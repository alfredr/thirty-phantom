import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [
  { RouteShaper, toLegs },
  { DrivePlan },
  { Polyline },
  { clipBox },
  { TUNING },
] = await loadModules(
  '/src/engine/nav/route-shaper.ts',
  '/src/engine/nav/drive-plan.ts',
  '/src/engine/nav/polyline.ts',
  '/src/engine/core/geometry.ts',
  '/src/config.ts',
);

const point = (x, z, y = 0) => new Vector3(x, y, z);
const flat = { cost: (a, b) => a.distanceTo(b), heightAt: () => 0 };

test('arc lengths include slopes and the closing segment of a loop', () => {
  const points = [point(0, 0), point(3, 0, 4), point(3, 12, 4)];
  const open = new Polyline(points);
  const loop = new Polyline(points, true);
  assert.deepEqual(open.distances, [0, 5, 17]);
  assert.deepEqual(loop.distances, [0, 5, 17, 30]);

  for (const path of [open, loop]) {
    assert.equal(path.total, path.distances.at(-1));
    points.forEach((p, i) =>
      assert.ok(
        path.sample(path.distances[i], new Vector3()).distanceTo(p) < 1e-10,
      ),
    );
  }
});

test('smoothing respects traversal cost and preserves both ends of an elevator ride', () => {
  const raw = [
    point(0, 0),
    point(2, 0),
    point(4, 0),
    point(6, 0),
    point(8, 0),
  ];
  const costs = [0, 2, 4, 6, 8];
  const shape = new RouteShaper(0, flat);
  assert.deepEqual(shape.smooth(raw, costs), [raw[0], raw[4]]);
  assert.deepEqual(shape.smooth(raw, costs, new Map([[1, 'lift']])), [
    raw[0],
    raw[1],
    raw[2],
    raw[4],
  ]);

  const costly = new RouteShaper(0, {
    ...flat,
    cost: (a, b) => (a.distanceTo(b) > 2 ? 100 : 2),
  });
  assert.deepEqual(costly.smooth(raw, costs), raw);
});

test('merging shallow bends keeps a detour when the shortcut crosses an obstacle', () => {
  const detour = [point(0, 0), point(4, 0.5), point(8, 0)];
  const blocked = new RouteShaper(3, {
    ...flat,
    cost: (a, b) =>
      clipBox(
        a.toArray(),
        b.clone().sub(a).toArray(),
        [3.5, -1, -0.1],
        [4.5, 1, 0.1],
        [0, 1],
      )
        ? Infinity
        : a.distanceTo(b),
  });
  assert.deepEqual(blocked.merge(detour), detour);
  assert.deepEqual(new RouteShaper(3, flat).merge(detour), [
    detour[0],
    detour[2],
  ]);
});

test('corner arcs retain the requested radius for left and right turns', () => {
  const radius = 3;
  const shape = new RouteShaper(radius, flat);
  for (const side of [-1, 1]) {
    const raw = [point(0, 0), point(0, 10), point(side * 10, 10)];
    const route = shape.corners(raw);
    const arc = route.slice(1, -1);
    const center = point(side * radius, 10 - radius);
    assert.equal(route[0].p, raw[0]);
    assert.equal(route.at(-1).p, raw[2]);
    assert.ok(arc.length > 2);

    for (const { p, reverse } of arc) {
      assert.ok(Math.abs(p.distanceTo(center) - radius) < 1e-10);
      assert.equal(reverse, false);
    }

    assert.ok(arc[0].p.distanceTo(point(0, 7)) < 1e-10);
    assert.ok(arc.at(-1).p.distanceTo(point(side * 3, 10)) < 1e-10);
  }
});

test('an obstructed corner stays sharp and requests a vehicle maneuver', () => {
  const shape = new RouteShaper(3, { ...flat, cost: () => Infinity });
  const raw = [point(0, 0), point(0, 10), point(10, 10)];
  const failed = [];
  assert.deepEqual(
    shape.corners(raw, failed).map((r) => r.p),
    raw,
  );
  assert.deepEqual(failed, [1]);
});

test('forward and reverse legs share each cusp without dropping travel', () => {
  const route = [
    { p: point(0, 0), reverse: false },
    { p: point(0, 4), reverse: false },
    { p: point(0, 2), reverse: true },
    { p: point(0, 6), reverse: false },
  ];
  const legs = toLegs(route);
  assert.deepEqual(
    legs.map((l) => l.reverse),
    [false, true, false],
  );
  assert.deepEqual(
    legs.map((l) => l.path.total),
    [4, 2, 4],
  );

  for (let i = 0; i < legs.length - 1; i++) {
    assert.deepEqual(legs[i].path.end, legs[i + 1].path.points[0]);
  }
});

function drivePlan(fits = () => 0) {
  const from = { x: 0, y: 0, z: 0, yaw: 0, reverse: false };
  const goal = { ...from, z: 30, rest: 0 };
  const ground = {
    stepUp: 0.3,
    fits,
    cost: () => 1,
    clearance: () => 10,
    toGo: () => Infinity,
  };
  return new DrivePlan(
    [point(0, 0), point(0, 30)],
    new RouteShaper(4, flat),
    {
      ground,
      heightAt: () => 0,
      guide: (_bounds, goals) => (x, _y, z) =>
        Math.min(...goals.map((g) => Math.hypot(g.x - x, g.z - z))),
    },
    { from, goals: [goal], vehicle: TUNING.car },
  );
}

test('resuming vehicle searches produces the same route as an uninterrupted search', () => {
  const whole = drivePlan();
  const expected = whole.advance(Infinity);
  assert.ok(expected);
  assert.equal(whole.drivable, true);
  assert.ok(expected.at(-1).p.distanceTo(point(0, 30)) < 0.6);

  const sliced = drivePlan();
  assert.equal(sliced.advance(-Infinity), null);
  let route = null;
  for (let i = 0; !route && i < 500; i++) {
    route = sliced.advance(-Infinity);
  }

  assert.deepEqual(route, expected);
  assert.equal(sliced.expanded, whole.expanded);
  assert.equal(sliced.drivable, true);
  assert.deepEqual(sliced.layout, whole.layout);
  assert.equal(sliced.advance(Infinity), route);
  assert.equal(sliced.expanded, whole.expanded);
});

test('failed vehicle searches retain endpoint guidance and report an undrivable route', () => {
  const plan = drivePlan(() => null);
  const route = plan.advance(Infinity);
  assert.equal(plan.drivable, false);
  assert.deepEqual(
    route.map((r) => r.p),
    [point(0, 0), point(0, 30)],
  );
  assert.ok(plan.layout.some((line) => line.includes('failed')));
});
