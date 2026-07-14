// ─────────────────────────────────────────────────────────────────────────────
// Owns the handoff from DialIntro to the real app. DialIntro itself never
// fades its own opacity (per spec: "the settled dial is a legitimate resting
// frame") — instead, once it settles, a small opaque scrim (same background
// color) covers it and THAT fades away, revealing <App/> underneath, which
// was mounted and loading the whole time and needed no wrapping of its own.
//
// Cold-start-only: `hasPlayedThisSession` is a plain module variable (memory,
// not storage, per spec) — since this app has no client-side router and
// App.js is only ever mounted once at real page load, that's sufficient to
// guarantee "never on resume-from-background, never on route changes".
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import DialIntro from './DialIntro';
import './AppIntroGate.css';

let hasPlayedThisSession = false;

const REVEAL_MS = 340; // > the .intro-reveal-scrim fade duration in the CSS, so unmount never clips it mid-fade

export default function AppIntroGate({ children }) {
  const [phase, setPhase] = useState(() => (hasPlayedThisSession ? 'done' : 'playing'));

  useEffect(() => {
    hasPlayedThisSession = true;
  }, []);

  useEffect(() => {
    if (phase !== 'revealing') return;
    const t = setTimeout(() => setPhase('done'), REVEAL_MS);
    return () => clearTimeout(t);
  }, [phase]);

  return (
    <>
      {children}
      {phase === 'playing' && <DialIntro onSettled={() => setPhase('revealing')} />}
      {phase === 'revealing' && <div className="intro-reveal-scrim" />}
    </>
  );
}
