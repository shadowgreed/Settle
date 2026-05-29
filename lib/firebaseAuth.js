// ─────────────────────────────────────────────────────────────────────────────
// Firebase ID-token verification WITHOUT the Admin SDK.
//
// We verify the token's RS256 signature against Google's PUBLIC securetoken
// certificates — no service-account key required. That matters here: the
// Firebase org policy `iam.disableServiceAccountKeyCreation` blocks key
// creation (it's the same policy that has push notifications parked), and the
// Admin SDK needs such a key to initialise. This path needs none, so it works
// cleanly under that policy.
//
// Purpose: derive a *stable, forge-proof* identity (the uid) for per-user rate
// limiting. The uid can't be spoofed because the token is cryptographically
// signed by Google and we check the signature + issuer + audience + expiry.
//
// On ANY failure we return null and the caller treats the request as anonymous
// (IP-tier limiting only). Verification never blocks a request by itself.
// ─────────────────────────────────────────────────────────────────────────────

// jose v6 is ESM-only — it ships no CommonJS build, so a top-level
// `require('jose')` throws ERR_REQUIRE_ESM on Vercel's Node 18/20 serverless
// runtime (which lacks require-of-ESM support) and crashes the whole function
// at load. A dynamic import() from CommonJS works on every Node version, so we
// load jose lazily and memoise the promise across warm invocations.
let josePromise;
function getJose() {
  if (!josePromise) josePromise = import('jose');
  return josePromise;
}

// Project id is public (it's in the client bundle + CSP). Overridable via env.
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'settle-b3887';
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;
const CERT_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

// Imported public keys, cached in module scope across warm invocations and
// refreshed per Google's Cache-Control max-age (the securetoken keys rotate
// roughly daily). Keyed by `kid`.
let cache = { keys: {}, expiresAt: 0 };

async function loadKeys() {
  const now = Date.now();
  if (now < cache.expiresAt && Object.keys(cache.keys).length) return cache.keys;

  const { importX509 } = await getJose();
  const resp = await fetch(CERT_URL);
  if (!resp.ok) throw new Error(`securetoken cert fetch ${resp.status}`);
  const pems = await resp.json(); // { "<kid>": "-----BEGIN CERTIFICATE-----...", ... }

  const keys = {};
  await Promise.all(
    Object.entries(pems).map(async ([kid, pem]) => {
      try {
        keys[kid] = await importX509(pem, 'RS256');
      } catch {
        /* skip a cert we can't parse rather than failing the whole refresh */
      }
    })
  );

  let maxAge = 3600;
  const m = (resp.headers.get('cache-control') || '').match(/max-age=(\d+)/);
  if (m) maxAge = parseInt(m[1], 10);
  cache = { keys, expiresAt: now + maxAge * 1000 };
  return keys;
}

/**
 * Verify the Bearer ID token on `req` and return the Firebase uid, or null.
 * @returns {Promise<string|null>}
 */
async function verifyFirebaseToken(req) {
  try {
    const header = req.headers.authorization || req.headers.Authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(String(header));
    if (!m) return null;
    const token = m[1].trim();
    if (!token) return null;

    const { jwtVerify } = await getJose();
    const { payload } = await jwtVerify(
      token,
      // Key resolver: jose hands us the token's protected header; we return the
      // matching public key. `algorithms` below pins RS256, blocking the
      // classic "alg":"none" / HS256 confusion attacks.
      async (protectedHeader) => {
        const keys = await loadKeys();
        const key = keys[protectedHeader.kid];
        if (!key) throw new Error('unknown kid');
        return key;
      },
      { issuer: ISSUER, audience: PROJECT_ID, algorithms: ['RS256'] }
    );

    return payload.sub || null; // `sub` is the Firebase uid
  } catch {
    // expired / forged / unknown-kid / network — treat as anonymous.
    return null;
  }
}

module.exports = { verifyFirebaseToken };
