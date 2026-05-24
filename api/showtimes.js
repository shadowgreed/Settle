// ─────────────────────────────────────────────────────────────────────────────
// Vercel serverless proxy for SerpAPI Google Showtimes.
// Keeps SERP_API_KEY server-side — it never reaches the browser bundle.
//
// Query params (all forwarded from the client):
//   movie  — movie title string (required)
//   zip    — 5-digit ZIP code   (preferred location signal)
//   lat    — latitude           (used when no zip)
//   lng    — longitude          (used when no zip)
//
// CORS: Same-origin in production (frontend + API both live on trysettle.app),
// but explicit headers added defensively. iOS Safari in PWA standalone mode
// has been observed treating requests with stricter rules than its browser
// mode — explicit ACAO + ACAM avoids any ambiguity.
// ─────────────────────────────────────────────────────────────────────────────

const SERP_BASE = 'https://serpapi.com/search.json';

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Vary',                         'Origin');
}

module.exports = async function handler(req, res) {
  setCorsHeaders(res);

  // Preflight — some Safari PWA contexts send OPTIONS unexpectedly.
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.SERP_API_KEY) {
    console.error('[showtimes] SERP_API_KEY not configured');
    return res.status(503).json({ error: 'Showtimes service not configured' });
  }

  const { movie, zip, lat, lng } = req.query;

  if (!movie) {
    return res.status(400).json({ error: 'movie parameter required' });
  }

  // ZIP is the most reliable signal for SerpAPI's Google engine. Lat/lng
  // works but is less precise for hyper-local results.
  const location = zip || (lat && lng ? `${lat},${lng}` : null);
  if (!location) {
    return res.status(400).json({ error: 'zip or lat+lng required' });
  }

  try {
    const params = new URLSearchParams({
      engine:  'google',
      q:       `${movie} showtimes`,
      location,
      hl:      'en',
      gl:      'us',
      api_key: process.env.SERP_API_KEY,
    });

    const upstream = await fetch(`${SERP_BASE}?${params}`);
    const data     = await upstream.json();

    if (!upstream.ok) {
      const msg = data?.error || `SerpAPI ${upstream.status}`;
      console.error('[showtimes] upstream error:', msg);
      return res.status(502).json({ error: msg });
    }

    // Showtimes are date-specific; 30-min CDN cache is safe.
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=300');
    return res.status(200).json(data);
  } catch (err) {
    console.error('[showtimes proxy]', err.message);
    return res.status(502).json({ error: 'Showtimes request failed' });
  }
};
