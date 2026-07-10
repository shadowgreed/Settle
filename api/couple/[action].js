/**
 * /api/couple/{code,pending,verify}
 *
 * Consolidated into one dynamic-route function (Vercel's [param] file
 * convention) to stay under the Hobby plan's 12-serverless-function cap per
 * deployment — three separate files here plus three under api/push counted
 * against that same limit, and every deployment since the Shareable Pick
 * Card work added api/share-card.js + api/pick/[id].js has been failing to
 * build as a result (14 functions total, cap is 12).
 *
 * Dispatches on the URL segment itself (req.query.action — Vercel populates
 * this from the [action] path segment), so the public paths the client
 * already calls are unchanged: /api/couple/code, /api/couple/pending,
 * /api/couple/verify all still work exactly as before.
 *
 * Each handler below is behavior-for-behavior identical to the file it
 * replaces — see git history for api/couple/code.js, api/couple/pending.js,
 * and api/couple/verify.js if you need the pre-consolidation version of any
 * one of them in isolation.
 */

const { verifyFirebaseToken } = require('../../lib/firebaseAuth');
const {
  isEnabled, generateCode, lookupCode, deleteCode, storePendingLink, claimPendingLink,
} = require('../../lib/coupleStore');
const { enforceRateLimit } = require('../../lib/rateLimit');

const CODE_RE = /^[A-Z2-9]{6}$/i;

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

// POST /api/couple/code — generate a 6-char invite code for the authenticated user.
async function handleCode(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isEnabled()) return res.status(503).json({ error: 'couple store not configured' });

  const uid = await verifyFirebaseToken(req);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });

  const gate = await enforceRateLimit(req, {
    endpoint: 'couple-code', userMax: 10, ipMax: 30, window: '60 s',
  });
  if (!gate.ok) {
    if (gate.retryAfter) res.setHeader('Retry-After', String(gate.retryAfter));
    return res.status(429).json({ error: 'Too many requests — please slow down.' });
  }

  const { displayName = '' } = readBody(req);
  const safeName = String(displayName).trim().slice(0, 40);

  try {
    const code = await generateCode(uid, safeName);
    return res.status(200).json({ code });
  } catch (err) {
    console.error('[couple/code]', err.message);
    return res.status(500).json({ error: 'could not generate code' });
  }
}

// GET /api/couple/pending — P1 polls on app open for P2's completed verification.
async function handlePending(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!isEnabled()) return res.status(200).json({ partnerUid: null }); // fail-open

  const uid = await verifyFirebaseToken(req);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });

  // Generous limit — this is polled on every app open, not just once, so it
  // needs headroom a normal user will never hit. Still worth a backstop since
  // it's an authenticated Redis read on every call.
  const gate = await enforceRateLimit(req, {
    endpoint: 'couple-pending', userMax: 60, ipMax: 120, window: '60 s',
  });
  if (!gate.ok) {
    if (gate.retryAfter) res.setHeader('Retry-After', String(gate.retryAfter));
    return res.status(200).json({ partnerUid: null }); // fail-open, same as store-not-configured
  }

  try {
    const partnerUid = await claimPendingLink(uid);
    return res.status(200).json({ partnerUid: partnerUid || null });
  } catch (err) {
    console.error('[couple/pending]', err.message);
    return res.status(200).json({ partnerUid: null }); // fail-open
  }
}

// POST /api/couple/verify — P2 redeems P1's code.
async function handleVerify(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isEnabled()) return res.status(503).json({ error: 'couple store not configured' });

  const uid = await verifyFirebaseToken(req);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });

  // Security audit fix (SEC-02): this endpoint redeems a 6-char code
  // (32^6 ≈ 1.07B keyspace) and, on a hit, returns the code owner's uid +
  // display name AND registers the caller as their pending link — with no
  // rate limit, a scripted attacker could brute-force live codes, harvest
  // identities, and hijack the pending-link flow ahead of the real partner.
  // Tight limits: a real user mistypes a 6-char code at most a few times.
  const gate = await enforceRateLimit(req, {
    endpoint: 'couple-verify', userMax: 10, ipMax: 20, window: '60 s',
  });
  if (!gate.ok) {
    if (gate.retryAfter) res.setHeader('Retry-After', String(gate.retryAfter));
    return res.status(429).json({ error: 'Too many requests — please slow down.' });
  }

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
}

const ACTIONS = { code: handleCode, pending: handlePending, verify: handleVerify };

module.exports = async function handler(req, res) {
  const action = ACTIONS[req.query.action];
  if (!action) return res.status(404).json({ error: 'unknown action' });
  return action(req, res);
};
