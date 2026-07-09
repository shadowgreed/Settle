// ─────────────────────────────────────────────────────────────────────────────
// Shared Satori JSX layout for the shareable pick card (handoff spec §3/§4).
//
// One source of truth for all four export formats (story/portrait/square/og),
// consumed by both api/share-card.jsx (renders the PNG) and api/pick/[id].js
// (reads storyLine/title for the unfurl page's og:description — see §5).
//
// Satori (the JSX-to-SVG engine behind @vercel/og) only supports a CSS subset:
// flexbox layout, absolute/relative positioning, linear-gradient backgrounds,
// border/borderRadius, and -webkit-line-clamp-style text clamping. Every
// multi-child <div> needs an explicit `display` (flex here, always) — Satori
// throws instead of defaulting the way a browser would.
//
// Colors are the literal hex values from src/App.css's :root token block —
// Satori can't resolve CSS custom properties, so these must be copy-pasted,
// not var()-referenced. Keep in sync by hand if the token file changes.
// ─────────────────────────────────────────────────────────────────────────────

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
export const FORMAT_SIZES = {
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
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize, fontWeight: 700, color: COLOR_ACCENT }}>🎬</span>
      <span style={{ fontSize, fontWeight: 700, color: COLOR_ACCENT, letterSpacing: 2 }}>
        SETTLE
      </span>
    </div>
  );
}

// Daypart badge — restyled to the standard accent chip (spec §3 item 3). The
// old canvas renderer's "mode pill" reused serviceColor for this, which read
// as branded red on Netflix picks; this is a fixed accent chip, unrelated to
// the service line below it.
function DaypartBadge({ text, fontSize = 26, padY = 12, padX = 22 }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        alignSelf: 'flex-start',
        padding: `${padY}px ${padX}px`,
        borderRadius: 9999,
        border: `1px solid ${COLOR_ACCENT}`,
        backgroundColor: 'rgba(240,160,48,0.18)', // color-accent @ 18%
      }}
    >
      <span style={{ fontSize, fontWeight: 600, color: COLOR_ACCENT }}>{text}</span>
    </div>
  );
}

// The story line (spec §3 item 4 — new) — the actual "why" reason. Rendered
// verbatim; the caller (api/share-card.jsx) is responsible for sourcing and
// sanitizing/truncating this string before it ever reaches this layout.
function StoryLine({ text, fontSize = 30 }) {
  if (!text) return null;
  return (
    <div style={{ display: 'flex' }}>
      <span style={{ fontSize, fontWeight: 500, color: COLOR_TEXT }}>{text}</span>
    </div>
  );
}

function Title({ title, fontSize = 66, maxWidth }) {
  return (
    <div
      style={{
        display: '-webkit-box',
        WebkitBoxOrient: 'vertical',
        WebkitLineClamp: 2,
        overflow: 'hidden',
        maxWidth,
        fontSize,
        fontWeight: 700,
        color: '#ffffff',
        lineHeight: 1.15,
      }}
    >
      {title}
    </div>
  );
}

// Numeric metadata line — "2004 · Movie · 6.8" (spec §3 item 5).
function MetaLine({ year, type, rating, fontSize = 26 }) {
  const ratingStr = formatRating(rating);
  const parts = [year, type, ratingStr ? `★ ${ratingStr}` : null].filter(Boolean);
  return (
    <div style={{ display: 'flex' }}>
      <span style={{ fontSize, fontWeight: 400, color: 'rgba(255,255,255,0.75)' }}>
        {parts.join('  ·  ')}
      </span>
    </div>
  );
}

function ServiceLine({ service, fontSize = 28 }) {
  const color = serviceColor(service);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div
        style={{
          display: 'flex',
          width: 14,
          height: 14,
          borderRadius: 7,
          backgroundColor: color,
        }}
      />
      <span style={{ fontSize, fontWeight: 700, color }}>{service}</span>
    </div>
  );
}

// Genre chips — capped at 2 (spec §3 item 5, tighter than the old canvas
// renderer's cap of 3).
function GenreChips({ genres, fontSize = 22 }) {
  const list = (genres || []).slice(0, 2);
  if (list.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'row', gap: 12 }}>
      {list.map((g) => (
        <div
          key={g}
          style={{
            display: 'flex',
            padding: '10px 18px',
            borderRadius: 9999,
            border: '1px solid rgba(255,255,255,0.22)',
            backgroundColor: 'rgba(255,255,255,0.10)',
          }}
        >
          <span style={{ fontSize, fontWeight: 500, color: 'rgba(255,255,255,0.85)' }}>{g}</span>
        </div>
      ))}
    </div>
  );
}

// CTA band — replaces the old duplicate footer branding (spec §3 item 6).
function CtaBand({ fontSize = 24 }) {
  return (
    <div style={{ display: 'flex' }}>
      <span style={{ fontSize, fontWeight: 600, color: COLOR_ACCENT }}>
        Find your next watch → trysettle.app
      </span>
    </div>
  );
}

// TMDB credit — required by TMDB's terms for redistributed poster imagery
// (spec §3 item 7), currently missing entirely from the canvas renderer.
function TmdbCredit({ fontSize = 20, style }) {
  return (
    <div style={{ display: 'flex', position: 'absolute', ...style }}>
      <span style={{ fontSize, color: COLOR_FAINT }}>Poster: TMDB</span>
    </div>
  );
}

