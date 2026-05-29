/**
 * Vercel cron — weekly re-engagement push for idle Settle users.
 * PM roadmap 3.1.
 *
 * Schedule: configured via vercel.json `crons` (recommended: weekly Friday 7pm UTC).
 * Vercel hits this endpoint with a CRON_SECRET header that we verify.
 *
 * For each user that:
 *   - has at least one pushSubscription saved
 *   - hasn't been active in 3+ days (lastSeenAt < now - 3 days)
 *   - has a built taste profile (>=1 top genre)
 * we:
 *   - find their top 3 genres from tasteProfile.solo
 *   - query TMDB for new releases in those genres + their selected services
 *   - send a push notification via web-push library (signed with VAPID)
 *
 * Required environment variables:
 *   VAPID_PUBLIC_KEY        — same value as REACT_APP_VAPID_PUBLIC_KEY
 *   VAPID_PRIVATE_KEY       — server-only, NEVER expose to client
 *   VAPID_SUBJECT           — mailto:hello@trysettle.app
 *   CRON_SECRET             — opaque token Vercel sends in the Authorization header
 *   FIREBASE_PROJECT_ID     — for Firebase Admin SDK
 *   FIREBASE_CLIENT_EMAIL   — service account email
 *   FIREBASE_PRIVATE_KEY    — service account private key
 *   TMDB_KEY                — already configured for the proxy
 *
 * Setup (one-time):
 *   1. npx web-push generate-vapid-keys
 *      → copy publicKey to REACT_APP_VAPID_PUBLIC_KEY
 *      → copy privateKey to VAPID_PRIVATE_KEY
 *   2. Add a CRON_SECRET (any long random string) to Vercel env
 *   3. Generate a Firebase service account JSON:
 *      Firebase Console → Settings → Service accounts → Generate new private key
 *      Add the email + key + project_id to Vercel env
 *   4. Configure the cron schedule in vercel.json (see comment block below)
 *   5. npm install web-push firebase-admin in the project root
 *
 * This file is SCAFFOLDED — wire-up code is present, but the VAPID and
 * Firebase Admin pieces require the env vars above to actually fire pushes.
 * Without them the endpoint returns a friendly error so cron retries don't
 * burn budget.
 */

// Conditional imports — these throw at install time if not present, so we
// require them lazily inside the handler. The endpoint stays callable for
// health checks even before deps are installed.
let webpush, admin;

const crypto = require('crypto');

// Constant-time string compare so the CRON_SECRET check doesn't leak length
// or prefix-match information through response timing.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const PROVIDER_IDS = {
  'Netflix':     8,
  'Max':         1899,
  'Disney+':     337,
  'Apple TV':    350,
  'Prime Video': 9,
};

module.exports = async function handler(req, res) {
  // ── Auth ─────────────────────────────────────────────────────────────
  const expectedAuth = `Bearer ${process.env.CRON_SECRET || ''}`;
  if (!process.env.CRON_SECRET || !safeEqual(req.headers.authorization || '', expectedAuth)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // ── Env sanity ───────────────────────────────────────────────────────
  const requiredEnv = [
    'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT',
    'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY',
    'TMDB_KEY',
  ];
  const missing = requiredEnv.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.warn('[push cron] Missing env:', missing.join(', '));
    return res.status(503).json({ error: 'env not configured', missing });
  }

  // ── Lazy require so the function loads even without deps installed ──
  try {
    webpush = require('web-push');
    admin   = require('firebase-admin');
  } catch (e) {
    return res.status(503).json({
      error: 'dependencies not installed',
      hint:  'npm install web-push firebase-admin',
    });
  }

  // ── Init ─────────────────────────────────────────────────────────────
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // Vercel stores newlines as literal "\n" in env vars — convert.
        privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
  }
  const db = admin.firestore();

  // ── Find candidate users ─────────────────────────────────────────────
  // Users with at least one push subscription. We then filter client-side
  // by lastSeenAt because Firestore queries on missing fields are tricky.
  const cutoff = Date.now() - THREE_DAYS_MS;
  const snap = await db.collection('users').get();

  let sent = 0, skipped = 0, failed = 0, gone = 0;
  for (const userDoc of snap.docs) {
    const u = userDoc.data();
    const subs = Array.isArray(u.pushSubscriptions) ? u.pushSubscriptions : [];
    if (subs.length === 0)                       { skipped++; continue; }

    // updatedAt is the sync timestamp we already write on every push. If
    // it's recent (< 3 days), the user is active — skip.
    const lastSeen = u.updatedAt?.toMillis?.() ?? 0;
    if (lastSeen > cutoff)                       { skipped++; continue; }

    // Build top genres from tasteProfile.solo
    const profile = u.tasteProfile?.solo || {};
    const topIds = Object.entries(profile)
      .filter(([, score]) => score >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id]) => id);
    if (topIds.length === 0)                     { skipped++; continue; }

    const services = u.prefs?.services || [];
    const providerIds = services
      .map(s => PROVIDER_IDS[s])
      .filter(Boolean)
      .join('|');
    if (!providerIds)                            { skipped++; continue; }

    // Count new releases in those genres + services for the last 7 days.
    const floor = new Date(Date.now() - SEVEN_DAYS_MS).toISOString().slice(0, 10);
    let count = 0;
    try {
      const params = new URLSearchParams({
        api_key:                    process.env.TMDB_KEY,
        with_watch_providers:       providerIds,
        watch_region:               'US',
        'primary_release_date.gte': floor,
        with_genres:                topIds.join('|'),
        'vote_count.gte':           '5',
        page:                       '1',
      });
      const r = await fetch(`https://api.themoviedb.org/3/discover/movie?${params}`);
      const json = await r.json();
      count = json?.total_results || 0;
    } catch (e) {
      console.warn('[push cron] TMDB query failed for', userDoc.id, e.message);
    }

    if (count === 0)                             { skipped++; continue; }

    const payload = JSON.stringify({
      title: 'Settle',
      body:  `${count} new title${count === 1 ? '' : 's'} in your genres dropped this week.`,
      url:   '/',
      tag:   'settle-newrel-weekly',
    });

    // Send to all of this user's subscribed devices. Remove any that
    // come back with 404/410 — they're stale endpoints (uninstalled PWA,
    // revoked permission, etc.) and will never deliver.
    const validSubs = [];
    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub, payload);
        validSubs.push(sub);
        sent++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          gone++; // drop it
        } else {
          validSubs.push(sub); // keep on transient errors
          failed++;
          console.warn('[push cron] send failed for', userDoc.id, e.statusCode, e.body);
        }
      }
    }

    // Persist pruned subscription list if any were removed.
    if (validSubs.length !== subs.length) {
      await userDoc.ref.update({ pushSubscriptions: validSubs });
    }
  }

  console.log(`[push cron] sent=${sent} skipped=${skipped} failed=${failed} gone=${gone}`);
  return res.status(200).json({ sent, skipped, failed, gone });
};

/*
  ── vercel.json cron config ─────────────────────────────────────────────
  Add to vercel.json:

    "crons": [
      {
        "path": "/api/cron/push-notifications",
        "schedule": "0 19 * * 5"   // Fridays at 19:00 UTC (3pm ET / noon PT)
      }
    ]

  Vercel automatically attaches the Authorization: Bearer <CRON_SECRET>
  header when invoking the cron, as long as CRON_SECRET is set in env.
*/
