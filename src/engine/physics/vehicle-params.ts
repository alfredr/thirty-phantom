/** A vehicle's handling and size, as its physics and anything simulating it (planners, rollouts) read them. */
export interface VehicleParams {
  maxSpeed: number;
  reverseSpeed: number;
  accel: number;
  brake: number;
  drag: number;
  maxSteer: number;
  wheelBase: number;
  grip: number;
  driftGrip: number;
  /** Collision circle radius (three circles are placed along the body). */
  radius: number;
  length: number;
  height: number;
  /** Max ledge the vehicle can roll up without being blocked. */
  stepUp: number;
  /** Vertical impulse for the hop (Space). */
  hop: number;
  /** Minimum speed to smash breakable parapets (Infinity = can't). */
  smashSpeed: number;
  /** Two-wheelers lean into turns, up to this angle (radians); cars just roll a little on their springs. */
  lean?: number;
}

/**
 * Where a vehicle's collision circles sit along its length (tail, middle,
 * nose), each of `params.radius`. The physics uses them, and so does anything
 * checking whether a simulated pose fits (autopilot rollouts, drive searches).
 */
export function bodyOffsets(params: VehicleParams): number[] {
  const half = bodyHalf(params);
  return [-half, 0, half];
}

/** How far the nose and tail collision circles sit from the middle one. */
export function bodyHalf(params: Pick<VehicleParams, 'length' | 'radius'>): number {
  return params.length / 2 - params.radius;
}

/** At top speed the wheels turn this much less than at a crawl (less twitchy at speed). */
const STEER_FADE = 0.45;

/** Share of full steering lock available at `speed` (m/s). The physics uses it, and so does anything simulating a vehicle. */
export function steerScale(params: VehicleParams, speed: number): number {
  return 1 - STEER_FADE * Math.min(1, Math.abs(speed) / params.maxSpeed);
}
