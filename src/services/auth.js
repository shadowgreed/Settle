import {
  GoogleAuthProvider,
  OAuthProvider,
  signInWithPopup,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  signOut as firebaseSignOut,
  onAuthStateChanged,
} from 'firebase/auth';
import { auth } from './firebase';

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// Apple — requires Apple Developer Service ID configured in Firebase console.
const appleProvider = new OAuthProvider('apple.com');
appleProvider.addScope('email');
appleProvider.addScope('name');

// ── Sign-in methods ──────────────────────────────────────────────────────────

export const signInWithGoogle = () => signInWithPopup(auth, googleProvider);

export const signInWithApple = () => signInWithPopup(auth, appleProvider);

// Magic link — sends a sign-in email. The link opens the app, which calls
// completeMagicLinkSignIn() on mount to finish the flow.
export const sendMagicLink = async (email) => {
  const actionCodeSettings = {
    url: window.location.origin,
    handleCodeInApp: true,
  };
  await sendSignInLinkToEmail(auth, email, actionCodeSettings);
  // Store email so we can complete sign-in when the link is clicked
  localStorage.setItem('settle_pending_email', email);
};

// Called on every app mount — completes the email link sign-in if the URL
// contains a Firebase sign-in link. Returns the UserCredential or null.
export const completeMagicLinkSignIn = async () => {
  if (!isSignInWithEmailLink(auth, window.location.href)) return null;

  let email = localStorage.getItem('settle_pending_email');
  if (!email) {
    // If the user opened the link on a different device they won't have the
    // email stored — prompt them for it.
    email = window.prompt('Please confirm your email address:');
    if (!email) return null;
  }

  try {
    const result = await signInWithEmailLink(auth, email, window.location.href);
    localStorage.removeItem('settle_pending_email');
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
