import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vector3 } from 'three';
import { loadModules } from './modules.mjs';

const [{ Walker }, { Polyline }, { NavJob, NAV }] = await loadModules('/src/actors/walker.ts', '/src/engine/nav/polyline.ts', '/src/world/nav-grid.ts');

const request = (x) => new NavJob(new Vector3(), new Vector3(x, 0, 0), NAV.person);
function finish(job) {
  job.path = new Polyline([job.from, job.to]);
  job.status = 'done';
}

test('a walker cancels a replaced route and starts the new route only once', () => {
  const walker = new Walker({});
  const old = request(3);
  const next = request(8);
  walker.plan(old, 2);
  assert.equal(walker.followPlanned(), 'waiting');
  walker.plan(next, 2);
  assert.equal(old.status, 'cancelled');
  finish(next);
  assert.equal(walker.followPlanned(), 'following');
  assert.equal(walker.goal, next.path.end);
  assert.equal(walker.planning, false);
  assert.equal(walker.followPlanned(), null, 'the completed request cannot restart the walk');

  const abandoned = request(12);
  walker.plan(abandoned, 2);
  walker.cancelPlan();
  assert.equal(abandoned.status, 'cancelled');
  assert.equal(walker.followPlanned(), null);
  assert.equal(walker.goal, next.path.end, 'cancelling a request preserves the route already being walked');
});

test('a fleeing walker finishes its dash before following the planned route', () => {
  const walker = new Walker({});
  const dash = new Polyline([new Vector3(), new Vector3(2, 0, 0)]);
  walker.follow(dash, 4);
  const route = request(10);
  walker.plan(route, 4);
  finish(route);
  assert.equal(walker.followPlanned(true), 'waiting');
  assert.equal(walker.goal, dash.end);
  walker.stop();
  assert.equal(walker.followPlanned(true), 'following');
  assert.equal(walker.goal, route.path.end);
});

test('a failed route is reported once and does not choose a walking pace', () => {
  const walker = new Walker({});
  const job = request(3);
  let choices = 0;
  walker.plan(job, () => { choices++; return 2; });
  job.status = 'failed';
  assert.equal(walker.followPlanned(), 'failed');
  assert.equal(walker.followPlanned(), null);
  assert.equal(walker.walking, false);
  assert.equal(choices, 0);
});
