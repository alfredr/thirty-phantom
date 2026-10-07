/**
 * Read a UI value and draw it when it changes. draw() receives the previously
 * drawn value, or undefined on its first call. Supply same() when reference
 * equality does not describe a visible change.
 */
export interface Binding<T> {
  read(): T;
  draw(value: T, was: T | undefined): void;
  /** Whether two reads show the same thing. By default, ===. */
  same?(a: T, b: T): boolean;
}

/**
 * Refresh registered UI bindings from game state. Each update reads every
 * binding and redraws only values that differ from the last draw according to
 * that binding’s equality check.
 */
export class Bindings {
  private readonly rows: (() => void)[] = [];

  add<T>(binding: Binding<T>): void {
    const same = binding.same ?? ((a: T, b: T) => a === b);
    let last: { value: T } | null = null;
    this.rows.push(() => {
      const value = binding.read();
      if (last && same(value, last.value)) {
        return;
      }

      binding.draw(value, last?.value);
      last = { value };
    });
  }

  update(): void {
    for (const row of this.rows) {
      row();
    }
  }
}
