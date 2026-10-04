import { Color, Group, Mesh, MeshStandardMaterial, type Vector3 } from 'three';

import { clamp, lerp } from '@/engine/core/math';
import { facadeUniforms, LIVE_MAX } from '@/render/facade';
import { boxFaces, GeometryBatch } from '@/render/geometry';
import { FACADE_GLOW, LAMP_GLASS, withCutaway, type MaterialLibrary } from '@/render/materials';

import { coplanarHoles } from './coplanar';
import type { Elevators } from './elevators';
import { facadeFaces, facadeOf } from './facade-layout';
import type { Interior } from './interior-layout';

/**
 * Interior activation distances in meters. Activate within `near` of the footprint and retain until `far`; allow
 * `floor` meters of vertical margin below the ground floor and above the highest walkable floor.
 */
const LIVE = { near: 14, far: 22, floor: 3 };

/** Window-pane material settings matching the facade shader's sky tint and reflectivity. */
const PANE = { color: '#5c5c8f', roughness: 0.3, metalness: 0.25 };
/** Pane opacity at the day and night endpoints of the windows channel. Lower night opacity reveals lit interiors. */
const PANE_OPACITY = { day: 0.62, night: 0.3 };

/**
 * Create and dispose interior render geometry near Cody, retaining at most LIVE_MAX buildings. Collision remains
 * present independently in build-world.ts. Active interiors replace the facade's simulated windows with physical rooms
 * and panes, and enable their elevator cab and landing geometry.
 */
export class Interiors {
  readonly root = new Group();
  private readonly live = new Map<number, Group>();
  private readonly paints = new Map<string, Color>();
  private readonly order: number[] = [];
  private readonly glass: MeshStandardMaterial;
  /** Shared interior lamp material excluded from the outline normal pass. */
  private readonly lamps: MeshStandardMaterial;
  private elevators: Elevators | null = null;
  /** Each interior's elevator, by index into the level's elevators (-1 for none). */
  private lifts: number[] = [];

  constructor(
    readonly all: readonly Interior[],
    private readonly mats: MaterialLibrary,
  ) {
    this.root.name = 'interiors';
    this.glass = withCutaway(
      new MeshStandardMaterial({ ...PANE, opacity: PANE_OPACITY.night, transparent: true, depthWrite: false }),
    );
    this.glass.name = 'pane';
    // Exclude transparent panes from normals so outlines on interior surfaces remain visible.
    this.glass.userData.noInk = true;
    const lamp = mats.get('lampWarm');
    this.lamps = withCutaway(lamp.clone());
    this.lamps.name = 'roomLamp';
    this.lamps.userData.noInk = true;
    mats.register(this.lamps, 'lamps', LAMP_GLASS.warm.emissiveIntensity);
  }

  /** Associate interiors with the game's elevators so active buildings can control cab and landing visibility. */
  attach(elevators: Elevators): void {
    this.elevators = elevators;
    this.lifts = this.all.map((it) => {
      const l = it.lift;
      if (!l) {
        return -1;
      }

      return elevators.list.findIndex(
        (e) =>
          Math.abs(e.def.min[0] - l.min[0]) < 1e-3 &&
          Math.abs(e.def.min[2] - l.min[2]) < 1e-3 &&
          Math.abs(e.def.max[0] - l.max[0]) < 1e-3,
      );
    });
  }

  /** Which buildings are live, by index into `all`. */
  get active(): readonly number[] {
    return this.order;
  }

