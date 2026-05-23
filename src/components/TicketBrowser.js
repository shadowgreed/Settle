import React, { useRef } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';
import './TicketBrowser.css';

// ─────────────────────────────────────────────────────────────────────────────
// TicketBrowser — full-screen in-app overlay for ticket purchases.
//
// Most major ticketing sites (Fandango, AMC, Regal, Cinemark) set
// X-Frame-Options: DENY and can't be embedded in an iframe. Rather than
// show a broken blank page, we detect known blocking domains upfront and
// render a clean "Continue to [Provider]" CTA instead.
//
// For sites that allow embedding (smaller chains, some independents),
// the iframe path is used.
//
// Props:
//   url      — purchase URL (from SerpAPI or Fandango fallback)
//   movie    — movie title
//   theater  — theater name
//   timeStr  — showtime string ("7:30 PM")
//   onClose  — back to showtimes
// ─────────────────────────────────────────────────────────────────────────────

// Domains that block iframe embedding — skip iframe, go straight to CTA.
const BLOCKED_DOMAINS = [
  'fandango.com',
  'amctheatres.com',
  'regmovies.com',
  'cinemark.com',
  'atomtickets.com',
  'drafthouse.com',
  'google.com',
];

function getProviderLabel(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const name = host.split('.')[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return 'Ticketing';
  }
}

function isKnownBlocked(url) {
  try {
    const host = new URL(url).hostname;
    return BLOCKED_DOMAINS.some(d => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

export default function TicketBrowser({ url, movie, theater, timeStr, onClose }) {
  const overlayRef = useRef(null);
  useFocusTrap(overlayRef, true);

  const openExternal = () => window.open(url, '_blank', 'noopener,noreferrer');
  const providerLabel = getProviderLabel(url);
  const blocked = isKnownBlocked(url);

  return (
    <div
      className="tb-overlay"
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Buy tickets — ${movie}`}
      tabIndex={-1}
    >
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
          aria-label={`Open on ${providerLabel}`}
          title={`Open on ${providerLabel}`}
        >
          <span aria-hidden="true">↗</span>
        </button>
      </div>

      {/* ── Body ── */}
      <div className="tb-body">
        {blocked ? (
          /* Known blocking domain — skip iframe, show direct CTA */
          <div className="tb-cta-screen">
            <div className="tb-cta-icon" aria-hidden="true">🎟️</div>
            <div className="tb-cta-provider">via {providerLabel}</div>
            <h2 className="tb-cta-movie">{movie}</h2>
            <div className="tb-cta-meta">
              {timeStr}
              {theater && <> · <span className="tb-cta-theater">{theater}</span></>}
            </div>
            <button className="tb-cta-btn" onClick={openExternal}>
              Buy Tickets on {providerLabel}
            </button>
            <p className="tb-cta-note">
              You'll complete your purchase securely on {providerLabel}'s site.
            </p>
          </div>
        ) : (
          /* Unknown domain — try iframe */
          <>
            <iframe
              className="tb-frame tb-frame--visible"
              src={url}
              title={`Buy tickets on ${providerLabel}`}
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            />
            <div className="tb-fallback-bar">
              Not loading?{' '}
              <button className="tb-fallback-link" onClick={openExternal}>
                Open in browser
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
