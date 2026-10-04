import { AdditiveBlending, Mesh, MeshBasicMaterial, PlaneGeometry } from 'three';

import { TAU, type V3 } from '@/engine/core/math';
import { Rng } from '@/engine/core/rng';
import { FX_LAYER } from '@/render/layers';
import { truckLivery } from '@/render/livery';
import { withCutaway } from '@/render/materials';
import { PALETTE } from '@/render/palette';
import { radialGlowTexture } from '@/render/textures';

import { box, type Box, build, type Face, group, model, NO_CAST, type Part, SIDES, solid, torus } from './part';
import { vehicleRig, wheels, type VehicleRig, type WheelSpec } from './rig';

export const TRUCK = {
  /** Livery lettering along the sides, and the roundel number. */
  name: 'ROADIE',
  number: '30',
  /** Drip layout. */
  seed: 303,
  /** Lower tub [width, height, length]; the livery is painted on its sides. */
  tub: [2.7, 0.9, 5.3] as V3,
  /** Tub underside above the ground. */
  lift: 1.95,
  cab: [2.5, 0.95, 2.0] as V3,
  cabZ: 0.15,
  wheels: { r: 1.15, w: 1.05, track: 3.5, base: 3.8 } satisfies WheelSpec,
  lugs: 14,
  height: 4.1,
};

export type TruckParams = typeof TRUCK;

/** Slime drip hanging `len` down `b`'s face from its top edge, at `u` along the face. */
function drip(b: Box, face: Face, u: number, len: number, w: number): Part<'slime'>[] {
  const onZ = face[1] === 'z';
  const run = box(onZ ? w : 0.08, len, onZ ? 0.08 : w)
    .onFace(b, face, 0.01)
    .y(b.top - len / 2);
  const d = onZ ? run.x(u) : run.z(u);
  const blob = d.sized(d.size[0] * 1.3, w * 1.1, d.size[2] * 1.3).y(b.top - len);
  return [solid(d, 'slime', NO_CAST), solid(blob, 'slime', NO_CAST)];
}

/** Calls `fn` at random steps along `b` on `axis`, inset from both ends. */
function along(rng: Rng, b: Box, axis: 0 | 2, inset: number, step: [number, number], fn: (v: number) => void): void {
  for (let v = b.min[axis] + inset; v < b.max[axis] - inset; v += rng.range(step[0], step[1])) {
    fn(v);
  }
}

/**
 * The phantom monster truck (+Z forward): lifted slime-green frame, purple glowing rims, name/number livery with slime
 * pouring off every edge, roof light bar. The green underglow is added by buildTruckRig.
 */
