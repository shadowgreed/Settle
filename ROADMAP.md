# Settle — Engineering Roadmap

Living list of deferred work captured from audits, code reviews, and PD/PM
sessions. Items move from this file into commits as they're completed.

Last updated: 2026-05-18 (post-audit + HIGH + MEDIUM + LOW + UX-wins passes)

All audit items are now closed. This file is currently empty of pending
work — add new items here as they come up.

---

## Deferred / parked

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
