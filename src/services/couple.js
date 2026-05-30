// ─────────────────────────────────────────────────────────────────────────────
// Couple-mode services — Firestore CRUD for partner linking and async ballots.
//
// Data model:
//   users/{uid}.couplePartnerUid  — uid of the linked partner (string | null)
//   users/{uid}.couplePendingCode — code P1 is currently showing (string | null)
//
//   pendingBallots/{ballotId}     — async ballot document
//     initiatorUid  string
//     partnerUid    string
//     title         { id, title, year, type, service, posterPath, rating, genres }
//     initiatorVote 'up' | 'down'
//     partnerVote   null | 'up' | 'down'
//     status        'pending' | 'matched' | 'missed' | 'expired'
//     createdAt     Timestamp
//     expiresAt     Timestamp    (48 h from creation)
//     initiatorName string
//     partnerName   string
// ─────────────────────────────────────────────────────────────────────────────

import {
  doc, setDoc, updateDoc, getDoc,
  collection, query, where,
  onSnapshot, Timestamp, addDoc, runTransaction,
} from 'firebase/firestore';
import { db } from './firebase';
import { authHeader } from './authHeader';

const userRef  = (uid) => doc(db, 'users', uid);
const ballotsRef = () => collection(db, 'pendingBallots');

const BALLOT_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

// ── Partner linking ───────────────────────────────────────────────────────────

/**
 * Write couplePartnerUid to the current user's own doc. Called by both P1
 * and P2 once linking is confirmed (each writes their own doc only).
 */
export async function savePartnerLink(uid, partnerUid) {
  await setDoc(userRef(uid), { couplePartnerUid: partnerUid }, { merge: true });
}

/**
 * Clear couplePartnerUid from the current user's doc (unlink).
 */
export async function clearPartnerLink(uid) {
  await setDoc(userRef(uid), { couplePartnerUid: null }, { merge: true });
}

/**
 * Generate an invite code via the server API. Returns the code string.
 */
export async function generateInviteCode(displayName) {
  const res = await fetch('/api/couple/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) throw new Error(`code generation failed: ${res.status}`);
  const { code } = await res.json();
  return code;
}

/**
 * Verify an invite code P2 typed. Returns { partnerUid, partnerName }.
 * Throws on invalid/expired code.
 */
export async function verifyInviteCode(code) {
  const res = await fetch('/api/couple/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ code }),
  });
  const json = await res.json();
  if (!res.ok) {
    if (res.status === 404) throw new Error('Code not found or expired. Check it and try again.');
    if (res.status === 409) throw new Error("That's your own code. Share it with your partner.");
    throw new Error(json.error || 'Verification failed');
  }
  return json; // { partnerUid, partnerName }
}

/**
 * Check if a pending link is waiting for this user (P1 discovers P2's link).
 * Returns { partnerUid } or { partnerUid: null }.
 */
export async function checkPendingLink() {
  try {
    const res = await fetch('/api/couple/pending', { headers: await authHeader() });
    if (!res.ok) return { partnerUid: null };
    return res.json();
  } catch {
    return { partnerUid: null };
  }
}

/**
 * Read a partner's user doc to get their display name and savedForLater.
 * Requires the Firestore rules to allow partner-read (see firestore.rules).
 * Returns null on failure.
 */
export async function readPartnerDoc(partnerUid) {
  try {
    const snap = await getDoc(userRef(partnerUid));
    return snap.exists() ? snap.data() : null;
  } catch {
    return null;
  }
}

// ── Live two-device ballot ─────────────────────────────────────────────────────
//
// Both partners are linked and (usually) together. P1 starts a ballot on a
// pick; it appears live on P2's device via onSnapshot. Each casts a HIDDEN vote
// on their own phone — neither vote is shown until both are in, then both
// devices reveal together. Status stays 'pending' through the voting phase
// (so the existing Firestore rules apply unchanged), flipping to
// 'matched' / 'missed' only when the second vote lands.

/**
 * P1 starts a LIVE two-device secret ballot for a specific title. Both votes
 * begin null — each partner casts their own hidden vote on their own device.
 * Sends a push to wake P2. Returns the new ballot document ID.
 */
