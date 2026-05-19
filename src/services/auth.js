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

// True if the current URL is a Firebase magic-link sign-in URL.
// Used by AuthGate to decide whether to show the cross-device confirm form.
export const isMagicLinkUrl = () =>
  isSignInWithEmailLink(auth, window.location.href);

// Called on every app mount — completes the email link sign-in if the URL
// contains a Firebase sign-in link.
//
// Returns a discriminated result so the caller (AuthGate) can render the
// appropriate UI for each branch without relying on window.prompt() (which
// is blocked in iOS in-app browsers like Gmail/Outlook viewers):
//
//   { status: 'not-magic-link' }            — URL doesn't carry a sign-in link
//   { status: 'success', result }           — signed in successfully
//   { status: 'needs-email' }               — URL is magic but we have no
//                                             stored email; UI should render
//                                             a confirm-email form and call
//                                             completeMagicLinkSignIn(email)
//   { status: 'error', code, message }      — finalization failed (expired,
//                                             email mismatch, network)
export const completeMagicLinkSignIn = async (emailOverride) => {
  if (!isSignInWithEmailLink(auth, window.location.href)) {
    return { status: 'not-magic-link' };
  }

  const email = emailOverride || readPendingEmail();
  if (!email) return { status: 'needs-email' };

  try {
    const result = await signInWithEmailLink(auth, email, window.location.href);
    try { localStorage.removeItem(PENDING_EMAIL_KEY); } catch {}
    // Clean the magic link params from the URL
    window.history.replaceState(null, '', window.location.pathname);
    return { status: 'success', result };
  } catch (err) {
    console.error('[Auth] Magic link completion failed:', err.message);
    return { status: 'error', code: err.code, message: err.message };
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
