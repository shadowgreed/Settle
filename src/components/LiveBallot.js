import React, { useState, useRef, useEffect } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';
import './LiveBallot.css';

// ─────────────────────────────────────────────────────────────────────────────
// LiveBallot — real-time two-device secret vote for linked couples.
//
// The SAME component renders on both phones. Everything is derived from the
// live Firestore ballot doc (passed in as `ballot`) plus this device's `role`
// ('initiator' = P1 who started it, 'partner' = P2). As votes land in Firestore
// the parent re-renders this with fresh ballot data, driving the view forward:
//
//   vote     →  "Cast your secret vote"  (this device hasn't voted)
//   waiting  →  "Waiting for [Name]…"    (we voted, partner hasn't)
//   reveal   →  match 🎉 / miss          (both votes in — status resolved)
//   expired  →  partner stepped away
//
// Neither vote is ever shown before the reveal — that's the "secret" part.
//
// Fallback: if the partner isn't actually there, the initiator can hand over
// their phone ("partner-vote" view) to cast the partner's vote on this device —
// i.e. the classic pass-the-phone ballot, folded into the same flow.
// ─────────────────────────────────────────────────────────────────────────────

const firstName = (n) => (n || '').trim().split(/\s+/)[0] || 'your partner';

export default function LiveBallot({
  ballot,
  role,                 // 'initiator' | 'partner'
  onCastVote,           // async (vote) — cast MY vote
  onCastPartnerVote,    // async (vote) — cast the OTHER side's vote (pass-the-phone)
  onMatch,              // () — both up, user taps "Let's watch"
  onRetry,             // () — miss, initiator picks again
  onClose,              // () — dismiss / close
  getPosterUrl,
  getServiceColor,
}) {
  const overlayRef = useRef(null);
  useFocusTrap(overlayRef, true);
  const [busy, setBusy] = useState(false);
  const [passPhone, setPassPhone] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!ballot) return null;

  const myVote    = role === 'initiator' ? ballot.initiatorVote : ballot.partnerVote;
  const otherName = firstName(role === 'initiator' ? ballot.partnerName : ballot.initiatorName);
  const resolved  = ballot.status === 'matched' || ballot.status === 'missed';
  const expired   = ballot.status === 'expired';

  const { title } = ballot;
  const posterUrl = title?.posterPath ? getPosterUrl?.(title.posterPath, 'w185') : null;

  const castMine = async (vote) => {
    if (busy) return;
    setBusy(true);
    try { await onCastVote(vote); } finally { setBusy(false); }
  };
  const castPartner = async (vote) => {
    if (busy) return;
    setBusy(true);
    try { await onCastPartnerVote(vote); setPassPhone(false); }
    finally { setBusy(false); }
  };

  // Which view to render
  let view;
  if (expired)            view = 'expired';
  else if (resolved)      view = 'reveal';
  else if (passPhone)     view = 'partner-vote';
  else if (myVote == null) view = 'vote';
  else                    view = 'waiting';

  const TitleCard = (
    <div className="liveballot-card">
      {posterUrl ? (
        <img className="liveballot-poster" src={posterUrl} alt="" loading="lazy" />
      ) : (
        <div className="liveballot-poster liveballot-poster-ph" aria-hidden="true">🎬</div>
      )}
      <div className="liveballot-info">
        <div className="liveballot-title">{title?.title}</div>
        <div className="liveballot-meta">
          {[title?.year, title?.type, title?.service].filter(Boolean).map((part, i, arr) => (
            <span key={i} style={part === title?.service ? { color: getServiceColor?.(title.service) } : {}}>
              {part}{i < arr.length - 1 ? ' · ' : ''}
            </span>
          ))}
        </div>
        {title?.rating ? <div className="liveballot-rating">★ {title.rating}</div> : null}
      </div>
    </div>
  );

  const VoteButtons = ({ onYes, onNo }) => (
    <div className="liveballot-votes">
      <button className="liveballot-vote yes" onClick={onYes} aria-label="Vote yes" disabled={busy}>👍</button>
      <button className="liveballot-vote no"  onClick={onNo}  aria-label="Vote no"  disabled={busy}>👎</button>
    </div>
  );

  return (
    <div className="liveballot-overlay" onClick={view === 'reveal' || view === 'expired' ? onClose : undefined}>
      <div
        ref={overlayRef}
        className="liveballot-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Secret vote with your partner"
        tabIndex={-1}
      >
        {/* ── My vote ─────────────────────────────────────────────────── */}
        {view === 'vote' && (
          <>
            <div className="liveballot-eyebrow">
              <span className="liveballot-live-dot" aria-hidden="true" /> Secret vote
            </div>
            {TitleCard}
            <p className="liveballot-cue">Cast your vote — {otherName} won't see it until you both decide.</p>
            <VoteButtons onYes={() => castMine('up')} onNo={() => castMine('down')} />
          </>
        )}

        {/* ── Waiting for partner ─────────────────────────────────────── */}
        {view === 'waiting' && (
          <>
            <div className="liveballot-eyebrow">
              <span className="liveballot-live-dot" aria-hidden="true" /> Vote locked
            </div>
            {TitleCard}
            <div className="liveballot-waiting">
              <div className="liveballot-dots" aria-label={`Waiting for ${otherName}`}>
                <span /><span /><span />
              </div>
              <p className="liveballot-waiting-text">
                Your vote is in. Waiting for <strong>{otherName}</strong>…
              </p>
            </div>
            {role === 'initiator' && (
              <button className="liveballot-passphone" onClick={() => setPassPhone(true)} disabled={busy}>
                {otherName} with you? Hand them your phone →
              </button>
            )}
            <button className="liveballot-close-link" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </>
        )}

        {/* ── Pass-the-phone: partner votes on this device ────────────── */}
        {view === 'partner-vote' && (
          <>
            <div className="liveballot-eyebrow">
              <span className="liveballot-lock" aria-hidden="true">🔒</span> Pass to {otherName}
            </div>
            {TitleCard}
            <p className="liveballot-cue">{otherName}, cast your secret vote.</p>
            <VoteButtons onYes={() => castPartner('up')} onNo={() => castPartner('down')} />
            <button className="liveballot-close-link" onClick={() => setPassPhone(false)} disabled={busy}>
              ← Back
            </button>
          </>
        )}

        {/* ── Reveal ──────────────────────────────────────────────────── */}
        {view === 'reveal' && (
          <div className="liveballot-reveal">
            <div className="liveballot-reveal-votes">
              <div className="liveballot-reveal-person">
                <div className="liveballot-reveal-name">{firstName(ballot.initiatorName)}</div>
                <div className={`liveballot-reveal-emoji ${ballot.initiatorVote === 'up' ? 'yes' : 'no'}`}>
                  {ballot.initiatorVote === 'up' ? '👍' : '👎'}
                </div>
              </div>
              <div className="liveballot-reveal-vs">vs</div>
              <div className="liveballot-reveal-person">
                <div className="liveballot-reveal-name">{firstName(ballot.partnerName)}</div>
                <div className={`liveballot-reveal-emoji ${ballot.partnerVote === 'up' ? 'yes' : 'no'}`}>
                  {ballot.partnerVote === 'up' ? '👍' : '👎'}
                </div>
              </div>
            </div>

            {ballot.status === 'matched' ? (
              <>
                <div className="liveballot-outcome-icon">🎉</div>
                <div className="liveballot-outcome-title">It's a match!</div>
                <div className="liveballot-outcome-sub">
                  You both want to watch <strong>{title?.title}</strong>
                </div>
                <button className="liveballot-action primary" onClick={onMatch}>Let's watch</button>
              </>
            ) : (
              <>
                <div className="liveballot-outcome-icon">🤔</div>
                <div className="liveballot-outcome-title">Not this one</div>
                <div className="liveballot-outcome-sub">
                  {ballot.initiatorVote === ballot.partnerVote
                    ? 'You both passed.'
                    : 'One of you wasn’t feeling it.'}
                </div>
                {role === 'initiator' ? (
                  <button className="liveballot-action primary" onClick={onRetry}>Find another</button>
                ) : (
                  <button className="liveballot-action primary" onClick={onClose}>
                    {firstName(ballot.initiatorName)} will pick another
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Expired ─────────────────────────────────────────────────── */}
        {view === 'expired' && (
          <div className="liveballot-reveal">
            <div className="liveballot-outcome-icon">⌛</div>
            <div className="liveballot-outcome-title">Vote closed</div>
            <div className="liveballot-outcome-sub">This vote was cancelled.</div>
            <button className="liveballot-action primary" onClick={onClose}>OK</button>
          </div>
        )}
      </div>
    </div>
  );
}
