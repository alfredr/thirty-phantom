import {
  box,
  cone,
  cylinder,
  type MatSpec,
  type Model,
  model,
  NO_CAST,
  type Part,
  solid,
  sphere,
  torus,
} from '@/actors/models/part';
import { TUNING } from '@/config';
import type { V3 } from '@/engine/core/math';
import { BARK, FOLIAGE, METAL, NEEDLES, PETALS } from '@/render/materials';
import { PALETTE } from '@/render/palette';

import type { DecorKind } from './level-kinds';
import { restTilt } from './props';

export { type DecorKind } from './level-kinds';

/**
 * Decor models use a base at the origin and face +Z. build-decor.ts batches
 * their render geometry by material. Generators append static collision from
 * DECOR.solids; breakable decor receives runtime collision and prop state
 * instead.
 */

/**
 * Stone, timber, and roofing share foliage roughness so they can batch with
 * vertex colors. Fountain water uses a separate reflective, emissive
 * material.
 */
const STONE: MatSpec = { color: '#6e677f', roughness: 0.9 };
const TIMBER: MatSpec = { color: '#5c3d4c', roughness: 0.9 };
const SHINGLE: MatSpec = { color: '#4b2a6e', roughness: 0.9 };
const WATER: MatSpec = {
  color: '#5a3fb0',
  emissive: PALETTE.purpleHot,
  emissiveIntensity: 0.55,
  roughness: 0.1,
  metalness: 0.3,
};
/**
 * Reflective bus-shelter panes use a lighter tint than building glass for
 * visibility.
 */
const PANE: MatSpec = { color: '#4a3d6e', roughness: 0.15, metalness: 0.5 };

/** A box part from its min and max corners. */
const slab = <M extends string>(min: V3, max: V3, mat: M): Part<M> =>
  solid(
    box(max[0] - min[0], max[1] - min[1], max[2] - min[2]).at(
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    ),
    mat,
  );

/** Upright cylinder standing on y0. */
const column = <M extends string>(
  r: number,
  y0: number,
  h: number,
  seg: number,
  mat: M,
  x = 0,
  z = 0,
): Part<M> => cylinder(r, h, seg, mat, { at: [x, y0 + h / 2, z] });

const TREE = {
  /** Trunk: radius at the foot and under the crown, its height, sides. */
  trunk: { r0: 0.2, r1: 0.13, h: 3.3, seg: 7 },
  /**
   * Crown spheres as (centre X, centre Y, centre Z, radius), largest first.
   * Dimensions are in meters.
   */
  crown: [
    [0, 4.0, 0, 1.35],
    [0.85, 3.6, 0.3, 0.85],
    [-0.8, 3.7, -0.35, 0.85],
    [0.2, 3.55, -0.85, 0.8],
    [-0.3, 3.5, 0.85, 0.75],
    [0.15, 4.95, 0.1, 0.9],
  ] as const,
  /** Segments around and down a blob. */
  seg: [7, 5] as [number, number],
};

/** A broadleaf street tree: a tapered trunk under a lumpy crown of blobs. */
function roundTree(p = TREE): Model<'bark' | 'leaf'> {
  const t = p.trunk;
  return model({ bark: BARK, leaf: FOLIAGE }, [
    cone(t.r0, t.r1, t.h, t.seg, 'bark', { at: [0, t.h / 2, 0] }),
    ...p.crown.map(([x, y, z, r]) =>
      sphere(r, p.seg, 'leaf', { at: [x, y, z] }),
    ),
  ]);
}

const PINE = {
  /** Trunk: radius at the foot and the top, height, sides. */
  trunk: { r0: 0.2, r1: 0.1, h: 1.6, seg: 6 },
  /** Tiers from the bottom: base height, radius, height; and the cones' sides. */
  tiers: [
    [0.9, 1.55, 2.3],
    [2.2, 1.2, 2.1],
    [3.4, 0.85, 2.0],
  ] as const,
  seg: 8,
};

/** Build a conifer from a tapered trunk and stacked foliage cones. */
function pine(p = PINE): Model<'bark' | 'needles'> {
  const t = p.trunk;
  return model({ bark: BARK, needles: NEEDLES }, [
    cone(t.r0, t.r1, t.h, t.seg, 'bark', { at: [0, t.h / 2, 0] }),
    ...p.tiers.map(([y, r, h]) =>
      cone(r, 0, h, p.seg, 'needles', { at: [0, y + h / 2, 0] }),
    ),
  ]);
}

const CYPRESS = {
  /** Trunk stub: radius, height, sides. */
  trunk: { r: 0.14, h: 0.8, seg: 6 },
  /**
   * The column (radii, middle height) and the tip on top of it; segments
   * around and down both.
   */
  body: { r: [0.75, 2.4, 0.75] as V3, y: 3.0 },
  tip: { r: [0.42, 1.0, 0.42] as V3, y: 5.2 },
  seg: [8, 8] as [number, number],
};

/** A tall, dark, flame-shaped cypress: graveyards and formal edges. */
function cypress(p = CYPRESS): Model<'bark' | 'needles'> {
  return model({ bark: BARK, needles: NEEDLES }, [
    column(p.trunk.r, 0, p.trunk.h, p.trunk.seg, 'bark'),
    sphere(p.body.r, p.seg, 'needles', { at: [0, p.body.y, 0] }),
    sphere(p.tip.r, p.seg, 'needles', { at: [0, p.tip.y, 0] }),
  ]);
}