export async function createLiveBallot({
  initiatorUid,
  partnerUid,
  initiatorName,
  partnerName,
  title,
}) {
  const now = Timestamp.now();
  const expiresAt = Timestamp.fromMillis(Date.now() + BALLOT_TTL_MS);

  const docRef = await addDoc(ballotsRef(), {
    initiatorUid,
    partnerUid,
    initiatorName: initiatorName || 'Your partner',
    partnerName:   partnerName   || 'Your partner',
    title: {
      id:         title.id,
      title:      title.title,
      year:       title.year      || null,
      type:       title.type      || null,
      service:    title.service   || null,
      posterPath: title.posterPath || null,
      rating:     title.rating    || null,
      genres:     title.genres    || [],
    },
    initiatorVote: null,
    partnerVote:   null,
    status:        'pending',
    createdAt:     now,
    expiresAt,
  });

  // Best-effort push notification — ballot is in Firestore regardless.
  fetch('/api/ballot/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({
      partnerUid,
      eventType:  'ballot_sent',
      titleName:  title.title,
      senderName: initiatorName || 'Your partner',
      ballotId:   docRef.id,
    }),
  }).catch(() => {});

  return docRef.id;
}

/**
 * Subscribe to incoming (pending) ballots for the current user (P2 side).
 * Calls `onBallot(ballotDoc | null)` whenever the latest pending ballot changes.
 * Returns an unsubscribe function.
 */
export function subscribeToIncomingBallot(uid, onBallot) {
  // IMPORTANT: a single equality filter only — `partnerUid == uid`. Combining a
  // second `where('status'...)` with `orderBy('createdAt')` would require a
  // Firestore COMPOSITE INDEX (not auto-created), and the listener would throw
  // until it's built — so the partner would never discover the ballot. We do the
  // status filter + newest-first selection client-side instead.
  const q = query(ballotsRef(), where('partnerUid', '==', uid));
  return onSnapshot(
    q,
    (snap) => {
      const open = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(b => b.status === 'pending')
        .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
      onBallot(open[0] || null);
    },
    (err) => { console.warn('[couple] ballot listen error:', err?.code || err?.message); onBallot(null); },
  );
}

/**
 * Subscribe to a SPECIFIC ballot document by id. Both partners use this once
 * they're engaged in a live ballot — unlike the query listener above, a direct
 * doc listener keeps firing through the status change to matched/missed, so the
 * reveal isn't lost when the doc drops out of the 'pending' query.
 * Calls `onBallot(ballotDoc | null)`. Returns an unsubscribe function.
 */
export function subscribeBallot(ballotId, onBallot) {
  return onSnapshot(
    doc(db, 'pendingBallots', ballotId),
    (snap) => onBallot(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    () => onBallot(null),
  );
}

/**
 * Cast this device's secret vote in a live ballot.
 *   role: 'initiator' | 'partner'  — which side this device is voting as.
 *   vote: 'up' | 'down'
 *
 * Runs in a transaction so two near-simultaneous votes can't lose an update.
 * When this vote completes the pair, the same write flips status to the outcome.
 * Returns 'matched' | 'missed' if this vote resolved the ballot, else null
 * (partner hasn't voted yet — UI shows a waiting state, driven by the snapshot).
 */
export async function castVote(ballotId, role, vote) {
  const ref = doc(db, 'pendingBallots', ballotId);
  let outcome = null;
  let snapshotData = null;

  await runTransaction(db, async (tx) => {
    // reset per-attempt (transactions can retry)
    outcome = null;
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('ballot no longer exists');
    const data = snap.data();
    snapshotData = data;
    if (data.status !== 'pending') return; // already resolved/expired — no-op

    const myField = role === 'initiator' ? 'initiatorVote' : 'partnerVote';
    const iv = role === 'initiator' ? vote : data.initiatorVote;
    const pv = role === 'partner'   ? vote : data.partnerVote;

    const update = { [myField]: vote };
    if (iv != null && pv != null) {
      outcome = iv === 'up' && pv === 'up' ? 'matched' : 'missed';
      update.status = outcome;
    }
    tx.update(ref, update);
  });

  // On match, best-effort push to the OTHER party in case their app is
  // backgrounded. The reveal itself is driven live by the snapshot.
  if (outcome === 'matched' && snapshotData) {
    const otherUid =
      role === 'initiator' ? snapshotData.partnerUid : snapshotData.initiatorUid;
    const myName =
      role === 'initiator' ? snapshotData.initiatorName : snapshotData.partnerName;
    fetch('/api/ballot/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({
        partnerUid: otherUid,
        eventType:  'ballot_match',
        titleName:  snapshotData.title?.title || 'the pick',
        senderName: myName || 'Your partner',
        ballotId,
      }),
    }).catch(() => {});
  }

  return outcome;
}

