import React, { useState, useEffect, useRef, useCallback } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';
import './Onboarding.css';

// 4×6 = 24 poster-palette color cells — heavily muted via CSS filter
const POSTER_COLORS = [
  '#0D1B2A','#2D0A14','#0A2010','#1A1205',
  '#0D0A2A','#181818','#152234','#1E0A0C',
  '#081A0C','#181208','#080E24','#141414',
  '#0C1A30','#240A0E','#081008','#1A1606',
  '#0A0826','#101010','#0A1620','#1C0808',
  '#040E04','#161006','#06061E','#0C0C0C',
];

// Ambient radial gradient per slide
const AMBIENT = [
  'radial-gradient(ellipse at 80% 15%, rgba(201,169,110,0.22) 0%, transparent 55%), radial-gradient(ellipse at 15% 85%, rgba(120,70,200,0.18) 0%, transparent 55%)',
  'radial-gradient(ellipse at 15% 18%, rgba(50,110,240,0.20) 0%, transparent 55%), radial-gradient(ellipse at 85% 82%, rgba(80,15,170,0.20) 0%, transparent 55%)',
  'radial-gradient(ellipse at 50% 12%, rgba(150,70,210,0.18) 0%, transparent 55%), radial-gradient(ellipse at 15% 85%, rgba(25,110,55,0.18) 0%, transparent 55%)',
  'radial-gradient(ellipse at 18% 18%, rgba(25,110,55,0.18) 0%, transparent 55%), radial-gradient(ellipse at 82% 82%, rgba(201,169,110,0.22) 0%, transparent 55%)',
];

const SERVICE_DOTS = [
  { color: '#E50914', name: 'Netflix' },
  { color: '#8B5CF6', name: 'Max' },
  { color: '#113CCF', name: 'Disney+' },
  { color: '#C8C8D0', name: 'Apple TV' },
  { color: '#1A8CFF', name: 'Prime' },
];

