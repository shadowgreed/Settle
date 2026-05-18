import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

const userDoc = (uid) => doc(db, 'users', uid);

// ── Pull ─────────────────────────────────────────────────────────────────────
// Returns the stored profile object, or null if this is a brand-new account.
export const pullUserData = async (uid) => {
  try {
    const snap = await getDoc(userDoc(uid));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.error('[Sync] Pull failed:', err.message);
    return null;
  }
};

// ── Push ─────────────────────────────────────────────────────────────────────
// Writes the full profile with merge:true so concurrent writes from other
// devices don't wipe fields we didn't touch in this session.
export const pushUserData = async (uid, payload) => {
  try {
    await setDoc(userDoc(uid), {
      ...payload,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    console.error('[Sync] Push failed:', err.message);
  }
};

// ── Payload builder ───────────────────────────────────────────────────────────
// Shapes current app state into the Firestore document structure.
export const buildPayload = (state) => ({
  tasteProfile:  state.tasteProfile,
  recentPicks:   state.recentPicks,
  savedForLater: state.savedForLater,
  watchHistory:  state.watchHistory,
  playerNames:   state.playerNames,
  consent:       state.consent,
  onboarded:     true,
  prefs: {
    mode:             state.mode,
    services:         state.selectedServices,
    genres:           state.selectedGenres,
    formats:          state.selectedFormats,
    minRating:        state.minRating,
    maxCertification: state.maxCertification ?? null,
    maxRuntime:       state.maxRuntime ?? null,
  },
});

// ── First-login merge ─────────────────────────────────────────────────────────
// When a user signs in for the first time on a device that already has local
// data, migrate that data to the cloud so it isn't lost.
// Strategy: if the cloud has a profile, cloud wins. If cloud is empty, push local.
export const migrateLocalToCloud = async (uid) => {
  const cloudData = await pullUserData(uid);
  if (cloudData) return cloudData; // cloud is canonical — use it

  // No cloud data yet — promote localStorage to cloud
  const local = readLocalData();
  if (local) {
    await pushUserData(uid, local);
    return local;
  }
  return null;
};

// Read everything from localStorage into the payload shape.
const readLocalData = () => {
  const safe = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  };

  const prefs = safe('streaming-prefs', {});
  return {
    tasteProfile:  safe('streaming-taste-profile', { solo: {}, p1: {}, p2: {} }),
    recentPicks:   safe('streaming-seen', []),
    savedForLater: safe('settle-saved', []),
    watchHistory:  safe('streaming-history', []),
    playerNames:   safe('streaming-player-names', { p1: 'Him', p2: 'Her' }),
    consent:       localStorage.getItem('sd_consent') === 'true',
    onboarded:     localStorage.getItem('sd_onboarded') === 'true',
    prefs: {
      mode:             prefs.mode             ?? 'solo',
      services:         prefs.services         ?? [],
      genres:           prefs.genres           ?? { solo: [], p1: [], p2: [], theater: [] },
      formats:          prefs.formats          ?? ['Movie', 'Series'],
      minRating:        prefs.minRating        ?? 0,
      maxCertification: prefs.maxCertification ?? null,
      maxRuntime:       prefs.maxRuntime       ?? null,
    },
  };
};
