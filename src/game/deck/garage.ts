import {
  AdditiveBlending,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Vector3,
} from 'three';

import type { VehicleRig } from '@/actors/models/rig';
import { buildTruckRig } from '@/actors/models/truck';
import type { Vehicle } from '@/actors/vehicles/vehicle';
import { FX_LAYER, GHOST_LAYER } from '@/render/layers';
import { withCutaway } from '@/render/materials';
import { radialGlowTexture } from '@/render/textures';
import type { Gates } from '@/world/gates';
import type { DeckNav, SpotDef, ZoneDef } from '@/world/level-data';

/** Use purple for ordinary spots and green for phantom spots. */
const SPOT_GLOW = new Color('#9b3cf0');
const PHANTOM_GLOW = new Color('#7dff1a');

export interface SpotRuntime {
  def: SpotDef;
  center: Vector3;
  occupant: Vehicle | null;
  phantom: Group | null;
  glow: Mesh;
  glowMat: MeshBasicMaterial;
}

/** Test whether `p` lies inside the painted rectangle and within 1.2 meters of its floor. */
export function inSpot(s: SpotRuntime, p: Vector3): boolean {
  const [w, d] = s.def.size;
  return Math.abs(p.x - s.center.x) < w / 2 && Math.abs(p.z - s.center.z) < d / 2 && Math.abs(p.y - s.center.y) < 1.2;
}

/** Format spot and level numbers for display, converting both from zero-based indices. */
export function spotLabel(s: SpotRuntime): string {
  return `SPOT ${s.def.id + 1}, LEVEL ${s.def.level + 1}`;
}

/** Vertical extent of a spot region below and above its floor, in meters. */
const SPOT_BELOW = 0.3;
const SPOT_ABOVE = 2;

/** Build a spot region with horizontal padding in meters; negative padding shrinks it. */
export function spotZone(s: SpotRuntime, pad: number): ZoneDef {
  const [w, d] = s.def.size;
  const c = s.center;
  return {
    min: [c.x - w / 2 - pad, c.y - SPOT_BELOW, c.z - d / 2 - pad],
    max: [c.x + w / 2 + pad, c.y + SPOT_ABOVE, c.z + d / 2 + pad],
  };
}

export type CrossingKind = 'logged-in' | 'logged-out' | 'escaped' | 'snuck-in';

export interface Crossing {
  vehicle: Vehicle;
  kind: CrossingKind;
}

/**
 * Track badge counts, physical occupancy, and phantom imprints. Phantom occupancy is the badge count minus the number
 * of vehicles physically inside.
 */
export class Garage {
  readonly root = new Group();
  readonly spots: SpotRuntime[];
  logged = 0;
  phantoms = 0;
  private readonly ghostMat: MeshStandardMaterial;
  private readonly phantomRigs: { g: Group; base: number; phase: number }[] = [];
  private t = 0;

  constructor(
    defs: SpotDef[],
    readonly nav: DeckNav,
    private readonly gates: Gates,
    private readonly makeTruck: () => VehicleRig = buildTruckRig,
  ) {
    const tex = radialGlowTexture();
    this.spots = defs.map((def) => {
      const glowMat = withCutaway(
        new MeshBasicMaterial({
          map: tex,
          color: SPOT_GLOW,
          transparent: true,
          blending: AdditiveBlending,
          depthWrite: false,
          opacity: 0,
          toneMapped: false,
        }),
      );
      const glow = new Mesh(new PlaneGeometry(def.size[0] * 1.3, def.size[1] * 1.2), glowMat);
      glow.rotation.x = -Math.PI / 2;
      glow.position.set(def.center[0], def.center[1] + 0.06, def.center[2]);
      glow.layers.set(FX_LAYER);
      glow.renderOrder = 2;
      this.root.add(glow);
      return { def, center: new Vector3(...def.center), occupant: null, phantom: null, glow, glowMat };
    });
    this.ghostMat = withCutaway(
      new MeshStandardMaterial({
        color: '#0c2a02',
        emissive: PHANTOM_GLOW,
        emissiveIntensity: 0.65,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        roughness: 0.3,
      }),
    );
  }

  inFootprint(p: Vector3): boolean {
    const { min, max } = this.nav;
    return p.x > min[0] && p.x < max[0] && p.z > min[2] && p.z < max[2] && p.y < max[1];
  }

  /** Count vehicles inside the deck, excluding removed vehicles. */
  actual(vehicles: Vehicle[]): number {
    let n = 0;
    for (const v of vehicles) {
      if (v.insideDeck && !v.gone) {
        n++;
      }
    }

    return n;
  }

  phantomOccupancy(vehicles: Vehicle[]): number {
    return this.logged - this.actual(vehicles);
  }

  spotAt(p: Vector3): SpotRuntime | null {
    return this.spots.find((s) => inSpot(s, p)) ?? null;
  }

  /** Return the spot’s reservation holder. The game supplies the claim lookup. */
  bookedBy: (s: SpotRuntime) => object | null = () => null;
  /** Return a vehicle physically standing in the spot, including one not registered as its occupant. */
  standingIn: (s: SpotRuntime) => Vehicle | null = () => null;

