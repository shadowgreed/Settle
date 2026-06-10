import React, { useEffect, useMemo, useRef, useState } from 'react';
import tmdbService from '../services/tmdb';
import { getShowtimes, ShowtimesServiceError } from '../services/showtimes';
import AreaPicker from './AreaPicker';
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
//     concurrency cap; "Check more" verifies the next batch. Results are cached
//     (in-memory + shared CDN + Upstash) so popular areas are nearly free.
//   • Steady reveal: the first batch is held behind skeletons until it settles,
//     then the grid fades in — no poster-by-poster pop-in.
// ─────────────────────────────────────────────────────────────────────────────

const BATCH = 10;      // candidates verified per batch
const CONCURRENCY = 3; // simultaneous showtimes lookups (gentler burst)
const AUTO_ADVANCE_CAP = 30; // stop auto-checking deeper than this without a tap

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

// Verify a title against the selected area, returning 'playing' | 'none'.
// Batch verification can momentarily brush the showtimes rate limit (e.g. when
// the user changes ZIP and a fresh batch fires); a 429 is transient, NOT a
// service outage, so we back off and retry a couple of times before giving up.
async function verifyPlaying(title, loc) {
  let delay = 700;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const theaters = await getShowtimes(title, loc);
      return theaters.some(t => t.showtimes && t.showtimes.length > 0) ? 'playing' : 'none';
    } catch (e) {
      const rateLimited = e instanceof ShowtimesServiceError && e.status === 429;
      if (rateLimited && attempt < 2) {
        await sleep(delay + Math.random() * 250);
        delay *= 2;
        continue;
      }
      throw e;
    }
  }
  return 'none';
}

// Candidate pool order: best-rated first, popularity as the tiebreak.
const rankNowPlaying = (list) =>
  (list || [])
    .filter(m => m.posterPath)
    .sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.popularity || 0) - (a.popularity || 0));

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
  // Hold the first batch behind skeletons until it settles, then reveal the
  // grid all at once (fades in) rather than poster-by-poster.
  const [revealed, setRevealed] = useState(false);

  const mark = (id, status) => {
    verifiedRef.current = { ...verifiedRef.current, [id]: status };
    setVerified(verifiedRef.current);
  };

  // ── Candidate pool (national now-playing, ranked best-first) ───────────────
  // Used by both the mount effect and the error-state retry. `isCancelled`
  // guards setState after unmount (always-false for the retry path).
  const loadNowPlaying = (isCancelled = () => false) => {
    setLoading(true);
    setError(false);
    return tmdbService.getNowPlaying()
      .then(list => {
        if (isCancelled()) return;
        setMovies(rankNowPlaying(list));
        setLoading(false);
      })
      .catch(() => { if (!isCancelled()) { setError(true); setLoading(false); } });
  };

  useEffect(() => {
    let cancelled = false;
    loadNowPlaying(() => cancelled);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // across areas, and start over from the first batch (held behind skeletons).
  useEffect(() => {
    verifiedRef.current = {};
    setVerified({});
    setServiceDown(false);
    setAttempted(BATCH);
    setRevealed(false);
  }, [locationKey]);

  // A new search just re-scopes which titles to check; per-movie verification
  // for the current area stays valid, so only the batch cursor + reveal reset.
  useEffect(() => { setAttempted(BATCH); setRevealed(false); }, [query]);

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
          const status = await verifyPlaying(m.title, { lat: loc.lat, lng: loc.lng, zip: loc.zip });
          if (!cancelled) mark(m.id, status);
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

  // Once a batch settles, reveal the grid (all-at-once fade-in).
  useEffect(() => {
    if (batchSettled && !verifying) setRevealed(true);
  }, [batchSettled, verifying]);

  // Gently check the next batch when the current one turned up nothing, so the
  // user isn't forced to tap "Check more" repeatedly. Bounded to cap spend.
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

  const areaEl = onSetLocation && (
    <AreaPicker
      variant="chip"
      userLocation={userLocation}
      defaultZip={defaultZip}
      onChange={onSetLocation}
    />
  );

  // ── Gate: no area yet → ask for one (search is useless until then). ─────────
  if (!locationKey) {
    return (
      <div className="intheaters">
        <div className="intheaters-controls intheaters-controls--gate">{areaEl}</div>
        <div className="intheaters-empty">
          <div className="intheaters-empty-icon" aria-hidden="true">📍</div>
          <p>Set your area to see what's playing near you — enter a ZIP or use your location above.</p>
        </div>
      </div>
    );
  }

  // Skeletons stay up until the batch settles (no per-poster pop-in), and again
  // whenever we're auto-checking deeper with nothing to show yet.
  const stillWorking = loading || !revealed || (verifying && showing.length === 0);

  return (
    <div className="intheaters">
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
        {areaEl}
      </div>

      <div className="intheaters-status">
        Playing near <strong>{areaLabel}</strong>
        {!stillWorking && showing.length > 0 && (
          <span className="intheaters-status-count">
            {' '}· {showing.length} film{showing.length === 1 ? '' : 's'}{moreToCheck ? '+' : ''}
          </span>
        )}
      </div>

      {error && !loading && (
        <div className="intheaters-empty">
          <div className="intheaters-empty-icon" aria-hidden="true">🎬</div>
          <p>Couldn't load what's playing. Check your connection and try again.</p>
          <button type="button" className="intheaters-retry" onClick={() => loadNowPlaying()}>Try again</button>
        </div>
      )}

      {!error && stillWorking && (
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

      {!error && !stillWorking && showing.length === 0 && serviceDown && (
        <div className="intheaters-empty">
          <div className="intheaters-empty-icon" aria-hidden="true">🛠️</div>
          <p>Showtimes are temporarily unavailable. Please try again in a bit.</p>
        </div>
      )}

      {!error && !stillWorking && showing.length === 0 && !serviceDown && (
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

      {!error && !stillWorking && showing.length > 0 && (
        <ul className="intheaters-grid intheaters-grid--reveal">
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
                  {/* Persistent tap cue — the hover badge above is invisible on
                      touch, so every device gets an explicit "this opens
                      showtimes" signal here. */}
                  <div className="intheaters-cta" aria-hidden="true">🎟️ Showtimes ›</div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!error && !stillWorking && moreToCheck && (
        <button
          type="button"
          className="intheaters-more"
          onClick={() => setAttempted(a => a + BATCH)}
          disabled={verifying}
        >
          {verifying ? 'Checking…' : 'Check more films'}
        </button>
      )}

      {!error && !stillWorking && !moreToCheck && showing.length > 0 && (
        <p className="intheaters-end">That's everything playing near {areaLabel}.</p>
      )}
    </div>
  );
}
