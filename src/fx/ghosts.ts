import { Group, Sprite, SpriteMaterial, Vector3 } from 'three';

import { Rng } from '@/engine/core/rng';
import { withCurve } from '@/render/curvature';
import { FX_LAYER } from '@/render/layers';
import { ghostTexture } from '@/render/textures';
import type { GhostZoneDef } from '@/world/level-data';

const _to = new Vector3();
/** Maximum active ghosts spawned from casualties. Reuse the oldest when the limit is reached. */
const RISEN_MAX = 12;
/** Fade-in time in seconds and horizontal roaming radius in meters for casualty ghosts. */
const RISE_IN = 1.5;
const HAUNT = 4;
/**
 * Intake motion uses an initial speed in m/s and acceleration in m/s². Collect ghosts within SWALLOW meters of the
 * intake; ambient ghosts return after their zone's respawn time, or RESPAWN visible simulation seconds by default.
 */
const SUCK_SPEED = 3;
const SUCK_ACCEL = 14;
const SWALLOW = 0.8;
const RESPAWN = 25;
/** Rate at which accumulated pull time decays after the intake releases a ghost. */
const RELAX = 2;

interface Ghost {
  s: Sprite;
  zone: GhostZoneDef;
  target: Vector3;
  vel: Vector3;
  phase: number;
  size: number;
  flip: number;
  /** Visible simulation time since spawning from a casualty, in seconds. */
  age?: number;
  /** Accumulated intake pull time in seconds; zero means normal drifting. */
  pulled: number;
  /** Whether suck() pulled it since the last update(). */
  held: boolean;
  /** Remaining visible simulation seconds before respawning. Collected casualty ghosts use Infinity. */
  gone: number;
}

