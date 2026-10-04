import {
  Frustum,
  Line,
  type Material,
  Matrix4,
  Mesh,
  type Object3D,
  type OrthographicCamera,
  Points,
  Sphere,
  Sprite,
  Vector2,
  Vector3,
  Vector4,
  type WebGLProgramParametersWithUniforms,
} from 'three';

import { TUNING } from '@/config';
import { urlChoice } from '@/engine/core/url-flags';

/**
 * Render the isometric world on a sphere centred beneath the camera focus. Horizontal distance becomes arc length;
 * height extends vertically or along the sphere's radius according to `lean`.
 *
 * This affects rendering and culling only. Physics, lighting, shadows, and texture coordinates use flat positions. A
 * zero radius disables the bend for a render; disabling CURVE_ON also skips material patches and subdivision.
 */

/** Whether the world can curve (TUNING.camera.curve.on, or ?curve=0 / ?curve=1). */
export const CURVE_ON = ((): boolean => {
  const flag = urlChoice('curve', ['0', '1']);
  return flag ? flag === '1' : TUNING.camera.curve.on;
})();

/** Subdivision grid spacing in meters for render/geometry.ts, or zero when curvature is disabled. */
export const CURVE_TILE: number = CURVE_ON ? TUNING.camera.curve.tile : 0;

/**
 * Maximum bend angle in radians. Sink geometry near this limit to prevent the distant city from wrapping around the
 * sphere and reappearing beneath the focus.
 */
const PHI_MAX = 2.6;
/** Angular interval in radians over which geometry sinks before PHI_MAX. */
const SINK = 0.25;

export const curveUniforms = {
  /** xyz: the bend's centre (the iso view's focus); w: the planet's radius, 0 for flat. */
  uCurve: { value: new Vector4() },
  /** How far heights stand out along the sphere's radius rather than straight up, 0..1. */
  uCurveLean: { value: 0 },
};

/**
 * Current isometric bend parameters for HUD projection and culling. curveCull activates these uniforms only during the
 * isometric render so other renders using shared materials remain flat. A zero w disables curvature.
 */
export const curveFrame = { planet: new Vector4(), lean: 0 };

const HEAD = /* glsl */ `
uniform vec4 uCurve;
uniform float uCurveLean;
vec3 curveBend(vec3 p) {
  float R = uCurve.w;
  if (R <= 0.0) return p;
  vec2 o = p.xz - uCurve.xz;
  float d = length(o);
  float phi = d / R;
  float sink = 0.9 * smoothstep(${(PHI_MAX - SINK).toFixed(3)}, ${PHI_MAX.toFixed(3)}, phi);
  phi = min(phi, ${PHI_MAX.toFixed(3)});
  vec2 dir = o / max(d, 1e-5);
  vec3 n = vec3(dir.x * sin(phi), cos(phi), dir.y * sin(phi));
  // Place the focus-height surface on the sphere and offset elevation along the blended up direction.
  vec3 q = R * n - vec3(0.0, R, 0.0) + (p.y - uCurve.y) * normalize(mix(vec3(0.0, 1.0, 0.0), n, uCurveLean));
  return uCurve.xyz + mix(q, vec3(0.0, -R, 0.0), sink);
}
`;

/** The vertex's world position, as three's chunks build it (instancing and batching included). */
const WORLD = /* glsl */ `
    vec4 curveWp = vec4(transformed, 1.0);
    #ifdef USE_BATCHING
      curveWp = batchingMatrix * curveWp;
    #endif
    #ifdef USE_INSTANCING
      curveWp = instanceMatrix * curveWp;
    #endif
    curveWp = modelMatrix * curveWp;
`;

/**
 * Patch supported mesh or sprite shaders to project curved world positions. Mesh lighting retains flat mvPosition;
 * sprites bend at their centres. If provided, `bent` names an existing vec3 receiving the mesh's bent position. Return
 * false when neither supported shader pattern is present.
 */
