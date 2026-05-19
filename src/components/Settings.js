import React, { useState, useRef } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';
import './Settings.css';

// ─────────────────────────────────────────────────────────────────────────────
// Settings modal — single home for Privacy & Data controls the user can
// exercise themselves (GDPR posture).
//
// Surfaces:
//   • Cloud sync toggle (consent revoke / re-grant)
//   • Account deletion (with a typed confirmation gate)
//
// Wired from the account bar's gear button in App.js.
// ─────────────────────────────────────────────────────────────────────────────

export default function Settings({
  user,
  consent,
  onClose,
  onWithdrawConsent,
  onDeleteAccount,
}) {
  const modalRef = useRef(null);
  useFocusTrap(modalRef, true);

  // 'idle' | 'revoke-confirm' | 'delete-confirm' | 'working' | 'error'
  const [stage, setStage] = useState('idle');
  const [confirmText, setConfirmText] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const handleConfirmRevoke = async () => {
    setStage('working');
    setErrorMsg('');
    try {
      await onWithdrawConsent();
      // onWithdrawConsent will normally close this modal; if it doesn't,
      // fall back to a clean idle state.
      setStage('idle');
    } catch (e) {
      setErrorMsg(e?.message || 'Could not withdraw consent. Please try again.');
      setStage('error');
    }
  };

  const handleConfirmDelete = async () => {
    if (confirmText.trim().toUpperCase() !== 'DELETE') return;
    setStage('working');
    setErrorMsg('');
    try {
      await onDeleteAccount();
      // onDeleteAccount triggers sign-out which unmounts this component.
    } catch (e) {
      // requires-recent-login is the most common path — user signed in days
      // ago and Firebase wants a fresh credential before deleting.
      if (e?.code === 'auth/requires-recent-login') {
        setErrorMsg('For your security, please sign out and sign back in, then try again.');
      } else {
        setErrorMsg(e?.message || 'Could not delete your account. Please try again or email hello@trysettle.app.');
      }
      setStage('error');
    }
  };

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
          <h2 id="settings-title" className="settings-title">Privacy & Data</h2>
          <button
            className="privacy-close"
            onClick={onClose}
            aria-label="Close settings"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        <div className="settings-body">
          {/* ── Account info ───────────────────────────────────────────── */}
          <section className="settings-section">
            <h3 className="settings-section-title">Account</h3>
            <p className="settings-account-line">
              <strong>{user.displayName || user.email?.split('@')[0] || 'Account'}</strong>
              {user.email ? <span className="settings-account-email"> · {user.email}</span> : null}
            </p>
          </section>

          {/* ── Cloud sync toggle ──────────────────────────────────────── */}
          <section className="settings-section">
            <h3 className="settings-section-title">Cloud sync</h3>
            <p className="settings-section-desc">
              {consent
                ? "Your preferences, history, and taste profile are syncing to your account across devices."
                : "Cloud sync is off. Your data only lives on this device."}
            </p>

            {consent ? (
              stage === 'revoke-confirm' ? (
                <div className="settings-confirm">
                  <p className="settings-confirm-text">
                    Stop syncing this account to the cloud? Your existing cloud data stays put — we'll just stop sending new updates from this device.
                  </p>
                  <div className="settings-confirm-actions">
                    <button
                      type="button"
                      className="settings-btn settings-btn-ghost"
                      onClick={() => setStage('idle')}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="settings-btn settings-btn-warn"
                      onClick={handleConfirmRevoke}
                      disabled={stage === 'working'}
                    >
                      {stage === 'working' ? 'Working…' : 'Yes, stop syncing'}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="settings-btn settings-btn-ghost"
                  onClick={() => { setStage('revoke-confirm'); setErrorMsg(''); }}
                >
                  Stop cloud sync
                </button>
              )
            ) : (
              <p className="settings-hint">
                To re-enable sync, sign out and sign back in — you'll see the consent prompt again.
              </p>
            )}
          </section>

          {/* ── Account deletion ───────────────────────────────────────── */}
          <section className="settings-section settings-section-danger">
            <h3 className="settings-section-title">Delete account</h3>
            <p className="settings-section-desc">
              Permanently delete your account and all associated cloud data. This can't be undone.
            </p>

            {stage === 'delete-confirm' ? (
              <div className="settings-confirm">
                <p className="settings-confirm-text">
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
                />
                <div className="settings-confirm-actions">
                  <button
                    type="button"
                    className="settings-btn settings-btn-ghost"
                    onClick={() => { setStage('idle'); setConfirmText(''); setErrorMsg(''); }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="settings-btn settings-btn-danger"
                    onClick={handleConfirmDelete}
                    disabled={
                      stage === 'working' ||
                      confirmText.trim().toUpperCase() !== 'DELETE'
                    }
                  >
                    {stage === 'working' ? 'Deleting…' : 'Delete forever'}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="settings-btn settings-btn-danger-outline"
                onClick={() => { setStage('delete-confirm'); setConfirmText(''); setErrorMsg(''); }}
              >
                Delete my account
              </button>
            )}
          </section>

          {errorMsg && (
            <p className="settings-error" role="alert">{errorMsg}</p>
          )}

          <p className="settings-footer-note">
            Questions? Email <strong>hello@trysettle.app</strong>
          </p>
        </div>
      </div>
    </div>
  );
}
