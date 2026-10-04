import type { V3 } from '@/engine/core/math';
import { PALETTE } from '@/render/palette';
import { box, build, cone, cylinder, group, model, NO_CAST, pivot, SIDES, solid, sphere } from './part';
import { FACE_INK } from './person';
import { characterRig, limb, type CharacterRig } from './rig';

export const CODY_DAY = {
  hoodie: PALETTE.hoodie,
  jeans: '#2b2f48',
  skin: '#e0b08c',
  hair: '#5a3a24',
  /** Top of the legs (the hip pivot). */
  hip: 0.9,
  leg: [0.26, 0.86, 0.3] as V3,
  /** Leg centers either side of the middle. */
  stance: 0.16,
  torso: [0.74, 0.76, 0.44] as V3,
  arm: [0.21, 0.7, 0.24] as V3,
  head: [0.46, 0.5, 0.44] as V3,
};

export type CodyDayParams = typeof CODY_DAY;

/** Daytime Cody: green hoodie, jeans, mustache. Feet at y=0, faces +Z. */
export function codyDay(params: Partial<CodyDayParams> = {}) {
  const p = { ...CODY_DAY, ...params };
  const torso = box(...p.torso).on(p.hip - 0.02);
  const head = box(...p.head).on(torso.top + 0.02);
  return model(
    {
      hoodie: { color: p.hoodie, roughness: 0.85 },
      hoodieDark: { color: '#1f6a1c', roughness: 0.9 },
      jeans: { color: p.jeans, roughness: 0.9 },
      shoe: { color: '#d8d0e4', roughness: 0.7 },
      skin: { color: p.skin, roughness: 0.8 },
      hair: { color: p.hair, roughness: 0.9 },
      ink: FACE_INK,
    },
    [
      group({ name: 'body' }, [
        ...SIDES.map((s) => {
          const leg = box(...p.leg).x(s * p.stance).under(p.hip);
          return limb(s < 0 ? 'legL' : 'legR', leg, 'jeans', [solid(leg.sized(0.3, 0.14, 0.44).on(0).move(0, 0, 0.06), 'shoe')]);
        }),
        solid(torso, 'hoodie'),
        solid(box(0.46, 0.2, 0.06).onFace(torso, '+z', 0.02).y(torso.bottom + 0.2), 'hoodieDark'),
        solid(box(0.6, 0.36, 0.22).y(torso.top + 0.08).onFace(torso, '-z', -0.02), 'hoodie'),
        ...SIDES.map((s) => solid(box(0.04, 0.2, 0.04).x(s * 0.1).y(torso.top - 0.16).onFace(torso, '+z', 0.01), 'shoe', NO_CAST)),
        ...SIDES.map((s) => {
          const arm = box(...p.arm).under(torso.top - 0.04).outside(torso, s < 0 ? '-x' : '+x');
          return limb(s < 0 ? 'armL' : 'armR', arm, 'hoodie', [solid(arm.sized(0.18, 0.16, 0.2).under(arm.bottom + 0.01), 'skin')]);
        }),
        pivot('head', [0, torso.top, 0], [
          solid(head, 'skin'),
          solid(head.sized(0.5, 0.16, 0.48).onFace(head, '+y', 0.04).move(0, 0, -0.01), 'hair'),
          solid(head.sized(0.5, 0.3, 0.12).onFace(head, '-z', -0.02).y(head.top - 0.12), 'hair'),
          solid(head.sized(0.28, 0.07, 0.05).onFace(head, '+z', 0.01).move(0, -0.1), 'ink', NO_CAST),
          ...SIDES.map((s) => solid(head.sized(0.07, 0.08, 0.03).onFace(head, '+z', 0.005).move(s * 0.11, 0.06), 'ink', NO_CAST)),
        ]),
      ]),
    ],
  );
}

