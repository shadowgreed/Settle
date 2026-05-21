import React from 'react';
import './NewReleasesCard.css';

// ─────────────────────────────────────────────────────────────────────────────
// NewReleasesCard — lightweight re-engagement hook (PM roadmap 3.2).
//
// Sits at the top of the home screen for returning users in solo mode.
// Reports the count of new titles ("dropped this week") that match the
// user's top voted genres and selected services. Tap = re-runs the pick
// engine seeded with those top genres so the user lands on a fresh pick.
//
// Dismissible — once dismissed, the dismiss flag is persisted for the day
// (parent component handles localStorage). Refreshes daily.
// ─────────────────────────────────────────────────────────────────────────────

export default function NewReleasesCard({ count, genreNames, onTap, onDismiss }) {
  if (!count || count <= 0) return null;
  // Headline copy: "3 new titles…" or "1 new title…" — grammar matters.
  const headline = count === 1
    ? '1 new title in your genres dropped this week'
    : `${count} new titles in your genres dropped this week`;

  const ariaGenres = genreNames && genreNames.length > 0
    ? ` — ${genreNames.join(', ')}`
    : '';

  return (
    // role="group" is quieter than "region" for screen readers and removes
    // the duplicate announcement caused by both region and inner button
    // carrying their own aria-label. Only the button label is announced now.
    <div className="newrel-card" role="group">
      <button
        type="button"
        className="newrel-body"
        onClick={onTap}
        aria-label={`Show me a fresh pick from ${count} new ${count === 1 ? 'title' : 'titles'}${ariaGenres}`}
      >
        <span className="newrel-icon" aria-hidden="true">🆕</span>
        <span className="newrel-text">
          <span className="newrel-headline">{headline}</span>
          {genreNames && genreNames.length > 0 && (
            <span className="newrel-sub">
              {genreNames.slice(0, 3).join(' · ')}
            </span>
          )}
        </span>
        <span className="newrel-arrow" aria-hidden="true">→</span>
      </button>
      <button
        type="button"
        className="newrel-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss new releases card"
      >
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  );
}
