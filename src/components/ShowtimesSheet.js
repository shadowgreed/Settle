import React, { useEffect, useMemo, useRef, useState } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';
import { getShowtimes, ShowtimesServiceError } from '../services/showtimes';
import { trackShowtimesOpened } from '../services/analytics';
import './ShowtimesSheet.css';

// ─────────────────────────────────────────────────────────────────────────────
// ShowtimesSheet — bottom-sheet modal for Theater Mode 2.0.
//
// Opens when user taps "🎟️ Get tickets" on a theater pick. Fetches showtimes
// via SerpAPI Google Showtimes (proxied through /api/showtimes) using the
// user's location (GPS coords or ZIP code).
//
// Google returns theaters pre-sorted by proximity — we preserve that order
// rather than re-ranking. The top 3 are shown by default; "Show more"
// expands to up to 10.
//
// Showtime pills open the purchase URL (Fandango / AMC.com / etc.) that
// Google surfaces for that format — users complete the purchase on the
// ticketing platform directly.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_VISIBLE  = 3;
const EXPANDED_VISIBLE = 10;

export default function ShowtimesSheet({ result, userLocation, onClose }) {
  const sheetRef = useRef(null);
  useFocusTrap(sheetRef, true);

  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [serviceDown, setServiceDown] = useState(false);
  const [theaters,    setTheaters]    = useState([]);
  const [expanded,    setExpanded]    = useState(false);

  // Google pre-sorts by proximity — preserve their order, just cap the count.
  const visibleTheaters = useMemo(() => {
    const withShowtimes = theaters.filter(t => t.showtimes && t.showtimes.length > 0);
    return withShowtimes.slice(0, expanded ? EXPANDED_VISIBLE : DEFAULT_VISIBLE);
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
      setServiceDown(false);

      try {
        const lat = userLocation?.lat;
        const lng = userLocation?.lng;
        const zip = userLocation?.zip || '';

        const results = await getShowtimes(result.title, { lat, lng, zip });
        if (cancelled) return;

        setTheaters(results);

        trackShowtimesOpened({
          titleId:               result.id,
          theaterCount:          results.filter(t => t.showtimes.length > 0).length,
          hasLocationPermission: !!userLocation && userLocation.source === 'gps',
        });
      } catch (e) {
        console.warn('[ShowtimesSheet] load failed:', e?.message);
        if (cancelled) return;
        if (e instanceof ShowtimesServiceError) {
          setServiceDown(true);
        } else {
          setError('Could not load showtimes. Try again in a moment.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.id, result?.title, userLocation?.lat, userLocation?.lng, userLocation?.zip, userLocation?.source]);

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

          {!loading && serviceDown && (
            <div className="showtimes-empty">
              <div className="showtimes-empty-icon" aria-hidden="true">🛠️</div>
              <p>
                Showtimes are temporarily unavailable. We're working on it —
                check back in a bit.
              </p>
            </div>
          )}

          {!loading && !serviceDown && error && (
            <div className="showtimes-empty">
              <div className="showtimes-empty-icon" aria-hidden="true">⚠️</div>
              <p>{error}</p>
            </div>
          )}

          {!loading && !serviceDown && !error && visibleTheaters.length === 0 && (
            <div className="showtimes-empty">
              <div className="showtimes-empty-icon" aria-hidden="true">📍</div>
              <p>
                No theaters near you are showing this film today.
                {userLocation?.source === 'zip' && ' Try a different ZIP.'}
              </p>
            </div>
          )}

          {!loading && !serviceDown && !error && visibleTheaters.length > 0 && (
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
  // Cap visible showtimes to 6 per theater for comfortable density.
  const visibleShows = theater.showtimes.slice(0, 6);

  const handleShowtimeClick = (showtime) => {
    if (!showtime.purchaseUrl) return;
    window.open(showtime.purchaseUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <li className="theater-card">
      <div className="theater-card-head">
        <div className="theater-card-info">
          <div className="theater-card-name">{theater.name}</div>
          <div className="theater-card-meta">
            {theater.address && (
              <span className="theater-address">{theater.address}</span>
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
            key={showtime.id}
            type="button"
            className={`showtime-pill ${showtime.soldOut ? 'sold-out' : ''}`}
            onClick={() => handleShowtimeClick(showtime)}
            disabled={showtime.soldOut}
            aria-label={
              showtime.soldOut
                ? `${showtime.timeStr} sold out`
                : `Buy tickets for ${showtime.timeStr}${showtime.format ? ` ${showtime.format}` : ''}`
            }
          >
            <span>{showtime.timeStr}</span>
            {showtime.format && (
              <span className="showtime-format">{showtime.format}</span>
            )}
          </button>
        ))}
      </div>
    </li>
  );
}
