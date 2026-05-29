// ─────────────────────────────────────────────────────────────────────────────
// Two-tier sliding-window rate limiting for the metered proxies
// (/api/showtimes → paid SerpAPI, /api/geocode → paid Google Geocoding),
// backed by Upstash Redis.
//
//   • USER tier — keyed on the verified Firebase uid. Tight. The real control.
//                 Because Theater Mode is post-login, virtually every metered
//                 call carries an identity, so this caps per-PERSON spend
//                 regardless of which network they're on. This is the fix for
//                 the shared-IP problem: a whole office behind one NAT, or a
//                 mobile carrier's CGNAT pool, no longer shares one bucket —
//                 each real user gets their own.
//
//   • IP tier   — keyed on client IP (IPv6 collapsed to its /64 prefix so a
//                 single user can't farm unlimited buckets by walking their
//                 allocation). Loose. A backstop for anonymous calls and a
//                 brake on a single-source flood. Set high enough to absorb a
//                 NAT'd office without throttling innocents.
//
// Authenticated request → BOTH tiers checked (either can reject).
// Anonymous request     → IP tier only.
//
// FAIL-OPEN by design: if Upstash isn't configured, or Redis errors, or token
// verification throws, we ALLOW the request. A rate limiter must never be the
// component that takes the app down. When the env vars are absent (e.g. local
// dev) this module is completely inert.
// ─────────────────────────────────────────────────────────────────────────────

const { Ratelimit } = require('@upstash/ratelimit');
const { Redis } = require('@upstash/redis');
const { verifyFirebaseToken } = require('./firebaseAuth');

// Accept either the Upstash-native env names or Vercel's KV-integration names —
// the Vercel Marketplace integration has used both over time.
const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

let redis = null;
if (REDIS_URL && REDIS_TOKEN) {
  try {
    redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  } catch (err) {
    console.error('[ratelimit] Redis init failed — limiting disabled:', err.message);
  }
}

// Short-circuit repeated *blocked* calls within a warm instance without a Redis
// round-trip. Shared across all limiter instances.
const ephemeralCache = new Map();

// Limiters are built once per endpoint+tier and reused across invocations.
const limiters = {};

function limiterFor(endpoint, tier, max, window) {
  const cacheKey = `${endpoint}:${tier}`;
  if (limiters[cacheKey]) return limiters[cacheKey];
  const rl = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(max, window),
    prefix: `rl:${endpoint}:${tier}`,
    analytics: false, // keep Redis command count (and cost) lean; toggle on if you want dashboards
    ephemeralCache,
  });
  limiters[cacheKey] = rl;
  return rl;
}

// Real client IP on Vercel = first hop of x-forwarded-for. Collapse IPv6 to its
// /64 prefix; leave IPv4 (and IPv4-mapped IPv6) as-is.
function ipKey(req) {
  const raw = (
    req.headers['x-forwarded-for'] ||
    req.headers['x-real-ip'] ||
    ''
  ).toString();
  const first = raw.split(',')[0].trim() || 'unknown';
  if (first.includes(':') && !first.startsWith('::ffff:')) {
    return first.split(':').slice(0, 4).join(':') + '::/64';
  }
  return first;
}

const DEFAULTS = { userMax: 30, ipMax: 100, window: '60 s' };

/**
 * Enforce the two-tier limit for a request.
 * @param {import('http').IncomingMessage} req
 * @param {{endpoint?: string, userMax?: number, ipMax?: number, window?: string}} [options]
 * @returns {Promise<{ok: boolean, retryAfter?: number, tier?: string}>}
 *   ok:false → caller should respond 429. Always ok:true when not configured or on error.
 */
async function enforceRateLimit(req, options = {}) {
  if (!redis) return { ok: true, skipped: true }; // not configured → inert

  const endpoint = options.endpoint || 'default';
  const cfg = { ...DEFAULTS, ...options };

  try {
    const uid = await verifyFirebaseToken(req);

    // Authenticated → check user (tight) + ip (loose) in parallel.
    // Anonymous     → ip only.
    const tasks = [];
    if (uid) {
      tasks.push(
        limiterFor(endpoint, 'user', cfg.userMax, cfg.window)
          .limit(`uid:${uid}`)
          .then((r) => ({ tier: 'user', r }))
      );
    }
    tasks.push(
      limiterFor(endpoint, 'ip', cfg.ipMax, cfg.window)
        .limit(`ip:${ipKey(req)}`)
        .then((r) => ({ tier: 'ip', r }))
    );

    const settled = await Promise.all(tasks);
    const blocked = settled.find((s) => !s.r.success);
    if (blocked) {
      const retryAfter = Math.max(1, Math.ceil((blocked.r.reset - Date.now()) / 1000));
      return { ok: false, retryAfter, tier: blocked.tier };
    }
    return { ok: true };
  } catch (err) {
    // Redis hiccup, network blip, anything — never take the app down over it.
    console.error(
      `[ratelimit] ${options.endpoint || ''} check failed — failing open:`,
      err.message
    );
    return { ok: true, error: true };
  }
}

module.exports = { enforceRateLimit };
