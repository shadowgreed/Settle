// ─────────────────────────────────────────────────────────────────────────────
// Lazy-loaded analytics. PostHog is ~30 KB gzipped — eagerly importing it
// bloats the initial bundle and blocks first paint for a feature that isn't
// needed until the user has done something worth tracking.
//
// We dynamic-import posthog-js on first event, await initialisation once,
// then re-use the singleton. All `track*` calls become async no-ops if the
// import fails (e.g. blocked by a content blocker) — silent by design.
// ─────────────────────────────────────────────────────────────────────────────

const IS_DEV = process.env.NODE_ENV === 'development';

let posthogPromise = null;

// Resolves to the initialised posthog client, or null if init was disabled
// or the import failed. Cached so subsequent calls don't re-init.
function loadPosthog() {
  if (posthogPromise) return posthogPromise;
  if (IS_DEV) {
    // Never load PostHog in dev — events would inflate prod metrics.
    posthogPromise = Promise.resolve(null);
    return posthogPromise;
  }
  posthogPromise = import(/* webpackChunkName: "posthog" */ 'posthog-js')
    .then(({ default: posthog }) => {
      posthog.init(process.env.REACT_APP_POSTHOG_KEY, {
        api_host:         'https://us.i.posthog.com',
        autocapture:      false,
        capture_pageview: false,
        persistence:      'localStorage',
        disable_flags:    true,
      });
      return posthog;
    })
    .catch((e) => {
      console.warn('[Analytics] PostHog failed to load:', e.message);
      return null;
    });
  return posthogPromise;
}

async function track(eventName, properties = {}) {
  if (IS_DEV) {
    console.log(`[Analytics] ${eventName}`, properties);
    return;
  }
  const posthog = await loadPosthog();
  if (posthog) posthog.capture(eventName, properties);
}

// ── Public event API ──────────────────────────────────────────────────────────

/**
 * Fired once on app mount.
 * Captures mode (solo/couples/theater) and whether it's a returning user.
 */
export function trackAppLoaded({ mode, isReturningUser }) {
  track('app_loaded', { mode, returning_user: isReturningUser });
}

/**
 * Fired every time the engine surfaces a result.
 * Captures the pick's service, type, rating, mode, and whether it was a hidden gem.
 */
export function trackPickGenerated({ service, type, rating, mode, isHiddenGem }) {
  track('pick_generated', {
    service,
    type,          // 'Movie' | 'Series'
    rating,
    mode,          // 'solo' | 'couple' | 'theater'
    hidden_gem: isHiddenGem,
  });
}

/**
 * Privacy-control events. No PII — just an aggregate count of users
 * exercising their data rights so we can monitor the rate.
 */
export function trackConsentRevoked()  { track('consent_revoked'); }
export function trackAccountDeleted()  { track('account_deleted'); }

/**
 * Push-notification opt-in funnel events. No PII.
 *   prompt_shown  → opt-in banner appeared (after 3rd successful pick)
 *   accepted      → user tapped accept + browser granted permission
 *   denied        → user dismissed banner OR browser denied permission
 *   unsubscribed  → user later turned off notifications via Settings
 */
export function trackPushPromptShown()   { track('push_prompt_shown'); }
export function trackPushAccepted()      { track('push_accepted'); }
export function trackPushDenied(reason)  { track('push_denied', { reason }); }
export function trackPushUnsubscribed()  { track('push_unsubscribed'); }

/**
 * Retention signal — user tapped "Watch trailer" on a pick. Captures
 * the title's service + type + mode so we can correlate trailer plays
 * with downstream "We're watching this" conversions.
 */
export function trackTrailerPlayed({ service, type, mode, fromSurface }) {
  track('trailer_played', {
    service,
    type,
    mode,
    from_surface: fromSurface, // 'result_card' | 'cinema_mode'
  });
}

/**
 * Conversion event — user tapped "Open on [Service]" to leave Settle for
 * the streaming platform. The funnel's terminal step: pick_generated →
 * trailer_played (optional) → deep_link_opened. Without this we can't
 * answer "are users actually opening Netflix when we tell them to?"
 */
export function trackDeepLinkOpened({ service, titleId, mode, surface }) {
  track('deep_link_opened', {
    service,
    title_id: titleId,
    mode,
    surface, // 'result_card' | 'cinema_mode'
  });
}

/**
 * Feedback event — user rated a pick up or down (or skipped) via the
 * rating popup. `timeSincePick` is the gap between when the pick was
 * surfaced and when the user voted, in seconds. Useful for distinguishing
 * "watched then loved it" (long gap) from "rejected on sight" (short gap).
 */
export function trackVoteSubmitted({ titleId, vote, service, timeSincePick }) {
  track('vote_submitted', {
    title_id: titleId,
    vote,              // 'up' | 'down' | 'skip'
    service,
    time_since_pick: timeSincePick, // seconds, or null if unavailable
  });
}
