import type { CanvasTexture } from 'three';

import { TAU } from '@/engine/core/math';
import { Rng } from '@/engine/core/rng';

import { PALETTE } from './palette';
import { drawSkull, drawSlimeTop, FONT, fitFont } from './signs';
import { addNoise, makeCanvas, toTexture, type Ctx } from './textures';

/** Truck body paint, behind and between the livery art. */
const BODY = '#1c0d2c';
/** Reduced slime intensity for emissive maps prevents overexposed highlights. */
const SLIME_GLOW = '#4bb80c';
/** Off-white lettering and number roundel. */
const LETTERING = '#f4ffe8';

export interface Livery {
  side: { map: CanvasTexture; emissive: CanvasTexture };
  hood: { map: CanvasTexture; emissive: CanvasTexture };
  cab: { map: CanvasTexture; emissive: CanvasTexture };
}

function splats(ctxs: Ctx[], w: number, h: number, rng: Rng, n: number, emissive?: Ctx): void {
  for (let i = 0; i < n; i++) {
    const x = rng.range(0, w);
    const y = rng.range(h * 0.3, h);
    const r = rng.range(2, 9);
    for (const c of ctxs) {
      c.fillStyle = c === emissive ? SLIME_GLOW : PALETTE.slime;
      c.beginPath();
      c.arc(x, y, r, 0, TAU);
      c.fill();
    }
  }
}

export interface LiveryText {
  /** Big brush lettering along the side. */
  name: string;
  /** Number in the roundel. */
  number: string;
}

const cache = new Map<string, Livery>();

/** Return cached color and emissive textures for the truck's side, hood, and cab, keyed by name and number. */
export function truckLivery(text: LiveryText = { name: 'ROADIE', number: '30' }): Livery {
  const key = `${text.name}|${text.number}`;
  const hit = cache.get(key);
  if (hit) {
    return hit;
  }

  const rng = new Rng(30);

  // Match the side texture aspect ratio to a 5.3 by 0.9 world-unit panel.
  const W = 1024;
  const H = 176;
  const a = makeCanvas(W, H);
  const e = makeCanvas(W, H);
  a.ctx.fillStyle = BODY;
  a.ctx.fillRect(0, 0, W, H);
  const g = a.ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(120,50,200,0.0)');
  g.addColorStop(1, 'rgba(120,50,200,0.35)');
  a.ctx.fillStyle = g;
  a.ctx.fillRect(0, 0, W, H);
  e.ctx.fillStyle = '#000';
  e.ctx.fillRect(0, 0, W, H);
  // Draw wider ink shapes before slime so each drip retains a border.
  const blobs: [number, number, number, number][] = [];
  for (let i = 0; i < 26; i++) {
    const y = rng.range(0, H * 0.75);
    blobs.push([rng.range(0, W), y, rng.range(14, 46), Math.max(0, H - y - rng.range(0, 40))]);
  }

  for (const [pass, c] of [
    [0, a.ctx],
    [1, a.ctx],
    [1, e.ctx],
  ] as const) {
    c.fillStyle = pass === 0 ? PALETTE.ink : c === e.ctx ? SLIME_GLOW : PALETTE.slime;

    for (const [x, y, r, len] of blobs) {
      c.beginPath();
      c.arc(x, y, r + (pass === 0 ? 4 : 0), 0, TAU);
      c.fill();
      c.fillRect(x - r * 0.35 - (pass === 0 ? 4 : 0), y, r * 0.7 + (pass === 0 ? 8 : 0), len);
    }
  }

  a.ctx.fillStyle = PALETTE.slimeHot;

  for (const [x, y, r] of blobs) {
    a.ctx.beginPath();
    a.ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.25, 0, TAU);
    a.ctx.fill();
  }

  splats([a.ctx, e.ctx], W, H, rng, 60, e.ctx);
  drawSlimeTop([a.ctx, e.ctx], W, 30, rng, 1.5, e.ctx);
  // name
  a.ctx.save();
  a.ctx.translate(W * 0.42, H * 0.62);
  a.ctx.rotate(-0.06);
  a.ctx.textAlign = 'center';
  a.ctx.textBaseline = 'middle';
  fitFont(a.ctx, text.name, FONT.brush, W * 0.56, H * 0.7);
  a.ctx.lineJoin = 'round';
  a.ctx.lineWidth = 16;
  a.ctx.strokeStyle = PALETTE.ink;
  a.ctx.strokeText(text.name, 0, 0);
  a.ctx.fillStyle = LETTERING;
  a.ctx.fillText(text.name, 0, 0);
  a.ctx.restore();
  // number roundel
  const rx = W * 0.86;
  const ry = H * 0.6;
  a.ctx.fillStyle = PALETTE.ink;
  a.ctx.beginPath();
  a.ctx.arc(rx, ry, H * 0.36, 0, TAU);
  a.ctx.fill();
  a.ctx.fillStyle = LETTERING;
  a.ctx.beginPath();
  a.ctx.arc(rx, ry, H * 0.31, 0, TAU);
  a.ctx.fill();
  a.ctx.fillStyle = PALETTE.ink;
  a.ctx.textAlign = 'center';
  a.ctx.textBaseline = 'middle';
  fitFont(a.ctx, text.number, FONT.label, H * 0.5, H * 0.46);
  a.ctx.fillText(text.number, rx, ry + 2);
  addNoise(a.ctx, W, H, rng, 10);
  const side = { map: toTexture(a.c), emissive: toTexture(e.c) };

  // hood (top): skull in slime
  const S = 256;
  const ha = makeCanvas(S, S);
  const he = makeCanvas(S, S);
  ha.ctx.fillStyle = BODY;
  ha.ctx.fillRect(0, 0, S, S);
  he.ctx.fillStyle = '#000';
  he.ctx.fillRect(0, 0, S, S);
  splats([ha.ctx, he.ctx], S, S, rng, 26, he.ctx);

  for (const [c, em] of [
    [ha.ctx, false],
    [he.ctx, true],
  ] as const) {
    c.save();
    c.shadowColor = PALETTE.slime;
    c.shadowBlur = em ? 12 : 0;
    drawSkull(c, S / 2, S / 2, S * 0.62, em ? '#5cd60f' : PALETTE.slime, em ? '#000' : BODY);
    c.restore();
  }

  addNoise(ha.ctx, S, S, rng, 10);
  const hood = { map: toTexture(ha.c), emissive: toTexture(he.c) };

  // cab sides
  const ca = makeCanvas(256, 128);
  const ce = makeCanvas(256, 128);
  ca.ctx.fillStyle = BODY;
  ca.ctx.fillRect(0, 0, 256, 128);
  ce.ctx.fillStyle = '#000';
  ce.ctx.fillRect(0, 0, 256, 128);
  drawSlimeTop([ca.ctx, ce.ctx], 256, 22, rng, 0.9, ce.ctx);
  splats([ca.ctx, ce.ctx], 256, 128, rng, 40, ce.ctx);
  addNoise(ca.ctx, 256, 128, rng, 10);
  const cab = { map: toTexture(ca.c), emissive: toTexture(ce.c) };

  const out = { side, hood, cab };
  cache.set(key, out);
  return out;
}
