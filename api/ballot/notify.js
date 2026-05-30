/**
 * POST /api/ballot/notify
 * Authorization: Bearer <Firebase ID token>
 * Body: {
 *   partnerUid: string,
 *   eventType:  'ballot_sent' | 'ballot_match',
 *   titleName:  string,
 *   senderName: string,
 *   ballotId?:  string,   // used as the notification tag to dedupe
 * }
 *
 * Looks up the partner's push subscription from Upstash and sends a web-push
 * notification. Used for two events:
 *
 *   ballot_sent  — P1 just sent an async ballot to P2:
 *                  "[P1] wants to watch [Title] — your vote?"
 *
 *   ballot_match — P2 voted and it's a match, notify P1:
 *                  "[P2] voted yes on [Title]! It's a match 🎉"
 *
 * Fails silently when push isn't configured or the partner has no subscription
 * — the ballot itself is stored in Firestore so P2 will still see it on next
 * open even without the push.
 */

const { verifyFirebaseToken } = require('../../lib/firebaseAuth');
const { isEnabled: pushEnabled, listProfiles } = require('../../lib/pushStore');

let webpush;

const MESSAGES = {
  ballot_sent:  (sender, title) => ({
    title: 'Settle',
    body:  `${sender} wants to watch ${title} — your vote?`,
    tag:   'settle-ballot-incoming',
    url:   '/?ballot=1',
  }),
  ballot_match: (sender, title) => ({
    title: 'It\'s a match! 🎉',
    body:  `${sender} voted yes on ${title}. You're watching tonight!`,
    tag:   'settle-ballot-match',
    url:   '/',
  }),
  session_started: (sender) => ({
    title: 'Settle',
    body:  `${sender} started a couple session — pick your moods together`,
    tag:   'settle-session',
    url:   '/',
  }),
};

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const uid = await verifyFirebaseToken(req);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });

  // VAPID not configured → push can't work, but don't 503 — ballot is already
  // in Firestore and the feature works without push (just no proactive nudge).
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) {
    return res.status(200).json({ ok: true, skipped: 'vapid_not_configured' });
  }
  if (!pushEnabled()) {
    return res.status(200).json({ ok: true, skipped: 'push_store_not_configured' });
  }

  const { partnerUid, eventType, titleName, senderName } = readBody(req);

  if (!partnerUid || typeof partnerUid !== 'string') {
    return res.status(400).json({ error: 'partnerUid required' });
  }
  if (!MESSAGES[eventType]) {
    return res.status(400).json({ error: 'invalid eventType' });
  }

  // Load web-push lazily.
  try {
    webpush = webpush || require('web-push');
  } catch {
    return res.status(200).json({ ok: true, skipped: 'web_push_not_installed' });
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );

  // Find the recipient's push profile in Upstash.
  let profiles;
  try { profiles = await listProfiles(); } catch { profiles = []; }
  const partnerProfile = profiles.find(p => p.uid === partnerUid);
  if (!partnerProfile?.subs?.length) {
    return res.status(200).json({ ok: true, skipped: 'no_subscription' });
  }

  // AUTHORISATION: only a real partner may push this user. The recipient's
  // profile records *their* linked partner (partnerUid, written on every app
  // open). We require it to equal the authenticated sender. Without this, any
  // signed-in user who learned another uid could spam push notifications.
  if (partnerProfile.partnerUid !== uid) {
    return res.status(200).json({ ok: true, skipped: 'not_linked' });
  }

  const msgFn = MESSAGES[eventType];
  const safe = (s) => String(s || '').slice(0, 60);
  const payload = JSON.stringify(msgFn(safe(senderName), safe(titleName)));

  let sent = 0;
  for (const sub of partnerProfile.subs) {
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch (e) {
      // 404/410 = stale sub; others = transient. Not our job to prune here
      // — the weekly cron handles that. Just swallow.
      if (![404, 410].includes(e.statusCode)) {
        console.warn('[ballot/notify]', e.statusCode, e.body?.substring?.(0, 80));
      }
    }
  }

  return res.status(200).json({ ok: true, sent });
};
