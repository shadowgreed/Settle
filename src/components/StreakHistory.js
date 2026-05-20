import React, { useMemo, useRef } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';
import './StreakHistory.css';

// ─────────────────────────────────────────────────────────────────────────────
// StreakHistory — small modal that surfaces the last 7 nights of couples
// activity so the streak chip feels like an investment, not just a stat.
//
// Each day shows hit (couple agreed), miss (couple disagreed), or no-data
// (no couples session). Computed from watchHistory entries with mode='couple'
// where coupleAgreed indicates the ballot outcome.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function formatDayLabel(date, todayMs) {
  const diff = Math.round((todayMs - date.getTime()) / DAY_MS);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  // 2 days ago, 3 days ago, etc.
  return `${diff} days ago`;
}

function formatShortDate(date) {
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function StreakHistory({ watchHistory, streak, onClose }) {
  const modalRef = useRef(null);
  useFocusTrap(modalRef, true);

  // Build the last 7 days (today + 6 days back), each annotated with the
  // best-of-day couples ballot outcome:
  //   'hit'  — at least one coupleAgreed entry that day
  //   'miss' — at least one couple entry that day, all disagreed
  //   null   — no couples activity that day
  const days = useMemo(() => {
    const today = startOfDay(new Date()).getTime();
    const byDay = new Map(); // dayMs -> 'hit' | 'miss'
    (watchHistory || []).forEach(entry => {
      if (entry.mode !== 'couple' || !entry.watchedAt) return;
      const dayMs = startOfDay(new Date(entry.watchedAt)).getTime();
      const existing = byDay.get(dayMs);
      // 'hit' wins over 'miss' if there are multiple entries the same day.
      if (entry.coupleAgreed) {
        byDay.set(dayMs, 'hit');
      } else if (existing !== 'hit') {
        byDay.set(dayMs, 'miss');
      }
    });
    const out = [];
    for (let i = 0; i < 7; i++) {
      const dayMs = today - i * DAY_MS;
      out.push({
        dayMs,
        date: new Date(dayMs),
        outcome: byDay.get(dayMs) || null,
      });
    }
    return out; // [today, yesterday, …, 6-days-ago]
  }, [watchHistory]);

  const todayMs = days[0]?.dayMs;
  const hitsLast7 = days.filter(d => d.outcome === 'hit').length;

  return (
    <div className="streak-overlay" onClick={onClose}>
      <div
        ref={modalRef}
        className="streak-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="streak-modal-title"
        tabIndex={-1}
      >
        <div className="streak-header">
          <h2 id="streak-modal-title" className="streak-title">
            <span aria-hidden="true">🔥</span> {streak}-night streak
          </h2>
          <button
            type="button"
            className="privacy-close"
            onClick={onClose}
            aria-label="Close streak history"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        <div className="streak-body">
          <p className="streak-tagline">
            {hitsLast7 >= 5
              ? 'You two are on fire.'
              : hitsLast7 >= 3
                ? 'Building momentum.'
                : 'Keep going — every night counts.'}
          </p>

          <div className="streak-grid" role="list" aria-label="Last 7 days">
            {days.map((d, i) => {
              const cls =
                d.outcome === 'hit'  ? 'streak-day streak-hit'  :
                d.outcome === 'miss' ? 'streak-day streak-miss' :
                                       'streak-day streak-none';
              const label =
                d.outcome === 'hit'  ? `Agreed on ${formatShortDate(d.date)}` :
                d.outcome === 'miss' ? `Missed ${formatShortDate(d.date)}` :
                                       `No couples pick on ${formatShortDate(d.date)}`;
              return (
                <div key={d.dayMs} className={cls} role="listitem" aria-label={label} title={label}>
                  <span className="streak-day-icon" aria-hidden="true">
                    {d.outcome === 'hit'  ? '🔥' :
                     d.outcome === 'miss' ? '—'  :
                                           '·'}
                  </span>
                  <span className="streak-day-label" aria-hidden="true">
                    {i === 0 ? 'Today' : formatDayLabel(d.date, todayMs).replace(' ago', '')}
                  </span>
                </div>
              );
            })}
          </div>

          <p className="streak-footer-note">
            Streak counts consecutive nights where both partners voted yes in
            a Couples ballot. Miss a night, the streak resets.
          </p>
        </div>
      </div>
    </div>
  );
}
