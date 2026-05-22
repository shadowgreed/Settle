# Settle — Engineering Roadmap

Living list of deferred work captured from audits, code reviews, and PD/PM
sessions. Items move from this file into commits as they're completed.

Last updated: 2026-05-20 (Theater Mode 2.0 M2+M3 shipped, AMC vendor key blocked)

---

## Deferred / parked

### Theater Mode 2.0 affiliate flow — blocked on AMC vendor key activation
M2 (proximity foundation) + M3 (AMC integration) are fully shipped in
commit `c4fb6dc`. Live verification shows AMC's servers reject our key
with `code 12005, "Unauthorized VendorKey."` (403). Geocoding + theater
discovery code work end-to-end — the only missing piece is AMC's side
activating the vendor key on our partner account.

Right now users who tap "🎟️ Get tickets" on a theater pick see a clean
"Showtimes temporarily unavailable" message (commit `a819f7b`) instead
of a misleading "not in catalog" error. When AMC activates the key,
**no code change needed** — the existing proxy + UI start working.

Next steps when unblocked:
  1. Confirm vendor-key auth works by curling `/api/amc?_p=v2/theatres&location.lat=...`
  2. Smoke-test the response shape against the normalizers in `src/services/amc.js`
     (might need small field-name adjustments if HAL response shape differs
     from what was assumed)
  3. Then proceed to M4 (affiliate deep-link routing) + M5 (FTC disclosure,
     ToS commission clause, remaining analytics events).

Open questions for PM when revisiting:
  - Is AMC's vendor-key activation manual? Has anyone contacted AMC support
    about the 12005 error?
  - Where do the keys appear in the AMC Developer Portal? User reported
    not being able to see any keys at all in their account.

### Push notification delivery (server side) — blocked on Firebase service account key
The client side is fully shipped (`28f0f15`): service worker push handlers,
subscribe/unsubscribe service, opt-in banner after 3rd successful pick,
Settings toggle, analytics events. The whole client-side opt-in flow is
ready. **Currently dormant** because `isPushSupported()` checks for
`REACT_APP_VAPID_PUBLIC_KEY` env var — without it set, the opt-in banner
and Settings toggle stay hidden so no user can opt in to a feature that
won't deliver.

**What's blocking delivery:** the Vercel cron at
`api/cron/push-notifications.js` needs Firebase Admin SDK to read user
docs from Firestore. Firebase Admin needs a service account JSON key.

Attempted on 2026-05-19:
  1. Generate VAPID keys — ✅ trivial
  2. Generate Firebase service account JSON — ❌ blocked
     - Initial block: org policy `iam.disableServiceAccountKeyCreation`
       enforced. Resolved by granting Org Policy Admin role + overriding
       the policy to "Off" for the project.
     - Also overrode `iam.disableServiceAccountKeyUpload` for good measure.
     - Both policies showed Inactive + Override parent's policy in the UI.
     - **Key creation still failed** with "Key creation is not allowed on
       this service account" — likely a third policy or a Google Cloud
       restriction we didn't surface.

**Resume paths (when we revisit):**
  - **Path A: deeper org policy hunt.** Search all enforced org policies
    for the project (not just the two we found). Candidates: any policy
    starting with `iam.` or `iam.managed.` that's status "Enforced".
  - **Path B: Workload Identity Federation.** Vercel supports OIDC token
    issuance. Configure WIF on the Google side to trust Vercel — no
    long-lived service account key needed. Multi-step setup but
    eliminates the key-creation battle entirely.
  - **Path C: skip Firebase Admin SDK in the cron.** Store push
    subscriptions in Vercel KV instead of Firestore (refactor `push.js`
    to POST to `/api/push/subscribe`, write to KV). Cron reads from KV,
    no Firebase Admin auth needed. Cleaner architecturally; ~30 min of
    code changes. Recommended path when we revisit.

For now the client code is dormant but harmless — opt-in flow stays
hidden because VAPID env var isn't set. When server delivery is sorted,
flip the env var + the feature wakes up.

