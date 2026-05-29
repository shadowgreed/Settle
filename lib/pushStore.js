// ─────────────────────────────────────────────────────────────────────────────
// Upstash-backed store for Web Push profiles — the "Vercel KV path".
//
// WHY THIS EXISTS: the push cron used to read subscriptions from Firestore via
// firebase-admin, which needs a service-account key. The org policy
// `iam.disableServiceAccountKeyCreation` forbids creating that key (it's the
// same wall that blocked push for the whole of Phase 3). Storing push profiles
// in Upstash instead means the cron reads them over plain REST with the token
// we already have for rate limiting — no service-account key, ever.
//
// Data model (small user base — flat is fine):
//   push:uids        → SET of uids that currently have ≥1 subscription
//   push:u:<uid>     → JSON {
//                        subs:           [ PushSubscription JSON, ... ],
//                        topGenres:      [ TMDB genre id, ... ],
//                        services:       [ provider name, ... ],
//                        lastSeenAt:     ms epoch (refreshed every app open),
//                        lastNotifiedAt: ms epoch (0 until first push),
//                      }
//
// The data here is non-sensitive: a push endpoint + its public keys, a handful
// of genre ids, and streaming-service names. No coordinates, no PII.
//
// All writes throw if the store isn't configured; callers decide how to degrade
// (the endpoints 503, the cron skips). The @upstash/redis client auto-serialises
// objects to JSON on set and parses them on get.
// ─────────────────────────────────────────────────────────────────────────────

const { Redis } = require('@upstash/redis');

// Accept either Upstash's native var names or Vercel's KV-integration names.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

let redis = null;
if (REDIS_URL && REDIS_TOKEN) {
  try {
    redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  } catch (err) {
    console.error('[pushStore] Redis init failed:', err.message);
  }
}

const SET_KEY = 'push:uids';
const profileKey = (uid) => `push:u:${uid}`;

/** True if Upstash creds are present and the client initialised. */
function isEnabled() {
  return !!redis;
}

/**
 * Upsert one device subscription + targeting data for a user. Dedupes devices
 * by endpoint (re-subscribing the same browser replaces, never duplicates).
 * Also doubles as the heartbeat: every call refreshes lastSeenAt.
 */
async function saveSubscription(uid, { subscription, topGenres, services }) {
  if (!redis) throw new Error('push store not configured');
  const key = profileKey(uid);
  const existing = (await redis.get(key)) || {};
  const prevSubs = Array.isArray(existing.subs) ? existing.subs : [];

  // Replace any existing entry with the same endpoint, then append this one.
  const subs = prevSubs.filter((s) => s && s.endpoint !== subscription.endpoint);
  subs.push(subscription);

  const profile = {
    subs,
    topGenres: Array.isArray(topGenres) ? topGenres : existing.topGenres || [],
    services: Array.isArray(services) ? services : existing.services || [],
    lastSeenAt: Date.now(),
    lastNotifiedAt: existing.lastNotifiedAt || 0,
  };

  await redis.set(key, profile);
  await redis.sadd(SET_KEY, uid);
  return profile;
}

/**
 * Remove one device subscription by endpoint. If it was the user's last one,
 * drop the whole record and de-index the uid so the cron stops scanning it.
 */
async function removeSubscription(uid, endpoint) {
  if (!redis) throw new Error('push store not configured');
  const key = profileKey(uid);
  const existing = await redis.get(key);
  if (!existing) return;

  const subs = (Array.isArray(existing.subs) ? existing.subs : []).filter(
    (s) => s && s.endpoint !== endpoint
  );

  if (subs.length === 0) {
    await redis.del(key);
    await redis.srem(SET_KEY, uid);
  } else {
    existing.subs = subs;
    await redis.set(key, existing);
  }
}

/**
 * Cron: list every push profile as [{ uid, subs, topGenres, services, ... }].
 * Skips records with no live subscriptions.
 */
async function listProfiles() {
  if (!redis) throw new Error('push store not configured');
  const uids = await redis.smembers(SET_KEY);
  if (!uids || uids.length === 0) return [];

  const values = await redis.mget(...uids.map(profileKey));
  const out = [];
  for (let i = 0; i < uids.length; i++) {
    const p = values[i];
    if (p && Array.isArray(p.subs) && p.subs.length > 0) {
      out.push({ uid: uids[i], ...p });
    }
  }
  return out;
}

/**
 * Cron: after a send pass for a user, persist the surviving subscriptions
 * (stale 404/410 endpoints pruned out) and optionally stamp lastNotifiedAt.
 * Only stamp when at least one push actually went out, so an all-transient-
 * failure run is retried on the next cron rather than silenced for a week.
 */
async function commitAfterSend(uid, { subs, notified }) {
  if (!redis) throw new Error('push store not configured');
  const key = profileKey(uid);
  const existing = await redis.get(key);
  if (!existing) return;

  existing.subs = Array.isArray(subs) ? subs : existing.subs;
  if (notified) existing.lastNotifiedAt = Date.now();

  if (!Array.isArray(existing.subs) || existing.subs.length === 0) {
    await redis.del(key);
    await redis.srem(SET_KEY, uid);
  } else {
    await redis.set(key, existing);
  }
}

module.exports = {
  isEnabled,
  saveSubscription,
  removeSubscription,
  listProfiles,
  commitAfterSend,
};
