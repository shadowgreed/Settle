/**
 * Vercel serverless function — Watchmode API proxy
 *
 * Forwards GET requests from the client to Watchmode, injecting the API key
 * server-side so it is never compiled into the browser JS bundle.
 *
 * Client calls:  GET /api/watchmode/search/?search_field=tmdb_movie_id&search_value=123
 * Proxied to:    GET https://api.watchmode.com/v1/search/?apiKey=<secret>&search_field=...
 *
 * Client calls:  GET /api/watchmode/title/456/sources/?regions=US
 * Proxied to:    GET https://api.watchmode.com/v1/title/456/sources/?apiKey=<secret>&regions=US
 *
 * Watchmode data is stable — edge-cached for 24 hours (mirrors the 7-day
 * localStorage cache in watchmode.js so the CDN absorbs repeat lookups).
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { path, ...queryParams } = req.query;
  const wmPath = Array.isArray(path) ? path.join('/') : (path || '');

  // Watchmode URLs end with a trailing slash
  const url = new URL(`https://api.watchmode.com/v1/${wmPath}/`);
  url.searchParams.set('apiKey', process.env.WATCHMODE_KEY);

  for (const [key, value] of Object.entries(queryParams)) {
    url.searchParams.set(key, value);
  }

  try {
    const upstream = await fetch(url.toString());
    const data = await upstream.json();

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error('[Watchmode proxy]', err.message);
    return res.status(502).json({ error: 'Upstream API unavailable' });
  }
}