  /**
   * Test availability against phantoms, occupants, reservations, and physically present vehicles. Ignore `except` in
   * vehicle checks.
   */
  isFree(s: SpotRuntime, except?: Vehicle): boolean {
    const booked = this.bookedBy(s);
    const there = this.standingIn(s);
    return (
      !s.phantom &&
      (!s.occupant || s.occupant === except) &&
      (!booked || booked === except) &&
      (!there || there === except)
    );
  }

  /** Return the nearest available spot, restricting the search when `floor` is non-null. */
  nearestFree(p: Vector3, floor: number | null): SpotRuntime | null {
    let best: SpotRuntime | null = null;
    let bd = Infinity;
    for (const s of this.spots) {
      if (!this.isFree(s)) {
        continue;
      }

      if (floor !== null && s.def.level !== floor) {
        continue;
      }

      const d = s.center.distanceToSquared(p);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }

    return best;
  }

  /** Return available spots across all floors. */
  freeSpots(): SpotRuntime[] {
    return this.spots.filter((s) => this.isFree(s));
  }

  /** Return an available spot on the highest floor, breaking ties by lowest spot ID. */
  topFree(): SpotRuntime | null {
    let best: SpotRuntime | null = null;
    for (const s of this.spots) {
      if (!this.isFree(s)) {
        continue;
      }

      if (!best || s.def.level > best.def.level || (s.def.level === best.def.level && s.def.id < best.def.id)) {
        best = s;
      }
    }

    return best;
  }

  floorOf(y: number): number {
    let best = 0;
    for (let i = 0; i < this.nav.floors.length; i++) {
      if (y >= (this.nav.floors[i] as number) - 1.5) {
        best = i;
      }
    }

    return best;
  }

  /** Detect footprint crossings and classify them against the badge gates. */
  track(v: Vehicle, prev: Vector3): Crossing | null {
    const inside = this.inFootprint(v.pos);
    if (inside === v.insideDeck) {
      return null;
    }

    v.insideDeck = inside;
    const gate = this.gates.inZone(v.pos) ?? this.gates.inZone(prev);
    if (gate) {
      gate.flash = 1.2;

      if (inside) {
        this.logged++;
        return { vehicle: v, kind: 'logged-in' };
      }

      this.logged--;
      return { vehicle: v, kind: 'logged-out' };
    }

    return { vehicle: v, kind: inside ? 'snuck-in' : 'escaped' };
  }

  occupy(s: SpotRuntime, v: Vehicle): void {
    this.release(v);
    s.occupant = v;
    v.homeSpot = s.def.id;
  }

  /** Park `v` in `s` as if it had badged in through the gate. */
  checkIn(s: SpotRuntime, v: Vehicle): void {
    this.occupy(s, v);
    this.logged++;
  }

  release(v: Vehicle): void {
    for (const o of this.spots) {
      if (o.occupant === v) {
        o.occupant = null;
      }
    }
  }

  /** Create a phantom truck at the spot, or at `at` when there is no spot. */
  addPhantom(at: Vector3, yaw: number, spot: SpotRuntime | null): Group {
    const rig = this.makeTruck();
    rig.root.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh && m.layers.isEnabled(0)) {
        m.material = this.ghostMat;
        m.castShadow = false;
        // Render after the sky band because the transparent ghost does not write depth.
        m.layers.set(GHOST_LAYER);
      }
    });
    rig.root.position.copy(spot ? spot.center : at);
    rig.root.rotation.y = spot
      ? Math.abs(Math.cos(yaw - spot.def.yaw)) > 0.5
        ? Math.cos(yaw - spot.def.yaw) > 0
          ? spot.def.yaw
          : spot.def.yaw + Math.PI
        : spot.def.yaw
      : yaw;
    this.root.add(rig.root);
    this.phantomRigs.push({ g: rig.root, base: rig.root.position.y, phase: Math.random() * 6 });

    if (spot) {
      spot.phantom = rig.root;
    }

    this.phantoms++;
    return rig.root;
  }

  /** @param beacon Whether to pulse the glow of available spots. */
  update(dt: number, beacon: boolean, nightness: number): void {
    this.t += dt;

    for (const s of this.spots) {
      const free = this.isFree(s);
      const target = s.phantom
        ? 0.5
        : beacon && free
          ? 0.55 + Math.sin(this.t * 4 + s.def.id) * 0.25
          : 0.12 + nightness * 0.1;
      s.glowMat.opacity += (target - s.glowMat.opacity) * Math.min(1, dt * 5);
      s.glowMat.color.copy(s.phantom ? PHANTOM_GLOW : SPOT_GLOW);
    }

    for (const p of this.phantomRigs) {
      p.g.position.y = p.base + 0.25 + Math.sin(this.t * 1.6 + p.phase) * 0.18;
    }

    this.ghostMat.emissiveIntensity = 0.55 + Math.sin(this.t * 5) * 0.08 + Math.random() * 0.06;
  }
}
