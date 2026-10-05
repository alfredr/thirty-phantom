import { Vector3 } from 'three';

import type { Avoidance } from '@/actors/avoidance';
import { Keyring } from '@/actors/vehicles/ignition';
import type { Vehicle } from '@/actors/vehicles/vehicle';
import type { Walker } from '@/actors/walker';
import { TUNING } from '@/config';
import type { Rng } from '@/engine/core/rng';
import type { Polyline } from '@/engine/nav/polyline';
import { type EventOf, Mind, mind, type MindEvent, type State, type StateOf } from '@/engine/sim/mind';
import type { Visitors } from '@/game/driving/visitors';
import type { NavGrid, NavJob } from '@/world/nav-grid';

import type { Casualties, Casualty, Cause, Harm } from './casualties';

const C = TUNING.crowd;

/** Distance multiplier on ghostReach below which fleeing continues. */
const STILL_CLOSE = 1.5;
/** Running-speed multiplier after recovery from an injury. */
const LIMP = 0.55;

const _up = new Vector3();

/** Pedestrian behavior states and their retained context. */
export type Doing =
  /** Wait for `t` seconds or for a pending walking route. */
  | State<'pause', { t: number }>
  /** Follow a walking route. */
  | State<'stroll'>
  /**
   * Flee from the recorded threat position with a direct dash followed by a planned route. `t` is the remaining calm
   * timer; `fresh` selects a new running pace and emits a fright event.
   */
  | State<'flee', { from: Vector3; t: number; fresh: boolean; keysChecked: boolean }>
  /** Walk back to an associated car to depart. */
  | State<'leave'>
  /** Retain impact velocity and injury while a casualty ragdoll controls the character. */
  | State<'down', { from: Vector3; vx: number; vz: number; harm: Harm; cause: Cause; hurt: Casualty | null }>
  /** End pedestrian simulation after departure or removal. */
  | State<'gone'>;

/** Events that can interrupt pedestrian behavior. */
export type TownEvent =
  /** Report a frightening source position. */
  | MindEvent<'frightened', { from: Vector3 }>
  /** Knock the pedestrian down with the supplied impact and injury. */
  | MindEvent<'felled', { from: Vector3; vx: number; vz: number; harm: Harm; cause: Cause }>;

/** Navigation, injury, visitor, and event services available to pedestrian behavior. */
export interface Town {
  readonly nav: NavGrid;
  readonly rng: Rng;
  readonly casualties: Casualties | null;
  /** Current dynamic avoidance and visitor vehicle services. */
  readonly avoid: Avoidance | null;
  readonly visitors: Visitors | null;
  /** Return a random pause duration in seconds. */
  pause(): number;
  /** Plan a nearby walking route, or return null when no destination is available. */
  strollFrom(at: Vector3): NavJob | null;
  /** Plan a route to the car’s driver door. */
  walkTo(at: Vector3, car: Vehicle): NavJob;
  /** Return a direct escape segment over standable ground, or null when blocked immediately. */
  dash(at: Vector3, from: Vector3): Polyline | null;
  /** Plan toward a destination away from the threat, or return null. */
  fleeFrom(start: Vector3, from: Vector3): NavJob | null;
  /** Report the start of a new fright response. */
  frightAt(at: Vector3): void;
  /** Drop money at the pedestrian’s position using the threat as the directional reference. */
  dropMoney(at: Vector3, from: Vector3): void;
  dropKeys(person: Townsperson, at: Vector3): void;
}

/** A pedestrian’s behavior state, walker, health, and optional parked car. */
export class Townsperson {
  readonly keys = new Keyring();
  readonly mind: Mind<Townsperson, Doing, TownEvent>;
  /** Whether this pedestrian has already dropped money. */
  dropped = false;
  /** Selected running speed in m/s. */
  pace = 0;
  /** Injury multiplier applied when selecting a running speed. */
  limp = 1;
  /** Associated parked car, cleared if it becomes unavailable. */
  car: Vehicle | null = null;
  /** Time before returning to the car, in seconds. */
  stay = 0;
  /** Health depleted by skeleton attacks; initially 100. */
  hp = 100;

  constructor(
    readonly walker: Walker,
    readonly town: Town,
  ) {
    this.mind = new Mind<Townsperson, Doing, TownEvent>(TOWN_MIND, this, { at: 'pause', t: town.pause() });
  }

  /** Current casualty while down, or null. */
  get hurt(): Casualty | null {
    return this.mind.in('down')?.hurt ?? null;
  }

  /** Recorded threat position while fleeing, or null. */
  get threat(): Vector3 | null {
    return this.mind.in('flee')?.from ?? null;
  }
}

const pause = (p: Townsperson): StateOf<Doing, 'pause'> => ({ at: 'pause', t: p.town.pause() });
const flee = (from: Vector3, fresh: boolean): StateOf<Doing, 'flee'> => ({
  at: 'flee',
  from: from.clone(),
  t: C.calm,
  fresh,
  keysChecked: false,
});
const fall = (
  _p: Townsperson,
  _s: Doing,
  { from, vx, vz, harm, cause }: EventOf<TownEvent, 'felled'>,
): StateOf<Doing, 'down'> => ({ at: 'down', from: from.clone(), vx, vz, harm, cause, hurt: null });
const frighten = (_p: Townsperson, _s: Doing, { from }: EventOf<TownEvent, 'frightened'>): StateOf<Doing, 'flee'> =>
  flee(from, true);

/**
 * Alternate pauses and walking routes, return visitors to their cars, and interrupt these activities for fright or
 * injury. Fleeing can redirect toward a newly reported threat direction; recovered casualties flee with an injury-
 * dependent pace.
 */
