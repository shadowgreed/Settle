# Settle — Engineering Roadmap

Living list of deferred work captured from audits, code reviews, and PD/PM
sessions. Items move from this file into commits as they're completed.

Last updated: 2026-05-18 (post-audit)

---

## Critical / High priority

### 1. Focus traps in all modals (a11y)
**Why:** Keyboard users can Tab out of any open modal (History, Share, Privacy,
Terms, Cinema, Ballot, Rating popup, Onboarding) and end up focused on the
background page that's still in the DOM. WCAG 2.1.2 violation.

**Approach:** Build a `useFocusTrap(ref, isOpen)` hook that:
- Captures the previously-focused element on open
- Cycles Tab/Shift-Tab within the first/last focusable descendants
- Restores focus on close
- Apply to every modal listed above.

Estimated ~80 LOC for the hook plus per-modal wiring. Reference:
WAI-ARIA Authoring Practices "Modal Dialog" pattern.

### 2. Consent revocation + account deletion UI
**Why:** GDPR posture. The Privacy Policy claims consent can be revoked, but
the only mechanism today is clearing browser data — and account deletion
requires emailing hello@trysettle.app. We need first-class controls.

**Approach:**
- Add a "Privacy & Data" section in a Settings panel (new modal triggered from
  the account bar).
- "Withdraw consent" toggle — flips `sd_consent` to false, stops sync, leaves
  the cloud doc orphaned (or optionally deletes it).
- "Delete my account" button — confirmation modal → calls a Firebase callable
  function that wipes the user's Firestore doc and revokes their auth identity.
- Track in PostHog (anonymous count of revoke/delete events).

### 3. Two-tab Firestore race
**Why:** `pushUserData` uses `setDoc(..., { merge: true })` which merges per
top-level field, not array-aware. Two tabs open → adding picks in tab A then
tab B causes B's write to overwrite A's `watchHistory` array.

**Approach:**
- Switch `watchHistory`, `savedForLater`, `recentPicks` to use
  `arrayUnion()` for adds, `arrayRemove()` for explicit removes.
- For full overwrites (e.g. "Clear history"), use a sentinel field marker.
- Test: open in two tabs, generate picks in each, verify both lands.

---

## Medium priority

### 4. Replace `window.prompt()` for cross-device magic link
**Why:** `auth.js:completeMagicLinkSignIn` falls back to `window.prompt()`
when the user opens the magic link on a device that didn't send it. Prompt is
blocked in iOS in-app browsers (Gmail viewer, Outlook viewer) — returns
`null`, sign-in silently fails, AuthGate just resets.

**Approach:** Render an in-app form (similar to the existing `view === 'email'`
state in AuthGate) when we detect the URL is a magic link but no pending
email is stored. Submit → completes sign-in.

### 5. Performance memoization pass
**Why:** Helpers like `getActiveGenres`, `getOverlapGenres`, `getStatusMessage`,
`getStreakInfo` are recomputed on every render and called multiple times per
render in JSX. Genre lookups use `.find()` inside `.map()` — O(n²).

**Approach:**
- `useMemo` for the helpers above against their real dependencies.
- Build a `genreById: Map` once via `useMemo` against `genres`, replace all
  `genres.find(g => g.id === id)` callsites.
- Same for `SERVICES.find(...)` inside `.map()` calls.

### 6. Firestore SDK modernization
**Why:** `enableIndexedDbPersistence` is deprecated; multi-tab will throw
`failed-precondition` for the second tab.

**Approach:** Migrate to `initializeFirestore({ localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) })`.

---

## Low priority / polish

### 7. Onboarding flash on returning users
On a new device + signed out, the onboarding component flashes for ~500 ms
before cloud hydration resolves and dismisses it. Fix: gate render of
onboarding on `user !== undefined && !cloudHydrationPending`.

### 8. Skip-to-content link
Long account bar + mode tabs precede the actual pick form. Add a visually
hidden "Skip to main content" link for keyboard users (becomes visible on
focus).

### 9. Lazy-load PostHog
PostHog eats ~30 KB gzipped on the initial bundle. Dynamic import on first
event would defer it.

### 10. Pre-baked grain texture
`shareCard.js:addGrain` runs a 2M-iteration JS pixel loop on every share. Pre-
bake a 256×256 grain tile and tile it. Onboarding `<feTurbulence>` SVG filter
similarly repaints constantly — replace with a static PNG noise texture on
low-end Android.

### 11. Cinema close cleans `replayResult`
`replayResult` persists in state when the cinema overlay is dismissed via
Escape (App.js:259 only sets `cinemaMode=false`). Stale state, not a
correctness bug — clear it for tidiness.

### 12. `clearHistory` consistency
`clearHistory` (App.js) writes directly to `localStorage.removeItem`,
bypassing the `safeSet`/consent discipline used elsewhere. Normalize.

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

## Done in recent audit (commit 50855bf · 2026-05-18)

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
