// ─────────────────────────────────────────────────────────────────────────────
// Backend cache for rendered share cards (Upstash Redis), mirroring
// lib/showtimesCache.js's shape — same fail-open-on-missing-config posture,
// same "never throws" contract for callers.
//
// Keyed on a hash of every input that actually affects the rendered pixels
// (title/story/daypart/rating/service/posterPath/genres — the full set of
// personalization params api/share-card.jsx receives), not just the TMDB id,
// since two shares of the same title can render differently (different mood
// matched, different daypart, different couple names). Re-sharing the exact
// same pick at the exact same moment — the actual "identical shares" case the
// spec calls out — hits this cache; anything that varies gets its own entry.
//
// ESM (not CommonJS like the Node api/*.js routes) so it can be imported
// directly from the Edge runtime's api/share-card.jsx without a require()
// interop step. @upstash/redis's client is itself a plain-fetch REST client
// with no Node-specific dependencies, so it works unchanged in Edge.
// ─────────────────────────────────────────────────────────────────────────────

import { Redis } from '@upstash/redis';

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

// Web Crypto (globalThis.crypto.subtle) — available in both the Edge runtime
// and modern Node — no Node-only 'crypto' module import needed.
async function hashKey(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

async function keyFor(fmt, paramsString) {
  return `sc:v1:${fmt}:${await hashKey(paramsString)}`;
}

/**
 * Returns the cached base64 PNG string for this format+params, or null on
 * miss / when caching is unavailable. Never throws.
 */
export async function getShareCardCache(fmt, paramsString) {
  if (!redis) return null;
  try {
    return await redis.get(await keyFor(fmt, paramsString));
  } catch (err) {
    console.warn('[shareCardCache] get failed:', err.message);
    return null;
  }
}

/**
 * Store the rendered card as a base64 PNG string. Never throws.
 */
export async function setShareCardCache(fmt, paramsString, base64Png) {
  if (!redis) return;
  try {
    await redis.set(await keyFor(fmt, paramsString), base64Png, { ex: TTL_SECONDS });
  } catch (err) {
    console.warn('[shareCardCache] set failed:', err.message);
  }
}
