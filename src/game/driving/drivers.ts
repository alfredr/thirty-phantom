import type { Vector3 } from 'three';

import type { Vehicle } from '@/actors/vehicles/vehicle';
import { Doing } from '@/engine/sim/action';

import type { DriverJob, DriveWorld } from './drive-actions';

/**
 * Run AI driving jobs through a shared action runner. Track active jobs for perception delivery and completion checks;
 * release their claims when they end.
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

  /** Start the job and return false if its initial action fails. */
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

  /** Test whether the job remains active. */
  running(job: DriverJob): boolean {
    return this.jobs.includes(job);
  }

  /** Return the active AI job for the car, or null. */
  of(car: Vehicle): DriverJob | null {
    return this.jobs.find((j) => j.car === car) ?? null;
  }

  /** Deliver a sighting to the car’s active job. Return false when no job owns the car. */
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
