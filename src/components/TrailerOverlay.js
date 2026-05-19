import React, { useEffect, useRef } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';
import './TrailerOverlay.css';

// ─────────────────────────────────────────────────────────────────────────────
// TrailerOverlay — full-screen YouTube trailer player.
//
// Embeds the trailer via youtube-nocookie.com (privacy-preserving variant —
// no tracking cookies until the user actually presses play).
//
// Closes on: backdrop tap, × button, Escape key, browser back gesture.
// Focus is trapped while open and restored on close (useFocusTrap).
// Body scroll is locked at the App.js level (same effect that handles other
// modals) — TrailerOverlay just declares `showTrailer` to that effect.
// ─────────────────────────────────────────────────────────────────────────────

export default function TrailerOverlay({ trailer, title, onClose }) {
  const cardRef = useRef(null);
  useFocusTrap(cardRef, true);

  // Escape-to-close (App.js's global Escape handler routes here too, but the
  // local listener guarantees behavior even if the global wiring changes).
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!trailer?.key) return null;

  // `autoplay=1` — the user explicitly tapped "Watch trailer" so this counts
  //   as a user gesture; browsers allow autoplay on user-initiated navigation.
  // `rel=0` — never show "related videos" suggestions at the end (avoids
  //   directing users away from Settle into the YouTube rabbit hole).
  // `modestbranding=1` — minimise YouTube branding chrome.
  // `playsinline=1` — keep playback inline on iOS Safari instead of
  //   trapping the user in the native iOS fullscreen video player.
  const src =
    `https://www.youtube-nocookie.com/embed/${encodeURIComponent(trailer.key)}` +
    `?autoplay=1&rel=0&modestbranding=1&playsinline=1`;

  return (
    <div className="trailer-overlay" onClick={onClose}>
      <div
        ref={cardRef}
        className="trailer-card"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title ? `Trailer for ${title}` : 'Trailer'}
        tabIndex={-1}
      >
        <button
          type="button"
          className="trailer-close"
          onClick={onClose}
          aria-label="Close trailer"
        >
          <span aria-hidden="true">✕</span>
        </button>
        <div className="trailer-frame-wrap">
          <iframe
            className="trailer-frame"
            src={src}
            title={title ? `Trailer for ${title}` : 'Trailer'}
            // `allow` permissions are required for autoplay + fullscreen toggle.
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
        {title && <div className="trailer-caption">{title}</div>}
      </div>
    </div>
  );
}
