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

// `url` originates from upstream SerpAPI showtimes data — an untrusted source.
// Only http(s) URLs may ever reach an href or an iframe src; a hostile
// `javascript:` or `data:` value would otherwise execute in our origin (XSS).
// Anything that doesn't parse as http(s) falls back to a safe Fandango search.
function toSafeUrl(raw, movie) {
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') return raw;
  } catch { /* not a parseable URL — fall through */ }
  return `https://www.fandango.com/search?q=${encodeURIComponent(movie || '')}`;
}

export default function TicketBrowser({ url, movie, theater, timeStr, onClose }) {
  const overlayRef = useRef(null);
  useFocusTrap(overlayRef, true);

  const safeUrl = toSafeUrl(url, movie);
  const providerLabel = getProviderLabel(safeUrl);
  const blocked = isKnownBlocked(safeUrl);

  // Safari (both browser and iOS PWA standalone) blocks window.open() via its
  // popup blocker. <a target="_blank"> is the only fully reliable cross-browser
  // way to open an external URL. All external-open affordances use anchor tags.
  const externalLinkProps = {
    href: safeUrl,
    target: '_blank',
    rel: 'noopener noreferrer',
  };

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

        <a
          className="tb-external"
          {...externalLinkProps}
          aria-label={`Open on ${providerLabel}`}
          title={`Open on ${providerLabel}`}
        >
          <span aria-hidden="true">↗</span>
        </a>
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
            <a className="tb-cta-btn" {...externalLinkProps}>
              Buy Tickets on {providerLabel}
            </a>
            <p className="tb-cta-note">
              You'll complete your purchase securely on {providerLabel}'s site.
            </p>
          </div>
        ) : (
          /* Unknown domain — try iframe */
          <>
            <iframe
              className="tb-frame tb-frame--visible"
              src={safeUrl}
              title={`Buy tickets on ${providerLabel}`}
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            />
            <div className="tb-fallback-bar">
              Not loading?{' '}
              <a className="tb-fallback-link" {...externalLinkProps}>
                Open in browser
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
