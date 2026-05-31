// ─────────────────────────────────────────────────────────────────────────────
// Native (Capacitor) bridge — turns the SAME web app into the native iOS/Android
// app without forking the codebase. Everything here is a NO-OP on the web PWA
// (guarded by isNative()), so the Vercel web build is byte-for-byte unchanged.
//
// Two problems it solves on native:
//   1. The bundled app runs from capacitor://localhost, so the app's relative
//      `/api/*` calls would resolve to the local shell (404). We rewrite them to
//      the deployed backend AND send them through the NATIVE http stack
//      (CapacitorHttp), which bypasses WebView CORS — the proxies' allowlist
//      doesn't include the capacitor:// origin. Firebase (absolute googleapis
//      URLs) and image loads are left on the normal fetch, untouched.
//   2. External links (the "Open on Netflix" deep link, the Fandango ticket CTA)
//      should open INSIDE the app — SFSafariViewController / Chrome Custom Tab —
//      not bounce the user out to Safari. This is the native-only purchase win.
// ─────────────────────────────────────────────────────────────────────────────

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Browser } from '@capacitor/browser';

export const isNative = () => Capacitor.isNativePlatform();

// Deployed backend the bundled native app talks to. (Web uses same-origin
// relative paths, so this is only ever prepended on native.)
const API_BASE = 'https://www.trysettle.app';

// CapacitorHttp returns headers as a plain object; give callers a Headers-like
// `.get()` so existing `res.headers.get(...)` code keeps working.
function asHeaders(obj) {
  const o = obj || {};
  return { get: (k) => o[k] ?? o[String(k).toLowerCase()] ?? null };
}

// Native API call → absolute URL + native HTTP. Returns a fetch-Response-like
// object the existing services already expect (ok / status / json / text).
async function nativeApiFetch(path, options = {}) {
  let data;
  if (options.body != null) {
    if (typeof options.body === 'string') {
      try { data = JSON.parse(options.body); } catch { data = options.body; }
    } else {
      data = options.body;
    }
  }
  const res = await CapacitorHttp.request({
    url: API_BASE + path,
    method: (options.method || 'GET').toUpperCase(),
    headers: options.headers || {},
    data,
    connectTimeout: 15000,
    readTimeout: 15000,
  });
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    headers: asHeaders(res.headers),
    json: async () => (typeof res.data === 'string' ? JSON.parse(res.data || 'null') : res.data),
    text: async () => (typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? null)),
  };
}

// Open an external URL in the in-app browser on native, or a new tab on web.
export async function openExternal(url) {
  if (!url) return;
  if (isNative()) {
    try { await Browser.open({ url, toolbarColor: '#0a0a0a' }); } catch {}
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

// Install native-only shims ONCE at startup. No-op on web.
export function installNativeBridge() {
  if (!isNative()) return;

  // 1) Route relative /api/* through native HTTP (absolute URL, no CORS wall).
  const origFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url);
    if (typeof url === 'string' && url.startsWith('/api/')) {
      return nativeApiFetch(url, init || {});
    }
    return origFetch(input, init);
  };

  // 2) window.open(...) → in-app browser.
  const origOpen = window.open.bind(window);
  window.open = (url, ...rest) => {
    if (typeof url === 'string' && /^https?:/i.test(url)) {
      Browser.open({ url, toolbarColor: '#0a0a0a' }).catch(() => {});
      return null;
    }
    return origOpen(url, ...rest);
  };

  // 3) <a target="_blank"> clicks ("Open on Netflix", ticket CTAs) → in-app browser.
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[target="_blank"]');
    if (a && a.href && /^https?:/i.test(a.href)) {
      e.preventDefault();
      Browser.open({ url: a.href, toolbarColor: '#0a0a0a' }).catch(() => {});
    }
  }, true);
}
