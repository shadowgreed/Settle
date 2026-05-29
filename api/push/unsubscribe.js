/**
 * Vercel serverless function — remove a Web Push subscription.
 *
 * POST /api/push/unsubscribe
 *   Authorization: Bearer <Firebase ID token>
 *   body: { endpoint: string }
 *
 * The uid comes from the verified token, so a caller can only remove their own
 * device. The client captures the endpoint BEFORE calling sub.unsubscribe(),
 * then posts it here so the server-side record matches the browser state.
 */

const { verifyFirebaseToken } = require('../../lib/firebaseAuth');
const { isEnabled, removeSubscription } = require('../../lib/pushStore');

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
};
