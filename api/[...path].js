/**
 * Vercel serverless function — unified API proxy
 *
 * Routes:
 *   /api/tmdb/*       → https://api.themoviedb.org/3/* (TMDB_KEY injected)
 *   /api/watchmode/*  → https://api.watchmode.com/v1/* (WATCHMODE_KEY injected)
 *
 * Catches all /api/* requests via the top-level catch-all so Vercel
 * reliably detects the function without subdirectory routing quirks.
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { path, ...queryParams } = req.query;
  const segments = Array.isArray(path) ? path : (path ? [path] : []);

  // segments[0] is the service: 'tmdb' or 'watchmode'
  const service  = segments[0];
  const subPath  = segments.slice(1).join('/');

  // ── TMDB ──────────────────────────────────────────────────────────────────
  if (service === 'tmdb') {
    const url = new URL(`https://api.themoviedb.org/3/${subPath}`);
    url.searchParams.set('api_key', process.env.TMDB_KEY);

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
      const isStatic = subPath.startsWith('genre/') || subPath.includes('/collection/');
      res.setHeader(
        'Cache-Control',
        isStatic
          ? 's-maxage=86400, stale-while-revalidate=604800'
          : 's-maxage=1800, stale-while-revalidate=3600'
      );
      return res.status(upstream.status).json(data);
    } catch (err) {
      console.error('[TMDB proxy]', err.message);
      return res.status(502).json({ error: 'Upstream TMDB unavailable' });
    }
  }

  // ── Watchmode ─────────────────────────────────────────────────────────────
  if (service === 'watchmode') {
    const url = new URL(`https://api.watchmode.com/v1/${subPath}/`);
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
  }

  return res.status(404).json({ error: 'Unknown service' });
};