const BUSH = {
  /** Blobs (x, y, z, radius): about 1.6 m across and 1.1 m tall. */
  blobs: [
    [0, 0.5, 0, 0.6],
    [0.45, 0.38, 0.15, 0.45],
    [-0.42, 0.4, -0.1, 0.45],
  ] as const,
  /** Segments around and down a blob. */
  seg: [6, 4] as [number, number],
};

/**
 * Build a shrub from overlapping foliage spheres. Collision is defined
 * separately in DECOR.
 */
function bush(p = BUSH): Model<'leaf'> {
  return model(
    { leaf: FOLIAGE },
    p.blobs.map(([x, y, z, r]) => sphere(r, p.seg, 'leaf', { at: [x, y, z] })),
  );
}

const HEDGE = {
  /**
   * One module along x (runs stretch modules to fit), its depth, and the
   * trimmed body's height.
   */
  len: 2,
  depth: 0.8,
  body: 0.75,
  /**
   * Rounded lumps along the top: radii, how many, and segments around and down
   * each.
   */
  lump: [0.5, 0.3, 0.44] as V3,
  lumps: 3,
  seg: [6, 3] as [number, number],
};

/** A trimmed hedge module: a box of leaves with a lumpy top. */
function hedge(p = HEDGE): Model<'leaf'> {
  const step = p.len / p.lumps;
  return model({ leaf: FOLIAGE }, [
    solid(box(p.len, p.body, p.depth).on(0), 'leaf'),
    ...Array.from({ length: p.lumps }, (_, i) =>
      sphere(p.lump, p.seg, 'leaf', {
        at: [-p.len / 2 + step * (i + 0.5), p.body, 0],
      }),
    ),
  ]);
}

/** Overall height of a hedge module. */
const hedgeHeight = (p = HEDGE): number => p.body + p.lump[1];

const FLOWERS = {
  /**
   * The leafy mound they grow from (radii, middle height: half sunk in the
   * bed).
   */
  mound: {
    r: [0.5, 0.25, 0.5] as V3,
    y: 0.08,
    seg: [6, 3] as [number, number],
  },
  /**
   * Flower heads: size, how far out the ring of them stands, how high it and
   * the one in the middle sit.
   */
  head: 0.15,
  ring: 0.3,
  heads: 6,
  y: [0.3, 0.38] as [number, number],
  /**
   * The ring is turned this far (radians) so its heads don't line up with the
   * paths' axes.
   */
  twist: 0.4,
};

/**
 * Build a foliage mound with rotated box-shaped flower heads using the
 * supplied petal material.
 */
function flowers(petals: MatSpec, p = FLOWERS): Model<'leaf' | 'petal'> {
  const head = (x: number, y: number, z: number): Part<'petal'> =>
    solid(box(p.head, p.head, p.head).at(x, y, z), 'petal', {
      rot: [Math.PI / 4, Math.PI / 4, 0],
      ...NO_CAST,
    });
  return model({ leaf: FOLIAGE, petal: { ...petals, softInk: true } }, [
    sphere(p.mound.r, p.mound.seg, 'leaf', { at: [0, p.mound.y, 0] }),
    head(0, p.y[1], 0),
    ...Array.from({ length: p.heads }, (_, i) => {
      const a = (i / p.heads) * Math.PI * 2 + p.twist;
      return head(
        Math.sin(a) * p.ring,
        i % 2 ? p.y[1] : p.y[0],
        Math.cos(a) * p.ring,
      );
    }),
  ]);
}

export const FOUNTAIN = {
  /**
   * Basin: radius, height of its stone drum, the rounded lip round it (tube
   * radius), the water's surface.
   */
  basin: { r: 2.6, h: 0.38, lip: 0.18, water: 0.42 },
  /**
   * The center column, the bowl on it (radius at the foot and the brim,
   * depth), the top tier on a stem, and the jet.
   */
  column: { r: 0.32, h: 1.5 },
  bowl: { foot: 0.45, r: 1.2, h: 0.35 },
  stem: { r: 0.18, h: 0.6 },
  top: { foot: 0.22, r: 0.55, h: 0.25 },
  jet: { r: 0.07, h: 0.5 },
  /**
   * Water-disc thickness, vertical offset above stone to prevent z-fighting,
   * and exposed brim widths for the two bowls.
   */
  sheet: { t: 0.03, lift: 0.02, brim: [0.1, 0.06] as [number, number] },
  /**
   * Sides round the basin and bowls (columns get half), round the lip's tube
   * and the jet; the jet's head is this many times its radius.
   */
  seg: 16,
  lipSeg: 6,
  jetSeg: 6,
  head: 2,
};

/**
 * A tiered park fountain: a round stone basin with a lip, a column, two bowls
 * and a jet, all brimming with glowing water.
 */
