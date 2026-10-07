import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Points,
  PointsMaterial,
  Vector3,
} from 'three';

import { FX_LAYER } from '@/render/layers';
import { withCutaway } from '@/render/materials';
import { radialGlowTexture } from '@/render/textures';

/**
 * Glowing trajectory markers rendered as one point cloud. `size` is in screen
 * pixels, `march` is pulses per second, and `fade` is the fade-out duration in
 * seconds.
 */
const LOOK = {
  color: '#ffe27a',
  dots: 34,
  size: 26,
  march: 1.4,
  dim: 0.5,
  fade: 1.2,
};

const _p = new Vector3();

export class ArcPath {
  readonly root: Points;
  private readonly geo = new BufferGeometry();
  private readonly mat: PointsMaterial;
  private readonly base = new Color(LOOK.color);
  private t = 0;
  /** Elapsed fade-out time in seconds, or -1 before fading starts. */
  private fading = -1;

  constructor() {
    const n = LOOK.dots;
    this.geo.setAttribute(
      'position',
      new Float32BufferAttribute(new Float32Array(n * 3), 3),
    );
    this.geo.setAttribute(
      'color',
      new Float32BufferAttribute(new Float32Array(n * 3), 3),
    );
    this.mat = withCutaway(
      new PointsMaterial({
        map: radialGlowTexture(),
        size: LOOK.size,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.root = new Points(this.geo, this.mat);
    this.root.layers.set(FX_LAYER);
    this.root.frustumCulled = false;
  }

  /**
   * Sample the curve at evenly spaced parameter values from 0 to 1. The
   * callback writes each position into `out`.
   */
  set(at: (u: number, out: Vector3) => Vector3): void {
    const pos = this.geo.getAttribute('position') as Float32BufferAttribute;
    const n = LOOK.dots;
    for (let i = 0; i < n; i++) {
      at(i / (n - 1), _p);
      pos.setXYZ(i, _p.x, _p.y, _p.z);
    }

    pos.needsUpdate = true;
  }

  /** Start fading the markers. update() returns false when the fade completes. */
  fadeOut(): void {
    if (this.fading < 0) {
      this.fading = 0;
    }
  }

  /**
   * Animate the markers and return whether they are still visible. Dispose
   * after this returns false.
   */
  update(dt: number): boolean {
    this.t += dt;
    let k = 1;
    if (this.fading >= 0) {
      this.fading += dt;
      k = Math.max(0, 1 - this.fading / LOOK.fade);
    }

    const col = this.geo.getAttribute('color') as Float32BufferAttribute;
    const n = LOOK.dots;
    for (let i = 0; i < n; i++) {
      // Move the brightness peak from the start of the curve toward the landing point.
      const phase = (i / n - this.t * LOOK.march) % 1;
      const b =
        (LOOK.dim +
          (1 - LOOK.dim) *
            Math.max(0, 1 - Math.abs(phase < 0 ? phase + 1 : phase) * 4)) *
        k;
      col.setXYZ(i, this.base.r * b, this.base.g * b, this.base.b * b);
    }

    col.needsUpdate = true;
    return k > 0;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}
