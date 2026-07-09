import React, { useState } from 'react';
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

export default function CoupleLink({
  partnerName,          // string | null — current linked partner's display name
  onGenerateCode,       // async () => string  — calls /api/couple/code
  onVerifyCode,         // async (code) => { partnerUid, partnerName } — calls /api/couple/verify + saves link
  onUnlink,             // async () => void
}) {
  const isLinked = !!partnerName;
  const [view, setView]   = useState('idle');  // 'idle' | 'showing-code' | 'entering-code'
  const [code, setCode]   = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  // ── P1 path: generate ──────────────────────────────────────────────────────
  const handleGetCode = async () => {
    setBusy(true);
    setError('');
    try {
      const generated = await onGenerateCode();
      setCode(generated);
      setView('showing-code');
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
    return (
      <div className="couplelink-linked">
        <span className="couplelink-linked-icon" aria-hidden="true">💑</span>
        <div className="couplelink-linked-info">
          <div className="couplelink-linked-label">Linked with</div>
          <div className="couplelink-linked-name">{partnerName}</div>
        </div>
        <button
          className="couplelink-unlink"
          onClick={onUnlink}
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
          <span className="couplelink-code">{code}</span>
          <button className="couplelink-copy" onClick={handleCopyCode} aria-label="Copy code">
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
        <p className="couplelink-waiting">Waiting for your partner to enter it…</p>
        <button className="couplelink-cancel" onClick={() => { setView('idle'); setCode(''); }}>
          Cancel
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
      <p className="couplelink-description">
        Link with your partner to watch together on two phones.
      </p>
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
