import React from 'react';
import tmdbService from '../services/tmdb';
import './NudgeCard.css';

// ─────────────────────────────────────────────────────────────────────────────
// NudgeCard — shared re-engagement card for the home screen.
//
// One component powers the per-mode retention nudges so they look and behave
// identically:
//   • Solo:    "You saved {title} — watch it tonight?"        (saved pick)
//   • Couples: "{partner} saved {title} — watch it together?" (partner's pick)
//
// Same interaction contract as NewReleasesCard: the body is one big tap target
// that takes the user straight to the title, the ✕ dismisses for the day
// (parent persists the day-key). A poster thumbnail makes the nudge concrete —
// it's about *this* film, not a generic reminder.
// ─────────────────────────────────────────────────────────────────────────────

export default function NudgeCard({ icon, posterPath, headline, sub, ctaAriaLabel, onTap, onDismiss }) {
  return (
    <div className="nudge-card" role="group">
      <button
        type="button"
        className="nudge-body"
        onClick={onTap}
        aria-label={ctaAriaLabel}
      >
        {posterPath ? (
          <img
            className="nudge-poster"
            src={tmdbService.getPosterUrl(posterPath, 'w92')}
            alt=""
          />
        ) : (
          <span className="nudge-icon" aria-hidden="true">{icon}</span>
        )}
        <span className="nudge-text">
          <span className="nudge-headline">{headline}</span>
          {sub && <span className="nudge-sub">{sub}</span>}
        </span>
        <span className="nudge-arrow" aria-hidden="true">→</span>
      </button>
      <button
        type="button"
        className="nudge-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss for today"
      >
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  );
}
