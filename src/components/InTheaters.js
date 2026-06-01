import React, { useEffect, useMemo, useRef, useState } from 'react';
import tmdbService from '../services/tmdb';
import { getShowtimes, ShowtimesServiceError } from '../services/showtimes';
import './InTheaters.css';

// ─────────────────────────────────────────────────────────────────────────────
// InTheaters — the "In Theaters" tab. A location-first storefront of films you
// can actually go see *tonight, near you*.
//
// Design rules baked in here:
//   • Location-first: nothing is shown until an area (ZIP / GPS) is set. The
//     national TMDB "now playing" list is only a candidate pool.
//   • Verified, no leakage: every poster shown has been confirmed to have real
//     showtimes at the selected location (one cached showtimes lookup per
//     title). A film is NEVER displayed before it's verified, so stale titles
//     that have left local theaters can't slip through.
//   • Best-first: candidates are ranked by rating (desc), then popularity.
//   • Bounded cost: verification runs in batches of BATCH with a small
//     concurrency cap; "Show more" verifies the next batch. Results are cached
//     (in-memory + shared CDN) so popular areas are nearly free.
//
// Self-contained on purpose — easy to reshape later (rails, format filters,
// affiliate tags) without touching the rest of the app.
// ─────────────────────────────────────────────────────────────────────────────

const BATCH = 12;      // candidates verified per batch
const CONCURRENCY = 4; // simultaneous showtimes lookups
const AUTO_ADVANCE_CAP = 36; // stop auto-checking deeper than this without a tap