export function curveVertex(shader: WebGLProgramParametersWithUniforms, bent = ''): boolean {
  const vs = shader.vertexShader;
  const out = bent ? `${bent} = curveBent;` : '';
  let next: string;
  if (vs.includes('#include <project_vertex>')) {
    next = vs.replace(
      '#include <project_vertex>',
      `#include <project_vertex>\n  {\n${WORLD}    vec3 curveBent = curveBend(curveWp.xyz);\n    ${out}\n    gl_Position = projectionMatrix * viewMatrix * vec4(curveBent, 1.0);\n  }`,
    );
  } else if (vs.includes('vec4 mvPosition = modelViewMatrix[ 3 ];')) {
    next = vs.replace(
      'vec4 mvPosition = modelViewMatrix[ 3 ];',
      'vec4 mvPosition = viewMatrix * vec4( curveBend( modelMatrix[ 3 ].xyz ), 1.0 );',
    );
  } else {
    return false;
  }

  shader.vertexShader = HEAD + next;
  Object.assign(shader.uniforms, curveUniforms);
  return true;
}

const curved = new WeakSet<Material>();

/**
 * Install the curvature shader patch once per material and return it. Skip patching when CURVE_ON is false. Cloned
 * materials must be patched separately because cloning does not preserve onBeforeCompile.
 */
export function withCurve<T extends Material>(mat: T): T {
  if (!CURVE_ON || curved.has(mat)) {
    return mat;
  }

  curved.add(mat);
  const prev = mat.onBeforeCompile.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    curveVertex(shader);
  };

  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => prevKey() + '|curve1';
  return mat;
}

/** Record a material already patched by the cutaway code so curveSweep does not patch it again. */
export function markCurved(mat: Material): void {
  curved.add(mat);
}

/**
 * Patch all unregistered materials under `root` and request shader recompilation. Call again after adding objects or
 * cloning materials. Do nothing when curvature is disabled.
 */
export function curveSweep(root: Object3D): void {
  if (!CURVE_ON) {
    return;
  }

  root.traverse((o) => {
    const m = (o as Mesh).material as Material | Material[] | undefined;
    if (!m) {
      return;
    }

    for (const mat of Array.isArray(m) ? m : [m]) {
      if (curved.has(mat)) {
        continue;
      }

      withCurve(mat);
      mat.needsUpdate = true;
    }
  });
}

const _o = new Vector2();

const _n = new Vector3();
const _up = new Vector3();

/** Bends a world point in place, as the shaders do (HUD markers, culling). */
export function curvePoint(p: Vector3): Vector3 {
  const c = curveFrame.planet;
  const R = c.w;
  if (R <= 0) {
    return p;
  }

  _o.set(p.x - c.x, p.z - c.z);
  const d = _o.length();
  let phi = d / R;
  const sink = 0.9 * smooth(PHI_MAX - SINK, PHI_MAX, phi);
  phi = Math.min(phi, PHI_MAX);
  const k = Math.sin(phi) / Math.max(d, 1e-5);
  _n.set(_o.x * k, Math.cos(phi), _o.y * k);
  _up.set(0, 1, 0).lerp(_n, curveFrame.lean).normalize();
  _up.multiplyScalar(p.y - c.y).addScaledVector(_n, R);
  _up.y -= R;
  _up.lerp(_n.set(0, -R, 0), sink);
  return p.set(c.x + _up.x, c.y + _up.y, c.z + _up.z);
}

/**
 * Return the flat-world screen height needed to cover ground visible at the curved viewport's top edge. `halfH` is the
 * viewport half-height in world units and `elevation` is the camera elevation in radians.
 */
