/**
 * GET /api/couple/pending
 * Authorization: Bearer <Firebase ID token>  (P1's token)
 *
 * Called by P1's app on open (once they already have a coupleCode they shared).
 * Returns { partnerUid } if P2 has verified P1's code and the pending-link
 * entry is waiting in Upstash, then deletes it (claim-once).
 *
 * Returns { partnerUid: null } if nothing is pending.
 *
 * P1's client uses the returned partnerUid to write its own Firestore doc
 * (couplePartnerUid field), completing the link without needing firebase-admin.
 */

const { verifyFirebaseToken } = require('../../lib/firebaseAuth');
const { isEnabled, claimPendingLink } = require('../../lib/coupleStore');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!isEnabled()) return res.status(200).json({ partnerUid: null }); // fail-open

  const uid = await verifyFirebaseToken(req);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });

  try {
    const partnerUid = await claimPendingLink(uid);
    return res.status(200).json({ partnerUid: partnerUid || null });
  } catch (err) {
    console.error('[couple/pending]', err.message);
    // Fail-open — don't block app load if Upstash is unreachable
    return res.status(200).json({ partnerUid: null });
  }
};
