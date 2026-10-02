import { type CanvasTexture, MeshStandardMaterial } from 'three';
import { TAU } from '../core/math';
import { Rng } from '../core/rng';
import type { SignStyle } from '../world/level-kinds';
import { withCutaway } from './materials';
import { addNoise, makeCanvas, toTexture, type Ctx } from './textures';
import { PALETTE } from './palette';

export { SIGN_STYLES, type SignStyle } from '../world/level-kinds';

export interface SignTextures {
  map: CanvasTexture;
  emissive: CanvasTexture;
  /** Base emissive intensity before the day/night multiplier. */
  glow: number;
}

/** A lit sign's material: its art, glowing through the emissive map. Register it for a day/night channel. */
export function signMaterial(t: SignTextures, roughness: number): MeshStandardMaterial {
  return withCutaway(new MeshStandardMaterial({ map: t.map, emissiveMap: t.emissive, emissive: 0xffffff, emissiveIntensity: t.glow, roughness }));
}

const PX = 112; // canvas pixels per world unit

export const FONT = {
  title: '"Creepster", "Impact", sans-serif',
  label: '"Anton", "Impact", sans-serif',
  brush: '"Bangers", "Impact", sans-serif',
};

/** Largest font size (<= max) that fits text into width. */
export function fitFont(ctx: Ctx, text: string, family: string, maxW: number, maxPx: number): number {
  let px = maxPx;
  ctx.font = `${px}px ${family}`;
  const w = ctx.measureText(text).width;
  if (w > maxW) px = Math.floor((px * maxW) / w);
  ctx.font = `${px}px ${family}`;
  return px;
}

