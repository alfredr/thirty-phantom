import type { Vector3 } from 'three';

/** Primary objectives use the large arrow; optional objectives use smaller arrows and an optional label. */
export type ObjectiveKind = 'primary' | 'optional';

/** A marker target whose position reference is kept current by its owner. */
export interface Objective {
  id: string;
  /** Plain display text; the HUD adds the optional suffix. */
  label: string;
  kind: ObjectiveKind;
  at: Vector3;
}

/**
 * Combine marker sources into at most one primary objective and any number of optional objectives. Each source replaces
 * only its own entries.
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
    if (list.length) {
      this.sources.set(source, list);
    } else {
      this.sources.delete(source);
    }

    let primary = false;
    this.items = [...this.sources.values()].flat().filter((o) => {
      if (o.kind !== 'primary') {
        return true;
      }

      if (primary) {
        return false;
      }

      primary = true;
      return true;
    });
  }

  has(id: string): boolean {
    return this.items.some((o) => o.id === id);
  }
}
