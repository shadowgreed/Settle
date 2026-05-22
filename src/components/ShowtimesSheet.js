import React, { useEffect, useMemo, useRef, useState } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';
import { theatersNearby, showtimesAt, findMovieSlug, todayISO, formatShowtime } from '../services/amc';
import { distanceMi, formatMi, DEFAULT_RADIUS_MI } from '../utils/haversine';
import { trackShowtimesOpened } from '../services/analytics';
import './ShowtimesSheet.css';

// ─────────────────────────────────────────────────────────────────────────────
// ShowtimesSheet — bottom-sheet modal for Theater Mode 2.0.
//
// Opens when user taps "Get tickets" on a theater pick. Loads:
//   1. User's effective location (from props — App.js owns the state)
//   2. AMC's slug for the picked movie (search by title + year)
//   3. AMC theaters near the user, filtered to those showing this movie
//   4. Showtimes per theater for today
//
// Renders the top 3 nearest theaters by default; "Show more" expands to
// up to 10. Theaters > 30mi away are hidden from the default view.
//
// Showtime pills are visually-styled tap targets but currently no-ops —
// the affiliate routing layer ships in M4. The click event is wired up
// so the analytics + deep-link logic can drop in cleanly later.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_VISIBLE = 3;
const EXPANDED_VISIBLE = 10;