export function drawSkull(ctx: Ctx, cx: number, cy: number, s: number, fill: string, holes: string): void {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.ellipse(cx, cy - s * 0.08, s * 0.5, s * 0.44, 0, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(cx - s * 0.3, cy + s * 0.18, s * 0.6, s * 0.32, s * 0.08);
  ctx.fill();
  ctx.fillStyle = holes;
  ctx.beginPath();
  ctx.ellipse(cx - s * 0.19, cy - s * 0.02, s * 0.13, s * 0.15, 0.2, 0, TAU);
  ctx.ellipse(cx + s * 0.19, cy - s * 0.02, s * 0.13, s * 0.15, -0.2, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx, cy + s * 0.1);
  ctx.lineTo(cx - s * 0.06, cy + s * 0.2);
  ctx.lineTo(cx + s * 0.06, cy + s * 0.2);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(cx - s * 0.17, cy + s * 0.3, s * 0.04, s * 0.18);
  ctx.fillRect(cx - s * 0.02, cy + s * 0.3, s * 0.04, s * 0.18);
  ctx.fillRect(cx + s * 0.13, cy + s * 0.3, s * 0.04, s * 0.18);
  ctx.restore();
}

/**
 * Slime band along the top edge with drips, drawn to every context given
 * (so a color map and its emissive map get identical shapes).
 */
export function drawSlimeTop(ctxs: Ctx[], w: number, band: number, rng: Rng, scale = 1, emissiveOnlyCtx?: Ctx): void {
  const drips: { x: number; w: number; l: number }[] = [];
  let x = rng.range(0, 10) * scale;
  while (x < w) {
    const dw = rng.range(7, 22) * scale;
    const long = rng.chance(0.35);
    drips.push({ x, w: dw, l: long ? rng.range(band * 0.8, band * 3.2) : rng.range(band * 0.1, band * 0.7) });
    x += dw + rng.range(-3, 14) * scale;
  }
  const shape = (ctx: Ctx, grow: number): void => {
    ctx.beginPath();
    ctx.rect(-grow, -grow, w + grow * 2, band + grow * 2);
    for (const d of drips) {
      const r = d.w / 2 + grow;
      ctx.rect(d.x - grow, band - 2, d.w + grow * 2, d.l);
      ctx.moveTo(d.x + d.w / 2 + r, band + d.l);
      ctx.arc(d.x + d.w / 2, band + d.l, r, 0, TAU);
    }
  };
  for (const ctx of ctxs) {
    const isEm = ctx === emissiveOnlyCtx;
    if (!isEm) {
      ctx.fillStyle = PALETTE.ink;
      shape(ctx, 3 * scale);
      ctx.fill();
    }
    ctx.fillStyle = isEm ? '#5cd60f' : PALETTE.slime;
    shape(ctx, 0);
    ctx.fill();
    ctx.fillStyle = isEm ? '#b9ff52' : PALETTE.slimeHot;
    for (const d of drips) {
      ctx.fillRect(d.x + d.w * 0.22, band * 0.3, Math.max(1.5, d.w * 0.16), band * 0.5 + d.l * 0.7);
    }
    ctx.fillStyle = isEm ? '#2a7a00' : PALETTE.slimeDeep;
    ctx.fillRect(0, band * 0.78, w, band * 0.22);
  }
}

function distress(ctx: Ctx, w: number, h: number, rng: Rng, n: number): void {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = `rgba(0,0,0,${rng.range(0.2, 0.7)})`;
    ctx.beginPath();
    ctx.arc(rng.range(0, w), rng.range(0, h), rng.range(0.5, 2.2), 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function finish(map: HTMLCanvasElement, emissive: HTMLCanvasElement, glow: number): SignTextures {
  return { map: toTexture(map), emissive: toTexture(emissive), glow };
}

function bannerSign(lines: string[], w: number, h: number, rng: Rng): SignTextures {
  const W = Math.round(w * PX);
  const H = Math.round(h * PX);
  const a = makeCanvas(W, H);
  const ctx = a.ctx;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#a466e6');
  g.addColorStop(1, '#7a3cc4');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = PALETTE.purpleInk;
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, W - 10, H - 10);
  const band = H * 0.06;
  drawSlimeTop([ctx], W, band, rng, W / 260);
  const pad = W * 0.12;
  const textTop = band * 2.6;
  const skullH = W * 0.42;
  const avail = H - textTop - skullH - pad;
  const lh = Math.min(avail / lines.length, W * 0.4);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((line, i) => {
    const y = textTop + lh * (i + 0.5);
    fitFont(ctx, line, FONT.label, W - pad * 2, lh * 0.9);
    ctx.fillStyle = 'rgba(236,220,255,0.35)';
    ctx.fillText(line, W / 2 + 2, y + 3);
    ctx.fillStyle = '#1a0830';
    ctx.fillText(line, W / 2, y);
  });
  drawSkull(ctx, W / 2, H - pad - skullH * 0.45, skullH * 0.75, '#1a0830', '#8c4ad6');
  addNoise(ctx, W, H, rng, 18);
  distress(ctx, W, H, rng, 160);
  const e = makeCanvas(W, H);
  e.ctx.drawImage(a.c, 0, 0);
  return finish(a.c, e.c, 0.28);
}

function levelSign(lines: string[], w: number, h: number, rng: Rng): SignTextures {
  const W = Math.round(w * PX);
  const H = Math.round(h * PX);
  const a = makeCanvas(W, H);
  const e = makeCanvas(W, H);
  for (const [ctx, em] of [
    [a.ctx, false],
    [e.ctx, true],
  ] as const) {
    ctx.fillStyle = em ? '#000' : PALETTE.purpleInk;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = PALETTE.purpleHot;
    ctx.lineWidth = 6;
    ctx.shadowColor = PALETTE.purpleHot;
    ctx.shadowBlur = em ? 14 : 0;
    ctx.strokeRect(8, 8, W - 16, H - 16);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const [small, big] = lines.length > 1 ? [lines[0] ?? '', lines[1] ?? ''] : ['', lines[0] ?? ''];
    if (small) {
      fitFont(ctx, small, FONT.label, W * 0.8, H * 0.24);
      ctx.fillStyle = '#d9b8ff';
      ctx.fillText(small, W / 2, H * 0.28);
    }
    fitFont(ctx, big, FONT.label, W * 0.8, small ? H * 0.5 : H * 0.7);
    ctx.fillStyle = em ? '#c87bff' : '#e7d2ff';
    ctx.fillText(big, W / 2, small ? H * 0.64 : H * 0.53);
    ctx.shadowBlur = 0;
  }
  addNoise(a.ctx, W, H, rng, 10);
  return finish(a.c, e.c, 1.1);
}

function checkerSign(lines: string[], w: number, h: number, rng: Rng): SignTextures {
  const W = Math.round(w * PX);
  const H = Math.round(h * PX);
  const a = makeCanvas(W, H);
  const ctx = a.ctx;
  ctx.fillStyle = '#f2ecf7';
  ctx.fillRect(0, 0, W, H);
  const sq = H / 5;
  const end = sq * 4;
  for (const x0 of [0, W - end]) {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 5; j++) {
        ctx.fillStyle = (i + j) % 2 ? '#111' : '#f2ecf7';
        ctx.fillRect(x0 + i * sq, j * sq, sq, sq);
      }
    }
  }
  const text = lines[0] ?? 'ROADIE';
  ctx.save();
  ctx.translate(W / 2, H * 0.58);
  ctx.rotate(-0.05);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fitFont(ctx, text, FONT.brush, W - end * 2 - 20, H * 0.72);
  ctx.lineWidth = H * 0.05;
  ctx.strokeStyle = '#111';
  ctx.fillStyle = '#16101e';
  ctx.fillText(text, 0, 0);
  ctx.restore();
  drawSlimeTop([ctx], W, H * 0.09, rng, H / 220);
  addNoise(ctx, W, H, rng, 14);
  distress(ctx, W, H, rng, 300);
  const e = makeCanvas(W, H);
  e.ctx.drawImage(a.c, 0, 0);
  return finish(a.c, e.c, 0.22);
}

