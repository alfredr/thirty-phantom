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
import { TUNING } from '../config';
import { urlChoice } from '../core/url-flags';

/**
 * World curvature, an experiment (TUNING.camera.curve): in the top-down view every material's
 * vertex shader bends the world onto a small planet, so the ground curves away into a real
 * horizon. Cody's own level lies on a sphere resting under the view's focus, a point's distance
 * from the focus going round it as arc length; heights above or below that level stand up from
 * it, straight up or (with `lean`) out along the sphere's radius. Round Cody it's drawn as it is.
 *
 * It's visual only: collision, physics and the game see the flat world. Lighting, shadows and
 * textures use flat positions too, so they stay put on the bent surfaces. Off (or in the chase
 * view, radius 0) everything is as before; with the switch off nothing is patched or tiled.
 */

/** Whether the world can curve (TUNING.camera.curve.on, or ?curve=0 / ?curve=1). */
export const CURVE_ON = ((): boolean => {
  const flag = urlChoice('curve', ['0', '1']);
  return flag ? flag === '1' : TUNING.camera.curve.on;
})();

/** Grid (m) big faces are split on while curvature is on (render/geometry.ts), else 0. */
export const CURVE_TILE: number = CURVE_ON ? TUNING.camera.curve.tile : 0;

/**
 * How far round the planet (radians) things go before they sink into it: past the farthest the
 * view sees on its near side (90 degrees plus the view's 55 from straight down), so it's all behind
 * that. Without it the far city would wrap round the back and come up again under Cody.
 */
const PHI_MAX = 2.6;
/** Over this much of a turn before PHI_MAX things sink toward the middle. */
const SINK = 0.25;

export const curveUniforms = {
  /** xyz: the bend's centre (the iso view's focus); w: the planet's radius, 0 for flat. */
  uCurve: { value: new Vector4() },
  /** How far heights stand out along the sphere's radius rather than straight up, 0..1. */
  uCurveLean: { value: 0 },
};

/**
 * The iso frame's planet, as uCurve packs it (w 0 when there's none), and its lean. The shaders
 * only get it while curveCull arms the iso render, so anything else drawn with the same materials
 * (portraits, the phone's avatar) stays flat; HUD markers and culling read it from here.
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
  // Cody's level on the sphere, and the height up from it
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
 * Patches a vertex shader to draw bent: after project_vertex, gl_Position is redone from the
 * bent world position (mvPosition stays flat, for lighting). `bent` names a vec3 to declare with
 * the bent position, for the cutaway. Sprites bend their centre. Returns false if there was nothing to patch.
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
    next = vs.replace('vec4 mvPosition = modelViewMatrix[ 3 ];', 'vec4 mvPosition = viewMatrix * vec4( curveBend( modelMatrix[ 3 ].xyz ), 1.0 );');
  } else return false;
  shader.vertexShader = HEAD + next;
  Object.assign(shader.uniforms, curveUniforms);
  return true;
}

const curved = new WeakSet<Material>();

/**
 * Bends a material that the cutaway patch doesn't cover (sprites, depth twins, lines). A no-op
 * with curvature off. Idempotent, like withCutaway (clones don't carry it).
 */
