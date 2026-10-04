import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from 'three';

import { TAU } from '@/engine/core/math';
import { Rng } from '@/engine/core/rng';

import { PALETTE } from './palette';

export type Ctx = CanvasRenderingContext2D;

export function makeCanvas(w: number, h: number): { c: HTMLCanvasElement; ctx: Ctx } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: false });
  if (!ctx) {
    throw new Error('2D canvas unavailable');
  }

  return { c, ctx };
}

export function toTexture(c: HTMLCanvasElement, opts: { repeat?: boolean; srgb?: boolean } = {}): CanvasTexture {
  const t = new CanvasTexture(c);
  if (opts.srgb !== false) {
    t.colorSpace = SRGBColorSpace;
  }

  if (opts.repeat) {
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
  }

  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** Per-pixel luminance grain. */
export function addNoise(ctx: Ctx, w: number, h: number, rng: Rng, amount: number): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng.next() - 0.5) * amount;
    d[i] = (d[i] ?? 0) + n;
    d[i + 1] = (d[i + 1] ?? 0) + n;
    d[i + 2] = (d[i + 2] ?? 0) + n * 1.1;
  }

  ctx.putImageData(img, 0, 0);
}

/** Draw a soft blob that wraps across tile edges so the texture stays seamless. */
function wrappedBlob(ctx: Ctx, S: number, x: number, y: number, r: number, color: string): void {
  for (const ox of [-S, 0, S]) {
    for (const oy of [-S, 0, S]) {
      const cx = x + ox;
      const cy = y + oy;
      if (cx + r < 0 || cx - r > S || cy + r < 0 || cy - r > S) {
        continue;
      }

      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
  }
}

/** Cast-concrete panel: lavender grey, stains, pores, a seam around the tile. */
export function concreteTexture(base: string, seed: number, seams = true): CanvasTexture {
  const S = 256;
  const { c, ctx } = makeCanvas(S, S);
  const rng = new Rng(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, S, S);

  for (let i = 0; i < 46; i++) {
    const dark = rng.chance(0.65);
    wrappedBlob(
      ctx,
      S,
      rng.range(0, S),
      rng.range(0, S),
      rng.range(12, 70),
      dark ? `rgba(25,12,40,${rng.range(0.05, 0.14)})` : `rgba(255,245,255,${rng.range(0.03, 0.08)})`,
    );
  }

  // water streaks running down
  for (let i = 0; i < 14; i++) {
    const x = rng.range(0, S);
    const w = rng.range(2, 7);
    const len = rng.range(30, 160);
    const y = rng.range(0, S);
    const g = ctx.createLinearGradient(0, y, 0, y + len);
    g.addColorStop(0, 'rgba(20,10,30,0.16)');
    g.addColorStop(1, 'rgba(20,10,30,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, len);

    if (y + len > S) {
      ctx.fillRect(x, y - S, w, len);
    }
  }

  for (let i = 0; i < 1400; i++) {
    ctx.fillStyle = `rgba(15,6,25,${rng.range(0.08, 0.35)})`;
    const s = rng.chance(0.85) ? 1 : 2;
    ctx.fillRect(rng.int(0, S - 1), rng.int(0, S - 1), s, s);
  }

  // cracks
  ctx.lineCap = 'round';

  for (let i = 0; i < 5; i++) {
    let x = rng.range(0, S);
    let y = rng.range(0, S);
    ctx.strokeStyle = `rgba(12,4,20,${rng.range(0.35, 0.65)})`;
    ctx.lineWidth = rng.range(0.8, 1.8);
    ctx.beginPath();
    ctx.moveTo(x, y);
    const n = rng.int(4, 10);
    for (let k = 0; k < n; k++) {
      x += rng.range(-16, 16);
      y += rng.range(-16, 16);
      ctx.lineTo(x, y);

      if (rng.chance(0.25)) {
        ctx.moveTo(x, y);
      }
    }

    ctx.stroke();
  }

  // grime speckle clusters
  for (let i = 0; i < 18; i++) {
    const cx = rng.range(0, S);
    const cy = rng.range(0, S);
    for (let k = 0; k < 40; k++) {
      ctx.fillStyle = `rgba(14,6,22,${rng.range(0.2, 0.5)})`;
      ctx.fillRect(cx + rng.range(-14, 14), cy + rng.range(-14, 14), rng.int(1, 3), rng.int(1, 3));
    }
  }

  if (seams) {
    ctx.fillStyle = 'rgba(20,8,32,0.45)';
    ctx.fillRect(0, 0, S, 2);
    ctx.fillRect(0, 0, 2, S);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fillRect(0, 2, S, 1);
    ctx.fillRect(2, 0, 1, S);
  }

  addNoise(ctx, S, S, rng, 16);
  return toTexture(c, { repeat: true });
}

export function asphaltTexture(seed: number): CanvasTexture {
  const S = 256;
  const { c, ctx } = makeCanvas(S, S);
  const rng = new Rng(seed);
  ctx.fillStyle = PALETTE.asphalt;
  ctx.fillRect(0, 0, S, S);

  for (let i = 0; i < 30; i++) {
    wrappedBlob(ctx, S, rng.range(0, S), rng.range(0, S), rng.range(20, 80), `rgba(10,4,18,${rng.range(0.08, 0.2)})`);
  }

  for (let i = 0; i < 6; i++) {
    wrappedBlob(ctx, S, rng.range(0, S), rng.range(0, S), rng.range(10, 30), 'rgba(120,80,170,0.10)');
  }

  for (let i = 0; i < 3000; i++) {
    const v = rng.chance(0.5);
    ctx.fillStyle = v ? `rgba(160,150,180,${rng.range(0.05, 0.18)})` : `rgba(0,0,0,${rng.range(0.1, 0.3)})`;
    ctx.fillRect(rng.int(0, S - 1), rng.int(0, S - 1), 1, 1);
  }

  // cracks
  ctx.strokeStyle = 'rgba(8,3,14,0.55)';
  ctx.lineWidth = 1;

  for (let i = 0; i < 4; i++) {
    let x = rng.range(0, S);
    let y = rng.range(0, S);
    ctx.beginPath();
    ctx.moveTo(x, y);

    for (let k = 0; k < 8; k++) {
      x += rng.range(-14, 14);
      y += rng.range(-14, 14);
      ctx.lineTo(x, y);
    }

    ctx.stroke();
  }

  addNoise(ctx, S, S, rng, 10);
  return toTexture(c, { repeat: true });
}

export function sidewalkTexture(seed: number): CanvasTexture {
  const S = 256;
  const { c, ctx } = makeCanvas(S, S);
  const rng = new Rng(seed);
  ctx.fillStyle = PALETTE.sidewalk;
  ctx.fillRect(0, 0, S, S);

  for (let i = 0; i < 20; i++) {
    wrappedBlob(ctx, S, rng.range(0, S), rng.range(0, S), rng.range(15, 50), `rgba(20,10,35,${rng.range(0.06, 0.15)})`);
  }

  ctx.fillStyle = 'rgba(15,6,25,0.5)';

  for (let i = 0; i < 4; i++) {
    ctx.fillRect(i * 64, 0, 2, S);
    ctx.fillRect(0, i * 64, S, 2);
  }

  addNoise(ctx, S, S, rng, 14);
  return toTexture(c, { repeat: true });
}

export function grassTexture(seed: number): CanvasTexture {
  const S = 256;
  const { c, ctx } = makeCanvas(S, S);
  const rng = new Rng(seed);
  ctx.fillStyle = '#23301f';
  ctx.fillRect(0, 0, S, S);

  for (let i = 0; i < 30; i++) {
    wrappedBlob(
      ctx,
      S,
      rng.range(0, S),
      rng.range(0, S),
      rng.range(15, 60),
      `rgba(${rng.chance(0.5) ? '60,20,80' : '10,20,5'},0.18)`,
    );
  }

  for (let i = 0; i < 2500; i++) {
    ctx.fillStyle = rng.chance(0.5) ? 'rgba(90,120,60,0.25)' : 'rgba(5,10,5,0.35)';
    ctx.fillRect(rng.int(0, S - 1), rng.int(0, S - 1), 1, rng.int(1, 3));
  }

  return toTexture(c, { repeat: true });
}

export function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * k);
  const g = Math.round(((n >> 8) & 255) * k);
  const b = Math.round((n & 255) * k);
  return `rgb(${r},${g},${b})`;
}

