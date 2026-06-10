import React, { useRef, useState } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';
import { setSkipLeaveConfirm } from './ShowtimesSheet';
import './LeaveForTickets.css';

// ─────────────────────────────────────────────────────────────────────────────
// LeaveForTickets — "you're about to leave Settle" awareness dialog (WEB ONLY).
//
// True in-app checkout (SFSafariViewController / Chrome Custom Tab) only exists
// in the native shell. On the web (desktop + mobile browser/PWA) the only way
// to reach Fandango is a new browser tab — Fandango et al. set X-Frame-Options
// so they can't be embedded. Rather than silently punt the user to another tab,
// we confirm first so the hand-off is intentional and not jarring.
//
// The "Continue" control is a real <a target="_blank"> — the most reliable
// cross-browser external-open (Safari blocks programmatic window.open). Fandango
// and the chain sites are responsive, so a mobile device lands on the mobile
// layout automatically; we never force a desktop URL.
//
// Props: url, movie, theater, timeStr, onCancel
// ─────────────────────────────────────────────────────────────────────────────

function providerLabel(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const name = host.split('.')[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return 'the ticketing site';
  }
}

export default function LeaveForTickets({ url, movie, theater, timeStr, onCancel }) {
  const ref = useRef(null);
  useFocusTrap(ref, true);

  const provider = providerLabel(url);
  const [skipNext, setSkipNext] = useState(false);

  // Persist the opt-out only when the user actually continues — ticking the
  // box and then backing out shouldn't silence future confirmations.
  const handleContinue = () => {
    if (skipNext) setSkipLeaveConfirm();
    onCancel();
  };

  return (
    <div className="lft-overlay" onClick={onCancel}>
      <div
        ref={ref}
        className="lft-dialog"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lft-title"
        tabIndex={-1}
      >
        <div className="lft-icon" aria-hidden="true">🎟️</div>
        <h2 id="lft-title" className="lft-title">Heads up — you're leaving Settle</h2>
        <p className="lft-body">
          Tickets are bought on <strong>{provider}</strong>. We'll open it in a
          new tab so you can finish checkout there.
        </p>

        <div className="lft-summary">
          <div className="lft-summary-movie">{movie}</div>
          <div className="lft-summary-meta">
            {timeStr}
            {theater && <> · {theater}</>}
          </div>
        </div>

        <label className="lft-skip">
          <input
            type="checkbox"
            checked={skipNext}
            onChange={e => setSkipNext(e.target.checked)}
          />
          <span>Don't ask me again — go straight to checkout</span>
        </label>

        <a
          className="lft-continue"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleContinue}
        >
          Continue to {provider} ↗
        </a>
        <button type="button" className="lft-cancel" onClick={onCancel}>
          Stay in Settle
        </button>
      </div>
    </div>
  );
}
