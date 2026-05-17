/**
 * Vercel serverless function — Watchmode proxy
 * Client calls: GET /api/watchmode?_p=search&search_field=tmdb_movie_id&search_value=123
 * Proxied to:   GET https://api.watchmode.com/v1/search/?apiKey=<secret>&search_field=...
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { _p: wmPath = '', ...queryParams } = req.query;

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
    return res.status(502).json({ error: 'Upstream Watchmode unavailable' });
  }
};
