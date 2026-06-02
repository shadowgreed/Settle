// ─────────────────────────────────────────────────────────────────────────────
// Vercel serverless proxy for SerpAPI Google Showtimes.
// Keeps SERP_API_KEY server-side — it never reaches the browser bundle.
//
// Query params (all forwarded from the client):
//   movie  — movie title string (required)
//   zip    — 5-digit ZIP code   (preferred location signal)
//   lat    — latitude           (used when no zip)
//   lng    — longitude          (used when no zip)
//
// IMPORTANT — Location handling:
//   SerpAPI's `location` parameter is a HUMAN-READABLE place string (e.g.
//   "New York,NY,United States" or "94110"), NOT raw coordinates. Passing
//   a "lat,lng" string here makes Google's location matcher fuzzy-match
//   the digits as a text query, which intermittently returns theaters in
//   completely wrong cities (the classic "Using my location" bug).
//
//   To fix that, when only lat/lng are provided we reverse-geocode them
//   server-side to a postal code (preferred) or a formatted address
//   (fallback) BEFORE calling SerpAPI. Both keys already live on this
//   function so no extra client roundtrip is required.
//
// CORS: Same-origin in production (frontend + API both live on trysettle.app),
// but explicit headers added defensively. iOS Safari in PWA standalone mode
// has been observed treating requests with stricter rules than its browser
// mode — explicit ACAO + ACAM avoids any ambiguity.
// ─────────────────────────────────────────────────────────────────────────────

const { enforceRateLimit } = require('../lib/rateLimit');
const { getShowtimesCache, setShowtimesCache } = require('../lib/showtimesCache');

const SERP_BASE    = 'https://serpapi.com/search.json';
const GEOCODE_BASE = 'https://maps.googleapis.com/maps/api/geocode/json';

// Origins permitted to read this endpoint cross-origin: production hosts plus
// Vercel preview deploys (settle-*.vercel.app). SerpAPI is a *paid, metered*
// upstream, so a wildcard ACAO ('*') would let any third-party site spend our
// search budget. The app itself is same-origin and never relies on these
// headers — they only service explicitly-trusted origins. (Non-browser clients
// ignore CORS, so this is defence-in-depth, not a substitute for rate-limiting.)
const ALLOWED_ORIGINS = ['https://trysettle.app', 'https://www.trysettle.app'];

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    return host === 'vercel.app' || host.endsWith('.vercel.app');
  } catch {
    return false;
  }
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Vary',                         'Origin');
}

/**
 * Reverse-geocode lat/lng → { zip, formattedAddress }.
 * Returns null on any failure (caller falls back to raw "lat,lng").
 *
 * We ask Google specifically for a postal_code result first (single round
 * trip, much shorter response). If that yields nothing — rural areas
 * without a US ZIP fall through — we widen to a generic reverse lookup
 * and pluck the most specific address we get.
 */