function fountain(p = FOUNTAIN): Model<'stone' | 'water'> {
  const b = p.basin;
  const bowlY = b.h + p.column.h;
  const stemY = bowlY + p.bowl.h;
  const topY = stemY + p.stem.h;
  const { t, lift, brim } = p.sheet;
  // Let the stone supply shadows; omit shadow casting for water surfaces.
  const disc = (r: number, y: number): Part<'water'> => ({
    ...column(r, y + lift, t, p.seg, 'water'),
    ...NO_CAST,
  });
  const jetTop = topY + p.top.h + p.jet.h;
  return model({ stone: STONE, water: WATER }, [
    column(b.r, 0, b.h, p.seg, 'stone'),
    // Raise the lip above the water surface to prevent overlap.
    torus(b.r - b.lip, b.lip, p.lipSeg, p.seg * 2, 'stone', {
      at: [0, b.water + lift, 0],
      rot: [Math.PI / 2, 0, 0],
    }),
    disc(b.r - b.lip, b.h),
    column(p.column.r, b.h, p.column.h, p.seg / 2, 'stone'),
    cone(p.bowl.foot, p.bowl.r, p.bowl.h, p.seg, 'stone', {
      at: [0, bowlY + p.bowl.h / 2, 0],
    }),
    disc(p.bowl.r - brim[0], stemY),
    column(p.stem.r, stemY, p.stem.h, p.seg / 2, 'stone'),
    cone(p.top.foot, p.top.r, p.top.h, p.seg, 'stone', {
      at: [0, topY + p.top.h / 2, 0],
    }),
    disc(p.top.r - brim[1], topY + p.top.h),
    {
      ...column(p.jet.r, topY + p.top.h, p.jet.h, p.jetSeg, 'water'),
      ...NO_CAST,
    },
    sphere(p.jet.r * p.head, [p.jetSeg, p.jetSeg / 2 + 1], 'water', {
      at: [0, jetTop, 0],
      ...NO_CAST,
    }),
  ]);
}

/**
 * Height from the fountain base to the jet endpoint, excluding its spherical
 * cap.
 */
const fountainHeight = (p = FOUNTAIN): number =>
  p.basin.h + p.column.h + p.bowl.h + p.stem.h + p.top.h + p.jet.h;

export const GAZEBO = {
  /** Sides, the radius its posts stand on, and the posts' size. */
  sides: 8,
  r: 2.4,
  post: { w: 0.2, h: 2.5 },
  /** Floor: its height and corner radius. */
  floor: { h: 0.3, r: 2.75 },
  /**
   * Rail between posts: height of its top, its section; the sides left open
   * (doorways), counted round from +z.
   */
  rail: { y: 0.9, h: 0.1, t: 0.08 },
  open: [0, 4],
  /**
   * The roof: corner radius, height of the cone, the fascia band under it, the
   * ball on top (and its segments).
   */
  roof: {
    r: 3.25,
    h: 1.7,
    band: 0.28,
    ball: 0.22,
    ballSeg: [8, 6] as [number, number],
  },
};

/**
 * Corner `i` of a regular polygon with `n` sides, one side facing +z, at
 * radius r.
 */
function corner(i: number, n: number, r: number): [number, number] {
  const a = ((i + 0.5) / n) * Math.PI * 2;
  return [Math.sin(a) * r, Math.cos(a) * r];
}

/**
 * An open octagonal gazebo: a timber floor, posts, low rails with two
 * doorways, and a purple pointed roof.
 */
function gazebo(p = GAZEBO): Model<'timber' | 'roof'> {
  const n = p.sides;
  const turn = Math.PI / n;
  const top = p.floor.h + p.post.h;
  const parts: Part<'timber' | 'roof'>[] = [
    cylinder(p.floor.r, p.floor.h, n, 'timber', {
      at: [0, p.floor.h / 2, 0],
      rot: [0, turn, 0],
    }),
    cylinder(p.roof.r, p.roof.band, n, 'roof', {
      at: [0, top + p.roof.band / 2, 0],
      rot: [0, turn, 0],
    }),
    cone(p.roof.r, 0, p.roof.h, n, 'roof', {
      at: [0, top + p.roof.band + p.roof.h / 2, 0],
      rot: [0, turn, 0],
    }),
    sphere(p.roof.ball, p.roof.ballSeg, 'roof', {
      at: [0, top + p.roof.band + p.roof.h, 0],
    }),
  ];
  const side = 2 * p.r * Math.sin(Math.PI / n);
  const apothem = p.r * Math.cos(Math.PI / n);
  for (let i = 0; i < n; i++) {
    const [x, z] = corner(i, n, p.r);
    parts.push(
      solid(
        box(p.post.w, p.post.h, p.post.w).at(x, p.floor.h + p.post.h / 2, z),
        'timber',
      ),
    );

    if (p.open.includes(i)) {
      continue;
    }

    const a = (i / n) * Math.PI * 2;
    parts.push(
      solid(
        box(side, p.rail.h, p.rail.t).at(
          Math.sin(a) * apothem,
          p.floor.h + p.rail.y - p.rail.h / 2,
          Math.cos(a) * apothem,
        ),
        'timber',
        { rot: [0, a, 0] },
      ),
    );
  }

  return model({ timber: TIMBER, roof: SHINGLE }, parts);
}

export const SHELTER = {
  /**
   * Width (x), depth (z) and the roof's underside; it opens toward +z, its
   * back on the -z side.
   */
  w: 3.6,
  d: 1.5,
  h: 2.5,
  /** Its posts' section; the roof's thickness and overhang. */
  post: 0.1,
  roof: { t: 0.14, over: 0.2 },
  /** Glass panes: thickness, gaps under them and under the roof. */
  pane: { t: 0.04, y: 0.15, top: 0.1 },
  /**
   * Bench along the back: seat height, depth, slab thickness, set in from the
   * ends and off the back pane; its two legs (section, in from the ends,
   * depth).
   */
  bench: {
    y: 0.45,
    d: 0.4,
    t: 0.06,
    end: 0.3,
    back: 0.08,
    leg: { w: 0.08, end: 0.5, d: 0.3 },
  },
  /**
   * The lit ad panel that closes the +x end, and the lit strip along the
   * roof's front edge (its height and depth).
   */
  ad: { t: 0.14, y: 0.25, h: 1.9 },
  strip: { h: 0.08, d: 0.12 },
};

