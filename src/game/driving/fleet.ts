import { type Scene, Vector3 } from 'three';

import { CAR_KINDS, type CarKind, VEHICLE_BREEDS } from '@/actors/vehicles/breeds';
import { Traffic } from '@/actors/vehicles/traffic';
import { Vehicle } from '@/actors/vehicles/vehicle';
import type { AssetRegistry } from '@/assets/asset-registry';
import { TUNING } from '@/config';
import { lerp, TAU } from '@/engine/core/math';
import type { Rng } from '@/engine/core/rng';
import type { Garage } from '@/game/deck/garage';
import { CAR_COLORS } from '@/render/palette';

/** Traffic replenishment interval in seconds and spawn/removal distances from the view target in meters. */
const SPAWN_EVERY = 1.2;
const SPAWN_DIST = 55;
const DROP_DIST = 60;
/** Headlight flash duration in seconds and added emissive intensity; two pulses accompany a honk. */
const FLASH_TIME = 0.5;
const FLASH_GLOW = 4;

/** Manage vehicle creation, traffic population, lighting, and removal animations. */
export class Fleet {
  readonly vehicles: Vehicle[] = [];
  private spawnTimer = 0;
  /** Abandoned parked cars eligible for removal beyond DROP_DIST. */
  private readonly abandoned = new Set<Vehicle>();
  /** Remaining headlight flash duration in seconds. */
  private readonly flashes = new Map<Vehicle, number>();

  constructor(
    private readonly scene: Scene,
    private readonly assets: AssetRegistry,
    private readonly garage: Garage,
    private readonly traffic: Traffic,
    private readonly rng: Rng,
  ) {}

  /** Create a civilian vehicle at `pos`, using the supplied kind or the weighted breed distribution. */
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

  /** Select a breed by spawn share, falling back to sedan. */
  private pickKind(): CarKind {
    let x = this.rng.next();
    for (const kind of CAR_KINDS) {
      if ((x -= VEHICLE_BREEDS[kind].share) < 0) {
        return kind;
      }
    }

    return 'sedan';
  }

  /** Spawn traffic on a clear lane at least `minDist` meters from `near`; return whether spawning succeeded. */
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

  /** Mark a car for distant removal while it remains parked. */
  abandon(v: Vehicle): void {
    this.abandoned.add(v);
  }

  /** Adjust traffic toward the day/night target and remove distant abandoned cars. */
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

  /** Start or restart a headlight flash. */
  flash(v: Vehicle): void {
    this.flashes.set(v, FLASH_TIME);
  }

  remove(v: Vehicle): void {
    v.ignition.dispose();
    this.scene.remove(v.rig.root);
    this.flashes.delete(v);
    this.garage.release(v);
    const i = this.vehicles.indexOf(v);
    if (i >= 0) {
      this.vehicles.splice(i, 1);
    }
  }

  /** Update lighting and removal animations for crushed cars and vanishing trucks. */
  update(dt: number, nightness: number): void {
    for (const [v, t] of this.flashes) {
      if (t > dt) {
        this.flashes.set(v, t - dt);
      } else {
        this.flashes.delete(v);
      }
    }

    // Iterate backward because removal mutates the vehicle array.
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i] as Vehicle;
      // Restore idle rig pose after engine animation.
      v.settle();

      if (v.form === 'car') {
        const f = this.flashes.get(v);

        const flash = f !== undefined && Math.sin((f / FLASH_TIME) * TAU * 2) > 0 ? FLASH_GLOW : 0;
        for (const l of v.rig.lights) {
          l.emissiveIntensity = l.name === 'taillight' ? lerp(0.6, 1.8, nightness) : lerp(0.2, 2.8, nightness) + flash;
        }
      }

      // Apply removal scaling relative to the rig’s native scale.
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
