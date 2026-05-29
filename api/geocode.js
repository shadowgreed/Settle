/**
 * Vercel serverless function — Google Geocoding API proxy.
 *
 * Used for two distinct geocoding flows:
 *   1. address → lat/long (forward geocode)
 *      Called for theater addresses that arrive without coordinates.
 *   2. zip → lat/long (also forward, just a 5-digit-zip query)
 *      Called when the user declines the location permission and types
 *      a ZIP code as fallback.
 *
 * GOOGLE_GEOCODING_KEY env var must be set in Vercel. If absent, the
 * endpoint returns a 503 — the app already handles "no distance ranking"
 * as a degraded path (per spec).
 *
 * Cache strategy: aggressive. Geocoded coordinates are essentially
 * permanent reference data. The `theaters_geocoded` Firestore cache holds
 * results for 30 days client-side; CDN holds 24h as a second layer.
 */

const { enforceRateLimit } = require('../lib/rateLimit');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.GOOGLE_GEOCODING_KEY) {
    return res.status(503).json({ error: 'Geocoding not configured' });
  }

  const { address } = req.query;
  if (!address || typeof address !== 'string') {
    return res.status(400).json({ error: 'Missing address parameter' });
  }
  // Belt-and-suspenders length cap — geocoding requests don't need to be
  // longer than this; longer = probably abuse.
  if (address.length > 200) {
    return res.status(400).json({ error: 'Address too long' });
  }

  // Rate-limit before the paid Google Geocoding call. Two-tier (per-user uid +
  // per-IP backstop); fail-open if Upstash is unreachable. See lib/rateLimit.js.
  const gate = await enforceRateLimit(req, {
    endpoint: 'geocode', userMax: 40, ipMax: 150, window: '60 s',
  });
  if (!gate.ok) {
    if (gate.retryAfter) res.setHeader('Retry-After', String(gate.retryAfter));
    return res.status(429).json({ error: 'Too many requests — please slow down.' });
  }

  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', address);
  url.searchParams.set('key', process.env.GOOGLE_GEOCODING_KEY);
  // US-only — Theater mode is US-only per spec, no point geocoding outside.
  url.searchParams.set('region', 'us');
  url.searchParams.set('components', 'country:US');

  try {
    const upstream = await fetch(url.toString());
    const data = await upstream.json();

    // Normalise to just what callers need — { lat, lng, formatted_address } or { error }.
    // Saves the client from parsing Google's nested response shape.
    if (data.status === 'OK' && data.results?.[0]) {
      const top = data.results[0];
      // `public` keeps the CDN caching this shared (non-user-specific) response
      // even though the request now carries an Authorization header (used only
      // for per-user rate limiting — it never varies the body).
      res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
      return res.status(200).json({
        lat:               top.geometry?.location?.lat ?? null,
        lng:               top.geometry?.location?.lng ?? null,
        formatted_address: top.formatted_address || null,
      });
    }

    // ZERO_RESULTS, INVALID_REQUEST, etc — propagate without retry value.
    return res.status(404).json({
      error: data.status || 'No geocoding result',
      message: data.error_message || null,
    });
  } catch (err) {
    console.error('[Geocode proxy]', err.message);
    return res.status(502).json({ error: 'Upstream geocoding unavailable' });
  }
};