/**
 * A bus shelter: posts, a flat roof with a lit strip under its front edge,
 * glass back and end, a bench inside, and a glowing ad panel at the other
 * end.
 */
function shelter(p = SHELTER): Model<'iron' | 'glass' | 'timber' | 'ad'> {
  const hw = p.w / 2;
  const hd = p.d / 2;
  const b = p.bench;
  const posts: [number, number][] = [
    [-hw, -hd],
    [hw, -hd],
    [-hw, hd],
    [hw, hd],
  ];
  // Share the purple-petal material settings so emissive ad surfaces can batch with flowers.
  return model(
    {
      iron: METAL,
      glass: PANE,
      timber: TIMBER,
      ad: { ...PETALS.purple, softInk: true },
    },
    [
      ...posts.map(([x, z]) =>
        slab(
          [x - p.post / 2, 0, z - p.post / 2],
          [x + p.post / 2, p.h, z + p.post / 2],
          'iron',
        ),
      ),
      slab(
        [-hw - p.roof.over, p.h, -hd - p.roof.over],
        [hw + p.roof.over, p.h + p.roof.t, hd + p.roof.over],
        'iron',
      ),
      {
        ...slab([-hw, p.h - p.strip.h, hd - p.strip.d], [hw, p.h, hd], 'ad'),
        ...NO_CAST,
      },
      slab(
        [-hw + p.post / 2, p.pane.y, -hd - p.pane.t / 2],
        [hw - p.post / 2, p.h - p.pane.top, -hd + p.pane.t / 2],
        'glass',
      ),
      slab(
        [-hw - p.pane.t / 2, p.pane.y, -hd + p.post / 2],
        [-hw + p.pane.t / 2, p.h - p.pane.top, hd - p.post / 2],
        'glass',
      ),
      {
        ...slab(
          [hw - p.ad.t / 2, p.ad.y, -hd + p.post / 2],
          [hw + p.ad.t / 2, p.ad.y + p.ad.h, hd - p.post / 2],
          'ad',
        ),
        ...NO_CAST,
      },
      slab(
        [-hw + b.end, b.y - b.t, -hd + b.back],
        [hw - b.end, b.y, -hd + b.back + b.d],
        'timber',
      ),
      ...[-hw + b.leg.end, hw - b.leg.end].map((x) =>
        slab(
          [x - b.leg.w / 2, 0, -hd + b.back],
          [x + b.leg.w / 2, b.y - b.t, -hd + b.back + b.leg.d],
          'iron',
        ),
      ),
    ],
  );
}

export const BENCH = {
  /** Length (x), seat height and depth, height of the back; it faces +z. */
  len: 1.8,
  seat: 0.45,
  depth: 0.5,
  back: 0.88,
  /**
   * Seat slats (thickness, width, count) and back slats (thickness, height,
   * heights of their middles).
   */
  slat: { t: 0.05, w: 0.13, n: 3 },
  backSlat: { t: 0.04, h: 0.12, ys: [0.62, 0.8] },
  /** The iron end frames: section, how far in from the ends, armrest height. */
  frame: { w: 0.07, inset: 0.12, arm: 0.66 },
};

/** A park bench: timber slats on two iron end frames. */
function bench(p = BENCH): Model<'iron' | 'timber'> {
  const hd = p.depth / 2;
  const f = p.frame.w;
  const parts: Part<'iron' | 'timber'>[] = [];
  for (const x of [-p.len / 2 + p.frame.inset, p.len / 2 - p.frame.inset]) {
    parts.push(
      slab([x - f / 2, 0, hd - f], [x + f / 2, p.seat, hd], 'iron'),
      slab([x - f / 2, 0, -hd], [x + f / 2, p.back, -hd + f], 'iron'),
      slab([x - f / 2, p.seat - f, -hd], [x + f / 2, p.seat, hd], 'iron'),
      slab(
        [x - f / 2, p.frame.arm - f, -hd],
        [x + f / 2, p.frame.arm, hd],
        'iron',
      ),
    );
  }

  const gap = (p.depth - p.slat.n * p.slat.w) / (p.slat.n - 1);
  for (let i = 0; i < p.slat.n; i++) {
    const z0 = -hd + i * (p.slat.w + gap);
    parts.push(
      slab(
        [-p.len / 2, p.seat, z0],
        [p.len / 2, p.seat + p.slat.t, z0 + p.slat.w],
        'timber',
      ),
    );
  }

  for (const y of p.backSlat.ys) {
    parts.push(
      slab(
        [-p.len / 2, y - p.backSlat.h / 2, -hd + f],
        [p.len / 2, y + p.backSlat.h / 2, -hd + f + p.backSlat.t],
        'timber',
      ),
    );
  }

  return model({ iron: METAL, timber: TIMBER }, parts);
}

const DEAD_TREE = {
  trunk: { r0: 0.34, r1: 0.1, h: 6, seg: 6 },
  branches: [
    [0.3, 3.0, 2.4, 1.0, 0.13],
    [2.2, 3.8, 1.9, 0.85, 0.11],
    [4.0, 2.6, 1.6, 1.15, 0.12],
    [5.2, 4.6, 1.5, 0.7, 0.09],
    [1.3, 5.0, 1.1, 0.55, 0.07],
  ] as const,
  seg: 5,
  taper: 0.25,
};

