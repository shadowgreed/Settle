/**
 * POST /api/couple/verify
 * Authorization: Bearer <Firebase ID token>  (P2's token)
 * Body: { code: string }
 *
 * Verifies the invite code P2 typed. On success:
 *   - Returns { partnerUid, partnerName } so P2's client can write
 *     couplePartnerUid to its own Firestore doc.
 *   - Stores a pending-link entry in Upstash so that when P1 next calls
 *     /api/couple/pending, they discover P2's uid and complete their own
 *     Firestore write.
 *   - Deletes the invite code (one-time use).
 *
 * Error cases:
 *   400  missing / malformed code
 *   404  code not found or expired
 *   409  P2 tried to use their own code (self-link)
 */

const { verifyFirebaseToken } = require('../../lib/firebaseAuth');
const { isEnabled, lookupCode, deleteCode, storePendingLink } = require('../../lib/coupleStore');

const CODE_RE = /^[A-Z2-9]{6}$/i;

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isEnabled()) return res.status(503).json({ error: 'couple store not configured' });

  const uid = await verifyFirebaseToken(req);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });

  const { code } = readBody(req);
  if (!code || !CODE_RE.test(String(code).trim())) {
    return res.status(400).json({ error: 'invalid code format' });
  }
  const normalised = String(code).trim().toUpperCase();

  try {
    const entry = await lookupCode(normalised);
    if (!entry?.uid) return res.status(404).json({ error: 'code not found or expired' });
    if (entry.uid === uid) return res.status(409).json({ error: 'cannot link with yourself' });

    // Burn the code and record the pending link for P1 to claim.
    await Promise.all([
      deleteCode(normalised),
      storePendingLink(entry.uid, uid),
    ]);

    return res.status(200).json({ partnerUid: entry.uid, partnerName: entry.name || '' });
  } catch (err) {
    console.error('[couple/verify]', err.message);
    return res.status(500).json({ error: 'verification failed' });
  }
};
