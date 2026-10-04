import { type Scene, Vector3 } from 'three';

import { Traffic } from '@/actors/traffic';
import { Vehicle } from '@/actors/vehicle';
import { CAR_KINDS, type CarKind, VEHICLE_BREEDS } from '@/actors/vehicle-breeds';
import type { AssetRegistry } from '@/assets/asset-registry';
import { TUNING } from '@/config';
import { lerp, TAU } from '@/engine/core/math';
import type { Rng } from '@/engine/core/rng';
import type { Garage } from '@/game/deck/garage';
import { CAR_COLORS } from '@/render/palette';

/**
 * Traffic top-ups: one car at most this often (s), spawned at least SPAWN_DIST from the view; extras go once DROP_DIST
 * away (m).
 */
const SPAWN_EVERY = 1.2;
const SPAWN_DIST = 55;
const DROP_DIST = 60;
/** A honk flashes the headlights twice over FLASH_TIME (s), FLASH_GLOW brighter than they were. */
const FLASH_TIME = 0.5;
const FLASH_GLOW = 4;

/** Every vehicle in the world: spawning, traffic upkeep, lights, and wrecks leaving the scene. */
export class Fleet {
  readonly vehicles: Vehicle[] = [];
  private spawnTimer = 0;
  /** Cars left in the road by drivers who ran: towed once out of sight. */
  private readonly abandoned = new Set<Vehicle>();
  /** Headlights flashing (a honk), and for how much longer (s). */
  private readonly flashes = new Map<Vehicle, number>();

  constructor(
    private readonly scene: Scene,
    private readonly assets: AssetRegistry,
    private readonly garage: Garage,
    private readonly traffic: Traffic,
    private readonly rng: Rng,
  ) {}

  /** A civilian car at `pos`; `kind` picks one, else the usual mix. */
  spawnCar(role: 'parked' | 'traffic' | 'visitor', pos: Vector3, yaw: number, kind?: CarKind): Vehicle {
    const color = this.rng.pick(CAR_COLORS);
    kind ??= this.pickKind();
    const v = new Vehicle('car', VEHICLE_BREEDS[kind].model(this.assets, color), color, role, kind);
    v.place(pos.x, pos.y, pos.z, yaw, 0, 0, null);
    v.markRest();
    v.insideDeck = this.garage.inFootprint(pos);
    this.scene.add(v.rig.root);
    this.vehicles.push(v);
    return v;
  }

  /** A kind by the breeds' shares of what spawns. */
  private pickKind(): CarKind {
    let x = this.rng.next();
    for (const kind of CAR_KINDS) {
      if ((x -= VEHICLE_BREEDS[kind].share) < 0) {
        return kind;
      }
    }

    return 'sedan';
  }

  /** A traffic car on a lane, at least `minDist` from `near`. */
  spawnTraffic(near: Vector3, minDist: number): boolean {
    const sp = this.traffic.spawnPoint(this.rng, near, minDist, this.vehicles);
    if (!sp) {
      return false;
    }

    const path = this.traffic.paths[sp.path];
    if (!path) {
      return false;
    }

    const pos = new Vector3();
    const dir = new Vector3();
    path.sample(sp.s, pos, dir);
    const v = this.spawnCar('traffic', pos, Math.atan2(dir.x, dir.z));
    v.pathIndex = sp.path;
    v.pathS = sp.s;
    v.cruise = Traffic.cruiseFor(this.rng);
    v.speed = v.cruise;
    return true;
  }

  /** A driver left `v` where it stands: it goes once nobody's looking (unless Cody takes it). */
  abandon(v: Vehicle): void {
    this.abandoned.add(v);
  }

  /** Hold traffic at the day or night count: new cars out of sight of `near`, far ones dropped. */
  maintain(dt: number, near: Vector3, day: boolean): void {
    for (const v of this.abandoned) {
      if (v.role !== 'parked') {
        this.abandoned.delete(v);
      } else if (v.pos.distanceTo(near) > DROP_DIST) {
        this.abandoned.delete(v);
        this.remove(v);
      }
    }

    this.spawnTimer -= dt;
    const target = day ? TUNING.traffic.dayCars : TUNING.traffic.nightCars;
    let live = 0;
    for (const v of this.vehicles) {
      if (v.role === 'traffic') {
        live++;
      }
    }

    if (live < target && this.spawnTimer <= 0) {
      this.spawnTimer = SPAWN_EVERY;
      this.spawnTraffic(near, SPAWN_DIST);
    } else if (live > target) {
      const far = this.vehicles.find((v) => v.role === 'traffic' && v.pos.distanceTo(near) > DROP_DIST);
      if (far) {
        this.remove(far);
      }
    }
  }

  /** Flash `v`'s headlights: its driver's honking. */
  flash(v: Vehicle): void {
    this.flashes.set(v, FLASH_TIME);
  }

  remove(v: Vehicle): void {
    this.scene.remove(v.rig.root);
    this.flashes.delete(v);
    this.garage.release(v);
    const i = this.vehicles.indexOf(v);
    if (i >= 0) {
      this.vehicles.splice(i, 1);
    }
  }

  /** Car lights follow `nightness` (and flash for a honk); crushed cars flatten and escaped trucks dissolve, then go. */
  update(dt: number, nightness: number): void {
    for (const [v, t] of this.flashes) {
      if (t > dt) {
        this.flashes.set(v, t - dt);
      } else {
        this.flashes.delete(v);
      }
    }

    // backwards, so removing one doesn't skip the next
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i] as Vehicle;
      // engine just off: the body stops buzzing
      v.settle();

      if (v.form === 'car') {
        const f = this.flashes.get(v);
        // on, off, on, off
        const flash = f !== undefined && Math.sin((f / FLASH_TIME) * TAU * 2) > 0 ? FLASH_GLOW : 0;
        for (const l of v.rig.lights) {
          l.emissiveIntensity = l.name === 'taillight' ? lerp(0.6, 1.8, nightness) : lerp(0.2, 2.8, nightness) + flash;
        }
      }

      // wrecks squash and shrink from the scale the rig was built at (sedans are built smaller than modelled)
      const base = v.rig.scale;
      if (v.status === 'crushed') {
        const t = (v.statusTime += dt);
        v.rig.root.scale.set(1.15 * base, Math.max(0.28, 1 - t * 6) * base, 1.1 * base);

        if (t > 6) {
          this.remove(v);
        }
      } else if (v.status === 'vanishing') {
        const t = (v.statusTime += dt);
        const k = Math.max(0, 1 - t * 1.6);
        v.rig.root.scale.setScalar(k * base);
        v.rig.root.position.y = v.pos.y + t * 2;

        if (k <= 0) {
          this.remove(v);
        }
      }
    }
  }
}
