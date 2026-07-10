/**
 * /api/push/{subscribe,unsubscribe,watch-loop}
 *
 * Consolidated into one dynamic-route function for the same reason as
 * api/couple/[action].js — see that file's header comment (Vercel Hobby
 * plan's 12-serverless-function-per-deployment cap). Public paths unchanged:
 * /api/push/subscribe, /api/push/unsubscribe, /api/push/watch-loop.
 *
 * Each handler below is behavior-for-behavior identical to the file it
 * replaces — see git history for api/push/subscribe.js,
 * api/push/unsubscribe.js, and api/push/watch-loop.js for the
 * pre-consolidation version of any one of them in isolation.
 *
 * api/cron/push-notifications.js is NOT part of this consolidation — it's
 * referenced by exact path in vercel.json's crons config, so it stays a
 * standalone function.
 */

const { verifyFirebaseToken } = require('../../lib/firebaseAuth');
const {
  isEnabled, saveSubscription, removeSubscription, scheduleWatchLoop,
} = require('../../lib/pushStore');

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

// POST /api/push/subscribe — register/refresh a Web Push subscription.
// Also doubles as the heartbeat: called on opt-in AND every app open.
async function handleSubscribe(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isEnabled()) return res.status(503).json({ error: 'push store not configured' });

  const uid = await verifyFirebaseToken(req);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });

  const body = readBody(req);
  const sub = body.subscription;

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

  const topGenres = Array.isArray(body.topGenres)
    ? body.topGenres.map(Number).filter(Number.isFinite).slice(0, 10)
    : [];
  const services = Array.isArray(body.services)
    ? body.services.filter((s) => typeof s === 'string' && s.length <= 40).slice(0, 20)
    : [];
  // The caller's linked-partner uid (or null). Used server-side only to gate
  // /api/ballot/notify — never trusted for anything else.
  const partnerUid =
    typeof body.partnerUid === 'string' && body.partnerUid.length <= 128
      ? body.partnerUid
      : null;

  const subscription = {
    endpoint: sub.endpoint,
    expirationTime: sub.expirationTime ?? null,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  };

  try {
    await saveSubscription(uid, { subscription, topGenres, services, partnerUid });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[push/subscribe]', err.message);
    return res.status(500).json({ error: 'could not save subscription' });
  }
}

// POST /api/push/unsubscribe — remove a Web Push subscription.
async function handleUnsubscribe(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isEnabled()) return res.status(503).json({ error: 'push store not configured' });

  const uid = await verifyFirebaseToken(req);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });

  const { endpoint } = readBody(req);
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint)) {
    return res.status(400).json({ error: 'invalid endpoint' });
  }

  try {
    await removeSubscription(uid, endpoint);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[push/unsubscribe]', err.message);
    return res.status(500).json({ error: 'could not remove subscription' });
  }
}

// POST /api/push/watch-loop — schedule the ~20h "how was it?" nudge.
async function handleWatchLoop(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const uid = await verifyFirebaseToken(req);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });

  if (!isEnabled()) return res.status(200).json({ ok: true, skipped: 'store_not_configured' });

  const { titleName } = readBody(req);
  if (!titleName || typeof titleName !== 'string') {
    return res.status(400).json({ error: 'titleName required' });
  }

  try {
    await scheduleWatchLoop(uid, { titleName });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[push/watch-loop]', err.message);
    return res.status(200).json({ ok: true, skipped: 'store_error' }); // fail-open
  }
}

const ACTIONS = {
  subscribe: handleSubscribe,
  unsubscribe: handleUnsubscribe,
  'watch-loop': handleWatchLoop,
};

module.exports = async function handler(req, res) {
  const action = ACTIONS[req.query.action];
  if (!action) return res.status(404).json({ error: 'unknown action' });
  return action(req, res);
};
