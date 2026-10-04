import {
  AdditiveBlending,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RingGeometry,
  Sprite,
  SpriteMaterial,
  type Vector3,
} from 'three';

import { fxDecal, FX_LAYER } from '@/render/layers';
import { withCutaway } from '@/render/materials';
import { radialGlowTexture } from '@/render/textures';

/**
 * Highlight appearance: a ground ring and glow plus a sprite halo around the item. Sizes and offsets are in meters;
 * pulse rate is in radians per second.
 */
const LOOK = {
  color: '#ffe27a',
  ring: [0.42, 0.52] as [number, number],
  glow: 1.6,
  halo: 0.9,
  breathe: 0.18,
  rate: 4.5,
  lift: 0.04,
  alpha: 0.85,
};

export class Highlight {
  readonly root = new Group();
  private readonly ground = new Group();
  private readonly halo: Sprite;
  private readonly mats: (MeshBasicMaterial | SpriteMaterial)[];
  private readonly geos: (RingGeometry | PlaneGeometry)[];
  private t = 0;

  constructor(color = LOOK.color) {
    const c = new Color(color);
    const add = {
      color: c,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    } as const;
    const ringMat = withCutaway(new MeshBasicMaterial({ ...add, opacity: LOOK.alpha }));
    const glowMat = withCutaway(new MeshBasicMaterial({ ...add, map: radialGlowTexture(), opacity: LOOK.alpha * 0.6 }));
    const haloMat = new SpriteMaterial({ ...add, map: radialGlowTexture(), opacity: LOOK.alpha * 0.7 });
    const ring = fxDecal(new Mesh(new RingGeometry(LOOK.ring[0], LOOK.ring[1], 32), ringMat));
    const glow = fxDecal(new Mesh(new PlaneGeometry(LOOK.glow, LOOK.glow), glowMat));
    for (const m of [ring, glow]) {
      m.rotation.x = -Math.PI / 2;
      m.position.y = LOOK.lift;
      this.ground.add(m);
    }

    this.halo = new Sprite(haloMat);
    this.halo.layers.set(FX_LAYER);
    this.halo.scale.setScalar(LOOK.halo);
    this.mats = [ringMat, glowMat, haloMat];
    this.geos = [ring.geometry, glow.geometry];
    this.root.add(this.ground, this.halo);
  }

  /**
   * Position the halo at the item and the ground marker at its resting or landing point. Update whenever either
   * position changes.
   */
  place(item: Vector3, ground: Vector3): void {
    this.ground.position.copy(ground);
    this.halo.position.copy(item);
  }

  update(dt: number): void {
    this.t += dt;
    const k = 1 + Math.sin(this.t * LOOK.rate) * LOOK.breathe;
    this.ground.scale.set(k, 1, k);
    this.halo.scale.setScalar(LOOK.halo * k);
  }

  dispose(): void {
    this.root.removeFromParent();

    for (const m of this.mats) {
      m.dispose();
    }

    for (const g of this.geos) {
      g.dispose();
    }
  }
}
