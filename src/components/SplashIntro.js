// ─────────────────────────────────────────────────────────────────────────────
// Splash intro — branded logo animation shown on every cold app open (web PWA
// and native alike), the "Settle" answer to Netflix's ta-dum / Disney's castle
// sting. Pure overlay: renders on top of <App/> via fixed positioning + a high
// z-index, so it never gates App's own mount/data-fetch — by the time the
// fixed-length animation finishes, the real app underneath is already ready.
//
// Tap anywhere to skip early. Respects prefers-reduced-motion (see .css) with
// a plain crossfade instead of the pop/slide/sheen sequence.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import markSrc from '../assets/settle-mark.png';
import wordmarkSrc from '../assets/settle-wordmark.png';
import './SplashIntro.css';

const HOLD_MS = 1750;   // full sequence plays out, then fade-out begins
const LEAVE_MS = 500;   // must be >= the CSS opacity transition duration

export default function SplashIntro() {
  const [leaving, setLeaving] = useState(false);
  const [mounted, setMounted] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setLeaving(true), HOLD_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setMounted(false), LEAVE_MS);
    return () => clearTimeout(t);
  }, [leaving]);

  if (!mounted) return null;

  return (
    <div
      className={`splash-intro${leaving ? ' splash-intro--leaving' : ''}`}
      onClick={() => setLeaving(true)}
      role="presentation"
      aria-hidden="true"
    >
      <div className="splash-glow" />
      <img src={markSrc} alt="" className="splash-mark" draggable="false" />
      <div className="splash-wordmark-wrap">
        <img src={wordmarkSrc} alt="" className="splash-wordmark" draggable="false" />
        <div
          className="splash-sheen"
          style={{ WebkitMaskImage: `url(${wordmarkSrc})`, maskImage: `url(${wordmarkSrc})` }}
        />
      </div>
    </div>
  );
}
