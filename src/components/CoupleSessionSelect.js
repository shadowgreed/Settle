import React from 'react';
import './CoupleSessionSelect.css';

// ─────────────────────────────────────────────────────────────────────────────
// CoupleSessionSelect — the "selecting" phase of a live two-device couple
// session. Each partner picks their OWN moods on their OWN phone, locks in, and
// waits for the other. When both are locked in, the initiator's device runs the
// pick and broadcasts the result (handled in App.js) — this component just shows
// the "finding your pick" state until the result card takes over.
//
// Reuses the app's existing mood-grid / chip CSS classes so it looks identical
// to the normal selector. All selection logic stays in App.js (bound to the
// 'session' genre slot) and is passed in as props.
// ─────────────────────────────────────────────────────────────────────────────

const firstName = (n) => (n || '').trim().split(/\s+/)[0] || 'your partner';

export default function CoupleSessionSelect({
  session,
  role,                 // 'initiator' | 'partner'
  partnerName,
  moods,                // MOODS array [{ label, emoji, ids }]
  genres,               // [{ id, name }]
  selectedIds,          // this device's selected genre ids (the 'session' slot)
  isMoodActive,         // (ids) => bool
  getGenreClass,        // (id) => string
  onToggleMood,         // (ids) => void
  onToggleGenre,        // (id) => void
  showAllGenres,
  onToggleShowGenres,
  onReady,
  onUnready,
  onCancel,
}) {
  const iAmReady     = role === 'initiator' ? session.initiatorReady : session.partnerReady;
  const partnerReady = role === 'initiator' ? session.partnerReady   : session.initiatorReady;
  const bothReady    = session.initiatorReady && session.partnerReady;
  const partner      = firstName(partnerName);
  const canLockIn    = (selectedIds?.length || 0) > 0;

  // Both locked in → the initiator is running the pick. Show a shared spinner.
  if (bothReady) {
    return (
      <div className="csess">
        <div className="csess-head">
          <span className="csess-live-dot" aria-hidden="true" /> Couple session
        </div>
        <div className="csess-finding">
          <div className="csess-finding-dots" aria-label="Finding your pick">
            <span /><span /><span />
          </div>
          <p className="csess-finding-text">Finding something you'll <strong>both</strong> like…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="csess">
      <div className="csess-head">
        <span className="csess-live-dot" aria-hidden="true" /> Couple session
        <button className="csess-cancel" onClick={onCancel} aria-label="Cancel session">Cancel</button>
      </div>

      {/* Partner status chip */}
      <div className={`csess-partner ${partnerReady ? 'ready' : ''}`} role="status" aria-live="polite">
        {partnerReady
          ? <><span aria-hidden="true">✓</span> {partner} is locked in</>
          : <><span className="csess-partner-spin" aria-hidden="true" /> {partner} is choosing…</>}
      </div>

      {iAmReady ? (
        // I'm locked in, waiting for partner
        <div className="csess-waiting">
          <div className="csess-locked"><span aria-hidden="true">🔒</span> Your moods are locked in</div>
          <p className="csess-waiting-text">Waiting for {partner} to lock in…</p>
          <button className="csess-change" onClick={onUnready}>Change my moods</button>
        </div>
      ) : (
        // Still choosing
        <>
          <p className="csess-cue">Pick your moods — {partner} picks theirs on their phone.</p>
          <div className="mood-grid" role="group" aria-label="Your moods">
            {moods.map(mood => (
              <button
                key={mood.label}
                className={`mood-btn ${isMoodActive(mood.ids) ? 'mood-on' : ''}`}
                onClick={() => onToggleMood(mood.ids)}
                aria-pressed={isMoodActive(mood.ids)}
              >
                <span className="mood-emoji" aria-hidden="true">{mood.emoji}</span>
                <span className="mood-label">{mood.label}</span>
              </button>
            ))}
          </div>

          <button
            className="show-genres-toggle"
            onClick={onToggleShowGenres}
            aria-expanded={showAllGenres}
          >
            {showAllGenres ? '▲ Hide genres' : '＋ More genres'}
          </button>
          {showAllGenres && (
            <div className="chip-grid genre-expand" role="group" aria-label="Genres">
              {genres.map(genre => (
                <button
                  type="button"
                  key={genre.id}
                  className={`chip ${getGenreClass(genre.id)}`}
                  onClick={() => onToggleGenre(genre.id)}
                  aria-pressed={selectedIds?.includes(genre.id)}
                >
                  {genre.name}
                </button>
              ))}
            </div>
          )}

          <button
            className="csess-lockin"
            onClick={onReady}
            disabled={!canLockIn}
            title={canLockIn ? undefined : 'Pick at least one mood first'}
          >
            Lock in my moods
          </button>
        </>
      )}
    </div>
  );
}
