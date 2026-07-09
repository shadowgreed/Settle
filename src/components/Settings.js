import React, { useState, useRef, useCallback } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';
// The one exception to this app's "analytics calls live in App.js" convention
// — there's no App.js-level handler for "delete confirm step shown" (unlike
// every other tracked event), so it's tracked directly at the UI transition.
import { trackAccountDeleteStarted } from '../services/analytics';
import pkg from '../../package.json';
import './Settings.css';

// ─────────────────────────────────────────────────────────────────────────────
// Settings modal — single home for everything users self-serve about their
// account. Organised into three groups:
//
//   Account         — identity (display name + email)
//   Preferences     — notifications, couples player names
//   Privacy & Data  — cloud sync toggle, account deletion (danger zone)
//
// Wired from the account bar's gear button in App.js.
// ─────────────────────────────────────────────────────────────────────────────

// Independent stage state per destructive flow so an errored revoke doesn't
// pollute the delete UI (the previous shared `stage` was leaking errorMsg
// across the two flows when the user cancelled one and started the other).
const STAGE = {
  IDLE:    'idle',
  CONFIRM: 'confirm',
  WORKING: 'working',
  ERROR:   'error',
};

export default function Settings({
  user,
  consent,
  playerNames,
  pushSupported,
  pushSubscribed,
  pushBusy,
  partnerLinkSlot,   // ReactNode — CoupleLink rendered by App.js
  onClose,
  onSignOut,
  onWithdrawConsent,
  onEnableConsent,
  onDeleteAccount,
  onSavePlayerNames,
  onTogglePush,
  onShowPrivacy,
  onShowTerms,
}) {
  const modalRef = useRef(null);
  useFocusTrap(modalRef, true);

  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const signOutTimerRef = useRef(null);

  const requestSignOut = useCallback(() => {
    setConfirmingSignOut(true);
    clearTimeout(signOutTimerRef.current);
    signOutTimerRef.current = setTimeout(() => setConfirmingSignOut(false), 4000);
  }, []);

  const cancelSignOut = useCallback(() => {
    clearTimeout(signOutTimerRef.current);
    setConfirmingSignOut(false);
  }, []);

  const confirmSignOut = useCallback(() => {
    clearTimeout(signOutTimerRef.current);
    setConfirmingSignOut(false);
    onSignOut?.();
  }, [onSignOut]);

  // Per-flow stage so revoke errors don't leak into the delete UI.
  const [revokeStage, setRevokeStage] = useState(STAGE.IDLE);
  const [revokeError, setRevokeError] = useState('');
  const [deleteStage, setDeleteStage] = useState(STAGE.IDLE);
  const [deleteError, setDeleteError] = useState('');
  const [confirmText, setConfirmText] = useState('');

  // Local draft state for the player-name editor — committed via
  // onSavePlayerNames on blur (or Enter). Keeps the input snappy without
  // re-rendering the whole app on every keystroke.
  const [p1Draft, setP1Draft] = useState(playerNames?.p1 || 'You');
  const [p2Draft, setP2Draft] = useState(playerNames?.p2 || 'Partner');

  const commitP1 = () => {
    const trimmed = p1Draft.trim() || 'You';
    if (trimmed !== playerNames?.p1) onSavePlayerNames?.('p1', trimmed);
    setP1Draft(trimmed);
  };
  const commitP2 = () => {
    const trimmed = p2Draft.trim() || 'Partner';
    if (trimmed !== playerNames?.p2) onSavePlayerNames?.('p2', trimmed);
    setP2Draft(trimmed);
  };

  const handleConfirmRevoke = async () => {
    setRevokeStage(STAGE.WORKING);
    setRevokeError('');
    try {
      await onWithdrawConsent();
      setRevokeStage(STAGE.IDLE);
    } catch (e) {
      setRevokeError(e?.message || 'Could not withdraw consent. Please try again.');
      setRevokeStage(STAGE.ERROR);
    }
  };

  const handleConfirmDelete = async () => {
    if (confirmText.trim().toUpperCase() !== 'DELETE') return;
    setDeleteStage(STAGE.WORKING);
    setDeleteError('');
    try {
      await onDeleteAccount();
      // onDeleteAccount triggers sign-out which unmounts this component.
    } catch (e) {
      // requires-recent-login is the most common path — user signed in days
      // ago and Firebase wants a fresh credential before deleting.
      if (e?.code === 'auth/requires-recent-login') {
        setDeleteError('For your security, please sign out and sign back in, then try again.');
      } else {
        setDeleteError(e?.message || 'Could not delete your account. Please try again or email hello@trysettle.app.');
      }
      setDeleteStage(STAGE.ERROR);
    }
  };

  // What sign-in provider did they use? The id is buried in user.providerData;
  // we surface a friendly label so the Account section reads as informative
  // rather than just a display-name dump.
  const providerLabel = (() => {
    const id = user?.providerData?.[0]?.providerId;
    if (id === 'google.com') return 'Google';
    if (id === 'password' || id === 'apple.com') return id === 'apple.com' ? 'Apple' : 'Email';
    // Firebase tags email-link sign-ins as 'password' too — Settle only
    // supports magic-link email, so "Email" is accurate.
    return null;
  })();

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        ref={modalRef}
        className="settings-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
      >
        <div className="settings-header">
          <h2 id="settings-title" className="settings-title">Settings</h2>
          <button
            className="privacy-close"
            onClick={onClose}
            aria-label="Close settings"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        <div className="settings-body">

          {/* ══ GROUP: ACCOUNT ════════════════════════════════════════════ */}
          <div className="settings-group">
            <h3 className="settings-group-title">Account</h3>
            <div className={`settings-account-card${confirmingSignOut ? ' confirming' : ''}`}>
              {user?.photoURL ? (
                <img
                  className="settings-account-avatar"
                  src={user.photoURL}
                  alt=""
                  aria-hidden="true"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="settings-account-avatar settings-account-avatar-fallback" aria-hidden="true">👤</span>
              )}
              <div className="settings-account-info">
                <div className="settings-account-name">
                  {user?.displayName || user?.email?.split('@')[0] || 'Account'}
                </div>
                {user?.email && (
                  <div className="settings-account-email">{user.email}</div>
                )}
                {providerLabel && (
                  <div className="settings-account-provider">
                    Signed in with {providerLabel}
                  </div>
                )}
              </div>
              {onSignOut && (
                confirmingSignOut ? (
                  <div className="settings-signout-confirm-row">
                    <p className="settings-signout-confirm-prompt">
                      Sign out of {user?.displayName || user?.email?.split('@')[0] || 'this account'}?
                    </p>
                    <div className="settings-signout-confirm-actions">
                      <button
                        type="button"
                        className="settings-signout-confirm-cancel"
                        onClick={cancelSignOut}
                        aria-label="Cancel sign out"
                        autoFocus
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="settings-signout-confirm-yes"
                        onClick={confirmSignOut}
                        aria-label="Confirm sign out"
                      >
                        Sign out
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="settings-signout-btn"
                    onClick={requestSignOut}
                    aria-label="Sign out"
                    title="Sign out"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                      <polyline points="16 17 21 12 16 7" />
                      <line x1="21" y1="12" x2="9" y2="12" />
                    </svg>
                  </button>
                )
              )}
            </div>
          </div>

          {/* ══ GROUP: PARTNER ══════════════════════════════════════════ */}
          {partnerLinkSlot && (
            <div className="settings-group">
              <h3 className="settings-group-title">Partner</h3>
              <section className="settings-section">
                {partnerLinkSlot}
              </section>
            </div>
          )}

          {/* ══ GROUP: PREFERENCES ═══════════════════════════════════════ */}
          {(pushSupported || true) && (
            <div className="settings-group">
              <h3 className="settings-group-title">Preferences</h3>

              {/* Notifications — hidden when push isn't supported on this
                  platform or VAPID isn't configured server-side. */}
              {pushSupported && (
                <section className="settings-section">
                  <div className="settings-section-head">
                    <h4 className="settings-section-title">Notifications</h4>
                  </div>
                  <p className="settings-section-desc">
                    {pushSubscribed
                      ? "You'll get a weekly heads-up when new titles in your top genres drop."
                      : 'Get a weekly heads-up when new titles in your top genres drop. No spam.'}
                  </p>
                  <button
                    type="button"
                    className={`settings-btn ${pushSubscribed ? 'settings-btn-ghost' : 'settings-btn-warn'}`}
                    onClick={() => onTogglePush?.(!pushSubscribed)}
                    disabled={pushBusy}
                  >
                    {pushBusy
                      ? 'Working…'
                      : pushSubscribed ? 'Turn off notifications' : 'Turn on notifications'}
                  </button>
                </section>
              )}

              {/* Your names — visible to all users (even solo, in case they
                  want to set names up before opening Couples mode). */}
              <section className="settings-section">
                <div className="settings-section-head">
                  <h4 className="settings-section-title">Your names</h4>
                </div>
                <p className="settings-section-desc">
                  Used by Couples mode and shareable pick cards.
                </p>
                <div className="settings-names-grid">
                  <label className="settings-name-field">
                    <span className="settings-name-label">You</span>
                    <input
                      type="text"
                      className="settings-name-input"
                      value={p1Draft}
                      onChange={(e) => setP1Draft(e.target.value)}
                      onBlur={commitP1}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                      maxLength={20}
                      aria-label="Your name"
                    />
                  </label>
                  <label className="settings-name-field">
                    <span className="settings-name-label">Partner</span>
                    <input
                      type="text"
                      className="settings-name-input"
                      value={p2Draft}
                      onChange={(e) => setP2Draft(e.target.value)}
                      onBlur={commitP2}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                      maxLength={20}
                      aria-label="Partner name"
                    />
                  </label>
                </div>
              </section>
            </div>
          )}

          {/* ══ GROUP: PRIVACY & DATA ════════════════════════════════════ */}
          <div className="settings-group">
            <h3 className="settings-group-title">Privacy &amp; Data</h3>

            {/* Cloud sync — single toggle switch (spec §5.1). Turning OFF
                keeps the existing confirm step; turning ON applies
                immediately, no confirmation. */}
            <section className="settings-section">
              <div className="settings-section-head">
                <h4 className="settings-section-title" id="cloud-sync-label">Cloud sync</h4>
                <button
                  type="button"
                  role="switch"
                  aria-checked={consent}
                  aria-labelledby="cloud-sync-label"
                  className={`settings-toggle ${consent ? 'on' : 'off'}`}
                  onClick={() => {
                    if (consent) setRevokeStage(STAGE.CONFIRM);
                    else onEnableConsent?.();
                  }}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>
              </div>
              <p className="settings-section-desc">
                {consent
                  ? 'Your preferences, history, and taste profile sync to your account across devices.'
                  : 'Your data stays on this device only. Nothing is uploaded.'}
              </p>

              {(revokeStage === STAGE.CONFIRM || revokeStage === STAGE.ERROR) && (
                <div className="settings-confirm">
                  <p className="settings-confirm-text">
                    <strong>Stop cloud sync?</strong> Data already in the cloud stays there until you delete your account. New activity will only be saved on this device.
                  </p>
                  {revokeStage === STAGE.ERROR && revokeError && (
                    <p className="settings-error" role="alert">{revokeError}</p>
                  )}
                  <div className="settings-confirm-actions">
                    <button
                      type="button"
                      className="settings-btn settings-btn-ghost"
                      onClick={() => { setRevokeStage(STAGE.IDLE); setRevokeError(''); }}
                      autoFocus
                    >
                      Keep syncing
                    </button>
                    <button
                      type="button"
                      className="settings-btn settings-btn-warn"
                      onClick={handleConfirmRevoke}
                      disabled={revokeStage === STAGE.WORKING}
                    >
                      {revokeStage === STAGE.WORKING ? 'Working…' : 'Stop sync'}
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* Account deletion — visually demarcated as the danger zone. */}
            <section className="settings-section settings-section-danger">
              <div className="settings-danger-zone-label">Danger Zone</div>
              <div className="settings-section-head">
                <h4 className="settings-section-title">Delete account</h4>
              </div>
              <p className="settings-section-desc">
                Permanently delete your account and all associated cloud data. This can't be undone.
              </p>

              {deleteStage === STAGE.CONFIRM || deleteStage === STAGE.ERROR || deleteStage === STAGE.WORKING ? (
                <div className="settings-confirm">
                  <p className="settings-confirm-text" id="delete-consequences">
                    This will immediately delete your Settle account, your cloud data, and your sign-in credential. Type <strong>DELETE</strong> to confirm.
                  </p>
                  <input
                    type="text"
                    className="settings-confirm-input"
                    placeholder="Type DELETE"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-label="Type DELETE to confirm"
                    aria-describedby="delete-consequences"
                    disabled={deleteStage === STAGE.WORKING}
                  />
                  {deleteStage === STAGE.ERROR && deleteError && (
                    <p className="settings-error" role="alert">{deleteError}</p>
                  )}
                  <div className="settings-confirm-actions">
                    <button
                      type="button"
                      className="settings-btn settings-btn-ghost"
                      onClick={() => {
                        setDeleteStage(STAGE.IDLE);
                        setConfirmText('');
                        setDeleteError('');
                      }}
                      disabled={deleteStage === STAGE.WORKING}
                      autoFocus
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="settings-btn settings-btn-danger"
                      onClick={handleConfirmDelete}
                      disabled={
                        deleteStage === STAGE.WORKING ||
                        confirmText.trim().toUpperCase() !== 'DELETE'
                      }
                    >
                      {deleteStage === STAGE.WORKING ? 'Deleting…' : 'Delete forever'}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="settings-btn settings-btn-danger-outline"
                  onClick={() => {
                    trackAccountDeleteStarted();
                    setDeleteStage(STAGE.CONFIRM);
                    setConfirmText('');
                    setDeleteError('');
                  }}
                >
                  Delete my account
                </button>
              )}
            </section>
          </div>

          <div className="settings-footer">
            <p className="settings-footer-version">Settle v{pkg.version}</p>
            <a
              className="settings-footer-link"
              href={`mailto:hello@trysettle.app?subject=${encodeURIComponent(`Settle Feedback (v${pkg.version})`)}`}
            >
              Send feedback
            </a>
            <p className="settings-footer-legal">
              <button type="button" className="settings-footer-link" onClick={onShowPrivacy}>
                Privacy Policy
              </button>
              <span aria-hidden="true"> · </span>
              <button type="button" className="settings-footer-link" onClick={onShowTerms}>
                Terms of Service
              </button>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
