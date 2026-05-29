/**
 * Vercel serverless function — register/refresh a Web Push subscription.
 *
 * POST /api/push/subscribe
 *   Authorization: Bearer <Firebase ID token>
 *   body: { subscription: PushSubscription JSON, topGenres?: number[], services?: string[] }
 *
 * The Firebase uid is derived from the verified ID token (never trusted from
 * the body), so a caller can only ever write their own push profile. Storage
 * is Upstash (see lib/pushStore.js) — no firebase-admin / service-account key.
 *
 * This endpoint is idempotent and doubles as the heartbeat: the client calls
 * it on opt-in AND on each app open (re-sending the existing subscription),
 * which keeps lastSeenAt + targeting data fresh for the re-engagement cron.
 */

const { verifyFirebaseToken } = require('../../lib/firebaseAuth');
const { isEnabled, saveSubscription } = require('../../lib/pushStore');

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try {
    return JSON.parse(req.body || '{}');
  } catch {
    return {};
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!isEnabled()) {
    return res.status(503).json({ error: 'push store not configured' });
  }

  // Identity comes from the signed token, not the body. No token → anonymous →
  // rejected outright (this is cheaper and safer than rate-limiting).
  const uid = await verifyFirebaseToken(req);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });

  const body = readBody(req);
  const sub = body.subscription;

  // Validate the PushSubscription shape before it touches the store.
  if (
    !sub ||
    typeof sub.endpoint !== 'string' ||
    !/^https:\/\//.test(sub.endpoint) ||
    sub.endpoint.length > 1024 ||
    !sub.keys ||
    typeof sub.keys.p256dh !== 'string' ||
    typeof sub.keys.auth !== 'string'
  ) {
    return res.status(400).json({ error: 'invalid subscription' });
  }

  // Targeting data — sanitised + capped. Genres are TMDB numeric ids; services
  // are short provider names. Anything else the client sent is dropped.
  const topGenres = Array.isArray(body.topGenres)
    ? body.topGenres.map(Number).filter(Number.isFinite).slice(0, 10)
    : [];
  const services = Array.isArray(body.services)
    ? body.services.filter((s) => typeof s === 'string' && s.length <= 40).slice(0, 20)
    : [];

  // Persist only the fields web-push needs.
  const subscription = {
    endpoint: sub.endpoint,
    expirationTime: sub.expirationTime ?? null,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  };

  try {
    await saveSubscription(uid, { subscription, topGenres, services });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[push/subscribe]', err.message);
    return res.status(500).json({ error: 'could not save subscription' });
  }
};
