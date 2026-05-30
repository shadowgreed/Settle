import React, { useState, useEffect, useRef, useMemo } from 'react';
import { flushSync } from 'react-dom';
import tmdbService from './services/tmdb';
import watchmodeService from './services/watchmode';
import { generateShareCard } from './utils/shareCard';
import { pickLabel, pickVerb, moodGreeting } from './utils/timeOfDay';
import {
  trackAppLoaded, trackPickGenerated, trackConsentRevoked, trackAccountDeleted,
  trackTrailerPlayed, trackDeepLinkOpened, trackVoteSubmitted,
  trackPushPromptShown, trackPushAccepted, trackPushDenied, trackPushUnsubscribed,
  trackLocationPermissionResult, trackZipEntered,
  trackMoodMigrationEasyWatchToFun,
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
import StreakHistory from './components/StreakHistory';
import TrailerOverlay from './components/TrailerOverlay';
import { PrivacyBody, TermsBody } from './components/LegalContent';
import { onAuthChange, signOut, deleteCurrentUser } from './services/auth';
import { migrateLocalToCloud, pushUserData, pushUserDataAuthoritative, buildPayload, deleteUserData } from './services/cloudSync';
import { authHeader } from './services/authHeader';
import {
  savePartnerLink, clearPartnerLink,
  generateInviteCode, verifyInviteCode, checkPendingLink, readPartnerDoc,
  createLiveBallot, subscribeToIncomingBallot, subscribeBallot, castVote, dismissBallot,
  createCoupleSession, subscribeIncomingSession, subscribeCoupleSession,
  setSessionReady, broadcastSessionResult, closeCoupleSession,
} from './services/couple';
import CoupleLink from './components/CoupleLink';
import LiveBallot from './components/LiveBallot';
import CoupleSessionSelect from './components/CoupleSessionSelect';
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
    return { solo: [], p1: [], p2: [], theater: [], session: [], ...saved };
  });
  const [selectedFormats, setSelectedFormats] = useState(() => loadPrefs().formats || ['Movie', 'Series']);
  const [minRating, setMinRating] = useState(() => loadPrefs().minRating ?? 6.0);
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
  const [showHistory, setShowHistory] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showStreakHistory, setShowStreakHistory] = useState(false);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const signOutResetRef = useRef(null);
  const [showToast, setShowToast] = useState(false);
  const [playerNames, setPlayerNames] = useState(() => {
    try { return JSON.parse(localStorage.getItem('streaming-player-names')) || { p1: 'Him', p2: 'Her' }; }
    catch { return { p1: 'Him', p2: 'Her' }; }
  });
  const [editingPlayer, setEditingPlayer] = useState(null);
  const [activePlayer, setActivePlayer] = useState('p1');
  const [showAllGenres, setShowAllGenres] = useState(false);
  const [pickReason, setPickReason] = useState(null);
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

  // "New in your genres" home-screen card (PM roadmap 3.2). Count is the
  // headline number from TMDB; dismissed flag is per-day in localStorage.
  const [newReleasesCount, setNewReleasesCount] = useState(0);
  const [newReleasesDismissed, setNewReleasesDismissed] = useState(() => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      return localStorage.getItem('settle_newrel_dismissed') === today;
    } catch { return false; }
  });

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
  const sessionPickedForRef = useRef(null); // guards the one-shot auto-pick
  const coupleSessionIdRef  = useRef(null);
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
  const [familyFriendly, setFamilyFriendly] = useState(false);

  // History panel tab — 'watched' | 'saved'
  const [historyTab, setHistoryTab] = useState('watched');

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
    if (data.playerNames && typeof data.playerNames === 'object') setPlayerNames(data.playerNames);
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
      if (p.minRating != null)               setMinRating(p.minRating);
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

  // Cancel the auto-revert timer for the sign-out confirm if the component
  // unmounts before the user resolves it.
  useEffect(() => () => {
    if (signOutResetRef.current) clearTimeout(signOutResetRef.current);
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
    setPlayerNames({ p1: 'Him', p2: 'Her' });
    setResult(null);
    setPickReason(null);
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
  }, [showShareModal, showPrivacy, showTerms, showHistory, ratingPopup, cinemaMode, showBallot, showSettings, showTrailer, showStreakHistory, showShowtimes, locationPrompt]);

  // Lock body scroll while any modal is open — prevents the underlying app from
  // scrolling on iOS when the user drags inside the overlay. Restores the prior
  // value on close so we don't fight other scripts that might set overflow.
  useEffect(() => {
    const anyOpen =
      showOnboarding || showHistory || showShareModal || showPrivacy ||
      showTerms || showBallot || cinemaMode || !!ratingPopup || showSettings ||
      showTrailer || showStreakHistory || showShowtimes || !!locationPrompt;
    if (anyOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [showOnboarding, showHistory, showShareModal, showPrivacy, showTerms,
      showBallot, cinemaMode, ratingPopup, showSettings, showTrailer, showStreakHistory,
      showShowtimes, locationPrompt]);

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
    setWatchLink(null);
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
    // Use Watchmode for Disney+ and Apple TV to get direct title deep links
    if (result.service === 'Disney+' || result.service === 'Apple TV') {
      watchmodeService.getServiceUrl(result.id, result.type, result.service, result.title)
        .then(url => { if (!cancelled) setWatchLink(url); })
        .catch(() => {});
    }
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

  const generatePickReason = (picked, activeGenreIds, isHiddenGems, currentMode) => {
    if (isHiddenGems) {
      return `💎 Hidden gem — high quality`;
    }

    if (currentMode === 'theater') {
      return `🎟️ Currently in US theaters`;
    }

    // Find which active moods match this result.
    // Use `every` on the selection check so a mood only qualifies if the user
    // explicitly activated it (all its IDs are present) — not just because
    // one shared genre ID (e.g. Drama=18 appears in both Emotional and
    // Thoughtful per the canonical map) causes a false match against a mood
    // the user never selected. Drama alone → Emotional only; Drama +
    // Documentary → Thoughtful (and Emotional, since Drama still satisfies it).
    const activeMoodLabels = MOODS
      .filter(mood =>
        mood.ids.every(id => activeGenreIds.includes(id)) &&
        mood.ids.some(id => picked.genres.includes(id))
      )
      .map(m => m.label)
      .slice(0, 2);

    // Fall back to genre names if no mood match. O(1) lookup via the
    // memoised genreById Map (was .find() inside .map() = O(n²)).
    const matchedGenreNames = picked.genres
      .filter(id => activeGenreIds.includes(id))
      .map(id => genreById.get(id)?.name)
      .filter(Boolean)
      .slice(0, 2);

    const label = activeMoodLabels.length > 0
      ? activeMoodLabels.join(' & ')
      : matchedGenreNames.join(' & ');

    if (label && currentMode === 'couple') {
      return `Picked because you both like ${label}`;
    }
    if (label) {
      return `Matches your ${label} mood`;
    }

    return `Top pick from your filters · ${picked.votes} ratings`;
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

  const overlapGenres = useMemo(() => {
    if (mode !== 'couple') return [];
    const p1 = selectedGenres.p1 || [];
    const p2 = selectedGenres.p2 || [];
    return p1.filter(g => p2.includes(g));
  }, [mode, selectedGenres]);

  const compatScore = useMemo(() => {
    if (mode !== 'couple') return null;
    const p1 = selectedGenres.p1 || [];
    const p2 = selectedGenres.p2 || [];
    if (p1.length === 0 && p2.length === 0) return null;
    if (p1.length === 0 || p2.length === 0) return 0;
    const overlap = p1.filter(g => p2.includes(g));
    const union = [...new Set([...p1, ...p2])];
    return Math.round((overlap.length / union.length) * 100);
  }, [mode, selectedGenres]);

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

  // ── Inline location change from ShowtimesSheet ─────────────────────────
  // Called when the user taps the location chip inside the showtimes sheet
  // and either enters a new ZIP or asks to re-try GPS. Throws on failure
  // so the chip can surface a clean error to the user.
  const handleLocationChange = async ({ mode, zip }) => {
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
      trackZipEntered({ firstTime: isFirstTime });
      setUserLocation({ ...coords, source: 'zip', zip });
      return;
    }
  };

  const handleNewReleasesDismiss = () => {
    setNewReleasesDismissed(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      safeSet('settle_newrel_dismissed', today);
    } catch {}
  };

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
    });
  }, [user?.uid, pushSubscribed, topSoloIdsKey, servicesKey]);

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
    const name = value.trim() || (player === 'p1' ? 'Him' : 'Her');
    const updated = { ...playerNames, [player]: name };
    setPlayerNames(updated);
    if (consent) safeSet('streaming-player-names', JSON.stringify(updated));
    setEditingPlayer(null);
  };

  // ── Couple linking effects + handlers ──────────────────────────────────────

  // When partnerUid is set, load their display name + saved list. Also subscribe
  // to incoming ballots so P2 sees the vote banner without needing to refresh.
  useEffect(() => {
    if (!partnerUid) {
      setPartnerName(null);
      setPartnerSaved([]);
      return;
    }
    // Load partner's display name + saved items.
    readPartnerDoc(partnerUid).then(data => {
      if (data) {
        // Prefer the Firebase Auth identity stored in displayName — that's the
        // person's real name (e.g. "Sarah" from Google sign-in). Fall back to
        // the ballot labels only if displayName hasn't synced yet (e.g. partner
        // hasn't opened the app since this field was added).
        setPartnerName(
          data.displayName ||
          data.playerNames?.p1 ||
          data.playerNames?.p2 ||
          'Your partner'
        );
        setPartnerSaved(Array.isArray(data.savedForLater) ? data.savedForLater : []);
      }
    });
  }, [partnerUid]);

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

  // Generate a code (P1 side). Called by CoupleLink.
  const handleGenerateCode = async () => {
    // Use the Firebase Auth identity (Google display name or email prefix) — not
    // the couples-ballot label (playerNames.p1 = 'Him' by default), which is
    // what P2 would see as "Linked with: Him". Fall through to the ballot label
    // only as a last resort, so the code always has something human-readable.
    const displayName =
      user?.displayName ||
      user?.email?.split('@')[0] ||
      playerNames?.p1 ||
      'Your partner';
    const code = await generateInviteCode(displayName);
    return code;
  };

  // Verify a code (P2 side). Saves the link to Firestore + state. Called by CoupleLink.
  const handleVerifyCode = async (code) => {
    const { partnerUid: pUid, partnerName: pName } = await verifyInviteCode(code);
    await savePartnerLink(user.uid, pUid);
    setPartnerUid(pUid);
    setPartnerName(pName || 'Your partner');
  };

  // Unlink — clears couplePartnerUid on this user's doc.
  const handleUnlinkPartner = async () => {
    if (!user?.uid) return;
    await clearPartnerLink(user.uid);
    setPartnerUid(null);
    setPartnerName(null);
    setPartnerSaved([]);
    closeLiveBallot();
  };

  // ── Live two-device ballot handlers ────────────────────────────────────────

  // Tear down the live ballot on this device. If we started it and it's still
  // unresolved, expire the doc so the partner's device closes too.
  const closeLiveBallot = ({ expire = false } = {}) => {
    const id = liveBallotId;
    const unresolved = liveBallot && liveBallot.status === 'pending';
    if (id && (expire || (liveRole === 'initiator' && unresolved))) {
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
  const handleStartSession = async () => {
    if (!partnerUid || !user?.uid) return;
    setSelectedGenres(g => ({ ...g, session: [] }));
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
    } catch (e) {
      console.warn('[CoupleSession] start failed:', e.message);
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

  // Memoised compatibility banner copy. Reads `compatScore` + `overlapGenres`
  // (already memos) + playerNames — depends on all three.
  const statusMsg = useMemo(() => {
    if (mode !== 'couple') return null;
    const score = compatScore;
    const overlap = overlapGenres;
    const p1 = playerNames.p1;
    const p2 = playerNames.p2;
    const pair = `${p1} & ${p2}`;
    if (score === null) return { text: 'Each pick your genres below', emoji: '👇' };
    if (score === 0)    return { text: `${pair} — no common ground yet`, emoji: '🤔' };
    if (overlap.length === 1) return { text: `${pair} — getting warmer...`, emoji: '🌡️' };
    if (score < 50)    return { text: `${pair} — finding middle ground`, emoji: '🤝' };
    if (score < 75)    return { text: `${pair} — you're vibing!`, emoji: '✨' };
    return { text: `${pair} — perfect match!`, emoji: '🔥' };
  }, [mode, compatScore, overlapGenres, playerNames]);

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
  // Length of the current "agreed" streak (consecutive couple-mode history
  // entries where coupleAgreed === true), or null if streak < 2. Memoised
  // because it's read from JSX in 3 places per render.
  const streakInfo = useMemo(() => {
    const entries = watchHistory.filter(h => h.mode === 'couple');
    if (entries.length < 2) return null;
    let streak = 0;
    for (const entry of entries) {
      if (entry.coupleAgreed) streak++;
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
    setPickReason(null);
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
      setPickReason(
        coinFlip
          ? '🎲 Chosen by fate — no algorithm, pure chance'
          : generatePickReason(picked, activeGenresForFetch, hiddenGems, mode)
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
      'Max':          `https://www.max.com/search?q=${q}`,
      'Disney+':      `https://www.disneyplus.com/search?q=${q}`,
      'Apple TV':     `https://tv.apple.com/search?term=${q}`,
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

  const handleVote = (vote) => {
    if (!ratingPopup) return;
    // Use functional setState to avoid reading from a potentially stale closure.
    const popupId = ratingPopup.id;
    const popupWatchedAt = ratingPopup.watchedAt;
    setWatchHistory(prev => {
      const updated = prev.map(entry =>
        entry.id === popupId && entry.watchedAt === popupWatchedAt
          // Also clear `trailerCredited` so a future re-rate on the same
          // entry doesn't reverse the trailer credit a second time.
          ? { ...entry, rated: vote, trailerCredited: false }
          : entry
      );
      if (consent) safeSet('streaming-history', JSON.stringify(updated));
      return updated;
    });
    if (vote !== 'skip') {
      // If the trailer applied a soft signal earlier, reverse it FIRST so the
      // explicit vote replaces (rather than compounds with) the +0.5 credit.
      // The flag lives on the history entry, so this works across sessions.
      const entryMode =
        ratingPopup.mode === 'theater' ? 'solo' : (ratingPopup.mode || 'solo');
      if (ratingPopup.trailerCredited) {
        reverseTrailerSignal(ratingPopup.genres || [], entryMode);
      }
      updateTasteProfile(ratingPopup.genres || [], vote, ratingPopup.mode);
    }
    // Feedback funnel event. time_since_pick measures how long after the
    // pick was first surfaced the user came back to vote — long gaps
    // typically indicate "actually watched the thing", short gaps indicate
    // a snap reject. PM uses this to distinguish quality from rejection.
    const timeSincePick = ratingPopup.watchedAt
      ? Math.round((Date.now() - new Date(ratingPopup.watchedAt).getTime()) / 1000)
      : null;
    trackVoteSubmitted({
      titleId:        popupId,
      vote,
      service:        ratingPopup.service,
      timeSincePick,
    });
    setRatingPopup(null);
    setWatchLoopStep(null);
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

  const clearHistory = () => {
    setWatchHistory([]);
    // Use the same removal path everywhere (was directly calling
    // localStorage.removeItem here, which bypassed the safeSet/consent
    // discipline used elsewhere — purely a code-hygiene fix).
    try { localStorage.removeItem('streaming-history'); } catch {}
    // Authoritative overwrite — bypass the additive merge so a concurrent tab
    // can't resurrect the entries we just deleted.
    flushAuthoritativeSync({ watchHistory: [] });
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
  //   series → "8 episodes · ~45min each"  /  "8 episodes"  /  "~45min each"
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
      bits.push(`~${info.avgEpisodeMin}min each`);
    }
    return bits.length > 0 ? bits.join(' · ') : null;
  };

  // Builds the unified meta line per PM spec 2.2:
  //   "2023 · Movie · 1h 42min · ★ 8.2"
  //   "2023 · Series · 8 episodes · ~45min each · ★ 8.2"
  // Pieces fall off gracefully if their data isn't loaded yet.
  const formatMetaLine = (item, info) => {
    const parts = [];
    if (item.year)  parts.push(item.year);
    if (item.type)  parts.push(item.type);
    const runtimePiece = formatRuntimePiece(item.type, info);
    if (runtimePiece) parts.push(runtimePiece);
    if (Number.isFinite(parseFloat(item.rating)) && item.rating > 0) {
      parts.push(`★ ${item.rating}`);
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

  // `compatScore` and `statusMsg` are now provided by useMemo above.

  // ── Auth guards ────────────────────────────────────────────────────────────
  if (user === undefined) {
    // Firebase auth is still initialising — show the branded loading screen
    return (
      <div className="authgate">
        <div className="authgate-brand">
          <span className="authgate-emoji" aria-hidden="true">🎬</span>
          <span className="authgate-wordmark">SETTLE</span>
        </div>
        <div className="authgate-spinner" aria-label="Loading…" />
      </div>
    );
  }
  if (!user) return <AuthGate />;

  return (
    <div className="app">
      {/* Skip link — visually hidden until focused. Lets keyboard users
          bypass the account bar + mode tabs and jump to the pick form. */}
      <a href="#main-content" className="skip-link">Skip to main content</a>

      {/* Account bar — left: history actions (watch + saved) · right: streak +
          settings + sign-out. User identity lives in Settings; the main page
          stays focused on the pick flow. */}
      <div className="account-bar">
        <div className="account-bar-left">
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
        </div>
        <div className="account-bar-right">
          {/* Couples streak — shown whenever the user has a >=2-night streak,
              regardless of current mode (PM roadmap 1.3). Tapping opens a
              7-day history modal so the streak feels like an investment, not
              just a stat. Hidden silently for users with no couples activity
              (streakInfo === null). */}
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
            className="account-settings-btn"
            onClick={() => setShowSettings(true)}
            aria-label="Privacy and data settings"
            title="Privacy & data"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          {confirmingSignOut ? (
            <>
              <button
                className="account-signout account-signout-confirm"
                onClick={() => {
                  if (signOutResetRef.current) clearTimeout(signOutResetRef.current);
                  setConfirmingSignOut(false);
                  handleSignOut();
                }}
                aria-label="Confirm sign out"
              >
                Yes, sign out
              </button>
              <button
                className="account-signout account-signout-cancel"
                onClick={() => {
                  if (signOutResetRef.current) clearTimeout(signOutResetRef.current);
                  setConfirmingSignOut(false);
                }}
                aria-label="Cancel sign out"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              className="account-signout"
              onClick={() => {
                setConfirmingSignOut(true);
                if (signOutResetRef.current) clearTimeout(signOutResetRef.current);
                // Auto-revert after 4 s so a forgotten confirm doesn't sit
                // there exposed if the user wanders off.
                signOutResetRef.current = setTimeout(() => setConfirmingSignOut(false), 4000);
              }}
              aria-label="Sign out"
            >
              Sign out
            </button>
          )}
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
          onWithdrawConsent={handleWithdrawConsent}
          onDeleteAccount={handleDeleteAccount}
          onSavePlayerNames={savePlayerName}
          onTogglePush={handlePushToggle}
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

      {/* Theater Mode 2.0 — showtimes sheet (M2+M3). Opens when the user
          taps "Get tickets" on a theater pick. Shows nearest theaters
          + today's showtimes for the picked movie. */}
      {showShowtimes && result && (
        <ShowtimesSheet
          result={result}
          userLocation={userLocation}
          onClose={() => setShowShowtimes(false)}
          onLocationChange={handleLocationChange}
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

      {/* "New in your genres" home card (PM roadmap 3.2). Solo mode only;
          hidden silently when there's nothing new or the user dismissed it
          today. Tap → seed top genres + fire a fresh pick. */}
      {mode === 'solo' && newReleasesCount > 0 && !newReleasesDismissed && (
        <NewReleasesCard
          count={newReleasesCount}
          genreNames={(topGenresByPlayer.solo || []).map(g => g.name)}
          onTap={handleNewReleasesTap}
          onDismiss={handleNewReleasesDismiss}
        />
      )}

      <div id="main-content" className="mode-tabs" role="group" aria-label="Mode" tabIndex={-1}>
        <button
          className={`mtab ${mode === 'solo' ? 'on' : ''}`}
          onClick={() => { setMode('solo'); setResult(null); setHasSearched(false); setFetchError(false); setMatchCount(0); }}
          aria-pressed={mode === 'solo'}
        >
          Solo <span aria-hidden="true">👤</span>
        </button>
        <button
          className={`mtab ${mode === 'couple' ? 'on' : ''}`}
          onClick={() => { setMode('couple'); setActivePlayer('p1'); setResult(null); setHasSearched(false); setFetchError(false); setMatchCount(0); }}
          aria-pressed={mode === 'couple'}
        >
          Couples <span aria-hidden="true">💑</span>
        </button>
        <button
          className={`mtab ${mode === 'theater' ? 'on theater-tab' : ''}`}
          onClick={() => { setMode('theater'); setResult(null); setHasSearched(false); setFetchError(false); setMatchCount(0); }}
          aria-pressed={mode === 'theater'}
        >
          In Theaters <span aria-hidden="true">🎟️</span>
        </button>
      </div>

      {welcomeBack && (
        <div className="welcome-back" role="status">
          <span aria-hidden="true">↩ </span>Preferences restored from your last session
        </div>
      )}

      {(mode === 'solo' || mode === 'theater') && (() => {
        // Each mode uses its own genre slot so selections never cross-contaminate.
        const moodPlayer = mode === 'theater' ? 'theater' : 'solo';
        const activeSlot = selectedGenres[moodPlayer] || [];
        const genreListId = `${moodPlayer}-genre-list`;
        return (
          <div className="section">
            <div className="label" id="mood-greeting-label">
              {mode === 'theater' ? 'What are you in the mood for?' : moodGreeting()}
            </div>
            <div className="mood-grid" role="group" aria-labelledby="mood-greeting-label">
              {/* Decade moods ('80s / '90s / '00s) are hidden in theater
                  mode — they query back catalog by release year, which
                  doesn't make sense for what's currently playing in
                  cinemas. */}
              {MOODS
                .filter(m => mode !== 'theater' || !m.ids.some(id => DECADE_YEARS[id]))
                .map(mood => (
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

      {mode === 'couple' && (
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

          {/* Status + compatibility */}
          <div className="couple-status" role="status" aria-live="polite">
            <div className="couple-status-text">
              <span aria-hidden="true">{statusMsg?.emoji}</span> {statusMsg?.text}
            </div>
            {compatScore !== null && (
              <div className={`compat-score ${compatScore >= 75 ? 'high' : compatScore >= 40 ? 'mid' : 'low'}`}>
                {compatScore}% match
              </div>
            )}
          </div>

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
          ) : (
          <>
          {/* Player tab switcher */}
          <div className="player-tabs" role="tablist" aria-label="Player">
            <div className={`player-tab p1-tab ${activePlayer === 'p1' ? 'active' : ''}`}>
              <button
                type="button"
                className="player-tab-select"
                onClick={() => setActivePlayer('p1')}
                role="tab"
                aria-selected={activePlayer === 'p1'}
                aria-label={`Select ${playerNames.p1}`}
              >
                <span className="player-tab-emoji" aria-hidden="true">⚽</span>
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
                aria-label={`Select ${playerNames.p2}`}
              >
                <span className="player-tab-emoji" aria-hidden="true">💅</span>
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
            <div className="mood-grid" role="group" aria-label={`Moods for ${activePlayer === 'p1' ? playerNames.p1 : playerNames.p2}`}>
              {MOODS.map(mood => (
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

          {partnerUid && (
            <button className="start-session-btn" onClick={handleStartSession}>
              <span aria-hidden="true">🎬</span> Start a couple session with {(partnerName || 'your partner').split(' ')[0]}
            </button>
          )}
          </>
          )}
        </>
      )}

      {mode === 'theater' && (
        <>
          <div className="theater-banner">
            <span aria-hidden="true">🎬</span> Updated weekly · US theaters
          </div>
          <div className="section theater-filters">
            <div className="label" id="theater-filter-label">Filter</div>
            <div className="theater-filter-row" role="group" aria-labelledby="theater-filter-label">
              <button
                type="button"
                className={`theater-filter-chip ${familyFriendly ? 'chip-on' : ''}`}
                onClick={() => setFamilyFriendly(prev => !prev)}
                aria-pressed={familyFriendly}
              >
                🧒 Family-friendly
              </button>
            </div>
          </div>
        </>
      )}

      <div className={`row2${mode === 'theater' ? ' row2-single' : ''}`}>
        {mode !== 'theater' && (
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
        )}
        <div className="fcard">
          <label className="label" htmlFor="min-rating-input">Min Rating</label>
          <div className="range-row">
            <div className="range-wrap">
              <input
                id="min-rating-input"
                type="range"
                min="0"
                max="10"
                step="0.5"
                value={minRating}
                onChange={(e) => setMinRating(parseFloat(e.target.value))}
                aria-valuemin={0}
                aria-valuemax={10}
                aria-valuenow={minRating}
                aria-valuetext={`${minRating.toFixed(1)} out of 10`}
              />
              <span className="range-hint" aria-hidden="true">drag to adjust</span>
            </div>
            <span className="rval" aria-hidden="true">{minRating.toFixed(1)}</span>
          </div>
        </div>
      </div>

      {mode !== 'theater' && (
        <div className="section">
          <div className="label" id="cert-label">Content Rating</div>
          <div className="cert-row" role="radiogroup" aria-labelledby="cert-label">
            {[
              { label: 'All', value: null, aria: 'All' },
              { label: '🧒 Family', value: 'PG', aria: 'Family (PG)' },
              { label: 'PG-13', value: 'PG-13', aria: 'PG-13' },
              { label: 'R & under', value: 'R', aria: 'R and under' }
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

      {mode !== 'theater' && (
        <div className="section">
          <div className="label" id="services-label">Your Services</div>
          <div className="chip-grid" role="group" aria-labelledby="services-label">
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
      )}

      <div className="divider" />

      {/* Note: we intentionally don't surface a "X titles available" count here.
          Users shouldn't be primed by the inventory size of their filters —
          it's both noisy and a poor proxy for whether they'll like the pick.
          `matchCount` is still tracked in state so the empty-state branch
          below can fire when the filter combo produces zero results. */}

      {/* Hidden during an active couple session — the pick is generated
          automatically once both partners lock in, and re-picks come from the
          shared result card's "Try another". */}
      {!coupleSession && (
        <div className="btn-row">
          <button className="pick-btn" onClick={() => pickContent(false)} disabled={loading}>
            {loading ? 'Finding...' : 'Find something for us →'}
          </button>
          {mode !== 'theater' && (
            <button className="hidden-gem-btn" onClick={() => pickContent(true)} disabled={loading}>
              <span aria-hidden="true">💎</span> Hidden Gem
            </button>
          )}
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
        <div className="result show">
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
                      background: `${getServiceColor(result.service)}22`,
                      color: getServiceColor(result.service)
                    }}
                  >
                    {result.service}
                  </div>
                )}
              </div>
              <div className="pills">
                {result.genres.slice(0, 3).map(genreId => {
                  const genre = genreById.get(genreId);
                  return genre && (
                    <span key={genreId} className="pill">{genre.name}</span>
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
              {pickReason && (
                <div className="pick-reason">{pickReason}</div>
              )}
              <div className="desc">{result.description}</div>
              <div className="act-row">
                {coupleSession ? (
                  // During a session only the initiator drives re-picks (the
                  // partner waits for the new broadcast).
                  sessionRole === 'initiator' && (
                    <button className="act" onClick={() => { setTryAnotherCount(c => c + 1); handleSessionTryAnother(); }}>
                      Try another
                    </button>
                  )
                ) : (
                  <button className="act" onClick={() => { setTryAnotherCount(c => c + 1); pickContent(false); }}>
                    Try another
                  </button>
                )}
                {mode === 'couple' ? (
                  <button
                    className="act primary ballot-trigger"
                    onClick={openBallot}
                    title={partnerUid
                      ? `Vote on this pick — it appears live on ${(partnerName || 'your partner').split(' ')[0]}'s phone`
                      : 'Both vote in secret on this device'}
                  >
                    <span aria-hidden="true">🗳️</span> Secret Vote
                  </button>
                ) : (
                  <button className="act primary" onClick={() => { setTryAnotherCount(0); setCinemaSource('pick'); setCinemaMode(true); saveToHistory(result); }}>
                    Watching this <span aria-hidden="true">✓</span>
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
                  {isSaved(result) ? '★' : '☆'}
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
                </button>
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
        <div className="toast">✓ Added to your watch history</div>
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
              <h2 id="history-title-heading" className="history-title">
                {historyTab === 'watched' ? <>Watch History <span className="history-count">({watchHistory.length}/30)</span></> : <>Saved <span className="history-count">({savedForLater.length}/20)</span></>}
              </h2>
              <button
                className="history-close"
                onClick={() => setShowHistory(false)}
                aria-label="Close watch history"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>

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
                ★ Saved {savedForLater.length > 0 && <span className="history-tab-badge">{savedForLater.length}</span>}
              </button>
            </div>

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
                            <div className="history-entry-title">{entry.title}</div>
                            <div className="history-entry-meta">{entry.year} · {entry.type}</div>
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
                            {entry.rated === 'up' && (
                              <span className="history-vote vote-up" role="img" aria-label="Liked">👍</span>
                            )}
                            {entry.rated === 'down' && (
                              <span className="history-vote vote-down" role="img" aria-label="Disliked">👎</span>
                            )}
                            {(!entry.rated || entry.rated === 'skip') && (
                              <span className="history-vote vote-pending" aria-label="Not rated yet">•••</span>
                            )}
                            <div className="history-rating" aria-label={`Rated ${entry.rating} out of 10`}>
                              <span className="history-stars" aria-hidden="true">★</span>
                              <span aria-hidden="true"> {entry.rating}</span>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                    <button className="history-clear" onClick={clearHistory}>
                      Clear history
                    </button>
                  </>
                )}
              </>
            ) : (
              /* Saved tab */
              savedForLater.length === 0 ? (
                <div className="history-empty">
                  <div className="history-empty-icon" aria-hidden="true">★</div>
                  <div className="history-empty-text">No saved picks yet</div>
                  <div className="history-empty-sub">Tap ☆ on any result to save it for later</div>
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
                          <button
                            className="saved-remove-btn"
                            onClick={e => { e.stopPropagation(); toggleSaveForLater(entry); }}
                            aria-label={`Remove ${entry.title} from saved`}
                          >
                            ★
                          </button>
                          <div className="history-rating" aria-label={`Rated ${entry.rating} out of 10`}>
                            <span className="history-stars" aria-hidden="true">★</span>
                            <span aria-hidden="true"> {entry.rating}</span>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                  <button className="history-clear" onClick={() => {
                    setSavedForLater([]);
                    localStorage.removeItem('settle-saved');
                    // Authoritative overwrite (see clearHistory for rationale).
                    flushAuthoritativeSync({ savedForLater: [] });
                  }}>
                    Clear saved
                  </button>
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
                        <span className="partner-saved-star" aria-hidden="true">★</span>
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
                  alt=""
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
              {cinemaSource === 'pick' && <div className="cinema-stamp" aria-hidden="true">{pickLabel(mode)} 🎬</div>}
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
                        openShowtimesFlow();
                      }}
                      style={{ background: getServiceColor(cinemaItem.service) }}
                    >
                      🎟️ Get tickets
                    </button>
                  </div>
                );
              }
              const useWatchmode = cinemaSource === 'pick' && (cinemaItem.service === 'Disney+' || cinemaItem.service === 'Apple TV');
              // Prefer Watchmode's direct title deep-link when we have it;
              // otherwise fall through to the platform's search-page URL so
              // Disney+ / Apple TV picks never end up with a missing "Open
              // on X" button when Watchmode fails to resolve the title.
              const href = (useWatchmode && watchLink) || getPlatformLink(cinemaItem.service, cinemaItem.title);
              return href ? (
                <div className="cinema-actions">
                  <a
                    className="cinema-watch-btn"
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ background: getServiceColor(cinemaItem.service) }}
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
        <div className="toast" role="status">Link copied to clipboard!</div>
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
