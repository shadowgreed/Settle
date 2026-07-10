// ─────────────────────────────────────────────────────────────────────────────
// GET /api/share-card?fmt=story|portrait|square|og&title=&year=&type=&rating=
//                     &service=&genres=&posterPath=&story=&daypart=
//
// Server-side render of the shareable pick card (handoff spec §2/§4), using
// @vercel/og (Satori) against the shared layout in lib/shareCardLayout.jsx.
//
// This is the first Edge Function in the codebase — every other api/*.js route
// is a Node serverless function (CommonJS, (req, res) signature). Edge Functions
// use the standard Web Request/Response API and ESM, which is why this file is
// .jsx with `export default` rather than `module.exports`.
//
// Deliberately takes only display data as query params (title/year/type/etc.),
// not a TMDB id — the client already has the full result object in memory when
// the user taps Share (it's the same object the old canvas renderer consumed),
// so there's no need for this route to re-fetch metadata from the TMDB API.
// It only fetches the poster IMAGE from TMDB's public image CDN (no API key
// required for images, unlike the metadata API that api/tmdb.js proxies).
//
// No rate limiting here yet — lib/rateLimit.js and lib/firebaseAuth.js both
// assume a Node IncomingMessage-shaped req (bracket property access on
// req.headers), which doesn't match the Edge runtime's Web Headers object.
// Adapting those shared files for dual-runtime use is a real but separate
// piece of work, flagged rather than silently bundled into this change.
// ─────────────────────────────────────────────────────────────────────────────

import { ImageResponse } from '@vercel/og';
// Explicit browser-safe subpath, not the bare 'qrcode' package — the default
// entry point's toDataURL renders via an actual <canvas> element (through
// CanvasRenderer), which doesn't exist in the Edge runtime (no DOM). This
// subpath's toString({type:'svg'}) path is pure string templating with no
// canvas/zlib dependency, confirmed by reading node_modules/qrcode/lib/
// browser.js directly rather than assuming the package.json "browser" field
// resolution would be honored by every bundler.
import QRCode from 'qrcode/lib/browser.js';
import { buildCardElement, FORMAT_SIZES } from '../lib/shareCardLayout.jsx';
import { getShareCardCache, setShareCardCache } from '../lib/shareCardCache.js';

export const config = { runtime: 'edge' };

const VALID_FORMATS = new Set(['story', 'portrait', 'square', 'og']);
const POSTER_FETCH_TIMEOUT_MS = 3000;

// Server-side length cap mirroring the real client-side convention
// (src/components/Settings.js maxLength={20} on player-name inputs) — not a
// security boundary (Satori renders text as SVG text nodes, not HTML/script,
// so there's no injection surface), just protecting the layout from an
// oversized/garbage string breaking the card.
function clean(str, maxLen) {
  if (typeof str !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, maxLen);
}

// Google Fonts serves WOFF2 by default (which Satori can't parse — it needs
// TTF/OTF) based on User-Agent sniffing. The commonly-cited "just use an old
// desktop Chrome UA" trick does NOT work for this: Chrome had WOFF2 support
// well before version 104, so that UA still gets WOFF2. Older UAs (Chrome 30,
// Safari 5, Firefox 4, an old iOS Safari) fare no better — they get WOFF1,
// which Satori also rejects. Empirically verified (see PR discussion) against
// the live API: only Googlebot's own UA reliably gets genuine
// format('truetype') — confirmed by fetching the resulting font file and
// checking its magic bytes (0x00010000, the standard sfnt/TrueType header).
// This was the actual root cause of the share card silently failing to
// render — Satori throws synchronously ("No fonts are loaded") when handed
// an empty fonts array, which an unmatched regex here produced every time.
const FONT_FETCH_UA = 'Googlebot/2.1 (+http://www.google.com/bot.html)';

let fontsPromise = null;
async function loadFonts() {
  if (fontsPromise) return fontsPromise;
  fontsPromise = loadInterWeights([400, 700]);
  // Don't memoize a rejection — a transient failure on a cold start
  // shouldn't poison every subsequent request for the rest of this warm
  // instance's lifetime the way a memoized rejected promise would.
  fontsPromise.catch(() => { fontsPromise = null; });
  return fontsPromise;
}

