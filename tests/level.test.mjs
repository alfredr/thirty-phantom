import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadModules } from './modules.mjs';

const [{ parseLevel }, { generateLevel }, { loadLevel }, { emptyLevel }, { stairShaft, elevatorShaft }] =
  await loadModules(
    '/src/world/parse-level.ts',
    '/src/world/generate-level.ts',
    '/src/world/load-level.ts',
    '/src/world/level-data.ts',
    '/src/world/gen-deck.ts',
  );
const generated = JSON.parse(JSON.stringify(generateLevel()));

test('the street surface leaves the basement stair and elevator shafts open', () => {
  const [x, , z] = generated.deck.min;
  const shafts = [stairShaft([x, 0, z]), elevatorShaft([x, 0, z])];
  const ground = generated.boxes.filter((b) => b.mat === 'asphalt' && b.min[1] < 0 && b.max[1] === 0);
  assert.ok(ground.length > 0, 'retain the surrounding street surface');

  for (const [x0, z0, x1, z1] of shafts) {
    for (const b of ground) {
      const overlaps = b.min[0] < x1 && b.max[0] > x0 && b.min[2] < z1 && b.max[2] > z0;
      assert.equal(overlaps, false, 'no street slab may cross a shaft opening');
    }
  }

  const area = ground.reduce((sum, b) => sum + (b.max[0] - b.min[0]) * (b.max[2] - b.min[2]), 0);
  const holes = shafts.reduce((sum, [x0, z0, x1, z1]) => sum + (x1 - x0) * (z1 - z0), 0);
  const minX = Math.min(...ground.map((b) => b.min[0]));
  const maxX = Math.max(...ground.map((b) => b.max[0]));
  const minZ = Math.min(...ground.map((b) => b.min[2]));
  const maxZ = Math.max(...ground.map((b) => b.max[2]));
  assert.ok(Math.abs(area + holes - (maxX - minX) * (maxZ - minZ)) < 1e-8, 'remove only the two shaft openings');
});

test('generated cities round-trip through the level parser', () => {
  for (const seed of [1, 30, 99]) {
    const data = JSON.parse(JSON.stringify(generateLevel(seed)));
    assert.deepEqual(parseLevel(data), data);
  }
});

test('v1 levels default omitted collections and names without changing the input', () => {
  const { playerSpawn, deck } = emptyLevel('minimal');
  const input = { version: 1, boxes: [], playerSpawn, deck, name: 'minimal' };
  const before = structuredClone(input);
  assert.deepEqual(parseLevel(input), emptyLevel('minimal'));
  assert.deepEqual(input, before);
  delete input.name;
  const first = parseLevel(input);
  assert.equal(first.name, 'custom');
  first.ramps.push({});
  assert.deepEqual(parseLevel(input).ramps, []);
  assert.equal(input.name, undefined);
});

test('custom levels can omit optional sections', () => {
  const data = structuredClone(generated);
  for (const key of ['bays', 'elevators', 'decor', 'buildings']) {
    delete data[key];
  }

  const parsed = parseLevel(data);
  for (const key of ['bays', 'elevators', 'decor', 'buildings']) {
    assert.deepEqual(parsed[key], []);
  }

  assert.deepEqual(parsed.boxes, generated.boxes);
});

test('rejects malformed root values and explicit nulls', () => {
  for (const data of [null, [], 'level', {}, { version: 2, boxes: [] }, { version: 1 }]) {
    assert.throws(() => parseLevel(data), /level/);
  }

  for (const key of ['boxes', 'ramps', 'spots', 'deck', 'playerSpawn', 'name']) {
    assert.throws(() => parseLevel({ ...generated, [key]: null }), new RegExp(`level\\.${key}`));
  }
});

test('requires an explicit supported version, geometry, spawn, and deck', () => {
  for (const key of ['version', 'boxes', 'playerSpawn', 'deck']) {
    const data = structuredClone(generated);
    delete data[key];
    assert.throws(() => parseLevel(data), new RegExp(`level\\.${key}`));
  }

  for (const version of [0, 2, 1.1, '1', null]) {
    assert.throws(() => parseLevel({ ...generated, version }), /level\.version: unsupported format version/);
  }
});

test('rejects unknown fields instead of silently dropping them', () => {
  assert.throws(() => parseLevel({ ...generated, ramp: [] }), /level\.ramp:/);
  const data = structuredClone(generated);
  data.boxes[0].material = data.boxes[0].mat;
  const before = structuredClone(data);
  assert.throws(() => parseLevel(data), /level\.boxes\[0\]\.material:/);
  assert.deepEqual(data, before);
});

