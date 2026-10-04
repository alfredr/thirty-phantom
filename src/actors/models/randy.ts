import type { Object3D } from 'three';

import type { V3 } from '@/engine/core/math';

import { type Box, box, build, cylinder, group, model, NO_CAST, type Part, pivot, SIDES, solid } from './part';
import { FACE_INK } from './person';
import { type CharacterRig, characterRig, limb } from './rig';

/** Randy Rolsen’s material palette, including his coat lining, hair, brisket, burner phone, and Cody’s badge. */
const RANDY = {
  coat: '#1d1b21',
  lining: '#3b1f4a',
  shirt: '#d8cfc0',
  slacks: '#2c2a30',
  shoes: '#3a2418',
  skin: '#d9a885',
  /** Salt-and-pepper: a mid grey with lighter and darker flecks. */
  grey: '#8a857f',
  salt: '#cfcac4',
  pepper: '#3d3936',
  /** Brisket: kraft butcher paper under it, the smoked crust (bark), and the red smoke ring showing at the sides. */
  paper: '#9c6b45',
  bark: '#2b130b',
  ring: '#7e2a1c',
  phone: '#141018',
  screen: '#7dff5a',
  stick: '#6b4a2a',
  /** Cody's badge: a white card with a blue band and a photo. */
  card: '#eeeaf2',
  band: '#2f5fd0',
};

type Mat =
  | 'coat'
  | 'lining'
  | 'shirt'
  | 'slacks'
  | 'shoes'
  | 'skin'
  | 'grey'
  | 'salt'
  | 'pepper'
  | 'paper'
  | 'bark'
  | 'ring'
  | 'phone'
  | 'screen'
  | 'stick'
  | 'card'
  | 'band'
  | 'ink';

/** Randy’s body dimensions in meters, with cylindrical torso and head geometry. */
const SHAPE = {
  hip: 0.9,
  leg: [0.19, 0.86, 0.23] as V3,
  stance: 0.11,
  torsoR: 0.21,
  torsoH: 0.74,
  headR: 0.19,
  headH: 0.44,
  arm: [0.17, 0.68, 0.19] as V3,
  /** Radial segment count for cylindrical parts. */
  segments: 16,
};
/** Perpendicular distance from the body center to each panel of the octagonal coat shell, in meters. */
const COAT_R = 0.27;
/** Hand-target inset from the flap corner in meters and fractional height above the coat hem. */
const GRIP = { in: 0.03, up: 0.62 };
const COAT_HEM = 0.42;
const COAT_PANEL = 0.035;
/** Screen emissive intensity, keeping the phone visible inside the coat in the basement. */
const SCREEN_GLOW = 1.2;
/** Hair-shell radial expansion and vertical coverage down the back of the head, in meters. */
const CROP = 0.012;
const CROP_DOWN = 0.24;
/** Flecks in his hair: [x, z] on top of his head, and whether each is salt (light) or pepper (dark). */
const FLECKS: readonly (readonly [number, number, 'salt' | 'pepper'])[] = [
  [-0.1, 0.06, 'salt'],
  [0.05, 0.1, 'pepper'],
  [0.11, -0.05, 'salt'],
  [-0.03, -0.11, 'pepper'],
  [-0.12, -0.03, 'pepper'],
  [0.08, 0.02, 'salt'],
];
/**
 * Roasting-stick length in meters and downward rest angle in radians. Raising the right arm by ROAST_LIFT brings the
 * stick approximately horizontal over the fire.
 */
const STICK = 1;
const STICK_DROP = 0.79;
/** The arm lift (rad) that holds the stick out over the fire. */
export const ROAST_LIFT = 0.7;