let radialGlow: CanvasTexture | null = null;

/** White radial falloff used by additive glow decals and light pools. Built once and shared. */
export function radialGlowTexture(): CanvasTexture {
  return (radialGlow ??= buildRadialGlow());
}

function buildRadialGlow(): CanvasTexture {
  const S = 128;
  const { c, ctx } = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5) / S - 0.5;
      const dy = (y + 0.5) / S - 0.5;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 2);
      const a = Math.pow(1 - r, 2.2);
      const i = (y * S + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }

  ctx.putImageData(img, 0, 0);
  return toTexture(c, { srgb: false });
}

/** Irregular slime puddle (white; tinted by vertex color). */
export function puddleTexture(seed: number): CanvasTexture {
  const S = 256;
  const { c, ctx } = makeCanvas(S, S);
  const rng = new Rng(seed);
  ctx.fillStyle = 'rgba(255,255,255,1)';

  for (let i = 0; i < 9; i++) {
    const a = rng.range(0, TAU);
    const d = rng.range(0, 50);
    ctx.beginPath();
    ctx.arc(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, rng.range(28, 60), 0, TAU);
    ctx.fill();
  }

  for (let i = 0; i < 16; i++) {
    ctx.beginPath();
    ctx.arc(rng.range(30, 226), rng.range(30, 226), rng.range(4, 12), 0, TAU);
    ctx.fill();
  }

  return toTexture(c, { srgb: false });
}

