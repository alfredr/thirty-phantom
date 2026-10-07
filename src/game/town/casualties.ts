import { Vector3 } from 'three';

import type { CharacterRig } from '@/actors/models/rig';
import { Ragdoll, type RagdollPusher } from '@/actors/ragdoll';
import type { CollisionWorld } from '@/engine/physics/collision';
import type { BloodSim } from '@/world/blood';

/**
 * Injury severity in ascending order. Survivors can recover; dead casualties
 * remain down.
 */
export type Harm = 'stunned' | 'injured' | 'unconscious' | 'dead';
export type Cause = 'vehicle' | 'claws';
const ORDER: readonly Harm[] = ['stunned', 'injured', 'unconscious', 'dead'];

/**
 * Impact thresholds after mass scaling, in m/s. Lower impacts do not cause
 * casualties.
 */
const HARM_AT: Readonly<Record<Harm, number>> = {
  stunned: 3,
  injured: 7,
  unconscious: 12,
  dead: 17,
};
/**
 * Reference mass in kilograms; impact severity scales with the cube root of
 * the mass ratio.
 */
const REF_MASS = 1300;
/** Recovery delay ranges in seconds. */
const DOWN_FOR: Readonly<Record<Harm, readonly [number, number]>> = {
  stunned: [1.5, 2.5],
  injured: [3, 5],
  unconscious: [40, 60],
  dead: [Infinity, Infinity],
};
/** Initial bleeding rates in m³/s and fractional decay rates per second. */
const BLEED: Readonly<Record<Harm, number>> = {
  stunned: 0,
  injured: 1e-5,
  unconscious: 2.5e-5,
  dead: 8e-5,
};
const STAUNCH: Readonly<Record<Harm, number>> = {
  stunned: 1,
  injured: 1 / 25,
  unconscious: 1 / 70,
  dead: 1 / 40,
};
/** Blood volume per drop in m³ and impact spray counts by severity. */
const DROP = 2e-6;
const SPRAY = [0, 10, 18, 30] as const;
/**
 * Horizontal velocity retention, vertical lift per m/s of impact, and ragdoll
 * tumble strength.
 */
const CARRY = 0.85;
const LIFT = 0.35;
const TUMBLE = 0.6;
/** Minimum interval between vehicle-induced injury escalations, in seconds. */
const REHIT = 0.6;
/**
 * Maximum additional recovery delay while the ragdoll remains unsettled, in
 * seconds.
 */
const GET_UP_ANYWAY = 3;

const _c = new Vector3();

/** Ragdoll, injury, bleeding, and recovery state for a fallen character. */
export interface Casualty {
  readonly rig: CharacterRig;
  readonly ragdoll: Ragdoll;
  harm: Harm;
  /** Remaining recovery delay in seconds; dead casualties never recover. */
  down: number;
  /** Current bleeding rate in m³/s and accumulated volume awaiting emission. */
  bleed: number;
  owed: number;
  /** Current pelvis position for obstacle queries. */
  readonly at: Vector3;
  readonly head: Vector3;
  readonly feet: Vector3;
  /**
   * Remaining cooldown before another vehicle impact can worsen the injury, in
   * seconds.
   */
  cool: number;
}

/**
 * Simulate fallen characters, impact injury, bleeding, and recovery. Repeated
 * vehicle impacts or claw attacks can increase severity. Survivors recover
 * after their delay and settling checks; dead casualties remain.
 */
export class Casualties {
  readonly list: Casualty[] = [];
  onDeath: ((c: Casualty, cause: Cause) => void) | null = null;

  constructor(
    private readonly world: CollisionWorld,
    private readonly blood: BloodSim,
  ) {}

  /**
   * Classify impact speed in m/s scaled by body mass in kilograms, or return
   * null below the injury threshold.
   */
  static harmFor(speed: number, mass: number): Harm | null {
    const k = speed * Math.cbrt(mass / REF_MASS);
    let harm: Harm | null = null;
    for (const h of ORDER) {
      if (k >= HARM_AT[h]) {
        harm = h;
      }
    }

    return harm;
  }

  /**
   * Launch a ragdoll from the current rig pose using impact velocity (vx, vz)
   * in m/s and the supplied injury.
   */
  strike(
    rig: CharacterRig,
    vx: number,
    vz: number,
    harm: Harm,
    cause: Cause,
  ): Casualty {
    const ragdoll = new Ragdoll(rig);
    const speed = Math.hypot(vx, vz);
    ragdoll.launch(vx * CARRY, 1.5 + speed * LIFT, vz * CARRY, TUMBLE);
    const c: Casualty = {
      rig,
      ragdoll,
      harm: 'stunned',
      down: 0,
      bleed: 0,
      owed: 0,
      at: ragdoll.pelvis(new Vector3()),
      head: ragdoll.head(new Vector3()),
      feet: ragdoll.feet(new Vector3()),
      cool: REHIT,
    };
    this.list.push(c);
    this.worsen(c, harm, vx, vz, cause);
    return c;
  }

