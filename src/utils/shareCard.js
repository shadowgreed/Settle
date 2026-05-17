const SERVICE_COLORS = {
  'Netflix':      '#E50914',
  'Max':          '#6A1BD0',
  'Disney+':      '#1B3CC0',
  'Apple TV':     '#A2AAAD',
  'Prime Video':  '#00A8E1',
  'In Theaters':  '#EF9F27',
};

// Two-stage image loader. Both stages produce a canvas-safe result.
//
// Stage 1: fetch → createImageBitmap(blob)
//   Fetches the raw bytes, decodes them into an ImageBitmap.
//   An ImageBitmap has NO URL origin — it came from a Blob — so drawing it
//   to canvas never taints it, regardless of where the bytes came from.
//
// Stage 2: <img crossOrigin="anonymous">
//   Falls back to a standard CORS image load. Safe as long as the server
//   sends Access-Control-Allow-Origin (TMDB CDN does).
async function loadImage(src) {
  // Stage 1 — fetch → ImageBitmap (no URL origin, canvas-safe by design)
  try {
    const res    = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob   = await res.blob();
    const bitmap = await createImageBitmap(blob);
    console.log('[ShareCard] poster loaded via fetch→createImageBitmap');
    return bitmap;
  } catch (e) {
    console.warn('[ShareCard] fetch→ImageBitmap failed:', e.message);
  }

  // Stage 2 — crossOrigin anonymous (canvas-safe if server sends CORS headers)
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = 'anonymous';
      el.onload  = () => resolve(el);
      el.onerror = () => reject(new Error('crossOrigin blocked'));
      el.src = src;
    });
    console.log('[ShareCard] poster loaded via crossOrigin');
    return img;
  } catch (e) {
    console.warn('[ShareCard] crossOrigin failed:', e.message);
  }

  throw new Error('loadImage: all stages failed for ' + src);
}

// Returns y of last line drawn
function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 3) {
  const words = text.split(' ');
  let line  = '';
  let ly    = y;
  let lines = 0;
  for (let w = 0; w < words.length; w++) {
    const word = words[w];
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, ly);
      line = word;
      ly  += lineHeight;
      lines++;
      if (lines >= maxLines - 1) {
        const remaining = words.slice(w).join(' ');
        const truncated = truncateToFit(ctx, remaining, maxWidth - 36);
        ctx.fillText(truncated, x, ly);
        return ly;
      }
    } else {
      line = test;
    }
  }
  ctx.fillText(line, x, ly);
  return ly;
}

