import { type Color, Vector3 } from 'three';

import type { DriveEvents, Vehicle } from '@/actors/vehicles/vehicle';
import type { Emitter } from '@/engine/core/events';
import type { Solid } from '@/engine/physics/collision';
import type { Garage } from '@/game/deck/garage';
import type { Junk } from '@/game/items/junk';
import type { BuiltWorld } from '@/world/build-world';
import type { PropKind } from '@/world/props';

import { carContacts } from './collisions';
import type { Fleet } from './fleet';

export type ImpactEvents = {
  /**
   * Velocity change or landing speed in m/s. dv is the larger received or
   * dealt change; took is the received change.
   */
  impact: {
    v: Vehicle;
    at: Vector3;
    dv: number;
    took: number;
    against: 'car' | 'wall' | 'ground';
  };
  /**
   * Prop damage and lamp landings. Positions, shatter bounds, and light colors
   * are copied from the simulation.
   */
  prop:
    | { how: 'knocked'; kind: PropKind; at: Vector3; by: Vehicle | null }
    | {
        how: 'shattered';
        kind: PropKind;
        at: Vector3;
        by: Vehicle | null;
        min: Vector3;
        max: Vector3;
      }
    | { how: 'landed'; kind: PropKind; at: Vector3; light: Color };
  smashed: { at: Vector3; by: Vehicle };
  crushed: { car: Vehicle; by: Vehicle };
};

interface ImpactCallbacks {
  bail(car: Vehicle, from: Vector3): void;
  fell(car: Vehicle): void;
}

const _at = new Vector3();
const _hardest = new Vector3();

/**
 * Apply collision consequences and keep uncontrolled wrecks moving until their
 * drivers can leave.
 */
export class VehicleImpacts {
  private readonly shaken = new Map<Vehicle, Vector3>();

  constructor(
    private readonly world: Pick<
      BuiltWorld,
      'collision' | 'props' | 'breakables'
    >,
    private readonly fleet: Pick<Fleet, 'vehicles' | 'abandon'>,
    private readonly garage: Pick<Garage, 'inFootprint'>,
    private readonly junk: Pick<Junk, 'hit' | 'crushed'>,
    private readonly events: Pick<Emitter<ImpactEvents>, 'emit'>,
    private readonly callbacks: ImpactCallbacks,
  ) {
    const props = world.props;
    props.onLanded = () => {
      if (props.landedKind) {
        this.events.emit('prop', {
          kind: props.landedKind,
          at: props.landed.clone(),
          how: 'landed',
          light: props.landedColor.clone(),
        });
      }
    };

    props.onBroken = () => {
      const lo = props.brokenMin;
      const hi = props.brokenMax;
      const by = this.fleet.vehicles.find((v) => v === props.brokenBy) ?? null;
      if (props.brokenKind) {
        this.events.emit('prop', {
          kind: props.brokenKind,
          at: new Vector3().lerpVectors(lo, hi, 0.5),
          how: 'shattered',
          by,
          min: lo.clone(),
          max: hi.clone(),
        });
      }
    };
  }

  /**
   * Wait for an uncontrolled car to settle before releasing its driver. Copy
   * the threat's current position.
   */
  deferBail(car: Vehicle, from: Vector3): void {
    this.shaken.set(car, from.clone());
  }

  /**
   * Step wrecks not already moved this frame. Settled drivers leave during
   * play if their car still exists.
   */
  update(dt: number, playing: boolean): void {
    for (const v of this.fleet.vehicles) {
      if (!v.crashing || v.role === 'player' || v.gone || v.steppedThisFrame) {
        continue;
      }

      this.afterDrive(v, v.drive(dt, null, this.world.collision));
      // A tumbling wreck changes physical deck presence without recording a gate crossing.
      v.insideDeck = this.garage.inFootprint(v.pos);
    }

    for (const [car, from] of this.shaken) {
      if (!car.resting) {
        continue;
      }

      this.shaken.delete(car);

      if (playing && this.fleet.vehicles.includes(car)) {
        this.callbacks.bail(car, from);
      }
    }
  }

