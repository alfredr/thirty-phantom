import { Vector3 } from 'three';
import type { CharacterRig } from '../../actors/models/rig';
import { Ragdoll, type RagdollPusher } from '../../actors/ragdoll';
import type { CollisionWorld } from '../../engine/physics/collision';
import type { BloodSim } from '../../world/blood';

/** How badly a hit leaves someone, worst last. Stunned and injured get up; unconscious come round later; dead don't. */
export type Harm = 'stunned' | 'injured' | 'unconscious' | 'dead';
const ORDER: readonly Harm[] = ['stunned', 'injured', 'unconscious', 'dead'];

/** Impact (m/s, scaled by the hitting body's weight) at which each harm starts; below the first, just a shove. */
const HARM_AT: Readonly<Record<Harm, number>> = { stunned: 3, injured: 7, unconscious: 12, dead: 17 };
/** A sedan's weight (kg): heavier things hit harder, by the cube root of how much heavier. */
const REF_MASS = 1300;
/** Seconds down before getting up (a range). */
const DOWN_FOR: Readonly<Record<Harm, readonly [number, number]>> = {
  stunned: [1.5, 2.5],
  injured: [3, 5],
  unconscious: [40, 60],
  dead: [Infinity, Infinity],
};
/** Bleeding when it starts (m^3/s), and the share it eases off by per second. */
const BLEED: Readonly<Record<Harm, number>> = { stunned: 0, injured: 1e-5, unconscious: 2.5e-5, dead: 8e-5 };
const STAUNCH: Readonly<Record<Harm, number>> = { stunned: 1, injured: 1 / 25, unconscious: 1 / 70, dead: 1 / 40 };
/** One drop's worth of blood (m^3, about 2 cc), and a hit's spray per unit of harm. */
const DROP = 2e-6;
const SPRAY = [0, 10, 18, 30] as const;
/** Flung by a hit: this share of the car's speed, plus a lift per m/s, and a tumble (feet taken out). */
const CARRY = 0.85;
const LIFT = 0.35;
const TUMBLE = 0.6;
/** Hit again while down: it only counts once per this long (s), so a car shoving a body doesn't escalate it every frame. */
const REHIT = 0.6;
/** This long past their time (s), they get up even if something keeps jostling them. */
const GET_UP_ANYWAY = 3;

const _c = new Vector3();

/** Someone knocked down: their ragdoll, how badly, and how long until they get up. */
export interface Casualty {
  readonly rig: CharacterRig;
  readonly ragdoll: Ragdoll;
  harm: Harm;
  /** Seconds until they can get up (Infinity: they won't). */
  down: number;
  /** Bleeding now (m^3/s), and blood owed toward the next drop. */
  bleed: number;
  owed: number;
  /** Where they lie (pelvis), kept current for traffic to stop for. */
  readonly at: Vector3;
  /** Seconds until another hit counts. */
  cool: number;
}

/**
 * People hit by vehicles: how hard sets the harm, the hit flings them as a
 * ragdoll, the hurt bleed (drops onto the ground, pooling), and the stunned
 * and injured get back up after a moment; the unconscious much later; the
 * dead stay down. Hit again while down, it gets worse.
 */
export class Casualties {
  readonly list: Casualty[] = [];

  constructor(
    private readonly world: CollisionWorld,
    private readonly blood: BloodSim,
  ) {}

  /** The harm from an impact `speed` (m/s) by a body of `mass` (kg), or null for just a shove. */
  static harmFor(speed: number, mass: number): Harm | null {
    const k = speed * Math.cbrt(mass / REF_MASS);
    let harm: Harm | null = null;
    for (const h of ORDER) if (k >= HARM_AT[h]) harm = h;
    return harm;
  }

