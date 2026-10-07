import type { Vector3 } from 'three';

/**
 * Primary objectives use the large arrow; optional objectives use smaller
 * arrows and an optional label. Pins appear only on the minimap.
 */
export type ObjectiveKind = 'primary' | 'optional' | 'pin';

/** A marker target whose position reference is kept current by its owner. */
export interface Objective {
  id: string;
  /** Plain display text; the HUD adds the optional suffix. */
  label: string;
  kind: ObjectiveKind;
  at: Vector3;
  color?: string;
}

/**
 * Combine marker sources into at most one primary objective and any number of
 * optional objectives. Each source replaces only its own entries.
 */
export class Objectives {
  /** The current task, shared by the HUD and the phone's task list. */
  goal: string | null = null;
  how: string | null = null;
  private readonly sources = new Map<object, readonly Objective[]>();
  private items: Objective[] = [];
  private pinned: Objective[] = [];

  get list(): readonly Objective[] {
    return this.items;
  }

  get pins(): readonly Objective[] {
    return this.pinned;
  }

  /**
   * Replace this source's markers. An empty list clears only that source. The
   * first primary wins.
   */
  replace(source: object, list: readonly Objective[]): void {
    if (list.length) {
      this.sources.set(source, list);
    } else {
      this.sources.delete(source);
    }

    let primary = false;
    const all = [...this.sources.values()].flat();
    this.pinned = all.filter((o) => o.kind === 'pin');
    this.items = all.filter((o) => {
      if (o.kind === 'pin') {
        return false;
      }

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
