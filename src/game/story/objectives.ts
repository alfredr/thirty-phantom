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
 * primary, any number of optional ones. Each source replaces its own markers; the HUD
 * reads the list (and re-projects each `at`) every frame.
 */
export class Objectives {
  /** The current task, shared by the HUD and the phone's task list. */
  goal: string | null = null;
  private readonly sources = new Map<object, readonly Objective[]>();
  private items: Objective[] = [];

  get list(): readonly Objective[] {
    return this.items;
  }

  /** Replace this source's markers. An empty list clears only that source. The first primary wins. */
  replace(source: object, list: readonly Objective[]): void {
    if (list.length) this.sources.set(source, list);
    else this.sources.delete(source);
    let primary = false;
    this.items = [...this.sources.values()].flat().filter((o) => {
      if (o.kind !== 'primary') return true;
      if (primary) return false;
      primary = true;
      return true;
    });
  }

  has(id: string): boolean {
    return this.items.some((o) => o.id === id);
  }
}
