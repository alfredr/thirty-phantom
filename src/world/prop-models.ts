import { box, type Model, model, NO_CAST, solid } from '@/actors/models/part';
import type { V3 } from '@/engine/core/math';
import { GLASS, LAMP_GLASS, METAL } from '@/render/materials';

import type { LampColor } from './level-data';

export const LAMP = {
  pole: [0.24, 6, 0.24] as V3,
  head: [0.84, 0.35, 0.84] as V3,
  cap: [1.1, 0.15, 1.1] as V3,
};

/**
 * Build a street lamp with its base at the origin. Include named lit and dead head variants for the caller to select
 * according to the lamp's state.
 */
export function streetLamp(color: LampColor, p = LAMP): Model<'iron' | 'lit' | 'dead'> {
  const pole = box(...p.pole).on(0);
  const head = box(...p.head).on(pole);
  const cap = box(...p.cap).on(head);
  return model(
    {
      iron: METAL,
      lit: { ...LAMP_GLASS[color], roughness: 0.5 },
      dead: GLASS,
    },
    [
      solid(pole, 'iron'),
      solid(cap, 'iron'),
      solid(head, 'lit', { name: 'lit', ...NO_CAST }),
      solid(head, 'dead', { name: 'dead', ...NO_CAST }),
    ],
  );
}

/** Overall height of a lamp. */
export const lampHeight = (p = LAMP): number => p.pole[1] + p.head[1] + p.cap[1];

export const FENCE = {
  /** Panel length along the run (runs are split evenly into panels about this long, stretched to fit). */
  span: 1.4,
  post: [0.12, 1.9, 0.12] as V3,
  finial: 0.22,
  rail: 0.08,
  /** Rail heights (bottoms). */
  rails: [0.5, 1.5],
};

/** Build an iron fence panel centred along local X with its base at Y=0. Add the far-end post when `end` is true. */
export function fencePanel(end: boolean, p = FENCE): Model<'iron'> {
  const post = box(...p.post).on(0);
  const finial = box(p.finial, p.finial, p.finial).on(post);
  const posts = end ? [-p.span / 2, p.span / 2] : [-p.span / 2];
  return model({ iron: METAL }, [
    ...posts.flatMap((x) => [solid(post.x(x), 'iron'), solid(finial.x(x), 'iron')]),
    ...p.rails.map((y) => solid(box(p.span, p.rail, p.rail).on(y), 'iron')),
  ]);
}

/** Overall height of a fence panel. */
export const fenceHeight = (p = FENCE): number => p.post[1] + p.finial;

const STEEL = { color: '#8d8699', roughness: 0.4, metalness: 0.6 };

export const GUARDRAIL = {
  /** Panel length along the run (runs are split evenly into panels about this long, stretched to fit). */
  span: 2,
  post: [0.12, 0.75, 0.12] as V3,
  /** The beam: bottom height, and its height and thickness. */
  beam: { y: 0.38, h: 0.3, t: 0.08 },
};

/**
 * Build a guardrail panel centred along local X, with the beam facing the lane at -Z. Add a far-end post when `end` is
 * true. Callers shear ramp instances to follow the slope while keeping posts upright.
 */
export function guardrailPanel(end: boolean, p = GUARDRAIL): Model<'iron' | 'steel'> {
  const post = box(...p.post).on(0);
  const beam = box(p.span, p.beam.h, p.beam.t).on(p.beam.y).outside(post, '-z');
  const posts = end ? [-p.span / 2, p.span / 2] : [-p.span / 2];
  return model({ iron: METAL, steel: STEEL }, [...posts.map((x) => solid(post.x(x), 'iron')), solid(beam, 'steel')]);
}

/** Overall height of a guardrail panel. */
export const guardrailHeight = (p = GUARDRAIL): number => p.post[1];

export const RAILING = {
  span: 2,
  post: [0.07, 0.9, 0.07] as V3,
  rail: 0.06,
  /** Rail heights (bottoms); the top one caps the posts. */
  rails: [0.42, 0.84],
};

/** Build a wall-top railing panel centred along local X with two rails. Add a far-end post when `end` is true. */
export function railingPanel(end: boolean, p = RAILING): Model<'iron'> {
  const post = box(...p.post).on(0);
  const posts = end ? [-p.span / 2, p.span / 2] : [-p.span / 2];
  return model({ iron: METAL }, [
    ...posts.map((x) => solid(post.x(x), 'iron')),
    ...p.rails.map((y) => solid(box(p.span, p.rail, p.rail).on(y), 'iron')),
  ]);
}

/** Overall height of a railing panel. */
export const railingHeight = (p = RAILING): number => p.post[1];

export const GATE_ARM = {
  /** Cross-section of the bar (m), and its stripes along it. */
  bar: 0.22,
  stripe: 0.5,
  colors: ['#9b3cf0', '#2a1040'] as const,
};

/** Build a striped barrier arm of the given length along +Y, hinged at the origin. The gate rotates it into place. */
export function gateArm(length: number, p = GATE_ARM): Model<'a' | 'b'> {
  const n = Math.max(1, Math.round(length / p.stripe));
  const seg = length / n;
  return model(
    {
      a: { color: p.colors[0], roughness: 0.6, emissive: p.colors[0], emissiveIntensity: 0.25 },
      b: { color: p.colors[1], roughness: 0.7 },
    },
    Array.from({ length: n }, (_, i) => solid(box(p.bar, seg, p.bar).on(i * seg), i % 2 ? 'b' : 'a')),
  );
}
