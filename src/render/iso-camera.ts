import { OrthographicCamera, Vector3 } from 'three';

import { TUNING } from '@/config';
import { clamp, damp, dampAngle } from '@/engine/core/math';

import { Shake } from './shake';

/** 35.264 deg: true isometric. */
export const ISO_ELEVATION = Math.atan(1 / Math.SQRT2);
/** Each mouse-wheel step zooms by this factor (both camera rigs). */
export const ZOOM_STEP = 1.12;
/**
 * The sun's shadow box covers what the view shows from the ground (or the focus, if lower) up to this far above the
 * focus. Higher roofs near the bottom of the screen go without shadows; taking in the tallest towers' would stretch the
 * box far down the screen for the few that stand there.
 */
const SHADOW_RISE = 20;
const _corner = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _fwd = new Vector3();

/** Share of the configured view a w x h (CSS px) screen shows, for both rigs: 1 on desktops, about 0.6 on a phone. */
export function viewFit(w: number, h: number): number {
  const { shortSide, power } = TUNING.camera.fit;
  return Math.min(1, Math.pow(Math.min(w, h) / shortSide, power));
}

/** Orthographic isometric rig: smooth follow, 90-degree rotation steps, zoom, shake. */
export class IsoCamera {
  readonly camera: OrthographicCamera;
  readonly target = new Vector3();
  /** Unit vector from target toward the camera. */
  readonly viewDir = new Vector3();
  azimuth = Math.PI / 4;
  azimuthTarget = Math.PI / 4;
  /** World units across the screen's short side, before small screens zoom in (see viewHeight). */
  zoom: number = TUNING.camera.zoom;
  zoomTarget: number = TUNING.camera.zoom;
  private aspect = 1;
  private fit = 1;
  private readonly shaker = new Shake(0.9);
  private readonly shake = new Vector3();

  constructor() {
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 1, 700);
    this.computeView();
  }

  /** Viewport size in CSS px. */
  setViewport(w: number, h: number): void {
    this.aspect = w / h;
    this.fit = viewFit(w, h);
  }

  /** World units the view spans vertically. */
  get viewHeight(): number {
    return (this.zoom * this.fit) / Math.min(1, this.aspect);
  }

  rotate(steps: number): void {
    this.azimuthTarget += (steps * Math.PI) / 2;
  }

  zoomBy(steps: number): void {
    this.zoomTarget = clamp(this.zoomTarget * Math.pow(ZOOM_STEP, steps), TUNING.camera.minZoom, TUNING.camera.maxZoom);
  }

  addTrauma(t: number): void {
    this.shaker.add(t);
  }

  snapTo(p: Vector3): void {
    this.target.copy(p);
  }

  /** Horizontal unit vector pointing "up" the screen. */
  screenUp(out: Vector3): Vector3 {
    return out.set(-this.viewDir.x, 0, -this.viewDir.z).normalize();
  }

  /** Horizontal unit vector pointing right on screen. */
  screenRight(out: Vector3): Vector3 {
    const f = this.screenUp(out);
    return out.set(-f.z, 0, f.x);
  }

  /** Center for the sun's shadow box. */
  shadowFocus(out: Vector3): Vector3 {
    return out.copy(this.target);
  }

  /**
   * How far up the screen (world units from its centre, as the flat world would be drawn) the view reaches: its top, or
   * more where world curvature brings farther ground into view.
   */
  shadowTop = 0;

  /**
   * What the sun's shadow box must cover: where the view's corner rays cross the lowest and highest heights it shows
   * shadows at (SHADOW_RISE). Into `out` (8 points).
   */
  shadowCorners(out: Vector3[]): Vector3[] {
    const cam = this.camera;
    cam.updateMatrixWorld();
    _right.setFromMatrixColumn(cam.matrixWorld, 0);
    _up.setFromMatrixColumn(cam.matrixWorld, 1);
    _fwd.setFromMatrixColumn(cam.matrixWorld, 2).negate();
    const lo = Math.min(this.target.y, 0) - 1;
    const hi = this.target.y + SHADOW_RISE;
    const top = Math.max(cam.top, this.shadowTop);
    let i = 0;
    for (const x of [cam.left, cam.right]) {
      for (const y of [cam.bottom, top]) {
        _corner.copy(cam.position).addScaledVector(_right, x).addScaledVector(_up, y);

        for (const h of [lo, hi]) {
          const p = (out[i++] ??= new Vector3());
          p.copy(_corner).addScaledVector(_fwd, (h - _corner.y) / _fwd.y);
        }
      }
    }

    out.length = 8;
    return out;
  }

  private computeView(): void {
    const c = Math.cos(ISO_ELEVATION);
    this.viewDir.set(Math.sin(this.azimuth) * c, Math.sin(ISO_ELEVATION), Math.cos(this.azimuth) * c);
  }

  update(dt: number, focus: Vector3, lead: Vector3 | null, followRate = 6): void {
    const fx = focus.x + (lead?.x ?? 0);
    const fy = focus.y + (lead?.y ?? 0);
    const fz = focus.z + (lead?.z ?? 0);
    this.target.set(
      damp(this.target.x, fx, followRate, dt),
      damp(this.target.y, fy, followRate * 0.6, dt),
      damp(this.target.z, fz, followRate, dt),
    );
    this.azimuth = dampAngle(this.azimuth, this.azimuthTarget, 9, dt);
    this.zoom = damp(this.zoom, this.zoomTarget, 7, dt);
    this.computeView();

    this.shaker.update(dt, this.shake);

    const d = TUNING.camera.distance;
    const cam = this.camera;
    cam.position.copy(this.target).addScaledVector(this.viewDir, d).add(this.shake);
    cam.lookAt(this.target.x + this.shake.x, this.target.y + this.shake.y, this.target.z + this.shake.z);
    const h = this.viewHeight / 2;
    cam.left = -h * this.aspect;
    cam.right = h * this.aspect;
    cam.top = h;
    cam.bottom = -h;
    cam.updateProjectionMatrix();
  }
}
