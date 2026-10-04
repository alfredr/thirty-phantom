import { Vector3 } from 'three';

import { RouteCursor } from '@/engine/nav/polyline';
import type { NavJob, NavPlanner, NavProfile, NavQuery } from '@/world/nav-grid';

/** Replan when the goal changes, when the driver strays this far, or this often anyway. */
const STRAY = 7;
const REFRESH = 6;
const LOOK_AHEAD = 10;
const NO_QUERY: NavQuery = {};

/**
 * The HUD arrow's route: planned with the shared planner and followed with a cursor, so it points along the real way
 * there (up the right ramp, through the entry gate) instead of straight at the goal.
 */
export class RouteGuide {
  private job: NavJob | null = null;
  private cursor: RouteCursor | null = null;
  private key = '';
  private age = 0;
  private readonly out = new Vector3();

  constructor(private readonly planner: NavPlanner) {}

  /** Point to aim at. Until the first plan lands it aims straight at the goal. */
  update(dt: number, from: Vector3, goal: Vector3, key: string, p: NavProfile, q: NavQuery = NO_QUERY): Vector3 {
    this.age += dt;

    if (key !== this.key) {
      this.reset();
      this.key = key;
    }

    if (this.job?.settled) {
      if (this.job.path) {
        this.cursor = new RouteCursor(this.job.path);
      }

      this.job = null;
    }

    const strayed = this.cursor ? this.cursor.offset(from) > STRAY : false;
    if (!this.job && (!this.cursor || strayed || this.age > REFRESH)) {
      this.age = 0;
      this.job = this.planner.request(from, goal, p, q);
    }

    if (!this.cursor) {
      return goal;
    }

    this.cursor.track(from);
    return this.cursor.ahead(LOOK_AHEAD, this.out);
  }

  /** Drop the route (no goal right now). */
  reset(): void {
    this.job?.cancel();
    this.job = null;
    this.cursor = null;
    this.key = '';
    this.age = 0;
  }
}