  /**
   * Handle damage and contacts after movement. loosen is the velocity-change
   * threshold in m/s for visitor drivers.
   */
  afterDrive(v: Vehicle, ev: DriveEvents, loosen = 0): void {
    for (const s of ev.smashed) {
      if (s.knockdown) {
        this.knockProp(s, v);
      } else {
        this.smash(s.id, v);
      }
    }

    if (ev.impact > 0) {
      this.events.emit('impact', {
        v,
        at: v.pos.clone(),
        dv: ev.impact,
        took: ev.impact,
        against: 'wall',
      });
    }

    if (ev.landed > 0) {
      this.events.emit('impact', {
        v,
        at: v.pos.clone(),
        dv: ev.landed,
        took: ev.landed,
        against: 'ground',
      });
    }

    if (!(v.crashing && v.resting)) {
      this.contacts(v, loosen);
    }

    if (ev.landed > (v.breed.landingTolerance ?? Infinity) && !v.gone) {
      v.setStatus('crushed');
      this.crushed(v, v);
      this.callbacks.fell(v);
      v.role = 'parked';
    }
  }

  repair(): void {
    for (const b of this.world.breakables) {
      b.broken = false;
      b.solid.enabled = true;
      b.group.visible = true;
    }

    this.world.props.repair();
  }

  private contacts(v: Vehicle, loosen: number): void {
    let dealt = 0;
    const dv = carContacts(
      v,
      this.fleet.vehicles,
      (o) => v.breed.crush?.hit(v, o, this.crushed) ?? false,
      (o, odv) => {
        // Traffic leaves its lane on any displacement; visitors use the caller's threshold.
        if (o.role === 'traffic' || odv >= loosen) {
          this.knocked(o, v);
        }

        _at.lerpVectors(v.pos, o.pos, 0.5);
        this.junk.hit(o, _at, odv);
        this.junk.hit(v, _at, odv);

        if (odv > dealt) {
          dealt = odv;
          _hardest.copy(_at);
        }
      },
    );

    if (dv > 0 || dealt > 0) {
      this.events.emit('impact', {
        v,
        at: dealt > 0 ? _hardest.clone() : v.pos.clone(),
        dv: Math.max(dv, dealt),
        took: dv,
        against: 'car',
      });
    }
  }

  private knocked(car: Vehicle, by: Vehicle): void {
    if (car.role !== 'traffic' && car.role !== 'visitor') {
      return;
    }

    car.role = 'parked';
    this.fleet.abandon(car);
    this.deferBail(car, by.pos);
  }

  private smash(solidId: number, v: Vehicle): void {
    const piece = this.world.breakables.find((b) => b.solid.id === solidId);
    if (!piece || piece.broken) {
      return;
    }

    piece.broken = true;
    piece.group.visible = false;
    this.events.emit('smashed', { at: piece.center.clone(), by: v });
  }

  private knockProp(s: Solid, v: Vehicle): void {
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    const side =
      ((s.min[0] + s.max[0]) / 2 - v.pos.x) * -fz +
      ((s.min[2] + s.max[2]) / 2 - v.pos.z) * fx;
    const kick =
      (side === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(side)) *
      Math.hypot(v.vel.x, v.vel.z) *
      0.8;
    const kind = this.world.props.knock(
      s.id,
      v.vel.x - fz * kick,
      v.vel.z + fx * kick,
      v,
    );
    if (!kind) {
      return;
    }

    const k = kind.keep ?? v.breed.knockKeep;
    v.vel.x *= k;
    v.vel.z *= k;

    // Shattering already reports through props.onBroken.
    if (kind.shatter) {
      return;
    }

    this.events.emit('prop', {
      kind,
      at: new Vector3(
        (s.min[0] + s.max[0]) / 2,
        v.pos.y + 1,
        (s.min[2] + s.max[2]) / 2,
      ),
      how: 'knocked',
      by: v,
    });
  }

  private readonly crushed = (car: Vehicle, by: Vehicle): void => {
    this.events.emit('crushed', { car, by });
    this.junk.crushed(car);
  };
}
