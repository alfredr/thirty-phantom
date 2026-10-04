import { Vector3 } from 'three';

import type { Vehicle } from '@/actors/vehicle';
import { TUNING } from '@/config';
import { mind, type MindEvent, type State, type StateOf } from '@/engine/sim/mind';
import type { SpotRuntime } from '@/game/deck/garage';

import type { Valet, ValetDrive } from './valet';

const T = TUNING.valet;
/** Arrival tolerance at the podium, in meters. */
const HOME_EPS = 0.5;

const _ahead = new Vector3();

/** Valet job states and their retained assignment data. */
export type Job =
  /** Hide the valet while off shift. */
  | State<'off'>
  /** Wait for a car assignment at the stand. */
  | State<'idle'>
  /** Walk to the assigned car. */
  | State<'toCar', { car: Vehicle; spot: SpotRuntime }>
  /** Wait for the boarding animation delay. */
  | State<'boarding', { car: Vehicle; spot: SpotRuntime; t: number }>
  /** Run the vehicle’s parking job. */
  | State<'driving', { car: Vehicle; spot: SpotRuntime; drive: ValetDrive }>
  /** Return to the stand after completing or abandoning a job. */
  | State<'returning'>;

/** Conversation attention, independent of the parking job. */
export type Attention =
  | State<'free'>
  /** Face the position returned by the conversation target. */
  | State<'facing', { who: () => Vector3 }>;

/** Events shared by the job and attention state machines. Each state handles only its declared events. */
export type ValetEvent =
  /** Assign a car and destination spot. */
  | MindEvent<'handedCar', { car: Vehicle; spot: SpotRuntime }>
  /** Cancel the assignment because Cody took the car. */
  | MindEvent<'carjacked'>
  /** Begin facing a conversation target whose position can change. */
  | MindEvent<'talk', { who: () => Vector3 }>
  /** Release conversation attention. */
  | MindEvent<'talkEnded'>;

const returning = (): StateOf<Job, 'returning'> => ({ at: 'returning' });

/** Accept assignments while idle or returning, then walk, board, drive, and return. */
export const VALET_JOB = mind<Valet, Job, ValetEvent>({
  off: {
    enter: (v) => {
      v.walker.rig.root.visible = false;
    },
    exit: (v) => {
      v.walker.place(v.home, v.homeYaw);
      v.walker.rig.root.visible = true;
    },
    tick: (v) => (v.crew.day ? { at: 'idle' } : null),
  },
  idle: {
    tick: (v, _s, dt) => {
      const talking = !!v.attention.in('facing');
      // Wait for the conversation to end before hiding the off-shift valet.
      if (!v.crew.day && !talking) {
        return { at: 'off' };
      }

      v.walker.update(dt, v.crew.nav);

      if (!talking) {
        v.idleAnim();
      }

      return null;
    },
    on: { handedCar: (_v, _s, { car, spot }) => ({ at: 'toCar', car, spot }) },
  },
  toCar: {
    enter: (v, s) => {
      v.walker.plan(v.crew.walkTo(v, v.crew.doorOf(s.car)), T.walkPace);
    },
    exit: (v) => v.walker.cancelPlan(),
    tick: (v, s, dt) => {
      const w = v.walker;
      if (w.followPlanned() === 'failed') {
        w.place(v.crew.doorOf(s.car), s.car.yaw);
      }

      if (!w.update(dt, v.crew.nav, v.crew.avoid) && (w.planning || w.walking)) {
        return null;
      }

      w.face(s.car.pos);
      return { at: 'boarding', car: s.car, spot: s.spot, t: 0 };
    },
    on: { carjacked: returning },
  },
  boarding: {
    tick: (v, s, dt) => {
      v.walker.update(dt, v.crew.nav);

      if ((s.t += dt) <= T.boardTime) {
        return null;
      }

      const drive = v.crew.startDrive(s.car, s.spot);
      if (drive) {
        return { at: 'driving', car: s.car, spot: s.spot, drive };
      }

      v.crew.drop(s.car);
      return returning();
    },
    on: { carjacked: returning },
  },
  driving: {
    enter: (v) => {
      v.walker.rig.root.visible = false;
    },
    // Restore the visible walker beside the car on every driving exit.
    exit: (v, s) => {
      v.walker.place(v.crew.doorOf(s.car), s.car.yaw + Math.PI / 2);
      v.walker.rig.root.visible = true;
    },
    tick: (v, s) => {
      if (v.crew.driving(s.drive)) {
        return null;
      }

      v.badged = s.drive.badged;

      if (s.drive.parked) {
        v.crew.parked(v, s.car, s.spot);
      } else {
        v.crew.drop(s.car);
      }

      return returning();
    },
    on: { carjacked: returning },
  },
  returning: {
    enter: (v) => {
      v.crew.jobOver(v);
      v.walker.plan(v.crew.walkTo(v, v.home), T.jogPace);
    },
    exit: (v) => v.walker.cancelPlan(),
    tick: (v, _s, dt) => {
      const w = v.walker;
      if (w.followPlanned() === 'failed') {
        w.place(v.home, v.homeYaw);
      }

      if (v.attention.in('facing')) {
        w.stop();
        w.update(dt, v.crew.nav);
        return null;
      }

      if (
        w.update(dt, v.crew.nav, v.crew.avoid) ||
        (!w.planning && !w.walking && w.pos.distanceTo(v.home) < HOME_EPS)
      ) {
        w.face(_ahead.set(v.home.x + Math.sin(v.homeYaw), v.home.y, v.home.z + Math.cos(v.homeYaw)));
        return { at: 'idle' };
      }

      // Resume the return route after an interruption.
      if (!w.planning && !w.walking) {
        w.plan(v.crew.walkTo(v, v.home), T.jogPace);
      }

      return null;
    },

    on: { handedCar: (_v, _s, { car, spot }) => ({ at: 'toCar', car, spot }) },
  },
});

/** Track conversation facing independently; a new car assignment releases that attention. */
export const VALET_ATTENTION = mind<Valet, Attention, ValetEvent>({
  free: {
    on: { talk: (_v, _s, { who }) => ({ at: 'facing', who }) },
  },
  facing: {
    tick: (v, s) => {
      v.walker.face(s.who());
      return null;
    },
    on: {
      talkEnded: () => ({ at: 'free' }),
      handedCar: () => ({ at: 'free' }),
    },
  },
});
