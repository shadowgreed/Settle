// ─────────────────────────────────────────────────────────────────────────────
// Shared Satori layout for the shareable pick card (handoff spec §3/§4).
//
// One source of truth for all four export formats (story/portrait/square/og),
// consumed by api/share-card.js (renders the PNG).
//
// Written with React.createElement instead of JSX on purpose: this file is
// require()'d directly by a Vercel Node serverless function with no build/
// transpile step in front of it (every other api/*.js file in this repo is
// plain runnable Node too) — a .jsx file with real JSX syntax throws
// `SyntaxError: Unexpected token '<'` the moment Vercel's Lambda tries to
// require() it, since nothing in that runtime transpiles JSX. Confirmed via
// `vercel logs` against a live 500 pointing at this exact file. Satori (the
// engine behind @vercel/og) resolves element trees shaped like React elements
// (including function-component types), so React.createElement produces
// exactly the tree Satori expects without needing JSX at all.
//
// Satori only supports a CSS subset: flexbox layout, absolute/relative
// positioning, linear-gradient backgrounds, border/borderRadius, and
// -webkit-line-clamp-style text clamping. Every multi-child div needs an
// explicit `display` (flex here, always) — Satori throws instead of
// defaulting the way a browser would.
//
// Colors are the literal hex values from src/App.css's :root token block —
// Satori can't resolve CSS custom properties, so these must be copy-pasted,
// not var()-referenced. Keep in sync by hand if the token file changes.
// ─────────────────────────────────────────────────────────────────────────────

const h = require('react').createElement;

const COLOR_BG     = '#0A0A0C';
const COLOR_ACCENT = '#F0A030';
const COLOR_TEXT   = '#F2F2F4';
const COLOR_DIM    = '#93939C';
const COLOR_FAINT  = '#5C5C66';
const COLOR_BORDER = '#2A2A32';

const SERVICE_COLORS = {
  'Netflix':      '#E50914',
  'Max':          '#6A1BD0',
  'Disney+':      '#1B3CC0',
  'Apple TV':     '#A2AAAD',
  'Prime Video':  '#00A8E1',
  'In Theaters':  '#EF9F27',
};

// Canvas sizes per format (spec §2).
const FORMAT_SIZES = {
  story:    { width: 1080, height: 1920 },
  portrait: { width: 1080, height: 1350 },
  square:   { width: 1080, height: 1080 },
  og:       { width: 1200, height: 630  },
};

function serviceColor(service) {
  return SERVICE_COLORS[service] || '#888888';
}

// Numeric rating, one decimal — spec §3 item 5 explicitly rejects star glyphs.
function formatRating(rating) {
  const n = parseFloat(rating);
  return Number.isFinite(n) ? n.toFixed(1) : null;
}

// ── Small shared pieces (Satori-safe: explicit display, no shorthand CSS) ────

function Wordmark({ fontSize = 36 }) {
  return h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
    h('span', { style: { fontSize, fontWeight: 700, color: COLOR_ACCENT } }, '🎬'),
    h('span', { style: { fontSize, fontWeight: 700, color: COLOR_ACCENT, letterSpacing: 2 } }, 'SETTLE'),
  );
}

// Daypart badge — restyled to the standard accent chip (spec §3 item 3). The
// old canvas renderer's "mode pill" reused serviceColor for this, which read
// as branded red on Netflix picks; this is a fixed accent chip, unrelated to
// the service line below it.
function DaypartBadge({ text, fontSize = 26, padY = 12, padX = 22 }) {
  return h('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      alignSelf: 'flex-start',
      padding: `${padY}px ${padX}px`,
      borderRadius: 9999,
      border: `1px solid ${COLOR_ACCENT}`,
      backgroundColor: 'rgba(240,160,48,0.18)', // color-accent @ 18%
    },
  }, h('span', { style: { fontSize, fontWeight: 600, color: COLOR_ACCENT } }, text));
}

// The story line (spec §3 item 4 — new) — the actual "why" reason. Rendered
// verbatim; the caller (api/share-card.js) is responsible for sourcing and
// sanitizing/truncating this string before it ever reaches this layout.
function StoryLine({ text, fontSize = 30 }) {
  if (!text) return null;
  return h('div', { style: { display: 'flex' } },
    h('span', { style: { fontSize, fontWeight: 500, color: COLOR_TEXT } }, text));
}

function Title({ title, fontSize = 66, maxWidth }) {
  return h('div', {
    style: {
      display: '-webkit-box',
      WebkitBoxOrient: 'vertical',
      WebkitLineClamp: 2,
      overflow: 'hidden',
      maxWidth,
      fontSize,
      fontWeight: 700,
      color: '#ffffff',
      lineHeight: 1.15,
    },
  }, title);
}

