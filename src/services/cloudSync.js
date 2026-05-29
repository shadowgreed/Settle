import { doc, getDoc, setDoc, deleteDoc, runTransaction, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

const userDoc = (uid) => doc(db, 'users', uid);

// Delete the user's Firestore document. Used by the account-deletion flow.
// Throws on failure so the caller can show an error state instead of
// silently telling the user their data is gone.
export const deleteUserData = async (uid) => {
  await deleteDoc(userDoc(uid));
};

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

// ── Push (additive merge) ────────────────────────────────────────────────────
// Default sync path. Runs in a Firestore transaction so two tabs adding picks
// concurrently can't clobber each other's writes:
//   • watchHistory + savedForLater are merged by `id` — local wins on
//     conflict (the local entry is fresher, e.g. has the latest vote).
//   • recentPicks is a set-union (IDs only, capped at 100).
//   • All other fields take the local value (last writer wins per field).
//
// NOTE: this is "additive" — if a user removes an entry locally, it would be
// re-added from the cloud copy. Explicit clears/removes must call
// pushUserDataAuthoritative() instead so cloud is overwritten, not merged.
export const pushUserData = async (uid, payload) => {
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(userDoc(uid));
      const cloud = snap.exists() ? snap.data() : {};
      tx.set(userDoc(uid), {
        ...payload,
        watchHistory:  mergeArrayById(cloud.watchHistory,  payload.watchHistory),
        savedForLater: mergeArrayById(cloud.savedForLater, payload.savedForLater),
        recentPicks:   mergeIdSet(cloud.recentPicks, payload.recentPicks, 100),
        updatedAt:     serverTimestamp(),
      }, { merge: true });
    });
  } catch (err) {
    console.error('[Sync] Push (merge) failed:', err.message);
  }
};

// ── Push (authoritative overwrite) ───────────────────────────────────────────
// Used when the local state is the canonical truth — e.g. after a "Clear
// history" or "Remove all saved picks" action. Skips the merge transaction
// and overwrites the cloud arrays directly so a concurrent tab can't
// resurrect entries the user just deleted.
//
// Still uses { merge: true } at the field level so untouched top-level fields
// (e.g. tasteProfile, prefs) aren't wiped.
export const pushUserDataAuthoritative = async (uid, payload) => {
  try {
    await setDoc(userDoc(uid), {
      ...payload,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    console.error('[Sync] Push (authoritative) failed:', err.message);
  }
};

// Union two arrays of objects by `id` field. Local entry wins on conflict
// because the local copy reflects the most recent vote/state from this tab.
function mergeArrayById(cloudArr, localArr) {
  if (!Array.isArray(cloudArr) && !Array.isArray(localArr)) return [];
  const map = new Map();
  (cloudArr || []).forEach(item => { if (item && item.id != null) map.set(item.id, item); });
  (localArr || []).forEach(item => { if (item && item.id != null) map.set(item.id, item); });
  return Array.from(map.values());
}

// Union two arrays of primitives (IDs) into a set, cap to most recent N.
// "Recent" here means later in the array — recentPicks already appends.
function mergeIdSet(cloudArr, localArr, cap) {
  const combined = [...(cloudArr || []), ...(localArr || [])];
  const seen = new Set();
  const out = [];
  // Iterate from the end so the most recent occurrence wins position.
  for (let i = combined.length - 1; i >= 0; i--) {
    const id = combined[i];
    if (!seen.has(id)) {
      seen.add(id);
      out.unshift(id);
    }
  }
  return out.slice(-cap);
}

// ── Payload builder ───────────────────────────────────────────────────────────
// Shapes current app state into the Firestore document structure.
//
// Note: `pushSubscriptions` is intentionally NOT written by buildPayload.
// Push subscriptions are managed by src/services/push.js via arrayUnion /
// arrayRemove on the user doc, and a regular merge:true write here would
// preserve them. Don't ever add them to this payload — would race with
// per-device subscribe/unsubscribe operations.
export const buildPayload = (state) => ({
  tasteProfile:  state.tasteProfile,
  recentPicks:   state.recentPicks,
  savedForLater: state.savedForLater,
  watchHistory:  state.watchHistory,
  playerNames:   state.playerNames,
  // displayName is the Firebase Auth identity (Google display name or email
  // prefix). Stored here so linked partners can read a real name rather than
  // the couples-ballot label (playerNames.p1 = "Him"/"Her" by default).
  displayName:   state.displayName   || null,
  consent:       state.consent,
  onboarded:     true,
  prefs: {
    mode:             state.mode,
    services:         state.selectedServices,
    genres:           state.selectedGenres,
    formats:          state.selectedFormats,
    minRating:        state.minRating,
    maxCertification: state.maxCertification ?? null,
    // maxRuntime removed — runtime filter retired in P2.2 (runtime now
    // surfaced on the result card metadata row instead).
  },
});

// ── First-login merge ─────────────────────────────────────────────────────────
// When a user signs in for the first time on a device that already has local
// data, migrate that data to the cloud so it isn't lost.
// Strategy: if the cloud has a profile, cloud wins. If cloud is empty, push local.
// Caller is responsible for guaranteeing the local data belongs to this account
// (App.js clears localStorage on signOut to prevent cross-account leakage).
export const migrateLocalToCloud = async (uid) => {
  const cloudData = await pullUserData(uid);
  if (cloudData) return cloudData; // cloud is canonical — use it

  // No cloud data yet — promote localStorage to cloud (only if it looks like
  // a real user with at least one persisted preference, to avoid pushing
  // an empty default payload from a brand-new device.)
  const local = readLocalData();
  if (local && hasMeaningfulData(local)) {
    await pushUserData(uid, local);
    return local;
  }
  return null;
};

// True if local data contains anything worth preserving — at least one
// taste vote, history entry, saved pick, or non-default preference.
const hasMeaningfulData = (local) => {
  if (!local) return false;
  const profileNonEmpty = Object.values(local.tasteProfile || {}).some(
    p => p && Object.keys(p).length > 0
  );
  return (
    profileNonEmpty
    || (local.watchHistory?.length ?? 0) > 0
    || (local.savedForLater?.length ?? 0) > 0
    || (local.recentPicks?.length ?? 0) > 0
    || local.onboarded === true
  );
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
      // maxRuntime intentionally dropped — runtime filter retired in P2.2.
    },
  };
};
