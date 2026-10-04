import { Group, Sprite, SpriteMaterial, Vector3 } from 'three';
import { Rng } from '../engine/core/rng';
import { withCurve } from '../render/curvature';
import { FX_LAYER } from '../render/layers';
import { ghostTexture } from '../render/textures';
import type { ZoneDef } from '../world/level-data';

const _to = new Vector3();
/** Risen ghosts (out of townsfolk the skeletons killed): at most this many, the oldest going to make room. */
const RISEN_MAX = 12;
/** A risen one fades in over this long (s), and haunts this far around where it rose (m). */
const RISE_IN = 1.5;
const HAUNT = 4;
/**
 * Sucked in (the monster truck's GhASt intake): pulled toward the mouth at
 * SUCK_SPEED (m/s) plus SUCK_ACCEL more each second it's held, shrinking to
 * nothing within SWALLOW (m) of it. An ambient one comes back out of its zone
 * RESPAWN seconds later.
 */
const SUCK_SPEED = 3;
const SUCK_ACCEL = 14;
const SWALLOW = 0.8;
const RESPAWN = 25;
/** A ghost no longer pulled sheds this many seconds of pull per second as it eases back into shape. */
const RELAX = 2;

interface Ghost {
  s: Sprite;
  zone: ZoneDef;
  target: Vector3;
  vel: Vector3;
  phase: number;
  size: number;
  flip: number;
  /** Seconds since it rose out of a body (risen ones only). */
  age?: number;
  /** Seconds it's been pulled toward an intake this time (0: free). */
  pulled: number;
  /** Whether suck() pulled it since the last update(). */
  held: boolean;
  /** Swallowed: seconds until it drifts back (ambient), or gone for good (risen: Infinity). */
  gone: number;
}

/** Ambient sheet ghosts drifting around the deck and graveyard. They only come out at night. */
export class Ghosts {
  readonly root = new Group();
  private readonly list: Ghost[] = [];
  private t = 0;
  private readonly rng = new Rng(66);
  /** How many are about, 0..1 (night still decides when), easing toward `target` at `rate` per second. */
  private presence = 1;
  private target = 1;
  private rate = Infinity;
  private readonly tex = [ghostTexture(1), ghostTexture(2), ghostTexture(3)];
  /** Ghosts that rose out of bodies, oldest first. */
  private readonly risen: Ghost[] = [];

  constructor(zones: ZoneDef[], count = 26) {
    const rng = this.rng;
    const tex = this.tex;
    for (let i = 0; i < count && zones.length; i++) {
      const zone = zones[i % zones.length] as ZoneDef;
      const s = new Sprite(withCurve(new SpriteMaterial({ map: rng.pick(tex), transparent: true, depthWrite: false, opacity: 0, toneMapped: false })));
      s.layers.set(FX_LAYER);
      s.renderOrder = 4;
      const g: Ghost = { s, zone, target: new Vector3(), vel: new Vector3(), phase: rng.range(0, 10), size: rng.range(1.8, 3.2), flip: 1, pulled: 0, held: false, gone: 0 };
      this.pick(g);
      s.position.copy(g.target);
      this.pick(g);
      this.list.push(g);
      this.root.add(s);
    }
  }

  /** A new spot in its zone to drift toward. */
  private pick(g: Ghost): void {
    const z = g.zone;
    const rng = this.rng;
    g.target.set(rng.range(z.min[0], z.max[0]), rng.range(z.min[1], z.max[1]), rng.range(z.min[2], z.max[2]));
  }

  /**
   * A ghost rising out of someone just killed at `at`: straight up out of the body, fading in,
   * then haunting the spot. Night and fade() rule it like the rest.
   */
  rise(at: Vector3): void {
    const rng = this.rng;
    let g: Ghost;
    if (this.risen.length >= RISEN_MAX) {
      g = this.risen.shift() as Ghost;
    } else {
      const s = new Sprite(withCurve(new SpriteMaterial({ map: rng.pick(this.tex), transparent: true, depthWrite: false, opacity: 0, toneMapped: false })));
      s.layers.set(FX_LAYER);
      s.renderOrder = 4;
      g = { s, zone: { min: [0, 0, 0], max: [0, 0, 0] }, target: new Vector3(), vel: new Vector3(), phase: rng.range(0, 10), size: rng.range(1.6, 2.6), flip: 1, pulled: 0, held: false, gone: 0 };
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
   * An intake at `at` (the monster truck's) pulls in every ghost that's out
   * and within `reach`: they stretch toward it, faster the longer they're
   * held, and shrink away into it. Returns how many it swallowed this frame.
   * Only while they're showing (night).
   */
  suck(at: Vector3, reach: number, dt: number): number {
    if (!this.root.visible) return 0;
    let swallowed = 0;
    for (const g of this.list) {
      if (g.gone > 0) continue;
      const p = g.s.position;
      const d = p.distanceTo(at);
      if (d > reach) continue;
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

  /** Gone into an intake: an ambient ghost drifts back later, a risen one is spent. */
  private swallow(g: Ghost): void {
    g.pulled = 0;
    g.s.visible = false;
    const r = this.risen.indexOf(g);
    if (r >= 0) {
      this.risen.splice(r, 1);
      g.gone = Infinity;
    } else {
      g.gone = RESPAWN;
    }
  }

  /** Clear them out, or bring them back, over `seconds` (0: at once). */
  fade(on: boolean, seconds = 0): void {
    this.target = on ? 1 : 0;
    this.rate = seconds > 0 ? 1 / seconds : Infinity;
  }

  update(dt: number, night: number): void {
    this.t += dt;
    this.presence += Math.max(-this.rate * dt, Math.min(this.rate * dt, this.target - this.presence));
    const nightness = night * this.presence;
    this.root.visible = nightness > 0.02;
    if (!this.root.visible) return;
    for (const g of this.list) {
      if (g.gone > 0) {
        // swallowed: an ambient one comes back out of its zone in a while
        g.gone -= dt;
        if (g.gone > 0) continue;
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
        // being sucked in: thinning toward the intake (suck() moves it)
        const k = Math.max(0.15, 1 - g.pulled * 1.5);
        g.s.scale.set(g.size * k * g.flip, g.size * (2 - k), 1);
        g.s.material.opacity = nightness * 0.8;
        continue;
      }
      const to = _to.subVectors(g.target, p);
      if (to.length() < 1.5) this.pick(g);
      to.normalize().multiplyScalar(2.2);
      g.vel.lerp(to, 1 - Math.exp(-dt * 0.8));
      p.addScaledVector(g.vel, dt);
      p.y += Math.sin(this.t * 1.7 + g.phase) * dt * 0.6;
      if (Math.abs(g.vel.x) > 0.3) g.flip = g.vel.x > 0 ? 1 : -1;
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