async function reverseGeocode(lat, lng) {
  if (!process.env.GOOGLE_GEOCODING_KEY) return null;

  const buildUrl = (extraParams = {}) => {
    const url = new URL(GEOCODE_BASE);
    url.searchParams.set('latlng', `${lat},${lng}`);
    url.searchParams.set('key', process.env.GOOGLE_GEOCODING_KEY);
    for (const [k, v] of Object.entries(extraParams)) {
      url.searchParams.set(k, v);
    }
    return url.toString();
  };

  // Pass 1: ask only for postal_code — fastest, exactly what SerpAPI prefers.
  try {
    const res  = await fetch(buildUrl({ result_type: 'postal_code' }));
    const data = await res.json();
    if (data.status === 'OK' && data.results?.[0]) {
      const top = data.results[0];
      const zipComp = (top.address_components || [])
        .find(c => c.types?.includes('postal_code'));
      if (zipComp?.long_name) {
        return { zip: zipComp.long_name, formattedAddress: top.formatted_address || null };
      }
    }
  } catch (err) {
    console.warn('[showtimes] reverseGeocode pass 1 failed:', err.message);
  }

  // Pass 2: generic reverse lookup, pick the most specific formatted_address.
  try {
    const res  = await fetch(buildUrl());
    const data = await res.json();
    if (data.status === 'OK' && data.results?.[0]) {
      return { zip: null, formattedAddress: data.results[0].formatted_address || null };
    }
  } catch (err) {
    console.warn('[showtimes] reverseGeocode pass 2 failed:', err.message);
  }

  return null;
}

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);

  // Preflight — some Safari PWA contexts send OPTIONS unexpectedly.
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.SERP_API_KEY) {
    console.error('[showtimes] SERP_API_KEY not configured');
    return res.status(503).json({ error: 'Showtimes service not configured' });
  }

  const { movie, zip, lat, lng } = req.query;

  // Validate inputs BEFORE touching the metered SerpAPI / Google upstreams.
  // Every param here flows into a paid request, so reject junk early.
  if (!movie || typeof movie !== 'string') {
    return res.status(400).json({ error: 'movie parameter required' });
  }
  if (movie.length > 200) {
    return res.status(400).json({ error: 'movie parameter too long' });
  }
  // ZIP is optional, but if present it must be a real US 5-digit ZIP — the
  // client only ever sends that shape.
  if (zip != null && zip !== '' && !/^\d{5}$/.test(zip)) {
    return res.status(400).json({ error: 'invalid zip' });
  }
  // lat/lng are optional, but if present must be finite and in range.
  if ((lat != null && lat !== '') || (lng != null && lng !== '')) {
    const latN = Number(lat);
    const lngN = Number(lng);
    if (!Number.isFinite(latN) || !Number.isFinite(lngN) ||
        latN < -90 || latN > 90 || lngN < -180 || lngN > 180) {
      return res.status(400).json({ error: 'invalid lat/lng' });
    }
  }

  // Backend cache key — derived from the client's raw inputs so a cache HIT
  // avoids the reverse-geocode round trip too. ZIP keys directly; GPS rounds to
  // ~1 km (2 dp) so the same spot reuses one entry.
  const cacheLocKey = zip
    ? `z:${zip}`
    : (lat && lng ? `g:${Number(lat).toFixed(2)},${Number(lng).toFixed(2)}` : null);

  // Durable shared cache (Upstash) FIRST — a hit costs no SerpAPI call and no
  // rate-limit budget. This is the main lever against repeated SerpAPI spend:
  // the first visitor to a ZIP today pays; everyone else rides the cache.
  if (cacheLocKey) {
    const cached = await getShowtimesCache(movie, cacheLocKey);
    if (cached) {
      res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=300');
      res.setHeader('X-Settle-Showtimes-Cache', 'hit');
      return res.status(200).json(cached);
    }
  }

  // Rate-limit BEFORE any paid upstream work (reverse-geocode + SerpAPI).
  // Two-tier: tight per-user (verified Firebase uid) + loose per-IP backstop;
  // fail-open if Upstash is unreachable. See lib/rateLimit.js.
  //
  // Headroom note: the In Theaters tab verifies one lookup per film (a batch of
  // ~10) to confirm a title is actually playing near you, and re-verifies on a
  // ZIP change. A load + a couple of ZIP changes legitimately needs more than a
  // handful of requests/min, so the per-user cap is sized for that. Cached
  // (movie+location) responses are served from the CDN edge and never reach
  // this function, so the real upstream spend is far below these ceilings.
  const gate = await enforceRateLimit(req, {
    endpoint: 'showtimes', userMax: 45, ipMax: 120, window: '60 s',
  });
  if (!gate.ok) {
    if (gate.retryAfter) res.setHeader('Retry-After', String(gate.retryAfter));
    return res.status(429).json({ error: 'Too many requests — please slow down and try again shortly.' });
  }

  // Resolve the SerpAPI `location` string. Order of preference:
  //   1. ZIP from client (most reliable)
  //   2. Reverse-geocoded ZIP from client lat/lng
  //   3. Reverse-geocoded formatted_address from client lat/lng
  //   4. Raw "lat,lng" string (last-resort — Google may misinterpret)
  let location = zip || null;
  let locationSource = location ? 'client_zip' : null;

  if (!location && lat && lng) {
    const resolved = await reverseGeocode(lat, lng);
    if (resolved?.zip) {
      location = resolved.zip;
      locationSource = 'reverse_zip';
    } else if (resolved?.formattedAddress) {
      location = resolved.formattedAddress;
      locationSource = 'reverse_address';
    } else {
      // Reverse geocoding failed — accept that this path can misfire, but
      // at least we still attempt a search rather than 502'ing the user.
      location = `${lat},${lng}`;
      locationSource = 'raw_coords_fallback';
    }
  }

  if (!location) {
    return res.status(400).json({ error: 'zip or lat+lng required' });
  }

  try {
    const params = new URLSearchParams({
      engine:  'google',
      q:       `${movie} showtimes`,
      location,
      hl:      'en',
      gl:      'us',
      api_key: process.env.SERP_API_KEY,
    });

    const upstream = await fetch(`${SERP_BASE}?${params}`);
    const data     = await upstream.json();

    if (!upstream.ok) {
      const msg = data?.error || `SerpAPI ${upstream.status}`;
      console.error('[showtimes] upstream error:', msg, '(location_source:', locationSource, ')');
      return res.status(502).json({ error: msg });
    }

    // Slim payload — the client (and native app) only ever reads `showtimes`.
    // Caching just this keeps the Redis entry small and the response identical
    // for the client's purposes.
    const payload = { showtimes: data.showtimes ?? null };

    // Persist to the durable shared cache (incl. negative results) so the next
    // visitor to this movie+location skips SerpAPI entirely. Awaited so the
    // write completes before the serverless instance can freeze.
    if (cacheLocKey) {
      await setShowtimesCache(movie, cacheLocKey, payload);
    }

    // Showtimes are date-specific; 30-min CDN cache is safe. `public` keeps the
    // CDN caching this shared (non-user-specific) response even though the
    // request now carries an Authorization header for per-user rate limiting —
    // the body is keyed only on movie+location, never on the user.
    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=300');
    res.setHeader('X-Settle-Showtimes-Cache', 'miss');
    return res.status(200).json(payload);
  } catch (err) {
    console.error('[showtimes proxy]', err.message);
    return res.status(502).json({ error: 'Showtimes request failed' });
  }
};