const invalid = [
  [
    'boxes[0].min',
    (d) => {
      d.boxes[0].min = [0, 1];
    },
  ],
  [
    'boxes[0].max[0]',
    (d) => {
      d.boxes[0].max[0] = Infinity;
    },
  ],
  [
    'boxes[0].max[0]',
    (d) => {
      d.boxes[0].max[0] = d.boxes[0].min[0] - 1;
    },
  ],
  [
    'boxes[0].mat',
    (d) => {
      d.boxes[0].mat = 'missing';
    },
  ],
  [
    'boxes[0].solid',
    (d) => {
      d.boxes[0].solid = 'false';
    },
  ],
  [
    'boxes[0].facade.bay',
    (d) => {
      d.boxes[0].facade = { kind: 'wall', bay: 0 };
    },
  ],
  [
    'boxes[0].facade.street',
    (d) => {
      d.boxes[0].facade = { kind: 'wall', street: { up: 'shop' } };
    },
  ],
  [
    'ramps[0].dir',
    (d) => {
      d.ramps[0].dir = 0;
    },
  ],
  [
    'ramps[0].low',
    (d) => {
      d.ramps[0].low = d.ramps[0].max[1] + 1;
    },
  ],
  [
    'signs[0].style',
    (d) => {
      d.signs[0].style = 'unknown';
    },
  ],
  [
    'signs[0].lines[0]',
    (d) => {
      d.signs[0].lines = [9];
    },
  ],
  [
    'spots[0].id',
    (d) => {
      d.spots[0].id = 9;
    },
  ],
  [
    'spots[0].level',
    (d) => {
      d.spots[0].level = d.deck.floors.length;
    },
  ],
  [
    'spots[0].size[0]',
    (d) => {
      d.spots[0].size[0] = -1;
    },
  ],
  [
    'paths[0].points',
    (d) => {
      d.paths[0].points = [];
    },
  ],
  [
    'paths[0].points',
    (d) => {
      d.paths[0].points = [
        [0, 0, 0],
        [0, 0, 0],
      ];
    },
  ],
  [
    'decor[0].kind',
    (d) => {
      d.decor[0].kind = 'missing';
    },
  ],
  [
    'decor[0].scale',
    (d) => {
      d.decor[0].scale = 0;
    },
  ],
  [
    'buildings[0].core.rect',
    (d) => {
      d.buildings[0].core = { kind: 'stair', rect: [2, 2, 1, 1] };
    },
  ],
  [
    'elevators[0].stops',
    (d) => {
      d.elevators[0].stops = [];
    },
  ],
  [
    'elevators[0].stops',
    (d) => {
      d.elevators[0].stops.reverse();
    },
  ],
  [
    'elevators[0].stops[0].y',
    (d) => {
      d.elevators[0].stops[0].y = d.elevators[0].min[1] - 1;
    },
  ],
  [
    'playerSpawn[1]',
    (d) => {
      d.playerSpawn[1] = NaN;
    },
  ],
  [
    'deck.floors',
    (d) => {
      d.deck.floors = [];
    },
  ],
  [
    'deck.floors',
    (d) => {
      d.deck.floors = [10, 0];
    },
  ],
];

test('rejects invalid nested values with a field path', () => {
  for (const [path, mutate] of invalid) {
    const data = structuredClone(generated);
    mutate(data);
    assert.throws(
      () => parseLevel(data),
      (err) => err.message.includes(`level.${path}`),
      path,
    );
  }
});

test('the loader accepts valid levels and falls back on malformed data or fetch errors', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(generated)));
  assert.deepEqual(await loadLevel('/custom.json'), generated);
  assert.equal(warn.mock.callCount(), 0);

  const bad = { version: 1, boxes: [], playerSpawn: [0, 0, 0], deck: null };
  fetch.mock.mockImplementation(async () => new Response(JSON.stringify(bad)));
  assert.equal((await loadLevel('/bad.json')).name, 'phantom-city');
  assert.match(warn.mock.calls[0].arguments[1].message, /level\.deck/);
  fetch.mock.mockImplementation(async () => new Response('', { status: 404 }));
  assert.equal((await loadLevel('/missing.json')).name, 'phantom-city');
  fetch.mock.mockImplementation(async () => {
    throw new Error('offline');
  });
  assert.equal((await loadLevel('/offline.json')).name, 'phantom-city');
  assert.equal(warn.mock.callCount(), 3);

  assert.equal((await loadLevel(null)).name, 'phantom-city');
  assert.equal(fetch.mock.callCount(), 4);
});
