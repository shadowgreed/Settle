/**
 * Vercel cron — weekly re-engagement push for idle Settle users.
 * PM roadmap 3.1.
 *
 * Reads push profiles from Upstash (lib/pushStore.js), NOT Firestore. This is
 * the unblock: the original version needed firebase-admin → a service-account
 * key → forbidden by org policy `iam.disableServiceAccountKeyCreation`. Upstash
 * is read over plain REST with the token we already use for rate limiting, so
 * no service-account key is required.
 *
 * For each user that:
 *   - has at least one push subscription
 *   - has been idle 3+ days (lastSeenAt older than the cutoff)
 *   - hasn't been pushed in the last 7 days (lastNotifiedAt frequency gate)
 *   - has a built taste profile (≥1 top genre) and ≥1 known service
 *   - actually has new releases this week in those genres + services
 * we send a single notification via web-push (signed with VAPID) and prune any
 * subscriptions the push service reports as gone (404/410).
 *
 * SCHEDULE: configured in vercel.json. We run DAILY but the per-user 7-day
 * lastNotifiedAt gate means any given user is pinged at most weekly — so this
 * works on any Vercel plan (incl. Hobby's once-per-day cron limit) without
 * over-notifying.
 *
 * Required environment variables:
 *   VAPID_PUBLIC_KEY   — same value as REACT_APP_VAPID_PUBLIC_KEY
 *   VAPID_PRIVATE_KEY  — server-only, NEVER expose to the client
 *   VAPID_SUBJECT      — mailto:hello@trysettle.app (or your contact URL)
 *   CRON_SECRET        — opaque token Vercel sends in the Authorization header
 *   TMDB_KEY           — already configured for the TMDB proxy
 *   UPSTASH_REDIS_REST_URL / _TOKEN (or KV_REST_API_URL / _TOKEN)
 */

const crypto = require('crypto');
const { isEnabled, listProfiles, commitAfterSend } = require('../../lib/pushStore');

// web-push is CommonJS; require it lazily so the function still loads (for the
// 503 health response) even if the dependency is somehow absent.
let webpush;

// Constant-time compare so the CRON_SECRET check doesn't leak length/prefix
// information through response timing.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// App service names → TMDB watch-provider ids (US).
const PROVIDER_IDS = {
  Netflix: 8,
  Max: 1899,
  'Disney+': 337,
  'Apple TV': 350,
  'Prime Video': 9,
};

module.exports = async function handler(req, res) {
  // ── Auth ─────────────────────────────────────────────────────────────────
  const expectedAuth = `Bearer ${process.env.CRON_SECRET || ''}`;
  if (!process.env.CRON_SECRET || !safeEqual(req.headers.authorization || '', expectedAuth)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // ── Env sanity ─────────────────────────────────────────────────────────────
  const requiredEnv = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'TMDB_KEY'];
  const missing = requiredEnv.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.warn('[push cron] Missing env:', missing.join(', '));
    return res.status(503).json({ error: 'env not configured', missing });
  }
  if (!isEnabled()) {
    return res.status(503).json({ error: 'push store not configured' });
  }

  try {
    webpush = require('web-push');
  } catch {
    return res.status(503).json({ error: 'web-push not installed' });
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  // ── Load candidates from Upstash ───────────────────────────────────────────
  let profiles;
  try {
    profiles = await listProfiles();
  } catch (e) {
    console.error('[push cron] listProfiles failed:', e.message);
    return res.status(500).json({ error: 'store read failed' });
  }

  const now = Date.now();
  const idleCutoff = now - THREE_DAYS_MS; // lastSeenAt older than this = idle
  const notifyCutoff = now - SEVEN_DAYS_MS; // lastNotifiedAt older than this = eligible
  const releaseFloor = new Date(now - SEVEN_DAYS_MS).toISOString().slice(0, 10);

  let users = 0;
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let gone = 0;

  for (const p of profiles) {
    const subs = Array.isArray(p.subs) ? p.subs : [];
    if (subs.length === 0) {
      skipped++;
      continue;
    }
    // Active recently — leave them alone.
    if ((p.lastSeenAt || 0) > idleCutoff) {
      skipped++;
      continue;
    }
    // Already pinged this week — frequency cap.
    if ((p.lastNotifiedAt || 0) > notifyCutoff) {
      skipped++;
      continue;
    }

    const topIds = (Array.isArray(p.topGenres) ? p.topGenres : [])
      .map(Number)
      .filter(Number.isFinite)
      .slice(0, 3);
    if (topIds.length === 0) {
      skipped++;
      continue;
    }

    const providerIds = (Array.isArray(p.services) ? p.services : [])
      .map((s) => PROVIDER_IDS[s])
      .filter(Boolean)
      .join('|');
    if (!providerIds) {
      skipped++;
      continue;
    }

    // How many new releases this week in their genres + services?
    let count = 0;
    try {
      const params = new URLSearchParams({
        api_key: process.env.TMDB_KEY,
        with_watch_providers: providerIds,
        watch_region: 'US',
        'primary_release_date.gte': releaseFloor,
        with_genres: topIds.join('|'),
        'vote_count.gte': '5',
        page: '1',
      });
      const r = await fetch(`https://api.themoviedb.org/3/discover/movie?${params}`);
      const json = await r.json();
      count = json?.total_results || 0;
    } catch (e) {
      console.warn('[push cron] TMDB query failed for', p.uid, e.message);
    }
    if (count === 0) {
      skipped++;
      continue;
    }

    users++;
    const payload = JSON.stringify({
      title: 'Settle',
      body: `${count} new title${count === 1 ? '' : 's'} in your genres dropped this week.`,
      url: '/',
      tag: 'settle-newrel-weekly',
    });

    // Send to every device. Drop endpoints the push service says are gone
    // (404/410 = uninstalled PWA / revoked permission); keep on transient errors.
    const validSubs = [];
    let okThisUser = 0;
    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub, payload);
        validSubs.push(sub);
        okThisUser++;
        sent++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          gone++;
        } else {
          validSubs.push(sub);
          failed++;
          console.warn('[push cron] send failed for', p.uid, e.statusCode);
        }
      }
    }

    // Persist pruned subs + stamp lastNotifiedAt only if something landed.
    try {
      await commitAfterSend(p.uid, { subs: validSubs, notified: okThisUser > 0 });
    } catch (e) {
      console.warn('[push cron] commit failed for', p.uid, e.message);
    }
  }

  console.log(
    `[push cron] users=${users} sent=${sent} skipped=${skipped} failed=${failed} gone=${gone}`
  );
  return res.status(200).json({ users, sent, skipped, failed, gone });
};

/*
  ── vercel.json cron config ─────────────────────────────────────────────────
  Add to vercel.json:

    "crons": [
      { "path": "/api/cron/push-notifications", "schedule": "0 19 * * *" }
    ]

  Runs daily at 19:00 UTC; the per-user 7-day gate keeps each user weekly.
  Vercel attaches Authorization: Bearer <CRON_SECRET> automatically when
  CRON_SECRET is set in the project env.
*/