export function curveTop(halfH: number, elevation: number): number {
  const R = curveFrame.planet.w;
  if (R <= 0) {
    return halfH;
  }

  // A surface point at angle phi projects R * (cos(phi - elevation) - cos(elevation)) above the focus.
  const phi = elevation - Math.acos(Math.min(1, Math.cos(elevation) + halfH / R));
  return R * phi * Math.sin(elevation);
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------- culling

/**
 * Curvature-aware culling state for the active isometric camera. Test each object's bent bounding sphere against the
 * view frustum and the planet horizon, expanding its radius to account for height-dependent stretching.
 */
const cull = {
  camera: null as OrthographicCamera | null,
  frustum: new Frustum(),
  /** Unit vector toward the camera. */
  toCam: new Vector3(),
  cutCenter: new Vector3(),
  cutRadius: 0,
};
const _m = new Matrix4();
const _s = new Sphere();
const _c = new Vector3();
const _spriteCentre = new Vector2(0.5, 0.5);

/**
 * Activate curveFrame for an isometric render and configure its culling frustum. The optional cutaway centre uses bent
 * world coordinates. Pass null to restore flat rendering for subsequent passes.
 */
export function curveCull(camera: OrthographicCamera | null, cutCenter?: Vector3, cutRadius = 0): void {
  const u = curveUniforms;
  cull.camera = camera && curveFrame.planet.w > 0 ? camera : null;
  cull.cutRadius = cutCenter ? cutRadius : 0;

  if (cutCenter) {
    cull.cutCenter.copy(cutCenter);
  }

  if (!cull.camera || !camera) {
    u.uCurve.value.w = 0;
    return;
  }

  u.uCurve.value.copy(curveFrame.planet);
  u.uCurveLean.value = curveFrame.lean;
  camera.updateMatrixWorld();
  _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  cull.frustum.setFromProjectionMatrix(_m, camera.coordinateSystem, camera.reversedDepth);
  camera.getWorldDirection(cull.toCam).negate();
}

/** Compare planes to identify the main camera frustum without relying on object identity. */
function isMain(f: Frustum): boolean {
  const a = f.planes;
  const b = cull.frustum.planes;
  for (let i = 0; i < 6; i++) {
    const p = a[i]!;
    const q = b[i]!;
    if (
      p.constant !== q.constant ||
      p.normal.x !== q.normal.x ||
      p.normal.y !== q.normal.y ||
      p.normal.z !== q.normal.z
    ) {
      return false;
    }
  }

  return true;
}

/** Bend and expand the world-space sphere `_s`, then test its visibility against the frustum and horizon. */
function bentVisible(): boolean {
  const c = curveFrame.planet;
  const R = c.w;
  // Bound the radial expansion caused by leaning geometry above or below the focus height.
  const tall = Math.max(Math.abs(_s.center.y + _s.radius - c.y), Math.abs(_s.center.y - _s.radius - c.y));
  const stretch = 1 + (curveFrame.lean * tall) / R;
  curvePoint(_s.center);
  _s.radius *= stretch;

  if (!cull.frustum.intersectsSphere(_s)) {
    return false;
  }

  // The ground has an opening here. Let depth testing decide what is visible through it,
  // including basement actors that would otherwise be hidden inside the street's sphere.
  if (cull.cutRadius > 0.01) {
    _c.subVectors(_s.center, cull.cutCenter);
    const along = _c.dot(cull.toCam);
    const radius = cull.cutRadius + _s.radius;
    if (_c.lengthSq() - along * along <= radius * radius) {
      return true;
    }
  }

  // Reject spheres fully hidden behind the curved street surface.
  _c.set(_s.center.x - c.x, _s.center.y + R, _s.center.z - c.z);
  const along = _c.dot(cull.toCam);
  const perp = Math.sqrt(Math.max(_c.lengthSq() - along * along, 0)) + _s.radius;
  return perp >= R || along + _s.radius >= Math.sqrt(R * R - perp * perp);
}

function objectSphere(o: Mesh | Line | Points): void {
  const own = (o as { boundingSphere?: Sphere | null }).boundingSphere;
  if (own !== undefined) {
    if (own === null) {
      (o as unknown as { computeBoundingSphere(): void }).computeBoundingSphere();
    }

    _s.copy((o as unknown as { boundingSphere: Sphere }).boundingSphere);
  } else {
    if (o.geometry.boundingSphere === null) {
      o.geometry.computeBoundingSphere();
    }

    _s.copy(o.geometry.boundingSphere!);
  }

  _s.applyMatrix4(o.matrixWorld);
}

if (CURVE_ON) {
  for (const cls of [Mesh, Line, Points]) {
    const flat = cls.prototype.intersectsFrustum;
    cls.prototype.intersectsFrustum = function (this: Mesh | Line | Points, f: Frustum): boolean {
      if (!cull.camera || !isMain(f)) {
        return flat.call(this, f);
      }

      objectSphere(this);
      return bentVisible();
    };
  }

  const flatSprite = Sprite.prototype.intersectsFrustum;
  Sprite.prototype.intersectsFrustum = function (this: Sprite, f: Frustum): boolean {
    if (!cull.camera || !isMain(f)) {
      return flatSprite.call(this, f);
    }

    _s.center.set(0, 0, 0);
    // A unit sprite's bounding radius is half its diagonal.
    _s.radius = Math.SQRT1_2 + _spriteCentre.distanceTo(this.center);
    _s.applyMatrix4(this.matrixWorld);
    return bentVisible();
  };
}
