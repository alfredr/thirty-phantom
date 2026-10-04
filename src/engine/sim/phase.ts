/** The phases of a frame, always in this order. */
export const PHASES = ['sense', 'think', 'act', 'move', 'events', 'present'] as const;
export type Phase = (typeof PHASES)[number];

/**
 * Tracks which phase the frame is in. Writers call require() so that, in development builds, a
 * write in the wrong phase fails loudly instead of quietly breaking the frame's ordering.
 */
export class Phases {
  private now: Phase = 'present';

  get current(): Phase {
    return this.now;
  }

  enter(phase: Phase): void {
    this.now = phase;
  }

  require(...allowed: readonly Phase[]): void {
    if (import.meta.env.DEV && !allowed.includes(this.now)) {
      throw new Error(`only allowed in ${allowed.join(' or ')}, not in ${this.now}`);
    }
  }
}