// Numeric metadata line — "2004 · Movie · 6.8" (spec §3 item 5).
function MetaLine({ year, type, rating, fontSize = 26 }) {
  const ratingStr = formatRating(rating);
  const parts = [year, type, ratingStr ? `★ ${ratingStr}` : null].filter(Boolean);
  return h('div', { style: { display: 'flex' } },
    h('span', { style: { fontSize, fontWeight: 400, color: 'rgba(255,255,255,0.75)' } }, parts.join('  ·  ')));
}

function ServiceLine({ service, fontSize = 28 }) {
  const color = serviceColor(service);
  return h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
    h('div', { style: { display: 'flex', width: 14, height: 14, borderRadius: 7, backgroundColor: color } }),
    h('span', { style: { fontSize, fontWeight: 700, color } }, service));
}

// Genre chips — capped at 2 (spec §3 item 5, tighter than the old canvas
// renderer's cap of 3).
function GenreChips({ genres, fontSize = 22 }) {
  const list = (genres || []).slice(0, 2);
  if (list.length === 0) return null;
  return h('div', { style: { display: 'flex', flexDirection: 'row', gap: 12 } },
    ...list.map((g) => h('div', {
      key: g,
      style: {
        display: 'flex',
        padding: '10px 18px',
        borderRadius: 9999,
        border: '1px solid rgba(255,255,255,0.22)',
        backgroundColor: 'rgba(255,255,255,0.10)',
      },
    }, h('span', { style: { fontSize, fontWeight: 500, color: 'rgba(255,255,255,0.85)' } }, g))),
  );
}

// CTA band — replaces the old duplicate footer branding (spec §3 item 6).
function CtaBand({ fontSize = 24 }) {
  return h('div', { style: { display: 'flex' } },
    h('span', { style: { fontSize, fontWeight: 600, color: COLOR_ACCENT } }, 'Find your next watch → trysettle.app'));
}

// TMDB credit — required by TMDB's terms for redistributed poster imagery
// (spec §3 item 7), currently missing entirely from the canvas renderer.
function TmdbCredit({ fontSize = 20, style }) {
  return h('div', { style: { display: 'flex', position: 'absolute', ...style } },
    h('span', { style: { fontSize, color: COLOR_FAINT } }, 'Poster: TMDB'));
}

function PosterBackground({ posterSrc, width, height }) {
  if (posterSrc) {
    return h('img', {
      src: posterSrc,
      width,
      height,
      style: { position: 'absolute', top: 0, left: 0, objectFit: 'cover' },
    });
  }
  // Timeout/fetch-failure fallback (spec §4) — dark placeholder panel, title
  // takes over as the focal point instead of broken/blank imagery.
  return h('div', {
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      width,
      height,
      display: 'flex',
      backgroundColor: COLOR_BG,
    },
  });
}

// ── Format layouts ────────────────────────────────────────────────────────────

// Story (1080×1920) — full-bleed poster, bottom scrim, stacked content.
// Safe zones (spec §2): 250px top, 310px bottom, 120px right kept clear of
// text/badges/QR.
function StoryLayout({ item, storyLine, daypartText, qrDataUrl }) {
  const { width, height } = FORMAT_SIZES.story;
  const SAFE_TOP = 250;
  const SAFE_BOTTOM = 310;
  const SAFE_RIGHT = 120;
  const PAD = 90;

  return h('div', {
    style: {
      width,
      height,
      display: 'flex',
      position: 'relative',
      backgroundColor: COLOR_BG,
      fontFamily: 'Inter',
    },
  },
    h(PosterBackground, { posterSrc: item.posterSrc, width, height }),

    // Bottom scrim — transparent → 88% black over the lower 45%
    h('div', {
      style: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: Math.round(height * 0.45),
        display: 'flex',
        backgroundImage:
          'linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.88) 100%)',
      },
    }),

    // Header — wordmark once, inside the top safe zone
    h('div', {
      style: {
        position: 'absolute',
        top: SAFE_TOP - 130,
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: 'center',
      },
    }, h(Wordmark, { fontSize: 40 })),

    // Content stack — bottom, inside the bottom/right safe zones
    h('div', {
      style: {
        position: 'absolute',
        left: PAD,
        right: PAD + (qrDataUrl ? SAFE_RIGHT : 0),
        bottom: SAFE_BOTTOM,
        display: 'flex',
        flexDirection: 'column',
        gap: 22,
      },
    },
      h(DaypartBadge, { text: daypartText }),
      h(StoryLine, { text: storyLine }),
      h(Title, { title: item.title, maxWidth: width - PAD * 2 - (qrDataUrl ? SAFE_RIGHT : 0) }),
      h(MetaLine, { year: item.year, type: item.type, rating: item.rating }),
      h(ServiceLine, { service: item.service }),
      h(GenreChips, { genres: item.genres }),
      h(CtaBand, {}),
    ),

    qrDataUrl ? h('img', {
      src: qrDataUrl,
      width: 120,
      height: 120,
      style: { position: 'absolute', right: PAD, bottom: SAFE_BOTTOM },
    }) : null,

    h(TmdbCredit, { style: { bottom: 16, right: 20 } }),
  );
}

