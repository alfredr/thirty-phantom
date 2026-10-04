import { clamp, TAU } from '@/engine/core/math';

import type { Skeleton } from './skeleton';

export interface RiseSpec {
  /** Rise duration, burial depth, and maximum random delay, in seconds and meters. */
  readonly duration: number;
  readonly depth: number;
  readonly delay: number;
}

/** Advance the emergence animation and notify effects at its start. Return true when fully above ground. */
export function rise(s: Skeleton, st: { t: number }, dt: number): boolean {
  const was = st.t;
  st.t += dt;

  if (was < 0 && st.t >= 0) {
    s.world.risen(s.pos);
  }

  const k = clamp(st.t / s.breed.rise.duration, 0, 1);
  const ease = 1 - (1 - k) * (1 - k);
  const r = s.rig;
  r.root.position.set(
    s.pos.x + Math.sin(st.t * 40) * 0.03 * (1 - k),
    s.pos.y - s.breed.rise.depth * (1 - ease),
    s.pos.z,
  );
  r.root.rotation.y = s.yaw;

  r.armL.rotation.x = -2.6 + Math.sin(st.t * 12) * 0.5 * (1 - k);
  r.armR.rotation.x = -2.6 + Math.cos(st.t * 12) * 0.5 * (1 - k);

  if (k < 1) {
    return false;
  }

  r.armL.rotation.x = 0;
  r.armR.rotation.x = 0;
  return true;
}

/** Update the rig pose, gait, attack arm, and stagger sway. */
export function pose(s: Skeleton, dt: number): void {
  const r = s.rig;
  r.root.position.copy(s.pos);
  r.root.rotation.y = s.yaw;
  s.gait.update(r, dt, s.speed);

  const hunt = s.hunting;
  if (hunt && hunt.swing > 0) {
    // Raise the arm, then complete the downward strike.
    const k = 1 - hunt.swing / hunt.spec.attack.every;
    r.armR.rotation.x = k < 0.35 ? -2.4 * (k / 0.35) : -2.4 + 2.9 * Math.min(1, (k - 0.35) / 0.2);
  }

  const staggered = s.mind.in('staggered');
  r.body.rotation.z = staggered ? Math.sin(staggered.t * TAU * 2) * 0.25 : 0;
}
