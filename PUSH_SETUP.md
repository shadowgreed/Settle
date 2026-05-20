# Web Push — manual setup steps

The client-side push opt-in flow is fully wired and live (PM roadmap 3.1).
Users will see the opt-in banner after their 3rd successful pick. To
actually deliver notifications, the server-side cron needs the following
one-time setup.

---

## 1. Generate VAPID keys

VAPID (Voluntary Application Server Identification) keys identify your
push server to the push service. Generate once, store both halves:

```bash
npx web-push generate-vapid-keys
```

Output looks like:
```
=======================================
Public Key:
BLc4xxx…long-base64-string…xxx

Private Key:
yyy…shorter-base64-string…yyy
=======================================
```

## 2. Add keys to environment

**Local development** — add to `.env.local`:
```
REACT_APP_VAPID_PUBLIC_KEY=BLc4xxx…
```
(Only the public key on the client. The private key never goes here.)

**Vercel project env** — add to `Project Settings → Environment Variables`:
- `REACT_APP_VAPID_PUBLIC_KEY` — same value as above (will be baked into the client bundle on deploy)
- `VAPID_PRIVATE_KEY` — the private half from step 1 (server-only)
- `VAPID_SUBJECT` — `mailto:hello@trysettle.app` (or another contact URL)
- `CRON_SECRET` — any long random string (32+ chars). Vercel sends this as `Authorization: Bearer <secret>` when invoking the cron.

## 3. Firebase Admin SDK credentials

The cron needs server-side Firestore access to read user subscriptions.

1. Firebase Console → ⚙ Project settings → Service accounts → **Generate new private key**
2. Download the JSON. Extract these three fields:
   - `project_id` → `FIREBASE_PROJECT_ID`
   - `client_email` → `FIREBASE_CLIENT_EMAIL`
   - `private_key` → `FIREBASE_PRIVATE_KEY`
3. Add all three to Vercel env. **Important:** for `FIREBASE_PRIVATE_KEY`, Vercel stores newlines as the literal string `\n`. The cron handler replaces them at runtime.

## 4. Install dependencies

The cron uses two npm packages not yet in `package.json`:

```bash
npm install web-push firebase-admin
git commit -am "deps: add web-push + firebase-admin for push cron"
git push
```

## 5. Configure the cron schedule

Edit `vercel.json` to add a `crons` array:

```json
{
  "buildCommand": "npm run build",
  "outputDirectory": "build",
  "crons": [
    {
      "path": "/api/cron/push-notifications",
      "schedule": "0 19 * * 5"
    }
  ],
  "rewrites": [...],
  "headers": [...]
}
```

`0 19 * * 5` = Fridays at 19:00 UTC (3pm ET / noon PT). Adjust to your audience.

Note: Vercel Cron requires the Hobby plan tier or higher. Free tier allows up to 2 cron jobs.

## 6. Verify

1. Push a deploy with the env + dependencies + cron config.
2. Trigger the cron manually from the Vercel dashboard: **Project → Cron Jobs → Run**.
3. Watch the function logs. Expected output:
   ```
   [push cron] sent=0 skipped=N failed=0 gone=0
   ```
   (sent=0 on first run is normal — no users have been idle 3+ days yet.)
4. On a real device:
   - Open Settle in Chrome / Edge / Firefox on Android, or as an installed PWA on iOS 16.4+
   - Generate 3 picks → opt-in banner appears
   - Accept → check Settings: "Turn off notifications" should now be visible
   - Open Firestore console: your user doc should have a `pushSubscriptions` array

## Privacy posture

- Push subscriptions are stored only in the user's Firestore doc, behind the same `users/{uid}` security rule as the rest of their data.
- The cron is consent-gated client-side — users who declined storage consent never see the opt-in.
- The Settings panel has a "Turn off notifications" toggle that removes the subscription from both the browser and Firestore.
- Privacy Policy already references PostHog analytics gated by consent; if you want to add a notification-specific line, the right spot is in the Cloud Sync (Firestore) section since the subscription is stored there.

## Platforms

| Platform | Status |
|---|---|
| Android Chrome / Firefox / Edge | ✅ Full support |
| Desktop Chrome / Edge / Firefox | ✅ Full support |
| iOS Safari (installed PWA, iOS 16.4+) | ✅ Works once installed to home screen |
| iOS Safari (browser tab) | ❌ Not supported by Apple |
| Desktop Safari | ⚠ Limited; opt-in banner will appear but delivery is inconsistent |

The `isPushSupported()` check in `src/services/push.js` hides the opt-in banner on platforms that can't deliver — users never see a prompt that can't be honored.