// Single combined CSS request for both weights (not one request per weight)
// — halves the network round-trips before the actual font-file fetches,
// which matters for the crawler-facing fmt=og path (bugfix ticket §3.4 —
// crawlers time out in ~3-5s).
async function loadInterWeights(weights) {
  const cssUrl = `https://fonts.googleapis.com/css2?family=Inter:wght@${weights.join(';')}`;
  const css = await (await fetch(cssUrl, { headers: { 'User-Agent': FONT_FETCH_UA } })).text();

  // Parse per @font-face block (not a single global regex) so each font
  // file is correctly paired with ITS OWN weight, not assumed from response
  // order alone.
  const blocks = css.match(/@font-face\s*\{[^}]+\}/g) || [];
  const byWeight = {};
  for (const block of blocks) {
    const weightMatch = block.match(/font-weight:\s*(\d+)/);
    const srcMatch = block.match(/src: url\((.+?)\) format\('(opentype|truetype)'\)/);
    if (weightMatch && srcMatch) byWeight[weightMatch[1]] = srcMatch[1];
  }

  const buffers = await Promise.all(
    weights.map(async (weight) => {
      const url = byWeight[weight];
      if (!url) throw new Error(`no TTF/OTF resource found for Inter ${weight}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`font fetch ${res.status} for Inter ${weight}`);
      return res.arrayBuffer();
    })
  );

  return weights.map((weight, i) => ({
    name: 'Inter',
    data: buffers[i],
    weight,
    style: 'normal',
  }));
}

// Story-format QR (spec §3 item 6) — stories aren't tappable for small
// accounts, so this is the only working link on that format. Encodes the
// same personalized /pick/{id} URL the card's own share flow generates,
// SVG-rendered (no canvas/zlib) and base64-embedded as an <img> data URI.
async function buildQrDataUri(pickUrl) {
  if (!pickUrl) return null;
  try {
    const svg = await QRCode.toString(pickUrl, {
      type: 'svg',
      width: 240,
      margin: 1,
      color: { dark: '#0A0A0C', light: '#FFFFFF' },
    });
    const base64 = Buffer.from(svg, 'utf8').toString('base64');
    return `data:image/svg+xml;base64,${base64}`;
  } catch (e) {
    console.warn('[share-card] QR generation failed:', e.message);
    return null;
  }
}

// 3s timeout (spec §4) — a slow TMDB image response must not hang the whole
// card render. Returns null (→ placeholder panel in the layout) on failure.
async function loadPosterDataUri(posterPath) {
  if (!posterPath) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POSTER_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://image.tmdb.org/t/p/w780${posterPath}`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const base64 = Buffer.from(buf).toString('base64');
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    return `data:${contentType};base64,${base64}`;
  } catch (e) {
    console.warn('[share-card] poster fetch failed/timed out:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(request) {
  const { searchParams, origin } = new URL(request.url);

  const fmt = VALID_FORMATS.has(searchParams.get('fmt')) ? searchParams.get('fmt') : 'story';
  const { width, height } = FORMAT_SIZES[fmt];

  const item = {
    title:      clean(searchParams.get('title') || 'Untitled', 100),
    year:       clean(searchParams.get('year') || '', 4),
    type:       clean(searchParams.get('type') || '', 10),
    rating:     searchParams.get('rating') || null,
    service:    clean(searchParams.get('service') || '', 20),
    genres:     clean(searchParams.get('genres') || '', 60).split(',').map(s => s.trim()).filter(Boolean),
  };
  const storyLine   = clean(searchParams.get('story') || '', 80);
  const daypartText = clean(searchParams.get('daypart') || '🎬 Tonight\'s Pick', 40);
  const tmdbId      = clean(searchParams.get('tmdb') || '', 20);
  const posterPath  = searchParams.get('posterPath') || '';

  const PNG_HEADERS = { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' };

  // Cache key covers every input that affects the rendered pixels (spec §4 —
  // "identical shares shouldn't re-render"). A hit skips the font/poster
  // fetch and the Satori render entirely.
  const cacheParams = JSON.stringify({ tmdbId, ...item, storyLine, daypartText, posterPath });
  const cached = await getShareCardCache(fmt, cacheParams);
  if (cached) {
    const bytes = Uint8Array.from(atob(cached), (c) => c.charCodeAt(0));
    return new Response(bytes, { headers: PNG_HEADERS });
  }

  // Story format only (spec §3 item 6). Mirrors the same personalization
  // params api/pick/[id].js reads, so the QR's destination unfurls with the
  // same title/story/daypart as this exact card.
  const pickUrl = tmdbId
    ? `${origin}/pick/${encodeURIComponent(tmdbId)}?${new URLSearchParams({
        title: item.title, year: item.year, type: item.type,
        rating: item.rating || '', service: item.service,
        posterPath,
        story: storyLine, daypart: daypartText,
        utm_source: 'pickcard', utm_medium: 'share', utm_campaign: 'story',
      }).toString()}`
    : null;

  // One retry on a transient font-fetch failure (network blip, momentary
  // Google Fonts hiccup) — Satori throws synchronously if handed an empty
  // fonts array ("No fonts are loaded"), so silently degrading to fonts:[]
  // isn't an option here the way it is for the poster/QR fallbacks.
  // loadFonts() itself clears its memoized promise on rejection, so calling
  // it again here genuinely retries the fetch rather than replaying the
  // same failure.
  const fonts = await loadFonts().catch(() => loadFonts()).catch((e) => {
    console.error('[share-card] font load failed after retry:', e.message);
    return null;
  });

  const [posterSrc, qrDataUrl] = await Promise.all([
    loadPosterDataUri(posterPath),
    fmt === 'story' ? buildQrDataUri(pickUrl) : Promise.resolve(null),
  ]);

  if (!fonts) {
    // Fail clearly rather than letting Satori's "No fonts are loaded" throw
    // propagate as an opaque, possibly non-JSON error the client can't
    // usefully branch on. The client already treats any non-2xx as a signal
    // to fall back to a text-only share (src/App.js fetchShareCard).
    return new Response(JSON.stringify({ error: 'font_load_failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const element = buildCardElement({
    fmt,
    item: { ...item, posterSrc },
    storyLine,
    daypartText,
    qrDataUrl,
  });

  let buf;
  try {
    const rendered = new ImageResponse(element, { width, height, fonts });
    buf = await rendered.arrayBuffer();
  } catch (e) {
    console.error('[share-card] Satori render failed:', e.message);
    return new Response(JSON.stringify({ error: 'render_failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Fire-and-forget — a cache-write failure shouldn't fail (or delay) the
  // response the user is waiting on.
  setShareCardCache(fmt, cacheParams, Buffer.from(buf).toString('base64')).catch(() => {});

  return new Response(buf, { headers: PNG_HEADERS });
}
