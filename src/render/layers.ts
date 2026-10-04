import type { Object3D } from 'three';

/**
 * Glows, sprites and debug lines: both cameras draw this layer, but the ink-outline normal prepass
 * (post/scene-outline-pass.ts) leaves it out, so effects never get outlined.
 */
export const FX_LAYER = 1;

/** Objects drawn see-through, over the finished sky, instead of in the main scene pass (post/ghost-pass.ts). */
export const GHOST_LAYER = 2;

/** A decal lying on the world: on the FX layer (no ink outline), drawn after what it lies on. */
export function fxDecal<T extends Object3D>(o: T): T {
  o.layers.set(FX_LAYER);
  o.renderOrder = 2;
  return o;
}
