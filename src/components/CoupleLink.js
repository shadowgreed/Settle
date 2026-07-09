import React, { useState, useEffect } from 'react';
import { trackLinkCodeGenerated, trackLinkCodeShared } from '../services/analytics';
import './CoupleLink.css';

// ─────────────────────────────────────────────────────────────────────────────
// CoupleLink — embedded in Settings, handles the partner-linking flow.
//
// States:
//   idle (not linked)  → "Get a code" or "Enter a code"
//   showing-code       → shows the generated code P1 shares with P2
//   entering-code      → P2 types in P1's code
//   linked             → shows partner name + Unlink option
// ─────────────────────────────────────────────────────────────────────────────

// Matches the real backend TTL (lib/coupleStore.js CODE_TTL_S = 24h). Computed
// client-side at generation time — no API/response-shape change needed.
const CODE_TTL_MS = 24 * 60 * 60 * 1000;

function formatExpiry(msRemaining) {
  if (msRemaining <= 0) return 'Expired';
  const totalSeconds = Math.floor(msRemaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `Expires in ${hours}h ${minutes}m`;
  if (minutes > 0) return `Expires in ${minutes}m ${seconds}s`;
  return `Expires in ${seconds}s`;
}

export default function CoupleLink({
  partnerName,          // string | null — current linked partner's display name
  onGenerateCode,       // async () => string  — calls /api/couple/code
  onVerifyCode,         // async (code) => { partnerUid, partnerName } — calls /api/couple/verify + saves link
  onUnlink,             // async () => void
  // Idle-state description ("Link with your partner to watch together on two
  // phones") is the only explanation of this feature when CoupleLink renders
  // standalone in Settings — but it's redundant when CoupleSessionIntro's own
  // title + 3 steps already cover the same ground. Default true so Settings
  // is unaffected; CoupleSessionIntro passes false.
  showIntro = true,
}) {
  const isLinked = !!partnerName;
  const [view, setView]   = useState('idle');  // 'idle' | 'showing-code' | 'entering-code'
  const [code, setCode]   = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState(false);
  const [expiresAt, setExpiresAt] = useState(null);
  const [now, setNow] = useState(Date.now());

  // Live countdown while the code is on screen — ticks every second and
  // auto-reverts to idle once the code's real backend TTL has elapsed.
  useEffect(() => {
    if (view !== 'showing-code' || !expiresAt) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [view, expiresAt]);

  useEffect(() => {
    if (view === 'showing-code' && expiresAt && now >= expiresAt) {
      setView('idle');
      setCode('');
      setExpiresAt(null);
    }
  }, [view, expiresAt, now]);

  // ── P1 path: generate ──────────────────────────────────────────────────────
  const handleGetCode = async () => {
    setBusy(true);
    setError('');
    try {
      const generated = await onGenerateCode();
      setCode(generated);
      setExpiresAt(Date.now() + CODE_TTL_MS);
      setNow(Date.now());
      setView('showing-code');
      trackLinkCodeGenerated();
    } catch (e) {
      setError(e?.message || 'Could not generate a code. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleCopyCode = () => {
    navigator.clipboard?.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    trackLinkCodeShared({ method: 'copy' });
  };

  // Web Share API — the critical piece of the code-display state (spec §1.6):
  // a code you can't send is a code that gets mistyped. Falls back silently
  // when unavailable (desktop); Copy remains the universal path either way.
  const handleShareCode = () => {
    navigator.share({
      title: 'Settle',
      text: `Join me on Settle — enter code ${code}. https://trysettle.app`,
    }).catch(() => {});
    trackLinkCodeShared({ method: 'share_sheet' });
  };

  // ── P2 path: verify ────────────────────────────────────────────────────────
  const handleVerify = async (e) => {
    e.preventDefault();
    const trimmed = input.trim().toUpperCase();
    if (trimmed.length !== 6) {
      setError('Enter the full 6-character code.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onVerifyCode(trimmed);
      // onVerifyCode saves the link; parent re-renders with partnerName set
      setView('idle');
      setInput('');
    } catch (e) {
      setError(e?.message || 'Invalid or expired code. Ask your partner for a new one.');
    } finally {
      setBusy(false);
    }
  };

  // ── Linked state ───────────────────────────────────────────────────────────
  if (isLinked) {
    if (showUnlinkConfirm) {
      return (
        <div className="couplelink-unlink-confirm">
          <p className="couplelink-unlink-confirm-title">Unlink from {partnerName}?</p>
          <p className="couplelink-unlink-confirm-body">
            You'll both lose shared saved items and your couples streak.
          </p>
          <div className="couplelink-unlink-confirm-actions">
            <button
              type="button"
              className="couplelink-btn ghost"
              onClick={() => setShowUnlinkConfirm(false)}
              autoFocus
            >
              Cancel
            </button>
            <button
              type="button"
              className="couplelink-unlink-confirm-yes"
              onClick={() => { setShowUnlinkConfirm(false); onUnlink(); }}
            >
              Unlink
            </button>
          </div>
        </div>
      );
    }
    const initial = (partnerName || '?').trim().charAt(0).toUpperCase();
    return (
      <div className="couplelink-linked">
        <span className="couplelink-linked-avatar" aria-hidden="true">{initial}</span>
        <div className="couplelink-linked-info">
          <div className="couplelink-linked-name">{partnerName}</div>
          <div className="couplelink-linked-status">
            <span aria-hidden="true">✓</span> Linked
          </div>
        </div>
        <button
          className="couplelink-unlink"
          onClick={() => setShowUnlinkConfirm(true)}
          aria-label={`Unlink from ${partnerName}`}
        >
          Unlink
        </button>
      </div>
    );
  }

  // ── Code-showing state (P1 waiting for P2) ─────────────────────────────────
  if (view === 'showing-code') {
    return (
      <div className="couplelink-code-display">
        <p className="couplelink-instruction">
          Share this code with your partner. It expires in 24 hours.
        </p>
        <div className="couplelink-code-block">
          <button
            type="button"
            className="couplelink-code"
            onClick={handleCopyCode}
            aria-label="Copy code"
          >
            {code}
          </button>
          <button className="couplelink-copy" onClick={handleCopyCode} aria-label="Copy code">
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
        {'share' in navigator && (
          <button type="button" className="couplelink-share" onClick={handleShareCode}>
            Send to your partner
          </button>
        )}
        <p className="couplelink-waiting">Waiting for your partner to enter it…</p>
        {expiresAt && (
          <p className="couplelink-expiry">{formatExpiry(expiresAt - now)}</p>
        )}
        <button
          className="couplelink-cancel"
          onClick={() => { setView('idle'); setCode(''); setExpiresAt(null); }}
        >
          Cancel code
        </button>
      </div>
    );
  }

  // ── Code-entry state (P2) ─────────────────────────────────────────────────
  if (view === 'entering-code') {
    return (
      <form className="couplelink-enter-form" onSubmit={handleVerify}>
        <p className="couplelink-instruction">Enter the 6-character code your partner shared.</p>
        <input
          className="couplelink-input"
          type="text"
          value={input}
          onChange={e => setInput(e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6))}
          placeholder="ABC123"
          maxLength={6}
          autoFocus
          aria-label="Partner invite code"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
        />
        {error && <p className="couplelink-error" role="alert">{error}</p>}
        <div className="couplelink-actions">
          <button type="submit" className="couplelink-btn primary" disabled={busy || input.length !== 6}>
            {busy ? 'Verifying…' : 'Link up'}
          </button>
          <button type="button" className="couplelink-btn ghost" onClick={() => { setView('idle'); setError(''); setInput(''); }}>
            Back
          </button>
        </div>
      </form>
    );
  }

  // ── Idle state (not linked) ────────────────────────────────────────────────
  return (
    <div className="couplelink-idle">
      {showIntro && (
        <p className="couplelink-description">
          Link with your partner to watch together on two phones.
        </p>
      )}
      {error && <p className="couplelink-error" role="alert">{error}</p>}
      <div className="couplelink-actions">
        <button className="couplelink-btn primary" onClick={handleGetCode} disabled={busy}>
          {busy ? 'Generating…' : 'Get a code'}
        </button>
        <button className="couplelink-btn ghost" onClick={() => { setView('entering-code'); setError(''); }}>
          Enter a code
        </button>
      </div>
      <p className="couplelink-explainer">
        Your partner enters the code on their phone. Codes expire in 24 hours.
      </p>
    </div>
  );
}