export default function ShowtimesSheet({ result, userLocation, onClose }) {
  const sheetRef = useRef(null);
  useFocusTrap(sheetRef, true);

  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [theaters, setTheaters]     = useState([]); // [{...theater, distanceMi, showtimes }]
  const [expanded, setExpanded]     = useState(false);
  const [movieFound, setMovieFound] = useState(true); // false if AMC doesn't carry this title

  // Memoised list of theaters to render — sorted by distance, filtered to
  // those with at least one showtime, capped at expansion threshold.
  const visibleTheaters = useMemo(() => {
    const withShowtimes = theaters.filter(t => t.showtimes && t.showtimes.length > 0);
    const sorted = [...withShowtimes].sort((a, b) => {
      const dA = typeof a.distanceMi === 'number' ? a.distanceMi : Infinity;
      const dB = typeof b.distanceMi === 'number' ? b.distanceMi : Infinity;
      return dA - dB;
    });
    // Hide theaters > DEFAULT_RADIUS_MI unless expanded
    const withinRange = expanded
      ? sorted
      : sorted.filter(t => (t.distanceMi ?? 0) <= DEFAULT_RADIUS_MI);
    return withinRange.slice(0, expanded ? EXPANDED_VISIBLE : DEFAULT_VISIBLE);
  }, [theaters, expanded]);

  const moreAvailable = useMemo(() => {
    if (expanded) return false;
    const withShowtimes = theaters.filter(t => t.showtimes && t.showtimes.length > 0);
    return withShowtimes.length > DEFAULT_VISIBLE;
  }, [theaters, expanded]);

  // Load on mount. Cancellable to avoid setState on unmount.
  useEffect(() => {
    if (!result?.title) return;

    let cancelled = false;

    (async () => {
      setLoading(true);
      setError('');

      try {
        // Step 1 — resolve AMC movie slug
        const slug = await findMovieSlug(result.title, result.year);
        if (cancelled) return;
        if (!slug) {
          setMovieFound(false);
          setLoading(false);
          return;
        }

        // Step 2 — find theaters near user
        const lat = userLocation?.lat;
        const lng = userLocation?.lng;
        const near = await theatersNearby({ lat, lng, radiusMi: DEFAULT_RADIUS_MI + 20 });
        if (cancelled) return;
        if (near.length === 0) {
          setTheaters([]);
          setLoading(false);
          return;
        }

        // Step 3 — for each theater, fetch today's showtimes for this movie.
        // Cap parallelism to avoid hammering AMC's API on the first paint —
        // the top 8 nearest theaters are plenty for the default view.
        const withDistance = near
          .map(t => ({
            ...t,
            distanceMi: distanceMi(userLocation, { lat: t.lat, lng: t.lng }),
          }))
          .sort((a, b) => (a.distanceMi ?? Infinity) - (b.distanceMi ?? Infinity))
          .slice(0, 10);

        const date = todayISO();
        const showtimeResults = await Promise.allSettled(
          withDistance.map(t => showtimesAt(t.id, slug, date))
        );
        if (cancelled) return;

        const enriched = withDistance.map((t, i) => ({
          ...t,
          showtimes: showtimeResults[i].status === 'fulfilled'
            ? showtimeResults[i].value
            : [],
        }));

        setTheaters(enriched);

        // Analytics — fire once after the first successful load.
        trackShowtimesOpened({
          titleId: result.id,
          theaterCount: enriched.filter(t => t.showtimes.length > 0).length,
          hasLocationPermission: !!userLocation && userLocation.source === 'gps',
        });
      } catch (e) {
        console.warn('[ShowtimesSheet] load failed:', e?.message);
        if (!cancelled) setError('Could not load showtimes. Try again in a moment.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
    // Depending on primitive lat/lng/source rather than the whole
    // userLocation object — prevents re-fetching every render when App.js
    // recreates the location object reference but values are unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.id, result?.title, result?.year, userLocation?.lat, userLocation?.lng, userLocation?.source]);

  return (
    <div className="showtimes-overlay" onClick={onClose}>
      <div
        ref={sheetRef}
        className="showtimes-sheet"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="showtimes-title"
        tabIndex={-1}
      >
        <div className="showtimes-header">
          <div>
            <div className="showtimes-eyebrow">Theaters near you</div>
            <h2 id="showtimes-title" className="showtimes-title">
              {result?.title}
            </h2>
          </div>
          <button
            className="showtimes-close"
            onClick={onClose}
            aria-label="Close showtimes"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        <div className="showtimes-body">
          {loading && (
            <div className="showtimes-loading" role="status" aria-label="Loading showtimes">
              {[0, 1, 2].map(i => (
                <div key={i} className="showtimes-skeleton">
                  <div className="showtimes-skel-row" />
                  <div className="showtimes-skel-pills">
                    <span /><span /><span />
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && error && (
            <div className="showtimes-empty">
              <div className="showtimes-empty-icon" aria-hidden="true">⚠️</div>
              <p>{error}</p>
            </div>
          )}

          {!loading && !error && !movieFound && (
            <div className="showtimes-empty">
              <div className="showtimes-empty-icon" aria-hidden="true">🎬</div>
              <p>This pick isn't in AMC's catalog. Try a different one.</p>
            </div>
          )}

          {!loading && !error && movieFound && visibleTheaters.length === 0 && (
            <div className="showtimes-empty">
              <div className="showtimes-empty-icon" aria-hidden="true">📍</div>
              <p>
                No theaters within 30 miles are showing this film today.
                {userLocation?.source === 'zip' && ' Try a different ZIP.'}
              </p>
            </div>
          )}

          {!loading && !error && movieFound && visibleTheaters.length > 0 && (
            <ul className="showtimes-list">
              {visibleTheaters.map(theater => (
                <TheaterCard key={theater.id} theater={theater} />
              ))}
            </ul>
          )}

          {!loading && moreAvailable && (
            <button
              type="button"
              className="showtimes-expand"
              onClick={() => setExpanded(true)}
            >
              Show more theaters
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Theater card ─────────────────────────────────────────────────────────────

function TheaterCard({ theater }) {
  // Cap visible showtimes to 4 per theater for the default density.
  const visibleShows = theater.showtimes.slice(0, 4);

  const handleShowtimeClick = (showtime) => {
    // M4 will wire the affiliate routing here. For now it's a no-op so the
    // user gets visual feedback (the button-styled element responds) but
    // doesn't navigate to an unconfigured destination.
    if (!showtime.purchaseUrl) return;
    // Placeholder — affiliate ID injection + new-tab open lands in M4.
    console.log('[Showtime click — M4 will handle]', theater.id, showtime.id);
  };

  return (
    <li className="theater-card">
      <div className="theater-card-head">
        <div className="theater-card-info">
          <div className="theater-card-name">{theater.name}</div>
          <div className="theater-card-meta">
            {typeof theater.distanceMi === 'number' && (
              <span className="theater-distance">{formatMi(theater.distanceMi)}</span>
            )}
            {theater.formats && theater.formats.slice(0, 2).map(f => (
              <span key={f} className="theater-format-badge">{f}</span>
            ))}
          </div>
        </div>
      </div>
      <div className="theater-showtimes" role="group" aria-label="Showtimes">
        {visibleShows.map(showtime => (
          <button
            key={showtime.id || showtime.iso}
            type="button"
            className={`showtime-pill ${showtime.soldOut ? 'sold-out' : ''}`}
            onClick={() => handleShowtimeClick(showtime)}
            disabled={showtime.soldOut}
            aria-label={
              showtime.soldOut
                ? `${formatShowtime(showtime.iso)} sold out`
                : `Buy tickets for ${formatShowtime(showtime.iso)}${showtime.format ? ` ${showtime.format}` : ''}`
            }
          >
            <span>{formatShowtime(showtime.iso)}</span>
            {showtime.format && showtime.format !== 'Standard' && (
              <span className="showtime-format">{showtime.format}</span>
            )}
          </button>
        ))}
      </div>
    </li>
  );
}