### iOS share sheet doesn't auto-dismiss after share (verified iOS limitation)
After a user shares a pick to Instagram Story / WhatsApp / etc. and returns
to Safari, the iOS native share sheet stays visible. They have to swipe it
down manually to see the app again.

We attempted two fixes (commits `47e119c`, `633ce4c`): pre-baking the share
file to preserve the user-gesture context, then switching to a fire-and-
forget pattern so iOS doesn't think the gesture is still in flight. Both
landed and helped — the share sheet renders properly now — but the
auto-dismiss is still not consistent on iOS 18 + Safari.

The Web Share API spec gives the page no way to programmatically dismiss
the share sheet — it's iOS-owned UI. The fire-and-forget pattern is the
documented best practice; iOS 18 just appears to keep the sheet around
longer than older versions for "follow-up actions" (share to another
target, save image, copy, etc.).

Possible future angles:
  - A non-Web-Share fallback flow (download + manual paste-into-app) for
    iOS specifically. Worse UX, but full control over dismissal.
  - Wait for an iOS / WebKit fix. Several open bugs in WebKit Bugzilla
    track this.

Parked as: known iOS limitation, low-impact (user can swipe away).

### Onboarding `<feTurbulence>` → static texture
The onboarding background uses an SVG `<feTurbulence>` filter that repaints
constantly. On low-end Android this can drag scroll perf. A static PNG
noise texture would be cheaper. The share-card grain win (commit 43972fa)
was the higher-leverage half of the same audit item; this one parked as
LOW-impact.

---

## Done in recent passes

### UX-wins pass · 2026-05-18

- ✅ **Sign-out confirmation** — two-stage inline confirm: tap "Sign out" →
     becomes "Yes, sign out" + "Cancel". Auto-reverts after 4 s if forgotten.
     Prevents mis-tap → re-auth + hydration race.
- ✅ **Couples ballot "Back" between P1 and P2** — small "← Back to {P1}"
     link on the P2 step. Resets `p1Vote` so the first partner can re-vote.
