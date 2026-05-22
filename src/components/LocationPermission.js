import React, { useEffect, useRef, useState } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';
import './LocationPermission.css';

// ─────────────────────────────────────────────────────────────────────────────
// LocationPermission — modal shown the first time a user opens Theater Mode
// (or 7 days after a previous decline, per spec). Asks for browser
// geolocation permission with a clear reassurance about non-persistence.
//
// Two paths from here:
//   1. Allow  → trigger navigator.geolocation.getCurrentPosition
//   2. ZIP    → switch to the ZIP entry view (still in this modal)
//
// "Maybe later" closes the modal and records the decline timestamp so we
// can re-prompt after the 7-day cooldown.
// ─────────────────────────────────────────────────────────────────────────────

export default function LocationPermission({
  promptType = 'first',
  initialZip = '',
  onAllow,
  onZip,
  onDismiss,
}) {
  const modalRef = useRef(null);
  useFocusTrap(modalRef, true);

  const [view, setView]       = useState('prompt'); // 'prompt' | 'zip'
  const [zip, setZip]         = useState(initialZip);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState('');

  // Close on Escape — modal-local in addition to the global handler so this
  // works even if rendered before the App-level escape listener wires up.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onDismiss?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const handleAllow = async () => {
    setBusy(true);
    setError('');
    try {
      await onAllow?.();
    } catch (e) {
      setError(e?.message || 'Could not get your location. Try ZIP instead.');
      setBusy(false);
    }
  };

  const handleSubmitZip = async (e) => {
    e.preventDefault();
    const trimmed = zip.trim();
    if (!/^\d{5}$/.test(trimmed)) {
      setError('Please enter a valid 5-digit ZIP.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onZip?.(trimmed);
    } catch (e) {
      setError(e?.message || 'Could not find that ZIP. Double-check and try again.');
      setBusy(false);
    }
  };

  return (
    <div className="locperm-overlay" onClick={onDismiss}>
      <div
        ref={modalRef}
        className="locperm-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="locperm-title"
        tabIndex={-1}
      >
        <button
          className="locperm-close"
          onClick={onDismiss}
          aria-label="Close"
        >
          <span aria-hidden="true">✕</span>
        </button>

        {view === 'prompt' ? (
          <>
            <div className="locperm-icon" aria-hidden="true">📍</div>
            <h2 id="locperm-title" className="locperm-title">
              Find theaters near you
            </h2>
            <p className="locperm-body">
              Settle uses your location to rank theaters by distance. Your
              location stays in your browser — we never store or share it.
            </p>
            {error && (
              <p className="locperm-error" role="alert">{error}</p>
            )}
            <div className="locperm-actions">
              <button
                type="button"
                className="locperm-btn locperm-btn-primary"
                onClick={handleAllow}
                disabled={busy}
              >
                {busy ? 'Working…' : 'Allow location'}
              </button>
              <button
                type="button"
                className="locperm-btn locperm-btn-ghost"
                onClick={() => { setView('zip'); setError(''); }}
                disabled={busy}
              >
                Enter ZIP instead
              </button>
              {promptType !== 'retry' && (
                <button
                  type="button"
                  className="locperm-btn locperm-btn-quiet"
                  onClick={onDismiss}
                  disabled={busy}
                >
                  Maybe later
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="locperm-icon" aria-hidden="true">📮</div>
            <h2 id="locperm-title" className="locperm-title">
              What's your ZIP code?
            </h2>
            <p className="locperm-body">
              We'll use this to find nearby theaters. It's stored with your
              account so you don't have to re-enter it next time.
            </p>
            <form className="locperm-zip-form" onSubmit={handleSubmitZip}>
              <input
                type="text"
                className="locperm-zip-input"
                placeholder="12345"
                value={zip}
                onChange={(e) => setZip(e.target.value.replace(/[^\d]/g, '').slice(0, 5))}
                inputMode="numeric"
                pattern="\d{5}"
                maxLength={5}
                autoFocus
                aria-label="5-digit ZIP code"
                autoComplete="postal-code"
              />
              {error && (
                <p className="locperm-error" role="alert">{error}</p>
              )}
              <div className="locperm-actions">
                <button
                  type="submit"
                  className="locperm-btn locperm-btn-primary"
                  disabled={busy || zip.length !== 5}
                >
                  {busy ? 'Looking up…' : 'Find theaters'}
                </button>
                <button
                  type="button"
                  className="locperm-btn locperm-btn-ghost"
                  onClick={() => { setView('prompt'); setError(''); }}
                  disabled={busy}
                >
                  ← Back
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
