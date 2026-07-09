/**
 * GET /pick/:id  (rewritten from vercel.json — this file lives at
 * api/pick/[id].js, Vercel's bracket convention for a dynamic segment,
 * exposed at the public /pick/:id path via the rewrite added ahead of the
 * SPA catch-all).
 *
 * Serves a minimal static HTML shell with per-pick og: / twitter: meta tags
 * so link unfurls (iMessage, WhatsApp, Discord, Slack, X) render the right
 * image/title/description (handoff spec §5). A Create React App SPA can't
 * vary meta tags per URL for a crawler that doesn't execute JS — this route
 * is the workaround: crawlers see only the static tags below; real browsers
 * get redirected into the actual app immediately.
 *
 * Query params are the same personalization params the client already sends
 * to /api/share-card (title/year/type/rating/service/genres/posterPath/
 * story/daypart) — forwarded here unchanged via the rewrite's query-string
 * passthrough, and re-forwarded again to build the og:image URL.
 *
 * Node runtime (unlike api/share-card.jsx) — this is plain HTML string
 * assembly, no Satori/image rendering needed here.
 */

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  // Same escaping is safe inside a double-quoted HTML attribute.
  return escapeHtml(str);
}

module.exports = async function handler(req, res) {
  const { id } = req.query;
  const title    = req.query.title || 'a pick';
  const story    = req.query.story || '';

  // Rebuild the query string for the OG image + canonical URLs so every
  // personalization param the client sent survives into both.
  const forwardParams = new URLSearchParams();
  ['title', 'year', 'type', 'rating', 'service', 'genres', 'posterPath', 'story', 'daypart']
    .forEach((key) => {
      if (req.query[key]) forwardParams.set(key, req.query[key]);
    });

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host'] || req.headers.host || 'trysettle.app';
  const base  = `${proto}://${host}`;

  const ogImageUrl = `${base}/api/share-card?fmt=og&${forwardParams.toString()}`;
  const canonicalUrl = `${base}/pick/${encodeURIComponent(id)}?${forwardParams.toString()}`;
  const redirectUrl = `${base}/?${forwardParams.toString()}`;

  const ogTitle = `${title} — picked on Settle`;
  const ogDescription = story || 'Answer a few mood questions, get one great pick. Solo, couples, or in theaters.';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(ogTitle)}</title>
<meta property="og:type" content="website" />
<meta property="og:title" content="${escapeAttr(ogTitle)}" />
<meta property="og:description" content="${escapeAttr(ogDescription)}" />
<meta property="og:image" content="${escapeAttr(ogImageUrl)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:url" content="${escapeAttr(canonicalUrl)}" />
<meta property="og:site_name" content="Settle" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeAttr(ogTitle)}" />
<meta name="twitter:description" content="${escapeAttr(ogDescription)}" />
<meta name="twitter:image" content="${escapeAttr(ogImageUrl)}" />
<meta http-equiv="refresh" content="0;url=${escapeAttr(redirectUrl)}" />
<script>window.location.replace(${JSON.stringify(redirectUrl)});</script>
</head>
<body>
<p>Redirecting to Settle…</p>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Short CDN cache — the underlying pick data never changes, but there's no
  // upside to a long TTL for a page real users only ever glance past.
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
  return res.status(200).send(html);
};
