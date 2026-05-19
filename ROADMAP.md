# Settle — Engineering Roadmap

Living list of deferred work captured from audits, code reviews, and PD/PM
sessions. Items move from this file into commits as they're completed.

Last updated: 2026-05-18 (post-audit + high + medium + low passes)

---

## Low priority / polish

### Deferred: Onboarding `<feTurbulence>` static texture
The onboarding background still uses an SVG `<feTurbulence>` filter that
repaints constantly. On low-end Android this can drag scroll perf. A
static PNG noise texture would be cheaper. Not done in this pass because
the share-card grain win was the higher-leverage half of the same item.

---

## UX wins (from audit)

### 13. Sign-out confirmation dialog
Currently a single tap on "Sign out" forces re-auth and a hydration race.
Add a confirmation step ("Are you sure? You'll need to sign in again.").

### 14. Couples ballot "undo" between P1 and P2
If P1 mis-taps their vote, the only escape is Cancel → restart the whole
ballot. Add a "← Back to {P1 name}" affordance once the P2 view shows.

### 15. Coin-flip preview from start
The 🎲 coin-flip unlocks after 2 consecutive ballot failures (App.js:2391),
but this is invisible to users until the second failure. Surface it upfront:
"🎲 unlocks after 2 misses".

### 16. Genres dropdown — discoverability
Niche genres (Documentary, Western) are hidden behind the "More genres" toggle.
First-time users only see 8 moods. Consider a "Popular" subset always visible,
or surface 2–3 recent picks.

### 17. Saved-for-later cap surfacing
Save-for-later silently caps at 20. Either bump to 50/100 or surface the cap
with an upsell.

### 18. Watch history cap surfacing
History caps at 30 silently — when the 31st pick lands, the oldest vanishes
with no warning. Either bump to 100 or surface "30/30 — oldest replaced".

### 19. Inline veto on the result card
A user has to thumbs-down via the rating popup *after* watching, but there's
no "veto" / "I've seen this" button pre-watch.

### 20. Settings panel
Single home for: edit player names, edit selected services, withdraw
consent, delete account, view privacy & terms. Currently scattered.

---

## Done in recent passes

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
