import { type CanvasTexture, Group, Sprite, SpriteMaterial, Vector3 } from 'three';

import { easeOutBack, lerp } from '@/engine/core/math';
import { withCurve } from '@/render/curvature';
import { FX_LAYER } from '@/render/layers';
import { fitFont, FONT } from '@/render/signs';
import { makeCanvas, toTexture } from '@/render/textures';

/** A honk's word: this wide at full size (m), popping up over POP (s), gone after LIFE (s), rising RISE (m) as it goes. */
const WIDTH = 2.4;
const POP = 0.2;
const LIFE = 1;
const RISE = 0.5;
/** It starts to fade this far into its life (share). */
const FADE_FROM = 0.55;
/** A fuming driver's honk is this much bigger, and lasts this much longer. */
const ANGRY_SIZE = 1.35;
const ANGRY_LIFE = 1.5;
/** Pops at once; the oldest is reused. */
const POOL = 6;
/** The word's canvas, and its colours: a warm white with a dark outline, like the HUD's comic lettering. */
const TEX_W = 256;
const TEX_H = 128;
const FILL = '#fff3c4';
const INK = '#1a0830';
const TILT = -0.12;
/**
 * The word fills at most this share of the canvas's width (room for the outline and the tilt), and this share of its
 * height.
 */
const FIT_W = 0.8;
const FIT_H = 0.62;

interface Pop {
  s: Sprite;
  m: SpriteMaterial;
  /** Seconds since it popped, or -1 while unused. */
  t: number;
  at: Vector3;
  /** How big it gets (m) and how long it lasts (s). */
  width: number;
  life: number;
}

let tex: CanvasTexture | null = null;

/** "HONK!" lettered once, on first use (the comic font has loaded by then). */
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

/** A driver leaning on the horn: the word pops up over the roof and floats off. */
export class Honks {
  readonly root = new Group();
  private readonly pops: Pop[] = [];
  private next = 0;

  /** Pop one up with its foot at `at` (over a roof); `anger` (0..1) makes it bigger and longer. */
  pop(at: Vector3, anger = 0): void {
    if (this.pops.length < POOL) {
      const m = withCurve(
        new SpriteMaterial({ map: honkTexture(), transparent: true, depthWrite: false, toneMapped: false }),
      );
      const s = new Sprite(m);
      s.center.set(0.5, 0);
      s.layers.set(FX_LAYER);
      s.renderOrder = 6;
      this.root.add(s);
      this.pops.push({ s, m, t: -1, at: new Vector3(), width: WIDTH, life: LIFE });
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