function deadTree(p = DEAD_TREE): Model<'bark'> {
  const t = p.trunk;
  return model({ bark: BARK }, [
    cone(t.r0, t.r1, t.h, t.seg, 'bark', { at: [0, t.h / 2, 0] }),
    ...p.branches.map(([turn, y, len, tilt, r]) => {
      const out = (Math.sin(tilt) * len) / 2;
      return cone(r, r * p.taper, len, p.seg, 'bark', {
        at: [
          Math.cos(turn) * out,
          y + (Math.cos(tilt) * len) / 2,
          -Math.sin(turn) * out,
        ],
        rot: [0, turn, -tilt],
      });
    }),
  ]);
}

const HEADSTONE = { w: 1, h: 1.05, d: 0.3, seg: 12 };

function headstone(p = HEADSTONE): Model<'stone'> {
  return model({ stone: STONE }, [
    slab([-p.w / 2, 0, -p.d / 2], [p.w / 2, p.h, p.d / 2], 'stone'),
    cylinder(p.w / 2, p.d, p.seg, 'stone', {
      at: [0, p.h, 0],
      rot: [Math.PI / 2, 0, 0],
    }),
  ]);
}

const CROSS = { post: 0.28, h: 1.8, arm: { w: 1, y: 1.15 } };

function cross(p = CROSS): Model<'stone'> {
  const t = p.post / 2;
  return model({ stone: STONE }, [
    slab([-t, 0, -t], [t, p.h, t], 'stone'),
    slab(
      [-p.arm.w / 2, p.arm.y, -t],
      [p.arm.w / 2, p.arm.y + p.post, t],
      'stone',
    ),
  ]);
}

const OBELISK = {
  base: { w: 0.9, h: 0.3 },
  shaft: { w: 0.5, h: 2.2 },
  tip: { r: 0.22, h: 0.4 },
};

function obelisk(p = OBELISK): Model<'stone'> {
  const b = p.base.w / 2;
  const s = p.shaft.w / 2;
  const top = p.base.h + p.shaft.h;
  return model({ stone: STONE }, [
    slab([-b, 0, -b], [b, p.base.h, b], 'stone'),
    slab([-s, p.base.h, -s], [s, top, s], 'stone'),
    cone(p.tip.r, 0, p.tip.h, 4, 'stone', {
      at: [0, top + p.tip.h / 2, 0],
      rot: [0, Math.PI / 4, 0],
    }),
  ]);
}

const TOMB = {
  slab: { w: 1.4, h: 0.5, d: 2.2 },
  stone: { w: 1, h: 1, d: 0.3, z: -0.9 },
};

function tomb(p = TOMB): Model<'stone'> {
  const { w, h, d } = p.slab;
  const s = p.stone;
  return model({ stone: STONE }, [
    slab([-w / 2, 0, -d / 2], [w / 2, h, d / 2], 'stone'),
    slab(
      [-s.w / 2, h, s.z - s.d / 2],
      [s.w / 2, h + s.h, s.z + s.d / 2],
      'stone',
    ),
  ]);
}

/**
 * A box in a piece's own frame (before its yaw and scale): min and max
 * corners.
 */
export type LocalBox = [V3, V3];

/**
 * Return world-axis-aligned bounds after applying uniform scale, local-X
 * stretch, yaw, and translation to a local box.
 */
export function worldBox(
  b: LocalBox,
  pos: V3,
  yaw: number,
  s: number,
  stretch: number,
): LocalBox {
  const [lo, hi] = b;
  const c = Math.cos(yaw);
  const n = Math.sin(yaw);
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const lx of [lo[0], hi[0]]) {
    for (const lz of [lo[2], hi[2]]) {
      const x = lx * s * stretch;
      const z = lz * s;
      // Match Three.js rotation about +Y: x' = x cos + z sin, z' = z cos - x sin.
      const wx = x * c + z * n;
      const wz = z * c - x * n;
      x0 = Math.min(x0, wx);
      x1 = Math.max(x1, wx);
      z0 = Math.min(z0, wz);
      z1 = Math.max(z1, wz);
    }
  }

  return [
    [pos[0] + x0, pos[1] + lo[1] * s, pos[2] + z0],
    [pos[0] + x1, pos[1] + hi[1] * s, pos[2] + z1],
  ];
}

/**
 * Break behavior for decor props: topple or shatter, then remain displaced
 * until repair. `by` selects ordinary knockdown or truck-only smash
 * eligibility. build-decor.ts creates breakable collision from DECOR.solids.
 */
export type DecorHit = {
  by: 'any' | 'truck';
  /** Scales above this limit use static, unbreakable collision. */
  maxScale?: number;
  /** Debris colors supplied to the game's break effect. */
  debris: readonly string[];
  /**
   * Fraction of vehicle speed retained after impact; undefined uses the
   * vehicle default.
   */
  keep?: number;
  boost?: { above: number; momentum: number };
} & (
  | { as: 'shatter' }
  /**
   * Toppling (PropKind): its height, half its lying width across its old up
   * axis, the tilt it comes to rest at.
   */
  | { as: 'topple'; height: number; wide: number; down: number }
);

export interface DecorSpec {
  model: () => Model<string>;
  /**
   * Local-space reservation boxes used by the generator to keep other decor
   * clear, including elevated foliage.
   */
  space: LocalBox[];
  /**
   * Local collision boxes. Generators append these for static decor;
   * build-decor.ts creates them for breakable props.
   */
  solids: LocalBox[];
  /**
   * Vehicles knock it over or smash it (hitOf()); otherwise it's static and
   * its solids stop them.
   */
  hit?: DecorHit;
  /**
   * Ignore yaw when transforming reservation and collision boxes for
   * approximately round decor.
   */
  round?: boolean;
  /**
   * Local visual-occlusion boxes, such as foliage, used by cutaway probes
   * without blocking movement.
   */
  sight?: LocalBox[];
}