export const CODY_NIGHT = {
  robe: '#1f1330',
  robeDark: '#0b0613',
  mask: '#e6e0d4',
  hip: 0.86,
  leg: [0.22, 0.8, 0.26] as V3,
  stance: 0.14,
  /** Where the robe skirt hangs and sways from. */
  waist: 1.0,
  /** The robe below the waist: a many-sided cone (each edge inks like a fold), radius at its hem and top, the hem's height. */
  skirt: { hem: 0.52, top: 0.36, bottom: 0.1, sides: 9 },
  /** The robe above the waist: radius at the bottom and the shoulders, height, sides. */
  torso: { bottom: 0.36, top: 0.27, height: 0.7, sides: 8 },
  /** Mantle over the shoulders: radius at its hem and at the neck, height, sides, how far its top rises past the torso's. */
  mantle: { hem: 0.5, neck: 0.18, height: 0.4, sides: 7, rise: 0.06 },
  arm: [0.16, 0.62, 0.18] as V3,
  /** Shoulders: how far below the torso's top (under the mantle) the arms hang from, and how far out. */
  shoulder: { drop: 0.22, out: 0.3 },
  /** Bell sleeve round each arm: radius at the shoulder and the cuff, sides, how far the cuff hangs past the arm. */
  sleeve: { top: 0.09, cuff: 0.23, sides: 7, past: 0.1 },
  /** Deep rounded hood: its radii, the dark hollow's half width and height, and how far forward its sides and brim reach. */
  hood: { radii: [0.32, 0.34, 0.31] as V3, hollow: [0.19, 0.25] as [number, number], reach: 0.29 },
  /** The long pale mask: radii, and how far it's rolled (crooked, radians). */
  face: { radii: [0.115, 0.19, 0.05] as V3, roll: 0.06 },
  /** Rags hanging off the hem: [angle round from the front (radians), length]. */
  tatters: [
    [0.3, 0.2],
    [0.9, 0.12],
    [1.7, 0.24],
    [2.4, 0.15],
    [3.0, 0.22],
    [3.7, 0.1],
    [4.3, 0.26],
    [5.1, 0.14],
    [5.8, 0.2],
  ] as [number, number][],
  /** Runs of the hem soaked in slime: angles round from the front (radians). */
  soaked: [0.6, 2.7, 4.6],
};

export type CodyNightParams = typeof CODY_NIGHT;

/**
 * Phantom Cody (after moonrise): a heavy ragged robe with a mantle and bell
 * sleeves, a deep rounded hood, and a long pale mask (crooked, cracked, with
 * drooping teardrop eyes and a stretched mouth); a little slime soaked into the hem.
 */
