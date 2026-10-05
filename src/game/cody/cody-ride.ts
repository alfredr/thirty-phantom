import { type Scene, Vector3 } from 'three';

import type { Player } from '@/actors/player';
import type { Keyring } from '@/actors/vehicles/ignition';
import type { Vehicle } from '@/actors/vehicles/vehicle';
import { TUNING } from '@/config';
import type { Emitter } from '@/engine/core/events';
import type { V3 } from '@/engine/core/math';
import type { CollisionWorld } from '@/engine/physics/collision';
import type { Claims } from '@/engine/sim/claims';
import { Mind, mind, type State } from '@/engine/sim/mind';
import type { Garage, SpotRuntime } from '@/game/deck/garage';
import type { TransformSequence } from '@/game/deck/transform-sequence';
import type { Money } from '@/game/items/money';
import type { ClaimKind } from '@/game/rules/claim-kinds';
import type { WorldConditions } from '@/game/rules/world-conditions';

import type { CodyState } from './cody-state';

/** Distance beyond the vehicle’s side used for exiting, in meters. */
const DOOR_GAP = 1;
const _door = new Vector3();

type RideState =
  | State<'onFoot'>
  | State<'changing', { seq: TransformSequence }>
  /** Seconds left rolling after an escape; null until the truck escapes. */
  | State<'driving', { v: Vehicle; escape: number | null }>;

/** A lesson may block entry or restrict it to one vehicle until Cody hotwires it. */
export type VehicleAccess = 'any' | 'none' | Vehicle;

export type RideEvents = {
  /** `from` is the previous driver role, or null when a car Cody already drives transforms at moonrise. */
  entered: { v: Vehicle; possessed: boolean; from: Vehicle['role'] | null; quiet: boolean };
  /** Cody is back on foot; the car may have been parked in a deck spot. */
  exited: { v: Vehicle; spot: SpotRuntime | null; quiet: boolean };
  /** Report where an escaped vehicle disappears. */
  vanished: { at: Vector3 };
  hotwired: { v: Vehicle };
};

interface RideWorld {
  readonly keys: Keyring;
  readonly player: Player;
  readonly cody: CodyState;
  readonly conditions: WorldConditions;
  readonly claims: Claims<ClaimKind>;
  readonly garage: Garage;
  readonly collision: CollisionWorld;
  readonly scene: Scene;
  readonly money: Money;
  readonly vehicles: readonly Vehicle[];
  readonly events: Pick<Emitter<RideEvents & { money: { kind: 'glovebox'; amount: number } }>, 'emit'>;
  carjacked(car: Vehicle): void;
  bail(car: Vehicle): void;
  transform(car: Vehicle): TransformSequence;
  onFoot(dt: number): void;
  drive(car: Vehicle, dt: number): void;
}

/** Owns Cody's seat, vehicle transitions, and the escape roll for his current drive. */
export class CodyRide {
  access: VehicleAccess = 'any';
  private readonly seat = { name: 'Cody at the wheel' };
  private readonly states = mind<CodyRide, RideState>({
    onFoot: {
      tick: (r, _s, dt) => {
        r.world.onFoot(dt);
        return null;
      },
    },
    changing: {
      tick: (_r, s, dt) => {
        s.seq.update(dt);
        return s.seq.done ? { at: 'driving', v: s.seq.vehicle, escape: null } : null;
      },
    },
    driving: {
      tick: (r, s, dt) => {
        r.world.drive(s.v, dt);

        if (r.driving === s.v && s.escape !== null) {
          s.escape -= dt;

          if (s.escape < 0 && s.v.grounded) {
            r.vanish(s.v);
          }
        }

        return null;
      },
    },
  });
  private readonly mind = new Mind<CodyRide, RideState>(this.states, this, { at: 'onFoot' });

  constructor(private readonly world: RideWorld) {}

  get driving(): Vehicle | null {
    return this.mind.in('driving')?.v ?? null;
  }
  get transform(): TransformSequence | null {
    return this.mind.in('changing')?.seq ?? null;
  }
  get vehicle(): Vehicle | null {
    return this.driving ?? this.transform?.vehicle ?? null;
  }
  get onFoot(): boolean {
    return !!this.mind.in('onFoot');
  }
  get escaping(): boolean {
    const drive = this.mind.in('driving');
    return !!drive && drive.escape !== null;
  }

  tick(dt: number): void {
    this.mind.tick(dt);
  }

  /** Shared by the interaction prompt and boarding. */
  possessable(car: Vehicle): boolean {
    return (
      this.access === 'any' &&
      car.form === 'car' &&
      car.insideDeck &&
      this.world.conditions.deckAwake() &&
      this.world.cody.can('possess')
    );
  }

  canEnter(car: Vehicle): boolean {
    return this.access === 'any' || this.access === car;
  }

  canHotwire(car: Vehicle): boolean {
    return (
      this.driving === car &&
      car.form === 'car' &&
      !car.ignition.ready &&
      this.canEnter(car) &&
      this.world.cody.can('steal')
    );
  }

  hotwire(car: Vehicle): boolean {
    if (!this.canHotwire(car)) {
      return false;
    }

    car.ignition.hotwired = true;

    if (this.access === car) {
      this.access = 'any';
    }

    this.world.events.emit('hotwired', { v: car });

    if (this.possessable(car)) {
      this.change(car);
      this.world.events.emit('entered', { v: car, possessed: true, from: null, quiet: true });
    }

    return true;
  }