// Run `worker` over `items` with at most `limit` in flight at once.
async function runConcurrent(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

export default function InTheaters({ onPickMovie, userLocation, defaultZip, onSetLocation }) {
  const [movies,  setMovies]  = useState([]);   // rating-sorted candidate pool
  const [loading, setLoading] = useState(true); // now-playing fetch
  const [error,   setError]   = useState(false);
  const [query,   setQuery]   = useState('');

  // Verification: id -> 'playing' | 'none' | 'error'. A ref mirrors it so the
  // verify effect can skip already-checked titles without re-running on every
  // single result.
  const [verified, setVerified] = useState({});
  const verifiedRef = useRef({});
  const [attempted, setAttempted] = useState(BATCH); // how many candidates we've tried
  const [verifying, setVerifying] = useState(false);
  const [serviceDown, setServiceDown] = useState(false);

  const mark = (id, status) => {
    verifiedRef.current = { ...verifiedRef.current, [id]: status };
    setVerified(verifiedRef.current);
  };

  // ── Candidate pool (national now-playing, ranked best-first) ───────────────
  const loadNowPlaying = () => {
    setLoading(true);
    setError(false);
    return tmdbService.getNowPlaying()
      .then(list => {
        const ranked = (list || [])
          .filter(m => m.posterPath)
          .sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.popularity || 0) - (a.popularity || 0));
        setMovies(ranked);
        setLoading(false);
      })
      .catch(() => { setError(true); setLoading(false); });
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    tmdbService.getNowPlaying()
      .then(list => {
        if (cancelled) return;
        const ranked = (list || [])
          .filter(m => m.posterPath)
          .sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.popularity || 0) - (a.popularity || 0));
        setMovies(ranked);
        setLoading(false);
      })
      .catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  // Restore a previously-used area on first mount so returning users skip the
  // "set your area" gate. Silent → no analytics noise for an auto-restore.
  useEffect(() => {
    if (!userLocation && defaultZip && /^\d{5}$/.test(defaultZip) && onSetLocation) {
      onSetLocation({ mode: 'zip', zip: defaultZip, silent: true }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const locationKey = userLocation
    ? (userLocation.zip || `${userLocation.lat},${userLocation.lng}`)
    : null;

  // Title filter applies to the candidate pool (already rating-sorted).
  const targets = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return movies;
    return movies.filter(m => (m.title || '').toLowerCase().includes(q));
  }, [movies, query]);

  // Changing area invalidates ALL prior verification — a film playing near the
  // old ZIP says nothing about the new one. Wipe the map so nothing leaks
  // across areas, and start over from the first batch.
  useEffect(() => {
    verifiedRef.current = {};
    setVerified({});
    setServiceDown(false);
    setAttempted(BATCH);
  }, [locationKey]);

  // A new search just re-scopes which titles to check; per-movie verification
  // for the current area stays valid, so only the batch cursor resets.
  useEffect(() => { setAttempted(BATCH); }, [query]);

  // ── Verification driver ────────────────────────────────────────────────────
  useEffect(() => {
    if (!locationKey || movies.length === 0) return;
    const loc = userLocation;
    const slice = targets.slice(0, attempted).filter(m => !(m.id in verifiedRef.current));
    if (slice.length === 0) return;

    let cancelled = false;
    setVerifying(true);
    (async () => {
      let sawError = false;
      await runConcurrent(slice, CONCURRENCY, async (m) => {
        if (cancelled) return;
        try {
          const theaters = await getShowtimes(m.title, { lat: loc.lat, lng: loc.lng, zip: loc.zip });
          const playing = theaters.some(t => t.showtimes && t.showtimes.length > 0);
          if (!cancelled) mark(m.id, playing ? 'playing' : 'none');
        } catch (e) {
          sawError = true;
          // Fail CLOSED — never show an unverified title. Mark as error so it
          // stays hidden; if the whole service is down we surface a banner.
          if (e instanceof ShowtimesServiceError) setServiceDown(true);
          if (!cancelled) mark(m.id, 'error');
        }
      });
      if (!cancelled) {
        if (!sawError) setServiceDown(false);
        setVerifying(false);
      }
    })();

    return () => { cancelled = true; };
    // verifiedRef is read fresh; excluded from deps on purpose to avoid re-runs
    // on every single result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, attempted, locationKey, movies.length]);

  // Films confirmed to be playing locally, in best-first order.
  const showing = useMemo(
    () => targets.filter(m => verified[m.id] === 'playing'),
    [targets, verified]
  );

  // How far through the current target list we've resolved.
  const resolvedCount = useMemo(
    () => targets.slice(0, attempted).filter(m => m.id in verified).length,
    [targets, attempted, verified]
  );
  const batchSettled = !verifying && resolvedCount >= Math.min(attempted, targets.length);
  const moreToCheck  = attempted < targets.length;

  // Gently check the next batch when the current one turned up nothing, so the
  // user isn't forced to tap "Show more" repeatedly. Bounded to cap spend.
  useEffect(() => {
    if (batchSettled && !serviceDown && showing.length === 0 && moreToCheck && attempted < AUTO_ADVANCE_CAP) {
      setAttempted(a => a + BATCH);
    }
  }, [batchSettled, serviceDown, showing.length, moreToCheck, attempted]);

  const areaLabel = useMemo(() => {
    if (userLocation?.source === 'gps') return 'your location';
    if (userLocation?.zip) return userLocation.zip;
    if (defaultZip) return defaultZip;
    return 'your area';
  }, [userLocation, defaultZip]);

  // ── Render ─────────────────────────────────────────────────────────────────
  const controls = (
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
          disabled={!locationKey}
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
  );

  // Gate: no area yet → ask for one (nothing unverified is ever shown).
  if (!locationKey) {
    return (
      <div className="intheaters">
        {controls}
        <div className="intheaters-empty">
          <div className="intheaters-empty-icon" aria-hidden="true">📍</div>
          <p>Set your area to see what's playing near you — enter a ZIP or use your location above.</p>
        </div>
      </div>
    );
  }

  const loadingNow = loading || (showing.length === 0 && !batchSettled);

  return (
    <div className="intheaters">
      {controls}

      <div className="intheaters-status">
        Playing near <strong>{areaLabel}</strong>
      </div>

      {error && !loading && (
        <div className="intheaters-empty">
          <div className="intheaters-empty-icon" aria-hidden="true">🎬</div>
          <p>Couldn't load what's playing. Check your connection and try again.</p>
          <button type="button" className="intheaters-retry" onClick={loadNowPlaying}>Try again</button>
        </div>
      )}

      {!error && loadingNow && (
        <>
          <div className="intheaters-checking" role="status">
            Finding films playing near {areaLabel}…
          </div>
          <div className="intheaters-grid" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="intheaters-card is-skeleton">
                <div className="intheaters-poster intheaters-skel" />
                <div className="intheaters-skel-line" />
                <div className="intheaters-skel-line short" />
              </div>
            ))}
          </div>
        </>
      )}

      {!error && !loadingNow && showing.length === 0 && serviceDown && (
        <div className="intheaters-empty">
          <div className="intheaters-empty-icon" aria-hidden="true">🛠️</div>
          <p>Showtimes are temporarily unavailable. Please try again in a bit.</p>
        </div>
      )}

      {!error && !loadingNow && showing.length === 0 && !serviceDown && (
        <div className="intheaters-empty">
          <div className="intheaters-empty-icon" aria-hidden="true">{query ? '🔍' : '🍿'}</div>
          <p>
            {query
              ? `No films matching “${query.trim()}” are playing near ${areaLabel}.`
              : `No films are playing near ${areaLabel} right now. Try a different ZIP above.`}
          </p>
          {query && (
            <button type="button" className="intheaters-retry" onClick={() => setQuery('')}>Clear search</button>
          )}
        </div>
      )}

      {!error && showing.length > 0 && (
        <ul className="intheaters-grid">
          {showing.map(movie => {
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
                    <img src={tmdbService.getPosterUrl(movie.posterPath, 'w342')} alt="" loading="lazy" />
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

      {!error && !loadingNow && moreToCheck && (
        <button
          type="button"
          className="intheaters-more"
          onClick={() => setAttempted(a => a + BATCH)}
          disabled={verifying}
        >
          {verifying ? 'Checking…' : 'Show more films'}
        </button>
      )}
    </div>
  );
}

// ── AreaControl ──────────────────────────────────────────────────────────────
// Sets the area showtimes are pulled for. Also the source of truth for the grid
// filter — change the ZIP and the whole grid re-verifies against the new area.

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