/**
 * Roof collision thickness exceeds THIN_SLAB so it blocks cutaway sightline
 * probes. Glass-wall collision extends `wall` meters to either side of the
 * pane.
 */
const SOLID = { roof: 0.35, wall: 0.08 };

/**
 * Collision boxes for a gazebo: its floor (a cross over a square inside the
 * octagon), each post, the rails, and its roof (a sightline blocker, for the
 * cut-away view).
 */
function gazeboSolids(p = GAZEBO): LocalBox[] {
  const n = p.sides;
  const apo = p.floor.r * Math.cos(Math.PI / n);
  const half = p.floor.r * Math.sin(Math.PI / n);
  const sq = apo / Math.SQRT2;
  const fh = p.floor.h;
  const out: LocalBox[] = [
    [
      [-apo, 0, -half],
      [apo, fh, half],
    ],
    [
      [-half, 0, -apo],
      [half, fh, apo],
    ],
    [
      [-sq, 0, -sq],
      [sq, fh, sq],
    ],
  ];
  for (let i = 0; i < n; i++) {
    const [x, z] = corner(i, n, p.r);
    const w = p.post.w / 2;
    out.push([
      [x - w, fh, z - w],
      [x + w, fh + p.post.h, z + w],
    ]);

    if (p.open.includes(i)) {
      continue;
    }

    // Approximate each diagonal rail with two axis-aligned collision boxes.
    const [ax, az] = corner(i - 1, n, p.r);
    for (const t of [0.25, 0.75]) {
      const cx = ax + (x - ax) * t;
      const cz = az + (z - az) * t;
      const hx = Math.abs(x - ax) / 4 + p.rail.t;
      const hz = Math.abs(z - az) / 4 + p.rail.t;
      out.push([
        [cx - hx, fh, cz - hz],
        [cx + hx, fh + p.rail.y, cz + hz],
      ]);
    }
  }

  const top = fh + p.post.h;
  out.push([
    [-sq, top, -sq],
    [sq, top + SOLID.roof, sq],
  ]);
  return out;
}

/**
 * Approximate the round fountain basin with two crossing rectangles and a
 * central square. Values are fractions of basin radius; a separate box covers
 * the central column.
 */
const ROUND_BASIN = { arm: 0.4, square: 0.75 };

function fountainSolids(p = FOUNTAIN): LocalBox[] {
  const r = p.basin.r;
  const h = p.basin.water + p.basin.lip;
  const s = r * ROUND_BASIN.square;
  const k = r * ROUND_BASIN.arm;
  return [
    [
      [-r, 0, -k],
      [r, h, k],
    ],
    [
      [-k, 0, -r],
      [k, h, r],
    ],
    [
      [-s, 0, -s],
      [s, h, s],
    ],
    [
      [-p.column.r, 0, -p.column.r],
      [p.column.r, fountainHeight(p), p.column.r],
    ],
  ];
}

/**
 * Collision boxes for a bus shelter: its back, its two ends, the bench, and
 * the roof (a sightline blocker).
 */
function shelterSolids(p = SHELTER): LocalBox[] {
  const hw = p.w / 2;
  const hd = p.d / 2;
  const { wall, roof } = SOLID;
  const b = p.bench;
  return [
    [
      [-hw, 0, -hd - wall],
      [hw, p.h, -hd + wall],
    ],
    [
      [-hw - wall, 0, -hd],
      [-hw + wall, p.h, hd],
    ],
    [
      [hw - p.ad.t, 0, -hd],
      [hw + p.ad.t, p.h, hd],
    ],
    [
      [-hw + b.end, 0, -hd],
      [hw - b.end, b.y, -hd + b.back + b.d],
    ],
    [
      [-hw, p.h, -hd],
      [hw, p.h + roof, hd],
    ],
  ];
}

/**
 * A box centered over a piece's base: half extents along x and z, from y0 up
 * to y1.
 */
const around = (hx: number, y0: number, y1: number, hz = hx): LocalBox => [
  [-hx, y0, -hz],
  [hx, y1, hz],
];

/**
 * Room round a bench or shelter seat for sitting: legs stretched out in front
 * of it.
 */
const LEGROOM = 0.5;
/**
 * Reservation margin around decor, with a separate bare-ground margin around
 * tree trunks.
 */
const MARGIN = { piece: 0.1, trunk: 0.15 };
/**
 * Fraction of crown radius treated as a visual occluder, excluding the
 * irregular outer edge.
 */
const SIGHT = 0.75;

type Blob = readonly [number, number, number, number];

/**
 * How far a cluster of blobs (x, y, z, radius) reaches out from the trunk's
 * axis, and its bottom and top.
 */
function reach(blobs: readonly Blob[]): {
  out: number;
  y0: number;
  y1: number;
} {
  let out = 0;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const [x, y, z, r] of blobs) {
    out = Math.max(out, Math.hypot(x, z) + r);
    y0 = Math.min(y0, y - r);
    y1 = Math.max(y1, y + r);
  }

  return { out, y0, y1 };
}

