// ─────────────────────────────────────────────────────────────────────────────
// Upstash-backed couple-linking store.
//
// Partner linking works without firebase-admin (blocked by org policy) by
// using Upstash as the short-lived rendezvous layer:
//
//   P1 taps "Get code" → generateCode() → stores code in Upstash (24h TTL)
//                         → client shows code to P1
//
//   P2 enters code     → verifyCode(code, p2uid)
//                         → returns { uid: p1uid, name: p1name }
//                         → stores pendingLink so P1 discovers P2 on next open
//
//   P1 opens app       → claimPendingLink(p1uid) → returns p2uid or null
//                         → P1's client writes couplePartnerUid to its own Firestore doc
//
// Both users write only their OWN Firestore doc (couplePartnerUid field), so
// existing owner-only security rules hold. The Upstash keys are the bridge.
//
// Keys:
//   couple:code:{code}        → { uid, name }   TTL 24h
//   couple:pending:{ownerUid} → { uid }          TTL 48h (waiting for P1 to open app)
// ─────────────────────────────────────────────────────────────────────────────

const { Redis } = require('@upstash/redis');

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

let redis = null;
if (REDIS_URL && REDIS_TOKEN) {
  try { redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN }); }
  catch (err) { console.error('[coupleStore] Redis init failed:', err.message); }
}

function isEnabled() { return !!redis; }

const CODE_TTL_S    = 24 * 60 * 60;   // 24 h
const PENDING_TTL_S = 48 * 60 * 60;   // 48 h

const codeKey    = (code) => `couple:code:${code.toUpperCase()}`;
const pendingKey = (uid)  => `couple:pending:${uid}`;

/** Generate a random 6-character uppercase alphanumeric code. */
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // omit I/O/1/0 to avoid ambiguity
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/**
 * Register a new invite code for `uid`. Retries once on collision.
 * Returns the generated code (uppercase, 6 chars).
 */
async function generateCode(uid, displayName) {
  if (!redis) throw new Error('couple store not configured');
  const payload = { uid, name: displayName || '' };
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeCode();
    // NX = only set if not already set (avoids stealing an existing code)
    const ok = await redis.set(codeKey(code), payload, { ex: CODE_TTL_S, nx: true });
    if (ok !== null) return code; // 'OK' on success, null if key existed
  }
  throw new Error('could not generate a unique code');
}

/**
 * Look up an invite code. Returns { uid, name } of the code's owner, or null
 * if the code is not found / expired.
 */
async function lookupCode(code) {
  if (!redis) throw new Error('couple store not configured');
  return redis.get(codeKey(code.toUpperCase()));
}

/**
 * Delete a code (after successful verification or explicit cancel).
 */
async function deleteCode(code) {
  if (!redis) return;
  await redis.del(codeKey(code.toUpperCase()));
}

/**
 * After P2 verifies P1's code, store a pending notification so P1 discovers
 * the link the next time they open the app.
 */
async function storePendingLink(p1Uid, p2Uid) {
  if (!redis) throw new Error('couple store not configured');
  await redis.set(pendingKey(p1Uid), { uid: p2Uid }, { ex: PENDING_TTL_S });
}

/**
 * P1 polls on app open. Returns p2's uid if a pending link is waiting, then
 * deletes the key (claim-once). Returns null if nothing is pending.
 */
async function claimPendingLink(uid) {
  if (!redis) return null;
  const pending = await redis.get(pendingKey(uid));
  if (!pending?.uid) return null;
  await redis.del(pendingKey(uid));
  return pending.uid;
}

module.exports = {
  isEnabled,
  generateCode,
  lookupCode,
  deleteCode,
  storePendingLink,
  claimPendingLink,
};
