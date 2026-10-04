import { Vector3 } from 'three';

import type { Avoidance } from '@/actors/avoidance';
import type { Vehicle } from '@/actors/vehicle';
import type { Walker } from '@/actors/walker';
import { TUNING } from '@/config';
import type { Rng } from '@/engine/core/rng';
import type { Polyline } from '@/engine/nav/polyline';
import { type EventOf, Mind, mind, type MindEvent, type State, type StateOf } from '@/engine/sim/mind';
import type { Visitors } from '@/game/driving/visitors';
import type { NavGrid, NavJob } from '@/world/nav-grid';

import type { Casualties, Casualty, Harm } from './casualties';

const C = TUNING.crowd;

/** Still this close to the threat (in ghost reaches) when a run ends: keep running. */
const STILL_CLOSE = 1.5;
/** An injured person back on their feet runs at this share of their pace. */
const LIMP = 0.55;

const _up = new Vector3();

/** What someone in town is doing, and what each part holds while it lasts. */
export type Doing =
  /** Standing about for `t` more seconds, or waiting on a route to somewhere to stroll to. */
  | State<'pause', { t: number }>
  /** Strolling a route somewhere. */
  | State<'stroll'>
  /**
   * Running from what's at `from`: a straight dash away first, then the route planned meanwhile by the walker. They
   * calm down `t` seconds after the last fright, once well away. `fresh`: a new fright, not a turn away from a new side
   * of one they're already running from.
   */
  | State<'flee', { from: Vector3; t: number; fresh: boolean }>
  /** Walking back to their car to drive off in it. */
  | State<'leave'>
  /** Knocked off their feet, moving (vx, vz), by something at `from`: the ragdoll has them till they can get up. */
  | State<'down', { from: Vector3; vx: number; vz: number; harm: Harm; hurt: Casualty | null }>
  /** Drove off: off the street for good. */
  | State<'gone'>;

/** What can happen to someone in town. Each state moves only on the ones it lists. */
export type TownEvent =
  /** Something frightening at `from`: phantom Cody, a skeleton, a car driven at them, a shove, a claw. */
  | MindEvent<'frightened', { from: Vector3 }>
  /** Knocked off their feet: run over, or clawed down. */
  | MindEvent<'felled', { from: Vector3; vx: number; vz: number; harm: Harm }>;

/** What the people in town share: the town itself, as their minds use it. */
export interface Town {
  readonly nav: NavGrid;
  readonly rng: Rng;
  readonly casualties: Casualties | null;
  /** Who's about to steer round this frame, and the visitors' cars, as the frame has them. */
  readonly avoid: Avoidance | null;
  readonly visitors: Visitors | null;
  /** A pause's length (s). */
  pause(): number;
  /** A route to stroll to somewhere near `at`, or null if there's nowhere to go. */
  strollFrom(at: Vector3): NavJob | null;
  /** A route from `at` to `car`'s driver's door. */
  walkTo(at: Vector3, car: Vehicle): NavJob;
  /** A straight line away from `from`, as far as the ground allows, or null if they can't get going that way. */
  dash(at: Vector3, from: Vector3): Polyline | null;
  /** A route from `start` to somewhere well away from `from`, or null if there's nowhere. */
  fleeFrom(start: Vector3, from: Vector3): NavJob | null;
  /** Someone at `at` took fright and started running. */
  frightAt(at: Vector3): void;
  /** Someone at `at` drops their money as they run from `from`. */
  dropMoney(at: Vector3, from: Vector3): void;
}

/** Someone in town, on foot. */
export class Townsperson {
  readonly mind: Mind<Townsperson, Doing, TownEvent>;
  /** Dropped their money already (once each). */
  dropped = false;
  /** Their running pace (m/s), picked when a fright starts. */
  pace = 0;
  /** Running pace scale: an injured person limps. */
  limp = 1;
  /** The car they drove in and left parked, while it's still where they left it. */
  car: Vehicle | null = null;
  /** Seconds before they head back to it and drive off. */
  stay = 0;
  /** Out of 100: skeletons' claws take it down (Crowd.maul). */
  hp = 100;

  constructor(
    readonly walker: Walker,
    readonly town: Town,
  ) {
    this.mind = new Mind<Townsperson, Doing, TownEvent>(TOWN_MIND, this, { at: 'pause', t: town.pause() });
  }

  /** Down, the ragdoll that has them; else null. */
  get hurt(): Casualty | null {
    return this.mind.in('down')?.hurt ?? null;
  }

  /** What they're running from, while they're running. */
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
});
const fall = (
  _p: Townsperson,
  _s: Doing,
  { from, vx, vz, harm }: EventOf<TownEvent, 'felled'>,
): StateOf<Doing, 'down'> => ({ at: 'down', from: from.clone(), vx, vz, harm, hurt: null });
const frighten = (_p: Townsperson, _s: Doing, { from }: EventOf<TownEvent, 'frightened'>): StateOf<Doing, 'flee'> =>
  flee(from, true);

/**
 * A townsperson's mind: they stand about, stroll from spot to spot, and after a while walk back to their car and drive
 * off. A fright sends them running from wherever they are (again, from a new side, if it heads them off), and a car or
 * a claw can knock them off their feet.
 */
export const TOWN_MIND = mind<Townsperson, Doing, TownEvent>({
  pause: {
    exit: (p) => p.walker.cancelPlan(),
    tick: (p, s, dt) => {
      const w = p.walker;
      s.t -= dt;

      // time to go: back to the car
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
      // held up too long: give it up and pick somewhere else
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

      // bolt away at once, with a proper route to somewhere well away planned meanwhile
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
      const close = w.pos.distanceTo(s.from) < C.ghostReach * STILL_CLOSE;
      // the run ended: further if the threat's still about, else catch their breath
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
      // already running: they keep at it, and turn to run from this instead only when it's off to a
      // new side (more than a right angle from what they ran from), so a fright that heads them off
      // sends them another way
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
      // no way back to it, or it's gone (stolen, towed): stay a pedestrian
      if (!car) {
        return w.walking ? { at: 'stroll' } : pause(p);
      }

      if (w.blocked && !w.planning) {
        // something's parked in the way since: a fresh route round it
        w.plan(p.town.walkTo(w.pos, car), () => p.town.rng.range(C.walkPace[0], C.walkPace[1]));
      } else if (w.update(dt, p.town.nav, p.town.avoid)) {
        if (p.town.visitors?.leave(car)) {
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

      s.hurt = p.town.casualties?.strike(w.rig, s.vx, s.vz, s.harm) ?? null;
    },
    // up once able (an injured one limps off), running from what hit them
    tick: (p, s) => {
      const c = p.town.casualties;
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
