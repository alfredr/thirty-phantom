import type { Vector3 } from 'three';
import { TUNING } from '../config';
import type { Action } from '../core/input';
import type { Hud } from '../ui/hud';
import type { Elevator, Elevators } from '../world/elevators';

/**
 * Cody and the elevators, on foot: walk up to a landing door and press F to
 * call the cab; in the cab F picks the next floor up and G the next one down
 * (wrapping round), and the doors shut a moment after the last pick. The
 * prompt says which floor it's going to. Proximity only, like talking to a
 * valet: nothing happens until he's at a door or in a cab.
 */
export class ElevatorPanel {
  constructor(
    private readonly hud: Hud,
    private readonly elevators: Elevators,
  ) {}

  /** Cody on foot at p. True while he's in a cab or at a landing the cab isn't open at: the prompt (and F) are the elevator's then. */
  update(p: Vector3, pressed: (a: Action) => boolean): boolean {
    const cab = this.elevators.cabAt(p);
    if (cab) {
      if (pressed('interact')) cab.pick(1);
      else if (pressed('pay')) cab.pick(-1);
      this.hud.setPrompt(`{interact} UP &nbsp;{pay} DOWN${this.heading(cab)}`);
      return true;
    }
    const at = this.elevators.landingAt(p, TUNING.elevator.callReach);
    // with the cab here and its doors open, just walk in
    if (!at || at.elevator.openAt(at.stop)) return false;
    if (pressed('interact')) at.elevator.call(at.stop);
    this.hud.setPrompt(at.elevator.requests.has(at.stop) ? 'ELEVATOR CALLED' : 'CALL ELEVATOR');
    return true;
  }

  /** Where the cab's going, after the keys: the floor picked, or the one it's at. */
  private heading(e: Elevator): string {
    const to = e.picked ?? (e.at === null ? e.target : null);
    if (to !== null) {
      const arrow = e.stopY(to) > e.y ? '&#9650;' : '&#9660;';
      return ` &nbsp;&middot;&nbsp; ${arrow} ${e.label(to)}`;
    }
    return e.at !== null ? ` &nbsp;&middot;&nbsp; ${e.label(e.at)}` : '';
  }
}
