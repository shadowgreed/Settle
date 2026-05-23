// ─────────────────────────────────────────────────────────────────────────────
// Showtimes service — backed by SerpAPI Google Showtimes.
//
// All calls go through the Vercel proxy at /api/showtimes, which injects
// SERP_API_KEY server-side. The key never reaches the browser bundle.
//
// SerpAPI returns theaters sorted by proximity to the search location
// (mirroring what Google shows). We normalise to the same flat shape
// ShowtimesSheet expects so the component needs minimal changes.
//
// Response shape from SerpAPI:
//   showtimes[0].theaters[] → today's theaters (first entry = today)
//     theater.name, .address, .showing[]
//       showing.type  (format: "Standard" / "IMAX" / "Dolby" / etc.)
//       showing.time  (["11:00am", "2:15pm", ...])
//       showing.links ([ { title: "Fandango", link: "https://..." } ])
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';

const SHOWTIMES_BASE = '/api/showtimes';

// In-memory session cache — same pattern as the rest of the services.
const cache      = new Map();
const CACHE_TTL  = 1000 * 60 * 30; // 30 min

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.value;
}
function setCached(key, value) {
  cache.set(key, { value, ts: Date.now() });
}

// Custom error type so ShowtimesSheet can distinguish "service down / API
// error" from "clean empty result" and show the right banner.
export class ShowtimesServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.name   = 'ShowtimesServiceError';
    this.status = status;
  }
}

/**
 * Fetch showtimes for `movieTitle` near the user's location.
 *
 * Returns a normalised array of theater objects:
 *   { id, name, address, distanceMi, formats, showtimes[] }
 *
 * `showtimes` entries: { id, timeStr, format, soldOut, purchaseUrl }
 *
 * `distanceMi` is always null — Google already sorts by proximity so we
 * preserve their ordering rather than re-ranking. `purchaseUrl` is the
 * Fandango / AMC.com link Google surfaces for that format; tapping a
 * showtime pill opens it in a new tab.
 *
 * @param {string} movieTitle
 * @param {{ lat?: number, lng?: number, zip?: string }} location
 */
export async function getShowtimes(movieTitle, { lat, lng, zip } = {}) {
  if (!movieTitle) return [];

  const locationKey = zip
    || (lat != null && lng != null ? `${lat.toFixed(3)},${lng.toFixed(3)}` : null);
  if (!locationKey) return [];

  const cacheKey = `st:${movieTitle.toLowerCase()}:${locationKey}`;
  const hit = getCached(cacheKey);
  if (hit) return hit;

  const params = { movie: movieTitle };
  if (zip)              { params.zip = zip; }
  else if (lat && lng)  { params.lat = lat; params.lng = lng; }

  try {
    const res  = await axios.get(SHOWTIMES_BASE, { params });
    const data = res.data;

    // showtimes[0] = today. Prefer a day entry labelled "Today", fall back
    // to [0] so we still work if SerpAPI reorders the array.
    const todayEntry =
      data?.showtimes?.find(d => /today/i.test(d.day || ''))
      ?? data?.showtimes?.[0];

    const rawTheaters = todayEntry?.theaters ?? [];
    const normalized  = rawTheaters.map(normalizeTheater).filter(Boolean);

    setCached(cacheKey, normalized);
    return normalized;
  } catch (err) {
    const status = err.response?.status ?? 0;
    const msg    = err.response?.data?.error || err.message || 'Showtimes request failed';
    throw new ShowtimesServiceError(status, msg);
  }
}

// ── Normalisers ──────────────────────────────────────────────────────────────

function normalizeTheater(raw, index) {
  if (!raw?.name) return null;

  // Flatten showing[] (per-format) → flat showtimes[] (per-time-slot)
  const showtimes = [];
  (raw.showing || []).forEach((showing, si) => {
    const format     = showing.type || 'Standard';
    // Purchase link is per-format (same URL for all times in that format).
    // Users land on Fandango's page for that movie/format and pick a time.
    const purchaseUrl = showing.links?.[0]?.link || null;

    (showing.time || []).forEach((timeStr, ti) => {
      showtimes.push({
        id:          `${index}-${si}-${ti}`,
        timeStr,          // "11:00am", "2:15pm" — already display-ready
        format:      format !== 'Standard' ? format : null,
        soldOut:     false,   // SerpAPI / Google doesn't surface sold-out state
        purchaseUrl,
      });
    });
  });

  // Unique non-standard formats for badge chips on the theater card header
  const formats = [
    ...new Set(
      (raw.showing || [])
        .map(s => s.type)
        .filter(f => f && f !== 'Standard')
    ),
  ];

  return {
    id:         String(index),
    name:       raw.name,
    address:    raw.address || null,
    distanceMi: null,  // Google sorts by proximity — no raw distance available
    formats,
    showtimes,
  };
}