export interface RandyRig extends CharacterRig {
  /** Side-hinged coat quarters. Negative left yaw and positive right yaw expose their lining and attached wares. */
  flaps: [Object3D, Object3D];
  /** Hand-target nodes parented to the moving coat flaps. */
  grips: [Object3D, Object3D];
  /** Brisket nodes on each flap and the burner phone on the right flap, for independent visibility. */
  brisket: [Object3D, Object3D];
  phone: Object3D;
  /** Right-hand skewer node. Raise armR by ROAST_LIFT to position it over the fire. */
  skewer: Object3D;
  /** Badge node in Randy’s left hand, initially hidden until he receives it. */
  badge: Object3D;
}

/** A coat panel facing out at angle `a` (0 = straight ahead, +x at a quarter turn), lined on the inside. */
function panel(a: number, width: number, h: number): Part<Mat> {
  const p = box(width, h, COAT_PANEL).at(Math.sin(a) * COAT_R, COAT_HEM + h / 2, Math.cos(a) * COAT_R);
  // +x, -x, +y, -y, +z (out), -z (in)
  return solid(p, ['coat', 'coat', 'coat', 'coat', 'coat', 'lining'], { rot: [0, a, 0] });
}

/** Position a box against the coat lining at angle `a` and height `up` above the hem. */
function tucked(a: number, up: number, b: Box): Box {
  const r = COAT_R - COAT_PANEL / 2 - b.size[2] / 2;
  return b.at(Math.sin(a) * r, COAT_HEM + up, Math.cos(a) * r);
}

/** Paper thickness, smoke-ring thickness, and ring offset below the brisket top, in meters. */
const BRISKET = { paper: 0.035, ring: 0.022, ringDown: 0.05 };

/** Build a named brisket group in butcher paper, rotated by `a`, with a visible smoke ring beneath the crust. */
function brisket(name: string, at: Box, a: number): Part<Mat> {
  const [w, h, d] = at.size;
  const B = BRISKET;
  const meat = at.sized(w - 0.01, h - B.paper, d).on(at.bottom + B.paper - 0.005);
  return group({ name }, [
    solid(at.sized(w, B.paper, d + 0.006).on(at.bottom), 'paper', { cast: false, rot: [0, a, 0] }),
    solid(meat, 'bark', { cast: false, rot: [0, a, 0] }),
    solid(meat.sized(w - 0.03, B.ring, d + 0.004).y(meat.top - B.ringDown), 'ring', { cast: false, rot: [0, a, 0] }),
  ]);
}

/** The roasting stick out of the fist (arm hanging), a chunk of brisket on the far end. */
function skewer(hand: Box): Part<Mat> {
  const dy = -Math.sin(STICK_DROP);
  const dz = Math.cos(STICK_DROP);
  const [hx, hy, hz] = hand.center;
  const along = (d: number): Box => box(1, 1, 1).at(hx, hy + dy * d, hz + dz * d);
  return group({ name: 'skewer' }, [
    solid(along(STICK / 2).sized(0.025, 0.025, STICK), 'stick', { rot: [STICK_DROP, 0, 0], cast: false }),
    solid(along(STICK - 0.07).sized(0.12, 0.09, 0.14), 'bark', { rot: [STICK_DROP, 0, 0], cast: false }),
  ]);
}

/** Build Cody’s badge below the hand, with its photo and blue band facing forward. */
function badge(hand: Box): Part<Mat> {
  const card = box(0.1, 0.065, 0.008).at(hand.center[0], hand.bottom - 0.03, hand.center[2] + 0.06);
  return group({ name: 'badge' }, [
    solid(card, 'card', NO_CAST),
    solid(card.sized(0.1, 0.014, 0.01).move(0, 0.022, 0), 'band', NO_CAST),
    solid(card.sized(0.026, 0.032, 0.01).move(-0.028, -0.006, 0.001), 'ink', NO_CAST),
  ]);
}

/** Position a facial detail against the cylindrical head surface, with optional forward offset `out`. */
function onFace(x: number, y: number, w: number, h: number, d: number, mid: number, out = 0): Box {
  const r = SHAPE.headR;
  const edge = Math.min(r, Math.abs(x) + w / 2);
  return box(w, h, d).at(x, mid + y, Math.sqrt(r * r - edge * edge) + d / 2 - 0.004 + out);
}

