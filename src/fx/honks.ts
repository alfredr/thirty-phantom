import {
  type CanvasTexture,
  Group,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';

import { easeOutBack, lerp } from '@/engine/core/math';
import { withCurve } from '@/render/curvature';
import { FX_LAYER } from '@/render/layers';
import { fitFont, FONT } from '@/render/signs';
import { makeCanvas, toTexture } from '@/render/textures';

/**
 * Honk label width and rise distance in meters, with entrance and lifetime
 * durations in seconds.
 */
const WIDTH = 2.4;
const POP = 0.2;
const LIFE = 1;
const RISE = 0.5;
/** Fraction of the label's lifetime before fading begins. */
const FADE_FROM = 0.55;
/** Size and lifetime multipliers at maximum driver anger. */
const ANGRY_SIZE = 1.35;
const ANGRY_LIFE = 1.5;
/** Maximum concurrent labels. Reuse slots in creation order. */
const POOL = 6;
/** Canvas dimensions in pixels and colors for the outlined honk label. */
const TEX_W = 256;
const TEX_H = 128;
const FILL = '#fff3c4';
const INK = '#1a0830';
const TILT = -0.12;
/**
 * Maximum text width and height as fractions of the canvas, leaving room for
 * outline and rotation.
 */
const FIT_W = 0.8;
const FIT_H = 0.62;

interface Pop {
  s: Sprite;
  m: SpriteMaterial;
  /** Elapsed animation time in seconds, or -1 for an inactive label. */
  t: number;
  at: Vector3;
  /** Final width in meters and total lifetime in seconds. */
  width: number;
  life: number;
}

let tex: CanvasTexture | null = null;

/** Create and cache the honk texture on first use, after fonts have loaded. */
function honkTexture(): CanvasTexture {
  if (tex) {
    return tex;
  }

  const { c, ctx } = makeCanvas(TEX_W, TEX_H);
  ctx.translate(TEX_W / 2, TEX_H / 2);
  ctx.rotate(TILT);
  fitFont(ctx, 'HONK!', FONT.brush, TEX_W * FIT_W, TEX_H * FIT_H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 14;
  ctx.strokeStyle = INK;
  ctx.strokeText('HONK!', 0, 4);
  ctx.fillStyle = FILL;
  ctx.fillText('HONK!', 0, 4);
  return (tex = toTexture(c));
}

/** Display animated honk labels above vehicles. */
export class Honks {
  readonly root = new Group();
  private readonly pops: Pop[] = [];
  private next = 0;

  /**
   * Show a label anchored at `at`. Driver anger from 0 to 1 increases its size
   * and lifetime.
   */
  pop(at: Vector3, anger = 0): void {
    if (this.pops.length < POOL) {
      const m = withCurve(
        new SpriteMaterial({
          map: honkTexture(),
          transparent: true,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      const s = new Sprite(m);
      s.center.set(0.5, 0);
      s.layers.set(FX_LAYER);
      s.renderOrder = 6;
      this.root.add(s);
      this.pops.push({
        s,
        m,
        t: -1,
        at: new Vector3(),
        width: WIDTH,
        life: LIFE,
      });
    }

    const p = this.pops[this.next % this.pops.length] as Pop;
    this.next++;
    p.t = 0;
    p.at.copy(at);
    p.width = WIDTH * lerp(1, ANGRY_SIZE, anger);
    p.life = LIFE * lerp(1, ANGRY_LIFE, anger);
    p.s.visible = true;
    this.place(p);
  }

  update(dt: number): void {
    for (const p of this.pops) {
      if (p.t < 0) {
        continue;
      }

      p.t += dt;

      if (p.t >= p.life) {
        p.t = -1;
        p.s.visible = false;
        continue;
      }

      this.place(p);
    }
  }

  private place(p: Pop): void {
    const k = p.t / p.life;
    const size = p.width * (p.t < POP ? easeOutBack(p.t / POP) : 1);
    p.s.scale.set(size, size * (TEX_H / TEX_W), 1);
    p.s.position.set(p.at.x, p.at.y + RISE * k, p.at.z);
    p.m.opacity = k < FADE_FROM ? 1 : 1 - (k - FADE_FROM) / (1 - FADE_FROM);
  }
}
