import React from 'react';
import './PushOptIn.css';

// ─────────────────────────────────────────────────────────────────────────────
// PushOptIn — opt-in banner shown after the user's 3rd successful pick.
// PM roadmap 3.1.
//
// Non-blocking, dismissible. Sits at the top of the home screen above the
// mode tabs. Parent (App.js) controls visibility based on pick count +
// dismissal flag + platform support.
// ─────────────────────────────────────────────────────────────────────────────

export default function PushOptIn({ onAccept, onDismiss, busy }) {
  return (
    // role="status" + aria-live="polite" so screen readers announce the
    // banner when it appears (it surfaces dynamically after the 3rd pick).
    // The buttons inside carry their own actionable labels.
    <div className="push-optin" role="status" aria-live="polite">
      <span className="push-optin-icon" aria-hidden="true">🔔</span>
      <div className="push-optin-body">
        <div className="push-optin-title">Heads-up on new picks?</div>
        <div className="push-optin-sub">
          We'll ping you weekly when fresh titles in your top genres drop. No spam.
        </div>
      </div>
      <div className="push-optin-actions">
        <button
          type="button"
          className="push-optin-dismiss"
          onClick={onDismiss}
          disabled={busy}
          aria-label="Not now"
        >
          Not now
        </button>
        <button
          type="button"
          className="push-optin-accept"
          onClick={onAccept}
          disabled={busy}
          aria-label="Enable notifications"
        >
          {busy ? 'Enabling…' : 'Yes, ping me'}
        </button>
      </div>
    </div>
  );
}
