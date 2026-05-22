// ─────────────────────────────────────────────────────────────────────────────
// Great-circle distance helpers for Theater Mode 2.0.
//
// Haversine formula — gives the shortest distance between two lat/long
// points on a sphere. Accurate to within ~0.5% for distances under 1,000 mi
// which is plenty for "is this theater 5 mi or 25 mi away?"
// ─────────────────────────────────────────────────────────────────────────────

const EARTH_RADIUS_MI = 3958.8;
const DEG_TO_RAD      = Math.PI / 180;

/**
 * Distance in miles between two {lat, lng} points.
 * Returns null if either point is missing valid coordinates.
 */
export function distanceMi(a, b) {
  if (
    !a || !b ||
    typeof a.lat !== 'number' || typeof a.lng !== 'number' ||
    typeof b.lat !== 'number' || typeof b.lng !== 'number'
  ) return null;

  const dLat = (b.lat - a.lat) * DEG_TO_RAD;
  const dLng = (b.lng - a.lng) * DEG_TO_RAD;
  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Display formatting per PD spec 2.0:
 *   Under 1 mi  → "0.5 mi" (one decimal)
 *   1–10 mi     → "3 mi"   (no decimal)
 *   Over 10 mi  → "12+ mi" (capped, with + symbol)
 *   30+ mi      → still formatted as "30+ mi" — the caller decides whether
 *                 to hide the theater entirely (per default-view rule).
 */
export function formatMi(mi) {
  if (mi == null || !Number.isFinite(mi)) return '';
  if (mi < 1)   return `${mi.toFixed(1)} mi`;
  if (mi < 10)  return `${Math.round(mi)} mi`;
  if (mi < 30)  return `${Math.round(mi)} mi`;
  return `${Math.round(mi)}+ mi`;
}

/**
 * Default-view threshold from the spec. Theaters further than this are
 * hidden behind a "Show more theaters" expansion.
 */
export const DEFAULT_RADIUS_MI = 30;