- ✅ **Coin-flip preview hint** — small pill at the top of the ballot card
     on P1/P2 steps showing "Two misses unlocks the coin flip" (or "One more
     miss..." after the first failure). Surfaces the escape hatch upfront
     instead of letting it appear by surprise.
- ✅ **Inline veto on result card** — new "I've seen this — don't pick it
     again" link below the action row. Adds the title to `recentPicks`
     (engine filter list) without touching the taste profile, then triggers
     a fresh pick. Pre-watch veto that doesn't require waiting for the
     rating popup.
- ✅ **Cap surfacing** — history at 30/30 and saved at 20/20 now show an
     amber "at the limit" hint above the list. The ☆ star button on the
     result card disables when saved is full + the pick isn't already saved.
- ✅ **Pinned "Your top genres"** — for users with a built taste profile
     (≥2 score on at least one genre), the top 3 voted genres appear above
     the "More genres" toggle. Per-player in couples mode ("{P1}'s top
     genres"). Brand-new users see nothing extra.
- ✅ **Settings panel expanded** — new Preferences section with couples
     player-name editing (was inline-only in couples mode; now also
     editable from solo mode via Settings). Commits on blur/Enter.

### Low-priority polish pass · 2026-05-18

- ✅ **Onboarding flash on returning users** — `showOnboarding` no longer
     derives from localStorage at mount. The decision is deferred to the
     auth listener, which considers cloud `onboarded:true` OR either local
     flag (`onboarding_complete` / legacy `sd_onboarded`). Returning users
     on a new device sign in → hydrate → main app renders with onboarding
     off in one batched render. Dev override `?onboarding=1` still fires
     immediately at mount.
- ✅ **Skip-to-content link** — visually-hidden `<a href="#main-content">`
     becomes a focusable high-contrast pill at the top of the viewport.
     The mode-tabs row gets `id="main-content"` + `tabIndex={-1}` so the
     jump target is keyboard-focusable. WCAG 2.4.1.
- ✅ **Lazy-load PostHog** — `services/analytics.js` rewritten to
     dynamic-import `posthog-js` on first event. Main bundle dropped from
     278 KB → 217 KB (~60 KB / ~30 KB gzipped), split into a separate
     `posthog.[hash].chunk.js` that only loads when the user actually does
     something worth tracking.
- ✅ **Pre-baked grain texture (share card)** — `shareCard.js:addGrain`
     no longer runs a 2M-iteration JS pixel loop per share. The 256×256
     grain tile is built once per page load and tiled across the 1080×1920
     canvas via `drawImage`. Massive perf win on share generation, esp.
     mobile.
- ✅ **Cinema close clears `replayResult`** — the global Escape handler
     now resets `replayResult` along with `cinemaMode=false` (was leaving
     a stale entry in state when the user pressed Escape).
- ✅ **`clearHistory` consistency** — wrapped the `localStorage.removeItem`
     call in try/catch like the rest of the codebase for storage discipline.

### Medium-priority audit pass · 2026-05-18

- ✅ **Cross-device magic link without `window.prompt()`** — `auth.js`
     `completeMagicLinkSignIn` now returns a discriminated status
     (`success` / `needs-email` / `not-magic-link` / `error`). AuthGate
     renders a new `confirm-email` view in the cross-device case,
     replacing the prompt that was silently failing in iOS in-app
     browsers (Gmail, Outlook viewers).
- ✅ **Performance memoization** — `getActiveGenres` / `getOverlapGenres` /
     `getCompatibilityScore` / `getStatusMessage` / `getStreakInfo`
     converted to `useMemo` against their real dependencies. New
     `genreById` and `serviceByName` Maps memoised once; replaces all
     six `.find()` inside `.map()` callsites that were O(n²) per render.
- ✅ **Firestore SDK modernization** — `firebase.js` migrated from the
     deprecated `enableIndexedDbPersistence` to
     `initializeFirestore({ localCache: persistentLocalCache({ tabManager:
     persistentMultipleTabManager() }) })`. Multi-tab no longer throws
     `failed-precondition` on the second tab.

### High-priority audit pass · 2026-05-18

- ✅ **Focus traps in all modals** — built `useFocusTrap` hook, wired
     to History, Share, Privacy, Terms, Cinema, Ballot, Rating popup,
     Onboarding, AuthGate legal modal, Settings.
- ✅ **Consent revoke + account deletion UI** — new `Settings` component
     with a "Stop cloud sync" toggle and a "Delete account" flow gated by a
     typed DELETE confirmation. Wired Firebase auth `deleteUser` and a
     `deleteUserData` Firestore call. Privacy Policy + ToS updated to point
     to the in-app controls instead of email-only. PostHog tracks
     `consent_revoked` and `account_deleted` (anonymous, no PII).
- ✅ **Two-tab Firestore race** — `pushUserData` now runs in a transaction
     that merges array fields by `id` with local-wins-on-conflict semantics
     (watchHistory, savedForLater) plus a set-union with cap for recentPicks.
     Destructive paths (clearHistory, savedForLater clear, toggleSaveForLater
     un-star, profile import) use the new `pushUserDataAuthoritative` to
     overwrite cloud instead, so concurrent tabs can't resurrect deletions.

### Initial audit pass · 2026-05-18 (commit 50855bf)

- ✅ Sign-out clears per-account localStorage
- ✅ `pickContent` generation token (stale-result race)
- ✅ `loadGenres` retry stale-closure fix
- ✅ Magic-link email TTL + legacy migration
- ✅ AuthGate legal links → in-app modals + shared `LegalContent` component
- ✅ Auth listener 10s timeout
- ✅ `hydrateFromCloud` array/object type guards
- ✅ Body scroll lock generalised to all modals
- ✅ Onboarding timer/RAF cleanup on unmount
- ✅ Onboarding swipe rejects mostly-vertical drags
- ✅ `migrateLocalToCloud` won't push empty defaults
- ✅ `tryAnotherCount` resets on mode change
- ✅ `viewport-fit=cover`
- ✅ Apple sign-in dead code removed
- ✅ Touch targets bumped to ≥40 px (chips, togs, cert-chip, mood) and
     44×44 for close buttons; `touch-action: manipulation` added
