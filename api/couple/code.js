/**
 * POST /api/couple/code
 * Authorization: Bearer <Firebase ID token>
 * Body: { displayName?: string }
 *
 * Generates a 6-char invite code for the authenticated user and stores it in
 * Upstash with a 24-hour TTL. The client shows the code to P1; P2 enters it
 * via /api/couple/verify.
 *
 * Idempotent in the sense that calling it again generates a fresh code (any
 * prior code is orphaned and expires naturally).
 */

const { verifyFirebaseToken } = require('../../lib/firebaseAuth');
const { isEnabled, generateCode } = require('../../lib/coupleStore');

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isEnabled()) return res.status(503).json({ error: 'couple store not configured' });

  const uid = await verifyFirebaseToken(req);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });

  const { displayName = '' } = readBody(req);
  const safeName = String(displayName).trim().slice(0, 40);

  try {
    const code = await generateCode(uid, safeName);
    return res.status(200).json({ code });
  } catch (err) {
    console.error('[couple/code]', err.message);
    return res.status(500).json({ error: 'could not generate code' });
  }
};
