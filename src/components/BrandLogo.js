import React from 'react';
import wordmark from '../assets/settle-wordmark.png';
import './BrandLogo.css';

// The official Settle wordmark (amber, transparent). One source of truth so the
// brand is consistent across the auth gate, loading screen, and onboarding.
export default function BrandLogo({ className = '', height = 30, alt = 'Settle' }) {
  // Pass height={null} to let CSS control sizing (e.g. a responsive clamp).
  return (
    <img
      src={wordmark}
      alt={alt}
      className={`brand-logo ${className}`.trim()}
      style={height != null ? { height } : undefined}
      draggable="false"
    />
  );
}
