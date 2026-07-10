// ─────────────────────────────────────────────────────────────────────────────
// Backend cache for rendered share cards (Upstash Redis), mirroring
// lib/showtimesCache.js's shape — same fail-open-on-missing-config posture,
// same "never throws" contract for callers.
//
// Keyed on a hash of every input that actually affects the rendered pixels
// (title/story/daypart/rating/service/posterPath/genres — the full set of
// personalization params api/share-card.js receives), not just the TMDB id,
// since two shares of the same title can render differently (different mood
// matched, different daypart, different couple names). Re-sharing the exact
// same pick at the exact same moment — the actual "identical shares" case the
// spec calls out — hits this cache; anything that varies gets its own entry.
//
// CommonJS, matching every other lib/*.js file — api/share-card.js moved off
// the Edge runtime onto Node (see that file's header comment for why), so
// there's no longer a reason for this one file to be the ESM exception.
// ─────────────────────────────────────────────────────────────────────────────

const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

let redis = null;
if (REDIS_URL && REDIS_TOKEN) {
  try {
    redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  } catch (err) {
    console.error('[shareCardCache] Redis init failed:', err.message);
  }
}

// 7 days — poster/title/rating for a given pick barely change, and every
// input that DOES vary session-to-session (story line, daypart, names) is
// already folded into the hash, so a cache hit is always a repeat of an
// identical prior render, never a stale one.
const TTL_SECONDS = 7 * 24 * 60 * 60;

function hashKey(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 32);
}

function keyFor(fmt, paramsString) {
  return `sc:v1:${fmt}:${hashKey(paramsString)}`;
}

/**
 * Returns the cached base64 image string for this format+params, or null on
 * miss / when caching is unavailable. Never throws.
 */
async function getShareCardCache(fmt, paramsString) {
  if (!redis) return null;
  try {
    return await redis.get(keyFor(fmt, paramsString));
  } catch (err) {
    console.warn('[shareCardCache] get failed:', err.message);
    return null;
  }
}

/**
 * Store the rendered card as a base64 image string. Never throws.
 */
async function setShareCardCache(fmt, paramsString, base64Image) {
  if (!redis) return;
  try {
    await redis.set(keyFor(fmt, paramsString), base64Image, { ex: TTL_SECONDS });
  } catch (err) {
    console.warn('[shareCardCache] set failed:', err.message);
  }
}

module.exports = { getShareCardCache, setShareCardCache };
