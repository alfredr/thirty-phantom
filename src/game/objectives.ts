import type { Vector3 } from 'three';

/** A primary objective gets the big arrow; an optional one the small arrow, marked "(OPTIONAL)" by the HUD. */
export type ObjectiveKind = 'primary' | 'optional';

/** Something to point Cody at. `at` is live: whoever sets it keeps it current (a car's `pos`, a pickup's position). */
export interface Objective {
  id: string;
  /** Plain text ('PHANTOM TRUCK', 'YOUR BADGE'); the HUD adds "(OPTIONAL)" itself. */
  label: string;
  kind: ObjectiveKind;
  at: Vector3;
}

/**
 * The objectives the markers and the minimap point at right now: at most one
 * primary, any number of optional ones. Scripts set and remove them; the HUD
 * reads the list (and re-projects each `at`) every frame.
 */
export class Objectives {
  private items: Objective[] = [];
  private readonly listeners: (() => void)[] = [];

  get list(): readonly Objective[] {
    return this.items;
  }

  /** Replace the lot (`set([])` clears them). Only the first primary is kept. */
  set(list: readonly Objective[]): void {
    let primary = false;
    this.items = list.filter((o) => {
      if (o.kind !== 'primary') return true;
      if (primary) return false;
      primary = true;
      return true;
    });
    this.changed();
  }

  /** Add one, or replace the one with its id (a new primary replaces the old one). */
  add(o: Objective): void {
    this.set([...this.items.filter((x) => x.id !== o.id && !(o.kind === 'primary' && x.kind === 'primary')), o]);
  }

  remove(id: string): void {
    if (!this.items.some((o) => o.id === id)) return;
    this.items = this.items.filter((o) => o.id !== id);
    this.changed();
  }

  has(id: string): boolean {
    return this.items.some((o) => o.id === id);
  }

  /** Called whenever the list changes (not when an `at` moves). */
  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }
}