function neonSign(lines: string[], w: number, h: number, color: string, family: string, rng: Rng): SignTextures {
  const W = Math.round(w * PX);
  const H = Math.round(h * PX);
  const a = makeCanvas(W, H);
  const e = makeCanvas(W, H);
  for (const [ctx, em] of [
    [a.ctx, false],
    [e.ctx, true],
  ] as const) {
    ctx.fillStyle = em ? '#000' : '#140a1f';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lh = H / lines.length;
    lines.forEach((line, i) => {
      fitFont(ctx, line, family, W * 0.88, lh * 0.82);
      ctx.shadowColor = color;
      ctx.shadowBlur = em ? 18 : 6;
      ctx.lineWidth = Math.max(3, lh * 0.05);
      ctx.strokeStyle = color;
      ctx.strokeText(line, W / 2, lh * (i + 0.53));
      ctx.fillStyle = em ? '#fff' : color;
      ctx.globalAlpha = em ? 0.55 : 0.9;
      ctx.fillText(line, W / 2, lh * (i + 0.53));
      ctx.globalAlpha = 1;
    });
    ctx.shadowBlur = 0;
  }
  addNoise(a.ctx, W, H, rng, 8);
  return finish(a.c, e.c, 2.2);
}

function billboardSign(lines: string[], w: number, h: number, rng: Rng): SignTextures {
  const W = Math.round(w * PX * 0.7);
  const H = Math.round(h * PX * 0.7);
  const a = makeCanvas(W, H);
  const e = makeCanvas(W, H);
  const ctx = a.ctx;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#2a0d47');
  g.addColorStop(1, '#12061f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  e.ctx.fillStyle = '#000';
  e.ctx.fillRect(0, 0, W, H);
  // moon
  const mx = W * 0.84;
  const my = H * 0.3;
  const mr = H * 0.17;
  for (const c of [ctx, e.ctx]) {
    c.save();
    c.shadowColor = '#e8dcff';
    c.shadowBlur = 30;
    c.fillStyle = c === ctx ? '#e9e0f5' : '#8a7fa0';
    c.beginPath();
    c.arc(mx, my, mr, 0, TAU);
    c.fill();
    c.restore();
  }
  drawSlimeTop([ctx, e.ctx], W, H * 0.07, rng, H / 260, e.ctx);
  const [top, mid, bottom] = [lines[0] ?? '', lines[1] ?? '', lines[2] ?? ''];
  for (const c of [ctx, e.ctx]) {
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    if (top) {
      fitFont(c, top, FONT.title, W * 0.5, H * 0.42);
      c.lineWidth = H * 0.03;
      c.strokeStyle = PALETTE.purple;
      c.strokeText(top, W * 0.36, H * 0.36);
      c.fillStyle = c === ctx ? PALETTE.slime : '#7fe82a';
      c.fillText(top, W * 0.36, H * 0.36);
    }
    if (mid) {
      fitFont(c, mid, FONT.title, W * 0.9, H * 0.3);
      c.lineWidth = H * 0.025;
      c.strokeStyle = PALETTE.purple;
      c.strokeText(mid, W / 2, H * 0.68);
      c.fillStyle = c === ctx ? PALETTE.slime : '#7fe82a';
      c.fillText(mid, W / 2, H * 0.68);
    }
    if (bottom) {
      fitFont(c, bottom, FONT.label, W * 0.8, H * 0.1);
      c.fillStyle = c === ctx ? '#d9c4ff' : '#5a3a80';
      c.fillText(bottom, W / 2, H * 0.89);
    }
  }
  addNoise(ctx, W, H, rng, 12);
  return finish(a.c, e.c, 1.2);
}

function scannerSign(w: number, h: number, rng: Rng): SignTextures {
  const W = Math.round(w * PX);
  const H = Math.round(h * PX);
  const a = makeCanvas(W, H);
  const e = makeCanvas(W, H);
  for (const [ctx, em] of [
    [a.ctx, false],
    [e.ctx, true],
  ] as const) {
    ctx.fillStyle = em ? '#000' : '#1a1424';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = em ? '#00ff66' : '#3dff8a';
    ctx.beginPath();
    ctx.roundRect(W * 0.2, H * 0.12, W * 0.6, H * 0.3, 6);
    ctx.fill();
    ctx.fillStyle = em ? '#888' : '#d8d0e8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitFont(ctx, 'SCAN', FONT.label, W * 0.8, H * 0.18);
    ctx.fillText('SCAN', W / 2, H * 0.58);
    fitFont(ctx, 'BADGE', FONT.label, W * 0.8, H * 0.18);
    ctx.fillText('BADGE', W / 2, H * 0.8);
  }
  addNoise(a.ctx, W, H, rng, 8);
  return finish(a.c, e.c, 1.4);
}

/** Clock dial: numerals and ticks glow green at night. */
function dialSign(rng: Rng): SignTextures {
  const S = 512;
  const a = makeCanvas(S, S);
  const e = makeCanvas(S, S);
  for (const [ctx, em] of [
    [a.ctx, false],
    [e.ctx, true],
  ] as const) {
    ctx.fillStyle = em ? '#000' : PALETTE.purpleInk;
    ctx.fillRect(0, 0, S, S);
    const c = S / 2;
    ctx.beginPath();
    ctx.arc(c, c, S * 0.47, 0, TAU);
    ctx.fillStyle = em ? '#0b2000' : '#e9e1f2';
    ctx.fill();
    ctx.lineWidth = 14;
    ctx.strokeStyle = em ? PALETTE.slime : PALETTE.purpleInk;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c, c, S * 0.41, 0, TAU);
    ctx.lineWidth = 3;
    ctx.stroke();
    for (let i = 0; i < 60; i++) {
      const ang = (i / 60) * TAU;
      const big = i % 5 === 0;
      const r0 = S * (big ? 0.36 : 0.39);
      const r1 = S * 0.42;
      ctx.beginPath();
      ctx.moveTo(c + Math.sin(ang) * r0, c - Math.cos(ang) * r0);
      ctx.lineTo(c + Math.sin(ang) * r1, c - Math.cos(ang) * r1);
      ctx.lineWidth = big ? 8 : 3;
      ctx.strokeStyle = em ? PALETTE.slime : PALETTE.ink;
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${S * 0.085}px ${FONT.label}`;
    ctx.fillStyle = em ? '#a8ff4a' : PALETTE.ink;
    for (let i = 1; i <= 12; i++) {
      const ang = (i / 12) * TAU;
      ctx.fillText(String(i), c + Math.sin(ang) * S * 0.3, c - Math.cos(ang) * S * 0.3 + 2);
    }
    if (!em) drawSkull(ctx, c, c + S * 0.14, S * 0.12, '#cbbfdd', '#e9e1f2');
  }
  addNoise(a.ctx, S, S, rng, 10);
  return finish(a.c, e.c, 1.6);
}

const cache = new Map<string, SignTextures>();

export function signTextures(style: SignStyle, lines: string[], w: number, h: number, seed = 1): SignTextures {
  const key = `${style}|${lines.join('/')}|${w}|${h}|${seed}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const rng = new Rng(seed * 7919 + lines.join('').length);
  let out: SignTextures;
  switch (style) {
    case 'banner':
      out = bannerSign(lines, w, h, rng);
      break;
    case 'level':
      out = levelSign(lines, w, h, rng);
      break;
    case 'checker':
      out = checkerSign(lines, w, h, rng);
      break;
    case 'neon':
      out = neonSign(lines, w, h, PALETTE.slime, FONT.brush, rng);
      break;
    case 'neonPurple':
      out = neonSign(lines, w, h, PALETTE.purpleHot, FONT.label, rng);
      break;
    case 'foxy':
      out = neonSign(lines, w, h, PALETTE.foxy, FONT.brush, rng);
      break;
    case 'billboard':
      out = billboardSign(lines, w, h, rng);
      break;
    case 'scanner':
      out = scannerSign(w, h, rng);
      break;
    case 'dial':
      out = dialSign(rng);
      break;
  }
  cache.set(key, out);
  return out;
}
