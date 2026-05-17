/**
 * Vercel serverless function — TMDB API proxy
 *
 * Forwards all GET requests from the client to TMDB, injecting the API key
 * server-side so it is never compiled into the browser JS bundle.
 *
 * Client calls:  GET /api/tmdb/discover/movie?sort_by=popularity.desc&...
 * Proxied to:    GET https://api.themoviedb.org/3/discover/movie?api_key=<secret>&sort_by=...
 *
 * Edge cache headers are set so Vercel's CDN caches responses:
 *   - Genre lists / collections: 24 hours (rarely change)
 *   - Everything else: 30 minutes (matches the in-memory cache in tmdb.js)
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { path, ...queryParams } = req.query;
  const tmdbPath = Array.isArray(path) ? path.join('/') : (path || '');

  const url = new URL(`https://api.themoviedb.org/3/${tmdbPath}`);
  url.searchParams.set('api_key', process.env.TMDB_KEY);

  // Forward every query param the client sent
  for (const [key, value] of Object.entries(queryParams)) {
    if (Array.isArray(value)) {
      value.forEach(v => url.searchParams.append(key, v));
    } else {
      url.searchParams.set(key, value);
    }
  }

  try {
    const upstream = await fetch(url.toString());
    const data = await upstream.json();

    // Genres and collections change very rarely — cache longer at the edge
    const isStatic = tmdbPath.startsWith('genre/') || tmdbPath.includes('/collection/');
    res.setHeader(
      'Cache-Control',
      isStatic
        ? 's-maxage=86400, stale-while-revalidate=604800'  // 1 day + 7-day stale
        : 's-maxage=1800, stale-while-revalidate=3600'     // 30 min + 1-hr stale
    );

    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error('[TMDB proxy]', err.message);
    return res.status(502).json({ error: 'Upstream API unavailable' });
  }
}
