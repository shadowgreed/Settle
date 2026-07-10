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

// Google Fonts serves WOFF2 by default, which Satori can't parse — an old
// enough User-Agent forces the TTF variant. Fetched once per format weight
// and cached in module scope across warm invocations (mirrors the key-caching
// pattern already used in lib/firebaseAuth.js).
const OLD_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.0.0 Safari/537.36';

let fontsPromise = null;
async function loadFonts() {
  if (fontsPromise) return fontsPromise;
  fontsPromise = Promise.all([400, 700].map(loadInterWeight)).then(([regular, bold]) => [
    { name: 'Inter', data: regular, weight: 400, style: 'normal' },
    { name: 'Inter', data: bold, weight: 700, style: 'normal' },
  ]);
  return fontsPromise;
}

async function loadInterWeight(weight) {
  const cssUrl = `https://fonts.googleapis.com/css2?family=Inter:wght@${weight}`;
  const css = await (await fetch(cssUrl, { headers: { 'User-Agent': OLD_UA } })).text();
  const match = css.match(/src: url\((.+?)\) format\('(opentype|truetype)'\)/);
  if (!match) throw new Error(`no TTF/OTF resource found for Inter ${weight}`);
  const res = await fetch(match[1]);
  if (!res.ok) throw new Error(`font fetch ${res.status} for Inter ${weight}`);
  return res.arrayBuffer();
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

  const [fonts, posterSrc, qrDataUrl] = await Promise.all([
    loadFonts().catch((e) => {
      console.warn('[share-card] font load failed, falling back to no custom font:', e.message);
      return [];
    }),
    loadPosterDataUri(posterPath),
    fmt === 'story' ? buildQrDataUri(pickUrl) : Promise.resolve(null),
  ]);

  const element = buildCardElement({
    fmt,
    item: { ...item, posterSrc },
    storyLine,
    daypartText,
    qrDataUrl,
  });

  const rendered = new ImageResponse(element, { width, height, fonts });
  const buf = await rendered.arrayBuffer();

  // Fire-and-forget — a cache-write failure shouldn't fail (or delay) the
  // response the user is waiting on.
  setShareCardCache(fmt, cacheParams, Buffer.from(buf).toString('base64')).catch(() => {});

  return new Response(buf, { headers: PNG_HEADERS });
}
