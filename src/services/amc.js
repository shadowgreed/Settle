// ─────────────────────────────────────────────────────────────────────────────
// AMC Theatres API client (Theater Mode 2.0).
//
// All calls go through the Vercel proxy at /api/amc, which injects the
// AMC_API_KEY as an X-AMC-Vendor-Key header server-side. The key never
// reaches the browser bundle.
//
// Endpoints used:
//   GET /v2/theatres?location.lat=&location.long=&location.radius=  → theaters near coords
//   GET /v2/theatres/{id}/showtimes/{YYYY-MM-DD}?movie={slug}        → showtimes per theater per day
//
// AMC's response shape uses HAL/hypermedia conventions — relevant fields
// are nested under `_embedded.theatres[]` for collections and at top
// level for single resources. We normalize to flat { id, name, ... }
// objects for the rest of the app.
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';

const AMC_BASE = '/api/amc';

// In-memory cache (session-scoped). Firestore handles 30-day cross-session
// caching for theater geocoding.
const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key, value) {
  cache.set(key, { value, ts: Date.now() });
}

async function amcGet(path, params = {}) {
  const res = await axios.get(AMC_BASE, { params: { _p: path, ...params } });
  return res.data;
}

/**
 * Search theaters near a coordinate. Returns normalised theater objects:
 *   { id, name, address, city, state, zip, lat, lng, formats, slug }
 *
 * `radiusMi` controls the search radius. Spec default-view is 30 miles,
 * which is also our hard cap for "default theater list" — beyond that
 * theaters are hidden behind a Show more expansion.
 */
export async function theatersNearby({ lat, lng, radiusMi = 30 } = {}) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return [];

  // Round to 3 decimals (~110m precision) for cache-key stability — small
  // GPS jitter between sessions shouldn't bust the cache.
  const key = `near:${lat.toFixed(3)}:${lng.toFixed(3)}:${radiusMi}`;
  const hit = getCached(key);
  if (hit) return hit;

  try {
    const data = await amcGet('v2/theatres', {
      'location.lat':    lat,
      'location.long':   lng,
      'location.radius': radiusMi,
      'page-size':       30,
    });

    // AMC HAL response: theaters under data._embedded.theatres.
    const list = data?._embedded?.theatres ?? data?.theatres ?? [];
    const normalized = list.map(normalizeTheater).filter(Boolean);
    setCached(key, normalized);
    return normalized;
  } catch (err) {
    console.warn('[AMC] theatersNearby failed:', err.message);
    return [];
  }
}

/**
 * Showtimes for a movie at a specific theater on a given date.
 *
 * `movieKey` is AMC's slug for the movie. AMC's API maps TMDB titles to
 * its own slugs via the /v2/movies endpoint; rather than maintain a
 * mapping client-side, we search AMC by title and use the first match.
 * If that misses, the theater shows "No showtimes today".
 *
 * `dateISO` is YYYY-MM-DD in the theater's local time (assume user TZ
 * matches theater TZ — true for 99% of cases since users go to local
 * cinemas).
 */
export async function showtimesAt(theaterId, movieKey, dateISO) {
  if (!theaterId || !movieKey || !dateISO) return [];

  const key = `showtimes:${theaterId}:${movieKey}:${dateISO}`;
  const hit = getCached(key);
  if (hit) return hit;

  try {
    const data = await amcGet(`v2/theatres/${theaterId}/showtimes/${dateISO}`, {
      movie: movieKey,
    });
    const list = data?._embedded?.showtimes ?? data?.showtimes ?? [];
    const normalized = list.map(normalizeShowtime).filter(Boolean);
    setCached(key, normalized);
    return normalized;
  } catch (err) {
    console.warn('[AMC] showtimesAt failed:', err.message);
    return [];
  }
}

/**
 * Find AMC's slug for a movie by title — needed because TMDB titles
 * don't always match AMC's slug exactly. We fuzzy-match: lowercase,
 * strip punctuation, compare. First match wins.
 */
export async function findMovieSlug(title, year) {
  if (!title) return null;
  const key = `movie:${title.toLowerCase()}:${year || ''}`;
  const hit = getCached(key);
  if (hit !== null) return hit;

  try {
    const data = await amcGet('v2/movies', { name: title, 'page-size': 5 });
    const list = data?._embedded?.movies ?? data?.movies ?? [];

    // Score matches: exact normalized title wins; release-year tiebreak.
    const wanted = normalizeTitle(title);
    const scored = list.map(m => ({
      slug: m.slug || m.urlSlug || null,
      titleMatch: normalizeTitle(m.name || m.title || '') === wanted ? 1 : 0,
      yearMatch:  year && m.releaseDateUtc?.startsWith(String(year)) ? 1 : 0,
    }));
    scored.sort((a, b) => (b.titleMatch + b.yearMatch) - (a.titleMatch + a.yearMatch));
    const top = scored[0]?.slug || null;
    setCached(key, top);
    return top;
  } catch (err) {
    console.warn('[AMC] findMovieSlug failed:', err.message);
    setCached(key, null);
    return null;
  }
}

// ── Normalisers ─────────────────────────────────────────────────────────────

function normalizeTheater(raw) {
  if (!raw || !raw.id) return null;
  // AMC's response includes location { latitude, longitude } and an
  // address object. Fall through if any of these are missing — caller
  // can still render the theater without coords (no distance ranking).
  const loc = raw.location || raw.geolocation || {};
  return {
    id:       String(raw.id),
    name:     raw.name || raw.longName || 'AMC Theatre',
    slug:     raw.slug || raw.urlSlug || null,
    address:  raw.address1 || raw.streetAddress || null,
    city:     raw.city || null,
    state:    raw.state || raw.stateProvince || null,
    zip:      raw.postalCode || raw.zip || null,
    lat:      typeof loc.latitude === 'number'  ? loc.latitude  : null,
    lng:      typeof loc.longitude === 'number' ? loc.longitude : null,
    // Premium formats — IMAX / Dolby / Prime / etc — used as small chip
    // badges on the theater card. AMC encodes these as attributes; we
    // surface a friendly subset.
    formats:  Array.isArray(raw.attributes) ? raw.attributes.map(a => a.name || a.code).filter(Boolean) : [],
    // Hold raw _links so we can build deep links later (M4) without
    // re-fetching.
    _links:   raw._links || null,
  };
}

function normalizeShowtime(raw) {
  if (!raw) return null;
  const iso = raw.showDateTimeUtc || raw.showDateTimeLocal || raw.startTimeUtc || null;
  if (!iso) return null;
  return {
    id:        String(raw.id || ''),
    iso,
    format:    raw.premiumFormat?.name || raw.format || null, // IMAX / Dolby Cinema / Standard / etc.
    seatsLeft: typeof raw.seatsRemaining === 'number' ? raw.seatsRemaining : null,
    soldOut:   raw.isSoldOut === true,
    // Affiliate-deep-link target — surfaced by M4 (ticket purchase). For
    // now we capture but don't use it.
    purchaseUrl: raw._links?.purchaseUrl?.href || raw.purchaseUrl || null,
  };
}

function normalizeTitle(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Today's date in YYYY-MM-DD (theater-local). Returns the user's local
 * date — sufficient for the "showtimes today" flow which dominates usage.
 */
export function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Format an ISO showtime to local "7:30 PM" / "10:15 AM" — uses the
 * user's locale. We could do per-theater TZ but in practice users
 * always book at theaters in their own timezone.
 */
export function formatShowtime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}
