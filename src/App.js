import React, { useState, useEffect, useRef, useMemo } from 'react';
import { flushSync } from 'react-dom';
import tmdbService from './services/tmdb';
import watchmodeService from './services/watchmode';
import { generateShareCard } from './utils/shareCard';
import { trackAppLoaded, trackPickGenerated, trackConsentRevoked, trackAccountDeleted } from './services/analytics';
import AuthGate from './components/AuthGate';
import Onboarding from './components/Onboarding';
import Settings from './components/Settings';
import { PrivacyBody, TermsBody } from './components/LegalContent';
import { onAuthChange, signOut, deleteCurrentUser } from './services/auth';
import { migrateLocalToCloud, pushUserData, pushUserDataAuthoritative, buildPayload, deleteUserData } from './services/cloudSync';
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

const STEAMY_KEYWORDS = '256466|738|3182|286925|41404|41260|278555|298666';

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

const MOODS = [
  { emoji: '😂', label: 'Fun',        ids: [35, 16] },
  { emoji: '❤️', label: 'Romantic',   ids: [10749, 18] },
  { emoji: '😱', label: 'Scary',      ids: [27, 53] },
  { emoji: '💥', label: 'Thrilling',  ids: [28, 12, 80] },
  { emoji: '😢', label: 'Emotional',  ids: [18, 36] },
  { emoji: '🧠', label: 'Thoughtful', ids: [99, 9648] },
  { emoji: '🍿', label: 'Easy Watch', ids: [10751, 35, 'anime'] },
  { emoji: '🔥', label: 'Steamy',     ids: ['steamy'] },
];
const ANIME_KEYWORD = '210024';

const SERVICES = [
  { name: 'Netflix',      color: '#E50914' },
  { name: 'Prime Video',  color: '#00A8E1' },
  { name: 'Disney+',      color: '#1B3CC0' },
  { name: 'Apple TV',     color: '#A2AAAD' },
  { name: 'Max',          color: '#6A1BD0' },
];

