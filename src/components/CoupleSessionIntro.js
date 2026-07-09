import React, { useEffect, useRef } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';
import CoupleLink from './CoupleLink';
import './CoupleSessionIntro.css';

// ─────────────────────────────────────────────────────────────────────────────
// CoupleSessionIntro — shown when an UNLINKED user taps "Couple session".
//
// Explains, without overwhelming, that a couple session runs on two phones and
// needs a one-time link, then drops them straight into the linking flow
// (reuses <CoupleLink/>). Once linked, a "Start the session" CTA appears.
// ─────────────────────────────────────────────────────────────────────────────

const STEPS = [
  { icon: '📱', title: 'Two phones', body: 'You each use your own phone, side by side or miles apart.' },
  { icon: '🔗', title: 'Link once',  body: "Share a 6-character code with your partner. You only do this once — you stay linked." },
  { icon: '🗳️', title: 'Pick & vote', body: 'Each choose your moods, then a secret vote settles it together.' },
];

export default function CoupleSessionIntro({
  partnerName,
  onGenerateCode,
  onVerifyCode,
  onUnlink,
  onStart,
  onClose,
  onSkipToQuickPick,
}) {
  const modalRef = useRef(null);
  useFocusTrap(modalRef, true);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const linked = !!partnerName;

  return (
    <div className="csi-overlay" onClick={onClose}>
      <div
        ref={modalRef}
        className="csi-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="csi-title"
        tabIndex={-1}
      >
        <button className="csi-close" onClick={onClose} aria-label="Close">
          <span aria-hidden="true">✕</span>
        </button>

        <div className="csi-icon" aria-hidden="true">🎬</div>
        <h2 id="csi-title" className="csi-title">Watch together, on two phones</h2>
        {/* Not-linked subtitle removed (spec §1.2) — it repeated the title
            verbatim and the three steps below already carry the explanation.
            The linked-state line stays: it describes what "Start" does next,
            which isn't said anywhere else. */}
        {linked && (
          <p className="csi-sub">
            You're linked — start a session and it appears live on both screens.
          </p>
        )}

        {/* How it works — three quick beats, no wall of text */}
        {!linked && (
          <ol className="csi-steps">
            {STEPS.map((s, i) => (
              <li key={i} className="csi-step">
                <span className="csi-step-icon" aria-hidden="true">{s.icon}</span>
                <span className="csi-step-text">
                  <span className="csi-step-title">{s.title}</span>
                  <span className="csi-step-body">{s.body}</span>
                </span>
              </li>
            ))}
          </ol>
        )}

        {/* Linking flow (reused) */}
        <div className="csi-link">
          {!linked && <div className="csi-link-label">Link your accounts</div>}
          <CoupleLink
            partnerName={partnerName}
            onGenerateCode={onGenerateCode}
            onVerifyCode={onVerifyCode}
            onUnlink={onUnlink}
            showIntro={false}
          />
        </div>

        {linked && (
          <button className="csi-start" onClick={onStart}>
            <span aria-hidden="true">🎬</span> Start the session
          </button>
        )}

        {/* Escape hatch (spec §1.4) — a real tap target, not just instructions
            for one the user has to go perform themselves. Keeps the session
            alive (Quick Pick) instead of a dead end when a partner can't
            link right now, giving linking a second chance later. */}
        {!linked && (
          <button type="button" className="csi-skip" onClick={onSkipToQuickPick}>
            Not together right now? Pick on this phone instead →
          </button>
        )}
      </div>
    </div>
  );
}
