import React, { useState, useEffect, useRef } from 'react';
import { signInWithGoogle, sendMagicLink, completeMagicLinkSignIn } from '../services/auth';
import { PrivacyBody, TermsBody } from './LegalContent';
import useFocusTrap from '../hooks/useFocusTrap';
import BrandLogo from './BrandLogo';
import './AuthGate.css';

export default function AuthGate() {
  // 'options' | 'email' | 'sent' | 'loading' | 'confirm-email'
  // 'confirm-email' = magic-link URL detected but no stored email (likely
  // opened on a different device than the one that sent the link).
  const [view,         setView]         = useState('options');
  const [email,        setEmail]        = useState('');
  const [error,        setError]        = useState('');
  const [linkLoading,  setLinkLoading]  = useState(false);
  const [legalModal,   setLegalModal]   = useState(null);     // 'privacy' | 'terms' | null
  const [confirmEmail, setConfirmEmail] = useState('');       // input for cross-device confirm
  const [confirming,   setConfirming]   = useState(false);
  const legalModalRef = useRef(null);
  useFocusTrap(legalModalRef, !!legalModal);

  // Close legal modal on Escape
  useEffect(() => {
    if (!legalModal) return;
    const onKey = (e) => { if (e.key === 'Escape') setLegalModal(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [legalModal]);

  // Lock body scroll while legal modal is open
  useEffect(() => {
    if (legalModal) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [legalModal]);

  // Handle magic link return — if the URL contains a sign-in link, complete it.
  // Three branches:
  //   success         → auth listener will switch the user in; we just wait
  //   needs-email     → cross-device case: render the confirm-email form
  //   error / other   → fall back to the normal options view + show an error
  useEffect(() => {
    const finish = async () => {
      try {
        setView('loading');
        const r = await completeMagicLinkSignIn();
        if (r.status === 'success')         return; // auth listener takes over
        if (r.status === 'needs-email')     { setView('confirm-email'); return; }
        if (r.status === 'not-magic-link')  { setView('options'); return; }
        // error
        setView('options');
        setError(r?.code === 'auth/invalid-action-code'
          ? 'This sign-in link has expired or already been used. Send a fresh one.'
          : 'Sign-in failed. Please send a fresh link and try again.');
      } catch {
        setView('options');
      }
    };
    finish();
  }, []);

  // Cross-device confirm: user types their email, we retry completeMagicLinkSignIn.
  const handleConfirmEmail = async (e) => {
    e.preventDefault();
    if (!confirmEmail.trim()) return;
    setError('');
    setConfirming(true);
    try {
      const r = await completeMagicLinkSignIn(confirmEmail.trim());
      if (r.status === 'success') return; // auth listener takes over
      if (r.status === 'error') {
        // 'auth/invalid-email' on bad format, 'auth/invalid-action-code' on
        // expired/used, plus the email-mismatch case which also returns
        // invalid-action-code. Surface a single retry-friendly message.
        setError(r?.code === 'auth/invalid-action-code'
          ? "That doesn't match the email this link was sent to, or the link has expired."
          : 'Could not sign in with that email. Try again or send a fresh link.');
      }
    } finally {
      setConfirming(false);
    }
  };

  const handleGoogle = async () => {
    setError('');
    try {
      setView('loading');
      await signInWithGoogle();
    } catch (err) {
      setView('options');
      if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
        setError('Google sign-in failed. Please try again.');
      }
    }
  };

  const handleMagicLink = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    setError('');
    setLinkLoading(true);
    try {
      await sendMagicLink(email.trim());
      setView('sent');
    } catch (err) {
      setError('Couldn\'t send the link. Check the email and try again.');
    } finally {
      setLinkLoading(false);
    }
  };

  if (view === 'loading') {
    return (
      <div className="authgate">
        <div className="authgate-brand">
          <BrandLogo className="authgate-logo" height={30} />
        </div>
        <div className="authgate-spinner" aria-label="Signing in…" />
      </div>
    );
  }

  if (view === 'sent') {
    return (
      <div className="authgate">
        <div className="authgate-brand">
          <BrandLogo className="authgate-logo" height={30} />
        </div>
        <div className="authgate-sent">
          <div className="authgate-sent-icon" aria-hidden="true">📬</div>
          <h2 className="authgate-sent-title">Check your inbox</h2>
          <p className="authgate-sent-body">
            We sent a sign-in link to <strong>{email}</strong>.
            Tap it to continue — the link expires in 1 hour.
          </p>
          <button className="authgate-back" onClick={() => { setView('email'); setError(''); }}>
            ← Use a different email
          </button>
        </div>
      </div>
    );
  }

  // Cross-device confirm: URL is a magic link but we don't have the pending
  // email stored (user opened the link on a different device or browser).
  // Render a small form so they can confirm — replaces the old window.prompt()
  // path which is blocked in iOS in-app browsers (Gmail, Outlook viewers).
  if (view === 'confirm-email') {
    return (
      <div className="authgate">
        <div className="authgate-brand">
          <BrandLogo className="authgate-logo" height={30} />
        </div>
        <p className="authgate-tagline">Confirm your email to finish signing in.</p>

        <div className="authgate-card">
          <form className="authgate-email-form" onSubmit={handleConfirmEmail}>
            <label className="authgate-email-label" htmlFor="auth-confirm-email">
              Email this link was sent to
            </label>
            <input
              id="auth-confirm-email"
              className="authgate-email-input"
              type="email"
              placeholder="you@example.com"
              value={confirmEmail}
              onChange={e => setConfirmEmail(e.target.value)}
              autoFocus
              required
              autoComplete="email"
            />
            <button
              type="submit"
              className="authgate-btn authgate-btn-primary"
              disabled={confirming || !confirmEmail.trim()}
            >
              {confirming ? 'Signing in…' : 'Continue'}
            </button>
            <button
              type="button"
              className="authgate-back"
              onClick={() => { setView('options'); setError(''); setConfirmEmail(''); }}
            >
              ← Start over
            </button>
            {error && <p className="authgate-error" role="alert">{error}</p>}
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="authgate">
      <div className="authgate-brand">
        <BrandLogo className="authgate-logo" height={30} />
      </div>
      <p className="authgate-tagline">Your picks, everywhere you go.</p>

      <div className="authgate-card">
        {view === 'options' && (
          <>
            {/* Google */}
            <button className="authgate-btn authgate-btn-google" onClick={handleGoogle}>
              <svg className="authgate-btn-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Continue with Google
            </button>

            {/* Divider */}
            <div className="authgate-divider"><span>or</span></div>

            {/* Email */}
            <button className="authgate-btn authgate-btn-email" onClick={() => { setView('email'); setError(''); }}>
              ✉️ &nbsp; Continue with email
            </button>
          </>
        )}

        {view === 'email' && (
          <form className="authgate-email-form" onSubmit={handleMagicLink}>
            <button type="button" className="authgate-back" onClick={() => { setView('options'); setError(''); }}>
              ← Back
            </button>
            <label className="authgate-email-label" htmlFor="auth-email">Your email address</label>
            <input
              id="auth-email"
              className="authgate-email-input"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              autoFocus
              required
            />
            <button
              type="submit"
              className="authgate-btn authgate-btn-primary"
              disabled={linkLoading || !email.trim()}
            >
              {linkLoading ? 'Sending…' : 'Send sign-in link'}
            </button>
          </form>
        )}

        {error && <p className="authgate-error" role="alert">{error}</p>}
      </div>

      <p className="authgate-legal">
        By continuing, you agree to our{' '}
        <button type="button" className="authgate-legal-link" onClick={() => setLegalModal('terms')}>Terms</button>
        {' '}and{' '}
        <button type="button" className="authgate-legal-link" onClick={() => setLegalModal('privacy')}>Privacy Policy</button>.
      </p>

      {legalModal && (
        <div className="privacy-overlay" onClick={() => setLegalModal(null)}>
          <div
            ref={legalModalRef}
            className="privacy-modal"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="authgate-legal-title"
            tabIndex={-1}
          >
            <div className="privacy-header">
              <h2 id="authgate-legal-title" className="privacy-title">
                {legalModal === 'privacy' ? 'Privacy Policy' : 'Terms of Service'}
              </h2>
              <button
                className="privacy-close"
                onClick={() => setLegalModal(null)}
                aria-label={`Close ${legalModal === 'privacy' ? 'privacy policy' : 'terms of service'}`}
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>
            <div className="privacy-body">
              {legalModal === 'privacy' ? <PrivacyBody /> : <TermsBody />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