  /**
   * Escalate a casualty by one severity level and emit blood away from the
   * attack. Return the resulting severity.
   */
  maul(c: Casualty, from: Vector3): Harm {
    c.ragdoll.chest(_c);
    this.worsen(
      c,
      this.next(c.harm),
      (_c.x - from.x) * 2,
      (_c.z - from.z) * 2,
      'claws',
    );
    c.cool = REHIT;
    return c.harm;
  }

  /** Emit a blood spray for an upright victim struck from `from`. */
  cut(at: Vector3, from: Vector3): void {
    this.blood.spray(
      at.x,
      at.y + 1.2,
      at.z,
      (at.x - from.x) * 2,
      (at.z - from.z) * 2,
      6,
      2.5,
      DROP * 1.5,
    );
  }

  /**
   * Allow living casualties to recover after the delay and settling, or after
   * the additional grace period.
   */
  ready(c: Casualty): boolean {
    return (
      c.harm !== 'dead' &&
      ((c.down <= 0 && c.ragdoll.asleep) || c.down <= -GET_UP_ANYWAY)
    );
  }

  /**
   * Remove casualty simulation, reset the rig pose, and write its ground
   * position into `out`. Return the recovery yaw.
   */
  recover(c: Casualty, out: Vector3): number {
    this.remove(c);
    const r = c.rig;
    for (const o of [r.armL, r.armR, r.legL, r.legR, r.head]) {
      o.rotation.set(0, 0, 0);
    }

    const yaw = c.ragdoll.yaw;
    r.root.rotation.set(0, yaw, 0);
    c.ragdoll.pelvis(out);
    out.y = this.world.groundAt(out.x, out.z, out.y, 0.5);
    return yaw;
  }

  /** Remove a casualty from simulation. */
  remove(c: Casualty): void {
    const i = this.list.indexOf(c);
    if (i >= 0) {
      this.list.splice(i, 1);
    }
  }

  update(dt: number, pushers: readonly RagdollPusher[]): void {
    for (let i = 0; i < this.list.length; i++) {
      const c = this.list[i] as Casualty;
      const rd = c.ragdoll;
      rd.hardest = 0;
      rd.step(dt, this.world, pushers);
      rd.pose();
      rd.pelvis(c.at);
      rd.head(c.head);
      rd.feet(c.feet);
      // Rate-limit injury escalation from repeated vehicle contact.
      c.cool -= dt;
      const again =
        rd.hardest > 0 && c.cool <= 0
          ? Casualties.harmFor(rd.hardest, REF_MASS)
          : null;
      if (again && ORDER.indexOf(again) >= ORDER.indexOf(c.harm) - 1) {
        this.worsen(c, this.next(c.harm), 0, 0, 'vehicle');
        c.cool = REHIT;
      }

      c.down -= dt;

      if (c.harm === 'unconscious' && c.down <= 0) {
        // Recovered unconscious casualties retain an injury.
        c.harm = 'injured';
      }

      this.bleedFrom(c, dt);
    }
  }

  private next(h: Harm): Harm {
    return ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(h) + 1)] as Harm;
  }

  /**
   * Raise injury severity without reducing it, refresh recovery and bleeding,
   * and emit impact blood. Report a death to onDeath with its cause.
   */
  private worsen(
    c: Casualty,
    harm: Harm,
    vx: number,
    vz: number,
    cause: Cause,
  ): void {
    const was = ORDER.indexOf(c.harm);
    const now = Math.max(was, ORDER.indexOf(harm));
    c.harm = ORDER[now] as Harm;
    const [lo, hi] = DOWN_FOR[c.harm];
    c.down = Math.max(c.down, lo + Math.random() * (hi - lo));
    c.bleed = Math.max(c.bleed, BLEED[c.harm]);
    const n = SPRAY[now] ?? 0;
    if (n > 0) {
      c.ragdoll.chest(_c);
      this.blood.spray(_c.x, _c.y, _c.z, vx * 0.3, vz * 0.3, n, 3, DROP * 2);
    }

    if (c.harm === 'dead' && was !== now) {
      this.onDeath?.(c, cause);
    }
  }

  /**
   * Accumulate blood volume into discrete drops while decaying the bleeding
   * rate.
   */
  private bleedFrom(c: Casualty, dt: number): void {
    if (c.bleed <= 0) {
      return;
    }

    c.owed += c.bleed * dt;
    c.bleed *= 1 - STAUNCH[c.harm] * dt;

    if (c.bleed < 2e-7) {
      c.bleed = 0;
    }

    while (c.owed >= DROP) {
      c.owed -= DROP;
      c.ragdoll.chest(_c);
      this.blood.drip(
        _c.x + (Math.random() - 0.5) * 0.3,
        _c.y,
        _c.z + (Math.random() - 0.5) * 0.3,
        0,
        0,
        0,
        DROP,
      );
    }
  }
}