const CROWN = reach(TREE.crown);
const PINE_TIERS = {
  out: Math.max(...PINE.tiers.map(([, r]) => r)),
  y0: PINE.tiers[0][0],
  y1: Math.max(...PINE.tiers.map(([y, , h]) => y + h)),
};
const CYPRESS_BODY = {
  out: CYPRESS.body.r[0],
  y0: CYPRESS.body.y - CYPRESS.body.r[1],
  y1: CYPRESS.tip.y + CYPRESS.tip.r[1],
};
const BUSH_REACH = reach(BUSH.blobs);
const FLOWER_TOP = FLOWERS.y[1] + FLOWERS.head;
const DEAD_REACH = {
  out: Math.max(
    ...DEAD_TREE.branches.map(([, , len, tilt]) => Math.sin(tilt) * len),
  ),
  y0: Math.min(...DEAD_TREE.branches.map(([, y]) => y)),
};
const HEADSTONE_TOP = HEADSTONE.h + HEADSTONE.w / 2;
const CROSS_ARM: LocalBox = [
  [-CROSS.arm.w / 2, CROSS.arm.y, -CROSS.post / 2],
  [CROSS.arm.w / 2, CROSS.arm.y + CROSS.post, CROSS.post / 2],
];
const OBELISK_TOP = OBELISK.base.h + OBELISK.shaft.h + OBELISK.tip.h;
const OBELISK_BOXES = [
  around(OBELISK.base.w / 2, 0, OBELISK.base.h),
  around(OBELISK.shaft.w / 2, OBELISK.base.h, OBELISK_TOP),
];
const TOMB_BOXES: LocalBox[] = [
  around(TOMB.slab.w / 2, 0, TOMB.slab.h, TOMB.slab.d / 2),
  [
    [-TOMB.stone.w / 2, TOMB.slab.h, TOMB.stone.z - TOMB.stone.d / 2],
    [
      TOMB.stone.w / 2,
      TOMB.slab.h + TOMB.stone.h,
      TOMB.stone.z + TOMB.stone.d / 2,
    ],
  ],
];

/**
 * Debris colors are lighter than source surfaces to remain visible against the
 * ground.
 */
const DEBRIS = {
  leaf: '#4f7a52',
  bark: '#5a4048',
  glass: '#b8b0dc',
  iron: '#5a5266',
  timber: '#7a5566',
  stone: '#9a93ab',
};

/**
 * Model, placement reservations, collision, and break behavior by decor kind.
 * Benches topple for any vehicle. Trucks can topple trees and grave markers
 * and shatter hedges, tombs, and shelters; other solid decor remains static.
 */
