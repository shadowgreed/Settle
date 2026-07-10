// ─────────────────────────────────────────────────────────────────────────────
// GET /api/share-card?fmt=story|portrait|square|og&title=&year=&type=&rating=
//                     &service=&genres=&posterPath=&story=&daypart=&tmdb=
//
// Server-side render of the shareable pick card (handoff spec §2/§4), using
// @vercel/og (Satori) against the shared layout in lib/shareCardLayout.jsx.
//
// Node runtime (CommonJS, (req, res) signature) — same convention as every
// other api/*.js route. This was originally an Edge Function (the first one
// in the codebase), moved back to Node for two concrete reasons, not style:
//   1. Getting the rendered PNG under the parent spec's 1MB target needs a
//      PNG-decode + JPEG-re-encode pass (photographic poster content barely
//      compresses under lossless PNG). pngjs's decoder requires Node's
//      native 'zlib' module, which doesn't exist in the Edge runtime — it
//      would throw on every request, the same class of bug as the font-load
//      failure this route already shipped once (see the FONT_FETCH_UA
//      comment below).
//   2. lib/rateLimit.js / lib/firebaseAuth.js assume a Node
//      IncomingMessage-shaped req (bracket property access on req.headers),
//      not the Edge runtime's Web Headers object — Node removes that
//      mismatch too, though rate limiting isn't wired in by this change.
//
// Deliberately takes only display data as query params (title/year/type/etc.),
// not a TMDB id for data lookup — the client already has the full result
// object in memory when the user taps Share, so there's no need to re-fetch
// metadata from the TMDB API. `tmdb` IS accepted, but only to build the QR
// code's /pick/{id} destination — this route only ever fetches the poster
// IMAGE from TMDB's public image CDN (no API key needed for images, unlike
// the metadata API api/tmdb.js proxies).
// ─────────────────────────────────────────────────────────────────────────────

const { ImageResponse } = require('@vercel/og');
const QRCode = require('qrcode');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const { buildCardElement, FORMAT_SIZES } = require('../lib/shareCardLayout.jsx');
const { getShareCardCache, setShareCardCache } = require('../lib/shareCardCache.js');

const VALID_FORMATS = new Set(['story', 'portrait', 'square', 'og']);
const POSTER_FETCH_TIMEOUT_MS = 3000;
const JPEG_QUALITY = 85; // spec §2's own suggested value; ~3.4MB PNG -> ~0.4MB JPEG at this setting, visually lossless at normal viewing size (verified directly against rendered output, not just measured)

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
// which Satori also rejects. Empirically verified against the live API: only
// Googlebot's own UA reliably gets genuine format('truetype') — confirmed by
// fetching the resulting font file and checking its magic bytes (0x00010000,
// the standard sfnt/TrueType header). This was the actual root cause of the
// share card silently failing to render — Satori throws synchronously ("No
// fonts are loaded") when handed an empty fonts array, which an unmatched
// regex here produced every time.
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
// which matters for the crawler-facing fmt=og path (crawlers time out in
// ~3-5s).
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
// same personalized /pick/{id} URL the card's own share flow generates.
// Node runtime, so the plain 'qrcode' entry point (canvas-capable) is fine —
// still asking for SVG output specifically, which needs no canvas either way.
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

// PNG -> JPEG re-encode (parent spec §2's ≤1MB target — @vercel/og only ever
// emits PNG, and a full-bleed photographic poster compresses poorly
// losslessly: ~3.4MB for the Story format before this step, ~0.4MB after at
// quality 85). Pure-JS decode/encode (pngjs + jpeg-js, no native bindings/
// WASM), verified end-to-end against real rendered output before shipping.
// Falls back to returning the original PNG if this step ever fails — a
// bigger-than-spec'd file is a much smaller problem than no file at all.
function pngToJpeg(pngBuf) {
  const decoded = PNG.sync.read(pngBuf);
  const encoded = jpeg.encode({ data: decoded.data, width: decoded.width, height: decoded.height }, JPEG_QUALITY);
  return encoded.data;
}

module.exports = async function handler(req, res) {
  const fmt = VALID_FORMATS.has(req.query.fmt) ? req.query.fmt : 'story';
  const { width, height } = FORMAT_SIZES[fmt];

  const item = {
    title:      clean(req.query.title || 'Untitled', 100),
    year:       clean(req.query.year || '', 4),
    type:       clean(req.query.type || '', 10),
    rating:     req.query.rating || null,
    service:    clean(req.query.service || '', 20),
    genres:     clean(req.query.genres || '', 60).split(',').map(s => s.trim()).filter(Boolean),
  };
  const storyLine   = clean(req.query.story || '', 80);
  const daypartText = clean(req.query.daypart || '🎬 Tonight\'s Pick', 40);
  const tmdbId      = clean(req.query.tmdb || '', 20);
  const posterPath  = req.query.posterPath || '';

  const proto  = req.headers['x-forwarded-proto'] || 'https';
  const origin = `${proto}://${req.headers['x-forwarded-host'] || req.headers.host || 'trysettle.app'}`;

  const JPEG_HEADERS = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' };
  const PNG_HEADERS  = { 'Content-Type': 'image/png',  'Cache-Control': 'public, max-age=86400' };

  // Cache key covers every input that affects the rendered pixels (spec §4 —
  // "identical shares shouldn't re-render"). A hit skips the font/poster
  // fetch, the Satori render, AND the JPEG re-encode entirely.
  const cacheParams = JSON.stringify({ tmdbId, ...item, storyLine, daypartText, posterPath });
  const cached = await getShareCardCache(fmt, cacheParams);
  if (cached) {
    res.setHeader('Content-Type', JPEG_HEADERS['Content-Type']);
    res.setHeader('Cache-Control', JPEG_HEADERS['Cache-Control']);
    return res.status(200).send(Buffer.from(cached, 'base64'));
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
    return res.status(502).json({ error: 'font_load_failed' });
  }

  const element = buildCardElement({
    fmt,
    item: { ...item, posterSrc },
    storyLine,
    daypartText,
    qrDataUrl,
  });

  let pngBuf;
  try {
    const rendered = new ImageResponse(element, { width, height, fonts });
    pngBuf = Buffer.from(await rendered.arrayBuffer());
  } catch (e) {
    console.error('[share-card] Satori render failed:', e.message);
    return res.status(500).json({ error: 'render_failed' });
  }

  let outBuf = pngBuf;
  let headers = PNG_HEADERS;
  try {
    outBuf = pngToJpeg(pngBuf);
    headers = JPEG_HEADERS;
    // Fire-and-forget — a cache-write failure shouldn't fail (or delay) the
    // response the user is waiting on. Only caching the JPEG path keeps the
    // cache-hit branch above simple (always JPEG, never a mixed format).
    setShareCardCache(fmt, cacheParams, outBuf.toString('base64')).catch(() => {});
  } catch (e) {
    // The render itself succeeded — a PNG a bit over the size target beats
    // no image at all, so this degrades rather than fails the request.
    console.error('[share-card] PNG->JPEG re-encode failed, serving PNG:', e.message);
  }

  res.setHeader('Content-Type', headers['Content-Type']);
  res.setHeader('Cache-Control', headers['Cache-Control']);
  return res.status(200).send(outBuf);
};