export const TOWN_MIND = mind<Townsperson, Doing, TownEvent>({
  pause: {
    exit: (p) => p.walker.cancelPlan(),
    tick: (p, s, dt) => {
      const w = p.walker;
      s.t -= dt;

      if (p.car && p.stay <= 0 && !w.planning) {
        return { at: 'leave' };
      }

      const route = w.followPlanned();
      if (route === 'following') {
        return { at: 'stroll' };
      }

      if (route === 'failed') {
        s.t = p.town.pause();
      } else if (!w.planning && s.t <= 0) {
        if (!w.plan(p.town.strollFrom(w.pos), () => p.town.rng.range(C.walkPace[0], C.walkPace[1]))) {
          s.t = p.town.pause();
        }
      }

      w.update(dt, p.town.nav, p.town.avoid);
      return null;
    },
    on: { frightened: frighten, felled: fall },
  },
  stroll: {
    tick: (p, _s, dt) => {
      const w = p.walker;
      // Abandon a blocked stroll and immediately request another destination.
      if (w.blocked) {
        w.stop();
        return { at: 'pause', t: 0 };
      }

      return w.update(dt, p.town.nav, p.town.avoid) ? pause(p) : null;
    },
    on: { frightened: frighten, felled: fall },
  },
  flee: {
    enter: (p, s) => {
      const t = p.town;
      const w = p.walker;
      if (s.fresh) {
        p.pace = t.rng.range(C.runPace[0], C.runPace[1]) * p.limp;
        t.frightAt(w.pos);
      }

      if (!p.dropped && t.rng.chance(C.dropChance)) {
        p.dropped = true;
        t.dropMoney(w.pos, s.from);
      }

      // Start a direct dash while planning a longer escape route.
      const dash = t.dash(w.pos, s.from);
      if (dash) {
        w.follow(dash, p.pace);
      } else {
        w.stop();
      }

      w.plan(t.fleeFrom(dash ? dash.end : w.pos, s.from), p.pace);
    },
    exit: (p) => p.walker.cancelPlan(),
    tick: (p, s, dt) => {
      const w = p.walker;
      s.t -= dt;
      w.followPlanned(true);

      if (!s.keysChecked && w.walking) {
        s.keysChecked = true;

        if (p.keys.held.size && p.town.rng.chance(C.keyDropChance)) {
          p.town.dropKeys(p, w.pos);
        }
      }

      const close = w.pos.distanceTo(s.from) < C.ghostReach * STILL_CLOSE;
      // Continue fleeing if the route ends too close to the recorded threat.
      if (!w.walking && !w.planning) {
        if (close) {
          return flee(s.from, false);
        }

        w.stop();
        return pause(p);
      }

      if (s.t <= 0 && !close) {
        w.stop();
        return pause(p);
      }

      if (w.blocked) {
        w.stop();
      }

      w.update(dt, p.town.nav, p.town.avoid);
      return null;
    },
    on: {
      // Redirect only when the new threat differs by more than a right angle; otherwise refresh the calm timer.

      frightened: (p, s, { from }) => {
        const at = p.walker.pos;
        if ((at.x - s.from.x) * (at.x - from.x) + (at.z - s.from.z) * (at.z - from.z) < 0) {
          return flee(from, false);
        }

        s.t = C.calm;
        return null;
      },
      felled: fall,
    },
  },
  leave: {
    enter: (p) => {
      if (p.car) {
        p.walker.plan(p.town.walkTo(p.walker.pos, p.car), () => p.town.rng.range(C.walkPace[0], C.walkPace[1]));
      }
    },
    exit: (p) => p.walker.cancelPlan(),
    tick: (p, _s, dt) => {
      const w = p.walker;
      if (w.followPlanned() === 'failed') {
        p.car = null;
      }

      const car = p.car;
      // Resume pedestrian behavior after losing access to the car.
      if (!car) {
        return w.walking ? { at: 'stroll' } : pause(p);
      }

      if (w.blocked && !w.planning) {
        // Replan a blocked return route from the current position.
        w.plan(p.town.walkTo(w.pos, car), () => p.town.rng.range(C.walkPace[0], C.walkPace[1]));
      } else if (w.update(dt, p.town.nav, p.town.avoid)) {
        if (p.town.visitors?.leave(car, p.keys)) {
          return { at: 'gone' };
        }

        p.car = null;
        return pause(p);
      }

      return null;
    },
    on: { frightened: frighten, felled: fall },
  },
  down: {
    enter: (p, s) => {
      const w = p.walker;
      w.stop();

      if (!p.dropped) {
        p.dropped = true;
        p.town.dropMoney(w.pos, s.from);
      }

      s.hurt = p.town.casualties?.strike(w.rig, s.vx, s.vz, s.harm, s.cause) ?? null;

      if (s.harm === 'dead') {
        p.town.dropKeys(p, w.pos);
      }
    },
    // Recover when ready, then flee from the impact source with an injury-dependent pace.
    tick: (p, s) => {
      const c = p.town.casualties;
      if (s.hurt?.harm === 'dead') {
        p.town.dropKeys(p, s.hurt.at);
      }

      if (!s.hurt || !c) {
        return flee(s.from, true);
      }

      if (!c.ready(s.hurt)) {
        return null;
      }

      p.limp = s.hurt.harm === 'injured' ? LIMP : 1;
      const yaw = c.recover(s.hurt, _up);
      p.walker.place(_up, yaw);
      return flee(s.from, true);
    },
  },
  gone: {},
});
