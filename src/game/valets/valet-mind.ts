import { Vector3 } from 'three';
import type { Vehicle } from '../../actors/vehicle';
import { TUNING } from '../../config';
import { mind } from '../../engine/sim/mind';
import type { NavJob } from '../../world/nav-grid';
import type { SpotRuntime } from '../deck/garage';
import type { Valet, ValetDrive } from './valet';

const T = TUNING.valet;
/** Back home once within this of the podium spot. */
const HOME_EPS = 0.5;

const _ahead = new Vector3();

/** What a valet's doing, and what each part of the job holds while it lasts. */
export type Job = {
  /** Night: the crew's inside. */
  off: object;
  /** At the stand, waiting for keys. */
  idle: object;
  /** Walking to the car he's been handed. */
  toCar: { car: Vehicle; spot: SpotRuntime; walk: NavJob | null };
  /** At the door, getting in. */
  boarding: { car: Vehicle; spot: SpotRuntime; t: number };
  /** At the wheel. */
  driving: { car: Vehicle; spot: SpotRuntime; drive: ValetDrive };
  /** Walking back to the stand. */
  returning: { walk: NavJob | null };
};

/** Whether he's paying anyone attention. */
export type Attention = {
  free: object;
  /** Turned to someone talking to him: he stands where he is and faces them. */
  facing: { who: () => Vector3 };
};

/** What can happen to a valet. Either of his minds can be sent any of these; each moves only on the ones its state lists. */
export type ValetEvents = {
  /** Someone's handed him keys to park `car` in `spot`. */
  handedCar: { car: Vehicle; spot: SpotRuntime };
  /** The car's gone from under him: Cody took it. */
  carjacked: object;
  /** Someone's started talking to him, from wherever `who` says. */
  talk: { who: () => Vector3 };
  /** They've stopped. */
  talkEnded: object;
};

const returning = (): { at: 'returning'; walk: null } => ({ at: 'returning', walk: null });

/** The job. Being handed a car moves him only while he's free for it: at the stand, or on his way back. */
export const VALET_JOB = mind<Valet, Job, ValetEvents>({
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
      // closing time: the crew goes inside, once he's done talking
      if (!v.crew.day && !talking) return { at: 'off' };
      v.walker.update(dt, v.crew.nav);
      if (!talking) v.idleAnim();
      return null;
    },
    on: { handedCar: (_v, _s, { car, spot }) => ({ at: 'toCar', car, spot, walk: null }) },
  },
  toCar: {
    enter: (v, s) => {
      s.walk = v.crew.walkTo(v, v.crew.doorOf(s.car));
    },
    exit: (_v, s) => s.walk?.cancel(),
    tick: (v, s, dt) => {
      const w = v.walker;
      if (s.walk?.settled) {
        if (s.walk.path) w.follow(s.walk.path, T.walkPace);
        else w.place(v.crew.doorOf(s.car), s.car.yaw);
        s.walk = null;
      }
      if (!w.update(dt, v.crew.nav, v.crew.avoid) && (s.walk || w.walking)) return null;
      w.face(s.car.pos);
      return { at: 'boarding', car: s.car, spot: s.spot, t: 0 };
    },
    on: { carjacked: returning },
  },
  boarding: {
    tick: (v, s, dt) => {
      v.walker.update(dt, v.crew.nav);
      if ((s.t += dt) <= T.boardTime) return null;
      const drive = v.crew.startDrive(s.car, s.spot);
      if (drive) return { at: 'driving', car: s.car, spot: s.spot, drive };
      v.crew.drop(s.car);
      return returning();
    },
    on: { carjacked: returning },
  },
  driving: {
    enter: (v) => {
      v.walker.rig.root.visible = false;
    },
    // out of the car, in its spot or not: he's beside it
    exit: (v, s) => {
      v.walker.place(v.crew.doorOf(s.car), s.car.yaw + Math.PI / 2);
      v.walker.rig.root.visible = true;
    },
    tick: (v, s) => {
      if (v.crew.driving(s.drive)) return null;
      v.badged = s.drive.badged;
      if (s.drive.parked) v.crew.parked(v, s.car, s.spot);
      else v.crew.drop(s.car);
      return returning();
    },
    on: { carjacked: returning },
  },
  returning: {
    enter: (v, s) => {
      s.walk = v.crew.walkTo(v, v.home);
    },
    exit: (_v, s) => s.walk?.cancel(),
    tick: (v, s, dt) => {
      const w = v.walker;
      if (s.walk?.settled) {
        if (s.walk.path) w.follow(s.walk.path, T.jogPace);
        else w.place(v.home, v.homeYaw);
        s.walk = null;
      }
      if (v.attention.in('facing')) {
        w.stop();
        w.update(dt, v.crew.nav);
        return null;
      }
      if (w.update(dt, v.crew.nav, v.crew.avoid) || (!s.walk && !w.walking && w.pos.distanceTo(v.home) < HOME_EPS)) {
        w.face(_ahead.set(v.home.x + Math.sin(v.homeYaw), v.home.y, v.home.z + Math.cos(v.homeYaw)));
        return { at: 'idle' };
      }
      // stopped short (a conversation, a replan): head home again
      if (!s.walk && !w.walking) s.walk = v.crew.walkTo(v, v.home);
      return null;
    },
    // a bribe turns him round
    on: { handedCar: (_v, _s, { car, spot }) => ({ at: 'toCar', car, spot, walk: null }) },
  },
});

/** His attention, side by side with the job: a talk turns him to face someone without touching what he's doing. */
export const VALET_ATTENTION = mind<Valet, Attention, ValetEvents>({
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