  /**
   * Board for a script, bypassing entry restrictions and supplying keys from an absent owner. Owned cars have no
   * glovebox reward.
   */
  board(car: Vehicle, own = false): void {
    if (this.driving === car) {
      return;
    }

    if (this.driving) {
      this.exit(true);
    }

    if (own) {
      this.world.money.empty(car);
    }

    car.ignition.transfer('away', this.world.keys);

    this.takeSeat(car, true);
  }

  enter(car: Vehicle): void {
    if (this.canEnter(car)) {
      this.takeSeat(car, false);
    }
  }

  exit(quiet = false): void {
    const car = this.driving;
    if (!car) {
      return;
    }

    const { player, claims, garage, collision, scene, events } = this.world;
    this.mind.go({ at: 'onFoot' });
    claims.release(this.seat);
    car.vel.set(0, 0, 0);
    car.speed = 0;
    car.role = 'parked';
    car.ignition.take(this.world.keys);
    let parkedIn: SpotRuntime | null = null;
    if (car.insideDeck) {
      const spot = garage.spotAt(car.pos);
      if (spot && garage.isFree(spot, car)) {
        const flip = Math.cos(car.yaw - spot.def.yaw) < 0;
        car.place(spot.center.x, spot.center.y, spot.center.z, spot.def.yaw + (flip ? Math.PI : 0), 0, 0, null);
        garage.occupy(spot, car);
        parkedIn = spot;
      } else {
        garage.release(car);
      }
    }

    car.markRest();
    const side = car.params.radius + DOOR_GAP;
    const pos: V3 = [car.pos.x + Math.cos(car.yaw) * side, car.pos.y, car.pos.z - Math.sin(car.yaw) * side];
    collision.resolveCircle(pos, TUNING.player.radius, TUNING.player.height, TUNING.player.stepUp);
    _door.set(pos[0], collision.groundAt(pos[0], pos[2], car.pos.y + 0.5, 1), pos[2]);
    player.dismount(scene);
    player.place(_door, car.yaw);
    player.visible = true;
    events.emit('exited', { v: car, spot: parkedIn, quiet });
  }

  /** Moonrise also transforms cars outside the deck when Cody is already driving them. */
  moonrise(): void {
    const car = this.driving;
    if (!car || car.form !== 'car' || !car.ignition.ready) {
      return;
    }

    if (car.rig.rider) {
      this.world.player.dismount(this.world.scene);
      this.world.player.visible = false;
    }

    this.change(car);
    this.world.events.emit('entered', { v: car, possessed: true, from: null, quiet: true });
  }

  escaped(): void {
    const drive = this.mind.in('driving');
    const delay = drive?.v.breed.phantom?.vanishAfter;
    if (drive && delay !== undefined) {
      drive.escape = delay;
    }
  }

  /** Nearest civilian car within valet reach for which Cody has the keys. */
  carForValet(): Vehicle | null {
    let nearest: Vehicle | null = null;
    let distance: number = TUNING.valet.carReach;
    const at = this.driving?.pos ?? this.world.player.pos;
    for (const car of this.world.vehicles) {
      const mine = car.ignition.heldBy(this.world.keys) || (car === this.driving && car.ignition.heldBy('ignition'));
      if (
        !mine ||
        car.form !== 'car' ||
        car.status ||
        car.insideDeck ||
        (car.role !== 'parked' && car !== this.driving)
      ) {
        continue;
      }

      const d = at.distanceTo(car.pos);
      if (d < distance) {
        nearest = car;
        distance = d;
      }
    }

    return nearest;
  }

  handOff(car: Vehicle, to: Keyring): void {
    if (this.driving === car) {
      this.exit();
    }

    car.ignition.transfer(this.world.keys, to);
  }

  private takeSeat(car: Vehicle, quiet: boolean): void {
    const { player, cody, claims, money, events } = this.world;
    const from = car.role;
    // Seize keys still in the ignition before a carjacked driver can take them.
    car.ignition.take(this.world.keys);
    claims.take('driverSeat', cody, car, { owner: this.seat, preempt: true });
    player.visible = false;

    if (from === 'valet') {
      this.world.carjacked(car);
    }

    if (from === 'parked' || from === 'traffic' || from === 'valet' || from === 'visitor') {
      car.markRest();
    }

    if (from === 'traffic' || from === 'visitor') {
      this.world.bail(car);
    }

    car.ignition.insert(this.world.keys);

    // Taking the seat stops AI driving immediately, including while the car transforms.
    car.role = 'player';
    const possessed = this.possessable(car);
    let found = 0;
    if (possessed) {
      this.change(car);
    } else {
      found = money.glovebox(car);
      this.mind.go({ at: 'driving', v: car, escape: null });

      if (car.rig.rider) {
        player.mount(car.rig.rider.saddle);
      }
    }

    events.emit('entered', { v: car, possessed, from, quiet });

    if (found) {
      events.emit('money', { kind: 'glovebox', amount: found });
    }
  }

  private change(car: Vehicle): void {
    this.mind.go({ at: 'changing', seq: this.world.transform(car) });
  }

  private vanish(car: Vehicle): void {
    this.world.events.emit('vanished', { at: car.pos.clone() });
    this.exit();
    car.setStatus('vanishing');
  }
}
