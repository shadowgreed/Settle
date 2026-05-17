import posthog from 'posthog-js';

const IS_DEV = process.env.NODE_ENV === 'development';

// Only initialise PostHog in production — dev events must never reach the
// production project and inflate metrics.
if (!IS_DEV) {
  posthog.init(process.env.REACT_APP_POSTHOG_KEY, {
    api_host:         'https://us.i.posthog.com',
    autocapture:      false,   // manual events only — keeps data clean
    capture_pageview: false,   // we fire app_loaded manually
    persistence:      'localStorage',
    disable_flags:    true,    // we don't use feature flags — stops /flags/ requests
  });
}

function track(eventName, properties = {}) {
  if (IS_DEV) {
    console.log(`[Analytics] ${eventName}`, properties);
    return; // never send dev events to PostHog
  }
  posthog.capture(eventName, properties);
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
