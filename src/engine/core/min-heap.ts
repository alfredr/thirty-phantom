/**
 * A minimum-priority queue. Priorities are captured on insertion; equal
 * priorities have no guaranteed order.
 */
export class MinHeap<T> {
  private readonly values: T[] = [];
  private readonly priorities: number[] = [];

  get size(): number {
    return this.values.length;
  }

  push(value: T, priority: number): void {
    const values = this.values;
    const priorities = this.priorities;
    let k = values.length;
    values.push(value);
    priorities.push(priority);

    while (k > 0) {
      const up = (k - 1) >> 1;
      if (priorities[up]! <= priority) {
        break;
      }

      values[k] = values[up]!;
      priorities[k] = priorities[up]!;
      k = up;
    }

    values[k] = value;
    priorities[k] = priority;
  }

  pop(): T {
    const values = this.values;
    const priorities = this.priorities;
    if (!values.length) {
      throw new RangeError('Cannot pop an empty heap');
    }

    const top = values[0]!;
    const value = values.pop()!;
    const priority = priorities.pop()!;
    if (!values.length) {
      return top;
    }

    let k = 0;
    for (;;) {
      const left = k * 2 + 1;
      if (left >= values.length) {
        break;
      }

      const right = left + 1;
      const child =
        right < values.length && priorities[right]! < priorities[left]!
          ? right
          : left;
      if (priorities[child]! >= priority) {
        break;
      }

      values[k] = values[child]!;
      priorities[k] = priorities[child]!;
      k = child;
    }

    values[k] = value;
    priorities[k] = priority;
    return top;
  }
}
