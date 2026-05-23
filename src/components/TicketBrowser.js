import React, { useRef, useState } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';
import './TicketBrowser.css';

// ─────────────────────────────────────────────────────────────────────────────
// TicketBrowser — full-screen in-app overlay that loads a ticket purchase URL
// (Fandango, AMC.com, etc.) inside an iframe.
//
// Header shows context (movie · theater · time) and a close button.
// "Open in browser" link is always available as a fallback — some ticketing
// sites block iframe embedding via X-Frame-Options / CSP, so we make the
// fallback prominent.
//
// Props:
//   url        — purchase URL from SerpAPI (Fandango / AMC / etc.)
//   movie      — movie title string
//   theater    — theater name string
//   timeStr    — showtime string ("7:30 PM")
//   onClose    — callback when user closes
// ─────────────────────────────────────────────────────────────────────────────

export default function TicketBrowser({ url, movie, theater, timeStr, onClose }) {
  const overlayRef = useRef(null);
  useFocusTrap(overlayRef, true);

  const [iframeState, setIframeState] = useState('loading'); // 'loading' | 'loaded' | 'blocked'

  // Most major ticketing sites (Fandango, AMC.com) block iframe embedding.
  // onLoad fires in two cases: successful load AND when the browser renders
  // the X-Frame-Options block page. We optimistically show the iframe and let
  // users hit "Open in browser" if they see a blank / error page.
  const handleLoad = () => setIframeState('loaded');
  const handleError = () => setIframeState('blocked');

  const openExternal = () => window.open(url, '_blank', 'noopener,noreferrer');

  // Provider name extracted from hostname for the "via …" chip
  const providerLabel = (() => {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      const name = host.split('.')[0];
      return name.charAt(0).toUpperCase() + name.slice(1);
    } catch {
      return 'Ticketing';
    }
  })();

  return (
    <div className="tb-overlay" ref={overlayRef} role="dialog" aria-modal="true" aria-label={`Buy tickets — ${movie}`} tabIndex={-1}>
      {/* ── Header ── */}
      <div className="tb-header">
        <button className="tb-back" onClick={onClose} aria-label="Back to showtimes">
          <span aria-hidden="true">←</span>
        </button>

        <div className="tb-context">
          <span className="tb-context-movie">{movie}</span>
          <span className="tb-context-sep" aria-hidden="true">·</span>
          <span className="tb-context-detail">{timeStr}</span>
          {theater && (
            <>
              <span className="tb-context-sep" aria-hidden="true">·</span>
              <span className="tb-context-detail tb-context-theater">{theater}</span>
            </>
          )}
        </div>

        <button
          className="tb-external"
          onClick={openExternal}
          aria-label={`Open on ${providerLabel} in browser`}
          title={`Open on ${providerLabel}`}
        >
          <span aria-hidden="true">↗</span>
        </button>
      </div>

      {/* ── Body ── */}
      <div className="tb-body">
        {iframeState === 'loading' && (
          <div className="tb-loading" aria-hidden="true">
            <div className="tb-spinner" />
            <p>Loading {providerLabel}…</p>
          </div>
        )}

        {iframeState === 'blocked' && (
          <div className="tb-blocked">
            <div className="tb-blocked-icon" aria-hidden="true">🔒</div>
            <p>{providerLabel} can't be embedded.<br />Open it in your browser to complete the purchase.</p>
            <button className="tb-blocked-cta" onClick={openExternal}>
              Open {providerLabel} →
            </button>
          </div>
        )}

        <iframe
          className={`tb-frame ${iframeState !== 'loading' && iframeState !== 'blocked' ? 'tb-frame--visible' : ''}`}
          src={url}
          title={`Buy tickets on ${providerLabel}`}
          onLoad={handleLoad}
          onError={handleError}
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        />

        {/* Subtle fallback nudge shown once the iframe renders, in case it
            loaded but shows a login wall or broken layout */}
        {iframeState === 'loaded' && (
          <div className="tb-fallback-bar">
            Not loading correctly?{' '}
            <button className="tb-fallback-link" onClick={openExternal}>
              Open in browser
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