  /** Knock down the person posed in `rig`, struck by something moving (vx, vz) hard enough for `harm`. */
  strike(rig: CharacterRig, vx: number, vz: number, harm: Harm): Casualty {
    const ragdoll = new Ragdoll(rig);
    const speed = Math.hypot(vx, vz);
    ragdoll.launch(vx * CARRY, 1.5 + speed * LIFT, vz * CARRY, TUMBLE);
    const c: Casualty = { rig, ragdoll, harm, down: 0, bleed: 0, owed: 0, at: ragdoll.pelvis(new Vector3()), cool: REHIT };
    this.list.push(c);
    this.worsen(c, harm, vx, vz);
    return c;
  }

  /** A blow (a skeleton's claws, from `from`) to someone lying there: a step worse. Returns how bad it is now. */
  maul(c: Casualty, from: Vector3): Harm {
    c.ragdoll.chest(_c);
    this.worsen(c, this.next(c.harm), (_c.x - from.x) * 2, (_c.z - from.z) * 2);
    c.cool = REHIT;
    return c.harm;
  }

  /** A clawing that draws blood from someone still on their feet at `at`, struck from `from`. */
  cut(at: Vector3, from: Vector3): void {
    this.blood.spray(at.x, at.y + 1.2, at.z, (at.x - from.x) * 2, (at.z - from.z) * 2, 6, 2.5, DROP * 1.5);
  }

  /** Up for getting up: down long enough, not dead, and lying still (or long past due, still or not). */
  ready(c: Casualty): boolean {
    return c.harm !== 'dead' && (c.down <= 0 && c.ragdoll.asleep || c.down <= -GET_UP_ANYWAY);
  }

  /**
   * Stand them back up where they lie: their rig straightened out and handed
   * back. Returns the yaw to stand facing; `out` gets the spot (pelvis, on the ground).
   */
  recover(c: Casualty, out: Vector3): number {
    this.remove(c);
    const r = c.rig;
    for (const o of [r.armL, r.armR, r.legL, r.legR, r.head]) o.rotation.set(0, 0, 0);
    const yaw = c.ragdoll.yaw;
    r.root.rotation.set(0, yaw, 0);
    c.ragdoll.pelvis(out);
    out.y = this.world.groundAt(out.x, out.z, out.y, 0.5);
    return yaw;
  }

  /** Forget a casualty (despawned, or back on their feet). */
  remove(c: Casualty): void {
    const i = this.list.indexOf(c);
    if (i >= 0) this.list.splice(i, 1);
  }

  update(dt: number, pushers: readonly RagdollPusher[]): void {
    for (let i = 0; i < this.list.length; i++) {
      const c = this.list[i] as Casualty;
      const rd = c.ragdoll;
      rd.hardest = 0;
      rd.step(dt, this.world, pushers);
      rd.pose();
      rd.pelvis(c.at);
      // run over while down: worse
      c.cool -= dt;
      const again = rd.hardest > 0 && c.cool <= 0 ? Casualties.harmFor(rd.hardest, REF_MASS) : null;
      if (again && ORDER.indexOf(again) >= ORDER.indexOf(c.harm) - 1) {
        this.worsen(c, this.next(c.harm), 0, 0);
        c.cool = REHIT;
      }
      c.down -= dt;
      if (c.harm === 'unconscious' && c.down <= 0) {
        // coming round: they'll get up hurt
        c.harm = 'injured';
      }
      this.bleedFrom(c, dt);
    }
  }

  private next(h: Harm): Harm {
    return ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(h) + 1)] as Harm;
  }

  /** At least `harm` now: longer down, bleeding harder, and a spray from the hit. */
  private worsen(c: Casualty, harm: Harm, vx: number, vz: number): void {
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
  }

  /** Blood off the wound in drops, easing off over time. */
  private bleedFrom(c: Casualty, dt: number): void {
    if (c.bleed <= 0) return;
    c.owed += c.bleed * dt;
    c.bleed *= 1 - STAUNCH[c.harm] * dt;
    if (c.bleed < 2e-7) c.bleed = 0;
    while (c.owed >= DROP) {
      c.owed -= DROP;
      c.ragdoll.chest(_c);
      this.blood.drip(_c.x + (Math.random() - 0.5) * 0.3, _c.y, _c.z + (Math.random() - 0.5) * 0.3, 0, 0, 0, DROP);
    }
  }
}