export function monsterTruck(params: Partial<TruckParams> = {}) {
  const p = { ...TRUCK, ...params };
  const rng = new Rng(p.seed);
  const liv = truckLivery(p);
  const W = p.wheels;

  const beam = box(3.2, 0.3, 0.3).y(W.r);
  const tub = box(...p.tub).on(p.lift);
  const cab = box(...p.cab)
    .on(tub)
    .z(p.cabZ);
  const windows = cab.grow(0.03, -0.225, -0.25).move(0, 0.06, 0.05);
  const bed = box(2.7, 0.32, 2.05).on(tub).inside(tub, '-z', 0.025);
  const tailgate = bed.sized(2.7, 0.32, 0.16).onFace(tub, '-z', 0.05);
  const bar = box(2.2, 0.16, 0.34).on(cab).z(0.6);

  const chassis = [
    ...SIDES.map((s) =>
      solid(
        box(0.24, 0.24, 5.4)
          .x(s * 0.62)
          .on(beam),
        'frame',
      ),
    ),
    ...SIDES.map((s) => solid(beam.z((s * W.base) / 2), 'metal')),
    // shocks with glowing rings
    ...SIDES.flatMap((sx) =>
      SIDES.flatMap((sz) => {
        const shock = box(0.18, 0.95, 0.18).at(sx * 1.1, 1.75, (sz * W.base) / 2 - 0.25);
        return [
          solid(shock, 'frame'),
          solid(shock.sized(0.26, 0.08, 0.26).y(1.55), 'lightP', NO_CAST),
          solid(shock.sized(0.26, 0.08, 0.26).y(1.85), 'lightP', NO_CAST),
        ];
      }),
    ),
  ];

  const body = [
    solid(tub, ['side', 'side', 'base', 'base', 'base', 'base']),
    solid(box(2.5, 0.06, 1.7).on(tub).inside(tub, '+z', 0.05), 'hood'),
    solid(cab, ['cab', 'cab', 'base', 'base', 'base', 'base']),
    solid(windows, 'glass'),
    solid(cab.sized(2.2, 0.55, 0.08).onFace(cab, '+z', 0.02).y(windows.center[1]), 'glass'),
    // bed with glowing slime
    ...SIDES.map((s) => solid(bed.sized(0.16, 0.32, 2.05).inside(tub, s > 0 ? '+x' : '-x'), 'base')),
    solid(tailgate, 'base'),
    solid(bed.sized(2.36, 0.12, 1.9).on(tub), 'slime', NO_CAST),
    // bumpers, grille, lights
    ...(['+z', '-z'] as const).map((f) =>
      solid(
        box(2.9, 0.34, 0.36)
          .on(tub.bottom - 0.07)
          .onFace(tub, f, 0.07),
        'metal',
      ),
    ),
    solid(tub.sized(1.6, 0.5, 0.06).outside(tub, '+z').move(0, 0.05), 'metal'),
    ...SIDES.flatMap((s) => {
      const stack = box(0.2, 1.1, 0.2)
        .at(s * 1.0, 3.6, 0)
        .outside(cab, '-z');
      return [
        solid(
          tub
            .sized(0.5, 0.26, 0.08)
            .outside(tub, '+z')
            .move(s * 0.95, 0.15),
          'lightG',
          NO_CAST,
        ),
        solid(
          tub
            .sized(0.42, 0.2, 0.08)
            .outside(tub, '-z')
            .move(s * 1.0, 0.15),
          'lightP',
          NO_CAST,
        ),
        solid(stack, 'metal'),
        solid(stack.sized(0.24, 0.1, 0.24).on(stack), 'lightG', NO_CAST),
      ];
    }),
    // roof light bar
    solid(bar, 'metal'),
    ...[0, 1, 2, 3].map((i) =>
      solid(
        bar
          .sized(0.34, 0.18, 0.3)
          .onFace(bar, '+y', 0.02)
          .x((i - 1.5) * 0.52),
        'lightG',
        NO_CAST,
      ),
    ),
  ];

  // slime drips off the tub, cab and tailgate edges
  const drips: Part<'slime'>[] = [];
  for (const s of SIDES) {
    const f: Face = s > 0 ? '+x' : '-x';
    along(rng, tub, 2, 0.15, [0.25, 0.7], (z) => {
      drips.push(
        ...drip(tub, f, z, rng.chance(0.3) ? rng.range(0.5, 1.1) : rng.range(0.12, 0.35), rng.range(0.1, 0.22)),
      );
    });
    along(rng, cab, 2, 0.05, [0.3, 0.6], (z) =>
      drips.push(...drip(cab, f, z, rng.range(0.15, 0.4), rng.range(0.1, 0.18))),
    );
  }

  along(rng, tub, 0, 0.15, [0.25, 0.6], (x) => {
    drips.push(...drip(tub, '+z', x, rng.range(0.1, 0.5), rng.range(0.1, 0.2)));
    drips.push(...drip(tailgate, '-z', x, rng.range(0.15, 0.7), rng.range(0.1, 0.2)));
  });

  // fat tires with lugs and glowing rims
  const tread = Array.from({ length: p.lugs }, (_, i) => {
    const a = (i / p.lugs) * TAU;
    return solid(box(W.w * 1.02, 0.22, 0.32).at(0, Math.cos(a) * W.r, Math.sin(a) * W.r), 'tire', { rot: [a, 0, 0] });
  });
  const rims = SIDES.map((s) =>
    torus(0.62, 0.09, 8, 28, 'rim', { at: [s * (W.w / 2 + 0.02), 0, 0], rot: [0, Math.PI / 2, 0] }),
  );

  const lit = { emissive: '#ffffff', emissiveIntensity: 0.9, roughness: 0.45 };
  return model(
    {
      base: { color: '#1c0d2c', roughness: 0.45, metalness: 0.3 },
      side: { ...lit, map: liv.side.map, emissiveMap: liv.side.emissive },
      hood: { ...lit, map: liv.hood.map, emissiveMap: liv.hood.emissive },
      cab: { ...lit, map: liv.cab.map, emissiveMap: liv.cab.emissive },
      frame: { color: PALETTE.slime, emissive: '#3aa000', emissiveIntensity: 0.4, roughness: 0.4, metalness: 0.3 },
      metal: { color: '#2a2233', roughness: 0.5, metalness: 0.5 },
      glass: { color: '#0e0818', roughness: 0.1, metalness: 0.8, emissive: '#3a1870', emissiveIntensity: 0.35 },
      lightG: { color: '#e6ffc8', emissive: PALETTE.slime, emissiveIntensity: 4 },
      lightP: { color: '#f0d8ff', emissive: PALETTE.purpleHot, emissiveIntensity: 3.5 },
      slime: { color: PALETTE.slime, emissive: '#59ff00', emissiveIntensity: 1.1, roughness: 0.3, softInk: true },
      tire: { color: '#120d17', roughness: 0.95 },
      rim: { color: '#2a0d47', emissive: PALETTE.purpleHot, emissiveIntensity: 3 },
    },
    [...chassis, group({ name: 'body' }, [...body, ...drips]), ...wheels(W, 'tire', 'metal', [...tread, ...rims])],
  );
}

export function buildTruckRig(params: Partial<TruckParams> = {}): VehicleRig {
  const rig = vehicleRig(build(monsterTruck(params)), ['lightG', 'lightP'], params.height ?? TRUCK.height);
  addUnderglow(rig);
  return rig;
}

/** The truck's green underglow: additive, on the FX layer so it never gets an ink outline. */
export function addUnderglow(rig: VehicleRig): void {
  const ug = new Mesh(
    new PlaneGeometry(7.5, 9),
    withCutaway(
      new MeshBasicMaterial({
        map: radialGlowTexture(),
        color: '#6dff1a',
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        opacity: 0.75,
        toneMapped: false,
      }),
    ),
  );
  ug.rotation.x = -Math.PI / 2;
  ug.position.y = 0.06;
  ug.layers.set(FX_LAYER);
  ug.renderOrder = 3;
  rig.root.add(ug);
  rig.materials.push(ug.material);
}
