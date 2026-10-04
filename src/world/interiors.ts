import { Color, Group, Mesh, MeshStandardMaterial, type Vector3 } from 'three';
import { clamp, lerp } from '../engine/core/math';
import { facadeUniforms, LIVE_MAX } from '../render/facade';
import { boxFaces, GeometryBatch } from '../render/geometry';
import { FACADE_GLOW, LAMP_GLASS, withCutaway, type MaterialLibrary } from '../render/materials';
import { coplanarHoles } from './coplanar';
import type { Elevators } from './elevators';
import { facadeFaces, facadeOf } from './facade-layout';
import type { Interior } from './interior-layout';

/**
 * When rooms are built: Cody on foot within `near` m of a building's footprint,
 * between `floor` m under its ground floor and that far over its top walkable
 * floor; dropped past `far`.
 */
const LIVE = { near: 14, far: 22, floor: 3 };

/**
 * The panes in a live building's windows: a lavender sky tint like the facade
 * shader's glass, see-through enough to show the rooms, a little glossy.
 */
const PANE = { color: '#5c5c8f', roughness: 0.3, metalness: 0.25 };
/**
 * How opaque the panes are: by day mostly sky reflection like the facade's
 * glass, at night clearer onto the lit rooms (following the 'windows' channel).
 */
const PANE_OPACITY = { day: 0.62, night: 0.3 };

/**
 * Walk-in buildings' rooms, built only while Cody is near one (up to LIVE_MAX
 * at a time) and thrown away when he leaves. Their collision is in the level
 * from the start (build-world.ts), so walkers use them either way; while a
 * building is live its facade opens its glass and doors onto the real rooms
 * (which bring panes of their own), and its elevator's cab and doors are drawn;
 * until then its windows show interior-mapped rooms.
 */
export class Interiors {
  readonly root = new Group();
  private readonly live = new Map<number, Group>();
  private readonly paints = new Map<string, Color>();
  private readonly order: number[] = [];
  private readonly glass: MeshStandardMaterial;
  /** The rooms' lamps: lamp glass of their own, left out of the ink (they glow; a draw call saved per building). */
  private readonly lamps: MeshStandardMaterial;
  private elevators: Elevators | null = null;
  /** Each interior's elevator, by index into the level's elevators (-1 for none). */
  private lifts: number[] = [];

  constructor(
    readonly all: readonly Interior[],
    private readonly mats: MaterialLibrary,
  ) {
    this.root.name = 'interiors';
    this.glass = withCutaway(new MeshStandardMaterial({ ...PANE, opacity: PANE_OPACITY.night, transparent: true, depthWrite: false }));
    this.glass.name = 'pane';
    // see-through: no ink of its own, so the rooms behind keep theirs
    this.glass.userData.noInk = true;
    const lamp = mats.get('lampWarm');
    this.lamps = withCutaway(lamp.clone());
    this.lamps.name = 'roomLamp';
    this.lamps.userData.noInk = true;
    mats.register(this.lamps, 'lamps', LAMP_GLASS.warm.emissiveIntensity);
  }

  /** The game's elevators (built after the world): each walk-in's own is drawn only while the building is live. */
  attach(elevators: Elevators): void {
    this.elevators = elevators;
    this.lifts = this.all.map((it) => {
      const l = it.lift;
      if (!l) return -1;
      return elevators.list.findIndex((e) => Math.abs(e.def.min[0] - l.min[0]) < 1e-3 && Math.abs(e.def.min[2] - l.min[2]) < 1e-3 && Math.abs(e.def.max[0] - l.max[0]) < 1e-3);
    });
  }

  /** Which buildings are live, by index into `all`. */
  get active(): readonly number[] {
    return this.order;
  }

  /** Build the rooms of the walk-ins nearest `at` (Cody's feet, or null when he's driving or not playing); drop the rest. */
  update(at: Vector3 | null): void {
    const want: { i: number; d: number }[] = [];
    if (at) {
      this.all.forEach((it, i) => {
        if (at.y < it.floor - LIVE.floor || at.y > it.top + LIVE.floor) return;
        const [x0, , z0] = it.def.min;
        const [x1, , z1] = it.def.max;
        const d = Math.hypot(Math.max(x0 - at.x, 0, at.x - x1), Math.max(z0 - at.z, 0, at.z - z1));
        if (d < (this.live.has(i) ? LIVE.far : LIVE.near)) want.push({ i, d });
      });
      want.sort((a, b) => a.d - b.d);
      want.length = Math.min(want.length, LIVE_MAX);
    }
    for (const [i, g] of this.live) {
      if (want.some((w) => w.i === i)) continue;
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
    // the panes follow the windows channel, as the facade's glass does
    const night = clamp(this.mats.get('facadeA').emissiveIntensity / FACADE_GLOW, 0, 1);
    this.glass.opacity = lerp(PANE_OPACITY.day, PANE_OPACITY.night, night);
    // open the live buildings' facades onto their rooms, close the rest
    for (let k = 0; k < LIVE_MAX; k++) {
      const it = this.all[this.order[k] ?? -1];
      const rect = facadeUniforms.uLiveRect.value[k];
      if (it) rect?.set(it.def.min[0], it.def.min[2], it.def.max[0], it.def.max[2]);
      else rect?.set(0, 0, -1, -1);
      facadeUniforms.uLiveTop.value[k] = it ? it.top : -1;
    }
  }

  private showLift(i: number, y: number | null): void {
    const e = this.lifts[i] ?? -1;
    if (e >= 0) this.elevators?.show(e, y);
  }

  /** One mesh per material: the painted rooms in the facade material, the lamps, and the panes. */
  private build(it: Interior): Group {
    const g = new Group();
    g.name = `interior ${it.def.use}`;
    // where boxes meet flush (trim on trim, a fitting against a wall), one face gives way, as in the level
    const holes = coplanarHoles(it.rooms.map((b) => ({ min: b.min, max: b.max, faces: boxFaces(b.min), yields: false })));
    const batches = new Map<string, { key: Interior['rooms'][number]['mat']; batch: GeometryBatch }>();
    it.rooms.forEach((b, i) => {
      const name = this.mats.get(b.mat).name;
      let e = batches.get(name);
      if (!e) batches.set(name, (e = { key: b.mat, batch: new GeometryBatch() }));
      const fac = facadeOf(b);
      const color = fac?.paint ? this.paint(fac.paint) : WHITE;
      e.batch.box(b.min, b.max, color, 1, true, { map: fac ? facadeFaces(b, fac) : undefined, holes: (f) => holes.get(i * 6 + f) });
    });
    for (const { key, batch } of batches.values()) {
      const m = new Mesh(batch.build(), key === 'lampWarm' ? this.lamps : this.mats.get(key));
      // indoors: the sun doesn't reach, so nothing in here needs to cast a shadow
      m.receiveShadow = true;
      g.add(m);
    }
    if (it.panes.length) {
      const panes = new GeometryBatch();
      // shaded darker toward the bottom, as the facade's glass reflects more sky toward the top
      for (const b of it.panes) panes.box(b.min, b.max, WHITE, 1, true);
      const m = new Mesh(panes.build(), this.glass);
      m.name = 'panes';
      g.add(m);
    }
    return g;
  }

  private paint(hex: string): Color {
    let c = this.paints.get(hex);
    if (!c) this.paints.set(hex, (c = new Color(hex)));
    return c;
  }
}

const WHITE = new Color(1, 1, 1);
