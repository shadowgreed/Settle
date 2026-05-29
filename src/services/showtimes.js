// ─────────────────────────────────────────────────────────────────────────────
// Showtimes service — SerpAPI Google Showtimes via /api/showtimes proxy.
//
// All calls go through the Vercel proxy which injects SERP_API_KEY server-side
// — the key never reaches the browser bundle.
//
// SerpAPI returns theaters sorted by proximity to the search location, mirroring
// what Google shows. We normalise the shape so ShowtimesSheet stays simple.
//
// Response shape from SerpAPI Google search engine:
//   showtimes[0]               → today's entry (label = "Today" usually)
//     .theaters[]              → array of nearby theaters
//       .name, .address, .distance ("44.4 mi" string)
//       .showing[]             → per-format show blocks
//         .type                → "IMAX" | "Dolby" | undefined (= standard)
//         .time                → ["11:00am", "2:15pm", ...]
//         .links[]             → [{ title: "Fandango", link: "https://..." }]
//
// Uses native `fetch` (not axios) to stay consistent with the rest of the
// services and avoid axios' XHR-based code path which has historically
// triggered edge cases in Safari (particularly in PWA standalone mode).
// ─────────────────────────────────────────────────────────────────────────────

import { authHeader } from './authHeader';

const SHOWTIMES_BASE = '/api/showtimes';
const REQUEST_TIMEOUT_MS = 12_000;

// In-memory session cache. Dropped on page reload.
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 30; // 30 min

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.value;
}
function setCached(key, value) {
  cache.set(key, { value, ts: Date.now() });
}

/**
 * Custom error so ShowtimesSheet can distinguish "service down / API error"
 * from "clean empty result" and pick the right banner.
 */
export class ShowtimesServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.name   = 'ShowtimesServiceError';
    this.status = status;
  }
}

/**
 * fetch() wrapper with an AbortController-backed timeout. Safari has been
 * known to leave fetches hanging indefinitely when the network path is
 * unhealthy — the hard timeout guarantees we always surface an error.
 */
async function fetchWithTimeout(url, { timeoutMs = REQUEST_TIMEOUT_MS, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal:      controller.signal,
      credentials: 'same-origin',
      cache:       'default',
      headers:     { Accept: 'application/json', ...headers },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Clear the in-memory cache for a specific movie+location, or all entries.
 * Called when the user manually changes location so we always re-fetch.
 */
export function invalidateShowtimesCache() {
  cache.clear();
}

/**
 * Fetch showtimes for `movieTitle` near the given location.
 *
 * Returns a normalised array of theater objects:
 *   { id, name, address, distanceMi, formats, showtimes[] }
 *
 * Each showtimes entry: { id, timeStr, format, soldOut, purchaseUrl }.
 *
 * Throws ShowtimesServiceError on upstream failure. Returns [] (not throws)
 * when no location is available — callers expecting empty UI can stay simple.
 */
export async function getShowtimes(movieTitle, { lat, lng, zip } = {}) {
  if (!movieTitle) return [];

  const locationKey =
    zip
      ? zip
      : (lat != null && lng != null ? `${lat.toFixed(3)},${lng.toFixed(3)}` : null);
  if (!locationKey) return [];

  const cacheKey = `st:${movieTitle.toLowerCase()}:${locationKey}`;
  const hit = getCached(cacheKey);
  if (hit) return hit;

  const params = new URLSearchParams({ movie: movieTitle });
  if (zip) {
    params.set('zip', zip);
  } else {
    params.set('lat', String(lat));
    params.set('lng', String(lng));
  }

  // Attach the signed-in user's ID token so the proxy can rate-limit per
  // verified user (uid) instead of per shared IP. {} when signed out.
  const headers = await authHeader();

  let res;
  try {
    res = await fetchWithTimeout(`${SHOWTIMES_BASE}?${params}`, { headers });
  } catch (err) {
    // Network error, abort, DNS failure, etc.
    throw new ShowtimesServiceError(0, err?.message || 'Network unavailable');
  }

  // Parse JSON defensively — Vercel error pages can sneak through as HTML.
  let data;
  try {
    data = await res.json();
  } catch {
    throw new ShowtimesServiceError(res.status, 'Bad response from showtimes service');
  }

  if (!res.ok) {
    throw new ShowtimesServiceError(res.status, data?.error || `Service returned ${res.status}`);
  }

  // showtimes[0] = today. Prefer an entry labelled "Today"; fall back to [0]
  // so we still work if SerpAPI ever reorders.
  const todayEntry =
    data?.showtimes?.find(d => /today/i.test(d.day || ''))
    ?? data?.showtimes?.[0];

  const rawTheaters = todayEntry?.theaters ?? [];
  const normalized  = rawTheaters.map(normalizeTheater).filter(Boolean);

  setCached(cacheKey, normalized);
  return normalized;
}

// ── Normalisers ──────────────────────────────────────────────────────────────

function normalizeTheater(raw, index) {
  if (!raw?.name) return null;

  // Flatten showing[] (per-format) → flat showtimes[] (per-time-slot).
  // Independent theaters may omit `type` and `links` entirely.
  const showtimes = [];
  (raw.showing || []).forEach((showing, si) => {
    const format      = showing.type || null;
    const purchaseUrl = showing.links?.[0]?.link || null;

    (showing.time || []).forEach((timeStr, ti) => {
      showtimes.push({
        id:       `${index}-${si}-${ti}`,
        timeStr,                     // "11:00am", "2:15pm" — display-ready
        format,
        soldOut:  false,             // Google doesn't surface sold-out state
        purchaseUrl,
      });
    });
  });

  // Unique premium formats for badge chips (IMAX, Dolby Cinema, etc.).
  const formats = [
    ...new Set(
      (raw.showing || [])
        .map(s => s.type)
        .filter(Boolean)
    ),
  ];

  // SerpAPI returns distance as a string like "44.4 mi" — parse it out.
  const distanceMi = raw.distance ? parseFloat(raw.distance) : null;

  return {
    id:        String(index),
    name:      raw.name,
    address:   raw.address || null,
    distanceMi,
    formats,
    showtimes,
  };
}
