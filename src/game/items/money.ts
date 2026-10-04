import { type Group, type Scene, Vector3 } from 'three';
import { buildLoot, type LootKind } from '../../actors/models/loot';
import { TUNING } from '../../config';
import type { Rng } from '../../core/rng';
import { NAV, type NavGrid } from '../../world/nav-grid';

const M = TUNING.money;

/** Dropped money hovers this high, bobbing this much at this rate, and spins (rad/s). */
const HOVER = 0.25;
const BOB = 0.06;
const BOB_RATE = 3;
const SPIN = 2.4;
/** It's tossed as it falls from a hand at this height: up and out (m/s), under this gravity. */
const HAND = 1;
const TOSS_UP = 3;
const TOSS_OUT = 1.6;
const GRAVITY = 14;
/** It shrinks away over its last few seconds. */
const FADE = 2;

interface Loot {
  kind: LootKind;
  amount: number;
  pos: Vector3;
  vel: Vector3;
  /** Ground under it. */
  floor: number;
  landed: boolean;
  age: number;
  /** Seconds it lies there before it's gone: dropped money doesn't last, found money stays till the next sunrise. */
  life: number;
  /** Laid out at sunrise (rather than dropped). */
  found: boolean;
  root: Group;
}

export interface Pickup {
  kind: LootKind;
  amount: number;
}

/** Cody's cash, and money lying around for him to pick up: dropped by people, or found about town. */
export class Money {
  cash: number = M.start;
  private readonly loot: Loot[] = [];
  /** Cars whose glovebox Cody has been through. */
  private readonly searched = new WeakSet<object>();

  constructor(
    private readonly scene: Scene,
    private readonly nav: NavGrid,
    private readonly rng: Rng,
  ) {}

  /** Cody gets into `car`: the first time, there may be cash in the glovebox. Returns how much he found (0: none). */
  glovebox(car: object): number {
    if (this.searched.has(car)) return 0;
    this.searched.add(car);
    if (!this.rng.chance(M.glovebox.chance)) return 0;
    const found = Math.round(this.rng.range(...M.glovebox.amount));
    this.cash += found;
    return found;
  }

  /** Sunrise: whatever cash was lying about town is gone, and fresh bills turn up in new places. */
  scatter(): void {
    for (let i = this.loot.length - 1; i >= 0; i--) if ((this.loot[i] as Loot).found) this.remove(i);
    const F = M.found;
    for (let k = 0; k < F.count; k++) {
      const at = this.nav.anywhere(this.rng, NAV.person, F.upTo, true);
      if (!at) continue;
      const root = buildLoot('cash');
      const pos = at.clone().setY(at.y + HOVER);
      root.position.copy(pos);
      this.scene.add(root);
      this.loot.push({ kind: 'cash', amount: Math.round(this.rng.range(...F.amount)), pos, vel: new Vector3(), floor: at.y, landed: true, age: 0, life: Infinity, found: true, root });
    }
  }

  spend(amount: number): boolean {
    if (this.cash < amount) return false;
    this.cash -= amount;
    return true;
  }

  /** Someone at `at` lets go of money as they run off: it flies out behind them (away from `toward`). */
  drop(at: Vector3, kind: LootKind, toward: Vector3): void {
    const [lo, hi] = kind === 'cash' ? M.cash : M.wallet;
    const root = buildLoot(kind);
    const away = new Vector3(at.x - toward.x, 0, at.z - toward.z);
    if (away.lengthSq() < 1e-6) away.set(this.rng.range(-1, 1), 0, this.rng.range(-1, 1));
    away.normalize().multiplyScalar(-TOSS_OUT);
    const pos = at.clone().setY(at.y + HAND);
    this.loot.push({
      kind,
      amount: Math.round(this.rng.range(lo, hi)),
      pos,
      vel: new Vector3(away.x, TOSS_UP, away.z),
      floor: this.nav.heightAt(at.x, at.y, at.z) ?? at.y,
      landed: false,
      age: 0,
      life: M.life,
      found: false,
      root,
    });
    root.position.copy(pos);
    this.scene.add(root);
  }

  /** Toss, settle, spin and expire; whatever is within `reach` of `pos` gets picked up and returned. */
  update(dt: number, pos: Vector3 | null, reach: number): Pickup[] {
    const got: Pickup[] = [];
    for (let i = this.loot.length - 1; i >= 0; i--) {
      const l = this.loot[i] as Loot;
      l.age += dt;
      if (!l.landed) {
        l.vel.y -= GRAVITY * dt;
        l.pos.addScaledVector(l.vel, dt);
        if (l.vel.y < 0 && l.pos.y <= l.floor + HOVER) {
          l.pos.y = l.floor + HOVER;
          l.landed = true;
        }
      }
      const r = l.root;
      r.position.set(l.pos.x, l.pos.y + (l.landed ? Math.sin(l.age * BOB_RATE) * BOB : 0), l.pos.z);
      r.rotation.y += SPIN * dt;
      r.scale.setScalar(Math.min(1, (l.life - l.age) / FADE));
      const taken = l.landed && pos !== null && Math.hypot(pos.x - l.pos.x, pos.z - l.pos.z) < reach && Math.abs(pos.y - l.floor) < reach;
      if (taken) got.push({ kind: l.kind, amount: l.amount });
      if (taken || l.age >= l.life) this.remove(i);
    }
    for (const g of got) this.cash += g.amount;
    return got;
  }

  private remove(i: number): void {
    this.scene.remove((this.loot[i] as Loot).root);
    this.loot.splice(i, 1);
  }
}
