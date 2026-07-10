# Settle — Project Reference

Ground-truth reference for this repo. Read this before inferring the stack from file
extensions, or assuming conventions from a different framework — several assumptions
that "look" plausible (Next.js? TypeScript? Tailwind? Supabase?) are **not true here**,
and got a prior audit's category grades wrong until corrected against actual code.

This file can go stale as the repo evolves — if something below contradicts what you
actually read in the code, trust the code and update this file, not the other way around.

## What This Is

Settle is a mood-first streaming decision app. Users answer a few quick "vibe" questions
(Fun, Romantic, Scary, Sci-Fi, Anime, decade throwbacks, etc.) instead of browsing
endlessly, and get one solid pick — solo, with a partner (Couples Mode), or for a night
at the theater (Theater Mode). Free, no ads.

Live at: https://trysettle.app

## Tech Stack — Verify Against This Before Assuming Anything

| Layer | Actual | NOT this |
|---|---|---|
| Frontend framework | Create React App (`react-scripts`) | ~~Next.js~~ |
| Language | Plain JavaScript / JSX | ~~TypeScript~~ — zero `.ts`/`.tsx` files, no `typescript` dependency |
| Styling | Hand-rolled CSS per component, `:root` CSS custom properties for design tokens | ~~Tailwind~~ — no config, no dependency |
| Database / Auth | Firebase (Firestore + Authentication) | ~~Supabase~~ — not in this repo at all |
| AI / LLM | None | ~~Anthropic API~~ — zero LLM calls anywhere in this codebase |
| Backend | Vercel serverless functions, plain Node.js CommonJS (`api/*.js`) | not Next.js API routes, not Express |
| Native wrapper | Capacitor (real iOS/Android builds under `ios/`, `android/`) | in addition to being a PWA — this app is both |

If a request or prior document describes this app as Next.js/TypeScript/Tailwind/
Supabase/Anthropic-powered, that description does not match this repo — check
`package.json` and actual file extensions before proceeding on that premise.

## Directory Map

- **`src/`** — the CRA frontend. `App.js` is the single large root component (mood
  picker, couples flow, theater mode, settings, history — most feature logic lives
  here). `src/components/` — modals/sheets (Settings, CoupleLink, ShowtimesSheet,
  Onboarding, etc.), each usually paired with its own `.css` file. `src/services/` —
  client-side service modules (`tmdb.js`, `couple.js`, `cloudSync.js`, `analytics.js`,
  `push.js`, `authHeader.js`, `firebase.js`). `src/assets/` — brand imagery.
- **`api/`** — Vercel serverless functions, one file (or `[dynamic]` folder) per route
  family. Plain Node CommonJS, `(req, res)` signature, **no build/transpile step** — a
  `.jsx` file here with real JSX syntax throws `SyntaxError` at runtime in production
  (confirmed the hard way this session). Some routes are consolidated behind
  `[action].js` / `[id].js` dynamic segments specifically to stay under Vercel Hobby's
  12-serverless-function-per-deployment cap.
- **`lib/`** — shared server-side modules imported by `api/*.js`: rate limiting
  (`rateLimit.js`), Firebase ID-token verification without firebase-admin
  (`firebaseAuth.js`), Upstash-backed stores for couples linking / push subscriptions /
  showtimes+share-card caching, and the share-card Satori layout (`shareCardLayout.js`,
  plain `React.createElement` calls, not JSX — same no-transpile reason as above).
- **`public/`** — static assets, `manifest.json` (PWA config), `sw.js` (service worker).
- **`firestore.rules`** — Firestore security rules. **Editing this file does NOT deploy
  it.** `firebase deploy --only firestore:rules` is a separate, manual step — always
  diff against the live Firebase Console rules first (the file's own header says so).
  Don't run that deploy command without the repo owner doing it themselves.
- **`ios/`, `android/`** — Capacitor-generated native project shells.
- **`.env`, `.env.local`** (gitignored) — server-only secrets vs. `REACT_APP_`-prefixed
  client-bundle-safe values respectively; see `.env.example` / `.env.local.example` for
  the documented list of what belongs in each.

## Core Features

- **Solo Picker** — mood/genre/format/rating/content-rating filters narrow TMDB's
  catalog down to one recommendation, scoped to the user's selected streaming services.
- **Couples Mode** — partner linking via a 6-character Upstash-backed invite code;
  shared mood selection; "secret ballot" voting (both vote blind, then reveal together)
  via Firestore `pendingBallots` / `coupleSessions`.
- **Theater Mode** — nearby showtimes (SerpAPI / Google Showtimes) by location or ZIP,
  with an in-app ticket-purchase handoff.
- **Watch History / Save for Later** — rating past picks feeds a taste profile that
  weights future recommendations; bookmarking for later.
- **Shareable Pick Cards** — server-side rendered share images (Story / Portrait /
  Square / OG-link-preview formats) via `@vercel/og` (Satori), cached in Upstash, with
  a QR code on Story format and a public `/pick/:id` unfurl page for link previews.
- **Push Notifications** — opt-in re-engagement, couple ballot alerts, "how was it?"
  watch-loop nudges — via `web-push`/VAPID on web, `@capacitor/push-notifications`
  natively.
- **Settings & Privacy** — cloud-sync consent gate, partner unlinking, full self-serve
  account deletion (Firestore doc + push subscriptions + analytics identity — not just
  the Firebase auth record).

## Third-Party Services

| Service | Used for |
|---|---|
| Firebase Auth + Firestore | Sign-in, per-user profile/preferences/history storage, security rules |
| TMDB API | Movie/TV metadata, posters, genres |
| Watchmode API | Direct streaming links (Disney+, Apple TV) |
| SerpAPI (Google Showtimes) | Theater Mode nearby showtimes |
| Google Geocoding | Coordinates → ZIP/area for showtimes search (raw coordinates never stored) |
| Upstash (Redis) | Rate limiting, couple-linking rendezvous, push-subscription store, share-card/showtimes cache |
| PostHog | Anonymous product analytics — consent-gated, only activates after explicit opt-in |
| Vercel | Hosting, serverless functions, cron (weekly push re-engagement) |

## Conventions Worth Knowing

- Every `api/*.js` route touching user-specific data verifies a Firebase ID token
  itself (`lib/firebaseAuth.js`) — no `firebase-admin`, since that needs a
  service-account key blocked by an org policy. Verification checks the JWT directly
  against Google's public securetoken certs.
- Expensive or abusable routes are rate-limited via `lib/rateLimit.js`
  (`enforceRateLimit`) — two-tier (per-uid + per-IP), fails open if Upstash isn't
  configured. Not every route has this yet — check before assuming it's universal.
- `lib/` and `api/` files are CommonJS, never ESM, and never contain JSX — Vercel's
  Node runtime doesn't transpile anything for a plain `.js` function. Packages whose
  package.json declares `"type": "module"` with no `require` export condition (e.g.
  `@vercel/og`) need a dynamic `import()`, not a top-level `require()`.
- Analytics (`src/services/analytics.js`) only fire after the user has granted storage
  consent (`localStorage['sd_consent'] === 'true'`) — this is an enforced code gate,
  not just a policy statement.
- Design tokens live as CSS custom properties in `src/App.css`'s `:root` block, but
  adoption is inconsistent — plenty of literal hex values still exist alongside them.
