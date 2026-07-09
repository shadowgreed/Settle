import React, { useState, useEffect, useRef, useMemo } from 'react';
import { flushSync } from 'react-dom';
import tmdbService from './services/tmdb';
import watchmodeService from './services/watchmode';
import { generateShareCard } from './utils/shareCard';
import { pickLabel, pickVerb } from './utils/timeOfDay';
import {
  trackAppLoaded, trackPickGenerated, trackConsentRevoked, trackAccountDeleted,
  trackTrailerPlayed, trackDeepLinkOpened, trackVoteSubmitted,
  trackPushPromptShown, trackPushAccepted, trackPushDenied, trackPushUnsubscribed,
  trackLocationPermissionResult, trackZipEntered,
  trackMoodMigrationEasyWatchToFun,
  trackModeSelected, trackCoupleFlowSelected, trackPartnerRenamed,
  trackRatingStepSelected, trackMatchCountShown, trackCtaTapped, trackZeroMatchesShown,
  trackPartnerUnlinked,
  trackPickAccepted, trackPickRejected, trackPickMarkedSeen, trackResultSynopsisExpanded,
  trackHistoryItemRated, trackHistoryRateNudgeTapped, trackHistoryCleared,
  trackMoreLikeThisTapped,
} from './services/analytics';
import {
  getCurrentCoords, getStoredPermissionState, getStoredZip, setStoredZip,
  zipToCoords, recordPermissionDecision, shouldRepromptAfterDecline,
  clearCachedCoords,
} from './services/location';
import { isPushSupported, subscribeToPush, unsubscribeFromPush, isSubscribedOnThisDevice, syncPushProfile } from './services/push';
import AuthGate from './components/AuthGate';
import Onboarding from './components/Onboarding';
import LocationPermission from './components/LocationPermission';
import NewReleasesCard from './components/NewReleasesCard';
import PushOptIn from './components/PushOptIn';
import Settings from './components/Settings';
import ShowtimesSheet from './components/ShowtimesSheet';
import InTheaters from './components/InTheaters';
import BrandLogo from './components/BrandLogo';
import NudgeCard from './components/NudgeCard';
import settleWordmark from './assets/settle-wordmark.png';
import StreakHistory from './components/StreakHistory';
import TrailerOverlay from './components/TrailerOverlay';
import { PrivacyBody, TermsBody } from './components/LegalContent';
import { onAuthChange, signOut, deleteCurrentUser } from './services/auth';
import { migrateLocalToCloud, pushUserData, pushUserDataAuthoritative, buildPayload, deleteUserData } from './services/cloudSync';
import { authHeader } from './services/authHeader';
import {
  savePartnerLink, clearPartnerLink,
  generateInviteCode, verifyInviteCode, checkPendingLink, subscribePartnerDoc,
  createLiveBallot, subscribeToIncomingBallot, subscribeBallot, castVote, dismissBallot,
  createCoupleSession, subscribeIncomingSession, subscribeCoupleSession,
  setSessionReady, updateSessionGenres, broadcastSessionResult, closeCoupleSession,
} from './services/couple';
import CoupleLink from './components/CoupleLink';
import LiveBallot from './components/LiveBallot';
import CoupleSessionSelect from './components/CoupleSessionSelect';
import CoupleSessionIntro from './components/CoupleSessionIntro';
import WatchLoop from './components/WatchLoop';
import useFocusTrap from './hooks/useFocusTrap';
import './App.css';

// All localStorage keys that hold per-account user data. Cleared on sign-out
// so the next account on the same device doesn't inherit the previous user's
// taste profile, history, prefs, etc.
const USER_DATA_KEYS = [
  'streaming-prefs',
  'streaming-seen',
  'streaming-history',
  'streaming-taste-profile',
  'streaming-player-names',
  'settle-saved',
  'sd_onboarded',
  'onboarding_complete',
  'sd_consent',
  'settle_pending_email',
];

// TMDB keyword 210024 = "anime". The canonical wide-net tag that covers
// both original Japanese animation AND manga-adapted titles (live-action
// and animated). Used by the Anime mood + Anime genre chip — both route
// through the same keyword discovery query.

// Stand-up comedy keyword union:
//   9716   = stand-up comedy        (primary tag)
//   276162 = stand-up comedian      (performer tag)
//   356038 = stand-up specials      (special-format tag)
// Stand-up is a virtual GENRE only — no mood references it. Selecting
// the Stand-up chip fires a compound query (Comedy genre + these keywords).
// All Comedy-containing queries (Fun mood, Comedy chip alone, etc.) add
// these to `without_keywords` so stand-up never leaks into a non-stand-up
// pool.
const STANDUP_KEYWORDS = '9716|276162|356038';

// Concurrency limiter — runs up to `limit` async tasks in parallel,
// queuing the rest until a slot opens. Prevents cold-start pile-ups when
// many Vercel serverless functions would otherwise all fire at once.
// Returns results in the same shape as Promise.allSettled.
async function runConcurrent(fns, limit = 5) {
  const results = new Array(fns.length);
  let next = 0;
  async function worker() {
    while (next < fns.length) {
      const idx = next++;
      try {
        results[idx] = { status: 'fulfilled', value: await fns[idx]() };
      } catch (e) {
        results[idx] = { status: 'rejected', reason: e };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, fns.length) }, worker));
  return results;
}

// Mood → primary-genre map, locked to the Mood Swap spec (May 2026).
// This table is canonical — do not edit individual mood IDs without a new
// spec. The mappings were chosen so each mood owns a distinct emotional
// fingerprint; overlap between moods (e.g. Drama in both Emotional and
// Thoughtful) is intentional and handled by the `every` activation check
// below: a mood is only "on" when ALL its IDs are present in the user's
// active genres, so Drama alone activates Emotional only — pairing it
// with Documentary then activates Thoughtful too.
//
//   Fun         → Comedy (35), Family (10751), Animation (16)
//   Romantic    → Romance (10749)
//   Scary       → Horror (27)
//   Thrilling   → Thriller (53), Action (28), Mystery (9648)
//   Emotional   → Drama (18)
//   Sci-Fi      → Sci-Fi (878)              ← replaced Easy Watch, May 2026
//   Thoughtful  → Documentary (99), History (36)
//   Anime       → virtual 'anime' keyword (Japanese animation + manga adaptations)
// NOTE: no mood shares a genre ID with another — prevents co-activation.
// NOTE: Stand-up is a GENRE-ONLY virtual ID (chip only, no mood). All
//       Comedy-containing mood queries exclude stand-up keywords so the
//       Stand-up chip is the only path that surfaces those specials.
const MOODS = [
  { emoji: '😂', label: 'Fun',        ids: [35, 10751, 16] },
  { emoji: '❤️', label: 'Romantic',   ids: [10749] },
  { emoji: '😱', label: 'Scary',      ids: [27] },
  { emoji: '💥', label: 'Thrilling',  ids: [53, 28, 9648] },
  { emoji: '😢', label: 'Emotional',  ids: [18] },
  { emoji: '🧠', label: 'Thoughtful', ids: [99, 36] },
  { emoji: '🛸', label: 'Sci-Fi',     ids: [878] },
  { emoji: '⛩️', label: 'Anime',      ids: ['anime'] },
  // Decade moods — added per PM roadmap 2.1. All three passed the catalog
  // audit (345 / 510 / 1050 combined pickable titles). Each decade ID is a
  // virtual genre that pickContent translates into a TMDB date-range query
  // parameter instead of a with_genres filter.
  { emoji: '📼', label: "'80s vibes", ids: ['decade-80s'] },
  { emoji: '📺', label: "'90s vibes", ids: ['decade-90s'] },
  { emoji: '💿', label: "'00s vibes", ids: ['decade-00s'] },
];
const ANIME_KEYWORD = '210024';

// Stepped rating filter (replaces the old 0-10 drag slider). Values are exact
// TMDB vote_average floors; labels are what the pill shows. minRating stays a
// plain number so every discoverContent call site is unaffected by this UI
// change — only the control that sets it changed.
const RATING_STEPS = [
  { label: 'Any',         value: 0 },
  { label: 'Good 6+',     value: 6 },
  { label: 'Great 7+',    value: 7 },
  { label: 'Top-tier 8+', value: 8 },
];

// Legacy slider values (e.g. a stored 6.4 or 7.9 from the old 0-10 drag
// control) snap DOWN to the nearest step so nobody's filter silently gets
// stricter after this migration.
function snapRatingStep(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  let snapped = RATING_STEPS[0].value;
  for (const step of RATING_STEPS) {
    if (step.value <= n) snapped = step.value;
  }
  return snapped;
}