// Portrait (1080×1350) / Square (1080×1080) — poster occupies the upper ~62%,
// text block below on solid color-bg (no scrim needed — spec §3 "Per-format
// reflow").
function StackedLayout({ fmt, item, storyLine, daypartText }) {
  const { width, height } = FORMAT_SIZES[fmt];
  const PAD = 64;
  // Square (1080×1080) has far less total height than portrait (1080×1350) to
  // split the same way — 62% left only ~410px for the text block, not enough
  // for badge+story+2-line title+meta+service+chips+CTA, and the title
  // visually overlapped the poster above it (confirmed by rendering both
  // formats and comparing). Portrait's 62% has real headroom to spare, so it
  // keeps it; square gets a smaller poster share instead.
  const posterH = Math.round(height * (fmt === 'square' ? 0.5 : 0.62));

  return h('div', {
    style: {
      width,
      height,
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: COLOR_BG,
      fontFamily: 'Inter',
    },
  },
    h('div', { style: { position: 'relative', display: 'flex', width, height: posterH } },
      h(PosterBackground, { posterSrc: item.posterSrc, width, height: posterH }),
      h('div', {
        style: { position: 'absolute', top: 28, left: 0, right: 0, display: 'flex', justifyContent: 'center' },
      }, h(Wordmark, { fontSize: 32 })),
    ),
    h('div', {
      style: {
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        padding: `36px ${PAD}px`,
        gap: 16,
      },
    },
      h(DaypartBadge, { text: daypartText, fontSize: 22, padY: 9, padX: 18 }),
      h(StoryLine, { text: storyLine, fontSize: 26 }),
      h(Title, { title: item.title, fontSize: 52, maxWidth: width - PAD * 2 }),
      h(MetaLine, { year: item.year, type: item.type, rating: item.rating, fontSize: 22 }),
      h(ServiceLine, { service: item.service, fontSize: 24 }),
      h(GenreChips, { genres: item.genres, fontSize: 19 }),
      h('div', { style: { display: 'flex', flex: 1 } }),
      h(CtaBand, { fontSize: 21 }),
    ),
    h(TmdbCredit, { style: { bottom: 14, right: 18 }, fontSize: 17 }),
  );
}

// OG (1200×630) — horizontal split: poster left at a safe 2:3 crop (never
// stretched), text block right (spec §3 "Per-format reflow").
function OgLayout({ item, storyLine, daypartText }) {
  const { width, height } = FORMAT_SIZES.og;
  const posterW = Math.round(height * (2 / 3)); // 2:3 crop, never stretched
  const textW = width - posterW;
  const PAD = 48;

  return h('div', {
    style: {
      width,
      height,
      display: 'flex',
      flexDirection: 'row',
      backgroundColor: COLOR_BG,
      fontFamily: 'Inter',
    },
  },
    h('div', { style: { position: 'relative', display: 'flex', width: posterW, height } },
      h(PosterBackground, { posterSrc: item.posterSrc, width: posterW, height }),
    ),
    h('div', {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: textW,
        height,
        padding: `${PAD}px ${PAD}px`,
        gap: 14,
        justifyContent: 'center',
      },
    },
      h(Wordmark, { fontSize: 26 }),
      h(DaypartBadge, { text: daypartText, fontSize: 18, padY: 7, padX: 14 }),
      h(StoryLine, { text: storyLine, fontSize: 20 }),
      h(Title, { title: item.title, fontSize: 36, maxWidth: textW - PAD * 2 }),
      h(MetaLine, { year: item.year, type: item.type, rating: item.rating, fontSize: 18 }),
      h(CtaBand, { fontSize: 17 }),
    ),
    h(TmdbCredit, { style: { bottom: 10, right: 14 }, fontSize: 14 }),
  );
}

/**
 * Build the Satori element tree for one format.
 * @param {object} params
 * @param {'story'|'portrait'|'square'|'og'} params.fmt
 * @param {{title, year, type, rating, service, genres, posterSrc}} params.item
 *   posterSrc is a data: URI (or null for the placeholder fallback) — the
 *   caller resolves the TMDB fetch (with its own timeout) before this runs.
 * @param {string} params.storyLine - pre-sanitized/truncated, rendered verbatim.
 * @param {string} params.daypartText - e.g. "🎬 Evening Pick".
 * @param {string} [params.qrDataUrl] - Story format only (Phase 3).
 */
function buildCardElement({ fmt, item, storyLine, daypartText, qrDataUrl }) {
  if (fmt === 'og') return h(OgLayout, { item, storyLine, daypartText });
  if (fmt === 'portrait' || fmt === 'square') {
    return h(StackedLayout, { fmt, item, storyLine, daypartText });
  }
  return h(StoryLayout, { item, storyLine, daypartText, qrDataUrl });
}

module.exports = { FORMAT_SIZES, buildCardElement };
