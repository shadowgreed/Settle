// ─────────────────────────────────────────────────────────────────────────────
// Backend showtimes cache (Upstash Redis).
//
// The In Theaters tab verifies one SerpAPI showtimes lookup per film to confirm
// it's actually playing near the user. SerpAPI is metered, so without a durable
// shared cache every cold area (and every ZIP change) re-bills ~10 searches.
//
// This caches the (slim) showtimes payload per movie + location for the rest of
// the local-ish day, SHARED across every user. A request that hits this cache
// never calls SerpAPI and never spends rate-limit budget — so the first visitor
// to a ZIP pays once, and everyone else (and that user's later searches) ride
// the cache until it expires.
//
// Fail-open by design: if Upstash isn't configured or errors, callers fall back
// to a live SerpAPI fetch exactly as before. Never throws.
// ─────────────────────────────────────────────────────────────────────────────

const { Redis } = require('@upstash/redis');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

let redis = null;
if (REDIS_URL && REDIS_TOKEN) {
  try {
    redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  } catch (err) {
    console.error('[showtimesCache] Redis init failed:', err.message);
  }
}

// 6 hours. Showtimes for "today" are stable across the day, so this trades a
// little freshness for a large cut in SerpAPI spend. The UTC date is baked into
// the key, so entries also turn over each day rather than serving stale times
// across the midnight boundary.
const TTL_SECONDS = 6 * 60 * 60;

function keyFor(movie, locationKey) {
  const day = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const m = String(movie || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 120);
  return `st:v1:${day}:${m}:${locationKey}`;
}

/**
 * Returns the cached slim payload `{ showtimes }` for this movie+location, or
 * null on miss / when caching is unavailable. Never throws.
 */
async function getShowtimesCache(movie, locationKey) {
  if (!redis || !locationKey) return null;
  try {
    return await redis.get(keyFor(movie, locationKey));
  } catch (err) {
    console.warn('[showtimesCache] get failed:', err.message);
    return null;
  }
}

/**
 * Store the slim payload `{ showtimes }` with a TTL. Negative results (a movie
 * with no nearby showtimes) are cached too, so we don't re-query titles that
 * aren't playing. Never throws.
 */
async function setShowtimesCache(movie, locationKey, payload) {
  if (!redis || !locationKey) return;
  try {
    await redis.set(keyFor(movie, locationKey), payload, { ex: TTL_SECONDS });
  } catch (err) {
    console.warn('[showtimesCache] set failed:', err.message);
  }
}

module.exports = { getShowtimesCache, setShowtimesCache, SHOWTIMES_CACHE_TTL: TTL_SECONDS };
