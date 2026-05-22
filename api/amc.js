/**
 * Vercel serverless function — AMC Theatres API proxy.
 *
 * AMC's developer API requires the vendor key in an `X-AMC-Vendor-Key`
 * header. Server-side only — never expose AMC_API_KEY to the browser
 * bundle.
 *
 * Client calls: GET /api/amc?_p=v2/theatres&location.lat=...&location.long=...
 * Proxied to:   GET https://api.amctheatres.com/v2/theatres?location.lat=...
 *               + header: X-AMC-Vendor-Key: <secret>
 *
 * Cache strategy:
 *   - Theater list lookups (theatres?location.*) — 1h CDN cache. Theaters
 *     don't move; theaters opening/closing is a slow signal.
 *   - Showtime lookups — 5min CDN cache. Showtimes update throughout the
 *     day as seats book up, but minute-level freshness isn't critical.
 *   - Everything else — no cache (defensive default).
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.AMC_API_KEY) {
    return res.status(503).json({ error: 'AMC API not configured' });
  }

  const { _p: amcPath = '', ...queryParams } = req.query;
  if (!amcPath) {
    return res.status(400).json({ error: 'Missing _p (endpoint path)' });
  }

  // Whitelist allowed endpoints — defensive against the proxy being used
  // as a generic open relay. AMC's API has dozens of endpoints we don't use.
  const ALLOWED_PREFIXES = [
    'v2/theatres',
    'v2/movies',
    'v2/showtimes',
  ];
  if (!ALLOWED_PREFIXES.some(prefix => amcPath.startsWith(prefix))) {
    return res.status(403).json({ error: 'Endpoint not allowed' });
  }

  const url = new URL(`https://api.amctheatres.com/${amcPath}`);
  for (const [key, value] of Object.entries(queryParams)) {
    if (Array.isArray(value)) value.forEach(v => url.searchParams.append(key, v));
    else url.searchParams.set(key, value);
  }

  try {
    const upstream = await fetch(url.toString(), {
      headers: {
        'X-AMC-Vendor-Key': process.env.AMC_API_KEY,
        'Accept': 'application/json',
      },
    });
    const data = await upstream.json();

    // CDN cache by endpoint family
    const isShowtimes = amcPath.includes('showtimes');
    const isTheatres  = amcPath.startsWith('v2/theatres') && !isShowtimes;
    if (isShowtimes) {
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    } else if (isTheatres) {
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    }

    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error('[AMC proxy]', err.message);
    return res.status(502).json({ error: 'Upstream AMC unavailable' });
  }
};
