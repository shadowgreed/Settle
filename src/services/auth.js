import {
  GoogleAuthProvider,
  signInWithPopup,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  deleteUser as firebaseDeleteUser,
} from 'firebase/auth';
import { auth } from './firebase';

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// NOTE: Apple sign-in is intentionally omitted until an Apple Developer
// Service ID is configured. To re-enable, restore the OAuthProvider import
// and the signInWithApple export, then wire the button in AuthGate.js.

const PENDING_EMAIL_KEY = 'settle_pending_email';
const PENDING_EMAIL_TTL_MS = 60 * 60 * 1000; // 1 hour — matches Firebase link expiry

// ── Sign-in methods ──────────────────────────────────────────────────────────

export const signInWithGoogle = () => signInWithPopup(auth, googleProvider);

// Magic link — sends a sign-in email. The link opens the app, which calls
// completeMagicLinkSignIn() on mount to finish the flow.
export const sendMagicLink = async (email) => {
  const actionCodeSettings = {
    url: window.location.origin,
    handleCodeInApp: true,
  };
  await sendSignInLinkToEmail(auth, email, actionCodeSettings);
  // Store with expiry so a never-completed link doesn't leave an email lying
  // around in storage. Firebase magic links themselves expire in 1 hour.
  try {
    localStorage.setItem(
      PENDING_EMAIL_KEY,
      JSON.stringify({ email, exp: Date.now() + PENDING_EMAIL_TTL_MS })
    );
  } catch {}
};

// Read the pending email if it exists and hasn't expired.
// Cleans up expired entries automatically.
const readPendingEmail = () => {
  try {
    const raw = localStorage.getItem(PENDING_EMAIL_KEY);
    if (!raw) return null;
    // Legacy format: a bare string (pre-expiry-tracking). Treat as expired.
    if (raw[0] !== '{') {
      localStorage.removeItem(PENDING_EMAIL_KEY);
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed?.email || !parsed?.exp || Date.now() > parsed.exp) {
      localStorage.removeItem(PENDING_EMAIL_KEY);
      return null;
    }
    return parsed.email;
  } catch {
    return null;
  }
};

// Called on every app mount — completes the email link sign-in if the URL
// contains a Firebase sign-in link. Returns the UserCredential or null.
export const completeMagicLinkSignIn = async () => {
  if (!isSignInWithEmailLink(auth, window.location.href)) return null;

  let email = readPendingEmail();
  if (!email) {
    // If the user opened the link on a different device, prompt them.
    // (window.prompt is blocked in some iOS in-app browsers — that path returns
    // null and the AuthGate resets to its options view.)
    email = window.prompt('Please confirm your email address:');
    if (!email) return null;
  }

  try {
    const result = await signInWithEmailLink(auth, email, window.location.href);
    try { localStorage.removeItem(PENDING_EMAIL_KEY); } catch {}
    // Clean the magic link params from the URL
    window.history.replaceState(null, '', window.location.pathname);
    return result;
  } catch (err) {
    console.error('[Auth] Magic link completion failed:', err.message);
    return null;
  }
};

export const signOut = () => firebaseSignOut(auth);

export const onAuthChange = (callback) => onAuthStateChanged(auth, callback);

// Permanently delete the current Firebase Auth user. Firebase requires the
// user to have signed in recently — if too much time has passed it throws
// 'auth/requires-recent-login' and we have to re-authenticate first. The
// caller is responsible for catching that error and prompting the user to
// sign in again before retrying.
export const deleteCurrentUser = async () => {
  if (!auth.currentUser) throw new Error('No signed-in user');
  await firebaseDeleteUser(auth.currentUser);
};
