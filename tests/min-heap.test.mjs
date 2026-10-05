import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadModules } from './modules.mjs';

const [{ MinHeap }, { Rng }] = await loadModules('/src/engine/core/min-heap.ts', '/src/engine/core/rng.ts');

test('the priority queue matches a sorted reference through interleaved inserts and removals', () => {
  const queue = new MinHeap();
  const remaining = new Map();
  const rng = new Rng(44);
  const pop = () => {
    const value = queue.pop();
    assert.equal(remaining.get(value), Math.min(...remaining.values()));
    remaining.delete(value);
    assert.equal(queue.size, remaining.size);
  };

  for (let id = 0; id < 300; id++) {
    const priority = rng.int(-20, 20);
    queue.push(id, priority);
    remaining.set(id, priority);

    if (rng.chance(0.6)) {
      pop();
    }
  }

  while (queue.size) {
    pop();
  }

  assert.throws(() => queue.pop(), RangeError);
  queue.push(999, 0);
  assert.equal(queue.pop(), 999);
});

test('object values retain their identity and the priority captured at insertion', () => {
  const queue = new MinHeap();
  const a = { cost: 3 };
  const b = { cost: 1 };
  queue.push(a, a.cost);
  queue.push(b, b.cost);
  a.cost = 0;
  assert.equal(queue.pop(), b);
  assert.equal(queue.pop(), a);
});
