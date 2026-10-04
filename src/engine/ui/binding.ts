/**
 * Part of the screen that shows some of the game's state. read() takes the state as it is now; draw() shows it, and
 * runs only when what's read has changed since it last drew (`was` is what it drew then, undefined the first time).
 */
export interface Binding<T> {
  read(): T;
  draw(value: T, was: T | undefined): void;
  /** Whether two reads show the same thing. By default, ===. */
  same?(a: T, b: T): boolean;
}

/**
 * Bindings drawn together once a frame: each reads its state, and redraws only if that changed. The screen pulls from
 * the game, so the game never has to push to it, and nothing redraws for a value that's the same as last frame's.
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