function truncateToFit(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (ctx.measureText(truncated + '…').width > maxWidth && truncated.length > 0) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + '…';
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
  const r    = parseFloat(rating) || 0;
  const full = Math.min(5, Math.max(0, Math.round(r / 2)));
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

// Grain drawn onto an OFFSCREEN canvas, then composited via drawImage.
function addGrain(ctx, W, H) {
  const off  = document.createElement('canvas');
  off.width  = W;
  off.height = H;
  const octx = off.getContext('2d');
  const data = octx.createImageData(W, H);
  for (let i = 0; i < data.data.length; i += 4) {
    const v          = (Math.random() * 28) | 0;
    data.data[i]     = v;
    data.data[i + 1] = v;
    data.data[i + 2] = v;
    data.data[i + 3] = 22;
  }
  octx.putImageData(data, 0, 0);

  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.18;
  ctx.drawImage(off, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

function drawFallbackPoster(ctx, W, H, serviceColor) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, serviceColor + '55');
  g.addColorStop(1, '#111');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.font         = '160px system-ui, -apple-system, sans-serif';
  ctx.fillStyle    = serviceColor + '44';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('🎬', W / 2, H / 2);
  ctx.restore();
}

export async function generateShareCard({ result, mode, playerNames }) {
  // 1080×1920 — the universal standard for Instagram Stories, WhatsApp Status,
  // and Snapchat (9:16 ratio). Sized correctly so platforms don't upscale it.
  const W   = 1080;
  const H   = 1920;
  const PAD = 54;  // 30 × 1.8 scale factor
  // Poster takes ~52% of card height, text panel gets the remaining 920px
  const POSTER_BOTTOM = 1000;
  const serviceColor  = SERVICE_COLORS[result.service] || '#888';

  const canvas  = document.createElement('canvas');
  canvas.width  = W;
  canvas.height = H;
  const ctx     = canvas.getContext('2d');

  // ── 1. Base background ───────────────────────────────────────────────
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, W, H);

  // ── 2. Poster (full-width, top ~52%) ─────────────────────────────────
  const posterBase =
    process.env.NODE_ENV === 'development'
      ? '/tmdb-images'
      : 'https://image.tmdb.org';

  let posterLoaded = false;
  if (result.posterPath) {
    try {
      const img   = await loadImage(`${posterBase}/t/p/w780${result.posterPath}`);
      const scale = W / img.width;
      const drawH = img.height * scale;

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, POSTER_BOTTOM);
      ctx.clip();
      ctx.drawImage(img, 0, 0, W, drawH);
      ctx.restore();
      posterLoaded = true;
    } catch {
      // falls through to fallback below
    }
  }

  if (!posterLoaded) {
    drawFallbackPoster(ctx, W, POSTER_BOTTOM, serviceColor);
  }

  // ── 3. Gradient: poster fades to black ───────────────────────────────
  const fadeGrad = ctx.createLinearGradient(0, POSTER_BOTTOM * 0.6, 0, POSTER_BOTTOM + 6);
  fadeGrad.addColorStop(0, 'rgba(10,10,10,0)');
  fadeGrad.addColorStop(1, 'rgba(10,10,10,1)');
  ctx.fillStyle = fadeGrad;
  ctx.fillRect(0, 0, W, POSTER_BOTTOM + 6);

  // ── 4. Bottom panel ───────────────────────────────────────────────────
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, POSTER_BOTTOM, W, H - POSTER_BOTTOM);

  // Subtle glow — service color only at the very bottom edge
  const glowGrad = ctx.createRadialGradient(W / 2, H + 180, 18, W / 2, H + 180, W * 0.9);
  glowGrad.addColorStop(0, serviceColor + '28');
  glowGrad.addColorStop(0.6, serviceColor + '0a');
  glowGrad.addColorStop(1, 'transparent');
  ctx.fillStyle = glowGrad;
  ctx.fillRect(0, POSTER_BOTTOM, W, H - POSTER_BOTTOM);

  // Accent line — thin, centered fade
  const accentGrad = ctx.createLinearGradient(0, 0, W, 0);
  accentGrad.addColorStop(0,    'transparent');
  accentGrad.addColorStop(0.2,  serviceColor + '99');
  accentGrad.addColorStop(0.5,  serviceColor + 'cc');
  accentGrad.addColorStop(0.8,  serviceColor + '99');
  accentGrad.addColorStop(1,    'transparent');
  ctx.fillStyle = accentGrad;
  ctx.fillRect(0, POSTER_BOTTOM, W, 3);

  // ── 5. App branding top-left (over poster) ────────────────────────────
  ctx.font         = '500 20px system-ui, -apple-system, sans-serif';
  ctx.fillStyle    = 'rgba(255,255,255,0.6)';
  ctx.textBaseline = 'top';
  ctx.textAlign    = 'left';
  ctx.fillText('🎬  Settle', PAD, 36);

  // ── 6. Mode pill ──────────────────────────────────────────────────────
  const modeText =
    mode === 'couple'  ? '💑  Our Pick Tonight'
    : mode === 'theater' ? '🎟️  In Theaters'
    : "🎬  Tonight's Pick";

  ctx.font = '600 20px system-ui, -apple-system, sans-serif';
  const pillW = ctx.measureText(modeText).width + 44;
  const pillH = 44;
  const pillX = PAD;
  const pillY = POSTER_BOTTOM + 32;

  roundRect(ctx, pillX, pillY, pillW, pillH, 22);
  ctx.fillStyle   = serviceColor + '25';
  ctx.fill();
  ctx.strokeStyle = serviceColor + '66';
  ctx.lineWidth   = 2;
  ctx.stroke();
  ctx.fillStyle    = serviceColor;
  ctx.textBaseline = 'middle';
  ctx.fillText(modeText, pillX + 22, pillY + pillH / 2);

  // ── 7. Title ──────────────────────────────────────────────────────────
  let curY = pillY + pillH + 32;
  ctx.font         = 'bold 50px system-ui, -apple-system, sans-serif';
  ctx.fillStyle    = '#f5f5f5';
  ctx.textBaseline = 'top';
  curY = wrapText(ctx, result.title, PAD, curY, W - PAD * 2, 65) + 65;

  // ── 8. Year · Type ────────────────────────────────────────────────────
  curY += 4;
  ctx.font      = '400 24px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#999';
  ctx.fillText(`${result.year} · ${result.type}`, PAD, curY);
  curY += 40;

  // ── 9. Stars ──────────────────────────────────────────────────────────
  ctx.font      = '25px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#EF9F27';
  ctx.fillText(starsFrom(result.rating), PAD, curY);
  curY += 44;

  // ── 10. Service dot + name ────────────────────────────────────────────
  ctx.beginPath();
  ctx.arc(PAD + 9, curY + 11, 8, 0, Math.PI * 2);
  ctx.fillStyle = serviceColor;
  ctx.fill();
  ctx.font         = '600 22px system-ui, -apple-system, sans-serif';
  ctx.fillStyle    = serviceColor;
  ctx.textBaseline = 'top';
  ctx.fillText(result.service, PAD + 26, curY);
  curY += 50;

  // ── 11. Genre tags ────────────────────────────────────────────────────
  const genreList = (result.genres || []).slice(0, 4);
  if (genreList.length > 0) {
    ctx.font = '500 20px system-ui, -apple-system, sans-serif';
    let tagX = PAD;
    const tagH = 40;
    const tagY = curY;
    for (const genre of genreList) {
      const label  = genre.name || String(genre);
      const labelW = ctx.measureText(label).width;
      const tagW   = labelW + 32;
      if (tagX + tagW > W - PAD) break;
      roundRect(ctx, tagX, tagY, tagW, tagH, 20);
      ctx.fillStyle   = 'rgba(255,255,255,0.07)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth   = 1;
      ctx.stroke();
      ctx.fillStyle    = '#ccc';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, tagX + 16, tagY + tagH / 2);
      tagX += tagW + 14;
    }
  }

  // ── 12. Film grain ────────────────────────────────────────────────────
  addGrain(ctx, W, H);

  // ── 13. Footer URL — pinned to bottom ────────────────────────────────
  ctx.font         = '400 20px system-ui, -apple-system, sans-serif';
  ctx.fillStyle    = 'rgba(255,255,255,0.25)';
  ctx.textBaseline = 'bottom';
  ctx.textAlign    = 'center';
  ctx.fillText('trysettle.app', W / 2, H - 36);

  return canvas;
}
