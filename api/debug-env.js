/**
 * TEMPORARY diagnostic endpoint. Reports presence + length of relevant
 * env vars without ever exposing their values. DELETE this file once the
 * AMC_API_KEY scope issue is resolved.
 *
 * Returns:
 *   {
 *     amc: { defined, length, first1, last1, trimmed_length },
 *     geo: { defined, length },
 *     tmdb: { defined, length },
 *     node_env: "production"|"preview"|"development",
 *     vercel_env: "production"|"preview"|"development",
 *   }
 */
module.exports = async function handler(req, res) {
  const summarize = (key) => {
    const raw = process.env[key];
    if (raw === undefined) return { defined: false };
    const trimmed = raw.trim();
    return {
      defined: true,
      length: raw.length,
      trimmed_length: trimmed.length,
      // First and last character — useful to spot accidental quotes /
      // wrapping. Single chars only — not enough to leak the secret.
      first1: trimmed.length ? trimmed.charCodeAt(0) : null,
      last1:  trimmed.length ? trimmed.charCodeAt(trimmed.length - 1) : null,
      has_whitespace_padding: raw !== trimmed,
    };
  };

  return res.status(200).json({
    amc:        summarize('AMC_API_KEY'),
    geo:        summarize('GOOGLE_GEOCODING_KEY'),
    tmdb:      summarize('TMDB_KEY'),
    node_env:   process.env.NODE_ENV || null,
    vercel_env: process.env.VERCEL_ENV || null,
    vercel_url: process.env.VERCEL_URL || null,
  });
};