export function codyNight(params: Partial<CodyNightParams> = {}) {
  const p = { ...CODY_NIGHT, ...params };
  const { skirt, torso, mantle, sleeve, hood, face } = p;
  const torsoTop = p.waist + torso.height;
  const skirtH = p.waist + 0.1 - skirt.bottom;
  const headY = torsoTop + 0.3;
  // the mask's middle, and a point on its curved front `dx, dy` from there (rolled with it)
  const mc: V3 = [0, headY - 0.04, hood.reach - 0.04 - face.radii[2]];
  const onFace = (dx: number, dy: number, out = 0): V3 => {
    const [rx, ry, rz] = face.radii;
    const z = rz * Math.sqrt(Math.max(0, 1 - (dx / rx) ** 2 - (dy / ry) ** 2));
    const c = Math.cos(face.roll);
    const s = Math.sin(face.roll);
    return [mc[0] + dx * c - dy * s, mc[1] + dx * s + dy * c, mc[2] + z + out];
  };
  const hemR = skirt.hem * 0.95;
  return model(
    {
      robe: { color: p.robe, roughness: 1 },
      robeDark: { color: p.robeDark, roughness: 1 },
      inner: { color: '#05020a', roughness: 1 },
      mask: { color: p.mask, roughness: 0.6, emissive: '#b8a8d8', emissiveIntensity: 0.12 },
      eyes: { color: '#c8ff8a', emissive: PALETTE.slime, emissiveIntensity: 1.5 },
      crack: { color: '#2b2330', roughness: 0.8 },
      stain: { color: '#857a6b', roughness: 0.9 },
      bone: { color: '#d9d2e6', roughness: 0.6 },
      trim: { color: PALETTE.slime, emissive: '#59ff00', emissiveIntensity: 1.4, softInk: true },
    },
    [
      group({ name: 'body' }, [
        ...SIDES.map((s) => limb(s < 0 ? 'legL' : 'legR', box(...p.leg).x(s * p.stance).under(p.hip), 'inner')),
        pivot('robe', [0, p.waist, 0], [
          cone(skirt.hem, skirt.top, skirtH, skirt.sides, 'robe', { at: [0, skirt.bottom + skirtH / 2, 0] }),
          ...p.tatters.map(([a, len]) =>
            cone(0, 0.075, len, 4, 'robe', { at: [Math.sin(a) * hemR, skirt.bottom - len / 2 + 0.01, Math.cos(a) * hemR], rot: [0, a, 0] }),
          ),
          ...p.soaked.map((a) =>
            solid(box(0.12, 0.035, 0.02).at(Math.sin(a) * skirt.hem * 0.97, skirt.bottom + 0.02, Math.cos(a) * skirt.hem * 0.97), 'trim', { rot: [0, a, 0], ...NO_CAST }),
          ),
        ]),
        cone(torso.bottom, torso.top, torso.height, torso.sides, 'robe', { at: [0, p.waist + torso.height / 2, 0] }),
        cone(mantle.hem, mantle.neck, mantle.height, mantle.sides, 'robe', { at: [0, torsoTop + mantle.rise - mantle.height / 2, 0] }),
        ...SIDES.map((s) => {
          const arm = box(...p.arm).under(torsoTop - p.shoulder.drop).x(s * p.shoulder.out);
          const h = p.arm[1] + sleeve.past;
          const cuffY = arm.top - h;
          return limb(s < 0 ? 'armL' : 'armR', arm, 'robe', [
            cone(sleeve.cuff, sleeve.top, h, sleeve.sides, 'robe', { at: [arm.center[0], arm.top - h / 2, 0] }),
            cylinder(sleeve.cuff * 0.85, 0.01, sleeve.sides, 'robeDark', { at: [arm.center[0], cuffY - 0.006, 0], ...NO_CAST }),
            solid(box(0.1, 0.14, 0.08).at(arm.center[0], cuffY - 0.02, 0.07), 'bone'),
          ]);
        }),
        pivot('head', [0, torsoTop, 0], [
          // the hood, the dark hollow it opens on, its sides and drooping brim reaching forward round the face
          sphere(hood.radii, [12, 9], 'robe', { at: [0, headY + 0.02, -0.1] }),
          sphere([hood.hollow[0], hood.hollow[1], 0.1], [12, 8], 'inner', { at: [0, headY - 0.02, mc[2] - 0.07] }),
          ...SIDES.map((s) => sphere([0.07, 0.27, 0.16], [8, 8], 'robe', { at: [s * 0.22, headY - 0.04, hood.reach - 0.16], rot: [0, 0, s * 0.08] })),
          sphere([0.25, 0.07, 0.16], [10, 6], 'robe', { at: [0, headY + 0.2, hood.reach - 0.16], rot: [0.2, 0, 0] }),
          // the mask
          sphere(face.radii, [14, 10], 'mask', { at: mc, rot: [0, 0, face.roll] }),
          ...SIDES.map((s) => {
            // drooping teardrop eyes, the points down and out (one droops more)
            const a = s > 0 ? 0.5 : 0.3;
            return group({ cast: false }, [
              sphere([0.028, 0.03, 0.012], [10, 6], 'inner', { at: onFace(s * 0.05, 0.05), rot: [0, 0, face.roll] }),
              cone(0, 0.02, 0.06, 6, 'inner', { at: onFace(s * (0.05 + Math.sin(a) * 0.03), 0.05 - Math.cos(a) * 0.03), rot: [0, 0, face.roll + s * a] }),
              sphere(0.007, [6, 4], 'eyes', { at: onFace(s * 0.05, 0.045, 0.008) }),
            ]);
          }),
          sphere([0.026, 0.062, 0.012], [10, 8], 'inner', { at: onFace(0.012, -0.1), rot: [0, 0, face.roll - 0.17], ...NO_CAST }),
          solid(box(0.008, 0.06, 0.012).at(...onFace(-0.04, 0.13)), 'crack', { rot: [0, 0, 0.4], ...NO_CAST }),
          solid(box(0.007, 0.05, 0.012).at(...onFace(-0.052, 0.085)), 'crack', { rot: [0, 0, -0.3], ...NO_CAST }),
          solid(box(0.016, 0.08, 0.01).at(...onFace(0.074, -0.025)), 'stain', { rot: [0, 0, face.roll], ...NO_CAST }),
        ]),
      ]),
    ],
  );
}

export function buildCodyDay(params: Partial<CodyDayParams> = {}): CharacterRig {
  return characterRig(build(codyDay(params)));
}

export function buildCodyNight(params: Partial<CodyNightParams> = {}): CharacterRig {
  return characterRig(build(codyNight(params)));
}