export default function Onboarding({ onDone }) {
  const [slide, setSlide]       = useState(0);
  const [animKey, setAnimKey]   = useState(0);
  const [showCompletion, setShowCompletion]       = useState(false);
  const [completionVisible, setCompletionVisible] = useState(false);
  const touchStartX = useRef(null);
  const touchStartY = useRef(null);
  const transitioning = useRef(false);
  const transitionTimerRef = useRef(null);
  const doneTimerRef = useRef(null);
  const raf1Ref = useRef(null);
  const raf2Ref = useRef(null);
  const rootRef = useRef(null);
  useFocusTrap(rootRef, true);

  // Clear any pending timers/RAFs on unmount so callbacks don't fire on a
  // stale tree (e.g. user backgrounds the tab mid-transition).
  useEffect(() => {
    return () => {
      if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
      if (doneTimerRef.current)       clearTimeout(doneTimerRef.current);
      if (raf1Ref.current)            cancelAnimationFrame(raf1Ref.current);
      if (raf2Ref.current)            cancelAnimationFrame(raf2Ref.current);
    };
  }, []);

  const goTo = useCallback((idx) => {
    if (idx < 0 || idx > 3 || transitioning.current) return;
    transitioning.current = true;
    setSlide(idx);
    setAnimKey(k => k + 1);
    if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
    transitionTimerRef.current = setTimeout(() => { transitioning.current = false; }, 650);
  }, []);

  const next = useCallback(() => goTo(slide + 1), [slide, goTo]);
  const prev = useCallback(() => goTo(slide - 1), [slide, goTo]);

  const handleDone = useCallback(() => {
    setShowCompletion(true);
    raf1Ref.current = requestAnimationFrame(() => {
      raf2Ref.current = requestAnimationFrame(() => setCompletionVisible(true));
    });
    if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
    doneTimerRef.current = setTimeout(onDone, 1800);
  }, [onDone]);

  // Keyboard navigation
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft')  prev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev]);

  // Touch/swipe — reject mostly-vertical drags so a downward flick doesn't
  // change slides when the user is just trying to scroll/reset.
  const onTouchStart = (e) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };
  const onTouchEnd = (e) => {
    if (touchStartX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    // Only treat as a horizontal swipe if dx dominates dy by 1.5×
    if (Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < -50) next();
      else if (dx > 50) prev();
    }
    touchStartX.current = null;
    touchStartY.current = null;
  };

  const ctaLabels = ["Let's go →", 'Continue →', 'One more →', 'Start with Settle'];

  return (
    <div
      ref={rootRef}
      className="ob-root"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Settle"
      tabIndex={-1}
    >
      {/* ── Background system ─────────────────────────────────────────── */}
      <div className="ob-bg-grid" aria-hidden="true">
        {POSTER_COLORS.map((c, i) => (
          <div key={i} className="ob-bg-cell" style={{ background: c }} />
        ))}
      </div>
      <div className="ob-bg-vignette" aria-hidden="true" />
      <div
        className="ob-bg-ambient"
        style={{ background: AMBIENT[slide] }}
        aria-hidden="true"
      />
      {/* Film grain */}
      <svg className="ob-grain" aria-hidden="true" focusable="false">
        <filter id="ob-grain-filter">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="4" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#ob-grain-filter)" />
      </svg>

      {/* ── Skip button ───────────────────────────────────────────────── */}
      <button
        className="ob-skip"
        onClick={() => goTo(3)}
        aria-label="Skip to end"
      >
        Skip
      </button>

      {/* ── Slide track ───────────────────────────────────────────────── */}
      <div
        className="ob-track"
        style={{ transform: `translateX(-${slide * 100}vw)` }}
        aria-live="polite"
      >
        {/* Slide 0 — Brand Reveal */}
        <div className="ob-slide" aria-label="Slide 1 of 4">
          <div className="ob-brand-wrap" key={`s0-${slide === 0 ? animKey : 0}`}>
            <h1 className="ob-brand-name">Settle</h1>
            <div className="ob-brand-rule" aria-hidden="true" />
            <p className="ob-brand-tagline">End the debate.</p>
          </div>
          <div className="ob-swipe-hint" aria-hidden="true">
            <span className="ob-swipe-arrow">Swipe →</span>
          </div>
        </div>

        {/* Slide 1 — Solo Mode */}
        <div className="ob-slide" aria-label="Slide 2 of 4">
          <div className="ob-slide-inner" key={`s1-${slide === 1 ? animKey : 0}`}>
            <div className="ob-icon ob-anim-icon" aria-hidden="true">🎬</div>
            <p className="ob-eyebrow ob-anim-eyebrow">SOLO MODE</p>
            <h2 className="ob-headline ob-anim-headline">
              Pick your mood.<br />
              <em>We handle the rest.</em>
            </h2>
            <p className="ob-body ob-anim-body">
              Tell Settle how you're feeling. It learns your taste over time and gets better with every watch.
            </p>
          </div>
        </div>

        {/* Slide 2 — Couples Mode */}
        <div className="ob-slide" aria-label="Slide 3 of 4">
          <div className="ob-slide-inner" key={`s2-${slide === 2 ? animKey : 0}`}>
            <div className="ob-icon ob-anim-icon" aria-hidden="true">💑</div>
            <p className="ob-eyebrow ob-anim-eyebrow">COUPLES MODE</p>
            <h2 className="ob-headline ob-anim-headline">
              Both vote.<br />
              <em>Nobody loses.</em>
            </h2>
            <p className="ob-body ob-anim-body">
              You each pick your mood independently. Settle finds the overlap — and when it can't, the coin decides.
            </p>
          </div>
        </div>

        {/* Slide 3 — Final CTA */}
        <div className="ob-slide" aria-label="Slide 4 of 4">
          <div className="ob-slide-inner" key={`s3-${slide === 3 ? animKey : 0}`}>
            <div className="ob-icon ob-anim-icon ob-icon-gold" aria-hidden="true">✦</div>
            <p className="ob-eyebrow ob-anim-eyebrow">ALL FIVE SERVICES</p>
            <h2 className="ob-headline ob-anim-headline">
              One answer.<br />
              <em>Every time.</em>
            </h2>
            <p className="ob-body ob-anim-body">
              Netflix, Max, Disney+, Apple TV, and Prime Video — all in one pick.
            </p>
            <div className="ob-service-dots ob-anim-body" aria-label="Supported services" role="list">
              {SERVICE_DOTS.map(s => (
                <span
                  key={s.name}
                  className="ob-service-dot"
                  style={{ background: s.color }}
                  title={s.name}
                  role="listitem"
                  aria-label={s.name}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Fixed bottom — progress dots + CTA ───────────────────────── */}
      <div className="ob-bottom" key={`bottom-${animKey}`}>
        <div className="ob-dots" role="tablist" aria-label="Onboarding progress">
          {[0, 1, 2, 3].map(i => (
            <button
              key={i}
              className={`ob-dot ${i === slide ? 'ob-dot-active' : ''}`}
              onClick={() => goTo(i)}
              role="tab"
              aria-selected={i === slide}
              aria-label={`Go to slide ${i + 1}`}
            />
          ))}
        </div>
        <button
          className={`ob-cta ${slide === 3 ? 'ob-cta-gold' : 'ob-cta-ghost'}`}
          onClick={slide === 3 ? handleDone : next}
        >
          {ctaLabels[slide]}
        </button>
      </div>

      {/* ── Completion overlay ────────────────────────────────────────── */}
      {showCompletion && (
        <div className={`ob-completion ${completionVisible ? 'ob-completion-in' : ''}`} aria-live="assertive">
          <div className="ob-completion-icon">✦</div>
          <p className="ob-completion-title">You're all set.</p>
          <p className="ob-completion-sub">Settle is ready.</p>
        </div>
      )}
    </div>
  );
}
