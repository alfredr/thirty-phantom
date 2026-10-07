import { DirectionalLight, HemisphereLight, type Scene, Vector3 } from 'three';

/**
 * Shadow-box half-width in meters for the chase view and the maximum for the
 * isometric view.
 */
const SHADOW_HALF = 55;
/**
 * Quantization step in meters for fitted half-extents, reducing changes as the
 * view moves.
 */
const SHADOW_STEP = 4;
/**
 * Extra coverage in meters for shadow-filter samples beyond the visible
 * region.
 */
const SHADOW_PAD = 2;
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _c = new Vector3();
const _offset = new Vector3();

/** Sky fill plus the shadow-casting sun, whose shadow box follows the view. */
export class SunLight {
  readonly hemi = new HemisphereLight('#7a55c4', '#1c0e2a', 1.2);
  readonly sun = new DirectionalLight('#b9a6ff', 1.3);

  constructor(scene: Scene, highQuality: boolean) {
    const sun = this.sun;
    const size = highQuality ? 4096 : 2048;
    sun.castShadow = true;
    sun.shadow.mapSize.set(size, size);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -SHADOW_HALF;
    sc.right = sc.top = SHADOW_HALF;
    sc.near = 1;
    sc.far = 260;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.05;
    scene.add(this.hemi, sun, sun.target);
  }

  /**
   * Centre a fixed shadow box on the ground below `focus`, snapping
   * horizontally to texels to reduce shimmer.
   */
  follow(focus: Vector3, dir: Vector3): void {
    this.size(SHADOW_HALF, SHADOW_HALF);
    this.sun.shadow.camera.up.set(0, 1, 0);
    const texel = (SHADOW_HALF * 2) / this.sun.shadow.mapSize.x;
    const x = Math.round(focus.x / texel) * texel;
    const z = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(x, 0, z);
    this.sun.position.set(x, 0, z).addScaledVector(dir, 120);
  }

  /**
   * Fit shadow bounds to the supplied world points as seen along `dir`,
   * oriented by `up`. Pad and quantize the half-extents, capped at
   * SHADOW_HALF, then snap the centre to shadow texels to reduce shimmer.
   * Callers normally supply IsoCamera.shadowCorners and the camera's
   * horizontal screen-up direction.
   */
  cover(points: readonly Vector3[], dir: Vector3, up: Vector3): void {
    // Match the shadow camera basis constructed by Three.js lookAt.
    this.sun.shadow.camera.up.copy(up);
    _z.copy(dir).normalize();
    _x.copy(up).cross(_z);

    if (_x.lengthSq() < 1e-8) {
      _x.set(1, 0, 0);
    }

    _x.normalize();
    _y.crossVectors(_z, _x);
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    _c.set(0, 0, 0);

    for (const p of points) {
      _c.add(p);
    }

    _c.divideScalar(points.length || 1);

    for (const p of points) {
      _offset.subVectors(p, _c);
      const u = _offset.dot(_x);
      const v = _offset.dot(_y);
      x0 = Math.min(x0, u);
      x1 = Math.max(x1, u);
      y0 = Math.min(y0, v);
      y1 = Math.max(y1, v);
    }

    const step = (h: number): number =>
      Math.min(
        SHADOW_HALF,
        Math.ceil((h + SHADOW_PAD) / SHADOW_STEP) * SHADOW_STEP,
      );
    const hx = step((x1 - x0) / 2);
    const hy = step((y1 - y0) / 2);
    this.size(hx, hy);
    // Snap the centre in the shadow camera's coordinate system.
    const tx = (hx * 2) / this.sun.shadow.mapSize.x;
    const ty = (hy * 2) / this.sun.shadow.mapSize.y;
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    const ox = _c.dot(_x) + mx;
    const oy = _c.dot(_y) + my;
    _c.addScaledVector(_x, Math.round(ox / tx) * tx - ox + mx).addScaledVector(
      _y,
      Math.round(oy / ty) * ty - oy + my,
    );
    this.sun.target.position.copy(_c);
    this.sun.position.copy(_c).addScaledVector(dir, 120);
  }

  /** The shadow box's half width and height across the sun's view. */
  private size(hx: number, hy: number): void {
    const sc = this.sun.shadow.camera;
    if (sc.right === hx && sc.top === hy) {
      return;
    }

    sc.left = -hx;
    sc.right = hx;
    sc.bottom = -hy;
    sc.top = hy;
    sc.updateProjectionMatrix();
  }
}
