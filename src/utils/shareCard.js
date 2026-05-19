const SERVICE_COLORS = {
  'Netflix':      '#E50914',
  'Max':          '#6A1BD0',
  'Disney+':      '#1B3CC0',
  'Apple TV':     '#A2AAAD',
  'Prime Video':  '#00A8E1',
  'In Theaters':  '#EF9F27',
};

// Two-stage image loader — produces a canvas-safe result in both paths.
// Stage 1: fetch → createImageBitmap(blob) — no URL origin, never taints canvas.
// Stage 2: <img crossOrigin="anonymous"> — safe when server sends CORS headers (TMDB does).
async function loadImage(src) {
  try {
    const res    = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob   = await res.blob();
    const bitmap = await createImageBitmap(blob);
    return bitmap;
  } catch (e) {
    console.warn('[ShareCard] fetch→ImageBitmap failed:', e.message);
  }

  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = 'anonymous';
      el.onload  = () => resolve(el);
      el.onerror = () => reject(new Error('crossOrigin blocked'));
      el.src = src;
    });
    return img;
  } catch (e) {
    console.warn('[ShareCard] crossOrigin failed:', e.message);
  }

  throw new Error('loadImage: all stages failed for ' + src);
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 2) {
  const words = text.split(' ');
  let line = '';
  let ly   = y;
  let lines = 0;
  for (let w = 0; w < words.length; w++) {
    const test = line ? `${line} ${words[w]}` : words[w];
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, ly);
      line = words[w];
      ly  += lineHeight;
      lines++;
      if (lines >= maxLines - 1) {
        const remaining = words.slice(w).join(' ');
        let truncated = remaining;
        while (ctx.measureText(truncated + '…').width > maxWidth && truncated.length > 0) {
          truncated = truncated.slice(0, -1);
        }
        ctx.fillText(truncated + (truncated !== remaining ? '…' : ''), x, ly);
        return ly;
      }
    } else {
      line = test;
    }
  }
  ctx.fillText(line, x, ly);
  return ly;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

