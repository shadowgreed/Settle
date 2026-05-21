// ─────────────────────────────────────────────────────────────────────────────
// Web Push (PM roadmap 3.1) — client-side subscribe/unsubscribe helpers.
//
// Flow:
//   1. App detects support + checks current permission
//   2. After 3rd successful pick, opt-in banner asks the user
//   3. User accepts → requestPermission() → subscribe via PushManager
//   4. PushSubscription JSON saved to Firestore (per-user, multi-device)
//   5. Server cron iterates subscriptions weekly and sends notifications
//      via the web-push library (signed with VAPID private key).
//
// Platform note: web push works on Android Chrome / Firefox / Edge today.
// iOS Safari supports it only when the PWA is installed to the home
// screen on iOS 16.4+. The opt-in banner is suppressed when push isn't
// available, so users never see a prompt that can't be honored.
// ─────────────────────────────────────────────────────────────────────────────

import { doc, getDoc, setDoc, updateDoc, arrayUnion, arrayRemove } from 'firebase/firestore';
import { db } from './firebase';

const VAPID_PUBLIC_KEY = process.env.REACT_APP_VAPID_PUBLIC_KEY || '';

// True if the browser supports Web Push (Service Worker + Push API) AND the
// server-side VAPID key is configured. The VAPID check effectively gates the
// entire feature behind environment configuration — without it set, the
// opt-in banner and Settings toggle stay hidden, so users never opt in to a
// feature that can't actually deliver notifications.
//
// On iOS specifically, also requires the PWA to be home-screen-installed.
export function isPushSupported() {
  if (typeof window === 'undefined') return false;
  if (!('serviceWorker' in navigator)) return false;
  if (!('PushManager' in window)) return false;
  if (!('Notification' in window)) return false;
  if (!VAPID_PUBLIC_KEY) return false; // server-side delivery not configured yet
  return true;
}

// Current notification permission state: 'default' | 'granted' | 'denied'.
export function notificationPermission() {
  return typeof Notification !== 'undefined' ? Notification.permission : 'default';
}

// Convert the base64url-encoded VAPID public key into the Uint8Array form
// the PushManager.subscribe() applicationServerKey option expects.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Subscribe the current device to push.
// Returns the PushSubscription on success, throws on failure (permission
// denied, no VAPID key configured, network error, etc.).
export async function subscribeToPush(uid) {
  if (!isPushSupported()) throw new Error('Push not supported');
  if (!VAPID_PUBLIC_KEY) throw new Error('VAPID public key not configured');
  if (!uid) throw new Error('User must be signed in to subscribe');

  // Ask the user for permission. On iOS, this also requires the
  // installed-PWA context — the browser handles the gate.
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    throw new Error(`Permission ${perm}`);
  }

  const reg = await navigator.serviceWorker.ready;
  // Reuse an existing subscription if the user is already opted in on this
  // device — no point creating a second endpoint.
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  // Save to Firestore so the server can iterate them when sending
  // notifications. Stored as a JSON-serializable object, not the live
  // PushSubscription (which can't cross the network boundary directly).
  const subJson = sub.toJSON();
  const userDoc = doc(db, 'users', uid);
  const snap = await getDoc(userDoc);
  if (snap.exists()) {
    await updateDoc(userDoc, { pushSubscriptions: arrayUnion(subJson) });
  } else {
    await setDoc(userDoc, { pushSubscriptions: [subJson] }, { merge: true });
  }
  return sub;
}

// Unsubscribe this device + remove the subscription from Firestore.
export async function unsubscribeFromPush(uid) {
  if (!isPushSupported() || !uid) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const subJson = sub.toJSON();
      await sub.unsubscribe();
      try {
        await updateDoc(doc(db, 'users', uid), {
          pushSubscriptions: arrayRemove(subJson),
        });
      } catch (e) {
        // Doc may not exist yet — that's fine, just means there's nothing to remove.
        console.warn('[Push] Could not remove subscription from Firestore:', e.message);
      }
    }
  } catch (e) {
    console.warn('[Push] Unsubscribe failed:', e.message);
  }
}

// True if the current device has an active push subscription.
export async function isSubscribedOnThisDevice() {
  if (!isPushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return !!sub;
  } catch {
    return false;
  }
}
