import React, { useEffect, useState } from 'react';
import tmdbService from '../services/tmdb';
import './InTheaters.css';

// ─────────────────────────────────────────────────────────────────────────────
// InTheaters — the "In Theaters" tab, remodeled as a browse-first grid.
//
// The decision-engine framing (moods → genres → one pick) doesn't fit theater
// behaviour: people heading to the cinema already know what they want to see.
// So this is a generic, customizable storefront — every film currently playing
// in US theaters, as a poster grid. Tap a poster → showtimes + in-app tickets
// (handled by the parent via onPickMovie).
//
// This is intentionally a clean, self-contained component (ported from the
// Expo HomeScreen) so it can be reshaped later — featured rails, "opening this
// week", premium-format filters, etc. — without touching the rest of the app.
// ─────────────────────────────────────────────────────────────────────────────

export default function InTheaters({ onPickMovie }) {
  const [movies,  setMovies]  = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);

    tmdbService.getNowPlaying()
      .then(list => {
        if (cancelled) return;
        // Only show films we have poster art for — a missing poster reads as
        // broken in a grid. Order is TMDB's curated now-playing ranking.
        setMovies((list || []).filter(m => m.posterPath));
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  const retry = () => {
    // Force a fresh fetch by remounting the effect's work.
    setLoading(true);
    setError(false);
    tmdbService.getNowPlaying()
      .then(list => { setMovies((list || []).filter(m => m.posterPath)); setLoading(false); })
      .catch(() => { setError(true); setLoading(false); });
  };

  return (
    <div className="intheaters">
      <div className="intheaters-head">
        <h2 className="intheaters-title">In theaters now</h2>
        <p className="intheaters-sub">
          Pick a movie — grab tickets without leaving the app.
        </p>
      </div>

      {loading && (
        <div className="intheaters-grid" aria-hidden="true">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="intheaters-card is-skeleton">
              <div className="intheaters-poster intheaters-skel" />
              <div className="intheaters-skel-line" />
              <div className="intheaters-skel-line short" />
            </div>
          ))}
        </div>
      )}

      {!loading && error && (
        <div className="intheaters-empty">
          <div className="intheaters-empty-icon" aria-hidden="true">🎬</div>
          <p>Couldn't load what's playing. Check your connection and try again.</p>
          <button type="button" className="intheaters-retry" onClick={retry}>
            Try again
          </button>
        </div>
      )}

      {!loading && !error && movies.length === 0 && (
        <div className="intheaters-empty">
          <div className="intheaters-empty-icon" aria-hidden="true">🍿</div>
          <p>No films are listed as playing right now. Check back soon.</p>
        </div>
      )}

      {!loading && !error && movies.length > 0 && (
        <ul className="intheaters-grid">
          {movies.map(movie => {
            const meta = [
              movie.year || null,
              movie.rating ? `★ ${movie.rating}` : null,
            ].filter(Boolean).join('  ·  ');

            return (
              <li key={movie.id} className="intheaters-card">
                <button
                  type="button"
                  className="intheaters-card-btn"
                  onClick={() => onPickMovie(movie)}
                  aria-label={`Get tickets for ${movie.title}`}
                >
                  <div className="intheaters-poster">
                    <img
                      src={tmdbService.getPosterUrl(movie.posterPath, 'w342')}
                      alt=""
                      loading="lazy"
                    />
                    <span className="intheaters-tickets" aria-hidden="true">🎟️ Tickets</span>
                  </div>
                  <div className="intheaters-name" title={movie.title}>{movie.title}</div>
                  {meta && <div className="intheaters-meta">{meta}</div>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