/** Randy on the shared rig layout (body, head, armL/R, legL/R) plus flapL/flapR. Feet at y=0, faces +Z. */
export function randy() {
  const S = SHAPE;
  const torsoTop = S.hip + S.torsoH;
  const top = torsoTop + 0.02;
  const h = top - COAT_HEM;
  const seg = Math.PI / 4;
  const panelW = 2 * COAT_R * Math.tan(seg / 2) + 0.01;
  // Hinge the front coat quarters at the side vertices of the octagonal shell.
  const hinge = COAT_R / Math.cos(seg / 2);
  const flaps = SIDES.map((s): Part<Mat> => {
    const front = (s * seg) / 2;
    const side = (s * 3 * seg) / 2;
    // Place the left brisket on the side panel so the opening arm does not obscure it.
    const at = s < 0 ? side : front;
    const wares: Part<Mat>[] = [
      brisket(s < 0 ? 'brisketL' : 'brisketR', tucked(at, h - 0.44, box(0.22, 0.22, 0.07)), at),
    ];
    if (s > 0) {
      const phone = tucked(side, h - 0.2, box(0.07, 0.13, 0.025));
      const screen = phone.sized(0.05, 0.07, 0.01).move(-Math.sin(side) * 0.012, 0.02, -Math.cos(side) * 0.012);
      wares.push(
        group({ name: 'phone' }, [
          solid(phone, 'phone', { cast: false, rot: [0, side, 0] }),
          solid(screen, 'screen', { cast: false, rot: [0, side, 0] }),
        ]),
      );
    }

    // Attach the hand target to the moving flap’s front edge.
    const grip = group<Mat>(
      { name: s < 0 ? 'gripL' : 'gripR', at: [s * GRIP.in, COAT_HEM + h * GRIP.up, hinge - GRIP.in] },
      [],
    );
    return pivot(
      s < 0 ? 'flapL' : 'flapR',
      [s * hinge, COAT_HEM, 0],
      [panel(front, panelW, h), panel(side, panelW, h), ...wares, grip],
    );
  });
  const back = [5, 7, 9, 11].map((k) => panel((k * seg) / 2, panelW, h));
  const headMid = torsoTop + 0.04 + S.headH / 2;
  const headParts: Part<Mat>[] = [
    cylinder(S.headR, S.headH, S.segments, 'skin', { at: [0, headMid, 0] }),
    // Offset the hair shell backward to leave the face exposed.
    cylinder(S.headR + CROP, 0.05, S.segments, 'grey', { at: [0, headMid + S.headH / 2 - 0.02, 0] }),
    cylinder(S.headR + CROP, CROP_DOWN, S.segments, 'grey', { at: [0, headMid + S.headH / 2 - CROP_DOWN / 2, -0.04] }),
    ...FLECKS.map(([x, z, m]) => solid(box(0.05, 0.012, 0.05).at(x, headMid + S.headH / 2 + 0.008, z), m, NO_CAST)),
    // Place facial details against the cylindrical head surface.
    ...SIDES.map((s) => solid(onFace(s * 0.085, 0.12, 0.09, 0.025, 0.02, headMid), 'pepper', NO_CAST)),
    ...SIDES.map((s) => solid(onFace(s * 0.085, 0.05, 0.045, 0.045, 0.02, headMid), 'ink', NO_CAST)),
    // Surround the mouth with a goatee and contrasting hair flecks.
    solid(onFace(0, -0.075, 0.2, 0.045, 0.03, headMid), 'grey', NO_CAST),
    ...SIDES.map((s) => solid(onFace(s * 0.08, -0.14, 0.045, 0.13, 0.03, headMid), 'grey', NO_CAST)),
    solid(onFace(0, -0.19, 0.2, 0.07, 0.035, headMid), 'grey', NO_CAST),
    solid(onFace(0, -0.12, 0.09, 0.025, 0.02, headMid), 'ink', NO_CAST),
    solid(onFace(-0.045, -0.19, 0.04, 0.03, 0.02, headMid, 0.02), 'salt', NO_CAST),
    solid(onFace(0.04, -0.205, 0.04, 0.03, 0.02, headMid, 0.02), 'pepper', NO_CAST),
    solid(onFace(0.08, -0.12, 0.03, 0.03, 0.02, headMid, 0.018), 'salt', NO_CAST),
  ];
  return model<Mat>(
    {
      coat: { color: RANDY.coat, roughness: 0.8 },
      lining: { color: RANDY.lining, roughness: 0.4 },
      shirt: { color: RANDY.shirt, roughness: 0.75 },
      slacks: { color: RANDY.slacks, roughness: 0.85 },
      shoes: { color: RANDY.shoes, roughness: 0.6 },
      skin: { color: RANDY.skin, roughness: 0.8 },
      grey: { color: RANDY.grey, roughness: 0.95 },
      salt: { color: RANDY.salt, roughness: 0.95 },
      pepper: { color: RANDY.pepper, roughness: 0.95 },
      paper: { color: RANDY.paper, roughness: 0.9 },
      bark: { color: RANDY.bark, roughness: 0.95 },
      ring: { color: RANDY.ring, roughness: 0.8 },
      phone: { color: RANDY.phone, roughness: 0.4, metalness: 0.2 },
      screen: { color: RANDY.screen, emissive: RANDY.screen, emissiveIntensity: SCREEN_GLOW },
      stick: { color: RANDY.stick, roughness: 0.9 },
      card: { color: RANDY.card, roughness: 0.5 },
      band: { color: RANDY.band, roughness: 0.5 },
      ink: FACE_INK,
    },
    [
      group({ name: 'body' }, [
        ...SIDES.map((s) => {
          const leg = box(...S.leg)
            .x(s * S.stance)
            .under(S.hip);
          return limb<Mat>(s < 0 ? 'legL' : 'legR', leg, 'slacks', [
            solid(leg.sized(0.22, 0.12, 0.34).on(0).move(0, 0, 0.05), 'shoes'),
          ]);
        }),
        cylinder(S.torsoR, S.torsoH, S.segments, 'shirt', { at: [0, S.hip + S.torsoH / 2, 0] }),
        ...back,
        ...flaps,
        // Close the coat at the shoulders and add the raised collar.
        cylinder(COAT_R + 0.01, 0.06, 8, 'coat', { at: [0, top, 0], rot: [0, Math.PI / 8, 0] }),
        cylinder(0.16, 0.1, S.segments, 'coat', { at: [0, top + 0.07, -0.01], cast: false }),
        ...SIDES.map((s) => {
          const arm = box(...S.arm)
            .under(top - 0.03)
            .x(s * (hinge + S.arm[0] / 2 - 0.02));
          const hand = arm.sized(0.14, 0.14, 0.16).under(arm.bottom + 0.01);
          return limb<Mat>(s < 0 ? 'armL' : 'armR', arm, 'coat', [
            solid(hand, 'skin'),
            ...(s > 0 ? [skewer(hand)] : [badge(hand)]),
          ]);
        }),
        pivot('head', [0, torsoTop + 0.02, 0], headParts),
      ]),
    ],
  );
}

function hideBadge(b: Object3D): Object3D {
  b.visible = false;
  return b;
}

export function buildRandy(): RandyRig {
  const built = build(randy());
  return {
    ...characterRig(built),
    flaps: [built.node('flapL'), built.node('flapR')],
    grips: [built.node('gripL'), built.node('gripR')],
    brisket: [built.node('brisketL'), built.node('brisketR')],
    phone: built.node('phone'),
    skewer: built.node('skewer'),
    badge: hideBadge(built.node('badge')),
  };
}
