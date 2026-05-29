import React, { useEffect, useRef } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';
import './WatchLoop.css';

// ─────────────────────────────────────────────────────────────────────────────
// WatchLoop — the feedback loop that closes every session and compounds
// pick quality over time.
//
// Two-step flow:
//   confirm  →  "You settled on [Title]. Did you watch it?"
//               [✓ Watched it]  [Not yet — ask tomorrow]  [Skipped it]
//
//   rate     →  "How'd it land?"
//               [👍 Loved it]  [👎 Not for us]
//
// The confirm step is the retention hook: it creates an open question that
// pulls the user back if they haven't answered it (the push cron fires
// ~20h later: "How was [Title]?").
//
// The rate step feeds the taste model. Week 4 picks are smarter than week 1
// because of this signal — that's the compounding quality loop.
//
// Mode-aware copy: couples get "we", solo gets "I" / "me".
// ─────────────────────────────────────────────────────────────────────────────

export default function WatchLoop({
  entry,          // watchHistory entry: { title, year, type, posterPath, mode, ... }
  step,           // 'confirm' | 'rate'
  onConfirm,      // () → void  — user says they watched it
  onSnooze,       // () → void  — "not yet, ask tomorrow"
  onSkip,         // () → void  — "we skipped it" / permanent dismiss
  onVote,         // (vote:'up'|'down') → void  — feeds taste model
  getPosterUrl,   // (posterPath, size) → string
}) {
  const overlayRef = useRef(null);
  useFocusTrap(overlayRef, true);

  const isCouple = entry?.mode === 'couple';

  // Close on Escape (skip permanently — same as old "Skip" button behaviour)
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onSkip?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSkip]);

  if (!entry) return null;

  const posterUrl = entry.posterPath ? getPosterUrl?.(entry.posterPath, 'w92') : null;

  return (
    <div className="watchloop-overlay" onClick={onSkip}>
      <div
        ref={overlayRef}
        className="watchloop-popup"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="watchloop-heading"
        tabIndex={-1}
      >

        {/* ── STEP: confirm ─────────────────────────────────────────────── */}
        {step === 'confirm' && (
          <>
            <p className="watchloop-eyebrow" id="watchloop-heading">
              You settled on…
            </p>

            <div className="watchloop-card">
              {posterUrl ? (
                <img
                  className="watchloop-poster"
                  src={posterUrl}
                  alt=""
                  loading="lazy"
                />
              ) : (
                <div className="watchloop-poster watchloop-poster-placeholder" aria-hidden="true">
                  🎬
                </div>
              )}
              <div className="watchloop-info">
                <div className="watchloop-title">{entry.title}</div>
                <div className="watchloop-meta">
                  {[entry.year, entry.type, entry.service].filter(Boolean).join(' · ')}
                </div>
              </div>
            </div>

            <p className="watchloop-question">
              {isCouple ? 'Did you end up watching it?' : 'Did you watch it?'}
            </p>

            <div className="watchloop-confirm-actions">
              <button
                className="watchloop-btn primary"
                onClick={onConfirm}
              >
                <span aria-hidden="true">✓</span>{' '}
                {isCouple ? 'We watched it' : 'Watched it'}
              </button>
              <button
                className="watchloop-btn ghost"
                onClick={onSnooze}
              >
                Not yet — ask tomorrow
              </button>
            </div>
            <button className="watchloop-skip" onClick={onSkip}>
              {isCouple ? 'We skipped it' : 'I skipped it'}
            </button>
          </>
        )}

        {/* ── STEP: rate ────────────────────────────────────────────────── */}
        {step === 'rate' && (
          <>
            <p className="watchloop-eyebrow" id="watchloop-heading">
              How'd it land?
            </p>

            <div className="watchloop-card">
              {posterUrl ? (
                <img
                  className="watchloop-poster"
                  src={posterUrl}
                  alt=""
                  loading="lazy"
                />
              ) : (
                <div className="watchloop-poster watchloop-poster-placeholder" aria-hidden="true">
                  🎬
                </div>
              )}
              <div className="watchloop-info">
                <div className="watchloop-title">{entry.title}</div>
                <div className="watchloop-meta">
                  {[entry.year, entry.type, entry.service].filter(Boolean).join(' · ')}
                </div>
              </div>
            </div>

            <div className="watchloop-vote-actions">
              <button
                className="watchloop-vote-btn vote-up"
                onClick={() => onVote('up')}
                aria-label={`Loved ${entry.title}`}
              >
                <span aria-hidden="true">👍</span>
                <span className="watchloop-vote-label">
                  {isCouple ? 'Loved it' : 'Loved it'}
                </span>
              </button>
              <button
                className="watchloop-vote-btn vote-down"
                onClick={() => onVote('down')}
                aria-label={`Not for ${isCouple ? 'us' : 'me'}`}
              >
                <span aria-hidden="true">👎</span>
                <span className="watchloop-vote-label">
                  {isCouple ? 'Not for us' : 'Not for me'}
                </span>
              </button>
            </div>
          </>
        )}

      </div>
    </div>
  );
}
