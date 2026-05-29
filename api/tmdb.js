/**
 * Vercel serverless function — TMDB proxy
 * Client calls: GET /api/tmdb?_p=discover/movie&sort_by=...
 * Proxied to:   GET https://api.themoviedb.org/3/discover/movie?api_key=<secret>&sort_by=...
 */
// Endpoint families the client actually uses. Constrains the proxy to TMDB
// read paths we rely on instead of being an open relay to the whole TMDB API
// (which would let anyone burn our key's rate budget on arbitrary endpoints).
const ALLOWED_PREFIXES = ['discover/', 'genre/', 'movie/', 'tv/', 'collection/'];

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.TMDB_KEY) {
    console.error('[TMDB proxy] TMDB_KEY not configured');
    return res.status(503).json({ error: 'TMDB service not configured' });
  }

  const { _p: tmdbPath = '', ...queryParams } = req.query;

  if (!ALLOWED_PREFIXES.some(prefix => tmdbPath.startsWith(prefix))) {
    return res.status(403).json({ error: 'Endpoint not allowed' });
  }

  const url = new URL(`https://api.themoviedb.org/3/${tmdbPath}`);
  url.searchParams.set('api_key', process.env.TMDB_KEY);

  for (const [key, value] of Object.entries(queryParams)) {
    if (Array.isArray(value)) value.forEach(v => url.searchParams.append(key, v));
    else url.searchParams.set(key, value);
  }

  try {
    const upstream = await fetch(url.toString());
    const data = await upstream.json();
    const isStatic = tmdbPath.startsWith('genre/') || tmdbPath.includes('/collection/');
    res.setHeader('Cache-Control', isStatic
      ? 's-maxage=86400, stale-while-revalidate=604800'
      : 's-maxage=1800, stale-while-revalidate=3600'
    );
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error('[TMDB proxy]', err.message);
    return res.status(502).json({ error: 'Upstream TMDB unavailable' });
  }
};
