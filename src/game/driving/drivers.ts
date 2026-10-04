import type { Vector3 } from 'three';

import type { Vehicle } from '@/actors/vehicle';
import { Doing } from '@/engine/sim/action';

import type { DriverJob, DriveWorld } from './drive-actions';

/**
 * Every AI driver's job at the wheel, run on one runner: scared drivers making for the deck, valets parking, visitors
 * coming and going. Whoever starts a job keeps it to see how it went; this is where the game finds the job driving a
 * car, to tell its driver what they can see.
 */
export class Drivers {
  private readonly doing: Doing<DriveWorld, DriveWorld>;
  private jobs: DriverJob[] = [];

  constructor(private readonly world: DriveWorld) {
    this.doing = new Doing({
      lost: (owner) => world.claims.lostBy(owner),
      end: (owner) => world.claims.release(owner),
    });
  }

  /** Starts `job`. False if it couldn't (its first step failed). */
  start(job: DriverJob): boolean {
    const result = this.doing.do(this.world, job);
    if ('fail' in result) {
      return false;
    }

    if ('running' in result) {
      this.jobs.push(job);
    }

    return true;
  }

  /** Whether `job` is still going. */
  running(job: DriverJob): boolean {
    return this.jobs.includes(job);
  }

  /** The job driving `car`, if an AI driver has it. */
  of(car: Vehicle): DriverJob | null {
    return this.jobs.find((j) => j.car === car) ?? null;
  }

  /** The driver of `car`, if an AI driver has it, sees phantom Cody at `at` this frame. False if none has it. */
  sees(car: Vehicle, at: Vector3): boolean {
    const job = this.of(car);
    job?.sees(at);
    return !!job;
  }

  update(dt: number): void {
    this.doing.update(this.world, dt);
    this.jobs = this.jobs.filter((j) => this.doing.isRunning((a) => a === j));
  }
}
