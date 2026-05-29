import React, { useState, useRef, useEffect } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';
import './AsyncBallot.css';

// ─────────────────────────────────────────────────────────────────────────────
// AsyncBallot — shown to P2 when they have a pending ballot from P1.
//
// P1's vote is already locked (shown on reveal). P2 casts theirs.
// After voting, shows a brief reveal (match 🎉 or miss) then closes.
//
// Props:
//   ballot        { id, title:{id,title,year,type,service,posterPath,rating},
//                   initiatorName, initiatorVote, createdAt }
//   onVote        async (vote:'up'|'down') => 'matched'|'missed'
//   onDismiss     () => void  — skip for now (sets ballot status to expired)
//   getPosterUrl  (posterPath, size) => string
//   getServiceColor (service) => string
// ─────────────────────────────────────────────────────────────────────────────

const REVEAL_DELAY_MS = 900;

export default function AsyncBallot({
  ballot,
  onVote,
  onDismiss,
  getPosterUrl,
  getServiceColor,
}) {
  const [step, setStep]       = useState('vote');  // 'vote' | 'revealing' | 'result'
  const [outcome, setOutcome] = useState(null);    // 'matched' | 'missed'
  const [busy, setBusy]       = useState(false);
  const overlayRef = useRef(null);
  useFocusTrap(overlayRef, true);

  // Close on Escape
  useEffect(() => {
    const fn = (e) => { if (e.key === 'Escape' && step !== 'revealing') onDismiss?.(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [step, onDismiss]);

  const handleVote = async (vote) => {
    if (busy) return;
    setBusy(true);
    setStep('revealing');
    try {
      const result = await onVote(vote);
      setTimeout(() => {
        setOutcome(result);
        setStep('result');
        setBusy(false);
      }, REVEAL_DELAY_MS);
    } catch {
      setStep('vote');
      setBusy(false);
    }
  };

  const { title } = ballot;
  const posterUrl = title.posterPath ? getPosterUrl?.(title.posterPath, 'w185') : null;

  return (
    <div className="async-ballot-overlay" onClick={step === 'result' ? onDismiss : undefined}>
      <div
        ref={overlayRef}
        className="async-ballot-card"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Incoming vote from your partner"
        tabIndex={-1}
      >
        {/* ── Vote step ─────────────────────────────────────────────────── */}
        {step === 'vote' && (
          <>
            <div className="async-ballot-header">
              <div className="async-ballot-from">
                <span className="async-ballot-lock" aria-hidden="true">🔒</span>
                {ballot.initiatorName} already voted
              </div>
              <button
                className="async-ballot-skip"
                onClick={onDismiss}
                aria-label="Skip for now"
              >
                Later
              </button>
            </div>

            <div className="async-ballot-cue">Your turn to vote</div>

            <div className="async-ballot-title-row">
              {posterUrl && (
                <img
                  className="async-ballot-poster"
                  src={posterUrl}
                  alt=""
                  loading="lazy"
                />
              )}
              <div className="async-ballot-info">
                <div className="async-ballot-name">{title.title}</div>
                <div className="async-ballot-meta">
                  {[
                    title.year,
                    title.type,
                    title.service,
                  ].filter(Boolean).map((part, i, arr) => (
                    <span
                      key={i}
                      style={part === title.service ? { color: getServiceColor?.(title.service) } : {}}
                    >
                      {part}{i < arr.length - 1 ? ' · ' : ''}
                    </span>
                  ))}
                </div>
                {title.rating && (
                  <div className="async-ballot-rating">★ {title.rating}</div>
                )}
              </div>
            </div>

            <div className="async-ballot-votes">
              <button
                className="async-ballot-vote yes"
                onClick={() => handleVote('up')}
                aria-label="Vote yes"
                disabled={busy}
              >
                👍
              </button>
              <button
                className="async-ballot-vote no"
                onClick={() => handleVote('down')}
                aria-label="Vote no"
                disabled={busy}
              >
                👎
              </button>
            </div>
          </>
        )}

        {/* ── Revealing step ────────────────────────────────────────────── */}
        {step === 'revealing' && (
          <div className="async-ballot-suspense">
            <div className="async-ballot-dots" aria-label="Revealing votes">
              <span /><span /><span />
            </div>
            <div className="async-ballot-suspense-text">Revealing…</div>
          </div>
        )}

        {/* ── Result step ───────────────────────────────────────────────── */}
        {step === 'result' && (
          <div className="async-ballot-result">
            {outcome === 'matched' ? (
              <>
                <div className="async-ballot-result-icon">🎉</div>
                <div className="async-ballot-result-title">It's a match!</div>
                <div className="async-ballot-result-sub">
                  You both want to watch <strong>{title.title}</strong>
                </div>
                <button className="async-ballot-action primary" onClick={onDismiss}>
                  Let's watch
                </button>
              </>
            ) : (
              <>
                <div className="async-ballot-result-icon">🤔</div>
                <div className="async-ballot-result-title">Not this one</div>
                <div className="async-ballot-result-sub">
                  {ballot.initiatorName} has been notified. They'll pick another one.
                </div>
                <button className="async-ballot-action primary" onClick={onDismiss}>
                  Got it
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
