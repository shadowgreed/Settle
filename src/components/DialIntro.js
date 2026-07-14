// ─────────────────────────────────────────────────────────────────────────────
// "The Dial" — cold-start intro animation. Ported from the reference file
// assets/settle-intro-dial-v6-sound.html (source of truth for every timing/
// audio value below — see handoff spec "The Dial v6" if either drifts).
//
// A needle spins just over one full rotation, decelerating like a roulette of
// choices, passes ~13 tick marks (each producing a synced audible tick),
// overshoots the top mark, and ratchets back with a click as the ring flashes
// and the top tick lights up. Self-contained: never fades itself out, never
// knows about app-readiness — see AppIntroGate for the handoff to the app.
//
// Two cuts share this same component via props (spec §7):
//   marketing: spinDelayMs=250 spinDurMs=3200 soundEnabled=true
//   app boot (default): spinDelayMs=150 spinDurMs=2000 soundEnabled=false
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { isNative } from '../native/bridge';
import './DialIntro.css';

// Keyframe geometry — fixed regardless of which cut is playing; only the
// duration/delay (CSS vars, passed as props) change between cuts.
const ROT_START = -375;
const ROT_MID = 9;
const SEG1_END = 0.88; // fraction of the spin where the needle reaches the overshoot, before ratcheting back

// Solve the CSS's own cubic-bezier(0.14, 0.72, 0.16, 1) by bisection so the
// audible ticks are computed from the exact same curve the needle animates
// on — not a separate approximation that could drift out of sync.
function bezierY(x, p1x, p1y, p2x, p2y) {
  let lo = 0, hi = 1, t = x;
  const bx = (t) => 3 * p1x * t * (1 - t) * (1 - t) + 3 * p2x * t * t * (1 - t) + t * t * t;
  const by = (t) => 3 * p1y * t * (1 - t) * (1 - t) + 3 * p2y * t * t * (1 - t) + t * t * t;
  for (let i = 0; i < 40; i++) {
    t = (lo + hi) / 2;
    if (bx(t) < x) lo = t; else hi = t;
  }
  return by(t);
}

// Every moment the needle's rotation crosses a multiple of 30° (a tick mark),
// in seconds from spin start — used to schedule the audible ticks.
function computeTickTimes(spinDurMs) {
  const times = [];
  let lastMark = Math.ceil(ROT_START / 30);
  const steps = 500;
  for (let i = 1; i <= steps; i++) {
    const frac = i / steps;
    const eased = bezierY(frac, 0.14, 0.72, 0.16, 1);
    const rot = ROT_START + (ROT_MID - ROT_START) * eased;
    const mark = Math.floor(rot / 30);
    if (mark >= lastMark) {
      times.push((frac * SEG1_END * spinDurMs) / 1000);
      lastMark = mark + 1;
    }
  }
  return times;
}

function scheduleTick(ctx, when, gainVal, freq, durMs) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const filt = ctx.createBiquadFilter();
  filt.type = 'bandpass';
  filt.frequency.value = freq;
  filt.Q.value = 6;
  osc.type = 'square';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(gainVal, when + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + durMs / 1000);
  osc.connect(filt);
  filt.connect(gain);
  gain.connect(ctx.destination);
  osc.start(when);
  osc.stop(when + durMs / 1000 + 0.02);
}

// Ticks and the needle share one clock: `ctx.currentTime + spinDelayS` is the
// same anchor as the CSS's `animation-delay`. If either delay/duration prop
// changes, both the visual and this schedule move together — nothing here is
// a hardcoded ms value independent of the props.
function playDialSound(ctx, spinDelayMs, spinDurMs) {
  const t0 = ctx.currentTime + spinDelayMs / 1000;
  const times = computeTickTimes(spinDurMs);
  times.forEach((t, i) => {
    const p = i / (times.length - 1); // 0 -> 1 across the spin: later ticks are louder + lower, adding tension
    scheduleTick(ctx, t0 + t, 0.09 + 0.07 * p, 1700 - 600 * p, 40);
  });
  const clickT = t0 + (SEG1_END * spinDurMs) / 1000;
  scheduleTick(ctx, clickT, 0.16, 1100, 45);        // overshoot hit
  scheduleTick(ctx, clickT + 0.085, 0.12, 520, 70);  // low settle clunk
}

export default function DialIntro({
  spinDelayMs = 150,
  spinDurMs = 2000,
  soundEnabled = true,
  onSettled,
}) {
  const [skipped, setSkipped] = useState(false);
  const audioCtxRef = useRef(null);
  const settledRef = useRef(false);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  useEffect(() => {
    const settle = () => {
      if (settledRef.current) return;
      settledRef.current = true;
      onSettledRef.current && onSettledRef.current();
    };

    // Native: hand off from the static black launch screen to this component's
    // own fade-in — one continuous shot, no logo flash from the native side.
    if (isNative()) {
      import('@capacitor/splash-screen')
        .then(({ SplashScreen }) => SplashScreen.hide().catch(() => {}))
        .catch(() => {});
    }

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const totalMs = reduced ? 300 : spinDelayMs + spinDurMs;

    if (!reduced && soundEnabled) {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx();
        audioCtxRef.current = ctx;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        playDialSound(ctx, spinDelayMs, spinDurMs);
      } catch {
        // Web Audio unavailable, or blocked pre-gesture — sound is additive
        // only, the visual sequence still plays and settles on schedule.
      }
    }

    const t = setTimeout(settle, totalMs);
    return () => {
      clearTimeout(t);
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
    };
    // Intentionally mount-once: a cut's timing is chosen at mount and never
    // re-tuned mid-play.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSkip = () => {
    if (skipped) return;
    setSkipped(true);
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (!settledRef.current) {
      settledRef.current = true;
      onSettledRef.current && onSettledRef.current();
    }
  };

  return (
    <div
      className={`dial-overlay${skipped ? ' dial-overlay--skip' : ''}`}
      style={{ '--spin-delay': `${spinDelayMs}ms`, '--spin-dur': `${spinDurMs}ms` }}
      onClick={handleSkip}
      role="img"
      aria-label="Settle"
    >
      <div className="dial-visual">
        <svg viewBox="0 0 120 120">
          <circle className="dial-ring" cx="60" cy="60" r="52" fill="none" stroke="#3a3a42" strokeWidth="6" strokeLinecap="round" />
          <g stroke="#4a4a52" strokeWidth="4" strokeLinecap="round">
            <line className="dial-tick-top" x1="60" y1="6" x2="60" y2="18" stroke="#FF982A" />
            <line x1="87" y1="13.2" x2="81" y2="23.6" />
            <line x1="106.8" y1="33" x2="96.4" y2="39" />
            <line x1="114" y1="60" x2="102" y2="60" />
            <line x1="106.8" y1="87" x2="96.4" y2="81" />
            <line x1="87" y1="106.8" x2="81" y2="96.4" />
            <line x1="60" y1="114" x2="60" y2="102" />
            <line x1="33" y1="106.8" x2="39" y2="96.4" />
            <line x1="13.2" y1="87" x2="23.6" y2="81" />
            <line x1="6" y1="60" x2="18" y2="60" />
            <line x1="13.2" y1="33" x2="23.6" y2="39" />
            <line x1="33" y1="13.2" x2="39" y2="23.6" />
          </g>
          <g className="dial-needle-group">
            <line x1="60" y1="60" x2="60" y2="16" stroke="#FF982A" strokeWidth="7" strokeLinecap="round" />
            <circle cx="60" cy="60" r="7" fill="#FF982A" />
          </g>
        </svg>
      </div>
    </div>
  );
}
