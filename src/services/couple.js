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
  collection, query, where, orderBy, limit,
  onSnapshot, Timestamp, addDoc,
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

// ── Async ballot ──────────────────────────────────────────────────────────────

/**
 * P1 creates an async ballot for a specific title and sends a push notification
 * to P2. Returns the new ballot document ID.
 */
export async function createBallot({
  initiatorUid,
  partnerUid,
  initiatorName,
  partnerName,
  title,
  initiatorVote,
}) {
  const now = Timestamp.now();
  const expiresAt = Timestamp.fromMillis(Date.now() + BALLOT_TTL_MS);

  const docRef = await addDoc(ballotsRef(), {
    initiatorUid,
    partnerUid,
    initiatorName: initiatorName || 'Your partner',
    partnerName:   partnerName   || 'You',
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
    initiatorVote,
    partnerVote:  null,
    status:       'pending',
    createdAt:    now,
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
  const q = query(
    ballotsRef(),
    where('partnerUid', '==', uid),
    where('status', '==', 'pending'),
    orderBy('createdAt', 'desc'),
    limit(1),
  );
  return onSnapshot(q, (snap) => {
    if (snap.empty) {
      onBallot(null);
    } else {
      const docSnap = snap.docs[0];
      onBallot({ id: docSnap.id, ...docSnap.data() });
    }
  }, () => onBallot(null));
}

/**
 * P2 casts their vote on an incoming ballot.
 * Returns the outcome: 'matched' | 'missed'.
 */
export async function voteBallot(ballotId, ballotData, partnerVote) {
  const outcome = ballotData.initiatorVote === 'up' && partnerVote === 'up'
    ? 'matched' : 'missed';

  await updateDoc(doc(db, 'pendingBallots', ballotId), {
    partnerVote,
    status: outcome,
  });

  // If matched: push P1 (best-effort).
  if (outcome === 'matched') {
    fetch('/api/ballot/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({
        partnerUid: ballotData.initiatorUid,
        eventType:  'ballot_match',
        titleName:  ballotData.title?.title || 'the pick',
        senderName: ballotData.partnerName  || 'Your partner',
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