export function withCurve<T extends Material>(mat: T): T {
  if (!CURVE_ON || curved.has(mat)) return mat;
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

/** Marks a material the cutaway patch bent (it calls curveVertex itself), so the sweep leaves it be. */
export function markCurved(mat: Material): void {
  curved.add(mat);
}

/**
 * Bends whatever under `root` still draws flat: materials made after a clone, or anywhere that
 * didn't ask. Run now and then; a material caught after it's compiled is rebuilt once.
 */
export function curveSweep(root: Object3D): void {
  if (!CURVE_ON) return;
  root.traverse((o) => {
    const m = (o as Mesh).material as Material | Material[] | undefined;
    if (!m) return;
    for (const mat of Array.isArray(m) ? m : [m]) {
      if (curved.has(mat)) continue;
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
  if (R <= 0) return p;
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
 * How far up the screen (world units from its centre, as flat) a curved view `halfH` high reaches
 * at its top edge: the ground there is farther off than flat, up to the horizon. For fitting the
 * sun's shadow box. `elevation` is the view's (radians).
 */
export function curveTop(halfH: number, elevation: number): number {
  const R = curveFrame.planet.w;
  if (R <= 0) return halfH;
  // a ground point phi round the planet shows R (cos(phi - elevation) - cos(elevation)) up the screen
  const phi = elevation - Math.acos(Math.min(1, Math.cos(elevation) + halfH / R));
  return R * phi * Math.sin(elevation);
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------- culling

/**
 * Three culls by each object's flat bounding sphere, but bent, towers past the horizon stand up
 * into view and the rest of the far city tucks in behind the planet. While `cull.camera` is set,
 * objects are tested against its frustum where they're drawn: the sphere's centre bent, its
 * radius grown by the most the bend stretches it, and hidden if it's wholly behind the planet.
 */
const cull = {
  camera: null as OrthographicCamera | null,
  frustum: new Frustum(),
  /** Unit vector toward the camera. */
  toCam: new Vector3(),
};
const _m = new Matrix4();
const _s = new Sphere();
const _c = new Vector3();
const _spriteCentre = new Vector2(0.5, 0.5);

/**
 * Arms the frame's planet (curveFrame) for `camera`'s render: the shaders bend, and objects are
 * culled where they're drawn. null disarms it, flat again for anything else drawn.
 */
export function curveCull(camera: OrthographicCamera | null): void {
  const u = curveUniforms;
  cull.camera = camera && curveFrame.planet.w > 0 ? camera : null;
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

/** The renderer's frustum is its own object, so it's told apart from the shadow map's (and a pass's quad) by its planes. */
function isMain(f: Frustum): boolean {
  const a = f.planes;
  const b = cull.frustum.planes;
  for (let i = 0; i < 6; i++) {
    const p = a[i]!;
    const q = b[i]!;
    if (p.constant !== q.constant || p.normal.x !== q.normal.x || p.normal.y !== q.normal.y || p.normal.z !== q.normal.z) return false;
  }
  return true;
}

/** Whether the flat sphere `_s` (world space) shows once bent. */
function bentVisible(): boolean {
  const c = curveFrame.planet;
  const R = c.w;
  // the ground maps without stretching; leaning out, heights fan out by up to lean * height / R
  const tall = Math.max(Math.abs(_s.center.y + _s.radius - c.y), Math.abs(_s.center.y - _s.radius - c.y));
  const stretch = 1 + (curveFrame.lean * tall) / R;
  curvePoint(_s.center);
  _s.radius *= stretch;
  if (!cull.frustum.intersectsSphere(_s)) return false;
  // behind the street's sphere (Cody's, dropped to the street), seen along the view: hidden by the ground on its near side
  _c.set(_s.center.x - c.x, _s.center.y + R, _s.center.z - c.z);
  const along = _c.dot(cull.toCam);
  const perp = Math.sqrt(Math.max(_c.lengthSq() - along * along, 0)) + _s.radius;
  return perp >= R || along + _s.radius >= Math.sqrt(R * R - perp * perp);
}

function objectSphere(o: Mesh | Line | Points): void {
  const own = (o as { boundingSphere?: Sphere | null }).boundingSphere;
  if (own !== undefined) {
    if (own === null) (o as unknown as { computeBoundingSphere(): void }).computeBoundingSphere();
    _s.copy((o as unknown as { boundingSphere: Sphere }).boundingSphere);
  } else {
    if (o.geometry.boundingSphere === null) o.geometry.computeBoundingSphere();
    _s.copy(o.geometry.boundingSphere!);
  }
  _s.applyMatrix4(o.matrixWorld);
}

if (CURVE_ON) {
  for (const cls of [Mesh, Line, Points]) {
    const flat = cls.prototype.intersectsFrustum;
    cls.prototype.intersectsFrustum = function (this: Mesh | Line | Points, f: Frustum): boolean {
      if (!cull.camera || !isMain(f)) return flat.call(this, f);
      objectSphere(this);
      return bentVisible();
    };
  }
  const flatSprite = Sprite.prototype.intersectsFrustum;
  Sprite.prototype.intersectsFrustum = function (this: Sprite, f: Frustum): boolean {
    if (!cull.camera || !isMain(f)) return flatSprite.call(this, f);
    _s.center.set(0, 0, 0);
    _s.radius = 0.7071067811865476 + _spriteCentre.distanceTo(this.center);
    _s.applyMatrix4(this.matrixWorld);
    return bentVisible();
  };
}
