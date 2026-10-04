import type { Object3D } from 'three';

/**
 * Both cameras render effects on this layer. The normal prepass in post/scene-outline-pass.ts excludes it to prevent
 * outlines on glows, sprites, and debug lines.
 */
export const FX_LAYER = 1;

/** Transparent objects composited over the sky by post/ghost-pass.ts. */
export const GHOST_LAYER = 2;

/** Place a decal on the FX layer and render it after its underlying surface. Return the same object. */
export function fxDecal<T extends Object3D>(o: T): T {
  o.layers.set(FX_LAYER);
  o.renderOrder = 2;
  return o;
}
