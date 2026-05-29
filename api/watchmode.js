/**
 * Vercel serverless function — Watchmode proxy
 * Client calls: GET /api/watchmode?_p=search&search_field=tmdb_movie_id&search_value=123
 * Proxied to:   GET https://api.watchmode.com/v1/search/?apiKey=<secret>&search_field=...
 */
// The client only ever hits two endpoint families: title-ID search and a
// title's streaming sources. Watchmode's free tier is a hard monthly request
// quota, so locking the proxy to these prevents it being used as an open relay
// that drains the quota.
const ALLOWED_PREFIXES = ['search', 'title/'];

const { enforceRateLimit } = require('../lib/rateLimit');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.WATCHMODE_KEY) {
    console.error('[Watchmode proxy] WATCHMODE_KEY not configured');
    return res.status(503).json({ error: 'Watchmode service not configured' });
  }

  const { _p: wmPath = '', ...queryParams } = req.query;

  if (!ALLOWED_PREFIXES.some(prefix => wmPath.startsWith(prefix))) {
    return res.status(403).json({ error: 'Endpoint not allowed' });
  }

  // Rate-limit before spending the (hard monthly) Watchmode quota. Two-tier
  // (per-user uid + per-IP backstop); fail-open if Upstash is unreachable.
  const gate = await enforceRateLimit(req, {
    endpoint: 'watchmode', userMax: 30, ipMax: 120, window: '60 s',
  });
  if (!gate.ok) {
    if (gate.retryAfter) res.setHeader('Retry-After', String(gate.retryAfter));
    return res.status(429).json({ error: 'Too many requests — please slow down.' });
  }

  const url = new URL(`https://api.watchmode.com/v1/${wmPath}/`);
  url.searchParams.set('apiKey', process.env.WATCHMODE_KEY);

  for (const [key, value] of Object.entries(queryParams)) {
    url.searchParams.set(key, value);
  }

  try {
    const upstream = await fetch(url.toString());
    const data = await upstream.json();
    // `public`: shared (non-user-specific) response, safe for the CDN to cache
    // even though the request now carries an Authorization header (used only
    // for per-user rate limiting — it never varies the body).
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error('[Watchmode proxy]', err.message);
    return res.status(502).json({ error: 'Upstream Watchmode unavailable' });
  }
};
