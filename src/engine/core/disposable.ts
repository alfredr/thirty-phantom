if (!Symbol.dispose) {
  Object.defineProperty(Symbol, 'dispose', {
    value: Symbol.for('Symbol.dispose'),
  });
}

export type Release = (() => void) & Disposable;

export class Disposables implements Disposable {
  private items: Disposable[] | null = [];

  use<T extends Disposable>(item: T): T {
    if (!this.items) {
      throw new Error('Resource scope is already closed');
    }

    this.items.push(item);
    return item;
  }

  [Symbol.dispose](): void {
    const items = this.items;
    this.items = null;
    const errors: unknown[] = [];
    for (const item of items?.reverse() ?? []) {
      try {
        item[Symbol.dispose]();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length) {
      throw new AggregateError(errors, 'Resource cleanup failed');
    }
  }
}

export function releaseOnce(stop: () => void): Release {
  let active = true;
  const release = (): void => {
    if (!active) {
      return;
    }

    active = false;
    stop();
  };

  return Object.assign(release, { [Symbol.dispose]: release });
}