function PosterBackground({ posterSrc, width, height }) {
  if (posterSrc) {
    return (
      <img
        src={posterSrc}
        width={width}
        height={height}
        style={{ position: 'absolute', top: 0, left: 0, objectFit: 'cover' }}
      />
    );
  }
  // Timeout/fetch-failure fallback (spec §4) — dark placeholder panel, title
  // takes over as the focal point instead of broken/blank imagery.
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width,
        height,
        display: 'flex',
        backgroundColor: COLOR_BG,
      }}
    />
  );
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

  return (
    <div
      style={{
        width,
        height,
        display: 'flex',
        position: 'relative',
        backgroundColor: COLOR_BG,
        fontFamily: 'Inter',
      }}
    >
      <PosterBackground posterSrc={item.posterSrc} width={width} height={height} />

      {/* Bottom scrim — transparent → 88% black over the lower 45% */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: Math.round(height * 0.45),
          display: 'flex',
          backgroundImage:
            'linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.88) 100%)',
        }}
      />

      {/* Header — wordmark once, inside the top safe zone */}
      <div
        style={{
          position: 'absolute',
          top: SAFE_TOP - 130,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <Wordmark fontSize={40} />
      </div>

      {/* Content stack — bottom, inside the bottom/right safe zones */}
      <div
        style={{
          position: 'absolute',
          left: PAD,
          right: PAD + (qrDataUrl ? SAFE_RIGHT : 0),
          bottom: SAFE_BOTTOM,
          display: 'flex',
          flexDirection: 'column',
          gap: 22,
        }}
      >
        <DaypartBadge text={daypartText} />
        <StoryLine text={storyLine} />
        <Title title={item.title} maxWidth={width - PAD * 2 - (qrDataUrl ? SAFE_RIGHT : 0)} />
        <MetaLine year={item.year} type={item.type} rating={item.rating} />
        <ServiceLine service={item.service} />
        <GenreChips genres={item.genres} />
        <CtaBand />
      </div>

      {qrDataUrl && (
        <img
          src={qrDataUrl}
          width={120}
          height={120}
          style={{ position: 'absolute', right: PAD, bottom: SAFE_BOTTOM }}
        />
      )}

      <TmdbCredit style={{ bottom: 16, right: 20 }} />
    </div>
  );
}

// Portrait (1080×1350) / Square (1080×1080) — poster occupies the upper ~62%,
// text block below on solid color-bg (no scrim needed — spec §3 "Per-format
// reflow").
function StackedLayout({ fmt, item, storyLine, daypartText }) {
  const { width, height } = FORMAT_SIZES[fmt];
  const PAD = 64;
  const posterH = Math.round(height * 0.62);

  return (
    <div
      style={{
        width,
        height,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: COLOR_BG,
        fontFamily: 'Inter',
      }}
    >
      <div style={{ position: 'relative', display: 'flex', width, height: posterH }}>
        <PosterBackground posterSrc={item.posterSrc} width={width} height={posterH} />
        <div style={{ position: 'absolute', top: 28, left: 0, right: 0, display: 'flex', justifyContent: 'center' }}>
          <Wordmark fontSize={32} />
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          padding: `36px ${PAD}px`,
          gap: 16,
        }}
      >
        <DaypartBadge text={daypartText} fontSize={22} padY={9} padX={18} />
        <StoryLine text={storyLine} fontSize={26} />
        <Title title={item.title} fontSize={52} maxWidth={width - PAD * 2} />
        <MetaLine year={item.year} type={item.type} rating={item.rating} fontSize={22} />
        <ServiceLine service={item.service} fontSize={24} />
        <GenreChips genres={item.genres} fontSize={19} />
        <div style={{ display: 'flex', flex: 1 }} />
        <CtaBand fontSize={21} />
      </div>
      <TmdbCredit style={{ bottom: 14, right: 18 }} fontSize={17} />
    </div>
  );
}

// OG (1200×630) — horizontal split: poster left at a safe 2:3 crop (never
// stretched), text block right (spec §3 "Per-format reflow").
function OgLayout({ item, storyLine, daypartText }) {
  const { width, height } = FORMAT_SIZES.og;
  const posterW = Math.round(height * (2 / 3)); // 2:3 crop, never stretched
  const textW = width - posterW;
  const PAD = 48;

  return (
    <div
      style={{
        width,
        height,
        display: 'flex',
        flexDirection: 'row',
        backgroundColor: COLOR_BG,
        fontFamily: 'Inter',
      }}
    >
      <div style={{ position: 'relative', display: 'flex', width: posterW, height }}>
        <PosterBackground posterSrc={item.posterSrc} width={posterW} height={height} />
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: textW,
          height,
          padding: `${PAD}px ${PAD}px`,
          gap: 14,
          justifyContent: 'center',
        }}
      >
        <Wordmark fontSize={26} />
        <DaypartBadge text={daypartText} fontSize={18} padY={7} padX={14} />
        <StoryLine text={storyLine} fontSize={20} />
        <Title title={item.title} fontSize={36} maxWidth={textW - PAD * 2} />
        <MetaLine year={item.year} type={item.type} rating={item.rating} fontSize={18} />
        <CtaBand fontSize={17} />
      </div>
      <TmdbCredit style={{ bottom: 10, right: 14 }} fontSize={14} />
    </div>
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
export function buildCardElement({ fmt, item, storyLine, daypartText, qrDataUrl }) {
  if (fmt === 'og') return <OgLayout item={item} storyLine={storyLine} daypartText={daypartText} />;
  if (fmt === 'portrait' || fmt === 'square') {
    return <StackedLayout fmt={fmt} item={item} storyLine={storyLine} daypartText={daypartText} />;
  }
  return <StoryLayout item={item} storyLine={storyLine} daypartText={daypartText} qrDataUrl={qrDataUrl} />;
}
