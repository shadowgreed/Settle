/**
 * POST /api/push/watch-loop
 * Authorization: Bearer <Firebase ID token>
 * Body: { titleName: string }
 *
 * Called by the client immediately after the user taps "Watching this"
 * (or confirms a couple ballot match). Schedules a next-day "how was it?"
 * push by writing a watchLoopPending entry into the user's Upstash push
 * profile. The daily push cron picks it up ~20h later and sends the nudge.
 *
 * If the user isn't subscribed to push (no push profile in Upstash), this
 * is a no-op — the watch-loop still works on next open via the in-app popup,
 * which is the primary mechanism. Push is the bonus re-engagement layer.
 */

const { verifyFirebaseToken } = require('../../lib/firebaseAuth');
const { isEnabled, scheduleWatchLoop } = require('../../lib/pushStore');

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

module.exports = async function handler(req, res) {
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
};
