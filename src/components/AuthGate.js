import React, { useState, useEffect } from 'react';
import { signInWithGoogle, signInWithApple, sendMagicLink, completeMagicLinkSignIn } from '../services/auth';
import './AuthGate.css';

export default function AuthGate() {
  const [view,        setView]        = useState('options'); // 'options' | 'email' | 'sent' | 'loading'
  const [email,       setEmail]       = useState('');
  const [error,       setError]       = useState('');
  const [linkLoading, setLinkLoading] = useState(false);

  // Handle magic link return — if the URL contains a sign-in link, complete it
  useEffect(() => {
    const finish = async () => {
      try {
        setView('loading');
        const result = await completeMagicLinkSignIn();
        if (!result) setView('options'); // not a magic link URL — show normal UI
      } catch {
        setView('options');
      }
    };
    finish();
  }, []);

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

  const handleApple = async () => {
    setError('');
    try {
      setView('loading');
      await signInWithApple();
    } catch (err) {
      setView('options');
      if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
        setError('Apple sign-in failed. Please try again.');
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
          <span className="authgate-emoji" aria-hidden="true">🎬</span>
          <span className="authgate-wordmark">SETTLE</span>
        </div>
        <div className="authgate-spinner" aria-label="Signing in…" />
      </div>
    );
  }

  if (view === 'sent') {
    return (
      <div className="authgate">
        <div className="authgate-brand">
          <span className="authgate-emoji" aria-hidden="true">🎬</span>
          <span className="authgate-wordmark">SETTLE</span>
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

  return (
    <div className="authgate">
      <div className="authgate-brand">
        <span className="authgate-emoji" aria-hidden="true">🎬</span>
        <span className="authgate-wordmark">SETTLE</span>
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

            {/* Apple */}
            <button className="authgate-btn authgate-btn-apple" onClick={handleApple}>
              <svg className="authgate-btn-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.7 9.05 7.4c1.39.07 2.35.74 3.17.8 1.21-.24 2.37-.93 3.68-.84 1.58.13 2.77.76 3.54 1.94-3.27 1.96-2.5 5.93.5 7.1-.6 1.55-1.37 3.07-2.89 3.88zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>
              </svg>
              Continue with Apple
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
        <button className="authgate-legal-link" onClick={() => window.open('/terms', '_blank')}>Terms</button>
        {' '}and{' '}
        <button className="authgate-legal-link" onClick={() => window.open('/privacy', '_blank')}>Privacy Policy</button>.
      </p>
    </div>
  );
}