export const DECOR: Readonly<Record<DecorKind, DecorSpec>> = {
  tree: {
    model: () => roundTree(),
    space: [
      around(TREE.trunk.r0 + MARGIN.trunk, 0, CROWN.y0),
      around(CROWN.out, CROWN.y0, CROWN.y1 + MARGIN.piece),
    ],
    solids: [around(TREE.trunk.r0, 0, TREE.trunk.h)],
    sight: [around(CROWN.out * SIGHT, CROWN.y0, CROWN.y1)],
    round: true,
    // Compute resting tilt from the largest crown sphere.
    hit: {
      as: 'topple',
      by: 'truck',
      boost: { above: 1, momentum: TUNING.knockdown.boosted },
      height: CROWN.y1,
      wide: CROWN.out,
      down: restTilt(TREE.crown[0][3], TREE.crown[0][1]),
      debris: [DEBRIS.leaf, DEBRIS.leaf, DEBRIS.bark],
      keep: 0.7,
    },
  },
  pine: {
    model: () => pine(),
    space: [
      around(PINE.trunk.r0 + MARGIN.trunk, 0, PINE_TIERS.y0),
      around(PINE_TIERS.out, PINE_TIERS.y0, PINE_TIERS.y1 + MARGIN.piece),
    ],
    // Restrict collision to the trunk through the second foliage tier.
    solids: [around(PINE.trunk.r0 + MARGIN.trunk, 0, PINE.tiers[1][0])],
    sight: [around(PINE_TIERS.out * SIGHT, PINE_TIERS.y0, PINE_TIERS.y1)],
    round: true,
    hit: {
      as: 'topple',
      by: 'truck',
      height: PINE_TIERS.y1,
      wide: PINE_TIERS.out,
      down: restTilt(PINE.tiers[2][1], PINE.tiers[2][0]),
      debris: [DEBRIS.leaf, DEBRIS.leaf, DEBRIS.bark],
      keep: 0.7,
    },
  },
  cypress: {
    model: () => cypress(),
    space: [
      around(
        CYPRESS_BODY.out + MARGIN.piece,
        0,
        CYPRESS_BODY.y1 + MARGIN.piece,
      ),
    ],
    // End solid collision at the centre of the broad foliage body.
    solids: [around(CYPRESS_BODY.out * SIGHT, 0, CYPRESS.body.y)],
    sight: [
      around(CYPRESS_BODY.out * SIGHT, CYPRESS_BODY.y0, CYPRESS_BODY.y1),
    ],
    round: true,
    hit: {
      as: 'topple',
      by: 'truck',
      height: CYPRESS_BODY.y1,
      wide: CYPRESS_BODY.out,
      down: restTilt(CYPRESS.body.r[0], CYPRESS.body.y),
      debris: [DEBRIS.leaf, DEBRIS.bark],
      keep: 0.75,
    },
  },
  bush: {
    model: () => bush(),
    space: [around(BUSH_REACH.out, 0, BUSH_REACH.y1)],
    solids: [],
    round: true,
  },
  hedge: {
    model: () => hedge(),
    space: [
      around(HEDGE.len / 2, 0, hedgeHeight(), HEDGE.depth / 2 + MARGIN.piece),
    ],
    solids: [around(HEDGE.len / 2, 0, hedgeHeight(), HEDGE.depth / 2)],
    hit: { as: 'shatter', by: 'truck', debris: [DEBRIS.leaf], keep: 0.85 },
  },
  flowersSlime: {
    model: () => flowers(PETALS.slime),
    space: [around(FLOWERS.mound.r[0] + MARGIN.piece, 0, FLOWER_TOP)],
    solids: [],
    round: true,
  },
  flowersPurple: {
    model: () => flowers(PETALS.purple),
    space: [around(FLOWERS.mound.r[0] + MARGIN.piece, 0, FLOWER_TOP)],
    solids: [],
    round: true,
  },
  fountain: {
    model: () => fountain(),
    space: [
      around(
        FOUNTAIN.basin.r + 2 * MARGIN.piece,
        0,
        fountainHeight() + FOUNTAIN.jet.r * FOUNTAIN.head,
      ),
    ],
    solids: fountainSolids(),
    round: true,
  },
  gazebo: {
    model: () => gazebo(),
    space: [
      around(
        GAZEBO.roof.r,
        0,
        GAZEBO.floor.h + GAZEBO.post.h + GAZEBO.roof.band + GAZEBO.roof.h,
      ),
    ],
    solids: gazeboSolids(),
  },
  shelter: {
    model: () => shelter(),
    space: [
      [
        [
          -SHELTER.w / 2 - SHELTER.roof.over,
          0,
          -SHELTER.d / 2 - SHELTER.roof.over,
        ],
        [
          SHELTER.w / 2 + SHELTER.roof.over,
          SHELTER.h + SHELTER.roof.t,
          SHELTER.d / 2 + LEGROOM,
        ],
      ],
    ],
    solids: shelterSolids(),
    hit: {
      as: 'shatter',
      by: 'truck',
      debris: [DEBRIS.glass, DEBRIS.glass, DEBRIS.iron],
      keep: 0.8,
    },
  },
  bench: {
    model: () => bench(),
    space: [
      [
        [-BENCH.len / 2 - MARGIN.piece, 0, -BENCH.depth / 2 - MARGIN.piece],
        [BENCH.len / 2 + MARGIN.piece, BENCH.back, BENCH.depth / 2 + LEGROOM],
      ],
    ],
    solids: [around(BENCH.len / 2, 0, BENCH.back, BENCH.depth / 2)],
    hit: {
      as: 'topple',
      by: 'any',
      height: BENCH.back,
      wide: BENCH.len / 2,
      down: restTilt(BENCH.depth / 2, BENCH.back),
      debris: [DEBRIS.timber],
    },
  },
  deadTree: {
    model: () => deadTree(),
    space: [
      around(DEAD_TREE.trunk.r0 + MARGIN.trunk, 0, DEAD_REACH.y0),
      around(DEAD_REACH.out, DEAD_REACH.y0, DEAD_TREE.trunk.h + MARGIN.piece),
    ],
    solids: [around(DEAD_TREE.trunk.r0, 0, DEAD_TREE.trunk.h / 2)],
    round: true,
    hit: {
      as: 'topple',
      by: 'truck',
      height: DEAD_TREE.trunk.h,
      wide: DEAD_REACH.out,
      down: restTilt(DEAD_REACH.out / 2, DEAD_TREE.trunk.h / 2),
      debris: [DEBRIS.bark, DEBRIS.bark],
      keep: 0.75,
    },
  },
  headstone: {
    model: () => headstone(),
    space: [around(HEADSTONE.w / 2, 0, HEADSTONE_TOP, HEADSTONE.d / 2)],
    solids: [around(HEADSTONE.w / 2, 0, HEADSTONE_TOP, HEADSTONE.d / 2)],
    hit: {
      as: 'topple',
      by: 'truck',
      height: HEADSTONE_TOP,
      wide: HEADSTONE.w / 2,
      down: restTilt(HEADSTONE.d / 2, HEADSTONE_TOP),
      debris: [DEBRIS.stone],
      keep: 0.85,
    },
  },
  cross: {
    model: () => cross(),
    space: [around(CROSS.post / 2, 0, CROSS.h), CROSS_ARM],
    solids: [around(CROSS.post / 2, 0, CROSS.h)],
    hit: {
      as: 'topple',
      by: 'truck',
      height: CROSS.h,
      wide: CROSS.arm.w / 2,
      down: restTilt(CROSS.post / 2, CROSS.h),
      debris: [DEBRIS.stone],
      keep: 0.85,
    },
  },
  obelisk: {
    model: () => obelisk(),
    space: OBELISK_BOXES,
    solids: OBELISK_BOXES,
    hit: {
      as: 'topple',
      by: 'truck',
      height: OBELISK_TOP,
      wide: OBELISK.base.w / 2,
      down: restTilt(OBELISK.shaft.w / 2, OBELISK_TOP),
      debris: [DEBRIS.stone],
      keep: 0.8,
    },
  },
  tomb: {
    model: () => tomb(),
    space: TOMB_BOXES,
    solids: TOMB_BOXES,
    hit: {
      as: 'shatter',
      by: 'truck',
      debris: [DEBRIS.stone, DEBRIS.stone, DEBRIS.iron],
      keep: 0.8,
    },
  },
};

/**
 * Return the break specification for this kind and scale, or null when it has
 * no break behavior or exceeds maxScale.
 */
export function hitOf(kind: DecorKind, scale = 1): DecorHit | null {
  const h = DECOR[kind].hit;
  return h && scale <= (h.maxScale ?? Infinity) ? h : null;
}
