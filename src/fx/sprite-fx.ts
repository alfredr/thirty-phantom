import { AdditiveBlending, type Color, Group, NormalBlending, Sprite, SpriteMaterial, type Texture, Vector3 } from 'three';
import { lerp } from '../core/math';
import { withCurve } from '../render/curvature';
import { FX_LAYER } from '../render/layers';
import { ghostTexture, puffTexture } from '../render/textures';

const _vel = new Vector3();

/** puff: glowing (additive) smoke; smoke: plain, dark smoke drawn over what's behind it; ghost: a wisp. */
export type SpriteKind = 'puff' | 'smoke' | 'ghost';

interface Puff {
  s: Sprite;
  vel: Vector3;
  life: number;
  max: number;
  size0: number;
  size1: number;
  alpha: number;
}

/** Pooled billboards: spectral exhaust, tailpipe smoke, ghost wisps rising out of transformations. */
export class SpriteFx {
  readonly root = new Group();
  private readonly pool: Puff[] = [];
  private cursor = 0;
  private readonly puffTex: Texture = puffTexture();
  private readonly ghostTex: Texture = ghostTexture(5);

  constructor(max = 96) {
    for (let i = 0; i < max; i++) {
      const s = new Sprite(withCurve(new SpriteMaterial({ map: this.puffTex, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false })));
      s.visible = false;
      s.layers.set(FX_LAYER);
      s.renderOrder = 5;
      this.root.add(s);
      this.pool.push({ s, vel: new Vector3(), life: 0, max: 1, size0: 1, size1: 1, alpha: 1 });
    }
  }

  /**
   * `n` sprites from `at`, flung up to spread/2 sideways and between up[0] and up[1] upward.
   * `life` is fixed, or a (min, max) range drawn per sprite.
   */
  spray(at: Vector3, n: number, spread: number, up: readonly [number, number], color: Color, size0: number, size1: number, life: number | readonly [number, number], kind: SpriteKind, alpha: number): void {
    for (let i = 0; i < n; i++) {
      _vel.set((Math.random() - 0.5) * spread, up[0] + Math.random() * (up[1] - up[0]), (Math.random() - 0.5) * spread);
      this.emit(at, _vel, color, size0, size1, typeof life === 'number' ? life : life[0] + Math.random() * (life[1] - life[0]), kind, alpha);
    }
  }

  emit(pos: Vector3, vel: Vector3, color: Color, size0: number, size1: number, life: number, kind: SpriteKind = 'puff', alpha = 1): void {
    const p = this.pool[this.cursor] as Puff;
    this.cursor = (this.cursor + 1) % this.pool.length;
    const m = p.s.material;
    m.map = kind === 'ghost' ? this.ghostTex : this.puffTex;
    m.blending = kind === 'puff' ? AdditiveBlending : NormalBlending;
    m.color.copy(color);
    p.s.position.copy(pos);
    p.vel.copy(vel);
    p.life = life;
    p.max = life;
    p.size0 = size0;
    p.size1 = size1;
    p.alpha = alpha;
    p.s.visible = true;
  }

  update(dt: number): void {
    for (const p of this.pool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.s.visible = false;
        continue;
      }
      const t = 1 - p.life / p.max;
      p.s.position.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(1 - dt * 0.8);
      p.s.scale.setScalar(lerp(p.size0, p.size1, t));
      p.s.material.opacity = p.alpha * Math.min(1, t * 6) * (1 - t);
    }
  }
}