// Short, non-reversible digest of the current filter combo — used only as an
// analytics dimension (match_count_shown / zero_matches_shown) so dashboards
// can group by "which filter combo" without genre IDs/services becoming
// separate tracked properties. Not cryptographic; collisions are harmless
// here (worst case, two different combos share a bucket in a chart).
function hashFilters(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

// One-time migration for the old 'Him'/'Her' defaults (Settings redesign,
// July 2026) — the empty-state fallback already changed to 'You'/'Partner',
// but a returning user's ALREADY-STORED value is a literal string, not a
// fallback, so it never picked up that change on its own. Only an EXACT
// match to the old default is rewritten; any custom name (even one that
// happens to be "Him") is preserved untouched, per spec.
function migrateLegacyPlayerNames(names) {
  if (!names || typeof names !== 'object') return names;
  const migrated = { ...names };
  if (migrated.p1 === 'Him') migrated.p1 = 'You';
  if (migrated.p2 === 'Her') migrated.p2 = 'Partner';
  return migrated;
}

// Maps decade-mood IDs to TMDB date-range query parameters. Multiple decade
// IDs combine by spanning the min `gte` and max `lte` (e.g. '80s + '90s
// becomes 1980-01-01 → 1999-12-31).
const DECADE_YEARS = {
  'decade-80s': { gte: '1980-01-01', lte: '1989-12-31' },
  'decade-90s': { gte: '1990-01-01', lte: '1999-12-31' },
  'decade-00s': { gte: '2000-01-01', lte: '2009-12-31' },
};

// Virtual genre IDs — IDs that aren't real TMDB genre IDs but instead drive
// special query behavior (keywords, date ranges, etc). The pickContent code
// uses this to decide whether an ID should appear in the with_genres param
// or be translated into a different filter.
const VIRTUAL_GENRES = new Set(['anime', 'standup', 'decade-80s', 'decade-90s', 'decade-00s']);

// Taste-profile weighting constants. Promoted from inline literals so the
// relationship between explicit votes and the soft trailer signal is
// documented in one place — TRAILER_BOOST is exactly 25% of an upvote.
const VOTE_UP_WEIGHT     = 2;     // explicit thumbs-up
const VOTE_DOWN_WEIGHT   = 1;     // explicit thumbs-down (subtracted)
const TRAILER_BOOST      = 0.5;   // soft signal from a trailer view (25% of upvote)

const SERVICES = [
  { name: 'Netflix',      color: '#E50914' },
  { name: 'Prime Video',  color: '#00A8E1' },
  { name: 'Disney+',      color: '#1B3CC0' },
  { name: 'Apple TV',     color: '#A2AAAD' },
  { name: 'Max',          color: '#6A1BD0' },
];

// Time-of-day helpers consolidated in src/utils/timeOfDay.js so the share
// card, cinema stamp, share text fallback, and mood greeting all read the
// same buckets.

const loadPrefs = () => {
  try { return JSON.parse(localStorage.getItem('streaming-prefs')) || {}; }
  catch { return {}; }
};

// Safe localStorage writer — swallows QuotaExceededError and any storage failures
// (iOS Safari private mode, full disk, disabled storage) so the app never crashes
// on a setItem call. Reads still use direct localStorage with try/catch at the call site.
const safeSet = (key, value) => {
  try { localStorage.setItem(key, value); }
  catch (e) { console.warn(`[Storage] Failed to write "${key}":`, e.message); }
};

function App() {
  const [mode, setMode] = useState(() => loadPrefs().mode || 'solo');
  const [selectedServices, setSelectedServices] = useState(() => loadPrefs().services || SERVICES.map(s => s.name));
  const [selectedGenres, setSelectedGenres] = useState(() => {
    const saved = loadPrefs().genres || {};
    // `session` is a transient slot for this device's pick in a live couple
    // session — never persisted, always reset when a session starts.
    // `live` is the local scratch slot for the pre-send Live-flow compose
    // screen (spec §4.2) — cleared once the ballot is sent.
    return { solo: [], p1: [], p2: [], theater: [], session: [], live: [], ...saved };
  });
  const [selectedFormats, setSelectedFormats] = useState(() => loadPrefs().formats || ['Movie', 'Series']);
  const [minRating, setMinRating] = useState(() => snapRatingStep(loadPrefs().minRating ?? 6.0));
  const [genres, setGenres] = useState([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [matchCount, setMatchCount] = useState(0);
  const [recentPicks, setRecentPicks] = useState(() => {
    try { return JSON.parse(localStorage.getItem('streaming-seen')) || []; }
    catch { return []; }
  });
  const [collection, setCollection] = useState(null);
  const [showCollection, setShowCollection] = useState(false);
  const [cinemaMode, setCinemaMode] = useState(false);
  const [cinemaSource, setCinemaSource] = useState('pick'); // 'pick' | 'history'
  const [replayResult, setReplayResult] = useState(null); // history replay only — never touches main result
  const [watchHistory, setWatchHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem('streaming-history')) || []; }
    catch { return []; }
  });
  const [navScrolled, setNavScrolled] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showStreakHistory, setShowStreakHistory] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [playerNames, setPlayerNames] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('streaming-player-names'));
      return migrateLegacyPlayerNames(stored) || { p1: 'You', p2: 'Partner' };
    }
    catch { return { p1: 'You', p2: 'Partner' }; }
  });
  const [editingPlayer, setEditingPlayer] = useState(null);
  const [activePlayer, setActivePlayer] = useState('p1');
  const [showAllGenres, setShowAllGenres] = useState(false);
  const [pickChips, setPickChips] = useState([]);
  // Synopsis clamp (spec §2.3) — descRef measures actual overflow after the
  // 3-line clamp so the "more" toggle only appears when text genuinely
  // overflows (not a character-count guess). Re-measured on every new result,
  // never re-measured on expand/collapse itself (see the effect below).
  const descRef = useRef(null);
  const [synopsisExpanded, setSynopsisExpanded] = useState(false);
  const [synopsisOverflows, setSynopsisOverflows] = useState(false);
  // Forces the metadata line (specifically its "ends by" time) to recompute
  // every 60s rather than freezing at fetch time — the value itself is never
  // read, its only job is to trigger the re-render (spec §2.4).
  const [, setMetaTick] = useState(0);
  const [tasteProfile, setTasteProfile] = useState(() => {
    try { return JSON.parse(localStorage.getItem('streaming-taste-profile')) || { solo: {}, p1: {}, p2: {} }; }
    catch { return { solo: {}, p1: {}, p2: {} }; }
  });
  const [ratingPopup, setRatingPopup] = useState(null);
  // watchLoopStep: 'confirm' (did you watch?) → 'rate' (how was it?) → null (closed)
  const [watchLoopStep, setWatchLoopStep] = useState(null);
  const [welcomeBack] = useState(() => Object.keys(loadPrefs()).length > 0);
  const [watchLink, setWatchLink] = useState(null);
  // Theater-specific enrichment — cert (G/PG/PG-13/R) + wide vs limited release.
  // Fetched lazily per pick, like collection data. null while loading or not theater.
  const [theaterReleaseInfo, setTheaterReleaseInfo] = useState(null);

  // YouTube trailer for the current pick (pre-fetched when the result lands)
  // and the overlay-visibility flag. `trailer` is { key, name } or null.
  const [trailer, setTrailer] = useState(null);
  const [showTrailer, setShowTrailer] = useState(false);
  // Theater Mode 2.0 — showtimes sheet (M2+M3).
  // `showShowtimes` opens the sheet for the current theater pick.
  // `locationPrompt` is the permission modal — null when hidden, or
  // 'first' / 'retry' when shown (controls copy + opt-out availability).
  // `userLocation` is { lat, lng, source: 'gps'|'zip', accuracy? } — in
  // memory only, never persisted.
  const [showShowtimes, setShowShowtimes]   = useState(false);
  const [locationPrompt, setLocationPrompt] = useState(null);
  const [userLocation, setUserLocation]     = useState(null);
  // The now-playing movie tapped in the "In Theaters" browse grid. Drives the
  // ShowtimesSheet (which film to look up). Null when the sheet is closed.
  const [theaterMovie, setTheaterMovie]     = useState(null);

  // Live match-count estimate for the sticky CTA bar (spec §3.3). null until
  // the first successful fetch resolves — the summary line omits the
  // "· N matches" segment until then, and keeps the last known number
  // through subsequent loads/errors rather than flickering.
  const [liveMatchCount, setLiveMatchCount] = useState(null);

  // "New in your genres" home-screen card (PM roadmap 3.2). Count is the
  // headline number from TMDB; dismissed flag is per-day in localStorage.
  const [newReleasesCount, setNewReleasesCount] = useState(0);
  const [newReleasesDismissed, setNewReleasesDismissed] = useState(() => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      return localStorage.getItem('settle_newrel_dismissed') === today;
    } catch { return false; }
  });

  // Per-mode retention nudges — saved-pick (solo) and partner-saved (couples).
  // Same per-day dismissal contract as the new-releases card above.
  const wasDismissedToday = (key) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      return localStorage.getItem(key) === today;
    } catch { return false; }
  };
  const [savedNudgeDismissed,  setSavedNudgeDismissed]  =
    useState(() => wasDismissedToday('settle_savednudge_dismissed'));
  const [coupleNudgeDismissed, setCoupleNudgeDismissed] =
    useState(() => wasDismissedToday('settle_couplenudge_dismissed'));

  // Push opt-in state (PM roadmap 3.1).
  // pickCount persists across sessions; the opt-in banner appears once
  // pickCount >= 3 AND the user hasn't seen the prompt before AND push is
  // supported on this device.
  const [pickCount, setPickCount] = useState(() => {
    const n = parseInt(localStorage.getItem('settle_pick_count') || '0', 10);
    return Number.isFinite(n) ? n : 0;
  });
  const [pushPrompted, setPushPrompted] = useState(() =>
    localStorage.getItem('settle_push_prompted') === 'true'
  );
  const [pushBusy, setPushBusy] = useState(false);
  const [pushSubscribed, setPushSubscribed] = useState(false);

  // ── Couple retention (live two-device ballot + partner linking) ───────────
  // partnerUid / partnerName come from the linked user doc once the couple link
  // is established. partnerSaved is the partner's savedForLater — shown in the
  // Saved tab.
  //
  // Live ballot state: when a two-device secret vote is active, liveBallotId is
  // the Firestore doc id, liveBallot is its live snapshot, and liveRole is which
  // side THIS device is voting as ('initiator' = started it, 'partner' = joined).
  const [partnerUid, setPartnerUid]       = useState(null);
  const [partnerName, setPartnerName]     = useState(null);
  const [partnerSaved, setPartnerSaved]   = useState([]);
  const [liveBallotId, setLiveBallotId]   = useState(null);
  const [liveBallot, setLiveBallot]       = useState(null);
  const [liveRole, setLiveRole]           = useState(null);

  // Live couple session (collaborative two-device mood → pick). coupleSessionId
  // is the Firestore doc id; coupleSession is its live snapshot; sessionRole is
  // which side THIS device is ('initiator' = started it, 'partner' = joined).
  const [coupleSessionId, setCoupleSessionId] = useState(null);
  const [coupleSession, setCoupleSession]     = useState(null);
  const [sessionRole, setSessionRole]         = useState(null);
  const [sessionError, setSessionError]       = useState(null); // visible start-failure message
  const [showSessionIntro, setShowSessionIntro] = useState(false); // "needs 2 phones" explainer
  // Couples fork (spec §4.1): null shows the two-card fork, 'live' the async
  // ballot flow, 'quick' the same-device tabs. Deliberately NOT persisted to
  // localStorage — returning to Couples within the session restores the last
  // flow (plain useState survives tab switches), a fresh session shows the fork.
  const [coupleFlow, setCoupleFlow] = useState(null);
  const [awaitingLink, setAwaitingLink]         = useState(false); // P1 is showing a code, waiting for P2
  const sessionPickedForRef = useRef(null); // guards the one-shot auto-pick
  const coupleSessionIdRef  = useRef(null);
  const sessionGenreSyncRef = useRef(null); // debounce timer for live genre sync
  // Runtime metadata for the result card (P2.2):
  //   movie  → { runtimeMin: 102 }
  //   series → { episodes: 8, avgEpisodeMin: 45 }
  //   null   → fetch failed or not yet loaded; card renders without runtime row
  const [runtimeInfo, setRuntimeInfo] = useState(null);
  // Session-scoped set of title IDs that have already received a trailer
  // taste-signal credit. Prevents the user from compounding +0.5 by
  // re-opening the trailer in the same session. Resets on app reload.
  const trailerCreditedRef = useRef(new Set());
  const [hasSearched, setHasSearched] = useState(false);
  const [noMoodSelected, setNoMoodSelected] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [fetchErrorType, setFetchErrorType] = useState(null); // 'timeout' | 'network'
  const [genreError, setGenreError] = useState(false);
  const [maxCertification, setMaxCertification] = useState(() => loadPrefs().maxCertification || null);
  // Note: `maxRuntime` was removed in P2.2 (runtime relocated to result card
  // metadata). State / sync / hydrate paths cleared in the post-audit pass.
  const [shareCopied, setShareCopied] = useState(false);

  const [showShareModal, setShowShareModal] = useState(false);
  const [shareCardUrl, setShareCardUrl] = useState(null);
  const [shareCardLoading, setShareCardLoading] = useState(false);
  const [shareCardReady, setShareCardReady] = useState(false);
  const shareItemRef = useRef(null);
  const shareCanvasRef = useRef(null);
  // Pre-baked share-blob File ref. Generated proactively when the canvas is
  // ready so the Share button's click handler can call navigator.share()
  // with zero awaits between the user gesture and the API call — iOS Safari
  // requires this strictly, otherwise the share sheet opens but renders as
  // a blank dark rectangle with no app icons.
  const shareFileRef = useRef(null);
  const sharePreviewRef = useRef(null);
  const [consent, setConsent] = useState(() => localStorage.getItem('sd_consent') === 'true');
  const [showConsent, setShowConsent] = useState(() => localStorage.getItem('sd_consent') === null);
  // Onboarding is NOT shown at mount — we defer the decision until after
  // auth + cloud hydration resolve. Otherwise returning users on a new device
  // (no localStorage flag yet, but `onboarded: true` in their cloud doc) see
  // the entire 4-slide flow flash for ~500 ms before hydrate dismisses it.
  // The decision is made in the auth listener below.
  const [showOnboarding, setShowOnboarding] = useState(() => {
    // Dev override fires immediately so /?onboarding=1 still works pre-auth.
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('onboarding') === '1') return true;
    return false;
  });
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [showBallot, setShowBallot] = useState(false);
  const [ballotStep, setBallotStep] = useState('p1');
  const [p1Vote, setP1Vote] = useState(null);
  const [p2Vote, setP2Vote] = useState(null);

  // Save for later — bookmarked picks (up to 20), persisted in localStorage
  const [savedForLater, setSavedForLater] = useState(() => {
    try { return JSON.parse(localStorage.getItem('settle-saved')) || []; }
    catch { return []; }
  });

  // Consecutive "Try another" counter — triggers mood nudge at 3
  const [tryAnotherCount, setTryAnotherCount] = useState(0);

  // Couples ballot failure tracking — coin flip unlocks after 2 straight rejections
  const [ballotFailCount, setBallotFailCount] = useState(0);
  const [revealReady, setRevealReady] = useState(false);

  // Theater mode filters
  // Family-friendly filter — the toggle UI was retired when the "In Theaters"
  // tab became a browse-first grid (decision engine no longer runs for theater).
  // Kept as a constant so the legacy now-playing fetch path still compiles and
  // can be re-surfaced later as a grid filter when we customize this tab.
  const [familyFriendly] = useState(false);

  // History panel tab — 'watched' | 'saved'
  const [historyTab, setHistoryTab] = useState('watched');
  // Clear history/saved — relocated into the header's ⋮ overflow menu with a
  // real confirmation dialog (spec §4.4), replacing the old two-tap
  // arm/timeout pattern on a full-width bottom button.
  const [showHistoryMenu, setShowHistoryMenu] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const historyMenuRef = useRef(null);

  // Per-row "More like this" overflow menu (spec §4.6) — second use of the
  // header's ⋮ menu pattern. Only one row menu can be open at a time, so a
  // single key (not a ref map) is enough; keyed the same way as the row's
  // scroll-target id so it stays unique across repeat-watched titles.
  const [openRowMenu, setOpenRowMenu] = useState(null);
  const [isOnline, setIsOnline] = useState(
    typeof navigator === 'undefined' || navigator.onLine
  );
  const [showNoSimilarToast, setShowNoSimilarToast] = useState(false);

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // Close the ⋮ menu on an outside click (it has no backdrop of its own).
  useEffect(() => {
    if (!showHistoryMenu) return;
    const onDocClick = (e) => {
      if (historyMenuRef.current && !historyMenuRef.current.contains(e.target)) {
        setShowHistoryMenu(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [showHistoryMenu]);

  // Row menus are rendered in a list rather than behind one fixed ref, so a
  // class check stands in for the header menu's single-ref containment test.
  useEffect(() => {
    if (!openRowMenu) return;
    const onDocClick = (e) => {
      if (!e.target.closest('.history-row-menu-wrap')) setOpenRowMenu(null);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [openRowMenu]);

  // Reset menu/confirm state whenever the sheet closes or the tab switches —
  // a stale "Clear saved?" confirm shouldn't survive into the Watched tab.
  useEffect(() => {
    setShowHistoryMenu(false);
    setShowClearConfirm(false);
    setOpenRowMenu(null);
  }, [showHistory, historyTab]);

  // ── Auth & cloud sync ──────────────────────────────────────────────────────
  // undefined = auth still initialising, null = signed out, object = signed in
  const [user, setUser] = useState(undefined);
  const syncTimerRef = useRef(null);

  // Monotonic counter that lets pickContent() abandon results from a prior
  // call when the user spam-taps "Try another" — only the latest generation's
  // result is allowed to land in state.
  const pickGenerationRef = useRef(0);

  // Refs for each modal container — useFocusTrap captures and restores focus
  // so keyboard users can't Tab past the modal onto the page underneath.
  const historyPanelRef = useRef(null);
  const cinemaCardRef   = useRef(null);
  const ballotCardRef   = useRef(null);
  const privacyModalRef = useRef(null);
  const termsModalRef   = useRef(null);
  const shareModalRef   = useRef(null);

  useFocusTrap(historyPanelRef, showHistory);
  // ratingPopupRef focus trap removed — WatchLoop component manages its own
  useFocusTrap(cinemaCardRef,   cinemaMode);
  useFocusTrap(ballotCardRef,   showBallot);
  useFocusTrap(privacyModalRef, showPrivacy);
  useFocusTrap(termsModalRef,   showTerms);
  useFocusTrap(shareModalRef,   showShareModal);

  // Hydrate all local state from a Firestore cloud document.
  // Called once after a successful sign-in.
  // Uses explicit type checks so an intentionally empty array on another device
  // (e.g. "I removed all services") replicates rather than being skipped.
  const hydrateFromCloud = (data) => {
    if (!data) return;
    if (data.tasteProfile && typeof data.tasteProfile === 'object') setTasteProfile(data.tasteProfile);
    if (Array.isArray(data.recentPicks))   setRecentPicks(data.recentPicks);
    if (Array.isArray(data.savedForLater)) setSavedForLater(data.savedForLater);
    if (Array.isArray(data.watchHistory))  setWatchHistory(data.watchHistory);
    if (data.playerNames && typeof data.playerNames === 'object') setPlayerNames(migrateLegacyPlayerNames(data.playerNames));
    if (data.couplePartnerUid) setPartnerUid(data.couplePartnerUid);
    if (data.consent != null) {
      setConsent(data.consent);
      if (data.consent) setShowConsent(false);
    }
    if (data.onboarded)           setShowOnboarding(false);
    if (data.prefs) {
      const p = data.prefs;
      if (p.mode)                            setMode(p.mode);
      if (Array.isArray(p.services))         setSelectedServices(p.services);
      if (p.genres && typeof p.genres === 'object') setSelectedGenres(g => ({ ...g, ...p.genres }));
      if (Array.isArray(p.formats))          setSelectedFormats(p.formats);
      if (p.minRating != null)               setMinRating(snapRatingStep(p.minRating));
      if ('maxCertification' in p)           setMaxCertification(p.maxCertification);
      // p.maxRuntime intentionally ignored — filter removed in P2.2.
    }
  };

  // Auth state listener — runs once on mount.
  // When a user signs in, migrate / pull their cloud data and hydrate state.
  // Hard-caps the loading state at 10s so a stalled Firebase init doesn't
  // pin the spinner forever — the AuthGate shows and the user can retry.
  useEffect(() => {
    let didSetUser = false;
    const fallbackTimer = setTimeout(() => {
      if (!didSetUser) {
        console.warn('[Auth] Listener did not resolve within 10s — defaulting to signed-out.');
        didSetUser = true;
        setUser(null);
      }
    }, 10000);

    const unsub = onAuthChange(async (firebaseUser) => {
      if (!firebaseUser) {
        didSetUser = true;
        clearTimeout(fallbackTimer);
        setUser(null);
        return;
      }
      let cloudData = null;
      try {
        cloudData = await migrateLocalToCloud(firebaseUser.uid);
        if (cloudData) hydrateFromCloud(cloudData);
      } catch (e) {
        console.warn('[Auth] Cloud hydration failed:', e.message);
      }

      // Now we have the full picture (cloud + local). Decide whether to show
      // onboarding once — never overrides the ?onboarding=1 dev flag.
      const devOverride = new URLSearchParams(window.location.search).get('onboarding') === '1';
      if (!devOverride) {
        const cloudOnboarded = cloudData?.onboarded === true;
        const localOnboarded =
          localStorage.getItem('onboarding_complete') === 'true' ||
          localStorage.getItem('sd_onboarded') === 'true';
        setShowOnboarding(!cloudOnboarded && !localOnboarded);
      }

      didSetUser = true;
      clearTimeout(fallbackTimer);
      setUser(firebaseUser);
    });
    return () => {
      clearTimeout(fallbackTimer);
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sticky nav — add .scrolled class once the user moves past the fold so
  // the frosted-glass background fades in without covering content at rest.
  useEffect(() => {
    const onScroll = () => setNavScrolled(window.scrollY > 10);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Clears every per-account localStorage key and resets in-memory state to
  // defaults, then triggers Firebase sign-out. The auto-save effects are
  // short-circuited by setting consent=false synchronously before the writes.
  const handleSignOut = async () => {
    setConsent(false);          // stops auto-save effects from running
    setRecentPicks([]);
    setWatchHistory([]);
    setSavedForLater([]);
    setTasteProfile({ solo: {}, p1: {}, p2: {} });
    setPlayerNames({ p1: 'You', p2: 'Partner' });
    setResult(null);
    setPickChips([]);
    setHasSearched(false);
    setPartnerUid(null);
    setPartnerName(null);
    setPartnerSaved([]);
    setLiveBallotId(null);
    setLiveBallot(null);
    setLiveRole(null);
    setCoupleSessionId(null);
    setCoupleSession(null);
    setSessionRole(null);
    USER_DATA_KEYS.forEach(k => { try { localStorage.removeItem(k); } catch {} });
    try { await signOut(); } catch (e) { console.warn('[Auth] signOut failed:', e.message); }
  };

  // ── Privacy & Data controls (wired into <Settings />) ────────────────────
  // Withdraw consent: stop syncing to the cloud from this device. The existing
  // cloud doc is left in place (the user can still sign in elsewhere); we just
  // flip the local consent flag and persist the choice so the banner won't
  // come back. The Settings modal stays open with a "Cloud sync is off" hint.
  const handleWithdrawConsent = async () => {
    setConsent(false);
    safeSet('sd_consent', 'false');
    trackConsentRevoked();
  };

  // Re-enable cloud sync from Settings. Mirrors handleConsent(true) (the
  // onboarding-banner accept path) — synchronous, no confirmation, matching
  // spec §5.3 ("Toggling on applies immediately"). `consent` is already in
  // the debounced push effect's dependency array (see that effect below), so
  // flipping it to true is sufficient to trigger an automatic sync on its own
  // — no separate manual push call needed here.
  const handleEnableCloudSync = () => {
    setConsent(true);
    safeSet('sd_consent', 'true');
  };

  // Permanently delete the user's account: wipe Firestore doc → delete the
  // Firebase Auth user → clear local data → sign out. Order matters:
  //   • Firestore delete first so the doc doesn't linger if auth delete fails
  //   • Auth delete second — Firebase may throw 'auth/requires-recent-login'
  //     here; we let the Settings modal surface that error and ask the user
  //     to sign back in.
  //   • Local clear + signOut last so the AuthGate shows a clean slate.
  const handleDeleteAccount = async () => {
    if (!user) throw new Error('No signed-in user');
    await deleteUserData(user.uid);     // throws → caught by Settings
    await deleteCurrentUser();          // throws → caught by Settings
    trackAccountDeleted();
    USER_DATA_KEYS.forEach(k => { try { localStorage.removeItem(k); } catch {} });
    setShowSettings(false);
    // deleteCurrentUser() already invalidates the auth session, so the
    // onAuthChange listener will set user=null and route us back to AuthGate.
  };

  // Debounced cloud sync — pushes current state to Firestore 2 s after the last
  // change. Requires consent + a signed-in user.
  useEffect(() => {
    if (!user || !consent) return;
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      pushUserData(user.uid, buildPayload({
        tasteProfile, recentPicks, savedForLater, watchHistory, playerNames, consent,
        mode, selectedServices, selectedGenres, selectedFormats, minRating,
        maxCertification,
        displayName: user.displayName || user.email?.split('@')[0] || '',
      }));
    }, 2000);
    return () => { if (syncTimerRef.current) clearTimeout(syncTimerRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, consent, tasteProfile, recentPicks, savedForLater, watchHistory,
      playerNames, mode, selectedServices, selectedGenres, selectedFormats,
      minRating, maxCertification]);

  // Global Escape-to-close for any open overlay/modal (a11y: 2.1.2 No Keyboard Trap)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // Trailer takes priority over everything else — if you opened it from
      // cinema mode, Escape should bring you back to cinema, not exit it.
      if (showTrailer)        { setShowTrailer(false); return; }
      if (locationPrompt)     { setLocationPrompt(null); return; }
      if (showShowtimes)      { setShowShowtimes(false); return; }
      if (showStreakHistory)  { setShowStreakHistory(false); return; }
      if (showSessionIntro)   { setShowSessionIntro(false); return; }
      if (showSettings)       { setShowSettings(false); return; }
      if (showShareModal) { closeShareModal(); return; }
      if (showPrivacy)    { setShowPrivacy(false); return; }
      if (showTerms)      { setShowTerms(false); return; }
      if (showHistory)    { setShowHistory(false); return; }
      if (ratingPopup)    { handleWatchSkip(); return; }
      if (cinemaMode)     { setCinemaMode(false); setReplayResult(null); return; }
      if (showBallot)     { setShowBallot(false); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showShareModal, showPrivacy, showTerms, showHistory, ratingPopup, cinemaMode, showBallot, showSettings, showTrailer, showStreakHistory, showShowtimes, locationPrompt, showSessionIntro]);

  // Lock body scroll while any modal is open — prevents the underlying app from
  // scrolling on iOS when the user drags inside the overlay. Restores the prior
  // value on close so we don't fight other scripts that might set overflow.
  useEffect(() => {
    const anyOpen =
      showOnboarding || showHistory || showShareModal || showPrivacy ||
      showTerms || showBallot || cinemaMode || !!ratingPopup || showSettings ||
      showTrailer || showStreakHistory || showShowtimes || !!locationPrompt ||
      !!liveBallot || showSessionIntro;
    if (anyOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [showOnboarding, showHistory, showShareModal, showPrivacy, showTerms,
      showBallot, cinemaMode, ratingPopup, showSettings, showTrailer, showStreakHistory,
      showShowtimes, locationPrompt, liveBallot, showSessionIntro]);

  // Multi-signal share-modal cleanup.
  // sessionStorage flag 'settle_sharing' is written before navigator.share()
  // and cleared after. On return from Instagram/WhatsApp, whichever of the
  // three signals fires first (visibilitychange, pageshow, window focus) will
  // call dismissIfSharing() and close the modal. Using all three covers:
  //   visibilitychange — standard app-switch on most browsers
  //   pageshow persisted — iOS bfcache restore on Safari
  //   window focus — iOS Edge and cases where the above miss
  useEffect(() => {
    const dismissIfSharing = () => {
      if (sessionStorage.getItem('settle_sharing')) {
        sessionStorage.removeItem('settle_sharing');
        setShowShareModal(false);
        setShareCardUrl(null);
        setShareCardReady(false);
      }
    };

    const onVisibility = () => { if (document.visibilityState === 'visible') dismissIfSharing(); };
    const onPageShow   = (e) => { if (e.persisted) dismissIfSharing(); };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus',    dismissIfSharing);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus',    dismissIfSharing);
    };
  }, []);

  // Load genres and fire app_loaded event on mount
  useEffect(() => {
    loadGenres();
    trackAppLoaded({ mode, isReturningUser: welcomeBack });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Mood Swap migration (May 2026) — Easy Watch → Sci-Fi.
  // One-shot fingerprint detection: if the user's stored genre selection
  // contains the full pre-swap Easy Watch fingerprint (Family + Comedy +
  // anime keyword), they were an Easy Watch user. Fire the PostHog event
  // so PM can size the affected segment, then stamp a flag so we never
  // fire it again. No UI shown — the migration is invisible per spec.
  useEffect(() => {
    try {
      if (localStorage.getItem('settle_mood_migration_v1')) return;
      const EASY_WATCH_FINGERPRINT = [10751, 35, 'anime'];
      const slots = ['solo', 'p1', 'p2', 'theater'];
      const hadEasyWatch = slots.some(slot => {
        const ids = selectedGenres[slot] || [];
        return EASY_WATCH_FINGERPRINT.every(id => ids.includes(id));
      });
      if (hadEasyWatch) {
        trackMoodMigrationEasyWatchToFun();
      }
      safeSet('settle_mood_migration_v1', '1');
    } catch { /* no-op — migration is best-effort */ }
    // Run once after initial state hydrates. selectedGenres is read but
    // never written here so re-runs would only re-no-op.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Watch loop — surface the "did you watch it?" prompt on app open.
  //
  // Rules:
  //   1. Entry must be unrated (rated === null).
  //   2. Must be at least 30 min old — avoids interrupting the same session
  //      where the user just tapped "Watching this". On the NEXT open
  //      (tomorrow evening, typically) the age condition is easily met.
  //   3. Global snooze respected — if the user tapped "Not yet — ask tomorrow",
  //      we store a timestamp in localStorage and skip until after it expires.
  //
  // The snooze key applies to all pending ratings, not per-title. If someone
  // isn't in the mood to rate anything tonight, they're not in the mood — one
  // dismissal defers everything to tomorrow.
  useEffect(() => {
    const now = Date.now();
    const MIN_AGE_MS = 30 * 60 * 1000; // 30 minutes

    // Respect global snooze
    try {
      const snoozeUntil = localStorage.getItem('settle_watchloop_snooze');
      if (snoozeUntil && now < new Date(snoozeUntil).getTime()) return;
    } catch {}

    const candidate = watchHistory.find(entry => {
      if (entry.rated) return false; // already rated or permanently skipped
      const age = now - new Date(entry.watchedAt).getTime();
      return age >= MIN_AGE_MS;
    });
    if (!candidate) return;

    const t = setTimeout(() => {
      setRatingPopup(candidate);
      setWatchLoopStep('confirm');
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // Level 1 — auto-save preferences on any change (only if consent given)
  useEffect(() => {
    if (!consent) return;
    safeSet('streaming-prefs', JSON.stringify({
      mode,
      services: selectedServices,
      genres: selectedGenres,
      formats: selectedFormats,
      minRating,
      maxCertification,
    }));
  }, [mode, selectedServices, selectedGenres, selectedFormats, minRating, maxCertification, consent]);

  // Reset ballot state when a new result comes in
  useEffect(() => {
    setShowBallot(false);
    setBallotStep('p1');
    setP1Vote(null);
    setP2Vote(null);
  }, [result]);

  // Reset the consecutive "Try another" counter on mode change — otherwise a
  // switch from solo→couple would carry over a stale count and surface the
  // mood-nudge banner immediately after the mode change.
  useEffect(() => { setTryAnotherCount(0); }, [mode]);

  // Ballot reveal tension — 1 s suspense before showing outcome + haptic pulse
  useEffect(() => {
    if (ballotStep !== 'reveal') return;
    setRevealReady(false);
    const t = setTimeout(() => {
      setRevealReady(true);
      if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
    }, 1000);
    return () => clearTimeout(t);
  }, [ballotStep]);

  // Mount tainted canvas directly into DOM when no data URL is available
  useEffect(() => {
    const container = sharePreviewRef.current;
    const canvas = shareCanvasRef.current;
    if (showShareModal && shareCardReady && !shareCardUrl && canvas && container) {
      container.innerHTML = '';
      canvas.className = 'share-preview-img';
      container.appendChild(canvas);
    }
  }, [showShareModal, shareCardReady, shareCardUrl]);

  // Check for sequel collection + Watchmode deep link whenever a movie result appears.
  // `cancelled` flag prevents stale promise responses from overwriting newer results
  // when the user spam-clicks "Try another".
  useEffect(() => {
    setCollection(null);
    setShowCollection(false);
    setTheaterReleaseInfo(null);
    setTrailer(null);
    setShowTrailer(false);
    setRuntimeInfo(null);
    if (!result) return;
    let cancelled = false;

    if (result.type === 'Movie') {
      tmdbService.getMovieCollection(result.id)
        .then(c => { if (!cancelled) setCollection(c); })
        .catch(() => {});
    }
    // Fetch cert + wide/limited for theater picks — displayed on the result card
    if (result.service === 'In Theaters') {
      tmdbService.getMovieReleaseInfo(result.id)
        .then(info => { if (!cancelled) setTheaterReleaseInfo(info); })
        .catch(() => {});
    }
    // (Direct watch-link resolution lives in its own effect below so it covers
    //  every service AND history replays, not just fresh Disney+/Apple TV picks.)
    // Pre-fetch the YouTube trailer so the "Watch trailer" button can appear
    // as soon as the result card renders. If TMDB has no trailer for this
    // title, `trailer` stays null and the button is hidden silently.
    const tmdbType = result.type === 'Movie' ? 'movie' : 'tv';
    tmdbService.getTrailer(result.id, tmdbType)
      .then(t => { if (!cancelled) setTrailer(t); })
      .catch(() => {});
    // Pre-fetch runtime info for the metadata row (P2.2). Movies need a
    // runtime; series need episode count + average episode length.
    tmdbService.getRuntimeInfo(result.id, tmdbType)
      .then(info => { if (!cancelled) setRuntimeInfo(info); })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [result]);

  // ── Direct watch link (Watchmode web_url) ──────────────────────────────────
  // Resolves a DIRECT title deep link for whatever title is in (or headed to)
  // cinema mode — the fresh pick OR a history replay — for ALL streaming
  // services. Previously only Disney+/Apple TV picks got a direct link and
  // everything else fell straight to a platform SEARCH page; now search is only
  // the fallback when Watchmode has no direct URL. Mirrors the `cinemaItem`
  // logic in the render so `watchLink` always matches the title being shown.
  useEffect(() => {
    const item = cinemaSource === 'history' ? replayResult : result;
    setWatchLink(null);
    if (!item || item.service === 'In Theaters') return;
    let cancelled = false;
    watchmodeService.getServiceUrl(item.id, item.type, item.service, item.title)
      .then(url => { if (!cancelled) setWatchLink(url); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [result, replayResult, cinemaSource]);

  // Synopsis clamp overflow check (spec §2.3) — measured once per new result,
  // right after the clamped layout paints. Deliberately NOT re-run when
  // synopsisExpanded changes (expanding removes the clamp, which would make
  // scrollHeight === clientHeight and wrongly hide the "less" toggle).
  useEffect(() => {
    setSynopsisExpanded(false);
    const raf = requestAnimationFrame(() => {
      const el = descRef.current;
      if (el) setSynopsisOverflows(el.scrollHeight > el.clientHeight + 1);
    });
    return () => cancelAnimationFrame(raf);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  // Re-render every 60s while a result is showing so its "ends by" time
  // never freezes on a card left open (spec §2.4).
  useEffect(() => {
    if (!result) return;
    const interval = setInterval(() => setMetaTick(t => t + 1), 60000);
    return () => clearInterval(interval);
  }, [result]);

  // `isRetry` flag avoids reading state from a closure (which would be stale
  // because this function is called from a [] -deps effect on mount). Instead
  // we pass an explicit "already retried" signal so the second failure surfaces
  // the genre error rather than retrying forever.
  const loadGenres = async (isRetry = false) => {
    try {
      const movieGenres = await tmdbService.getGenres('movie');
      const tvGenres = await tmdbService.getGenres('tv');

      // Merge and deduplicate
      const EXCLUDED_GENRES = ['Action & Adventure', 'Sci-Fi & Fantasy', 'TV Movie', 'War & Politics', 'Soap'];
      const allGenres = [...movieGenres, ...tvGenres];
      const uniqueGenres = Array.from(
        new Map(allGenres.map(g => [g.name, g])).values()
      ).filter(g => !EXCLUDED_GENRES.includes(g.name))
       .map(g => g.name === 'Science Fiction' ? { ...g, name: 'Sci-Fi' } : g);

      const customGenres = [
        { id: 'anime', name: 'Anime ⛩️' },
        { id: 'standup', name: 'Stand-up 🎤' }
      ];

      const allWithCustom = [...uniqueGenres, ...customGenres]
        .sort((a, b) => a.name.localeCompare(b.name));

      setGenres(allWithCustom);
      setGenreError(false);
    } catch (error) {
      console.error('Error loading genres:', error);
      // Retry once after 2s — common cause is a transient network blip on cold load.
      // If the retry also fails, surface a genre error so the user can manually retry.
      if (!isRetry) {
        setTimeout(() => { loadGenres(true); }, 2000);
      } else {
        setGenreError(true);
      }
    }
  };

  const toggleService = (serviceName) => {
    setSelectedServices(prev =>
      prev.includes(serviceName)
        ? prev.filter(s => s !== serviceName)
        : [...prev, serviceName]
    );
  };

  const toggleFormat = (format) => {
    setSelectedFormats(prev =>
      prev.includes(format)
        ? prev.filter(f => f !== format)
        : [...prev, format]
    );
  };

  const handleGenreClick = (genreId, player = 'solo') => {
    setTryAnotherCount(0);
    setSelectedGenres(prev => {
      const current = prev[player] || [];
      const newSelection = current.includes(genreId)
        ? current.filter(g => g !== genreId)
        : [...current, genreId];
      return { ...prev, [player]: newSelection };
    });
  };

  const handleMoodClick = (moodIds, player = 'solo') => {
    setTryAnotherCount(0);
    setNoMoodSelected(false); // dismiss the "pick a mood" warning
    setSelectedGenres(prev => {
      const current = prev[player] || [];
      // Only treat as "deselect" if ALL of this mood's IDs are already selected.
      // Using `some` caused shared IDs (e.g. Drama=18 in both Romantic & Emotional)
      // to trigger a removal instead of an addition.
      const allSelected = moodIds.every(id => current.includes(id));
      const newSelection = allSelected
        ? current.filter(id => !moodIds.includes(id))
        : [...new Set([...current, ...moodIds])];
      return { ...prev, [player]: newSelection };
    });
  };

  const isMoodActive = (moodIds, player = 'solo') => {
    // A mood is "on" only when every one of its genre IDs is present.
    return moodIds.every(id => selectedGenres[player]?.includes(id));
  };

  // Match-reason CHIPS (replaces the old single-string .pick-reason banner).
  // One chip per satisfied filter instead of one collapsed sentence — mood/
  // era matches (MOODS already carries its own emoji for both, so no special
  // "era" branch is needed), a service-confirmation chip, and format/rating
  // chips only when the user tightened them from the defaults (both formats /
  // minRating 6 = untouched, so no chip).
  //
  // Couples mode attributes each mood chip to whichever person(s) actually
  // picked it, using couplePair.a/b + playerNames — both already computed in
  // this same component for the compat/shared-zone UI, so no new state.
  const buildMatchChips = (picked, activeGenreIds, isHiddenGems, currentMode) => {
    if (isHiddenGems) {
      return [{ key: 'hidden-gem', icon: '💎', label: 'Hidden gem', kind: 'solo' }];
    }
    if (currentMode === 'theater') {
      return [{ key: 'theater', icon: '🎟️', label: 'In US theaters', kind: 'solo' }];
    }

    const chips = [];

    if (currentMode === 'couple') {
      // Same `every`/`some` matching rule as the old solo logic (a mood only
      // qualifies if the user fully activated it AND the result actually
      // carries at least one of its genre ids).
      const p1Moods = MOODS.filter(m =>
        m.ids.every(id => couplePair.a.includes(id)) && m.ids.some(id => picked.genres.includes(id))
      );
      const p2Moods = MOODS.filter(m =>
        m.ids.every(id => couplePair.b.includes(id)) && m.ids.some(id => picked.genres.includes(id))
      );
      const p2Labels = new Set(p2Moods.map(m => m.label));
      const p1Labels = new Set(p1Moods.map(m => m.label));

      p1Moods.forEach(m => {
        if (p2Labels.has(m.label)) {
          chips.push({ key: `shared-${m.label}`, icon: m.emoji, label: m.label, kind: 'shared' });
        } else {
          chips.push({ key: `p1-${m.label}`, icon: m.emoji, label: `${playerNames.p1}: ${m.label}`, kind: 'p1' });
        }
      });
      p2Moods.forEach(m => {
        if (!p1Labels.has(m.label)) {
          chips.push({ key: `p2-${m.label}`, icon: m.emoji, label: `${playerNames.p2}: ${m.label}`, kind: 'p2' });
        }
      });
    } else {
      const activeMoods = MOODS.filter(mood =>
        mood.ids.every(id => activeGenreIds.includes(id)) &&
        mood.ids.some(id => picked.genres.includes(id))
      );
      activeMoods.forEach(m => chips.push({ key: m.label, icon: m.emoji, label: m.label, kind: 'solo' }));

      // Fall back to matched genre names if no mood match (mirrors the old
      // generatePickReason fallback). O(1) lookup via the memoised genreById.
      if (chips.length === 0) {
        picked.genres
          .filter(id => activeGenreIds.includes(id))
          .map(id => genreById.get(id)?.name)
          .filter(Boolean)
          .slice(0, 2)
          .forEach(name => chips.push({ key: name, icon: null, label: name, kind: 'solo' }));
      }
    }

    if (picked.service) {
      chips.push({ key: 'service', icon: null, label: `On your ${picked.service}`, kind: 'service' });
    }

    if (selectedFormats.length === 1) {
      chips.push({
        key: 'format', icon: null,
        label: selectedFormats[0] === 'Movie' ? 'Movies only' : 'Series only',
        kind: 'solo',
      });
    }
    if (minRating > 6) {
      const step = RATING_STEPS.find(s => s.value === minRating);
      if (step) chips.push({ key: 'rating', icon: null, label: step.label, kind: 'solo' });
    }

    if (chips.length === 0) {
      chips.push({ key: 'fallback', icon: null, label: `Top pick from your filters · ${picked.votes} ratings`, kind: 'solo' });
    }

    return chips;
  };

  // ── Memoised derived values ───────────────────────────────────────────────
  // Replaces the old `getActiveGenres()` / `getOverlapGenres()` /
  // `getCompatibilityScore()` helpers. These are read from JSX in multiple
  // places per render; memoizing avoids recomputing the same .filter/.includes
  // chains on every keystroke into the player-name input.
  const activeGenres = useMemo(() => {
    if (mode === 'solo') return selectedGenres.solo || [];
    if (mode === 'theater') return selectedGenres.theater || [];
    const p1 = selectedGenres.p1 || [];
    const p2 = selectedGenres.p2 || [];
    const overlap = p1.filter(g => p2.includes(g));
    return overlap.length > 0 ? overlap : [...new Set([...p1, ...p2])];
  }, [mode, selectedGenres]);

  // The two genre sets that drive couple compatibility. In a LIVE session each
  // partner picks on their own device, so we compare THIS device's live
  // selection (selectedGenres.session) against the partner's (from the session
  // doc, synced as they pick). Outside a session it's the single-device p1/p2
  // tabs. Same maths either way — the % match works identically.
  const couplePair = useMemo(() => {
    if (mode !== 'couple') return { a: [], b: [] };
    if (coupleSession && coupleSession.status !== 'closed') {
      const mine = selectedGenres.session || [];
      const theirs = (sessionRole === 'initiator'
        ? coupleSession.partnerGenres
        : coupleSession.initiatorGenres) || [];
      return { a: mine, b: theirs };
    }
    return { a: selectedGenres.p1 || [], b: selectedGenres.p2 || [] };
  }, [mode, selectedGenres, coupleSession, sessionRole]);

  const overlapGenres = useMemo(() => {
    if (mode !== 'couple') return [];
    return couplePair.a.filter(g => couplePair.b.includes(g));
  }, [mode, couplePair]);

  // Summary line for the sticky CTA bar — "{Format} · {Rating label} · {N}
  // vibes[ · {M} matches]". The matches segment is appended by the live
  // match-count feature (Phase 3); until then it's just format/rating/vibes.
  const ctaSummary = useMemo(() => {
    const formatLabel = selectedFormats.length === 2
      ? 'Movies & Series'
      : selectedFormats[0] === 'Series' ? 'Series' : 'Movies';
    const ratingLabel = (RATING_STEPS.find(s => s.value === minRating) || RATING_STEPS[0]).label;
    // Couples quick-pick reads "N shared vibes" (mood tiles BOTH players have
    // fully selected) instead of solo's plain "N vibes" (spec §3.3).
    let vibesSegment;
    if (mode === 'couple') {
      const sharedCount = MOODS.filter(m => isMoodActive(m.ids, 'p1') && isMoodActive(m.ids, 'p2')).length;
      vibesSegment = `${sharedCount} shared vibe${sharedCount === 1 ? '' : 's'}`;
    } else {
      const vibesCount = MOODS.filter(m => isMoodActive(m.ids, 'solo')).length;
      vibesSegment = `${vibesCount} vibe${vibesCount === 1 ? '' : 's'}`;
    }
    const matchesSegment = liveMatchCount !== null
      ? ` · ${liveMatchCount} match${liveMatchCount === 1 ? '' : 'es'}`
      : '';
    return `${formatLabel} · ${ratingLabel} · ${vibesSegment}${matchesSegment}`;
  // isMoodActive closes over selectedGenres, which is already a dep — including
  // the function itself would just redefine on every render with no benefit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFormats, minRating, mode, selectedGenres, liveMatchCount]);

  // O(1) lookups — replaces .find() inside .map() callsites that were O(n²).
  const genreById = useMemo(() => {
    const m = new Map();
    genres.forEach(g => m.set(g.id, g));
    return m;
  }, [genres]);

  const serviceByName = useMemo(() => {
    const m = new Map();
    SERVICES.forEach(s => m.set(s.name, s));
    return m;
  }, []);

  // Pinned "your top genres" per player slot — the top 3 IDs from the taste
  // profile (descending by score). Only includes genres the user has actively
  // up-voted (score ≥ 2) so we don't suggest a genre they merely watched
  // once. Returns empty arrays for slots with no signal yet, so brand-new
  // users see no extra clutter.
  const topGenresByPlayer = useMemo(() => {
    const out = { solo: [], p1: [], p2: [] };
    for (const slot of ['solo', 'p1', 'p2']) {
      const profile = tasteProfile[slot] || {};
      out[slot] = Object.entries(profile)
        .filter(([id, score]) => score >= 2 && genreById.has(Number(id)))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id]) => genreById.get(Number(id)))
        .filter(Boolean);
    }
    return out;
  }, [tasteProfile, genreById]);

  // ── "New in your genres" home-screen card (PM roadmap 3.2) ──────────────
  // Fetches a headline count of new releases (last 7 days) matching the
  // user's top voted genres + selected services. Only solo mode, only for
  // users with a built taste profile, only when not dismissed today.
  //
  // Stringified deps prevent re-fetching every time tasteProfile mutates —
  // topGenresByPlayer.solo returns a new array reference on each render even
  // when the underlying IDs are byte-identical, so without stringifying we'd
  // hit TMDB on every vote.
  const topSoloIdsKey  = (topGenresByPlayer.solo || []).map(g => g.id).join(',');
  const servicesKey    = selectedServices.join(',');
  useEffect(() => {
    if (mode !== 'solo')        { setNewReleasesCount(0); return; }
    if (newReleasesDismissed)   { setNewReleasesCount(0); return; }
    if (!topSoloIdsKey)         { setNewReleasesCount(0); return; }
    if (!servicesKey)           { setNewReleasesCount(0); return; }

    const topIds   = topSoloIdsKey.split(',').map(s => isNaN(s) ? s : Number(s));
    const services = servicesKey.split(',');

    let cancelled = false;
    tmdbService.getNewReleasesCount({ services, genreIds: topIds, days: 7 })
      .then(c => { if (!cancelled) setNewReleasesCount(c); })
      .catch(() => { if (!cancelled) setNewReleasesCount(0); });
    return () => { cancelled = true; };
  }, [mode, topSoloIdsKey, servicesKey, newReleasesDismissed]);

  // Live match-count estimate for the sticky CTA bar (spec §3.3). Debounced
  // 400ms so it doesn't fire on every mood toggle; the `cancelled` guard
  // (reset by the cleanup on each re-run) discards a response that arrives
  // after a newer request has already been fired, so an out-of-order network
  // reply can never clobber a fresher result. Fetch failures leave
  // liveMatchCount untouched (see getMatchCount's comment) — the summary line
  // just keeps showing the last known number instead of flashing to zero.
  //
  // Mirrors showPickForm's own condition (computed later, after the render's
  // auth-guard early returns, so it can't be referenced here directly) — the
  // bar and this fetch must only be active on the same screens. Genre source
  // is `activeGenres` — the SAME memo pickContent itself searches with (solo's
  // own picks, or couples' overlap-else-union) — so the estimate reflects
  // what a real search would actually query, not just one player's taps.
  const matchCountActive = !coupleSession && mode !== 'theater' && (mode !== 'couple' || coupleFlow === 'quick');
  const matchCountGenreKey = activeGenres.join(',');
  const matchCountFormatsKey = selectedFormats.join(',');
  const matchCountServicesKey = selectedServices.join(',');
  useEffect(() => {
    if (!matchCountActive) return;
    let cancelled = false;
    const filtersHash = hashFilters(
      `${matchCountServicesKey}|${matchCountFormatsKey}|${matchCountGenreKey}|${minRating}|${maxCertification}`
    );
    const timer = setTimeout(() => {
      const genreIds = matchCountGenreKey
        ? matchCountGenreKey.split(',').map(s => (isNaN(s) ? s : Number(s)))
        : [];
      tmdbService.getMatchCount({
        services: matchCountServicesKey ? matchCountServicesKey.split(',') : [],
        formats: matchCountFormatsKey ? matchCountFormatsKey.split(',') : [],
        genreIds,
        minRating,
        maxCertification,
      })
        .then(c => {
          if (cancelled) return;
          setLiveMatchCount(c);
          trackMatchCountShown({ count: c, filtersHash });
        })
        .catch(() => { /* keep the last known count — see getMatchCount comment */ });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [
    matchCountActive, matchCountGenreKey,
    matchCountFormatsKey, matchCountServicesKey, minRating, maxCertification,
  ]);

  // Post-search zero (an actual pickContent run came up empty) is the
  // authoritative signal when available; otherwise fall back to the live
  // pre-search estimate. Either way this never reads "0 matches" off a fetch
  // failure — liveMatchCount only updates on success (see getMatchCount).
  const zeroMatches = (hasSearched && matchCount === 0) || (!hasSearched && liveMatchCount === 0);

  // Fire the zero-matches analytics event once per false→true transition,
  // not on every render while it stays true.
  const wasZeroMatchesRef = useRef(false);
  useEffect(() => {
    if (zeroMatches && !wasZeroMatchesRef.current) {
      const filtersHash = hashFilters(
        `${matchCountServicesKey}|${matchCountFormatsKey}|${matchCountGenreKey}|${minRating}|${maxCertification}`
      );
      trackZeroMatchesShown({ filtersHash });
    }
    wasZeroMatchesRef.current = zeroMatches;
  }, [zeroMatches, matchCountServicesKey, matchCountFormatsKey, matchCountGenreKey, minRating, maxCertification]);

  // Handler — tap the "New in your genres" card. Seeds solo mode with the
  // top genres (for visible mood-grid state) AND passes the IDs directly to
  // pickContent so the immediate pick fires against the right set without
  // waiting for React to commit the setSelectedGenres call.
  const handleNewReleasesTap = () => {
    const topIds = (topGenresByPlayer.solo || []).map(g => g.id).filter(Boolean);
    if (topIds.length === 0) return;
    setSelectedGenres(prev => ({ ...prev, solo: topIds }));
    setTryAnotherCount(0);
    pickContent(false, false, topIds);
  };

  // ── Theater Mode 2.0 — location + showtimes handlers ───────────────────
  // Gates the Showtimes sheet behind a location decision. If the user
  // previously granted, we silently get coords and open the sheet. If
  // they declined, fall back to the stored ZIP if any. Otherwise the
  // permission modal surfaces with the right copy ('first' / 'retry').
  // Browse-grid tap: remember which film, then open showtimes. If the user
  // already set an area (ZIP or GPS) via the In Theaters area control, skip
  // the gate and go straight to local times; otherwise run the location gate.
  const handleTheaterMoviePick = (movie) => {
    setTheaterMovie(movie);
    if (userLocation) {
      setShowShowtimes(true);
    } else {
      openShowtimesFlow();
    }
  };

  const openShowtimesFlow = async () => {
    const permission = getStoredPermissionState();
    const zip        = getStoredZip();

    // Path A — previously granted permission
    if (permission === 'granted') {
      const coords = await getCurrentCoords();
      if (coords) {
        setUserLocation({ ...coords, source: 'gps' });
        setShowShowtimes(true);
        return;
      }
      // Granted but device returned nothing (e.g. user revoked OS-level)
      // — fall through to prompt.
    }

    // Path B — previously declined; use ZIP if we have it, otherwise re-prompt
    if (permission === 'denied') {
      if (zip) {
        const coords = await zipToCoords(zip);
        if (coords) {
          setUserLocation({ ...coords, source: 'zip', zip });
          setShowShowtimes(true);
          return;
        }
      }
      // 7-day re-prompt timer elapsed? Re-surface the full prompt (treat
      // as first-time). Otherwise show the retry view which leads with ZIP.
      setLocationPrompt(shouldRepromptAfterDecline() ? 'first' : 'retry');
      return;
    }

    // Path C — first time
    setLocationPrompt('first');
  };

  const handleLocationAllow = async () => {
    const coords = await getCurrentCoords({ forceRefresh: true });
    if (!coords) {
      // Browser denied or returned junk. Treat as denial — but tell the
      // user via the modal's error state by throwing back.
      recordPermissionDecision('denied');
      trackLocationPermissionResult({ result: 'denied', promptType: locationPrompt || 'first' });
      throw new Error('Location unavailable. Try ZIP instead.');
    }
    recordPermissionDecision('granted');
    trackLocationPermissionResult({ result: 'granted', promptType: locationPrompt || 'first' });
    setUserLocation({ ...coords, source: 'gps' });
    setLocationPrompt(null);
    setShowShowtimes(true);
  };

  const handleLocationZip = async (zip) => {
    const coords = await zipToCoords(zip);
    if (!coords) {
      throw new Error('Could not find that ZIP. Try again.');
    }
    const isFirstTime = !getStoredZip();
    setStoredZip(zip);
    // ZIP entry implies the user declined GPS (or chose not to use it).
    if (getStoredPermissionState() !== 'granted') {
      recordPermissionDecision('denied');
    }
    trackZipEntered({ firstTime: isFirstTime });
    setUserLocation({ ...coords, source: 'zip', zip });
    setLocationPrompt(null);
    setShowShowtimes(true);
  };

  const handleLocationDismiss = () => {
    // User backed out without making a decision. Don't record anything —
    // they'll be re-prompted next time they tap "Get tickets".
    setLocationPrompt(null);
  };

  // ── Inline location change from ShowtimesSheet / InTheaters ────────────
  // Called when the user sets/changes their area (ZIP chip or "use my
  // location"). Throws on failure so the caller can surface a clean error.
  // `silent` skips analytics — used by the In Theaters auto-restore of a
  // previously-saved ZIP, which isn't a fresh user action.
  const handleLocationChange = async ({ mode, zip, silent = false }) => {
    if (mode === 'gps') {
      clearCachedCoords();
      const coords = await getCurrentCoords({ forceRefresh: true });
      if (!coords) {
        recordPermissionDecision('denied');
        trackLocationPermissionResult({ result: 'denied', promptType: 'inline' });
        throw new Error('Location unavailable. Try a ZIP instead.');
      }
      recordPermissionDecision('granted');
      trackLocationPermissionResult({ result: 'granted', promptType: 'inline' });
      setUserLocation({ ...coords, source: 'gps' });
      return;
    }

    if (mode === 'zip') {
      const coords = await zipToCoords(zip);
      if (!coords) {
        throw new Error("Couldn't find that ZIP. Try another.");
      }
      const isFirstTime = !getStoredZip();
      setStoredZip(zip);
      if (!silent) trackZipEntered({ firstTime: isFirstTime });
      setUserLocation({ ...coords, source: 'zip', zip });
      return;
    }
  };

  // Shared "dismiss for today" — persists the day key so the card stays gone
  // until tomorrow. Used by the new-releases card and both retention nudges.
  const dismissForToday = (key, setter) => {
    setter(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      safeSet(key, today);
    } catch {}
  };

  const handleNewReleasesDismiss = () =>
    dismissForToday('settle_newrel_dismissed', setNewReleasesDismissed);

  // ── Push notifications opt-in (PM roadmap 3.1) ──────────────────────────
  // On mount + when the signed-in account changes, check whether this device
  // is already subscribed so the Settings toggle reflects reality. Key on
  // user.uid (not the user object) — Firebase emits multiple identity-stable
  // setUser calls during hydration; keying on the uid skips the redundant
  // service-worker round-trips.
  useEffect(() => {
    if (!user?.uid) { setPushSubscribed(false); return; }
    let cancelled = false;
    isSubscribedOnThisDevice().then(sub => {
      if (!cancelled) setPushSubscribed(sub);
    });
    return () => { cancelled = true; };
  }, [user?.uid]);

  // Heartbeat — once this device is subscribed, refresh the server-side push
  // profile on app open and whenever top genres / services change. Keeps the
  // re-engagement cron's lastSeenAt (idle detection) and targeting current.
  // Lightweight: re-sends the existing subscription, no permission prompt.
  useEffect(() => {
    if (!user?.uid || !pushSubscribed) return;
    syncPushProfile(user.uid, {
      topGenres: topSoloIdsKey ? topSoloIdsKey.split(',').map(Number).filter(Number.isFinite) : [],
      services: servicesKey ? servicesKey.split(',') : [],
      partnerUid: partnerUid || null,
    });
  }, [user?.uid, pushSubscribed, topSoloIdsKey, servicesKey, partnerUid]);

  // Fire the analytics "prompt shown" event the first time the banner
  // becomes visible. Tracked separately from "accepted/denied" so the funnel
  // can measure prompt-to-acceptance conversion.
  const shouldShowOptIn =
    !!user &&
    pickCount >= 3 &&
    !pushPrompted &&
    isPushSupported() &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'default' &&
    consent; // respect storage consent — no opt-in for users who declined sync
  useEffect(() => {
    if (shouldShowOptIn) trackPushPromptShown();
  }, [shouldShowOptIn]);

  // Targeting passed to the push subscription so the cron knows which genres +
  // services to surface "new releases" for. Reads the user's top solo genres
  // (TMDB ids) and their selected services.
  const pushTargeting = () => ({
    topGenres: (topGenresByPlayer.solo || []).map(g => g.id).filter(Boolean),
    services: selectedServices,
    partnerUid: partnerUid || null,
  });

  const handlePushAccept = async () => {
    if (!user) return;
    setPushBusy(true);
    try {
      await subscribeToPush(user.uid, pushTargeting());
      setPushSubscribed(true);
      setPushPrompted(true);
      safeSet('settle_push_prompted', 'true');
      trackPushAccepted();
    } catch (e) {
      const code = (e?.message || '').toLowerCase();
      const reason = code.includes('denied')   ? 'permission_denied'
                   : code.includes('vapid')    ? 'no_vapid_key'
                   : code.includes('supported') ? 'not_supported'
                   : 'subscribe_failed';
      trackPushDenied(reason);
      // Hide the banner either way — the user took action. They can still
      // re-enable from Settings later if it was just an env-config issue.
      setPushPrompted(true);
      safeSet('settle_push_prompted', 'true');
      console.warn('[Push] Subscribe failed:', e?.message);
    } finally {
      setPushBusy(false);
    }
  };

  const handlePushDismiss = () => {
    setPushPrompted(true);
    safeSet('settle_push_prompted', 'true');
    trackPushDenied('dismissed');
  };

  // Toggle wired from Settings panel. Returns true if state changed
  // successfully — the Settings component uses the return to display
  // success/error states.
  const handlePushToggle = async (wantOn) => {
    if (!user) return false;
    setPushBusy(true);
    try {
      if (wantOn) {
        await subscribeToPush(user.uid, pushTargeting());
        setPushSubscribed(true);
        trackPushAccepted();
      } else {
        await unsubscribeFromPush(user.uid);
        setPushSubscribed(false);
        trackPushUnsubscribed();
      }
      return true;
    } catch (e) {
      console.warn('[Push] Toggle failed:', e?.message);
      return false;
    } finally {
      setPushBusy(false);
    }
  };

  const savePlayerName = (player, value) => {
    const name = value.trim() || (player === 'p1' ? 'You' : 'Partner');
    if (name !== playerNames[player]) {
      trackPartnerRenamed({ person: player === 'p1' ? 1 : 2 });
    }
    const updated = { ...playerNames, [player]: name };
    setPlayerNames(updated);
    if (consent) safeSet('streaming-player-names', JSON.stringify(updated));
    setEditingPlayer(null);
  };

  // ── Couple linking effects + handlers ──────────────────────────────────────

  // Live subscription to the partner's doc: keeps their name + saved list fresh
  // AND drives bidirectional unlink. If their doc stops pointing back at us
  // (they unlinked, or deleted their account), we unlink on this device too —
  // which also stops the ballot/session discovery listeners, so the old Secret
  // Vote popups can't keep reappearing after an unlink.
  //
  // The grace timer avoids a false unlink during the brief LINK-ESTABLISHMENT
  // window: when we enter a code, our doc points at them immediately but theirs
  // only points back once they claim the pending link (a few seconds). We only
  // treat "not mutual" as a real unlink once it's been confirmed mutual, or
  // after a short grace has passed without it becoming mutual.
  useEffect(() => {
    if (!partnerUid) {
      setPartnerName(null);
      setPartnerSaved([]);
      return;
    }
    let confirmed = false;
    let graceTimer = null;

    const performAutoUnlink = async () => {
      try { if (user?.uid) await clearPartnerLink(user.uid); } catch {}
      setPartnerUid(null);
      setPartnerName(null);
      setPartnerSaved([]);
      setAwaitingLink(false);
      setLiveBallotId(null);
      setLiveBallot(null);
      setLiveRole(null);
      setCoupleSessionId(null);
      setCoupleSession(null);
      setSessionRole(null);
    };

    const unsub = subscribePartnerDoc(partnerUid, (data) => {
      if (data) {
        setPartnerName(
          data.displayName || data.playerNames?.p1 || data.playerNames?.p2 || 'Your partner'
        );
        setPartnerSaved(Array.isArray(data.savedForLater) ? data.savedForLater : []);
      }
      const mutual = !!data && data.couplePartnerUid === user?.uid;
      if (mutual) {
        confirmed = true;
        if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      } else if (confirmed) {
        // Was a confirmed link, now broken → the partner unlinked. Unlink now.
        performAutoUnlink();
      } else if (!graceTimer) {
        // Not yet confirmed — could be a link still establishing. Give it a
        // short grace, then unlink if it's still one-sided (e.g. a stale link
        // the partner already severed).
        graceTimer = setTimeout(() => { if (!confirmed) performAutoUnlink(); }, 15000);
      }
    });

    return () => { if (graceTimer) clearTimeout(graceTimer); unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerUid, user?.uid]);

  // Ref mirror of the active ballot id so the snapshot callback below can guard
  // against re-opening while a vote is already in progress (closures see stale
  // state otherwise).
  const liveBallotIdRef = useRef(null);
  useEffect(() => { liveBallotIdRef.current = liveBallotId; }, [liveBallotId]);

  // P2 discovery — listen for a live ballot where this user is the partner.
  // When one arrives and we're not already in a ballot, join it as 'partner'.
  // The query filters status=='pending', so it stops matching once the ballot
  // resolves — that's fine, the dedicated doc subscription below takes over and
  // carries us through the reveal.
  useEffect(() => {
    if (!user?.uid || !partnerUid) return;
    const unsub = subscribeToIncomingBallot(user.uid, (incoming) => {
      if (incoming && !liveBallotIdRef.current) {
        setLiveRole('partner');
        setLiveBallotId(incoming.id);
      }
    });
    return unsub;
  }, [user?.uid, partnerUid]);

  // Direct doc subscription for whichever ballot we're engaged in (either side).
  // Unlike the query listener, this keeps firing through the status change to
  // matched/missed, so both devices see the reveal. Clears state if the doc is
  // deleted.
  useEffect(() => {
    if (!liveBallotId) { setLiveBallot(null); return; }
    const unsub = subscribeBallot(liveBallotId, (docData) => {
      if (!docData) {
        setLiveBallot(null);
        setLiveBallotId(null);
        setLiveRole(null);
      } else {
        setLiveBallot(docData);
      }
    });
    return unsub;
  }, [liveBallotId]);

  // On app open (after sign-in), check if P1's partner has accepted the code
  // while P1 was away. Claims the pending-link and writes the partner uid.
  useEffect(() => {
    if (!user?.uid) return;
    // Only poll if we don't already have a partner (avoid double-write).
    if (partnerUid) return;
    checkPendingLink().then(async ({ partnerUid: pUid }) => {
      if (!pUid) return;
      await savePartnerLink(user.uid, pUid);
      setPartnerUid(pUid);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid]);

  // While P1 is showing an invite code, poll for the partner having entered it
  // so the link completes LIVE — no manual refresh. /api/couple/pending is
  // claim-once, so the first poll that lands after P2 verifies wins. Once
  // partnerUid is set, CoupleLink re-renders into its "Linked with…" state and
  // the session intro shows its "Start the session" CTA automatically.
  useEffect(() => {
    if (!awaitingLink || partnerUid || !user?.uid) return;
    const iv = setInterval(async () => {
      try {
        const { partnerUid: pUid } = await checkPendingLink();
        if (pUid) {
          await savePartnerLink(user.uid, pUid);
          setPartnerUid(pUid);
          setAwaitingLink(false);
        }
      } catch { /* keep polling */ }
    }, 4000);
    return () => clearInterval(iv);
  }, [awaitingLink, partnerUid, user?.uid]);

  // Stop waiting once the linking UI (intro modal or Settings) is closed.
  useEffect(() => {
    if (!showSessionIntro && !showSettings) setAwaitingLink(false);
  }, [showSessionIntro, showSettings]);

  // Generate a code (P1 side). Called by CoupleLink.
  const handleGenerateCode = async () => {
    // Use the Firebase Auth identity (Google display name or email prefix) — not
    // the couples-ballot label (playerNames.p1 = 'You' by default), which is
    // what P2 would see as "Linked with: You". Fall through to the ballot label
    // only as a last resort, so the code always has something human-readable.
    const displayName =
      user?.displayName ||
      user?.email?.split('@')[0] ||
      playerNames?.p1 ||
      'Your partner';
    const code = await generateInviteCode(displayName);
    // Start watching for the partner to enter it — completes the link live so
    // P1 doesn't have to refresh (see the polling effect below).
    setAwaitingLink(true);
    return code;
  };

  // Verify a code (P2 side). Saves the link to Firestore + state. Called by CoupleLink.
  const handleVerifyCode = async (code) => {
    const { partnerUid: pUid, partnerName: pName } = await verifyInviteCode(code);
    await savePartnerLink(user.uid, pUid);
    setPartnerUid(pUid);
    setPartnerName(pName || 'Your partner');
  };

  // Unlink — clears couplePartnerUid on this user's doc, and tears down any
  // in-flight ballot / session / pending link so nothing lingers.
  const handleUnlinkPartner = async () => {
    if (!user?.uid) return;
    await clearPartnerLink(user.uid);
    trackPartnerUnlinked();
    setPartnerUid(null);
    setPartnerName(null);
    setPartnerSaved([]);
    setAwaitingLink(false);
    closeLiveBallot();
    if (coupleSessionId) closeCoupleSession(coupleSessionId);
    setCoupleSessionId(null);
    setCoupleSession(null);
    setSessionRole(null);
  };

  // ── Live two-device ballot handlers ────────────────────────────────────────

  // Tear down the live ballot on this device. Expire the doc whenever it's
  // still pending — for EITHER party. Previously only the initiator expired it,
  // so when the partner dismissed/skipped, the ballot stayed 'pending' in
  // Firestore and the discovery listener re-opened it on every refresh. A
  // resolved (matched/missed) ballot is left untouched — closing the reveal
  // shouldn't rewrite its outcome.
  const closeLiveBallot = ({ expire = false } = {}) => {
    const id = liveBallotId;
    const unresolved = liveBallot && liveBallot.status === 'pending';
    if (id && (expire || unresolved)) {
      dismissBallot(id);
    }
    setLiveBallotId(null);
    setLiveBallot(null);
    setLiveRole(null);
  };

  // Cast THIS device's secret vote.
  const handleCastLiveVote = async (vote) => {
    if (!liveBallotId || !liveRole) return;
    try { await castVote(liveBallotId, liveRole, vote); }
    catch (e) { console.warn('[LiveBallot] vote failed:', e.message); }
  };

  // Pass-the-phone fallback: the initiator casts the partner's vote on this
  // device when the partner isn't there to use their own phone.
  const handleCastPartnerVote = async (vote) => {
    if (!liveBallotId) return;
    try { await castVote(liveBallotId, 'partner', vote); }
    catch (e) { console.warn('[LiveBallot] partner vote failed:', e.message); }
  };

  // Both voted yes — record the match on THIS device and open it full-screen.
  const handleLiveMatch = () => {
    const t = liveBallot?.title;
    closeLiveBallot();
    // If this match came out of a couple session, end the session too.
    if (coupleSessionId) {
      closeCoupleSession(coupleSessionId);
      setCoupleSessionId(null);
      setCoupleSession(null);
      setSessionRole(null);
      sessionPickedForRef.current = null;
    }
    if (!t) return;
    saveToHistory(t, { coupleAgreed: true, mode: 'couple' });
    if (Array.isArray(t.genres) && t.genres.length) {
      updateTasteProfile(t.genres, 'up', 'couple');
    }
    // Show the matched title full-screen via the replay path — works on both
    // devices regardless of which one originally picked it.
    setReplayResult(t);
    setCinemaSource('history');
    setCinemaMode(true);
  };

  // Miss — the initiator finds another pick (expiring the current ballot so the
  // partner's view closes), then re-picks.
  const handleLiveRetry = () => {
    closeLiveBallot({ expire: true });
    pickContent(false);
  };

  // ── Live couple session (collaborative mood → pick) ────────────────────────

  useEffect(() => { coupleSessionIdRef.current = coupleSessionId; }, [coupleSessionId]);

  // Partner discovery — a session where this user is the partner just started.
  // Join it: force couples mode, reset our session mood slot, clear any result.
  useEffect(() => {
    if (!user?.uid || !partnerUid) return;
    const unsub = subscribeIncomingSession(user.uid, (incoming) => {
      if (incoming && !coupleSessionIdRef.current) {
        setSessionRole('partner');
        setCoupleSessionId(incoming.id);
        setMode('couple');
        setSelectedGenres(g => ({ ...g, session: [] }));
        setResult(null);
        setHasSearched(false);
      }
    });
    return unsub;
  }, [user?.uid, partnerUid]);

  // Direct doc subscription — both sides, full lifecycle (survives status flips).
  useEffect(() => {
    if (!coupleSessionId) { setCoupleSession(null); return; }
    const unsub = subscribeCoupleSession(coupleSessionId, (docData) => {
      if (!docData || docData.status === 'closed') {
        setCoupleSession(null);
        setCoupleSessionId(null);
        setSessionRole(null);
        sessionPickedForRef.current = null;
      } else {
        setCoupleSession(docData);
      }
    });
    return unsub;
  }, [coupleSessionId]);

  // Live-sync this device's mood selection to the session doc (debounced) while
  // selecting, so the partner's compatibility % updates as each person picks —
  // mirroring the single-device meter. Keyed on a stringified id list to avoid
  // firing on every array-identity change.
  const sessionGenresKey = (selectedGenres.session || []).join(',');
  useEffect(() => {
    if (!coupleSessionId || !sessionRole) return;
    if (!coupleSession || coupleSession.status !== 'selecting') return;
    if (sessionGenreSyncRef.current) clearTimeout(sessionGenreSyncRef.current);
    sessionGenreSyncRef.current = setTimeout(() => {
      updateSessionGenres(coupleSessionId, sessionRole, selectedGenres.session || []).catch(() => {});
    }, 500);
    return () => { if (sessionGenreSyncRef.current) clearTimeout(sessionGenreSyncRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coupleSessionId, sessionRole, coupleSession?.status, sessionGenresKey]);

  // Both locked in → the INITIATOR runs the pick once and broadcasts it.
  useEffect(() => {
    if (!coupleSession || sessionRole !== 'initiator') return;
    if (coupleSession.status !== 'selecting') return;
    if (!(coupleSession.initiatorReady && coupleSession.partnerReady)) return;
    if (sessionPickedForRef.current === coupleSession.id) return; // already picked this round
    sessionPickedForRef.current = coupleSession.id;

    const combined = [...new Set([
      ...(coupleSession.initiatorGenres || []),
      ...(coupleSession.partnerGenres || []),
    ])];
    (async () => {
      const picked = await pickContent(false, false, combined);
      if (picked) {
        try { await broadcastSessionResult(coupleSession.id, picked); }
        catch (e) { console.warn('[CoupleSession] broadcast failed:', e.message); }
      } else {
        // No pick (e.g. no services / no matches) — let the initiator retry by
        // un-readying so the UI returns to selection.
        sessionPickedForRef.current = null;
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coupleSession?.status, coupleSession?.initiatorReady, coupleSession?.partnerReady, sessionRole]);

  // Result handoff — once a result is broadcast, BOTH devices show it via the
  // normal result card (the partner especially, who didn't run the pick).
  useEffect(() => {
    if (coupleSession?.status === 'result' && coupleSession.result) {
      const r = coupleSession.result;
      setResult(prev => (prev?.id === r.id ? prev : r));
      setHasSearched(true);
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coupleSession?.status, coupleSession?.result?.id]);

  // Start a session (initiator).
  // Live-flow "Send ballot" (spec §4.2). Unlike the old handleStartSession,
  // the Firestore session doc isn't created until the sender has already
  // chosen their moods in the compose screen (selectedGenres.live) — so
  // creation and the initiator's own lock-in happen together, in one tap.
  const handleSendLiveBallot = async () => {
    if (!partnerUid || !user?.uid) return;
    const chosen = selectedGenres.live || [];
    if (chosen.length === 0) return;
    setSessionError(null);
    setResult(null);
    setHasSearched(false);
    try {
      const id = await createCoupleSession({
        initiatorUid:  user.uid,
        partnerUid,
        initiatorName: user.displayName || user.email?.split('@')[0] || playerNames?.p1 || 'Your partner',
        partnerName:   partnerName || 'Your partner',
      });
      setSessionRole('initiator');
      setCoupleSessionId(id);
      await setSessionReady(id, 'initiator', chosen, true);
      setSelectedGenres(g => ({ ...g, live: [] }));
    } catch (e) {
      // Surface the failure instead of dying silently. The usual cause is the
      // coupleSessions Firestore rules not being deployed (permission-denied).
      console.error('[CoupleSession] send failed:', e?.code || '', e?.message);
      setSessionError(
        e?.code === 'permission-denied'
          ? "Couldn't send the ballot — the couples feature isn't fully enabled on the server yet."
          : "Couldn't send the ballot. Check your connection and try again."
      );
    }
  };

  // Lock in my moods (write my genres + ready=true).
  const handleSessionReady = () => {
    if (!coupleSessionId || !sessionRole) return;
    const myGenres = selectedGenres.session || [];
    if (myGenres.length === 0) return;
    setSessionReady(coupleSessionId, sessionRole, myGenres, true).catch(() => {});
  };

  // Un-lock (go back to choosing).
  const handleSessionUnready = () => {
    if (!coupleSessionId || !sessionRole) return;
    setSessionReady(coupleSessionId, sessionRole, selectedGenres.session || [], false).catch(() => {});
  };

  // Cancel / close the session (either party).
  const handleCancelSession = () => {
    if (coupleSessionId) closeCoupleSession(coupleSessionId);
    setCoupleSession(null);
    setCoupleSessionId(null);
    setSessionRole(null);
    sessionPickedForRef.current = null;
  };

  // "Try another" inside an active session — the initiator re-picks from the
  // combined moods and re-broadcasts; the partner's tap is a no-op (they wait).
  const handleSessionTryAnother = async () => {
    if (sessionRole !== 'initiator' || !coupleSession) return;
    const combined = [...new Set([
      ...(coupleSession.initiatorGenres || []),
      ...(coupleSession.partnerGenres || []),
    ])];
    const picked = await pickContent(false, false, combined);
    if (picked) {
      try { await broadcastSessionResult(coupleSession.id, picked); }
      catch (e) { console.warn('[CoupleSession] re-broadcast failed:', e.message); }
    }
  };

  // ── Save for later ────────────────────────────────────────────────────────
  // "I've seen this" pre-watch veto — adds the current pick's id to
  // recentPicks (which pickContent already filters against) so it never
  // re-appears, then triggers a fresh pick. Does NOT touch tasteProfile
  // because we don't have a signal about whether they liked it or not —
  // they just don't want to see it again.
  // Opens the YouTube trailer overlay for the currently-active item.
  // `surface` identifies which UI surface the user tapped from so we can
  // correlate trailer plays with downstream conversion in analytics
  // ('result_card' vs 'cinema_mode').
  const openTrailer = (surface) => {
    const item = cinemaSource === 'history' ? replayResult : result;
    if (!trailer?.key || !item) return;
    setShowTrailer(true);
    trackTrailerPlayed({
      service: item.service,
      type:    item.type,
      mode,
      fromSurface: surface,
    });
    // Apply soft taste signal — trailer view counts as a 25% upvote (+0.5 vs
    // an explicit upvote's +2). Capped at one credit per title per session
    // so the user can't compound by re-opening the trailer.
    applyTrailerSignal(item);
  };

  // ── Trailer-as-soft-taste-signal (PM roadmap 1.2) ────────────────────────
  // A user who watches a trailer didn't skip — that's a real signal. We add
  // +0.5 per genre, capped at one credit per title per session. If the user
  // later explicitly votes on the same title, handleVote/saveToHistory mark
  // the entry as `trailerCredited: true` so the explicit vote can reverse
  // the +0.5 first, preventing double-counting.
  const applyTrailerSignal = (item) => {
    if (!item || !item.id) return;
    if (trailerCreditedRef.current.has(item.id)) return; // already credited this session
    trailerCreditedRef.current.add(item.id);

    const entryMode = mode === 'theater' ? 'solo' : mode;
    const genreIds = item.genres || [];
    if (genreIds.length === 0) return;

    setTasteProfile(prev => {
      const updated = JSON.parse(JSON.stringify(prev));
      const players = entryMode === 'couple' ? ['p1', 'p2'] : [entryMode];
      players.forEach(player => {
        if (!updated[player]) updated[player] = {};
        genreIds.forEach(id => {
          updated[player][id] = (updated[player][id] || 0) + TRAILER_BOOST;
        });
      });
      if (consent) safeSet('streaming-taste-profile', JSON.stringify(updated));
      return updated;
    });
  };

  // Reverses a trailer signal — used by handleVote so an explicit vote doesn't
  // compound on top of the trailer-view boost already applied.
  const reverseTrailerSignal = (genreIds, entryMode) => {
    if (!genreIds || genreIds.length === 0) return;
    setTasteProfile(prev => {
      const updated = JSON.parse(JSON.stringify(prev));
      const players = entryMode === 'couple' ? ['p1', 'p2'] : [entryMode];
      players.forEach(player => {
        if (!updated[player]) return;
        genreIds.forEach(id => {
          updated[player][id] = Math.max(0, (updated[player][id] || 0) - TRAILER_BOOST);
        });
      });
      if (consent) safeSet('streaming-taste-profile', JSON.stringify(updated));
      return updated;
    });
  };

  const closeTrailer = () => setShowTrailer(false);

  const handleVetoPick = () => {
    if (!result) return;
    const id = result.id;
    setRecentPicks(prev => {
      const updated = [...prev.filter(p => p !== id), id].slice(-100);
      if (consent) safeSet('streaming-seen', JSON.stringify(updated));
      return updated;
    });
    trackPickMarkedSeen({ tmdbId: id });
    setTryAnotherCount(c => c + 1);
    pickContent(false);
  };

  const toggleSaveForLater = (item) => {
    const exists = savedForLater.some(s => s.id === item.id);
    const updated = exists
      ? savedForLater.filter(s => s.id !== item.id)
      : [{
          id: item.id, title: item.title, year: item.year,
          posterPath: item.posterPath, service: item.service,
          rating: item.rating, type: item.type,
          genres: item.genres || [], savedAt: new Date().toISOString()
        }, ...savedForLater].slice(0, 20);
    setSavedForLater(updated);
    safeSet('settle-saved', JSON.stringify(updated));
    if (exists) {
      // Removal — flush authoritatively so the additive merge transaction
      // can't resurrect the unstarred entry from the cloud copy.
      flushAuthoritativeSync({ savedForLater: updated });
    }
  };

  const isSaved = (item) => item && savedForLater.some(s => s.id === item.id);

  // ── Profile export / import ────────────────────────────────────────────────
  // Manual export/import flow removed in this commit. Was a stop-gap
  // against localStorage wipe before cloud sync existed; now Firestore is
  // the canonical persistence layer and the cross-device portability
  // story is "sign in on the other device".

  // ── Couples streak ─────────────────────────────────────────────────────────
  // Number of consecutive NIGHTS (distinct calendar days) on which the couple
  // agreed on a pick — NOT the raw number of agreed entries. Multiple "Let's
  // watch" matches in a single day count once. A gap day (no agreed watch)
  // resets the streak. Returns null below 2 nights. Matches the day-grouped
  // logic in StreakHistory.js so the chip and the modal always agree.
  const streakInfo = useMemo(() => {
    const DAY = 24 * 60 * 60 * 1000;
    // Distinct local days that had at least one couple-agreed watch.
    const hitDays = new Set();
    for (const h of watchHistory) {
      if (h.mode !== 'couple' || !h.coupleAgreed || !h.watchedAt) continue;
      const d = new Date(h.watchedAt);
      if (isNaN(d.getTime())) continue;
      d.setHours(0, 0, 0, 0);
      hitDays.add(d.getTime());
    }
    if (hitDays.size === 0) return null;

    // Walk distinct hit-days newest→oldest, counting only back-to-back days.
    // Math.round on the day delta keeps it DST-safe (23h/25h days → 1).
    const sorted = [...hitDays].sort((a, b) => b - a);
    let streak = 1;
    for (let i = 1; i < sorted.length; i++) {
      if (Math.round((sorted[i - 1] - sorted[i]) / DAY) === 1) streak++;
      else break;
    }
    return streak >= 2 ? streak : null;
  }, [watchHistory]);

  const handleConsent = (accepted) => {
    // Persist the decision either way so the banner never re-appears on return visits.
    safeSet('sd_consent', accepted ? 'true' : 'false');
    if (accepted) setConsent(true);
    setShowConsent(false);
  };

  const handleOnboardingDone = () => {
    safeSet('sd_onboarded', 'true');
    safeSet('onboarding_complete', 'true');
    setShowOnboarding(false);
  };

  // Single-device pass-the-phone ballot (original behaviour) — used when the
  // user isn't linked with a partner.
  const openSingleDeviceBallot = () => {
    setBallotStep('p1');
    setP1Vote(null);
    setP2Vote(null);
    setShowBallot(true);
  };

  // Secret Vote entry point. When linked with a partner, start a LIVE
  // two-device ballot: it appears on the partner's phone in real time and each
  // votes on their own device. Otherwise fall back to the single-device ballot.
  const openBallot = async () => {
    // Already in a live ballot (e.g. the partner's discovery listener opened it
    // when we tapped Secret Vote) — don't create a second one.
    if (liveBallotId) return;
    if (partnerUid && result && user?.uid) {
      try {
        const id = await createLiveBallot({
          initiatorUid:  user.uid,
          partnerUid,
          initiatorName: user.displayName || user.email?.split('@')[0] || playerNames?.p1 || 'Your partner',
          partnerName:   partnerName || 'Your partner',
          title:         result,
        });
        setLiveRole('initiator');
        setLiveBallotId(id);
        return;
      } catch (e) {
        console.warn('[LiveBallot] start failed, falling back to single device:', e.message);
        // fall through to single-device ballot
      }
    }
    openSingleDeviceBallot();
  };

  const handleBallotVote = (vote) => {
    if (ballotStep === 'p1') {
      setP1Vote(vote);
      setBallotStep('p2');
    } else if (ballotStep === 'p2') {
      setP2Vote(vote);
      setBallotStep('reveal');
    }
  };

  const getBallotOutcome = (v1, v2) => {
    if (v1 === 'up' && v2 === 'up') return 'match';
    if (v1 === 'down' && v2 === 'down') return 'both-no';
    return 'split';
  };

  const handleBallotMatch = () => {
    setShowBallot(false);
    setBallotFailCount(0);
    setCinemaSource('pick');
    setCinemaMode(true);
    saveToHistory(result, { coupleAgreed: true });
    // Both players voted up — train both taste profiles immediately
    if (result.genres?.length > 0) {
      updateTasteProfile(result.genres, 'up', 'couple');
    }
  };

  const handleBallotRetry = () => {
    const genreIds = result.genres || [];
    setShowBallot(false);
    setBallotFailCount(prev => prev + 1);
    // Train each player's profile from their individual ballot vote before retrying.
    // Split/veto data is signal — don't discard it.
    if (genreIds.length > 0) {
      if (p1Vote) updateTasteProfile(genreIds, p1Vote, 'p1');
      if (p2Vote) updateTasteProfile(genreIds, p2Vote, 'p2');
    }
    pickContent(false);
  };

  // Coin flip — pure random pick with no taste-profile weighting. Fires after
  // 2 consecutive failed ballots when both players want fate to decide.
  const handleCoinFlip = () => {
    setBallotFailCount(0);
    setShowBallot(false);
    pickContent(false, true); // true = coinFlip mode
  };

  const closeShareModal = () => {
    setShowShareModal(false);
    setShareCardUrl(null);
    setShareCardReady(false);
    shareCanvasRef.current = null;
    shareFileRef.current = null;
  };

  // Opens the share modal and generates the card.
  // Critically: we also pre-bake the share File here so the Share button's
  // click handler doesn't have to await anything before navigator.share().
  // iOS Safari enforces user-gesture context strictly — any async work
  // between the tap and navigator.share() makes the share sheet render
  // as an empty dark overlay with no app icons.
  const handleShare = async (item) => {
    shareItemRef.current = item;
    setShareCardUrl(null);
    setShareCardReady(false);
    shareCanvasRef.current = null;
    shareFileRef.current = null;
    setShareCardLoading(true);
    setShowShareModal(true);
    try {
      const resolvedGenres = (item.genres || [])
        .map(id => genreById.get(id))
        .filter(Boolean)
        .slice(0, 4);
      const canvas = await generateShareCard({ result: { ...item, genres: resolvedGenres }, mode, playerNames });
      shareCanvasRef.current = canvas;

      // Pre-bake the share File. JPEG @ 0.92 quality halves the file size vs
      // PNG (1080×1920 PNG can hit 2–3 MB, which the iOS share sheet
      // sometimes chokes on). Visual fidelity is indistinguishable at this
      // quality for poster art + flat dark gradients.
      try {
        const blob = await new Promise(resolve =>
          canvas.toBlob(resolve, 'image/jpeg', 0.92)
        );
        if (blob) {
          shareFileRef.current = new File([blob], 'settle-pick.jpg', { type: 'image/jpeg' });
        }
      } catch (e) {
        // Tainted canvas — toBlob will throw. Falls through to text share.
        console.warn('[ShareCard] toBlob failed:', e?.message);
      }

      try {
        setShareCardUrl(canvas.toDataURL('image/jpeg', 0.92));
      } catch {
        // Canvas is tainted (poster loaded without CORS) — card still renders,
        // we'll mount the canvas element directly for preview
        console.warn('[ShareCard] canvas tainted — mounting directly');
      }
      setShareCardReady(true);
    } catch (err) {
      console.error('[ShareCard] generation failed:', err);
      closeShareModal();
      shareAsText(item);
    } finally {
      setShareCardLoading(false);
    }
  };

  // Fallback: share/copy as plain text
  const shareAsText = async (item) => {
    const verb = pickVerb(mode);
    const text = `🎬 ${verb} "${item.title}" (${item.year}) on ${item.service}. Found it in seconds with Settle.`;
    const url  = 'https://trysettle.app';
    if (navigator.share) {
      try { await navigator.share({ title: 'Settle', text, url }); } catch {}
    } else {
      try {
        await navigator.clipboard.writeText(`${text}\n${url}`);
        setShareCopied(true);
        setTimeout(() => setShareCopied(false), 2500);
      } catch {}
    }
  };

  // Share via native share sheet (Instagram, WhatsApp, etc.)
  //
  // Two iOS Safari constraints to satisfy:
  //
  // 1. navigator.share() MUST be called synchronously from the user-gesture
  //    handler. Any await between the tap and the call severs the gesture
  //    context and iOS opens a blank share sheet. We satisfy this by
  //    pre-baking shareFileRef in handleShare() — by the time the user taps
  //    Share, the File is already in memory and dispatch is synchronous.
  //
  // 2. The click handler must RETURN immediately, without awaiting the share
  //    promise. If we await, iOS thinks the gesture is still in flight and
  //    keeps the share sheet visible after the user returns from Instagram /
  //    WhatsApp / etc — they have to manually swipe it away. Fire-and-forget
  //    with .then/.catch/.finally lets iOS auto-dismiss the sheet as soon as
  //    the target app reports completion.
  const shareImageCard = () => {
    const file = shareFileRef.current;
    const item = shareItemRef.current;
    if (!file) {
      // Pre-bake failed (tainted canvas, low-memory abort) — fall back to
      // text-only share so the user isn't stuck.
      shareAsText(item || {});
      return;
    }
    if (!navigator.canShare?.({ files: [file] })) {
      shareAsText(item || {});
      return;
    }

    // Mark share in progress so the visibilitychange/pageshow/focus listeners
    // know to fully reset our state when the user returns. Survives bfcache.
    sessionStorage.setItem('settle_sharing', '1');
    // flushSync commits the modal-close to the DOM synchronously so the
    // bfcache snapshot (taken when iOS switches to Instagram) is clean.
    try { flushSync(() => closeShareModal()); } catch { closeShareModal(); }

    // Hand off to the OS share sheet — fire-and-forget. Title is intentionally
    // omitted: it was confusing iOS into displaying a "Sharing 'Title'…"
    // status that delayed sheet dismissal in some flows.
    navigator.share({ files: [file] })
      .catch(() => { /* AbortError (user cancelled) or extension error */ })
      .finally(() => {
        sessionStorage.removeItem('settle_sharing');
        // Release the file reference so iOS doesn't hold the 340 KB blob
        // longer than necessary — also makes the share state unambiguous.
        shareFileRef.current = null;
      });
  };

  // `forceGenres` (optional) — caller-supplied genre IDs that bypass the
  // memoized `activeGenres` lookup. Used by handleNewReleasesTap so the
  // immediate pick fires against the seeded top genres without waiting
  // for React to commit the setSelectedGenres call (queueMicrotask /
  // setTimeout both run before commit and would read stale state).
  const pickContent = async (hiddenGems = false, coinFlip = false, forceGenres = null) => {
    if (mode !== 'theater' && selectedServices.length === 0) {
      setHasSearched(true);
      setMatchCount(0);
      return;
    }

    // Require at least one mood to be selected before fetching.
    // Hidden gems intentionally bypass genre filtering, but we still
    // want users to confirm intent — skip the guard for that path.
    if (!hiddenGems) {
      const hasMood = forceGenres
        ? forceGenres.length > 0
        : mode === 'couple'
          ? (selectedGenres.p1.length > 0 || selectedGenres.p2.length > 0)
          : (selectedGenres[mode === 'theater' ? 'theater' : 'solo'] || []).length > 0;

      if (!hasMood) {
        setHasSearched(true);
        setMatchCount(0);
        setNoMoodSelected(true);
        return;
      }
    }
    setNoMoodSelected(false);
    setLoading(true);
    setResult(null);
    setPickChips([]);
    setFetchError(false);
    setFetchErrorType(null);

    // Bump the generation token so any earlier in-flight pickContent() that
    // resolves *after* this call returns is silently ignored — prevents a
    // stale "Try another" result from popping in on top of a newer pick.
    const myGen = ++pickGenerationRef.current;
    const isCurrent = () => myGen === pickGenerationRef.current;

    // 20-second hard timeout — if TMDB is stalling (cold-start pile-up, rate
    // limit, slow network) the spinner would otherwise hang indefinitely.
    let fetchTimedOut = false;
    const fetchTimeout = setTimeout(() => {
      fetchTimedOut = true;
      if (!isCurrent()) return;
      setFetchErrorType('timeout');
      setFetchError(true);
      setLoading(false);
      setHasSearched(true);
    }, 20000);

    try {
      let allResults = [];
      // Theater uses its own genre slot so solo selections never bleed across.
      // Hidden gems bypass genre filtering entirely (wide net by design).
      // The `activeGenres` memo already handles solo/couple/theater branches,
      // so we only need to special-case the hidden-gems "no filter" path here.
      // `forceGenres` (from handleNewReleasesTap) wins over the memo so we
      // can fire a pick against just-seeded genres before React commits.
      const activeGenresForFetch = hiddenGems
        ? []
        : (forceGenres && forceGenres.length > 0)
          ? forceGenres
          : activeGenres;

      if (mode === 'theater') {
        allResults = familyFriendly
          ? await tmdbService.getNowPlayingWithOptions({
              maxCertification: 'PG-13',
            })
          : await tmdbService.getNowPlaying();
      } else {
        const activeFormats = selectedFormats;
        // Collect thunks (not live promises) so runConcurrent can control
        // how many fire at once and avoid cold-start pile-ups.
        const fetchFns = [];

        // Split activeGenres into three buckets:
        //   regularIds  → real TMDB genre IDs (combined into one OR query)
        //   specialIds  → keyword-based virtual genres ('anime', 'standup')
        //   decadeIds   → date-range virtual genres ('80s, '90s, '00s)
        // The three buckets are independent layers; decade range applies to
        // ALL queries (regular + special) so '80s + Anime = '80s anime.
        const regularIds = activeGenresForFetch.filter(id => !VIRTUAL_GENRES.has(id));
        const specialIds = activeGenresForFetch.filter(id => id === 'anime' || id === 'standup');
        const decadeIds  = activeGenresForFetch.filter(id => DECADE_YEARS[id]);

        // Stand-up exclusion: when the regular query includes Comedy (35),
        // we drop stand-up-tagged titles from it so they only ever surface
        // when the user explicitly selects the Stand-up chip. Same rule for
        // the no-genre browse path (catches any incidental Comedy).
        const COMEDY_GENRE_ID = 35;
        const excludeStandup = !specialIds.includes('standup');
        const regularExcludeKeywords =
          excludeStandup && regularIds.includes(COMEDY_GENRE_ID) ? STANDUP_KEYWORDS : null;

        // Combine multiple decades by spanning the union (min gte, max lte).
        const dateGte = decadeIds.length
          ? decadeIds.map(d => DECADE_YEARS[d].gte).sort()[0]
          : null;
        const dateLte = decadeIds.length
          ? decadeIds.map(d => DECADE_YEARS[d].lte).sort().slice(-1)[0]
          : null;

        for (const service of selectedServices) {
          for (const format of activeFormats) {
            const type = format === 'Movie' ? 'movie' : 'tv';

            // No genre filter case — fires when nothing is selected OR when
            // only decade moods are selected. The date range still applies.
            // Stand-up exclusion still fires here so an unfiltered browse
            // doesn't surface stand-up specials by accident.
            if (regularIds.length === 0 && specialIds.length === 0) {
              fetchFns.push(() =>
                tmdbService.discoverContent({
                  service,
                  type,
                  minRating: hiddenGems ? 0 : minRating,
                  hiddenGems,
                  maxCertification: hiddenGems ? null : maxCertification,
                  excludeKeywords: excludeStandup ? STANDUP_KEYWORDS : null,
                  // maxRuntime removed in P2.2 — surfaced on the result card instead.
                  dateGte, dateLte,
                })
              );
            } else {
              // Regular TMDB genres are combined into one OR query (e.g.
              // "35|16") so we fire 1 request per service+format instead
              // of N requests — reduces peak burst from ~20 to ~10.
              if (regularIds.length > 0) {
                const combinedGenre = regularIds.join('|'); // TMDB OR query
                fetchFns.push(() =>
                  tmdbService.discoverContent({
                    service,
                    type,
                    genre: combinedGenre,
                    minRating,
                    hiddenGems: false,
                    maxCertification,
                    excludeKeywords: regularExcludeKeywords,
                    dateGte, dateLte,
                  })
                );
              }

              // Currently only 'anime' is a special (virtual) ID. The loop
              // stays generic so future virtual genres (K-drama, telenovela,
              // Bollywood) drop in without restructuring.
              //
              // Anime fetch fires THREE complementary queries combined into
              // one deduplicated pool. The single keyword query was returning
              // near-zero results on Netflix because TMDB's keyword tagging
              // is inconsistent, so we widen the net across three independent
              // anchors. The vote-count floor is relaxed (50→20) because
              // legit anime titles often have smaller TMDB audiences than
              // mainstream catalogs; the popularity sort still pushes noise
              // down without that floor. The user's rating slider (minRating)
              // is preserved — that's an explicit user preference.
              const ANIME_VOTE_FLOOR = 20;
              for (const id of specialIds) {
                if (id === 'anime') {
                  // Query A — Japanese animation by origin country.
                  fetchFns.push(() =>
                    tmdbService.discoverContent({
                      service,
                      type,
                      genre: '16',                // Animation
                      originCountry: 'JP',        // Japan
                      minRating,
                      voteCountFloor: ANIME_VOTE_FLOOR,
                      hiddenGems: false,
                      maxCertification,
                      dateGte, dateLte,
                    })
                  );
                  // Query B — Japanese-language animation (catches titles
                  // with original_language=ja but missing origin_country).
                  fetchFns.push(() =>
                    tmdbService.discoverContent({
                      service,
                      type,
                      genre: '16',                // Animation
                      originalLanguage: 'ja',     // Japanese
                      minRating,
                      voteCountFloor: ANIME_VOTE_FLOOR,
                      hiddenGems: false,
                      maxCertification,
                      dateGte, dateLte,
                    })
                  );
                  // Query C — anime keyword fallback (catches manga
                  // adaptations and anime-flavored mixed-origin titles).
                  fetchFns.push(() =>
                    tmdbService.discoverContent({
                      service,
                      type,
                      genre: null,
                      keywords: ANIME_KEYWORD,
                      minRating,
                      voteCountFloor: ANIME_VOTE_FLOOR,
                      hiddenGems: false,
                      maxCertification,
                      dateGte, dateLte,
                    })
                  );
                  continue;
                }
                if (id === 'standup') {
                  // Stand-up compound query: Comedy genre (35) intersected
                  // with the stand-up keyword union. Single query — no need
                  // for multi-anchor fallback because the keyword tagging
                  // on stand-up specials is consistent in TMDB.
                  fetchFns.push(() =>
                    tmdbService.discoverContent({
                      service,
                      type,
                      genre: '35',                  // Comedy
                      keywords: STANDUP_KEYWORDS,
                      minRating,
                      hiddenGems: false,
                      maxCertification,
                      dateGte, dateLte,
                    })
                  );
                  continue;
                }
                // Future virtual genres: add their fetch thunks here.
              }
            }
          }
        }

        // Cap concurrency at 5 — prevents simultaneous cold-start saturation.
        // A single failed query (rate limit, network blip) won't cancel the rest.
        const batchResults = await runConcurrent(fetchFns, 5);
        batchResults.forEach(r => {
          if (r.status === 'fulfilled') allResults.push(...r.value);
        });
      }

      // Remove duplicates
      const unique = Array.from(
        new Map(allResults.map(item => [item.id, item])).values()
      );

      // Apply rating floor.
      // Theater: use a light floor of 4.0 — new releases have thin vote counts and
      // the streaming minRating slider should never gate what's playing in cinemas.
      // Streaming hidden gems: no floor (TMDB already filters server-side at 7.5).
      // Streaming normal: apply the user's minRating preference.
      let filtered = hiddenGems
        ? unique
        : mode === 'theater'
          ? unique.filter(item => item.rating >= 4.0)
          : unique.filter(item => item.rating >= minRating);

      // Genre filter — only "real" TMDB genre IDs make it into this check.
      // Virtual IDs (keywords / decade date ranges) are handled at the query
      // layer and would never match item.genres, so filtering by them here
      // would zero out the pool.
      const realGenres = activeGenresForFetch.filter(id => !VIRTUAL_GENRES.has(id));
      if (realGenres.length > 0 && !hiddenGems) {
        filtered = filtered.filter(item =>
          item.genres.some(genreId => realGenres.includes(genreId))
        );
      }

      // Hidden gems from theater: high rated, low popularity
      if (hiddenGems && mode === 'theater') {
        filtered = filtered.filter(item => item.rating >= 7.5 && item.popularity < 50);
        if (filtered.length === 0) filtered = unique.filter(item => item.rating >= 7.0);
      }

      if (!isCurrent()) return; // a newer pickContent() took over
      setMatchCount(filtered.length);

      if (filtered.length === 0) {
        return;
      }

      const fresh = filtered.filter(item => !recentPicks.includes(item.id));
      const pool = fresh.length > 0 ? fresh : filtered;

      // Weighted random using taste profile
      const profile = mode === 'couple'
        ? (() => {
            const merged = {};
            ['p1', 'p2'].forEach(p => {
              Object.entries(tasteProfile[p] || {}).forEach(([id, score]) => {
                merged[id] = (merged[id] || 0) + score;
              });
            });
            return merged;
          })()
        : (tasteProfile[mode === 'theater' ? 'solo' : mode] || {});

      const hasProfile = Object.keys(profile).length > 0;
      const weights = pool.map(item => {
        if (coinFlip) return 1;

        let weight = 1;

        // Taste-profile genre boost (applies to all modes when profile exists)
        if (hasProfile) {
          const boost = item.genres.reduce((sum, id) => sum + (profile[id] || 0), 0);
          weight += boost * 0.15;
        }

        // Theater-specific signals layered on top of (or instead of) taste profile:
        // 1. verifiedTheater — item appeared on TMDB's curated /movie/now_playing list,
        //    meaning TMDB itself confirms it's currently screening. Strong signal.
        // 2. popularity — high popularity correlates with wide release + active buzz,
        //    capped at 100 so megablockbusters don't completely dominate the pool.
        if (mode === 'theater') {
          if (item.verifiedTheater) weight *= 1.3;
          weight += Math.min(item.popularity || 0, 100) / 200;
        }

        return weight;
      });
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      let rand = Math.random() * totalWeight;
      let picked = pool[pool.length - 1];
      for (let i = 0; i < pool.length; i++) {
        rand -= weights[i];
        if (rand <= 0) { picked = pool[i]; break; }
      }
      if (!isCurrent()) return;
      setResult(picked);
      setPickChips(
        coinFlip
          ? [{ key: 'coin-flip', icon: '🎲', label: 'Chosen by fate — no algorithm', kind: 'solo' }]
          : buildMatchChips(picked, activeGenresForFetch, hiddenGems, mode)
      );
      trackPickGenerated({
        service:     picked.service,
        type:        picked.type,
        rating:      picked.rating,
        mode,
        isHiddenGem: hiddenGems,
      });
      // Pick counter drives the push opt-in banner (PM roadmap 3.1). Counts
      // every successful pick across all modes. Persists in localStorage so
      // it survives reloads — the 3rd pick triggers the prompt whether it
      // happens in session 1 or session 4.
      setPickCount(prev => {
        const next = prev + 1;
        try { localStorage.setItem('settle_pick_count', String(next)); } catch {}
        return next;
      });
      setRecentPicks(prev => {
        const updated = [...prev.filter(id => id !== picked.id), picked.id].slice(-100);
        if (consent) safeSet('streaming-seen', JSON.stringify(updated));
        return updated;
      });
      // Return the chosen item so callers (e.g. the couple-session initiator)
      // can broadcast it to the partner's device.
      return picked;
    } catch (error) {
      console.error('Error fetching content:', error);
      if (!fetchTimedOut && isCurrent()) {
        setFetchErrorType('network');
        setFetchError(true);
      }
    } finally {
      clearTimeout(fetchTimeout);
      if (!fetchTimedOut && isCurrent()) {
        setLoading(false);
        setHasSearched(true);
      }
    }
  };

  const getPlatformLink = (service, title) => {
    const q = encodeURIComponent(title);
    const links = {
      'Netflix':      `https://www.netflix.com/search?q=${q}`,
      // Max has no reliable public search-deep-link (the old www.max.com/search
      // path 404s), so fall back to the Max app home rather than a broken page.
      // The Watchmode direct title link is the real path and covers most cases.
      'Max':          `https://play.max.com`,
      'Disney+':      `https://www.disneyplus.com/search?q=${q}`,
      // Apple TV's tv.apple.com/search?term= just dumps users on an empty
      // search bar. With no reliable web search-deep-link, fall back to the
      // Apple TV app home; the Watchmode direct title link is the real path.
      'Apple TV':     `https://tv.apple.com`,
      'Prime Video':  `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${q}`,
      'In Theaters':  `https://www.google.com/search?q=${q}+movie+showtimes`,
    };
    return links[service] || null;
  };

  const saveToHistory = (item, { coupleAgreed = false, mode: modeOverride } = {}) => {
    // Capture whether the trailer signal was applied — handleVote uses this
    // when the user later rates the title to reverse the +0.5 before applying
    // the explicit vote. Persists across sessions with the history entry.
    const trailerCredited = trailerCreditedRef.current.has(item.id);
    const entry = {
      id: item.id,
      title: item.title,
      year: item.year,
      posterPath: item.posterPath,
      service: item.service,
      rating: item.rating,
      type: item.type,
      genres: item.genres || [],
      watchedAt: new Date().toISOString(),
      // modeOverride lets the live two-device match record 'couple' on BOTH
      // devices even though the partner's local mode might be 'solo' — keeps
      // the couple streak accurate for both people.
      mode: modeOverride || mode,
      coupleAgreed,
      rated: null,
      trailerCredited,
    };
    setWatchHistory(prev => {
      const filtered = prev.filter(h => h.id !== item.id);
      const updated = [entry, ...filtered].slice(0, 30);
      if (consent) safeSet('streaming-history', JSON.stringify(updated));
      return updated;
    });
    setShowToast(true);
    setTimeout(() => setShowToast(false), 2800);

    // Schedule a next-day "how was it?" push — best-effort, fire and forget.
    // The server stores the title in Upstash with a ~20h delay; the daily
    // cron sends the nudge and clears it. Only fires when push is subscribed
    // and the user has a uid (signed in).
    if (pushSubscribed && user?.uid) {
      authHeader().then(headers => {
        fetch('/api/push/watch-loop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ titleName: item.title }),
        }).catch(() => {});
      });
    }
  };

  const handleHistoryReplay = (entry) => {
    setReplayResult(entry);
    setShowHistory(false);
    setCinemaSource('history');
    setCinemaMode(true);
  };

  // entryMode: 'solo' | 'couple' (both players) | 'p1' | 'p2' (individual)
  const updateTasteProfile = (genreIds, vote, entryMode) => {
    setTasteProfile(prev => {
      const updated = JSON.parse(JSON.stringify(prev));
      const players =
        entryMode === 'couple' ? ['p1', 'p2'] :
        entryMode === 'p1'     ? ['p1'] :
        entryMode === 'p2'     ? ['p2'] :
        ['solo'];
      players.forEach(player => {
        if (!updated[player]) updated[player] = {};
        genreIds.forEach(id => {
          const current = updated[player][id] || 0;
          updated[player][id] = vote === 'up'
            ? current + VOTE_UP_WEIGHT
            : Math.max(0, current - VOTE_DOWN_WEIGHT);
        });
      });
      if (consent) safeSet('streaming-taste-profile', JSON.stringify(updated));
      return updated;
    });
  };

  // Core rating logic, extracted from the old handleVote so it can be called
  // for ANY history entry — not just the one currently active in the
  // WatchLoop popup. `source` distinguishes the popup flow from a direct
  // History-row tap for analytics only; the taste-profile/watchHistory
  // writes are identical either way.
  const rateHistoryEntry = (entry, vote, source = 'row') => {
    if (!entry) return;
    // Use functional setState to avoid reading from a potentially stale closure.
    const entryId = entry.id;
    const entryWatchedAt = entry.watchedAt;
    setWatchHistory(prev => {
      const updated = prev.map(e =>
        e.id === entryId && e.watchedAt === entryWatchedAt
          // Also clear `trailerCredited` so a future re-rate on the same
          // entry doesn't reverse the trailer credit a second time.
          ? { ...e, rated: vote, trailerCredited: false }
          : e
      );
      if (consent) safeSet('streaming-history', JSON.stringify(updated));
      return updated;
    });
    if (vote !== 'skip') {
      // If the trailer applied a soft signal earlier, reverse it FIRST so the
      // explicit vote replaces (rather than compounds with) the +0.5 credit.
      // The flag lives on the history entry, so this works across sessions.
      const entryMode = entry.mode === 'theater' ? 'solo' : (entry.mode || 'solo');
      if (entry.trailerCredited) {
        reverseTrailerSignal(entry.genres || [], entryMode);
      }
      updateTasteProfile(entry.genres || [], vote, entry.mode);
    }
    // Feedback funnel event. time_since_pick measures how long after the
    // pick was first surfaced the user came back to vote — long gaps
    // typically indicate "actually watched the thing", short gaps indicate
    // a snap reject. PM uses this to distinguish quality from rejection.
    const timeSincePick = entry.watchedAt
      ? Math.round((Date.now() - new Date(entry.watchedAt).getTime()) / 1000)
      : null;
    trackVoteSubmitted({
      titleId:        entryId,
      vote,
      service:        entry.service,
      timeSincePick,
    });
    // history_item_rated is specifically for History-panel-initiated rating
    // changes (row tap or menu) — the WatchLoop popup path already has its
    // own trackVoteSubmitted call above, so it's excluded here.
    if (source !== 'popup' && (vote === 'up' || vote === 'down')) {
      trackHistoryItemRated({ tmdbId: entryId, rating: vote, source });
    }
  };

  const handleVote = (vote) => {
    if (!ratingPopup) return;
    rateHistoryEntry(ratingPopup, vote, 'popup');
    setRatingPopup(null);
    setWatchLoopStep(null);
  };

  // Tapping a solid thumb reverts a History row to the ghost pair (spec
  // §4.2). Reverses the EXACT prior weight rather than calling
  // updateTasteProfile with the flipped vote — an undone 'up' must subtract
  // VOTE_UP_WEIGHT (2), not VOTE_DOWN_WEIGHT (1); an undone 'down' must add
  // VOTE_DOWN_WEIGHT back. Floor-at-0 clamping (same as updateTasteProfile
  // itself) means this can slightly under/over-correct if a genre's score
  // was already at the floor — the same tolerance the additive scoring
  // system already accepts elsewhere.
  const unrateHistoryEntry = (entry) => {
    const priorVote = entry.rated;
    if (priorVote === 'up' || priorVote === 'down') {
      const entryMode = entry.mode === 'theater' ? 'solo' : (entry.mode || 'solo');
      const players =
        entryMode === 'couple' ? ['p1', 'p2'] :
        entryMode === 'p1'     ? ['p1'] :
        entryMode === 'p2'     ? ['p2'] :
        ['solo'];
      const undoAmount = priorVote === 'up' ? VOTE_UP_WEIGHT : -VOTE_DOWN_WEIGHT;
      setTasteProfile(prev => {
        const updated = JSON.parse(JSON.stringify(prev));
        players.forEach(player => {
          if (!updated[player]) updated[player] = {};
          (entry.genres || []).forEach(id => {
            const current = updated[player][id] || 0;
            updated[player][id] = Math.max(0, current - undoAmount);
          });
        });
        if (consent) safeSet('streaming-taste-profile', JSON.stringify(updated));
        return updated;
      });
    }
    const entryId = entry.id;
    const entryWatchedAt = entry.watchedAt;
    setWatchHistory(prev => {
      const updated = prev.map(e =>
        e.id === entryId && e.watchedAt === entryWatchedAt ? { ...e, rated: null } : e
      );
      if (consent) safeSet('streaming-history', JSON.stringify(updated));
      return updated;
    });
    trackHistoryItemRated({ tmdbId: entryId, rating: 'cleared', source: 'row' });
  };

  // "More like this" (spec §4.6) — seeds the result card with a TMDB
  // recommendation for `entry` instead of running a fresh discover query.
  // Mirrors the tail end of pickContent()'s success path (result, chips,
  // pick count, recent-picks dedupe) so the card behind the sheet renders
  // identically to an organic pick. Falls back to a normal pickContent()
  // call — with a toast — when no recommendation clears the user's
  // service filter, per the spec's explicit empty-state instruction.
  const handleMoreLikeThis = async (entry) => {
    setOpenRowMenu(null);
    setShowHistory(false);
    setLoading(true);
    setResult(null);
    setPickChips([]);
    setFetchError(false);
    setFetchErrorType(null);

    const myGen = ++pickGenerationRef.current;
    const isCurrent = () => myGen === pickGenerationRef.current;

    let similar = [];
    try {
      similar = await tmdbService.getSimilarTitles(
        entry.id,
        entry.type === 'Movie' ? 'movie' : 'tv',
        selectedServices
      );
    } catch (e) {
      console.error('getSimilarTitles failed:', e);
    }
    if (!isCurrent()) return;

    trackMoreLikeThisTapped({ seedTmdbId: entry.id, resultFound: similar.length > 0 });

    if (similar.length === 0) {
      setLoading(false);
      setShowNoSimilarToast(true);
      setTimeout(() => setShowNoSimilarToast(false), 2800);
      await pickContent();
      return;
    }

    const picked = similar[Math.floor(Math.random() * similar.length)];
    setResult(picked);
    setPickChips([
      { key: 'more-like-this', icon: '✨', label: `Because you watched ${entry.title}`, kind: 'solo' },
    ]);
    setMatchCount(similar.length);
    setPickCount(prev => {
      const next = prev + 1;
      try { localStorage.setItem('settle_pick_count', String(next)); } catch {}
      return next;
    });
    setRecentPicks(prev => {
      const updated = [...prev.filter(id => id !== picked.id), picked.id].slice(-100);
      if (consent) safeSet('streaming-seen', JSON.stringify(updated));
      return updated;
    });
    setLoading(false);
    setHasSearched(true);
  };

  // ── Watch loop handlers ───────────────────────────────────────────────────

  // Step 1 confirmed — they watched it. Advance to the rating step.
  const handleWatchConfirm = () => {
    setWatchLoopStep('rate');
  };

  // "Not yet — ask tomorrow." Set a global 24h snooze and close the popup
  // WITHOUT rating the entry, so it re-surfaces on the next open after the
  // snooze expires.
  const handleWatchSnooze = () => {
    try {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      localStorage.setItem('settle_watchloop_snooze', tomorrow);
    } catch {}
    setRatingPopup(null);
    setWatchLoopStep(null);
  };

  // "We/I skipped it." Permanent dismiss — marks rated: 'skip' so it never
  // re-surfaces. Does NOT feed the taste model (they didn't form a view).
  const handleWatchSkip = () => {
    handleVote('skip');
    // handleVote already calls setRatingPopup(null) and setWatchLoopStep(null)
  };

  // Clears watch history AND resets the taste profile — the confirmation
  // copy (spec §4.4) explicitly tells the user both happen, so both must
  // actually happen; leaving stale taste-profile weight from now-invisible
  // ratings behind would make the copy inaccurate.
  const clearHistory = () => {
    const itemCount = watchHistory.length;
    setWatchHistory([]);
    setTasteProfile({ solo: {}, p1: {}, p2: {} });
    try {
      localStorage.removeItem('streaming-history');
      localStorage.removeItem('streaming-taste-profile');
    } catch {}
    // Authoritative overwrite — bypass the additive merge so a concurrent tab
    // can't resurrect the entries we just deleted.
    flushAuthoritativeSync({ watchHistory: [], tasteProfile: { solo: {}, p1: {}, p2: {} } });
    trackHistoryCleared({ itemCount });
  };

  const clearSaved = () => {
    const itemCount = savedForLater.length;
    setSavedForLater([]);
    try { localStorage.removeItem('settle-saved'); } catch {}
    // Authoritative overwrite (see clearHistory for rationale).
    flushAuthoritativeSync({ savedForLater: [] });
    trackHistoryCleared({ itemCount });
  };

  // Helper: cancels any pending debounced merge push and immediately pushes
  // the current state to Firestore using authoritative semantics (cloud arrays
  // are replaced, not unioned). Used by destructive ops — clear history,
  // remove saved picks — so concurrent tabs can't resurrect deleted entries.
  const flushAuthoritativeSync = (overrides = {}) => {
    if (!user || !consent) return;
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    pushUserDataAuthoritative(user.uid, buildPayload({
      tasteProfile, recentPicks, savedForLater, watchHistory, playerNames, consent,
      mode, selectedServices, selectedGenres, selectedFormats, minRating,
      maxCertification,
      displayName: user.displayName || user.email?.split('@')[0] || '',
      ...overrides,
    }));
  };

  const formatWatchedDate = (iso) => {
    if (!iso) return '';
    const date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    const today = new Date();
    const diff = Math.floor((today - date) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return `${diff} days ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const starsFromRating = (rating) => {
    const full = Math.min(5, Math.max(0, Math.round((parseFloat(rating) || 0) / 2)));
    return '★'.repeat(full) + '☆'.repeat(5 - full);
  };

  // Format runtime for the pick-card metadata row (P2.2):
  //   movies → "1h 42min"  /  "45min"  /  "2h"
  //   series → "8 episodes · ~45 min/ep"  /  "8 episodes"  /  "~45 min/ep"
  // Returns null if neither dataset is available — the meta line skips it.
  const formatRuntimePiece = (type, info) => {
    if (!info) return null;
    if (type === 'Movie') {
      const r = info.runtimeMin;
      if (!Number.isFinite(r) || r <= 0) return null;
      const h = Math.floor(r / 60);
      const m = r % 60;
      if (h === 0) return `${m}min`;
      if (m === 0) return `${h}h`;
      return `${h}h ${m}min`;
    }
    const bits = [];
    if (Number.isFinite(info.episodes) && info.episodes > 0) {
      bits.push(`${info.episodes} episode${info.episodes === 1 ? '' : 's'}`);
    }
    if (Number.isFinite(info.avgEpisodeMin) && info.avgEpisodeMin > 0) {
      bits.push(`~${info.avgEpisodeMin} min/ep`);
    }
    return bits.length > 0 ? bits.join(' · ') : null;
  };

  // End-time for movies only (spec §2.4) — "now + runtime", rounded UP to the
  // next 5 minutes, locale-aware 12/24h via toLocaleTimeString. Series omit
  // this entirely (per-episode runtime makes an end-time ambiguous — binge
  // vs. one episode). `metaTick` (below) forces this to recompute every 60s
  // so a card left open doesn't freeze on a stale end-time from fetch time.
  const formatEndTime = (runtimeMin) => {
    if (!Number.isFinite(runtimeMin) || runtimeMin <= 0) return null;
    const FIVE_MIN_MS = 5 * 60000;
    const endMs = Date.now() + runtimeMin * 60000;
    const rounded = Math.ceil(endMs / FIVE_MIN_MS) * FIVE_MIN_MS;
    return new Date(rounded).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  };

  // Builds the unified meta line per PM spec 2.2, updated per the result-card
  // handoff spec §2.4/§4.3:
  //   "2023 · Movie · 1h 42min · ends by 11:55 PM · TMDB 8.2"
  //   "2023 · Series · 8 episodes · ~45 min/ep · TMDB 8.2"
  // Pieces fall off gracefully if their data isn't loaded yet. The score
  // reads as plain "TMDB {n}" text rather than a star glyph — the star is
  // reserved for the user's own rating elsewhere (History row), not TMDB's.
  const formatMetaLine = (item, info) => {
    const parts = [];
    if (item.year)  parts.push(item.year);
    if (item.type)  parts.push(item.type);
    const runtimePiece = formatRuntimePiece(item.type, info);
    if (runtimePiece) parts.push(runtimePiece);
    if (item.type === 'Movie') {
      const endTime = formatEndTime(info?.runtimeMin);
      if (endTime) parts.push(`ends by ${endTime}`);
    }
    if (Number.isFinite(parseFloat(item.rating)) && item.rating > 0) {
      parts.push(`TMDB ${item.rating}`);
    }
    return parts.join(' · ');
  };

  const getServiceColor = (serviceName) => {
    if (serviceName === 'In Theaters') return '#EF9F27';
    return serviceByName.get(serviceName)?.color || '#888';
  };

  const getGenreClass = (genreId, player) => {
    if (mode === 'solo') {
      return (selectedGenres.solo || []).includes(genreId) ? 'solo-on' : '';
    }
    if (mode === 'theater') {
      return (selectedGenres.theater || []).includes(genreId) ? 'solo-on' : '';
    }
    
    const p1Has = selectedGenres.p1.includes(genreId);
    const p2Has = selectedGenres.p2.includes(genreId);
    
    if (player === 'p1') {
      if (p1Has && p2Has) return 'bothon';
      if (p1Has) return 'p1on';
    } else {
      if (p1Has && p2Has) return 'bothon';
      if (p2Has) return 'p2on';
    }
    
    return '';
  };

  // ── Auth guards ────────────────────────────────────────────────────────────
  if (user === undefined) {
    // Firebase auth is still initialising — show the branded loading screen
    return (
      <div className="authgate">
        <div className="authgate-brand">
          <BrandLogo className="authgate-logo" height={30} />
        </div>
        <div className="authgate-spinner" aria-label="Loading…" />
      </div>
    );
  }
  if (!user) return <AuthGate />;

  // The filter sections (Format/Rating/Content Rating/Services) and the
  // sticky CTA bar only render where there's an active pick-form to submit —
  // not in theater mode, not while a couple session already has the picker
  // running automatically, and — now that Couples has a fork — not on the
  // fork screen or the live-flow compose/sent screens (spec §3.1: solo
  // always, couples quick-pick only).
  const showPickForm = !coupleSession && mode !== 'theater' && (mode !== 'couple' || coupleFlow === 'quick');

  // Toast collision avoidance (spec §2.3) — all three page-level toasts share
  // this class so none of them land on top of the sticky CTA bar or a
  // full-screen modal's own action row.
  const toastPositionClass =
    (cinemaMode || showShareModal) ? ' toast-above-modal'
    : showPickForm                 ? ' toast-above-cta'
    : '';

  return (
    <div className={`app${showPickForm ? ' app-cta-padded' : ''}`}>
      {/* Skip link — visually hidden until focused. Lets keyboard users
          bypass the account bar + mode tabs and jump to the pick form. */}
      <a href="#main-content" className="skip-link">Skip to main content</a>

      {/* Account bar — sticky nav (Netflix-style). Transparent at rest;
          frosted-glass once the user scrolls past 10 px. Sign-out lives
          inside Settings next to the account name.
          inert + aria-hidden while the confirmation modal is open (spec §2.2)
          — useFocusTrap only cycles Tab focus, it doesn't stop a screen
          reader's swipe/rotor navigation from reaching content behind the
          modal, which inert does natively. */}
      <div
        className={`account-bar${navScrolled ? ' scrolled' : ''}`}
        inert={cinemaMode || undefined}
        aria-hidden={cinemaMode || undefined}
      >
        <img className="account-brand" src={settleWordmark} alt="Settle" draggable="false" />
        <div className="account-bar-right">
          {streakInfo ? (
            <button
              type="button"
              className="account-stat account-streak"
              onClick={() => setShowStreakHistory(true)}
              title={`${streakInfo}-night streak — tap for details`}
              aria-label={`${streakInfo}-night streak. Open streak history.`}
            >
              <span aria-hidden="true">🔥</span> {streakInfo}
            </button>
          ) : null}
          <button
            className="account-stat"
            onClick={() => { setShowHistory(true); setHistoryTab('watched'); }}
            title="Watch history"
            aria-label={
              watchHistory.length > 0
                ? `Watch history — ${watchHistory.length} watched`
                : 'Watch history'
            }
          >
            <span aria-hidden="true">🕐</span>
            {watchHistory.length > 0 ? ` ${watchHistory.length}` : ''}
          </button>
          {savedForLater.length > 0 && (
            <button
              className="account-stat"
              onClick={() => { setShowHistory(true); setHistoryTab('saved'); }}
              title="Saved for later"
              aria-label={`${savedForLater.length} saved picks`}
            >
              <span aria-hidden="true">★</span> {savedForLater.length}
            </button>
          )}
          <button
            className="account-settings-btn"
            onClick={() => setShowSettings(true)}
            aria-label="Settings"
            title="Settings"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Settings modal — Privacy & Data + Preferences */}
      {showSettings && (
        <Settings
          user={user}
          consent={consent}
          playerNames={playerNames}
          pushSupported={isPushSupported()}
          pushSubscribed={pushSubscribed}
          pushBusy={pushBusy}
          partnerLinkSlot={user && (
            <CoupleLink
              partnerName={partnerName}
              onGenerateCode={handleGenerateCode}
              onVerifyCode={handleVerifyCode}
              onUnlink={handleUnlinkPartner}
            />
          )}
          onClose={() => setShowSettings(false)}
          onSignOut={handleSignOut}
          onWithdrawConsent={handleWithdrawConsent}
          onEnableConsent={handleEnableCloudSync}
          onDeleteAccount={handleDeleteAccount}
          onSavePlayerNames={savePlayerName}
          onTogglePush={handlePushToggle}
          onShowPrivacy={() => setShowPrivacy(true)}
          onShowTerms={() => setShowTerms(true)}
        />
      )}

      {/* Couple session intro — shown when an unlinked user taps the session
          button. Explains the two-phone flow + walks them into linking. */}
      {showSessionIntro && (
        <CoupleSessionIntro
          partnerName={partnerName}
          onGenerateCode={handleGenerateCode}
          onVerifyCode={handleVerifyCode}
          onUnlink={handleUnlinkPartner}
          onStart={() => { setShowSessionIntro(false); setCoupleFlow('live'); }}
          onClose={() => setShowSessionIntro(false)}
        />
      )}

      {/* YouTube trailer overlay — full-screen iframe player. Hidden silently
          when there's no trailer available for the current pick. */}
      {showTrailer && trailer?.key && (() => {
        const item = cinemaSource === 'history' ? replayResult : result;
        return (
          <TrailerOverlay
            trailer={trailer}
            title={item?.title}
            onClose={closeTrailer}
          />
        );
      })()}

      {/* Streak history — last 7 nights with hit/miss markers (PM roadmap 1.3). */}
      {showStreakHistory && streakInfo && (
        <StreakHistory
          watchHistory={watchHistory}
          streak={streakInfo}
          onClose={() => setShowStreakHistory(false)}
        />
      )}

      {/* Live two-device secret vote — same component on both phones, driven by
          the live Firestore ballot doc. Renders for the initiator and the
          partner alike; the view advances as votes land. */}
      {liveBallot && (
        <LiveBallot
          ballot={liveBallot}
          role={liveRole}
          onCastVote={handleCastLiveVote}
          onCastPartnerVote={handleCastPartnerVote}
          onMatch={handleLiveMatch}
          onRetry={handleLiveRetry}
          onClose={closeLiveBallot}
          getPosterUrl={(path, size) => tmdbService.getPosterUrl(path, size)}
          getServiceColor={(svc) => serviceByName.get(svc)?.color || '#999'}
        />
      )}

      {/* Theater Mode 2.0 — location permission modal (M2). */}
      {locationPrompt && (
        <LocationPermission
          promptType={locationPrompt}
          initialZip={getStoredZip()}
          onAllow={handleLocationAllow}
          onZip={handleLocationZip}
          onDismiss={handleLocationDismiss}
        />
      )}

      {/* Showtimes sheet — opens when the user taps a film in the "In Theaters"
          browse grid (after the location gate). Shows nearest theaters +
          today's showtimes for the picked movie, with in-app ticket checkout. */}
      {showShowtimes && theaterMovie && (
        <ShowtimesSheet
          result={theaterMovie}
          userLocation={userLocation}
          onClose={() => { setShowShowtimes(false); setTheaterMovie(null); }}
          onLocationChange={handleLocationChange}
          onBuyIntent={() => {
            // A showtime tap is the strongest intent signal in the app. Record
            // it in watch history so the film feeds the rate → taste-profile
            // loop and the next-day "how was it?" push — the same retention
            // loop streaming picks already get.
            trackDeepLinkOpened({
              service: 'In Theaters',
              titleId: theaterMovie.id,
              mode,
              surface: 'showtimes_sheet',
            });
            saveToHistory(theaterMovie);
          }}
        />
      )}

      {/* Push notifications opt-in (PM roadmap 3.1). Appears after the user
          has generated 3 successful picks, only on push-supported devices,
          only if they granted storage consent. One-shot — dismissing or
          accepting both hide it permanently (user can re-enable in Settings). */}
      {shouldShowOptIn && (
        <PushOptIn
          onAccept={handlePushAccept}
          onDismiss={handlePushDismiss}
          busy={pushBusy}
        />
      )}

      {/* Per-mode retention nudges — at most ONE card shows at a time so the
          home screen never stacks banners. Priority: a film the user (or
          their partner) explicitly saved beats the generic new-releases
          count, because it's a concrete "watch tonight" candidate. */}
      {(() => {
        // Solo: resurface the most recent saved pick — but not one saved
        // today, which would just echo what the user did moments ago.
        const savedCandidate = savedForLater[0];
        const savedNudgeVisible =
          mode === 'solo' && !savedNudgeDismissed && !!savedCandidate &&
          (!savedCandidate.savedAt ||
            savedCandidate.savedAt.slice(0, 10) !== new Date().toISOString().slice(0, 10));

        // Couples: surface the partner's most recent saved pick — a built-in
        // "watch together tonight" suggestion neither person has to make.
        const partnerCandidate = partnerSaved[0];
        const coupleNudgeVisible =
          mode === 'couple' && !coupleNudgeDismissed && !!partnerUid && !!partnerCandidate;

        if (savedNudgeVisible) {
          return (
            <NudgeCard
              posterPath={savedCandidate.posterPath}
              icon="★"
              headline={`You saved ${savedCandidate.title}`}
              sub="Watch it tonight?"
              ctaAriaLabel={`Open your saved pick ${savedCandidate.title}`}
              onTap={() => handleHistoryReplay(savedCandidate)}
              onDismiss={() => dismissForToday('settle_savednudge_dismissed', setSavedNudgeDismissed)}
            />
          );
        }
        if (coupleNudgeVisible) {
          return (
            <NudgeCard
              posterPath={partnerCandidate.posterPath}
              icon="💑"
              headline={`${(partnerName || 'Your partner').split(' ')[0]} saved ${partnerCandidate.title}`}
              sub="Watch it together tonight?"
              ctaAriaLabel={`Open ${partnerCandidate.title}, saved by ${partnerName || 'your partner'}`}
              onTap={() => handleHistoryReplay(partnerCandidate)}
              onDismiss={() => dismissForToday('settle_couplenudge_dismissed', setCoupleNudgeDismissed)}
            />
          );
        }
        // "New in your genres" home card (PM roadmap 3.2). Solo mode only;
        // hidden silently when there's nothing new or the user dismissed it
        // today. Tap → seed top genres + fire a fresh pick.
        if (mode === 'solo' && newReleasesCount > 0 && !newReleasesDismissed) {
          return (
            <NewReleasesCard
              count={newReleasesCount}
              genreNames={(topGenresByPlayer.solo || []).map(g => g.name)}
              onTap={handleNewReleasesTap}
              onDismiss={handleNewReleasesDismiss}
            />
          );
        }
        return null;
      })()}

      <div id="main-content" className="mode-tabs" role="group" aria-label="Mode" tabIndex={-1}>
        <button
          className={`mtab ${mode === 'solo' ? 'on' : ''}`}
          onClick={() => { trackModeSelected({ mode: 'solo' }); setMode('solo'); setResult(null); setHasSearched(false); setFetchError(false); setMatchCount(0); }}
          aria-pressed={mode === 'solo'}
        >
          Solo <span aria-hidden="true">👤</span>
        </button>
        <button
          className={`mtab ${mode === 'couple' ? 'on' : ''}`}
          onClick={() => { trackModeSelected({ mode: 'couple' }); setMode('couple'); setActivePlayer('p1'); setResult(null); setHasSearched(false); setFetchError(false); setMatchCount(0); }}
          aria-pressed={mode === 'couple'}
        >
          Couples <span aria-hidden="true">💑</span>
        </button>
        <button
          className={`mtab ${mode === 'theater' ? 'on theater-tab' : ''}`}
          onClick={() => { trackModeSelected({ mode: 'theater' }); setMode('theater'); setResult(null); setHasSearched(false); setFetchError(false); setMatchCount(0); }}
          aria-pressed={mode === 'theater'}
        >
          In Theaters <span aria-hidden="true">🎟️</span>
        </button>
      </div>

      {/* Solo context banner (spec §3.8) — reflects the current mood picks
          back at the user so the configuration reads at a glance even before
          scrolling to the grid. Solo only; Couples gets its own progress
          banner in the quick-pick flow. */}
      {mode === 'solo' && (() => {
        const activeMoods = MOODS.filter(m => isMoodActive(m.ids, 'solo'));
        const shown = activeMoods.slice(0, 6);
        const extra = activeMoods.length - shown.length;
        return (
          <div className="solo-context-banner" aria-live="polite">
            {activeMoods.length === 0
              ? 'Pick a mood or two — recs sharpen with each one ✨'
              : <>Tonight's read: {shown.map(m => m.emoji).join(' ')}{extra > 0 ? ` +${extra}` : ''} — nice combo</>}
          </div>
        );
      })()}

      {welcomeBack && (
        <div className="welcome-back" role="status">
          <span aria-hidden="true">↩ </span>Preferences restored from your last session
        </div>
      )}

      {mode === 'solo' && (() => {
        // Solo mode uses its own genre slot so selections never cross-contaminate.
        const moodPlayer = 'solo';
        const activeSlot = selectedGenres[moodPlayer] || [];
        const genreListId = `${moodPlayer}-genre-list`;
        return (
          <div className="section">
            <div className="mood-section-label" id="mood-greeting-label">
              What's the vibe?
            </div>
            <div className="mood-grid" role="group" aria-labelledby="mood-greeting-label">
              {MOODS.slice(0, 8).map(mood => (
                <button
                  key={mood.label}
                  className={`mood-btn ${isMoodActive(mood.ids, moodPlayer) ? 'mood-on' : ''}`}
                  onClick={() => handleMoodClick(mood.ids, moodPlayer)}
                  aria-pressed={isMoodActive(mood.ids, moodPlayer)}
                >
                  <span className="mood-emoji" aria-hidden="true">{mood.emoji}</span>
                  <span className="mood-label">{mood.label}</span>
                </button>
              ))}
            </div>
            <div className="era-divider" role="separator">
              <span className="era-divider-label">Era</span>
            </div>
            <div className="mood-grid mood-grid-era" role="group" aria-label="Decades">
              {MOODS.slice(8).map(mood => (
                <button
                  key={mood.label}
                  className={`mood-btn ${isMoodActive(mood.ids, moodPlayer) ? 'mood-on' : ''}`}
                  onClick={() => handleMoodClick(mood.ids, moodPlayer)}
                  aria-pressed={isMoodActive(mood.ids, moodPlayer)}
                >
                  <span className="mood-emoji" aria-hidden="true">{mood.emoji}</span>
                  <span className="mood-label">{mood.label}</span>
                </button>
              ))}
            </div>
            <button
              className="show-genres-toggle"
              onClick={() => setShowAllGenres(prev => !prev)}
              aria-expanded={showAllGenres}
              aria-controls={genreListId}
            >
              {showAllGenres ? '▲ Hide genres' : '＋ More genres'}
            </button>
            {showAllGenres && (
              <div className="chip-grid genre-expand" id={genreListId} role="group" aria-label="Genres">
                {genreError && genres.length === 0 ? (
                  <div className="genre-error" role="alert">
                    <span>Couldn't load genres.</span>
                    <button
                      className="genre-error-retry"
                      onClick={() => { setGenreError(false); loadGenres(); }}
                    >
                      Retry
                    </button>
                  </div>
                ) : genres.map(genre => {
                  const active = activeSlot.includes(genre.id);
                  // Mood-driven indicator (May 2026 Mood Swap spec, Step 3,
                  // Option A): if this genre ID is part of a currently-active
                  // mood, surface a subtle gold border so the user understands
                  // why it's selected. Toggling the chip still works the same.
                  const moodDriven = active && MOODS.some(m =>
                    isMoodActive(m.ids, moodPlayer) && m.ids.includes(genre.id)
                  );
                  return (
                    <button
                      type="button"
                      key={genre.id}
                      className={`chip ${getGenreClass(genre.id, moodPlayer)} ${moodDriven ? 'mood-driven' : ''}`}
                      onClick={() => handleGenreClick(genre.id, moodPlayer)}
                      aria-pressed={active}
                    >
                      {genre.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      {mode === 'couple' && (() => {
        const partnerFirstName = (partnerName || 'your partner').split(' ')[0];
        return (
        <>
          {/* Streak banner — visible on home screen for returning couples */}
          {streakInfo ? (
              <div className="couple-streak-banner" role="status" aria-live="polite">
                <span aria-hidden="true">🔥</span>
                <span>
                  {streakInfo}-night streak{streakInfo >= 5 ? ' — you two are on fire' : ' — keep it going'}
                </span>
              </div>
            ) : null}

          {coupleSession && coupleSession.status === 'selecting' ? (
            <CoupleSessionSelect
              session={coupleSession}
              role={sessionRole}
              partnerName={partnerName}
              moods={MOODS}
              genres={genres}
              selectedIds={selectedGenres.session || []}
              isMoodActive={(ids) => isMoodActive(ids, 'session')}
              getGenreClass={(id) => getGenreClass(id, 'session')}
              onToggleMood={(ids) => handleMoodClick(ids, 'session')}
              onToggleGenre={(id) => handleGenreClick(id, 'session')}
              showAllGenres={showAllGenres}
              onToggleShowGenres={() => setShowAllGenres(p => !p)}
              onReady={handleSessionReady}
              onUnready={handleSessionUnready}
              onCancel={handleCancelSession}
            />
          ) : coupleSession && coupleSession.status === 'result' ? (
            <div className="csess-resultbar">
              <span><span aria-hidden="true">🎬</span> Couple pick with {(partnerName || 'your partner').split(' ')[0]}</span>
              <button className="csess-cancel" onClick={handleCancelSession}>End session</button>
            </div>
          ) : coupleFlow === null ? (
            // Fork screen (spec §4.1) — two explicit paths instead of one
            // hybrid screen. A fresh session always lands here; picking a
            // path persists (in-memory) for the rest of the session.
            <div className="couple-fork">
              <button
                type="button"
                className="fork-card fork-card-live"
                onClick={() => {
                  trackCoupleFlowSelected({ flow: 'live' });
                  partnerUid ? setCoupleFlow('live') : setShowSessionIntro(true);
                }}
              >
                <span className="fork-card-icon" aria-hidden="true">💑</span>
                <span className="fork-card-title">Pick together — live</span>
                <span className="fork-card-sub">Each of you picks on your own phone. We find the overlap.</span>
                <span className="fork-card-link">Send ballot →</span>
              </button>
              <button
                type="button"
                className="fork-card fork-card-quick"
                onClick={() => { trackCoupleFlowSelected({ flow: 'quick' }); setCoupleFlow('quick'); }}
              >
                <span className="fork-card-icon" aria-hidden="true">📱</span>
                <span className="fork-card-title">Quick pick on this phone</span>
                <span className="fork-card-sub">Partner's not around? Enter both sets of moods here.</span>
              </button>
            </div>
          ) : coupleFlow === 'live' ? (
            // Live-flow compose step (spec §4.2.1) — moods are chosen here,
            // BEFORE the Firestore session doc exists. Sending creates the
            // session and submits these moods as the initiator's lock-in in
            // one action (handleSendLiveBallot).
            <div className="live-compose">
              <button type="button" className="couple-back-btn" onClick={() => setCoupleFlow(null)}>
                <span aria-hidden="true">←</span> Back
              </button>
              <div className="live-compose-card">
                <span className="live-compose-icon" aria-hidden="true">💌</span>
                <div className="live-compose-title">Pick your moods below, then send</div>
                <p className="live-compose-body">
                  {partnerFirstName} gets a push notification and picks on their phone. Results stay secret until you both finish.
                </p>
              </div>
              <div className="couple-genre-panel p1-panel">
                <div className="mood-grid" role="group" aria-label="Your moods">
                  {MOODS.slice(0, 8).map(mood => (
                    <button
                      key={mood.label}
                      className={`mood-btn ${isMoodActive(mood.ids, 'live') ? 'mood-on' : ''}`}
                      onClick={() => handleMoodClick(mood.ids, 'live')}
                      aria-pressed={isMoodActive(mood.ids, 'live')}
                    >
                      <span className="mood-emoji" aria-hidden="true">{mood.emoji}</span>
                      <span className="mood-label">{mood.label}</span>
                    </button>
                  ))}
                </div>
                <div className="era-divider" role="separator">
                  <span className="era-divider-label">Era</span>
                </div>
                <div className="mood-grid mood-grid-era" role="group" aria-label="Decades">
                  {MOODS.slice(8).map(mood => (
                    <button
                      key={mood.label}
                      className={`mood-btn ${isMoodActive(mood.ids, 'live') ? 'mood-on' : ''}`}
                      onClick={() => handleMoodClick(mood.ids, 'live')}
                      aria-pressed={isMoodActive(mood.ids, 'live')}
                    >
                      <span className="mood-emoji" aria-hidden="true">{mood.emoji}</span>
                      <span className="mood-label">{mood.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <button
                type="button"
                className="live-send-btn"
                onClick={handleSendLiveBallot}
                disabled={(selectedGenres.live || []).length === 0}
              >
                Send ballot to {partnerFirstName} →
              </button>
              {sessionError && (
                <p className="start-session-error start-session-error-shake" role="alert">{sessionError}</p>
              )}
            </div>
          ) : (
          <>
          {/* Quick pick — same-device tabs (spec §4.3) */}
          <button type="button" className="couple-back-btn" onClick={() => setCoupleFlow(null)}>
            <span aria-hidden="true">←</span> Back
          </button>

          {/* Progress banner — no percentage anywhere (spec §8.4 acceptance
              criterion). Three states: nobody's picked, picked but no overlap
              yet, or N shared vibes with their emojis. */}
          {(() => {
            const p1Count = selectedGenres.p1.length;
            const p2Count = selectedGenres.p2.length;
            const sharedMoods = MOODS.filter(m => isMoodActive(m.ids, 'p1') && isMoodActive(m.ids, 'p2'));
            if (sharedMoods.length > 0) {
              return (
                <div className="couple-progress-banner couple-progress-shared" role="status" aria-live="polite">
                  <span className="couple-progress-headline">
                    <span aria-hidden="true">🎯</span> {sharedMoods.length} shared vibe{sharedMoods.length === 1 ? '' : 's'}
                  </span>
                  <span className="couple-progress-emojis" aria-hidden="true">
                    {sharedMoods.map(m => m.emoji).join(' ')}
                  </span>
                </div>
              );
            }
            if (p1Count === 0 && p2Count === 0) {
              return (
                <div className="couple-progress-banner" role="status" aria-live="polite">
                  <span aria-hidden="true">✨</span> Pick a few moods each — we'll find your overlap
                </div>
              );
            }
            return (
              <div className="couple-progress-banner" role="status" aria-live="polite">
                <span aria-hidden="true">🔍</span> {playerNames.p1}: {p1Count} · {playerNames.p2}: {p2Count} — overlap shows here
              </div>
            );
          })()}

          {/* Player tab switcher */}
          <div className="player-tabs" role="tablist" aria-label="Player">
            <div className={`player-tab p1-tab ${activePlayer === 'p1' ? 'active' : ''}`}>
              <button
                type="button"
                className="player-tab-select"
                onClick={() => setActivePlayer('p1')}
                role="tab"
                aria-selected={activePlayer === 'p1'}
                aria-label={`${playerNames.p1}, ${selectedGenres.p1.length} picks`}
              >
                <span className="player-tab-emoji" aria-hidden="true">🍿</span>
                {editingPlayer === 'p1' ? null : (
                  <span className="player-name">{playerNames.p1}</span>
                )}
                {selectedGenres.p1.length > 0 && (
                  <span className="player-tab-count" aria-label={`${selectedGenres.p1.length} genres selected`}>
                    {selectedGenres.p1.length}
                  </span>
                )}
              </button>
              {editingPlayer === 'p1' ? (
                <input
                  className="player-name-input"
                  defaultValue={playerNames.p1}
                  autoFocus
                  maxLength={16}
                  aria-label="Player 1 name"
                  onBlur={e => savePlayerName('p1', e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && savePlayerName('p1', e.target.value)}
                />
              ) : (
                <button
                  type="button"
                  className="player-tab-edit"
                  onClick={() => setEditingPlayer('p1')}
                  aria-label={`Edit name for ${playerNames.p1}`}
                >
                  <span className="edit-hint" aria-hidden="true">✎</span>
                </button>
              )}
            </div>

            <div className={`player-tab p2-tab ${activePlayer === 'p2' ? 'active' : ''}`}>
              <button
                type="button"
                className="player-tab-select"
                onClick={() => setActivePlayer('p2')}
                role="tab"
                aria-selected={activePlayer === 'p2'}
                aria-label={`${playerNames.p2}, ${selectedGenres.p2.length} picks`}
              >
                <span className="player-tab-emoji" aria-hidden="true">🎬</span>
                {editingPlayer === 'p2' ? null : (
                  <span className="player-name">{playerNames.p2}</span>
                )}
                {selectedGenres.p2.length > 0 && (
                  <span className="player-tab-count" aria-label={`${selectedGenres.p2.length} genres selected`}>
                    {selectedGenres.p2.length}
                  </span>
                )}
              </button>
              {editingPlayer === 'p2' ? (
                <input
                  className="player-name-input"
                  defaultValue={playerNames.p2}
                  autoFocus
                  maxLength={16}
                  aria-label="Player 2 name"
                  onBlur={e => savePlayerName('p2', e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && savePlayerName('p2', e.target.value)}
                />
              ) : (
                <button
                  type="button"
                  className="player-tab-edit"
                  onClick={() => setEditingPlayer('p2')}
                  aria-label={`Edit name for ${playerNames.p2}`}
                >
                  <span className="edit-hint" aria-hidden="true">✎</span>
                </button>
              )}
            </div>
          </div>

          {/* Active player mood + genre grid */}
          <div className={`couple-genre-panel ${activePlayer === 'p1' ? 'p1-panel' : 'p2-panel'}`}>
            <div className={`picking-for-header picking-for-${activePlayer}`}>
              Picking for: {activePlayer === 'p1' ? playerNames.p1 : playerNames.p2}{' '}
              <span aria-hidden="true">{activePlayer === 'p1' ? '🍿' : '🎬'}</span>
            </div>
            <div className="mood-grid" role="group" aria-label={`Moods for ${activePlayer === 'p1' ? playerNames.p1 : playerNames.p2}`}>
              {MOODS.slice(0, 8).map(mood => (
                <button
                  key={mood.label}
                  className={`mood-btn ${isMoodActive(mood.ids, activePlayer) ? 'mood-on' : ''}`}
                  onClick={() => handleMoodClick(mood.ids, activePlayer)}
                  aria-pressed={isMoodActive(mood.ids, activePlayer)}
                >
                  <span className="mood-emoji" aria-hidden="true">{mood.emoji}</span>
                  <span className="mood-label">{mood.label}</span>
                </button>
              ))}
            </div>
            <div className="era-divider" role="separator">
              <span className="era-divider-label">Era</span>
            </div>
            <div className="mood-grid mood-grid-era" role="group" aria-label="Decades">
              {MOODS.slice(8).map(mood => (
                <button
                  key={mood.label}
                  className={`mood-btn ${isMoodActive(mood.ids, activePlayer) ? 'mood-on' : ''}`}
                  onClick={() => handleMoodClick(mood.ids, activePlayer)}
                  aria-pressed={isMoodActive(mood.ids, activePlayer)}
                >
                  <span className="mood-emoji" aria-hidden="true">{mood.emoji}</span>
                  <span className="mood-label">{mood.label}</span>
                </button>
              ))}
            </div>
            <button
              className="show-genres-toggle"
              onClick={() => setShowAllGenres(prev => !prev)}
              aria-expanded={showAllGenres}
              aria-controls="couple-genre-list"
            >
              {showAllGenres ? '▲ Hide genres' : '＋ More genres'}
            </button>
            {showAllGenres && (
              <div className="chip-grid genre-expand" id="couple-genre-list" role="group" aria-label="Genres">
                {genres.map(genre => {
                  const active = selectedGenres[activePlayer]?.includes(genre.id);
                  // Mood-driven indicator (Mood Swap spec, Step 3, Option A)
                  const moodDriven = active && MOODS.some(m =>
                    isMoodActive(m.ids, activePlayer) && m.ids.includes(genre.id)
                  );
                  return (
                    <button
                      type="button"
                      key={genre.id}
                      className={`chip ${getGenreClass(genre.id, activePlayer)} ${moodDriven ? 'mood-driven' : ''}`}
                      onClick={() => handleGenreClick(genre.id, activePlayer)}
                      aria-pressed={active}
                    >
                      {genre.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Shared zone */}
          {overlapGenres.length > 0 && (
            <div className="shared-zone">
              <div className="shared-zone-label">Both want</div>
              <div className="shared-chips">
                {overlapGenres.map(id => {
                  const genre = genreById.get(id);
                  return genre && (
                    <span key={id} className="shared-chip">{genre.name}</span>
                  );
                })}
              </div>
            </div>
          )}

          </>
          )}
        </>
        );
      })()}

      {/* In Theaters — generic browse-first grid. People heading to the cinema
          already know what they want, so this skips the decision engine: every
          film now playing, tap a poster → showtimes + in-app tickets. */}
      {mode === 'theater' && (
        <InTheaters
          onPickMovie={handleTheaterMoviePick}
          userLocation={userLocation}
          defaultZip={getStoredZip()}
          onSetLocation={handleLocationChange}
        />
      )}

      {showPickForm && (
      <div className="row2">
        <div className="fcard">
          <div className="label" id="format-label">Format</div>
          <div className="tog-row" role="group" aria-labelledby="format-label">
            {['Movie', 'Series'].map(format => {
              const active = selectedFormats.includes(format);
              return (
                <button
                  type="button"
                  key={format}
                  className={`tog ${active ? 'on' : ''}`}
                  onClick={() => toggleFormat(format)}
                  aria-pressed={active}
                >
                  {format}
                </button>
              );
            })}
          </div>
        </div>
        <div className="fcard">
          <div className="label" id="rating-label">Min Rating</div>
          <div className="rating-row" role="radiogroup" aria-labelledby="rating-label">
            {RATING_STEPS.map(step => {
              const active = minRating === step.value;
              return (
                <button
                  type="button"
                  key={step.label}
                  className={`rating-chip ${active ? 'rating-on' : ''}`}
                  onClick={() => { trackRatingStepSelected({ value: step.value }); setMinRating(step.value); }}
                  role="radio"
                  aria-checked={active}
                >
                  {step.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      )}

      {showPickForm && (
        <div className="section">
          <div className="label" id="cert-label">Content Rating</div>
          <div className="cert-row" role="radiogroup" aria-labelledby="cert-label">
            {[
              { label: 'All', value: null, aria: 'All' },
              { label: '🧒 Family', value: 'PG', aria: 'Family' },
              { label: 'Teen', value: 'PG-13', aria: 'Teen' },
              { label: 'Mature', value: 'R', aria: 'Mature' }
            ].map(opt => {
              const active = maxCertification === opt.value;
              return (
                <button
                  type="button"
                  key={opt.label}
                  className={`cert-chip ${active ? 'cert-on' : ''}`}
                  onClick={() => setMaxCertification(opt.value)}
                  role="radio"
                  aria-checked={active}
                  aria-label={opt.aria}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Runtime filter removed in P2.2 — users now see runtime on the pick
          card metadata row and decide in context, not pre-filter. */}

      {showPickForm && (
        <div className="section">
          <div className="label" id="services-label">Your Services</div>
          {/* Horizontal scroll, never wraps — fixes the orphaned last pill
              (e.g. Max) on narrow screens. Right-edge fade is a visual
              affordance that more content exists off-screen. */}
          <div className="services-scroll-wrap">
            <div className="chip-grid services-row" role="group" aria-labelledby="services-label">
              {SERVICES.map(service => {
                const active = selectedServices.includes(service.name);
                return (
                  <button
                    type="button"
                    key={service.name}
                    className={`chip ${active ? 'svc-on' : ''}`}
                    onClick={() => toggleService(service.name)}
                    aria-pressed={active}
                  >
                    <span className="sdot" style={{ background: service.color }} aria-hidden="true" />
                    {service.name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {showPickForm && <div className="divider" />}

      {/* Note: we intentionally don't surface a "X titles available" count here.
          Users shouldn't be primed by the inventory size of their filters —
          it's both noisy and a poor proxy for whether they'll like the pick.
          `matchCount` is still tracked in state so the empty-state branch
          below can fire when the filter combo produces zero results. */}

      {/* Sticky bottom CTA — hidden during an active couple session (the pick
          is generated automatically once both partners lock in, and re-picks
          come from the shared result card's "Try another") and in theater
          mode. Reachable from any scroll position; `.app-cta-padded` above
          reserves the matching bottom space so it never covers the footer. */}
      {showPickForm && (
        <div className="cta-bar" inert={cinemaMode || undefined} aria-hidden={cinemaMode || undefined}>
          <div className="cta-bar-inner">
            <div className={`cta-bar-summary${zeroMatches ? ' cta-bar-zero' : ''}`}>
              {zeroMatches ? 'No matches — loosen a filter' : ctaSummary}
            </div>
            <div className="cta-bar-row">
              <button
                className="pick-btn"
                onClick={() => {
                  trackCtaTapped({
                    mode,
                    flow: mode === 'couple' ? coupleFlow : null,
                    vibeCount: MOODS.filter(m => isMoodActive(m.ids, mode === 'couple' ? activePlayer : 'solo')).length,
                    matchCount: liveMatchCount,
                  });
                  pickContent(false);
                }}
                disabled={loading}
              >
                {loading ? 'Finding...' : mode === 'solo' ? 'Find something for me →' : 'Find something for us →'}
              </button>
              <button
                className="hidden-gem-btn"
                onClick={() => pickContent(true)}
                disabled={loading}
                aria-label="Hidden Gem"
                title="Hidden Gem"
              >
                <span aria-hidden="true">💎</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {loading && (
        <div className="skeleton-card">
          <div className="skeleton-poster" />
          <div className="skeleton-content">
            <div className="skeleton-top">
              <div>
                <div className="skeleton-block" style={{ width: '60%', height: 18, marginBottom: 6 }} />
                <div className="skeleton-block" style={{ width: '35%', height: 11 }} />
              </div>
              <div className="skeleton-block" style={{ width: 52, height: 22, borderRadius: 8 }} />
            </div>
            <div className="skeleton-pills">
              <div className="skeleton-block" style={{ width: 56, height: 20, borderRadius: 6 }} />
              <div className="skeleton-block" style={{ width: 48, height: 20, borderRadius: 6 }} />
              <div className="skeleton-block" style={{ width: 64, height: 20, borderRadius: 6 }} />
            </div>
            <div className="skeleton-block" style={{ width: '45%', height: 13, marginBottom: 10 }} />
            <div className="skeleton-block" style={{ width: '100%', height: 11, marginBottom: 5 }} />
            <div className="skeleton-block" style={{ width: '90%', height: 11, marginBottom: 5 }} />
            <div className="skeleton-block" style={{ width: '75%', height: 11, marginBottom: 12 }} />
            <div className="skeleton-actions">
              <div className="skeleton-block" style={{ flex: 1, height: 32, borderRadius: 8 }} />
              <div className="skeleton-block" style={{ flex: 1, height: 32, borderRadius: 8 }} />
            </div>
          </div>
        </div>
      )}

      {fetchError && !loading && (
        <div className="error-card" role="alert">
          <div className="error-icon" aria-hidden="true">⚠️</div>
          <div className="error-msg">
            {fetchErrorType === 'timeout'
              ? 'Request timed out — TMDB is taking too long. Check your connection and try again.'
              : 'Couldn\'t connect. Check your connection and try again.'}
          </div>
          <button className="error-retry" onClick={() => pickContent(false)}>Try again</button>
        </div>
      )}

      {hasSearched && matchCount === 0 && !loading && !result && !fetchError && (
        <div className="nomatch" role="status">
          {noMoodSelected
            ? <><span aria-hidden="true">🎭 </span>Pick a mood above to get your recommendation.</>
            : mode !== 'theater' && selectedServices.length === 0
              ? <><span aria-hidden="true">👆 </span>Select at least one streaming service above to get started.</>
              : <div className="nomatch-empty">
                  <div className="nomatch-icon" aria-hidden="true">🎯</div>
                  <div className="nomatch-title">You've out-filtered us.</div>
                  <div className="nomatch-body">Your taste is too specific — and we respect it. Try loosening your mood, adding a service, or dropping a filter.</div>
                  <button className="nomatch-reset" onClick={() => {
                    setSelectedGenres(g => ({ ...g, [mode === 'couple' ? 'p1' : mode === 'theater' ? 'theater' : 'solo']: [] }));
                    setHasSearched(false);
                  }}>
                    Reset mood →
                  </button>
                </div>
          }
        </div>
      )}

      {result && !loading && (
        <div
          className="result show"
          inert={cinemaMode || undefined}
          aria-hidden={cinemaMode || undefined}
        >
          <div className="result-inner">
            <div className="poster-wrap">
              <div className="poster">
                {result.posterPath ? (
                  <img
                    src={tmdbService.getPosterUrl(result.posterPath)}
                    alt=""
                    onError={e => { e.currentTarget.style.display = 'none'; }}
                  />
                ) : (
                  <div
                    className="poster-placeholder"
                    style={{
                      background: `${getServiceColor(result.service)}22`,
                      color: getServiceColor(result.service)
                    }}
                    aria-hidden="true"
                  >
                    {result.service}
                  </div>
                )}
              </div>
              {collection && (
                <div className="sequel-wrap">
                  <button
                    type="button"
                    className={`sequel-badge ${showCollection ? 'open' : ''}`}
                    onClick={() => setShowCollection(prev => !prev)}
                    aria-expanded={showCollection}
                    aria-controls="sequel-list"
                  >
                    <span aria-hidden="true">🎬</span> Has sequels{' '}
                    <span aria-hidden="true">{showCollection ? '▲' : '▼'}</span>
                  </button>
                  {showCollection && (
                    <ul className="sequel-list" id="sequel-list">
                      {collection.parts.map(part => (
                        <li
                          key={part.id}
                          className={`sequel-item ${part.id === result.id ? 'current' : ''}`}
                          aria-current={part.id === result.id ? 'true' : undefined}
                        >
                          <span className="sequel-title">{part.title}</span>
                          <span className="sequel-year">{part.year}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            <div className="result-content">
              <div className="result-top">
                <div>
                  <div className="result-title">{result.title}</div>
                  {/* Unified meta line per PM spec 2.2:
                        "2023 · Movie · 1h 42min · ★ 8.2"
                        "2023 · Series · 8 episodes · ~45min each · ★ 8.2"
                      Runtime piece appears once runtimeInfo loads (pre-fetched
                      alongside the trailer + collection). Rating piece falls
                      off if missing. Votes count stays accessible to AT users
                      via the aria-label without cluttering the visual line. */}
                  <div className="result-meta-row">
                    <div
                      className="result-meta-line"
                      aria-label={`Released ${result.year}, ${result.type}, rated ${result.rating} out of 10, ${result.votes} ratings`}
                    >
                      {formatMetaLine(result, runtimeInfo)}
                    </div>
                    {/* Trailer button — small dark inline chip per PD spec 3.3.
                        Sits next to the metadata, not as a full-width CTA. */}
                    {trailer?.key && (
                      <button
                        type="button"
                        className="trailer-btn trailer-btn-card"
                        onClick={() => openTrailer('result_card')}
                        aria-label={`Watch trailer for ${result.title}`}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
                          <polygon points="6 4 20 12 6 20" />
                        </svg>
                        Trailer
                      </button>
                    )}
                  </div>
                </div>
                {result.service === 'In Theaters' ? (
                  <div className="svc-badge theater-badge">🎟️ In Theaters</div>
                ) : (
                  <div
                    className="svc-badge"
                    style={{
                      background: `${getServiceColor(result.service)}33`,
                      color: getServiceColor(result.service),
                      borderColor: `${getServiceColor(result.service)}66`,
                    }}
                  >
                    {result.service}
                  </div>
                )}
              </div>
              {/* Match-reason chips (spec §2.1) — sits directly under the
                  title/metadata, above the genre tags and synopsis. Capped
                  at 5 chips + a "+N more" pill as a lightweight stand-in for
                  literal 2-row DOM measurement — keeps the same bounded,
                  non-sprawling result without a ResizeObserver. */}
              {pickChips.length > 0 && (
                <div className="match-chips">
                  {pickChips.slice(0, 5).map(chip => (
                    <span key={chip.key} className={`match-chip match-chip-${chip.kind}`}>
                      {chip.icon && <span aria-hidden="true">{chip.icon} </span>}
                      {chip.label}
                      {chip.kind === 'service' && <span className="match-chip-check" aria-hidden="true"> ✓</span>}
                    </span>
                  ))}
                  {pickChips.length > 5 && (
                    <span className="match-chip match-chip-more">+{pickChips.length - 5} more</span>
                  )}
                </div>
              )}
              <div className="pills">
                {result.genres.slice(0, 3).map((genreId, i) => {
                  const genre = genreById.get(genreId);
                  return genre && (
                    <React.Fragment key={genreId}>
                      {i > 0 && <span className="pill-sep" aria-hidden="true"> · </span>}
                      <span className="pill">{genre.name}</span>
                    </React.Fragment>
                  );
                })}
              </div>
              {/* Theater-specific enrichment row — cert + wide/limited badge */}
              {result.service === 'In Theaters' && theaterReleaseInfo && (
                <div className="theater-meta-row">
                  <span className="cert-badge">
                    {theaterReleaseInfo.certification || 'NR'}
                  </span>
                  <span className={`release-type-badge ${theaterReleaseInfo.isWideRelease ? 'wide' : 'limited'}`}>
                    {theaterReleaseInfo.isWideRelease ? '🎬 Wide Release' : '🎞️ Limited Release'}
                  </span>
                </div>
              )}
              <div ref={descRef} className={`desc${synopsisExpanded ? ' desc-expanded' : ''}`}>
                {result.description}
              </div>
              {synopsisOverflows && (
                <button
                  type="button"
                  className="desc-toggle"
                  onClick={() => {
                    const next = !synopsisExpanded;
                    setSynopsisExpanded(next);
                    if (next) trackResultSynopsisExpanded({ tmdbId: result.id });
                  }}
                  aria-expanded={synopsisExpanded}
                >
                  {synopsisExpanded ? 'less' : 'more'}
                </button>
              )}
              <div className="act-row">
                {/* Primary — the win condition, full-width and unmistakable
                    (spec §2.5). Couples' Secret Vote is the mode's analogous
                    primary action, so it gets the same treatment. */}
                {mode === 'couple' ? (
                  <button
                    className="act-primary"
                    onClick={openBallot}
                    title={partnerUid
                      ? `Vote on this pick — it appears live on ${(partnerName || 'your partner').split(' ')[0]}'s phone`
                      : 'Both vote in secret on this device'}
                  >
                    <span aria-hidden="true">🗳️</span> Secret Vote
                  </button>
                ) : (
                  <button
                    className="act-primary"
                    onClick={() => {
                      const matchedMoods = pickChips
                        .filter(c => ['solo', 'p1', 'p2', 'shared'].includes(c.kind))
                        .map(c => c.label);
                      trackPickAccepted({ tmdbId: result.id, mode, matchedMoods, service: result.service });
                      setTryAnotherCount(0);
                      setCinemaSource('pick');
                      setCinemaMode(true);
                      saveToHistory(result);
                    }}
                  >
                    Watching this <span aria-hidden="true">✓</span>
                  </button>
                )}
                {/* Secondary — equal thirds, every control carries a visible
                    text label (spec §2.5: "no bare icons"). */}
                <div className="act-secondary-row">
                  {coupleSession ? (
                    // During a session only the initiator drives re-picks (the
                    // partner waits for the new broadcast).
                    sessionRole === 'initiator' && (
                      <button
                        className="act"
                        onClick={() => {
                          trackPickRejected({ tmdbId: result.id, rejectionCountThisSession: tryAnotherCount + 1 });
                          setTryAnotherCount(c => c + 1);
                          handleSessionTryAnother();
                        }}
                      >
                        Try another
                      </button>
                    )
                  ) : (
                    <button
                      className="act"
                      onClick={() => {
                        trackPickRejected({ tmdbId: result.id, rejectionCountThisSession: tryAnotherCount + 1 });
                        setTryAnotherCount(c => c + 1);
                        pickContent(false);
                      }}
                    >
                      Try another
                    </button>
                  )}
                  <button
                    className={`act save-btn ${isSaved(result) ? 'saved' : ''}`}
                    onClick={() => toggleSaveForLater(result)}
                    disabled={!isSaved(result) && savedForLater.length >= 20}
                    aria-label={
                      isSaved(result)
                        ? 'Remove from saved'
                        : savedForLater.length >= 20
                          ? 'Saved list is full — remove a pick to save another'
                          : 'Save for later'
                    }
                    aria-pressed={isSaved(result)}
                    title={
                      !isSaved(result) && savedForLater.length >= 20
                        ? 'Saved list is full (20 max)'
                        : undefined
                    }
                  >
                    <span aria-hidden="true">🔖</span> {isSaved(result) ? 'Saved' : 'Save'}
                  </button>
                  <button
                    className="act share-btn"
                    onClick={() => handleShare(result)}
                    aria-label="Share this pick"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                      <line x1="22" y1="2" x2="11" y2="13" />
                      <polygon points="22 2 15 22 11 13 2 9 22 2" />
                    </svg>
                    Share
                  </button>
                </div>
              </div>
              {/* Pre-watch veto — quieter than "Try another" because it
                  permanently bans the title from future picks. */}
              <button
                type="button"
                className="veto-btn"
                onClick={handleVetoPick}
                aria-label={`I've already seen ${result.title} — don't pick it again`}
              >
                <span aria-hidden="true">✗</span> I've seen this — don't pick it again
              </button>
              {tryAnotherCount >= 3 && (
                <div className="mood-nudge" role="status">
                  <span aria-hidden="true">🎯</span> Not feeling these?
                  <button
                    className="mood-nudge-btn"
                    onClick={() => { setTryAnotherCount(0); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                  >
                    Try a different mood
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="footer-row">
        <div className="footer-left">
          <div className="catalog-size">Settle · Powered by TMDB</div>
          <div className="footer-legal">
            <button className="privacy-link" onClick={() => setShowPrivacy(true)}>Privacy Policy</button>
            <span className="footer-legal-sep">·</span>
            <button className="privacy-link" onClick={() => setShowTerms(true)}>Terms of Service</button>
          </div>
        </div>
        {/* Watch History button moved to the account bar (top-left). */}
      </div>

      {/* Toast */}
      {showToast && (
        <div className={`toast${toastPositionClass}`}>✓ Added to your watch history</div>
      )}

      {showNoSimilarToast && (
        <div className={`toast${toastPositionClass}`}>No similar titles on your services — here's a fresh pick</div>
      )}

      {/* History panel */}
      {showHistory && (
        <div className="history-overlay" onClick={() => setShowHistory(false)}>
          <div
            ref={historyPanelRef}
            className="history-panel"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="history-title-heading"
            tabIndex={-1}
          >
            <div className="history-header">
              <div className="history-header-text">
                <h2 id="history-title-heading" className="history-title">
                  {historyTab === 'watched' ? 'Watch History' : 'Saved'}
                </h2>
                <p className="history-subtitle">
                  {historyTab === 'watched' ? 'Last 30 watches' : 'Up to 20 items'}
                </p>
              </div>
              <div className="history-header-actions">
                {/* Clear history/saved relocated here from a full-width
                    bottom button (spec §4.4) — out of the thumb zone, behind
                    an explicit menu tap instead of a two-tap arm/timeout. */}
                <div className="history-menu-wrap" ref={historyMenuRef}>
                  <button
                    type="button"
                    className="history-menu-btn"
                    onClick={() => setShowHistoryMenu(o => !o)}
                    aria-label="More options"
                    aria-haspopup="true"
                    aria-expanded={showHistoryMenu}
                  >
                    <span aria-hidden="true">⋮</span>
                  </button>
                  {showHistoryMenu && (
                    <div className="history-menu" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        className="history-menu-item"
                        onClick={() => { setShowHistoryMenu(false); setShowClearConfirm(true); }}
                      >
                        {historyTab === 'watched' ? 'Clear watch history' : 'Clear saved'}
                      </button>
                    </div>
                  )}
                </div>
                <button
                  className="history-close"
                  onClick={() => setShowHistory(false)}
                  aria-label="Close watch history"
                >
                  <span aria-hidden="true">✕</span>
                </button>
              </div>
            </div>

            {showClearConfirm && (
              <div className="history-clear-confirm">
                <p className="history-clear-confirm-title">
                  {historyTab === 'watched' ? 'Clear watch history?' : 'Clear saved?'}
                </p>
                <p className="history-clear-confirm-body">
                  {historyTab === 'watched'
                    ? `This removes all ${watchHistory.length} items and resets your taste profile. Your saved items are kept. This can't be undone.`
                    : `This removes all ${savedForLater.length} saved items. This can't be undone.`}
                </p>
                <div className="history-clear-confirm-actions">
                  <button
                    type="button"
                    className="history-clear-confirm-cancel"
                    onClick={() => setShowClearConfirm(false)}
                    autoFocus
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="history-clear-confirm-yes"
                    onClick={() => {
                      setShowClearConfirm(false);
                      if (historyTab === 'watched') clearHistory();
                      else clearSaved();
                    }}
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}

            {/* Tab switcher */}
            <div className="history-tab-bar" role="tablist">
              <button
                role="tab"
                aria-selected={historyTab === 'watched'}
                className={`history-tab ${historyTab === 'watched' ? 'active' : ''}`}
                onClick={() => setHistoryTab('watched')}
              >
                Watched
              </button>
              <button
                role="tab"
                aria-selected={historyTab === 'saved'}
                className={`history-tab ${historyTab === 'saved' ? 'active' : ''}`}
                onClick={() => setHistoryTab('saved')}
              >
                🔖 Saved {savedForLater.length > 0 && <span className="history-tab-badge">{savedForLater.length}</span>}
              </button>
            </div>

            {/* Rate-nudge banner (spec §4.2) — a static banner tied to live
                unrated count, not a dismissible toast: it's simply present
                whenever ≥1 Watched item has no rating, and disappears on its
                own once everything is rated. */}
            {historyTab === 'watched' && (() => {
              const unratedCount = watchHistory.filter(e => !e.rated || e.rated === 'skip').length;
              if (unratedCount === 0) return null;
              return (
                <button
                  type="button"
                  className="history-rate-nudge"
                  onClick={() => {
                    trackHistoryRateNudgeTapped({ unratedCount });
                    const firstUnrated = watchHistory.find(e => !e.rated || e.rated === 'skip');
                    if (firstUnrated) {
                      const el = document.getElementById(`history-row-${firstUnrated.id}-${firstUnrated.watchedAt}`);
                      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                  }}
                >
                  Rate {unratedCount} more to sharpen your recs
                </button>
              );
            })()}

            {historyTab === 'watched' ? (
              <>
                {/* Couples streak */}
                {streakInfo ? (
                  <div className="streak-info" role="status">
                    <span className="streak-fire" aria-hidden="true">🔥</span>
                    <span>{streakInfo} night{streakInfo > 1 ? 's' : ''} in a row you both said yes</span>
                  </div>
                ) : null}

                {watchHistory.length === 0 ? (
                  <div className="history-empty">
                    <div className="history-empty-icon" aria-hidden="true">🎬</div>
                    <div className="history-empty-text">Nothing watched yet</div>
                    <div className="history-empty-sub">Make your first pick — watched titles show up here.</div>
                  </div>
                ) : (
                  <>
                    {watchHistory.length >= 30 && (
                      <div className="history-cap-hint" role="status">
                        At the 30-entry limit — adding a new pick replaces the oldest.
                      </div>
                    )}
                    <div className="history-list">
                      {watchHistory.map(entry => (
                        <button
                          key={`${entry.id}-${entry.watchedAt}`}
                          id={`history-row-${entry.id}-${entry.watchedAt}`}
                          className="history-entry"
                          onClick={() => handleHistoryReplay(entry)}
                          aria-label={`Rewatch ${entry.title}`}
                        >
                          <div className="history-poster">
                            {entry.posterPath ? (
                              <img src={tmdbService.getPosterUrl(entry.posterPath, 'w92')} alt="" />
                            ) : (
                              <div className="history-poster-placeholder" aria-hidden="true">🎬</div>
                            )}
                          </div>
                          <div className="history-info">
                            <div className="history-entry-title">
                              {entry.title}
                              {/* Couple matches were stored but invisible — the
                                  badge makes "we agreed on this one" scannable. */}
                              {entry.coupleAgreed && (
                                <span
                                  className="history-couple-badge"
                                  role="img"
                                  aria-label="Matched together"
                                  title="You matched on this together"
                                >
                                  💑
                                </span>
                              )}
                            </div>
                            <div className="history-entry-meta">
                              {entry.year} · {entry.type}
                              {Number.isFinite(parseFloat(entry.rating)) && entry.rating > 0 && (
                                <> · TMDB {entry.rating}</>
                              )}
                            </div>
                            <div className="history-entry-bottom">
                              <span className="history-service" style={{
                                color: entry.service === 'In Theaters' ? '#EF9F27'
                                  : serviceByName.get(entry.service)?.color || '#999'
                              }}>
                                {entry.service}
                              </span>
                              <span className="history-date">{formatWatchedDate(entry.watchedAt)}</span>
                            </div>
                          </div>
                          <div className="history-right">
                            {entry.rated === 'up' || entry.rated === 'down' ? (
                              <button
                                type="button"
                                className={`history-vote-btn history-vote-solid-${entry.rated}`}
                                onClick={e => { e.stopPropagation(); unrateHistoryEntry(entry); }}
                                aria-label={`${entry.rated === 'up' ? 'Liked' : 'Disliked'} ${entry.title} — tap to un-rate`}
                              >
                                {entry.rated === 'up' ? '👍' : '👎'}
                              </button>
                            ) : (
                              <div className="history-vote-pair">
                                <button
                                  type="button"
                                  className="history-vote-btn history-vote-ghost"
                                  onClick={e => { e.stopPropagation(); rateHistoryEntry(entry, 'up'); }}
                                  aria-label={`Rate ${entry.title} thumbs up`}
                                >
                                  👍
                                </button>
                                <button
                                  type="button"
                                  className="history-vote-btn history-vote-ghost"
                                  onClick={e => { e.stopPropagation(); rateHistoryEntry(entry, 'down'); }}
                                  aria-label={`Rate ${entry.title} thumbs down`}
                                >
                                  👎
                                </button>
                              </div>
                            )}
                            {/* "More like this" (spec §4.6) — hidden for
                                down-rated titles (a bad match shouldn't seed
                                more of the same) and while offline, since the
                                lookup needs a live TMDB call. */}
                            {entry.rated !== 'down' && (
                              <div className="history-row-menu-wrap history-menu-wrap">
                                <button
                                  type="button"
                                  className="history-menu-btn"
                                  onClick={e => {
                                    e.stopPropagation();
                                    const key = `${entry.id}-${entry.watchedAt}`;
                                    setOpenRowMenu(openRowMenu === key ? null : key);
                                  }}
                                  aria-label={`More options for ${entry.title}`}
                                  aria-haspopup="true"
                                  aria-expanded={openRowMenu === `${entry.id}-${entry.watchedAt}`}
                                >
                                  <span aria-hidden="true">⋮</span>
                                </button>
                                {openRowMenu === `${entry.id}-${entry.watchedAt}` && (
                                  <div className="history-menu" role="menu">
                                    <button
                                      type="button"
                                      className="history-menu-item"
                                      role="menuitem"
                                      disabled={!isOnline}
                                      onClick={e => {
                                        e.stopPropagation();
                                        handleMoreLikeThis(entry);
                                      }}
                                    >
                                      {isOnline ? '✨ More like this' : '✨ More like this (offline)'}
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            ) : (
              /* Saved tab */
              savedForLater.length === 0 ? (
                <div className="history-empty">
                  <div className="history-empty-icon" aria-hidden="true">🔖</div>
                  <div className="history-empty-text">No saved picks yet</div>
                  <div className="history-empty-sub">Tap 🔖 on any result to save it for later</div>
                </div>
              ) : (
                <>
                  {savedForLater.length >= 20 && (
                    <div className="history-cap-hint" role="status">
                      Saved list is full (20 max) — remove a pick to add another.
                    </div>
                  )}
                  <div className="history-list">
                    {savedForLater.map(entry => (
                      <button
                        key={entry.id}
                        className="history-entry"
                        onClick={() => handleHistoryReplay(entry)}
                        aria-label={`View ${entry.title}`}
                      >
                        <div className="history-poster">
                          {entry.posterPath ? (
                            <img src={tmdbService.getPosterUrl(entry.posterPath, 'w92')} alt="" />
                          ) : (
                            <div className="history-poster-placeholder" aria-hidden="true">🎬</div>
                          )}
                        </div>
                        <div className="history-info">
                          <div className="history-entry-title">{entry.title}</div>
                          <div className="history-entry-meta">
                            {entry.year} · {entry.type}
                            {Number.isFinite(parseFloat(entry.rating)) && entry.rating > 0 && (
                              <> · TMDB {entry.rating}</>
                            )}
                          </div>
                          <div className="history-entry-bottom">
                            <span className="history-service" style={{
                              color: entry.service === 'In Theaters' ? '#EF9F27'
                                : serviceByName.get(entry.service)?.color || '#999'
                            }}>
                              {entry.service}
                            </span>
                          </div>
                        </div>
                        <div className="history-right">
                          <button
                            className="saved-remove-btn"
                            onClick={e => { e.stopPropagation(); toggleSaveForLater(entry); }}
                            aria-label={`Remove ${entry.title} from saved`}
                          >
                            🔖
                          </button>
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )
            )}

            {/* Partner's saved items — visible when a partner is linked and
                has saved something. Read-only: the ★ shows their interest but
                the user can't remove it from here. */}
            {partnerUid && partnerSaved.length > 0 && (
              <div className="partner-saved-section">
                <div className="partner-saved-header">
                  <span className="partner-saved-icon" aria-hidden="true">💑</span>
                  {partnerName ? `${partnerName.split(' ')[0]} wants to watch` : 'Your partner saved these'}
                </div>
                <div className="history-list">
                  {partnerSaved.map(entry => (
                    <button
                      key={entry.id}
                      className="history-entry partner-saved-entry"
                      onClick={() => handleHistoryReplay(entry)}
                      aria-label={`View ${entry.title}`}
                    >
                      <div className="history-poster">
                        {entry.posterPath ? (
                          <img src={tmdbService.getPosterUrl(entry.posterPath, 'w92')} alt="" />
                        ) : (
                          <div className="history-poster-placeholder" aria-hidden="true">🎬</div>
                        )}
                      </div>
                      <div className="history-info">
                        <div className="history-entry-title">{entry.title}</div>
                        <div className="history-entry-meta">{entry.year} · {entry.type}</div>
                        <div className="history-entry-bottom">
                          <span className="history-service" style={{
                            color: entry.service === 'In Theaters' ? '#EF9F27'
                              : serviceByName.get(entry.service)?.color || '#999'
                          }}>
                            {entry.service}
                          </span>
                        </div>
                      </div>
                      <div className="history-right">
                        <span className="partner-saved-bookmark" aria-hidden="true">🔖</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Manual import/export removed — cloud sync (Firestore) is now
                the canonical persistence layer. Users wanting cross-device
                portability sign in; the data follows automatically. */}
          </div>
        </div>
      )}

      {/* Watch loop — "did you watch it? / how was it?" (replaces old rating popup) */}
      {ratingPopup && watchLoopStep && (
        <WatchLoop
          entry={ratingPopup}
          step={watchLoopStep}
          onConfirm={handleWatchConfirm}
          onSnooze={handleWatchSnooze}
          onSkip={handleWatchSkip}
          onVote={handleVote}
          getPosterUrl={(path, size) => tmdbService.getPosterUrl(path, size)}
        />
      )}

      {cinemaMode && (cinemaSource === 'history' ? replayResult : result) && (() => {
        const cinemaItem = cinemaSource === 'history' ? replayResult : result;
        return (
        <div className="cinema-overlay" onClick={() => { setCinemaMode(false); setReplayResult(null); }}>
          <div
            ref={cinemaCardRef}
            className="cinema-card"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cinema-title"
            tabIndex={-1}
          >
            <div className="cinema-poster-wrap">
              {cinemaItem.posterPath ? (
                <img
                  className="cinema-poster"
                  src={tmdbService.getPosterUrl(cinemaItem.posterPath, 'w500')}
                  alt={`${cinemaItem.title} poster`}
                />
              ) : (
                <div
                  className="cinema-poster cinema-poster-placeholder"
                  style={{ background: `${getServiceColor(cinemaItem.service)}22`, color: getServiceColor(cinemaItem.service) }}
                  aria-hidden="true"
                >
                  {cinemaItem.service}
                </div>
              )}
              {/* Corner-ribbon (spec §2.1) — a small clipping wrapper in the
                  poster's corner, not the poster itself, so the ribbon's ends
                  terminate cleanly at the wrapper's edges instead of clipping
                  mid-letter. Hidden entirely without a real poster (nothing to
                  anchor the corner to). aria-label drops the "Our " couple
                  prefix so VoiceOver hears one clean phrase, not the full
                  visual string twice. */}
              {cinemaSource === 'pick' && cinemaItem.posterPath && (
                <div className="cinema-stamp-wrap">
                  <div
                    className="cinema-stamp"
                    role="img"
                    aria-label={pickLabel(mode).replace(/^Our /, '')}
                  >
                    {pickLabel(mode)} <span aria-hidden="true">🎬</span>
                  </div>
                </div>
              )}
            </div>
            <h2 id="cinema-title" className="cinema-title">{cinemaItem.title}</h2>
            <div className="cinema-meta">
              {cinemaItem.year} · {cinemaItem.type} ·{' '}
              <span style={{ color: getServiceColor(cinemaItem.service) }}>{cinemaItem.service}</span>
            </div>
            <div className="cinema-rating" aria-label={`Rated ${cinemaItem.rating} out of 10`}>
              <span className="stars" aria-hidden="true">{starsFromRating(cinemaItem.rating)}</span>
              <span className="cinema-rating-num" aria-hidden="true">{cinemaItem.rating}/10</span>
            </div>
            {(() => {
              // Theater picks now open the in-app ShowtimesSheet (Theater
              // Mode 2.0) instead of routing out to Google search. The
              // sheet handles location permission + nearby theaters +
              // showtimes. Streaming picks still get the existing deep
              // link to their service.
              if (cinemaSource === 'pick' && cinemaItem.service === 'In Theaters') {
                return (
                  <div className="cinema-actions">
                    <button
                      type="button"
                      className="cinema-watch-btn"
                      onClick={() => {
                        trackDeepLinkOpened({
                          service: cinemaItem.service,
                          titleId: cinemaItem.id,
                          mode,
                          surface: 'cinema_mode',
                        });
                        handleTheaterMoviePick(cinemaItem);
                      }}
                      style={{ background: getServiceColor(cinemaItem.service) }}
                    >
                      🎟️ Get tickets
                    </button>
                  </div>
                );
              }
              // Prefer Watchmode's direct title deep-link (resolved into
              // watchLink for the current cinema item, any service); fall back
              // to the platform's search page only when there's no direct URL.
              const href = watchLink || getPlatformLink(cinemaItem.service, cinemaItem.title);
              return href ? (
                <div className="cinema-actions">
                  <a
                    className="cinema-watch-btn"
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ background: getServiceColor(cinemaItem.service) }}
                    aria-label={`Open ${cinemaItem.title} on ${cinemaItem.service}`}
                    onClick={() => trackDeepLinkOpened({
                      service: cinemaItem.service,
                      titleId: cinemaItem.id,
                      mode,
                      surface: 'cinema_mode',
                    })}
                  >
                    ▶ Open on {cinemaItem.service}
                  </a>
                </div>
              ) : null;
            })()}
            {/* Trailer button intentionally absent from cinema mode — by the
                time the user has tapped "Watching this" (or won the couples
                ballot) they've already committed; surfacing a trailer here
                is friction. The trailer chip on the result card covers
                pre-commit. */}
            <button className="cinema-share-btn" onClick={() => handleShare(cinemaItem)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
              {mode === 'couple' ? "Share what we're watching" : 'Share this pick'}
            </button>
          </div>
        </div>
        );
      })()}

      {/* Secret ballot overlay */}
      {showBallot && result && (
        <div className="ballot-overlay" role="dialog" aria-modal="true" aria-label="Secret vote">
          <div ref={ballotCardRef} className="ballot-card" tabIndex={-1}>

            {/* Coin-flip preview hint — surfaces the escape hatch BEFORE
                users have failed twice, so they know it's coming. Replaced
                by the live "Let fate decide" button on the reveal screen
                once ballotFailCount >= 2. */}
            {ballotStep !== 'reveal' && ballotFailCount < 2 && (
              <div className="ballot-coin-hint" aria-hidden="true">
                <span aria-hidden="true">🎲</span>
                <span>
                  {ballotFailCount === 0
                    ? 'Two misses unlocks the coin flip'
                    : 'One more miss unlocks the coin flip'}
                </span>
              </div>
            )}

            {/* Step — P1 votes */}
            {ballotStep === 'p1' && (
              <div className="ballot-step">
                <div className="ballot-look-away">
                  <span aria-hidden="true">👀</span> {playerNames.p2} — look away!
                </div>
                <div className="ballot-cue">{playerNames.p1}, cast your vote</div>
                <div className="ballot-preview">
                  {result.posterPath && (
                    <img className="ballot-poster" src={tmdbService.getPosterUrl(result.posterPath, 'w185')} alt="" />
                  )}
                  <div className="ballot-preview-info">
                    <div className="ballot-preview-title">{result.title}</div>
                    <div className="ballot-preview-meta">{result.year} · {result.type} · <span style={{ color: getServiceColor(result.service) }}>{result.service}</span></div>
                    <div className="ballot-preview-rating" aria-label={`Rated ${result.rating} out of 10`}>
                      <span aria-hidden="true">{starsFromRating(result.rating)} {result.rating}/10</span>
                    </div>
                  </div>
                </div>
                <div className="ballot-votes">
                  <button className="ballot-vote yes" onClick={() => handleBallotVote('up')} aria-label="Vote yes">
                    <span aria-hidden="true">👍</span><span>Yes</span>
                  </button>
                  <button className="ballot-vote no" onClick={() => handleBallotVote('down')} aria-label="Vote no">
                    <span aria-hidden="true">👎</span><span>No</span>
                  </button>
                </div>
              </div>
            )}

            {/* Step — P2 votes */}
            {ballotStep === 'p2' && (
              <div className="ballot-step">
                <button
                  type="button"
                  className="ballot-back"
                  onClick={() => { setBallotStep('p1'); setP1Vote(null); }}
                  aria-label={`Back to ${playerNames.p1}'s vote`}
                >
                  ← Back to {playerNames.p1}
                </button>
                <div className="ballot-locked"><span aria-hidden="true">🔒</span> {playerNames.p1}'s vote is locked</div>
                <div className="ballot-cue">{playerNames.p2}, your turn</div>
                <div className="ballot-preview">
                  {result.posterPath && (
                    <img className="ballot-poster" src={tmdbService.getPosterUrl(result.posterPath, 'w185')} alt="" />
                  )}
                  <div className="ballot-preview-info">
                    <div className="ballot-preview-title">{result.title}</div>
                    <div className="ballot-preview-meta">{result.year} · {result.type} · <span style={{ color: getServiceColor(result.service) }}>{result.service}</span></div>
                    <div className="ballot-preview-rating" aria-label={`Rated ${result.rating} out of 10`}>
                      <span aria-hidden="true">{starsFromRating(result.rating)} {result.rating}/10</span>
                    </div>
                  </div>
                </div>
                <div className="ballot-votes">
                  <button className="ballot-vote yes" onClick={() => handleBallotVote('up')} aria-label="Vote yes">
                    <span aria-hidden="true">👍</span><span>Yes</span>
                  </button>
                  <button className="ballot-vote no" onClick={() => handleBallotVote('down')} aria-label="Vote no">
                    <span aria-hidden="true">👎</span><span>No</span>
                  </button>
                </div>
              </div>
            )}

            {/* Step — Reveal */}
            {ballotStep === 'reveal' && (() => {
              // 1-second suspense beat before showing outcome
              if (!revealReady) {
                return (
                  <div className="ballot-step ballot-suspense">
                    <div className="ballot-dots" aria-label="Revealing votes">
                      <span /><span /><span />
                    </div>
                    <div className="ballot-suspense-text">Revealing...</div>
                  </div>
                );
              }
              const outcome = getBallotOutcome(p1Vote, p2Vote);
              return (
                <div className="ballot-step ballot-reveal">
                  <div className="ballot-reveal-votes">
                    <div className="ballot-reveal-player">
                      <div className="ballot-reveal-name">{playerNames.p1}</div>
                      <div className={`ballot-reveal-emoji ${p1Vote === 'up' ? 'yes' : 'no'}`}>
                        {p1Vote === 'up' ? '👍' : '👎'}
                      </div>
                    </div>
                    <div className="ballot-reveal-vs">vs</div>
                    <div className="ballot-reveal-player">
                      <div className="ballot-reveal-name">{playerNames.p2}</div>
                      <div className={`ballot-reveal-emoji ${p2Vote === 'up' ? 'yes' : 'no'}`}>
                        {p2Vote === 'up' ? '👍' : '👎'}
                      </div>
                    </div>
                  </div>

                  {outcome === 'match' && (
                    <>
                      <div className="ballot-outcome-icon">🎉</div>
                      <div className="ballot-outcome-title">It's a match!</div>
                      <div className="ballot-outcome-sub">You're both watching <strong>{result.title}</strong></div>
                      <button className="ballot-action primary" onClick={handleBallotMatch}>
                        Let's watch it ✓
                      </button>
                    </>
                  )}

                  {outcome === 'split' && (
                    <>
                      <div className="ballot-outcome-icon">🤔</div>
                      <div className="ballot-outcome-title">Not this one…</div>
                      <div className="ballot-outcome-sub">
                        {p1Vote === 'up' ? playerNames.p1 : playerNames.p2} wanted it,{' '}
                        {p1Vote === 'down' ? playerNames.p1 : playerNames.p2} didn't.
                      </div>
                      <button className="ballot-action primary" onClick={handleBallotRetry}>
                        Try another →
                      </button>
                    </>
                  )}

                  {outcome === 'both-no' && (
                    <>
                      <div className="ballot-outcome-icon">😂</div>
                      <div className="ballot-outcome-title">Hard pass from both!</div>
                      <div className="ballot-outcome-sub">Finding something better...</div>
                      <button className="ballot-action primary" onClick={handleBallotRetry}>
                        Find something else →
                      </button>
                    </>
                  )}

                  {/* Coin flip unlocks after 2 consecutive failed ballots */}
                  {ballotFailCount >= 2 && outcome !== 'match' && (
                    <button className="ballot-action coin-flip" onClick={handleCoinFlip}>
                      🎲 Let fate decide
                    </button>
                  )}

                  <button className="ballot-action secondary" onClick={() => setShowBallot(false)}>
                    Cancel
                  </button>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* Onboarding — cinematic 4-slide flow */}
      {showOnboarding && <Onboarding onDone={handleOnboardingDone} />}

      {/* Privacy Policy modal */}
      {showPrivacy && (
        <div className="privacy-overlay" onClick={() => setShowPrivacy(false)}>
          <div
            ref={privacyModalRef}
            className="privacy-modal"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="privacy-modal-title"
            tabIndex={-1}
          >
            <div className="privacy-header">
              <h2 id="privacy-modal-title" className="privacy-title">Privacy Policy</h2>
              <button
                className="privacy-close"
                onClick={() => setShowPrivacy(false)}
                aria-label="Close privacy policy"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>
            <div className="privacy-body">
              <PrivacyBody />
            </div>
          </div>
        </div>
      )}

      {/* Terms of Service modal */}
      {showTerms && (
        <div className="privacy-overlay" onClick={() => setShowTerms(false)}>
          <div
            ref={termsModalRef}
            className="privacy-modal"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="terms-modal-title"
            tabIndex={-1}
          >
            <div className="privacy-header">
              <h2 id="terms-modal-title" className="privacy-title">Terms of Service</h2>
              <button
                className="privacy-close"
                onClick={() => setShowTerms(false)}
                aria-label="Close terms of service"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>
            <div className="privacy-body">
              <TermsBody />
            </div>
          </div>
        </div>
      )}

      {/* Share card modal */}
      {showShareModal && (
        <div className="share-overlay" onClick={closeShareModal}>
          <div
            ref={shareModalRef}
            className="share-modal"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="share-modal-title"
            tabIndex={-1}
          >
            <div className="share-modal-header">
              <h2 id="share-modal-title" className="share-modal-title">Your Pick Card</h2>
              <button
                className="share-modal-close"
                onClick={closeShareModal}
                aria-label="Close share dialog"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>

            {shareCardLoading ? (
              <div className="share-modal-loading" role="status">
                <div className="share-spinner" aria-hidden="true" />
                <span>Generating card…</span>
              </div>
            ) : shareCardReady ? (
              <>
                <div className="share-preview-wrap" ref={sharePreviewRef}>
                  {shareCardUrl && (
                    <img className="share-preview-img" src={shareCardUrl} alt={`Share card for ${shareItemRef.current?.title || 'pick'}`} />
                  )}
                </div>
                <div className="share-modal-actions">
                  {'share' in navigator ? (
                    <button className="share-action-primary" onClick={shareImageCard}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                        <line x1="22" y1="2" x2="11" y2="13" />
                        <polygon points="22 2 15 22 11 13 2 9 22 2" />
                      </svg>
                      Share
                    </button>
                  ) : (
                    <p className="share-desktop-hint">Open on mobile to share to Instagram or WhatsApp</p>
                  )}
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}

      {/* Share copied toast */}
      {shareCopied && (
        <div className={`toast${toastPositionClass}`} role="status">Link copied to clipboard!</div>
      )}

      {/* Consent banner */}
      {showConsent && (
        <div className="consent-banner" role="region" aria-label="Storage consent">
          <div className="consent-text">
            <span aria-hidden="true">🔒</span> We save your preferences and watch history <strong>on your device only</strong>. Nothing is shared externally.
          </div>
          <div className="consent-actions">
            <button className="consent-decline" onClick={() => handleConsent(false)}>Decline</button>
            <button className="consent-accept" onClick={() => handleConsent(true)}>Got it</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
