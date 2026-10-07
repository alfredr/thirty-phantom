import { type Release, releaseOnce } from '@/engine/core/disposable';

export class Leases<T> {
  private readonly held: { value: T }[] = [];

  constructor(
    private readonly apply: (top: T | null) => void = () => undefined,
  ) {}

  get top(): T | null {
    return this.held.at(-1)?.value ?? null;
  }

  take(value: T): Release {
    const entry = { value };
    const release = releaseOnce(() => {
      const i = this.held.indexOf(entry);
      if (i < 0) {
        return;
      }

      const top = i === this.held.length - 1;
      this.held.splice(i, 1);

      if (top) {
        this.apply(this.top);
      }
    });
    this.held.push(entry);

    try {
      this.apply(value);
    } catch (error) {
      release();
      throw error;
    }

    return release;
  }

  clear(): void {
    if (!this.held.length) {
      return;
    }

    this.held.length = 0;
    this.apply(null);
  }
}
