import React, { useMemo, useState } from 'react';
import { invalidateShowtimesCache } from '../services/showtimes';
import './AreaPicker.css';

// ─────────────────────────────────────────────────────────────────────────────
// AreaPicker — the single "set your area" control, shared by the In Theaters
// grid and the showtimes sheet so they look and behave identically.
//
// Collapsed: a chip showing the active area + a "Change" affordance.
// Expanded:  ZIP input + "Use my location".
//
// Always invalidates the in-memory showtimes cache before onChange so the new
// area re-fetches fresh. `variant`: 'chip' (inline, beside the grid search) or
// 'strip' (full-width, inside the sheet).
// ─────────────────────────────────────────────────────────────────────────────

export default function AreaPicker({ userLocation, defaultZip, onChange, variant = 'chip' }) {
  const [editing,  setEditing]  = useState(false);
  const [zipDraft, setZipDraft] = useState('');
  const [busy,     setBusy]     = useState(false);
  const [err,      setErr]      = useState('');

  const hasLocation = !!(userLocation?.source === 'gps' || userLocation?.zip || defaultZip);

  const label = useMemo(() => {
    if (userLocation?.source === 'gps') return 'Near you';
    if (userLocation?.zip) return `Near ${userLocation.zip}`;
    if (defaultZip) return `Near ${defaultZip}`;
    return 'Set your area';
  }, [userLocation, defaultZip]);

  const open  = () => { setZipDraft(userLocation?.zip || defaultZip || ''); setErr(''); setEditing(true); };
  const close = () => { setEditing(false); setErr(''); setBusy(false); };

  const submitZip = async (e) => {
    e?.preventDefault?.();
    const zip = (zipDraft || '').trim();
    if (!/^\d{5}$/.test(zip)) { setErr('Enter a valid 5-digit ZIP.'); return; }
    setBusy(true); setErr('');
    try {
      invalidateShowtimesCache();
      await onChange({ mode: 'zip', zip });
      setEditing(false);
    } catch (e2) {
      setErr(e2?.message || 'Could not set that area. Try again.');
    } finally { setBusy(false); }
  };

  const useGps = async () => {
    setBusy(true); setErr('');
    try {
      invalidateShowtimesCache();
      await onChange({ mode: 'gps' });
      setEditing(false);
    } catch (e2) {
      setErr(e2?.message || 'Location unavailable. Use a ZIP instead.');
    } finally { setBusy(false); }
  };

  const cls = `areapicker areapicker--${variant}${editing ? ' areapicker--editing' : ''}`;

  if (!editing) {
    return (
      <div className={cls}>
        <button
          type="button"
          className="areapicker-chip"
          onClick={open}
          aria-label={hasLocation ? 'Change your area for showtimes' : 'Set your area for showtimes'}
        >
          <span className="areapicker-pin" aria-hidden="true">📍</span>
          <span className="areapicker-label">{label}</span>
          {hasLocation && <span className="areapicker-change" aria-hidden="true">Change</span>}
        </button>
      </div>
    );
  }

  return (
    <div className={cls}>
      <form className="areapicker-form" onSubmit={submitZip}>
        <div className="areapicker-row">
          <input
            type="text"
            className="areapicker-input"
            placeholder="ZIP code"
            value={zipDraft}
            onChange={e => setZipDraft(e.target.value.replace(/[^\d]/g, '').slice(0, 5))}
            inputMode="numeric"
            pattern="\d{5}"
            maxLength={5}
            autoFocus
            aria-label="5-digit ZIP code"
            autoComplete="postal-code"
            disabled={busy}
          />
          <button type="submit" className="areapicker-go" disabled={busy || zipDraft.length !== 5}>
            {busy ? '…' : 'Set'}
          </button>
        </div>
        <div className="areapicker-actions">
          <button type="button" className="areapicker-gps" onClick={useGps} disabled={busy} aria-label="Use my current location">
            <span aria-hidden="true">🎯</span> Use my location
          </button>
          <button type="button" className="areapicker-cancel" onClick={close} disabled={busy}>
            Cancel
          </button>
        </div>
        {err && <p className="areapicker-error" role="alert">{err}</p>}
      </form>
    </div>
  );
}