/** Classic sheet ghost with glow and dark eyes. */
export function ghostTexture(seed: number): CanvasTexture {
  const S = 256;
  const { c, ctx } = makeCanvas(S, S);
  const rng = new Rng(seed);
  const cx = 128;
  const top = 50;
  const w = 108;
  const bottom = 210;
  ctx.save();
  ctx.shadowColor = 'rgba(140,255,60,0.95)';
  ctx.shadowBlur = 34;
  const g = ctx.createRadialGradient(cx, 105, 6, cx, 120, 120);
  g.addColorStop(0, 'rgba(250,255,240,0.98)');
  g.addColorStop(0.45, 'rgba(200,255,150,0.82)');
  g.addColorStop(1, 'rgba(110,255,40,0.15)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(cx - w / 2, 110);
  ctx.arc(cx, top + w / 2, w / 2, Math.PI, 0);
  ctx.lineTo(cx + w / 2 + 6, bottom - 20);
  const lobes = 4;
  for (let i = 0; i < lobes; i++) {
    const x0 = cx + w / 2 + 6 - ((i + 0.5) * (w + 12)) / lobes;
    const x1 = cx + w / 2 + 6 - ((i + 1) * (w + 12)) / lobes;
    const dip = rng.range(-6, 18);
    ctx.quadraticCurveTo(x0, bottom + dip, x1, bottom - 20 + rng.range(-4, 4));
  }

  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = PALETTE.ink;
  ctx.beginPath();
  ctx.ellipse(cx - 20, 100, 11, 16, -0.1, 0, TAU);
  ctx.ellipse(cx + 20, 100, 11, 16, 0.1, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx, 138, 9, 13, 0, 0, TAU);
  ctx.fill();
  return toTexture(c);
}

export function puffTexture(): CanvasTexture {
  const S = 128;
  const { c, ctx } = makeCanvas(S, S);
  const rng = new Rng(77);
  for (let i = 0; i < 7; i++) {
    const x = 64 + rng.range(-18, 18);
    const y = 64 + rng.range(-18, 18);
    const r = rng.range(20, 34);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }

  return toTexture(c);
}

/** Diagonal hazard stripes. */
export function hazardTexture(a: string, b: string): CanvasTexture {
  const S = 128;
  const { c, ctx } = makeCanvas(S, S);
  ctx.fillStyle = a;
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = b;

  for (let i = -S; i < S * 2; i += 32) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 16, 0);
    ctx.lineTo(i + 16 - S, S);
    ctx.lineTo(i - S, S);
    ctx.closePath();
    ctx.fill();
  }

  return toTexture(c, { repeat: true });
}
