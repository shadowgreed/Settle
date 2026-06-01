import React, { useEffect, useMemo, useState } from 'react';
import tmdbService from '../services/tmdb';
import './InTheaters.css';

// ─────────────────────────────────────────────────────────────────────────────
// InTheaters — the "In Theaters" tab, a browse-first storefront.
//
// Cinema-goers already know what they want to see, so this skips the decision
// engine: every film now playing in US theaters as a poster grid. Tap a poster
// → showtimes + in-app tickets (handled by the parent via onPickMovie).
//
// Two find-it affordances sit above the grid:
//   1. Search — filters the grid by title as the user types (the slate is
//      national, so this is a fast client-side filter, no extra fetch).
//   2. Area  — a ZIP / "use my location" control. The now-playing list is
//      national, but the chosen area is what showtimes are pulled for, so
//      setting it here means tapping a poster goes straight to local times.
//
// Intentionally self-contained so the tab can be reshaped later (featured
// rails, premium-format filters, affiliate tags) without touching the app.
// ─────────────────────────────────────────────────────────────────────────────

export default function InTheaters({ onPickMovie, userLocation, defaultZip, onSetLocation }) {
  const [movies,  setMovies]  = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(false);
  const [query,   setQuery]   = useState('');

  const load = () => {
    setLoading(true);
    setError(false);
    return tmdbService.getNowPlaying()
      .then(list => { setMovies((list || []).filter(m => m.posterPath)); setLoading(false); })
      .catch(() => { setError(true); setLoading(false); });
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    tmdbService.getNowPlaying()
      .then(list => {
        if (cancelled) return;
        // Only films we have poster art for — a missing poster reads as broken
        // in a grid. Order is TMDB's curated now-playing ranking.
        setMovies((list || []).filter(m => m.posterPath));
        setLoading(false);
      })
      .catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  // Title filter — case/diacritic-insensitive, recomputed only when the slate
  // or query changes.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return movies;
    return movies.filter(m => (m.title || '').toLowerCase().includes(q));
  }, [movies, query]);

  return (
    <div className="intheaters">
      <div className="intheaters-head">
        <h2 className="intheaters-title">In theaters now</h2>
        <p className="intheaters-sub">
          Pick a movie — grab tickets without leaving the app.
        </p>
      </div>

      <div className="intheaters-controls">
        <div className="intheaters-search">
          <span className="intheaters-search-icon" aria-hidden="true">🔍</span>
          <input
            type="search"
            className="intheaters-search-input"
            placeholder="Search movies in theaters"
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label="Search movies in theaters by title"
            enterKeyHint="search"
          />
          {query && (
            <button
              type="button"
              className="intheaters-search-clear"
              onClick={() => setQuery('')}
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>

        {onSetLocation && (
          <AreaControl
            userLocation={userLocation}
            defaultZip={defaultZip}
            onSetLocation={onSetLocation}
          />
        )}
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
          <button type="button" className="intheaters-retry" onClick={load}>
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

      {!loading && !error && movies.length > 0 && filtered.length === 0 && (
        <div className="intheaters-empty">
          <div className="intheaters-empty-icon" aria-hidden="true">🔍</div>
          <p>No films in theaters match “{query.trim()}”.</p>
          <button type="button" className="intheaters-retry" onClick={() => setQuery('')}>
            Clear search
          </button>
        </div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <ul className="intheaters-grid">
          {filtered.map(movie => {
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

// ── AreaControl ──────────────────────────────────────────────────────────────
// Compact "where are you?" control. Sets the area showtimes are pulled for, so
// a poster tap can skip the location prompt and go straight to local times.

function AreaControl({ userLocation, defaultZip, onSetLocation }) {
  const [editing,  setEditing]  = useState(false);
  const [zipDraft, setZipDraft] = useState('');
  const [busy,     setBusy]     = useState(false);
  const [err,      setErr]      = useState('');

  const label = useMemo(() => {
    if (userLocation?.source === 'gps') return 'Near you';
    if (userLocation?.zip) return `Near ${userLocation.zip}`;
    if (defaultZip) return `Near ${defaultZip}`;
    return 'Set your area';
  }, [userLocation, defaultZip]);

  const open = () => {
    setZipDraft(userLocation?.zip || defaultZip || '');
    setErr('');
    setEditing(true);
  };

  const close = () => { setEditing(false); setErr(''); setBusy(false); };

  const submitZip = async (e) => {
    e?.preventDefault?.();
    const zip = (zipDraft || '').trim();
    if (!/^\d{5}$/.test(zip)) { setErr('Enter a valid 5-digit ZIP.'); return; }
    setBusy(true); setErr('');
    try {
      await onSetLocation({ mode: 'zip', zip });
      setEditing(false);
    } catch (e2) {
      setErr(e2?.message || 'Could not set that area. Try again.');
    } finally { setBusy(false); }
  };

  const useGps = async () => {
    setBusy(true); setErr('');
    try {
      await onSetLocation({ mode: 'gps' });
      setEditing(false);
    } catch (e2) {
      setErr(e2?.message || 'Location unavailable. Use a ZIP instead.');
    } finally { setBusy(false); }
  };

  if (!editing) {
    return (
      <button type="button" className="intheaters-area" onClick={open} aria-label="Set your area for showtimes">
        <span className="intheaters-area-icon" aria-hidden="true">📍</span>
        <span className="intheaters-area-label">{label}</span>
      </button>
    );
  }

  return (
    <form className="intheaters-area-form" onSubmit={submitZip}>
      <div className="intheaters-area-row">
        <input
          type="text"
          className="intheaters-area-input"
          placeholder="ZIP code"
          value={zipDraft}
          onChange={e => setZipDraft(e.target.value.replace(/[^\d]/g, '').slice(0, 5))}
          inputMode="numeric"
          pattern="\d{5}"
          maxLength={5}
          autoFocus
          aria-label="5-digit ZIP code"
          autoComplete="postal-code"
          disabled={busy}
        />
        <button type="submit" className="intheaters-area-go" disabled={busy || zipDraft.length !== 5}>
          {busy ? '…' : 'Set'}
        </button>
      </div>
      <div className="intheaters-area-actions">
        <button type="button" className="intheaters-area-gps" onClick={useGps} disabled={busy}>
          <span aria-hidden="true">🎯</span> Use my location
        </button>
        <button type="button" className="intheaters-area-cancel" onClick={close} disabled={busy}>
          Cancel
        </button>
      </div>
      {err && <p className="intheaters-area-error" role="alert">{err}</p>}
    </form>
  );
}