/**
 * Dismiss a ballot (P2 chose not to vote, or it's expired).
 */
export async function dismissBallot(ballotId) {
  try {
    await updateDoc(doc(db, 'pendingBallots', ballotId), { status: 'expired' });
  } catch {}
}

// ── Live couple session (collaborative mood → pick) ────────────────────────────
//
// Extends the two-device model back to mood selection. Each partner picks their
// moods on their own phone; when both are ready, the INITIATOR runs the pick and
// broadcasts the result so both screens show the same title. The existing
// LiveBallot then handles the secret vote on that result.
//
// coupleSessions/{id}:
//   initiatorUid, partnerUid, initiatorName, partnerName
//   initiatorGenres [], partnerGenres []   — each partner writes only their own
//   initiatorReady, partnerReady (bool)
//   status: 'selecting' | 'result' | 'closed'
//   result: null | { picked title object }
//   createdAt, expiresAt

const sessionsRef = () => collection(db, 'coupleSessions');

/** Initiator starts a session. Returns the new session id. Wakes the partner. */
export async function createCoupleSession({ initiatorUid, partnerUid, initiatorName, partnerName }) {
  const now = Timestamp.now();
  const expiresAt = Timestamp.fromMillis(Date.now() + BALLOT_TTL_MS);

  const docRef = await addDoc(sessionsRef(), {
    initiatorUid,
    partnerUid,
    initiatorName:   initiatorName || 'Your partner',
    partnerName:     partnerName   || 'Your partner',
    initiatorGenres: [],
    partnerGenres:   [],
    initiatorReady:  false,
    partnerReady:    false,
    status:          'selecting',
    result:          null,
    createdAt:       now,
    expiresAt,
  });

  // Best-effort push to wake the partner.
  fetch('/api/ballot/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({
      partnerUid,
      eventType:  'session_started',
      titleName:  '',
      senderName: initiatorName || 'Your partner',
      ballotId:   docRef.id,
    }),
  }).catch(() => {});

  return docRef.id;
}

/** Partner discovery — a session where this user is the partner and selecting. */
export function subscribeIncomingSession(uid, cb) {
  // Single equality filter only (see subscribeToIncomingBallot) — a multi-field
  // query + orderBy needs a composite index that isn't auto-created, which would
  // make the listener throw and the partner would never discover the session.
  const q = query(sessionsRef(), where('partnerUid', '==', uid));
  return onSnapshot(
    q,
    (snap) => {
      const open = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(s => s.status === 'selecting')
        .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
      cb(open[0] || null);
    },
    (err) => { console.warn('[couple] session listen error:', err?.code || err?.message); cb(null); },
  );
}

/** Direct doc subscription (both sides, full lifecycle incl. result/closed). */
export function subscribeCoupleSession(id, cb) {
  return onSnapshot(
    doc(db, 'coupleSessions', id),
    (snap) => cb(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    () => cb(null),
  );
}

/** Write this device's genre selection + ready flag. */
export async function setSessionReady(id, role, genres, ready) {
  const field = role === 'initiator' ? 'initiator' : 'partner';
  await updateDoc(doc(db, 'coupleSessions', id), {
    [`${field}Genres`]: Array.isArray(genres) ? genres : [],
    [`${field}Ready`]:  !!ready,
  });
}

/** Initiator broadcasts the picked result to both devices. */
export async function broadcastSessionResult(id, result) {
  // JSON round-trip strips undefined fields (Firestore rejects them).
  const clean = result ? JSON.parse(JSON.stringify(result)) : null;
  await updateDoc(doc(db, 'coupleSessions', id), { result: clean, status: 'result' });
}

/** End the session. */
export async function closeCoupleSession(id) {
  try {
    await updateDoc(doc(db, 'coupleSessions', id), { status: 'closed' });
  } catch {}
}
