/**
 * Shared handling and dimensions for vehicle physics, route planning, and
 * predictive simulation.
 */
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
  /** Maximum climbable ledge height, in meters. */
  stepUp: number;
  /** Vertical velocity added by a hop, in m/s. */
  hop: number;
  /**
   * Minimum speed in m/s for breaking parapets. Infinity disables this
   * capability.
   */
  smashSpeed: number;
  /**
   * Two-wheelers lean into turns, up to this angle (radians); cars just roll a
   * little on their springs.
   */
  lean?: number;
}

/**
 * Where a vehicle's collision circles sit along its length (tail, middle,
 * nose), each of `params.radius`. The physics uses them, and so does anything
 * checking whether a simulated pose fits (autopilot rollouts, drive
 * searches).
 */
export function bodyOffsets(params: VehicleParams): number[] {
  const half = bodyHalf(params);
  return [-half, 0, half];
}

/** How far the nose and tail collision circles sit from the middle one. */
export function bodyHalf(
  params: Pick<VehicleParams, 'length' | 'radius'>,
): number {
  return params.length / 2 - params.radius;
}

/** Reduce available steering lock by this fraction at maximum speed. */
const STEER_FADE = 0.45;

/**
 * Share of full steering lock available at `speed` (m/s). The physics uses it,
 * and so does anything simulating a vehicle.
 */
export function steerScale(params: VehicleParams, speed: number): number {
  return 1 - STEER_FADE * Math.min(1, Math.abs(speed) / params.maxSpeed);
}
