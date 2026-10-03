import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BufferGeometry,
  Frustum,
  Line,
  Matrix4,
  Mesh,
  OrthographicCamera,
  Points,
  Sphere,
  Sprite,
  Vector3,
} from 'three';
import { loadModules } from './modules.mjs';

const [{ curveCull, curveFrame }] = await loadModules('/src/render/curvature.ts');

function setup(t, radius = 2) {
  const camera = new OrthographicCamera(-12, 12, 12, -12, 1, 700);
  const focus = new Vector3(0, -4.8, 0);
  camera.position.copy(focus).add(new Vector3(100, 100, 100));
  camera.lookAt(focus);
  camera.updateMatrixWorld();
  curveFrame.planet.set(focus.x, focus.y, focus.z, 240);
  curveFrame.lean = 0;
  const center = focus.clone().add(new Vector3(0, 1.2, 0));
  curveCull(camera, center, radius);
  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    camera.coordinateSystem, camera.reversedDepth,
  );
  t.after(() => curveCull(null));
  return { center, frustum, right: new Vector3(1, 0, -1).normalize() };
}

function objectAt(Type, center) {
  const geometry = new BufferGeometry();
  geometry.boundingSphere = new Sphere(new Vector3(), 0.4);
  const object = Type === Sprite ? new Sprite() : new Type(geometry);
  object.position.copy(center);
  object.updateMatrixWorld();
  return object;
}

test('the x-ray opening keeps underground actors and effects visible', (t) => {
  const { center, frustum } = setup(t);
  for (const Type of [Mesh, Line, Points, Sprite]) {
    assert.equal(objectAt(Type, center).intersectsFrustum(frustum), true, Type.name);
  }
});

test('objects crossing the x-ray edge remain visible, while buried objects outside it are culled', (t) => {
  const { center, frustum, right } = setup(t);
  const edge = objectAt(Mesh, center.clone().addScaledVector(right, 2.3));
  const outside = objectAt(Mesh, center.clone().addScaledVector(right, 3));
  assert.equal(edge.intersectsFrustum(frustum), true);
  assert.equal(outside.intersectsFrustum(frustum), false);
});

test('closing the x-ray window restores ground occlusion without hiding objects above ground', (t) => {
  const { center, frustum } = setup(t, 0);
  assert.equal(objectAt(Mesh, center).intersectsFrustum(frustum), false);
  assert.equal(objectAt(Mesh, center.clone().setY(1.2)).intersectsFrustum(frustum), true);
});

test('the x-ray window still respects the camera frustum', (t) => {
  const { center, frustum } = setup(t, 1000);
  const offscreen = objectAt(Mesh, center.clone().add(new Vector3(100, 0, -100)));
  assert.equal(offscreen.intersectsFrustum(frustum), false);
});