function starsFrom(rating) {
  const full = Math.min(5, Math.max(0, Math.round((parseFloat(rating) || 0) / 2)));
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

// Subtle film grain. We bake a 256×256 grain tile ONCE per page load and
// tile it across the 1080×1920 share canvas, saving ~2 M iterations of the
// JS pixel loop per share. Tile is composited via overlay blend so it
// modulates the underlying pixels rather than replacing them.
const GRAIN_TILE_SIZE = 256;
let grainTileCanvas = null;

function buildGrainTile() {
  if (grainTileCanvas) return grainTileCanvas;
  const tile = document.createElement('canvas');
  tile.width  = GRAIN_TILE_SIZE;
  tile.height = GRAIN_TILE_SIZE;
  const tctx  = tile.getContext('2d');
  const data  = tctx.createImageData(GRAIN_TILE_SIZE, GRAIN_TILE_SIZE);
  for (let i = 0; i < data.data.length; i += 4) {
    const v = (Math.random() * 30) | 0;
    data.data[i] = data.data[i + 1] = data.data[i + 2] = v;
    data.data[i + 3] = 20;
  }
  tctx.putImageData(data, 0, 0);
  grainTileCanvas = tile;
  return tile;
}

function addGrain(ctx, W, H) {
  const tile = buildGrainTile();
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.15;
  for (let y = 0; y < H; y += GRAIN_TILE_SIZE) {
    for (let x = 0; x < W; x += GRAIN_TILE_SIZE) {
      ctx.drawImage(tile, x, y);
    }
  }
  ctx.restore();
}

export async function generateShareCard({ result, mode, playerNames }) {
  // 1080×1920 — universal 9:16 standard for Instagram Stories, WhatsApp Status, Snapchat.
  const W   = 1080;
  const H   = 1920;
  // Horizontal padding respects Instagram's safe zone (~8% from sides = ~86px).
  // Left side especially matters — Instagram's × button sits in top-left.
  const PAD = 90;
  const serviceColor = SERVICE_COLORS[result.service] || '#888';

  const canvas  = document.createElement('canvas');
  canvas.width  = W;
  canvas.height = H;
  const ctx     = canvas.getContext('2d');

  // ── 1. Dark base (visible if poster fails) ───────────────────────────
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, W, H);

  // ── 2. Poster — FULL BLEED, cover mode ──────────────────────────────
  // Scale so the poster fills the entire 1080×1920 canvas (object-fit: cover).
  // For a standard 2:3 TMDB poster this crops ~100px from each side, keeping
  // the centered subject fully visible.
  const posterBase =
    process.env.NODE_ENV === 'development'
      ? '/tmdb-images'
      : 'https://image.tmdb.org';

  if (result.posterPath) {
    try {
      const img = await loadImage(`${posterBase}/t/p/w780${result.posterPath}`);
      const imgAspect    = img.width / img.height;
      const canvasAspect = W / H;

      let dw, dh, dx, dy;
      if (imgAspect > canvasAspect) {
        // Poster wider than canvas ratio — fit to height, crop sides
        dh = H; dw = H * imgAspect;
        dx = (W - dw) / 2; dy = 0;
      } else {
        // Poster taller than canvas ratio — fit to width, anchor to top
        // (keeps the face / key art at the top in frame)
        dw = W; dh = W / imgAspect;
        dx = 0; dy = 0;
      }

      ctx.drawImage(img, dx, dy, dw, dh);
    } catch {
      // Fallback: service-colored gradient if poster fails
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, serviceColor + '66');
      g.addColorStop(1, '#111');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.font         = '180px system-ui';
      ctx.fillStyle    = serviceColor + '33';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🎬', W / 2, H / 2);
    }
  }

  // ── 3. Top vignette — makes branding readable over any poster ────────
  const topGrad = ctx.createLinearGradient(0, 0, 0, H * 0.28);
  topGrad.addColorStop(0,   'rgba(0,0,0,0.82)');
  topGrad.addColorStop(0.5, 'rgba(0,0,0,0.35)');
  topGrad.addColorStop(1,   'rgba(0,0,0,0)');
  ctx.fillStyle = topGrad;
  ctx.fillRect(0, 0, W, H * 0.28);

  // ── 4. Bottom overlay — strong fade for text readability ─────────────
  // Starts fully transparent at 42% height, deepens to ~95% opacity at bottom.
  const botGrad = ctx.createLinearGradient(0, H * 0.42, 0, H);
  botGrad.addColorStop(0,    'rgba(0,0,0,0)');
  botGrad.addColorStop(0.28, 'rgba(0,0,0,0.60)');
  botGrad.addColorStop(0.55, 'rgba(0,0,0,0.88)');
  botGrad.addColorStop(1,    'rgba(0,0,0,0.97)');
  ctx.fillStyle = botGrad;
  ctx.fillRect(0, 0, W, H);

  // ── 5. Film grain ─────────────────────────────────────────────────────
  addGrain(ctx, W, H);

  // ── 6. App branding — top center ─────────────────────────────────────
  // Prominent enough to catch the eye but not competing with the poster art.
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'top';
  ctx.font         = '600 32px system-ui, -apple-system, sans-serif';
  ctx.fillStyle    = 'rgba(255,255,255,0.90)';
  ctx.fillText('🎬  SETTLE', W / 2, 72);

  // Tagline below branding
  ctx.font      = '400 22px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillText('trysettle.app', W / 2, 116);

  // ── 7. Bottom text block ──────────────────────────────────────────────
  // All text anchored from the bottom up so it never bleeds off-canvas.
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'top';

  // Fixed y positions, working bottom-up from a safe bottom edge (H - 100)
  const SAFE_BOT  = H - 100;  // 100px from physical bottom edge
  const genreTagH = 46;
  const TAGS_BOT  = SAFE_BOT - genreTagH;         // bottom of genre row  = 1774
  const SVC_Y     = TAGS_BOT - 60;                // service name top     = 1714
  const META_Y    = SVC_Y - 46;                   // year · type · stars  = 1668
  const TITLE_BOT = META_Y - 28;                  // bottom of title text = 1640
  const TITLE_TOP = TITLE_BOT - 148;              // title start (2×74px) = 1492
  const PILL_Y    = TITLE_TOP - 62;               // mode pill top        = 1430

  // ── Mode pill ─────────────────────────────────────────────────────────
  const modeText =
    mode === 'couple'  ? '💑  Our Pick Tonight'
    : mode === 'theater' ? '🎟️  In Theaters'
    : "🎬  Tonight's Pick";

  ctx.font = '600 22px system-ui, -apple-system, sans-serif';
  const pillW = ctx.measureText(modeText).width + 48;
  const pillH = 48;

  roundRect(ctx, PAD, PILL_Y, pillW, pillH, 24);
  ctx.fillStyle   = serviceColor + '30';
  ctx.fill();
  ctx.strokeStyle = serviceColor + '80';
  ctx.lineWidth   = 1.5;
  ctx.stroke();
  ctx.fillStyle    = serviceColor;
  ctx.textBaseline = 'middle';
  ctx.fillText(modeText, PAD + 24, PILL_Y + pillH / 2);

  // ── Title ─────────────────────────────────────────────────────────────
  ctx.font         = 'bold 66px system-ui, -apple-system, sans-serif';
  ctx.fillStyle    = '#ffffff';
  ctx.textBaseline = 'top';
  // Shadow for legibility on light posters
  ctx.shadowColor   = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur    = 18;
  ctx.shadowOffsetY = 3;
  wrapText(ctx, result.title, PAD, TITLE_TOP, W - PAD * 2, 74, 2);
  ctx.shadowColor  = 'transparent';
  ctx.shadowBlur   = 0;
  ctx.shadowOffsetY = 0;

  // ── Year · Type · Stars ───────────────────────────────────────────────
  ctx.font      = '400 26px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  const stars   = starsFrom(result.rating);
  ctx.fillText(`${result.year}  ·  ${result.type}  ·  ${stars}`, PAD, META_Y);

  // ── Service name ──────────────────────────────────────────────────────
  // Service dot
  ctx.beginPath();
  ctx.arc(PAD + 10, SVC_Y + 14, 8, 0, Math.PI * 2);
  ctx.fillStyle = serviceColor;
  ctx.fill();
  // Service text
  ctx.font         = '700 28px system-ui, -apple-system, sans-serif';
  ctx.fillStyle    = serviceColor;
  ctx.textBaseline = 'top';
  ctx.fillText(result.service, PAD + 28, SVC_Y);

  // ── Genre tags ────────────────────────────────────────────────────────
  const genreList = (result.genres || []).slice(0, 3);
  if (genreList.length > 0) {
    ctx.font = '500 22px system-ui, -apple-system, sans-serif';
    let tagX = PAD;
    for (const genre of genreList) {
      const label = genre.name || String(genre);
      const labelW = ctx.measureText(label).width;
      const tagW   = labelW + 36;
      if (tagX + tagW > W - PAD) break;
      roundRect(ctx, tagX, TAGS_BOT, tagW, genreTagH, 23);
      ctx.fillStyle   = 'rgba(255,255,255,0.10)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth   = 1;
      ctx.stroke();
      ctx.fillStyle    = 'rgba(255,255,255,0.85)';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, tagX + 18, TAGS_BOT + genreTagH / 2);
      tagX += tagW + 16;
    }
  }

  // ── 8. Footer branding — passive brand impression on every share ─────
  // Sits below the safe zone, centered, small enough not to compete with content.
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.font         = '500 24px system-ui, -apple-system, sans-serif';
  ctx.fillStyle    = 'rgba(255,255,255,0.28)';
  ctx.fillText('🎬  SETTLE  ·  trysettle.app', W / 2, H - 52);

  return canvas;
}
