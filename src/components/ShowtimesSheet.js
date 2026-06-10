import React, { useEffect, useMemo, useRef, useState } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';
import {
  getShowtimes,
  ShowtimesServiceError,
} from '../services/showtimes';
import { trackShowtimesOpened } from '../services/analytics';
import { isNative, openExternal } from '../native/bridge';
import AreaPicker from './AreaPicker';
import LeaveForTickets from './LeaveForTickets';
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
// Showtime pills hand off to the purchase site: a native in-app browser on
// the app, or (on web) a "leaving Settle" confirmation before a new tab.
//
// The shared AreaPicker strip lets the user override the search location at
// any time — primary recovery path when GPS fails (Safari) or when the user
// wants to search a different area entirely.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_VISIBLE  = 3;
const EXPANDED_VISIBLE = 10;

// Users who tick "Don't ask me again" in the leaving-Settle dialog skip it on
// future buys and go straight to checkout in a new tab.
const SKIP_LEAVE_KEY = 'settle_skip_leave_confirm';

export const shouldSkipLeaveConfirm = () => {
  try { return localStorage.getItem(SKIP_LEAVE_KEY) === '1'; } catch { return false; }
};
export const setSkipLeaveConfirm = () => {
  try { localStorage.setItem(SKIP_LEAVE_KEY, '1'); } catch {}
};

export default function ShowtimesSheet({
  result,
  userLocation,
  onClose,
  onLocationChange,        // ({ mode: 'gps' | 'zip', zip? }) => Promise<void>
  onBuyIntent,             // fired once per sheet when the user taps a showtime
}) {
  const sheetRef = useRef(null);
  useFocusTrap(sheetRef, true);

  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState('');
  const [serviceDown,   setServiceDown]   = useState(false);
  const [theaters,      setTheaters]      = useState([]);
  const [expanded,      setExpanded]      = useState(false);
  // Web-only "leaving Settle" dialog payload — { url, movie, theater, timeStr }.
  // null when closed. On native we open the in-app browser directly instead.
  const [leaveInfo,     setLeaveInfo]     = useState(null);
  // Buy-intent fires at most once per sheet open — tapping three showtimes for
  // the same film is still one trip to the movies.
  const intentSentRef = useRef(false);

  // Ticket hand-off. Native gets a true in-app browser (SFSafariViewController /
  // Custom Tab) — no awareness dialog, the user never actually leaves the app.
  // Web can only open a new tab (ticketing sites block iframing), so confirm
  // first via LeaveForTickets — unless the user opted out of the confirmation,
  // in which case open directly (synchronous within the tap, so popup-safe).
  const handleBuy = (info) => {
    if (!info?.url) return;
    if (!intentSentRef.current) {
      intentSentRef.current = true;
      try { onBuyIntent?.(); } catch {}
    }
    if (isNative()) {
      openExternal(info.url);
    } else if (shouldSkipLeaveConfirm()) {
      window.open(info.url, '_blank', 'noopener,noreferrer');
    } else {
      setLeaveInfo(info);
    }
  };

  // Sort by distanceMi when available; otherwise preserve Google's proximity order.
  const visibleTheaters = useMemo(() => {
    const withShowtimes = theaters.filter(t => t.showtimes && t.showtimes.length > 0);
    const hasDistances  = withShowtimes.some(t => t.distanceMi !== null);
    const sorted = hasDistances
      ? [...withShowtimes].sort((a, b) => (a.distanceMi ?? Infinity) - (b.distanceMi ?? Infinity))
      : withShowtimes;
    return sorted.slice(0, expanded ? EXPANDED_VISIBLE : DEFAULT_VISIBLE);
  }, [theaters, expanded]);

  const moreAvailable = useMemo(() => {
    if (expanded) return false;
    const withShowtimes = theaters.filter(t => t.showtimes && t.showtimes.length > 0);
    return withShowtimes.length > DEFAULT_VISIBLE;
  }, [theaters, expanded]);

  // Load on mount + whenever the search location changes. Cancellable to
  // avoid setState on unmount or out-of-order responses.
  useEffect(() => {
    if (!result?.title) return;

    let cancelled = false;

    (async () => {
      setLoading(true);
      setError('');
      setServiceDown(false);
      setExpanded(false);

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
          <div className="showtimes-header-text">
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

        {/* Location strip — surfaces the active search location and lets
            the user override it. Primary recovery path for any case where
            GPS isn't producing usable results (Safari first-run, denied
            permission, wrong neighbourhood, etc.). */}
        {onLocationChange && (
          <div className="showtimes-area">
            <AreaPicker
              variant="strip"
              userLocation={userLocation}
              onChange={onLocationChange}
            />
          </div>
        )}

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
                {' '}Try a different ZIP above to widen your search.
              </p>
            </div>
          )}

          {!loading && !serviceDown && !error && visibleTheaters.length > 0 && (
            <ul className="showtimes-list">
              {visibleTheaters.map(theater => (
                <TheaterCard
                  key={theater.id}
                  theater={theater}
                  movieTitle={result?.title}
                  onBuy={(showtime) =>
                    handleBuy({
                      url:      showtime.purchaseUrl,
                      movie:    result?.title,
                      theater:  theater.name,
                      timeStr:  showtime.timeStr,
                    })
                  }
                />
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

      {/* Web-only "you're leaving Settle" confirmation before the new tab. */}
      {leaveInfo && (
        <LeaveForTickets
          url={leaveInfo.url}
          movie={leaveInfo.movie}
          theater={leaveInfo.theater}
          timeStr={leaveInfo.timeStr}
          onCancel={() => setLeaveInfo(null)}
        />
      )}
    </div>
  );
}

// ── Theater card ─────────────────────────────────────────────────────────────

function TheaterCard({ theater, movieTitle, onBuy }) {
  // Cap visible showtimes to 6 per theater for comfortable density.
  const visibleShows = theater.showtimes.slice(0, 6);

  const handleShowtimeClick = (showtime) => {
    // Use direct purchase URL if SerpAPI provided one; otherwise fall back to
    // a Fandango search for the movie so the user always lands somewhere useful.
    const url = showtime.purchaseUrl
      || `https://www.fandango.com/search?q=${encodeURIComponent(movieTitle || '')}`;
    onBuy({ ...showtime, purchaseUrl: url });
  };

  return (
    <li className="theater-card">
      <div className="theater-card-head">
        <div className="theater-card-info">
          <div className="theater-card-name">{theater.name}</div>
          <div className="theater-card-meta">
            {theater.distanceMi !== null && (
              <span className="theater-distance">{theater.distanceMi} mi</span>
            )}
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
