import { type Group, type Scene, Vector3 } from 'three';

import { buildLoot, type LootKind } from '@/actors/models/loot';
import { TUNING } from '@/config';
import type { Rng } from '@/engine/core/rng';
import { NAV, type NavGrid } from '@/world/nav-grid';

const M = TUNING.money;

/** Hover height and bob amplitude in meters; bob and spin rates in rad/s. */
const HOVER = 0.25;
const BOB = 0.06;
const BOB_RATE = 3;
const SPIN = 2.4;
/** Release height in meters, launch velocities in m/s, and gravity in m/s². */
const HAND = 1;
const TOSS_UP = 3;
const TOSS_OUT = 1.6;
const GRAVITY = 14;
/** Shrink duration before expiry, in seconds. */
const FADE = 2;

interface Loot {
  kind: LootKind;
  amount: number;
  pos: Vector3;
  vel: Vector3;
  /** Ground height in meters. */
  floor: number;
  landed: boolean;
  age: number;
  /**
   * Lifetime in seconds. Daily cash has infinite lifetime and is replaced at
   * sunrise.
   */
  life: number;
  /** Identify daily cash for saving and replacement. */
  found: boolean;
  root: Group;
}

/**
 * A daily cash record: ground position (x, y, z) in meters and amount in
 * dollars.
 */
export type FoundCash = [number, number, number, number];

export interface Pickup {
  kind: LootKind;
  amount: number;
}

/** Manage Cody’s balance, daily cash, and temporary dropped pickups. */
export class Money {
  cash: number = M.start;
  private readonly loot: Loot[] = [];
  /** Vehicles already checked for glovebox cash. */
  private readonly searched = new WeakSet<object>();

  constructor(
    private readonly scene: Scene,
    private readonly nav: NavGrid,
    private readonly rng: Rng,
  ) {}

  /** Mark a car as searched so it cannot award glovebox cash. */
  empty(car: object): void {
    this.searched.add(car);
  }

  /**
   * Search a car once, add any cash found to the balance, and return the
   * amount in dollars.
   */
  glovebox(car: object): number {
    if (this.searched.has(car)) {
      return 0;
    }

    this.searched.add(car);

    if (!this.rng.chance(M.glovebox.chance)) {
      return 0;
    }

    const found = Math.round(this.rng.range(...M.glovebox.amount));
    this.cash += found;
    return found;
  }

  /** Replace daily cash with a new random layout, preserving temporary drops. */
  scatter(): void {
    const F = M.found;
    const fresh: FoundCash[] = [];
    for (let k = 0; k < F.count; k++) {
      const at = this.nav.anywhere(this.rng, NAV.person, F.upTo, true);
      if (at) {
        fresh.push([
          at.x,
          at.y,
          at.z,
          Math.round(this.rng.range(...F.amount)),
        ]);
      }
    }

    this.layOut(fresh);
  }

  /**
   * Serialize remaining daily cash using ground heights rather than hovering
   * positions.
   */
  foundToday(): FoundCash[] {
    return this.loot
      .filter((l) => l.found)
      .map((l) => [l.pos.x, l.floor, l.pos.z, l.amount]);
  }

  /** Replace daily cash with the supplied layout, preserving temporary drops. */
  layOut(list: readonly FoundCash[]): void {
    for (let i = this.loot.length - 1; i >= 0; i--) {
      if (this.loot[i]?.found) {
        this.remove(i);
      }
    }

    for (const [x, y, z, amount] of list) {
      const root = buildLoot('cash');
      const pos = new Vector3(x, y + HOVER, z);
      root.position.copy(pos);
      this.scene.add(root);
      this.loot.push({
        kind: 'cash',
        amount,
        pos,
        vel: new Vector3(),
        floor: y,
        landed: true,
        age: 0,
        life: Infinity,
        found: true,
        root,
      });
    }
  }

  spend(amount: number): boolean {
    if (this.cash < amount) {
      return false;
    }

    this.cash -= amount;
    return true;
  }

  /** Release money at `at` with horizontal velocity toward `toward`. */
  drop(at: Vector3, kind: LootKind, toward: Vector3): void {
    const [lo, hi] = kind === 'cash' ? M.cash : M.wallet;
    const root = buildLoot(kind);
    const away = new Vector3(at.x - toward.x, 0, at.z - toward.z);
    if (away.lengthSq() < 1e-6) {
      away.set(this.rng.range(-1, 1), 0, this.rng.range(-1, 1));
    }

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

  /**
   * Advance and expire loot, collect landed pickups within `reach`, and credit
   * their amounts to the balance.
   */
  update(dt: number, pos: Vector3 | null, reach: number): Pickup[] {
    const got: Pickup[] = [];
    for (let i = this.loot.length - 1; i >= 0; i--) {
      const l = this.loot[i];
      if (!l) {
        continue;
      }

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
      r.position.set(
        l.pos.x,
        l.pos.y + (l.landed ? Math.sin(l.age * BOB_RATE) * BOB : 0),
        l.pos.z,
      );
      r.rotation.y += SPIN * dt;
      r.scale.setScalar(Math.min(1, (l.life - l.age) / FADE));
      const taken =
        l.landed &&
        pos !== null &&
        Math.hypot(pos.x - l.pos.x, pos.z - l.pos.z) < reach &&
        Math.abs(pos.y - l.floor) < reach;
      if (taken) {
        got.push({ kind: l.kind, amount: l.amount });
      }

      if (taken || l.age >= l.life) {
        this.remove(i);
      }
    }

    for (const g of got) {
      this.cash += g.amount;
    }

    return got;
  }

  private remove(i: number): void {
    const l = this.loot[i];
    if (!l) {
      return;
    }

    this.scene.remove(l.root);
    this.loot.splice(i, 1);
  }
}