export function shareOut<Z extends { readonly weight?: number }>(
  zones: readonly Z[],
  count: number,
): { zone: Z; n: number }[] {
  const total = zones.reduce((sum, z) => sum + (z.weight ?? 1), 0);
  const parts = zones.map((zone) => {
    const exact = (count * (zone.weight ?? 1)) / total;
    return { zone, n: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let left = count - parts.reduce((sum, p) => sum + p.n, 0);
  for (const p of [...parts].sort((a, b) => b.rest - a.rest)) {
    if (left <= 0) {
      break;
    }

    p.n++;
    left--;
  }

  return parts;
}

/** Animate ambient and casualty ghosts, with visibility controlled by night intensity and fade(). */
export class Ghosts {
  readonly root = new Group();
  private readonly list: Ghost[] = [];
  private t = 0;
  private readonly rng = new Rng(66);
  /** Visibility multiplier approaching `target` at `rate` per second, combined with night intensity. */
  private presence = 1;
  private target = 1;
  private rate = Infinity;
  private readonly tex = [ghostTexture(1), ghostTexture(2), ghostTexture(3)];
  /** Active casualty ghosts in spawn order. */
  private readonly risen: Ghost[] = [];
  private readonly shown: Vector3[] = [];

  constructor(zones: readonly GhostZoneDef[], count = 26) {
    for (const { zone, n } of shareOut(zones, count)) {
      for (let i = 0; i < n; i++) {
        this.haunt(zone);
      }
    }
  }

  private haunt(zone: GhostZoneDef): void {
    const rng = this.rng;
    const s = new Sprite(
      withCurve(
        new SpriteMaterial({
          map: rng.pick(this.tex),
          transparent: true,
          depthWrite: false,
          opacity: 0,
          toneMapped: false,
        }),
      ),
    );
    s.layers.set(FX_LAYER);
    s.renderOrder = 4;
    const g: Ghost = {
      s,
      zone,
      target: new Vector3(),
      vel: new Vector3(),
      phase: rng.range(0, 10),
      size: rng.range(1.8, 3.2),
      flip: 1,
      pulled: 0,
      held: false,
      gone: 0,
    };
    this.pick(g);
    s.position.copy(g.target);
    this.pick(g);
    this.list.push(g);
    this.root.add(s);
  }

  /** Choose a random target inside the ghost's roaming zone. */
  private pick(g: Ghost): void {
    const z = g.zone;
    const rng = this.rng;
    g.target.set(rng.range(z.min[0], z.max[0]), rng.range(z.min[1], z.max[1]), rng.range(z.min[2], z.max[2]));
  }

  /**
   * Spawn a ghost rising from a casualty at `at`, then roaming nearby. Global night intensity and fade() still control
   * visibility.
   */
  rise(at: Vector3): void {
    const rng = this.rng;
    let g: Ghost;
    if (this.risen.length >= RISEN_MAX) {
      g = this.risen.shift() as Ghost;
    } else {
      const s = new Sprite(
        withCurve(
          new SpriteMaterial({
            map: rng.pick(this.tex),
            transparent: true,
            depthWrite: false,
            opacity: 0,
            toneMapped: false,
          }),
        ),
      );
      s.layers.set(FX_LAYER);
      s.renderOrder = 4;
      g = {
        s,
        zone: { min: [0, 0, 0], max: [0, 0, 0] },
        target: new Vector3(),
        vel: new Vector3(),
        phase: rng.range(0, 10),
        size: rng.range(1.6, 2.6),
        flip: 1,
        pulled: 0,
        held: false,
        gone: 0,
      };
      this.list.push(g);
      this.root.add(g.s);
    }

    g.zone.min = [at.x - HAUNT, at.y + 1, at.z - HAUNT];
    g.zone.max = [at.x + HAUNT, at.y + 4, at.z + HAUNT];
    g.s.position.copy(at);
    g.vel.set(0, 1.5, 0);
    g.target.set(at.x, at.y + 3, at.z);
    g.age = 0;
    g.pulled = 0;
    g.gone = 0;
    g.s.visible = true;
    this.risen.push(g);
  }

  /**
   * Pull available ghosts within `reach` meters toward the intake and return the number collected this frame. Pull
   * speed increases with accumulated pull time. Do nothing while the ghost group is hidden.
   */
  suck(at: Vector3, reach: number, dt: number): number {
    if (!this.root.visible) {
      return 0;
    }

    let swallowed = 0;
    for (const g of this.list) {
      if (g.gone > 0) {
        continue;
      }

      const p = g.s.position;
      const d = p.distanceTo(at);
      if (d > reach) {
        continue;
      }

      g.pulled += dt;
      const step = (SUCK_SPEED + SUCK_ACCEL * g.pulled) * dt;
      if (d - step <= SWALLOW) {
        swallowed++;
        this.swallow(g);
        continue;
      }

      g.held = true;
      _to.subVectors(at, p).multiplyScalar(step / d);
      p.add(_to);
      g.vel.copy(_to).divideScalar(Math.max(dt, 1e-4));
    }

    return swallowed;
  }

  nearest(at: Vector3, out: Vector3): boolean {
    let best = Infinity;
    for (const g of this.list) {
      const d = g.gone > 0 ? Infinity : g.s.position.distanceToSquared(at);
      if (d < best) {
        best = d;
        out.copy(g.s.position);
      }
    }

    return best < Infinity;
  }

  active(): readonly Readonly<Vector3>[] {
    const out = this.shown;
    out.length = 0;

    if (!this.root.visible) {
      return out;
    }

    for (const g of this.list) {
      if (g.gone <= 0) {
        out.push(g.s.position);
      }
    }

    return out;
  }

  /** Hide a collected ghost. Ambient ghosts respawn later; casualty ghosts remain inactive. */
  private swallow(g: Ghost): void {
    g.pulled = 0;
    g.s.visible = false;
    const r = this.risen.indexOf(g);
    if (r >= 0) {
      this.risen.splice(r, 1);
      g.gone = Infinity;
    } else {
      g.gone = g.zone.respawn ?? RESPAWN;
    }
  }

  /**
   * Set the target visibility. `seconds` is the duration of a full fade between 0 and 1; zero applies on the next
   * update.
   */
  fade(on: boolean, seconds = 0): void {
    this.target = on ? 1 : 0;
    this.rate = seconds > 0 ? 1 / seconds : Infinity;
  }

  update(dt: number, night: number): void {
    this.t += dt;
    this.presence += Math.max(-this.rate * dt, Math.min(this.rate * dt, this.target - this.presence));
    const nightness = night * this.presence;
    this.root.visible = nightness > 0.02;

    if (!this.root.visible) {
      return;
    }

    for (const g of this.list) {
      if (g.gone > 0) {
        // Advance respawn timers only while the ghost group is visible.
        g.gone -= dt;

        if (g.gone > 0) {
          continue;
        }

        this.pick(g);
        g.s.position.copy(g.target);
        this.pick(g);
        g.s.visible = true;
      }

      const p = g.s.position;
      if (g.pulled > 0 && !g.held) {
        // A ghost no longer pulled eases back into shape where it is, then drifts on from rest.
        g.pulled = Math.max(0, g.pulled - RELAX * dt);
        g.vel.set(0, 0, 0);
      }

      g.held = false;

      if (g.pulled > 0) {
        // Stretch and narrow the ghost while suck() controls its position.
        const k = Math.max(0.15, 1 - g.pulled * 1.5);
        g.s.scale.set(g.size * k * g.flip, g.size * (2 - k), 1);
        g.s.material.opacity = nightness * 0.8;
        continue;
      }

      const to = _to.subVectors(g.target, p);
      if (to.length() < 1.5) {
        this.pick(g);
      }

      to.normalize().multiplyScalar(2.2);
      g.vel.lerp(to, 1 - Math.exp(-dt * 0.8));
      p.addScaledVector(g.vel, dt);
      p.y += Math.sin(this.t * 1.7 + g.phase) * dt * 0.6;

      if (Math.abs(g.vel.x) > 0.3) {
        g.flip = g.vel.x > 0 ? 1 : -1;
      }

      const pulse = 1 + Math.sin(this.t * 2.3 + g.phase) * 0.06;
      g.s.scale.set(g.size * pulse * g.flip, g.size * pulse, 1);
      let fade = 1;
      if (g.age !== undefined) {
        g.age += dt;
        fade = Math.min(1, g.age / RISE_IN);
      }

      g.s.material.opacity = nightness * fade * (0.62 + Math.sin(this.t * 3.1 + g.phase * 2) * 0.18);
    }
  }
}