  /**
   * Retain the nearest eligible interiors to `at`, updating facade openings and elevator visibility. Pass Cody's foot
   * position while walking, or null to dispose all active interiors.
   */
  update(at: Vector3 | null): void {
    const want: { i: number; d: number }[] = [];
    if (at) {
      this.all.forEach((it, i) => {
        if (at.y < it.floor - LIVE.floor || at.y > it.top + LIVE.floor) {
          return;
        }

        const [x0, , z0] = it.def.min;
        const [x1, , z1] = it.def.max;
        const d = Math.hypot(Math.max(x0 - at.x, 0, at.x - x1), Math.max(z0 - at.z, 0, at.z - z1));
        if (d < (this.live.has(i) ? LIVE.far : LIVE.near)) {
          want.push({ i, d });
        }
      });
      want.sort((a, b) => a.d - b.d);
      want.length = Math.min(want.length, LIVE_MAX);
    }

    for (const [i, g] of this.live) {
      if (want.some((w) => w.i === i)) {
        continue;
      }

      this.root.remove(g);
      g.traverse((o) => (o as Mesh).isMesh && (o as Mesh).geometry.dispose());
      this.live.delete(i);
      this.showLift(i, null);
    }

    this.order.length = 0;

    for (const { i } of want) {
      const it = this.all[i] as Interior;
      if (!this.live.has(i)) {
        const g = this.build(it);
        this.live.set(i, g);
        this.root.add(g);
      }

      this.showLift(i, at?.y ?? null);
      this.order.push(i);
    }

    // Match pane opacity to the facade's current windows-channel intensity.
    const night = clamp(this.mats.get('facadeA').emissiveIntensity / FACADE_GLOW, 0, 1);
    this.glass.opacity = lerp(PANE_OPACITY.day, PANE_OPACITY.night, night);

    // Restrict facade openings to the active interior slots.
    for (let k = 0; k < LIVE_MAX; k++) {
      const it = this.all[this.order[k] ?? -1];
      const rect = facadeUniforms.uLiveRect.value[k];
      if (it) {
        rect?.set(it.def.min[0], it.def.min[2], it.def.max[0], it.def.max[2]);
      } else {
        rect?.set(0, 0, -1, -1);
      }

      facadeUniforms.uLiveTop.value[k] = it ? it.top : -1;
    }
  }

  private showLift(i: number, y: number | null): void {
    const e = this.lifts[i] ?? -1;
    if (e >= 0) {
      this.elevators?.show(e, y);
    }
  }

  /** Build batched interior meshes and optional transparent panes. Remove overlapping coplanar faces before batching. */
  private build(it: Interior): Group {
    const g = new Group();
    g.name = `interior ${it.def.use}`;
    // Remove coplanar overlaps to prevent z-fighting where fittings meet walls.
    const holes = coplanarHoles(
      it.rooms.map((b) => ({ min: b.min, max: b.max, faces: boxFaces(b.min), yields: false })),
    );
    const batches = new Map<string, { key: Interior['rooms'][number]['mat']; batch: GeometryBatch }>();
    it.rooms.forEach((b, i) => {
      const name = this.mats.get(b.mat).name;
      let e = batches.get(name);
      if (!e) {
        batches.set(name, (e = { key: b.mat, batch: new GeometryBatch() }));
      }

      const fac = facadeOf(b);
      const color = fac?.paint ? this.paint(fac.paint) : WHITE;
      e.batch.box(b.min, b.max, color, 1, true, {
        map: fac ? facadeFaces(b, fac) : undefined,
        holes: (f) => holes.get(i * 6 + f),
      });
    });

    for (const { key, batch } of batches.values()) {
      const m = new Mesh(batch.build(), key === 'lampWarm' ? this.lamps : this.mats.get(key));
      // Interior meshes receive shadows but do not add shadow-map draw calls.
      m.receiveShadow = true;
      g.add(m);
    }

    if (it.panes.length) {
      const panes = new GeometryBatch();
      // Darken pane bottoms to match the facade's stronger sky reflection near the top.
      for (const b of it.panes) {
        panes.box(b.min, b.max, WHITE, 1, true);
      }

      const m = new Mesh(panes.build(), this.glass);
      m.name = 'panes';
      g.add(m);
    }

    return g;
  }

  private paint(hex: string): Color {
    let c = this.paints.get(hex);
    if (!c) {
      this.paints.set(hex, (c = new Color(hex)));
    }

    return c;
  }
}

const WHITE = new Color(1, 1, 1);
