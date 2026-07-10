// ─────────────────────────────────────────────────────────────────────────────
// Web Push (PM roadmap 3.1) — client-side subscribe/unsubscribe helpers.
//
// Flow:
//   1. App detects support + checks current permission
//   2. After 3rd successful pick, opt-in banner asks the user
//   3. User accepts → requestPermission() → subscribe via PushManager
//   4. Subscription POSTed to /api/push/subscribe and stored in Upstash
//      (NOT Firestore — the re-engagement cron reads it back over REST, which
//      sidesteps the firebase-admin service-account key the org policy blocks).
//   5. Server cron iterates subscriptions and sends notifications weekly via
//      the web-push library (signed with the VAPID private key).
//
// The /api/push/* endpoints derive the Firebase uid from the ID token in the
// Authorization header, so a client can only ever write its own profile.
//
// Platform note: web push works on Android Chrome / Firefox / Edge today.
// iOS Safari supports it only when the PWA is installed to the home screen on
// iOS 16.4+. The opt-in banner is suppressed when push isn't available, so
// users never see a prompt that can't be honored.
// ─────────────────────────────────────────────────────────────────────────────

import { authHeader } from './authHeader';

const VAPID_PUBLIC_KEY = process.env.REACT_APP_VAPID_PUBLIC_KEY || '';

// True if the browser supports Web Push (Service Worker + Push API) AND the
// server-side VAPID key is configured. The VAPID check effectively gates the
// entire feature behind environment configuration — without it set, the opt-in
// banner and Settings toggle stay hidden, so users never opt in to a feature
// that can't actually deliver notifications.
//
// On iOS specifically, also requires the PWA to be home-screen-installed.
export function isPushSupported() {
  if (typeof window === 'undefined') return false;
  if (!('serviceWorker' in navigator)) return false;
  if (!('PushManager' in window)) return false;
  if (!('Notification' in window)) return false;
  if (!VAPID_PUBLIC_KEY) return false; // server-side delivery not configured yet
  return true;
}

// Current notification permission state: 'default' | 'granted' | 'denied'.
export function notificationPermission() {
  return typeof Notification !== 'undefined' ? Notification.permission : 'default';
}

// Convert the base64url-encoded VAPID public key into the Uint8Array form the
// PushManager.subscribe() applicationServerKey option expects.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// POST JSON to one of our same-origin endpoints with the Firebase ID token
// attached. Returns the Response (callers decide how to handle non-2xx).
async function postJson(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
  });
}

function cleanTargeting(targeting = {}) {
  return {
    topGenres: Array.isArray(targeting.topGenres) ? targeting.topGenres : [],
    services: Array.isArray(targeting.services) ? targeting.services : [],
    // The user's linked-partner uid (or null). Lets the server gate
    // /api/ballot/notify so only a real partner can push this user.
    partnerUid: typeof targeting.partnerUid === 'string' ? targeting.partnerUid : null,
  };
}

// Subscribe the current device to push and persist it server-side.
// `targeting` = { topGenres: number[], services: string[] } feeds the cron's
// "new in your genres" query. Returns the PushSubscription on success; throws
// on the failures the UI cares about (no support, permission denied, no key).
export async function subscribeToPush(uid, targeting = {}) {
  if (!isPushSupported()) throw new Error('Push not supported');
  if (!VAPID_PUBLIC_KEY) throw new Error('VAPID public key not configured');
  if (!uid) throw new Error('User must be signed in to subscribe');

  // Ask the user for permission. On iOS this also requires the installed-PWA
  // context — the browser handles that gate.
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    throw new Error(`Permission ${perm}`);
  }

  const reg = await navigator.serviceWorker.ready;
  // Reuse an existing subscription if this device is already opted in — no
  // point minting a second endpoint.
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  // Persist to Upstash via the API. If this POST fails the browser is still
  // subscribed; the app-open heartbeat (syncPushProfile) will re-sync later,
  // so we don't treat a transient persist failure as an opt-in failure.
  try {
    const res = await postJson('/api/push/subscribe', {
      subscription: sub.toJSON(),
      ...cleanTargeting(targeting),
    });
    if (!res.ok) console.warn('[Push] subscribe persist failed:', res.status);
  } catch (e) {
    console.warn('[Push] subscribe persist error:', e.message);
  }

  return sub;
}

// Heartbeat — called on app open when already subscribed. Re-sends the existing
// subscription so the server refreshes lastSeenAt (idle detection) and the
// latest genre/service targeting. No permission prompt, no-op if unsubscribed.
export async function syncPushProfile(uid, targeting = {}) {
  if (!isPushSupported() || !uid) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return; // not subscribed on this device — nothing to refresh
    await postJson('/api/push/subscribe', {
      subscription: sub.toJSON(),
      ...cleanTargeting(targeting),
    });
  } catch (e) {
    console.warn('[Push] profile sync failed:', e.message);
  }
}

// Unsubscribe this device + remove the subscription server-side.
export async function unsubscribeFromPush(uid) {
  if (!isPushSupported() || !uid) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      // Capture the endpoint BEFORE unsubscribing — afterwards it's gone.
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      try {
        await postJson('/api/push/unsubscribe', { endpoint });
      } catch (e) {
        console.warn('[Push] Could not remove subscription server-side:', e.message);
      }
    }
  } catch (e) {
    console.warn('[Push] Unsubscribe failed:', e.message);
  }
}

// Wipe every device's push subscription server-side, plus unsubscribe this
// device's own browser-level PushManager registration (security audit
// SEC-03 — account deletion). unsubscribeFromPush only ever removed one
// device by endpoint via /api/push/unsubscribe; account deletion needs
// every device gone, which /api/push/delete-all handles server-side in one
// call since it derives uid from the auth token, not a per-device endpoint.
export async function deleteAllPushData() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch (e) {
    console.warn('[Push] local unsubscribe during account deletion failed:', e.message);
  }
  try {
    const res = await postJson('/api/push/delete-all', {});
    if (!res.ok) console.warn('[Push] delete-all persist failed:', res.status);
  } catch (e) {
    console.warn('[Push] delete-all persist error:', e.message);
  }
}

// True if the current device has an active push subscription.
export async function isSubscribedOnThisDevice() {
  if (!isPushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return !!sub;
  } catch {
    return false;
  }
}