// Returns a time-aware mood greeting so the label feels natural at any hour.
// 5 am–11 am  → morning   |  12 pm–5 pm → afternoon
// 6 pm–8 pm   → evening   |  9 pm–4 am  → tonight
const getMoodGreeting = () => {
  const hour = new Date().getHours();
  if (hour >= 5  && hour < 12) return 'How are you feeling this morning?';
  if (hour >= 12 && hour < 18) return 'How are you feeling this afternoon?';
  if (hour >= 18 && hour < 21) return 'How are you feeling this evening?';
  return 'How are you feeling tonight?';
};

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
    return { solo: [], p1: [], p2: [], theater: [], ...saved };
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
  const [welcomeBack] = useState(() => Object.keys(loadPrefs()).length > 0);
  const [watchLink, setWatchLink] = useState(null);
  // Theater-specific enrichment — cert (G/PG/PG-13/R) + wide vs limited release.
  // Fetched lazily per pick, like collection data. null while loading or not theater.
  const [theaterReleaseInfo, setTheaterReleaseInfo] = useState(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [noMoodSelected, setNoMoodSelected] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [fetchErrorType, setFetchErrorType] = useState(null); // 'timeout' | 'network'
  const [genreError, setGenreError] = useState(false);
  const [importError, setImportError] = useState(false);
  const [maxCertification, setMaxCertification] = useState(() => loadPrefs().maxCertification || null);
  const [maxRuntime, setMaxRuntime] = useState(() => loadPrefs().maxRuntime || null);
  const [shareCopied, setShareCopied] = useState(false);

  const [showShareModal, setShowShareModal] = useState(false);
  const [shareCardUrl, setShareCardUrl] = useState(null);
  const [shareCardLoading, setShareCardLoading] = useState(false);
  const [shareCardReady, setShareCardReady] = useState(false);
  const shareItemRef = useRef(null);
  const shareCanvasRef = useRef(null);
  const sharePreviewRef = useRef(null);
  const importFileRef = useRef(null);
  const [importSuccess, setImportSuccess] = useState(false);
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
  const ratingPopupRef  = useRef(null);
  const cinemaCardRef   = useRef(null);
  const ballotCardRef   = useRef(null);
  const privacyModalRef = useRef(null);
  const termsModalRef   = useRef(null);
  const shareModalRef   = useRef(null);

  useFocusTrap(historyPanelRef, showHistory);
  useFocusTrap(ratingPopupRef,  !!ratingPopup);
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
      if ('maxRuntime' in p)                 setMaxRuntime(p.maxRuntime);
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
        maxCertification, maxRuntime,
      }));
    }, 2000);
    return () => { if (syncTimerRef.current) clearTimeout(syncTimerRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, consent, tasteProfile, recentPicks, savedForLater, watchHistory,
      playerNames, mode, selectedServices, selectedGenres, selectedFormats,
      minRating, maxCertification, maxRuntime]);

  // Global Escape-to-close for any open overlay/modal (a11y: 2.1.2 No Keyboard Trap)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (showSettings)   { setShowSettings(false); return; }
      if (showShareModal) { closeShareModal(); return; }
      if (showPrivacy)    { setShowPrivacy(false); return; }
      if (showTerms)      { setShowTerms(false); return; }
      if (showHistory)    { setShowHistory(false); return; }
      if (ratingPopup)    { handleVote('skip'); return; }
      if (cinemaMode)     { setCinemaMode(false); setReplayResult(null); return; }
      if (showBallot)     { setShowBallot(false); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showShareModal, showPrivacy, showTerms, showHistory, ratingPopup, cinemaMode, showBallot, showSettings]);

  // Lock body scroll while any modal is open — prevents the underlying app from
  // scrolling on iOS when the user drags inside the overlay. Restores the prior
  // value on close so we don't fight other scripts that might set overflow.
  useEffect(() => {
    const anyOpen =
      showOnboarding || showHistory || showShareModal || showPrivacy ||
      showTerms || showBallot || cinemaMode || !!ratingPopup || showSettings;
    if (anyOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [showOnboarding, showHistory, showShareModal, showPrivacy, showTerms,
      showBallot, cinemaMode, ratingPopup, showSettings]);

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

  // Show rating popup on mount for entries that have never been rated.
  // 'skip' is treated as a permanent decision — the popup never re-fires for it.
  useEffect(() => {
    const unrated = watchHistory.find(entry => !entry.rated);
    if (!unrated) return;
    const t = setTimeout(() => setRatingPopup(unrated), 800);
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
      maxRuntime
    }));
  }, [mode, selectedServices, selectedGenres, selectedFormats, minRating, maxCertification, maxRuntime, consent]);

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
        { id: 'steamy', name: 'Steamy 🔥' }
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
    // explicitly activated it (all its IDs are present) — not just because one
    // shared genre ID (e.g. Comedy=35 appears in both Fun and Easy Watch) causes
    // a false match against a mood the user never selected.
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

  const savePlayerName = (player, value) => {
    const name = value.trim() || (player === 'p1' ? 'Him' : 'Her');
    const updated = { ...playerNames, [player]: name };
    setPlayerNames(updated);
    if (consent) safeSet('streaming-player-names', JSON.stringify(updated));
    setEditingPlayer(null);
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
  // Packages all meaningful user data into a dated JSON file the user can save
  // locally. Import reads it back and restores every piece of state + localStorage.
  // This is a stop-gap against localStorage wipe until cloud sync ships.
  const handleExportData = () => {
    const exportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      tasteProfile,
      watchHistory,
      savedForLater,
      recentPicks,
      playerNames,
      prefs: {
        mode,
        services: selectedServices,
        genres: selectedGenres,
        formats: selectedFormats,
        minRating,
        maxCertification,
      },
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `settle-profile-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImportData = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data.version || !data.tasteProfile) throw new Error('Invalid format');

        if (data.tasteProfile) {
          setTasteProfile(data.tasteProfile);
          safeSet('streaming-taste-profile', JSON.stringify(data.tasteProfile));
        }
        if (data.watchHistory) {
          setWatchHistory(data.watchHistory);
          safeSet('streaming-history', JSON.stringify(data.watchHistory));
        }
        if (data.savedForLater) {
          setSavedForLater(data.savedForLater);
          safeSet('settle-saved', JSON.stringify(data.savedForLater));
        }
        if (data.recentPicks) {
          setRecentPicks(data.recentPicks);
          safeSet('streaming-seen', JSON.stringify(data.recentPicks));
        }
        if (data.playerNames) {
          setPlayerNames(data.playerNames);
          safeSet('streaming-player-names', JSON.stringify(data.playerNames));
        }
        if (data.prefs) {
          const p = data.prefs;
          if (p.services) setSelectedServices(p.services);
          if (p.genres)   setSelectedGenres({ solo: [], p1: [], p2: [], theater: [], ...p.genres });
          if (p.formats)  setSelectedFormats(p.formats);
          if (p.minRating !== undefined) setMinRating(p.minRating);
        }

        setImportSuccess(true);
        setTimeout(() => setImportSuccess(false), 3000);

        // Import is canonical — push the imported arrays authoritatively so
        // the cloud copy is replaced rather than additively merged with the
        // pre-import state.
        flushAuthoritativeSync({
          ...(data.watchHistory  != null && { watchHistory:  data.watchHistory  }),
          ...(data.savedForLater != null && { savedForLater: data.savedForLater }),
          ...(data.recentPicks   != null && { recentPicks:   data.recentPicks   }),
        });
      } catch {
        setImportError(true);
        setTimeout(() => setImportError(false), 4000);
      }
      // Reset so the same file can be re-imported if needed
      e.target.value = '';
    };
    reader.readAsText(file);
  };

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

  const openBallot = () => {
    setBallotStep('p1');
    setP1Vote(null);
    setP2Vote(null);
    setShowBallot(true);
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
  };

  // Opens the share modal and generates the card
  const handleShare = async (item) => {
    shareItemRef.current = item;
    setShareCardUrl(null);
    setShareCardReady(false);
    shareCanvasRef.current = null;
    setShareCardLoading(true);
    setShowShareModal(true);
    try {
      const resolvedGenres = (item.genres || [])
        .map(id => genreById.get(id))
        .filter(Boolean)
        .slice(0, 4);
      const canvas = await generateShareCard({ result: { ...item, genres: resolvedGenres }, mode, playerNames });
      shareCanvasRef.current = canvas;
      try {
        setShareCardUrl(canvas.toDataURL('image/png'));
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
    const isCouple = mode === 'couple';
    const verb = isCouple ? "We're watching" : "Tonight's pick:";
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
  // Only available on mobile browsers that support the Web Share API with files.
  const shareImageCard = async () => {
    const canvas = shareCanvasRef.current;
    if (!canvas) return;
    const item = shareItemRef.current;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const file = new File([blob], 'settle-pick.png', { type: 'image/png' });

    if (navigator.canShare?.({ files: [file] })) {
      // 1. Mark share in progress in sessionStorage — survives bfcache freeze
      //    and live-background alike, cleared by whichever return signal fires.
      sessionStorage.setItem('settle_sharing', '1');
      // 2. flushSync commits the modal-close to the DOM synchronously so the
      //    bfcache snapshot (taken when iOS switches to Instagram) is clean.
      try { flushSync(() => closeShareModal()); } catch { closeShareModal(); }
      // 3. Hand off to the OS share sheet.
      try {
        await navigator.share({ files: [file], title: item?.title });
      } catch {}
      // 4. If we're still in-app (Android / cancelled), clear the flag now.
      sessionStorage.removeItem('settle_sharing');
    }
  };

  const pickContent = async (hiddenGems = false, coinFlip = false) => {
    if (mode !== 'theater' && selectedServices.length === 0) {
      setHasSearched(true);
      setMatchCount(0);
      return;
    }

    // Require at least one mood to be selected before fetching.
    // Hidden gems intentionally bypass genre filtering, but we still
    // want users to confirm intent — skip the guard for that path.
    if (!hiddenGems) {
      const hasMood =
        mode === 'couple'
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
      const activeGenresForFetch = hiddenGems ? [] : activeGenres;

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

        for (const service of selectedServices) {
          for (const format of activeFormats) {
            const type = format === 'Movie' ? 'movie' : 'tv';

            if (activeGenresForFetch.length === 0) {
              fetchFns.push(() =>
                tmdbService.discoverContent({
                  service,
                  type,
                  minRating: hiddenGems ? 0 : minRating,
                  hiddenGems,
                  maxCertification: hiddenGems ? null : maxCertification,
                  maxRuntime: (hiddenGems || type !== 'movie') ? null : maxRuntime
                })
              );
            } else {
              // Split keyword-based special genres (steamy, anime) from regular
              // TMDB genre IDs. Regular IDs are combined into one OR query
              // (e.g. "35|16") so we fire 1 request per service+format instead
              // of N requests — reduces peak burst from ~20 to ~10.
              const regularIds = activeGenresForFetch.filter(id => id !== 'steamy' && id !== 'anime');
              const specialIds = activeGenresForFetch.filter(id => id === 'steamy' || id === 'anime');

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
                    maxRuntime: type !== 'movie' ? null : maxRuntime
                  })
                );
              }

              for (const id of specialIds) {
                const isSteamy = id === 'steamy';
                fetchFns.push(() =>
                  tmdbService.discoverContent({
                    service,
                    type,
                    genre: null,
                    keywords: isSteamy ? STEAMY_KEYWORDS : ANIME_KEYWORD,
                    minRating,
                    hiddenGems: false,
                    maxCertification,
                    maxRuntime: type !== 'movie' ? null : maxRuntime
                  })
                );
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

      // Genre filter
      const virtualGenres = ['steamy', 'anime'];
      const realGenres = activeGenresForFetch.filter(id => !virtualGenres.includes(id));
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
      setRecentPicks(prev => {
        const updated = [...prev.filter(id => id !== picked.id), picked.id].slice(-100);
        if (consent) safeSet('streaming-seen', JSON.stringify(updated));
        return updated;
      });
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
      'Apple TV':     `https://tv.apple.com/search?term=${q}`,
      'Prime Video':  `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${q}`,
      'In Theaters':  `https://www.google.com/search?q=${q}+movie+showtimes`,
    };
    return links[service] || null;
  };

  const saveToHistory = (item, { coupleAgreed = false } = {}) => {
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
      mode,
      coupleAgreed,
      rated: null
    };
    setWatchHistory(prev => {
      const filtered = prev.filter(h => h.id !== item.id);
      const updated = [entry, ...filtered].slice(0, 30);
      if (consent) safeSet('streaming-history', JSON.stringify(updated));
      return updated;
    });
    setShowToast(true);
    setTimeout(() => setShowToast(false), 2800);
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
            ? current + 2
            : Math.max(0, current - 1);
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
          ? { ...entry, rated: vote }
          : entry
      );
      if (consent) safeSet('streaming-history', JSON.stringify(updated));
      return updated;
    });
    if (vote !== 'skip') {
      updateTasteProfile(ratingPopup.genres || [], vote, ratingPopup.mode);
    }
    setRatingPopup(null);
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
      maxCertification, maxRuntime,
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

      {/* Account bar — user identity + sign-out */}
      <div className="account-bar">
        <span className="account-email" title={user.email || user.displayName || ''}>
          {user.photoURL
            ? <img className="account-avatar" src={user.photoURL} alt="" aria-hidden="true" referrerPolicy="no-referrer" />
            : <span className="account-avatar-fallback" aria-hidden="true">👤</span>
          }
          <span className="account-name">
            {user.displayName || user.email?.split('@')[0] || 'Account'}
          </span>
        </span>
        <div className="account-bar-right">
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
          {mode === 'couple' && streakInfo ? (
            <span className="account-stat account-streak" title={`${streakInfo}-night streak`} aria-label={`${streakInfo}-night streak`}>
              <span aria-hidden="true">🔥</span> {streakInfo}
            </span>
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
          onClose={() => setShowSettings(false)}
          onWithdrawConsent={handleWithdrawConsent}
          onDeleteAccount={handleDeleteAccount}
          onSavePlayerNames={savePlayerName}
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
              {mode === 'theater' ? 'What are you in the mood for?' : getMoodGreeting()}
            </div>
            <div className="mood-grid" role="group" aria-labelledby="mood-greeting-label">
              {MOODS.map(mood => (
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
            {/* Pinned "your top genres" — only shown when the user has built
                a taste profile (>=2 score on at least one genre). Surfaces
                their gravitational center above the More-genres toggle. */}
            {(() => {
              const slot = moodPlayer === 'theater' ? 'solo' : moodPlayer;
              const top = topGenresByPlayer[slot];
              if (!top || top.length === 0) return null;
              return (
                <div className="top-genres-row" role="group" aria-label="Your top genres">
                  <span className="top-genres-label">Your top genres</span>
                  <div className="top-genres-chips">
                    {top.map(genre => {
                      const active = activeSlot.includes(genre.id);
                      return (
                        <button
                          type="button"
                          key={genre.id}
                          className={`chip top-genre-chip ${getGenreClass(genre.id, moodPlayer)}`}
                          onClick={() => handleGenreClick(genre.id, moodPlayer)}
                          aria-pressed={active}
                        >
                          {genre.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
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
                  return (
                    <button
                      type="button"
                      key={genre.id}
                      className={`chip ${getGenreClass(genre.id, moodPlayer)}`}
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
            {/* Pinned "your top genres" — per-player in couples mode so each
                partner sees their own taste signal. */}
            {(() => {
              const top = topGenresByPlayer[activePlayer];
              if (!top || top.length === 0) return null;
              return (
                <div className="top-genres-row" role="group" aria-label={`${playerNames[activePlayer]}'s top genres`}>
                  <span className="top-genres-label">{playerNames[activePlayer]}'s top genres</span>
                  <div className="top-genres-chips">
                    {top.map(genre => {
                      const active = selectedGenres[activePlayer]?.includes(genre.id);
                      return (
                        <button
                          type="button"
                          key={genre.id}
                          className={`chip top-genre-chip ${getGenreClass(genre.id, activePlayer)}`}
                          onClick={() => handleGenreClick(genre.id, activePlayer)}
                          aria-pressed={active}
                        >
                          {genre.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
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
                  return (
                    <button
                      type="button"
                      key={genre.id}
                      className={`chip ${getGenreClass(genre.id, activePlayer)}`}
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

      {mode !== 'theater' && selectedFormats.includes('Movie') && (
        <div className="section">
          <div className="label" id="runtime-label">Movie Length</div>
          <div className="cert-row" role="radiogroup" aria-labelledby="runtime-label">
            {[
              { label: 'Any length', value: null, aria: 'Any length' },
              { label: '⏱ Under 90 min', value: 90, aria: 'Under 90 minutes' },
              { label: '⏱ Under 2 hrs', value: 120, aria: 'Under 2 hours' },
            ].map(opt => {
              const active = maxRuntime === opt.value;
              return (
                <button
                  type="button"
                  key={opt.label}
                  className={`cert-chip ${active ? 'cert-on' : ''}`}
                  onClick={() => setMaxRuntime(opt.value)}
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
                  <div className="result-year">{result.year} · {result.type}</div>
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
              <div className="rating-row" aria-label={`Rated ${result.rating} out of 10, ${result.votes} ratings`}>
                <span className="stars" aria-hidden="true">{starsFromRating(result.rating)}</span>
                <span className="rating-num" aria-hidden="true">{result.rating}/10</span>
                <span className="rating-sub" aria-hidden="true">· {result.votes} ratings</span>
              </div>
              {pickReason && (
                <div className="pick-reason">{pickReason}</div>
              )}
              <div className="desc">{result.description}</div>
              <div className="act-row">
                <button className="act" onClick={() => { setTryAnotherCount(c => c + 1); pickContent(false); }}>
                  Try another
                </button>
                {mode === 'couple' ? (
                  <button className="act primary ballot-trigger" onClick={openBallot}>
                    <span aria-hidden="true">🗳️</span> Secret Vote
                  </button>
                ) : (
                  <button className="act primary" onClick={() => { setTryAnotherCount(0); setCinemaSource('pick'); setCinemaMode(true); saveToHistory(result); }}>
                    We're watching this <span aria-hidden="true">✓</span>
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
        <button
          className="history-btn"
          onClick={() => setShowHistory(true)}
          aria-label={watchHistory.length > 0 ? `Watch history — ${watchHistory.length} watched` : 'Watch history'}
        >
          <span aria-hidden="true">🕐</span> {watchHistory.length > 0 ? `${watchHistory.length} watched` : 'History'}
        </button>
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
                    <div className="history-empty-sub">Make your first pick and tap "We're watching this"</div>
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

            {/* Data management — always visible at panel bottom */}
            <div className="history-data-actions">
              <button className="data-action-btn" onClick={handleExportData}>
                ↓ Export data
              </button>
              <label className="data-action-btn data-action-import">
                ↑ Import
                <input
                  ref={importFileRef}
                  type="file"
                  accept=".json"
                  style={{ display: 'none' }}
                  onChange={handleImportData}
                />
              </label>
              {importSuccess && (
                <span className="import-success" role="status">✓ Profile restored</span>
              )}
              {importError && (
                <span className="import-error" role="alert">⚠️ Invalid file — please use a Settle export</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Rating popup */}
      {ratingPopup && (
        <div className="rating-overlay" onClick={() => handleVote('skip')}>
          <div
            ref={ratingPopupRef}
            className="rating-popup"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="rating-popup-title"
            tabIndex={-1}
          >
            <h2 id="rating-popup-title" className="rating-popup-eyebrow">How was it?</h2>
            <div className="rating-popup-card">
              {ratingPopup.posterPath ? (
                <img
                  className="rating-popup-poster"
                  src={tmdbService.getPosterUrl(ratingPopup.posterPath, 'w92')}
                  alt=""
                />
              ) : (
                <div className="rating-popup-poster rating-popup-poster-placeholder" aria-hidden="true">🎬</div>
              )}
              <div className="rating-popup-info">
                <div className="rating-popup-title">{ratingPopup.title}</div>
                <div className="rating-popup-meta">{ratingPopup.year} · {ratingPopup.type}</div>
              </div>
            </div>
            <div className="rating-popup-actions">
              <button
                className="vote-btn vote-up"
                onClick={() => handleVote('up')}
                aria-label={`Liked ${ratingPopup.title}`}
              >
                <span aria-hidden="true">👍</span>
              </button>
              <button
                className="vote-btn vote-down"
                onClick={() => handleVote('down')}
                aria-label={`Disliked ${ratingPopup.title}`}
              >
                <span aria-hidden="true">👎</span>
              </button>
            </div>
            <button className="rating-skip" onClick={() => handleVote('skip')}>
              Skip
            </button>
          </div>
        </div>
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
              {cinemaSource === 'pick' && <div className="cinema-stamp" aria-hidden="true">Tonight's Pick 🎬</div>}
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
              const useWatchmode = cinemaSource === 'pick' && (cinemaItem.service === 'Disney+' || cinemaItem.service === 'Apple TV');
              const href = useWatchmode ? watchLink : getPlatformLink(cinemaItem.service, cinemaItem.title);
              return href ? (
                <div className="cinema-actions">
                  <a
                    className="cinema-watch-btn"
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ background: getServiceColor(cinemaItem.service) }}
                  >
                    ▶ Open on {cinemaItem.service === 'In Theaters' ? 'Google' : cinemaItem.service}
                  </a>
                </div>
              ) : null;
            })()}
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
                      <div className="ballot-outcome-title">Not tonight...</div>
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
                      🎲 Let fate decide tonight
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
