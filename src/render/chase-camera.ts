import { PerspectiveCamera, Vector3 } from 'three';
import { TUNING } from '@/config';
import { clamp, damp, dampAngle, type V3 } from '@/engine/core/math';
import type { CollisionWorld } from '@/engine/physics/collision';
import { viewFit, ZOOM_STEP } from './iso-camera';
import { Shake } from './shake';

export type ChaseKind = 'foot' | 'car' | 'truck';

/** What the chase camera follows this frame. */
export interface ChaseSubject {
  kind: ChaseKind;
  pos: Vector3;
  vel: Vector3;
  /** Vehicle heading: the boom swings in behind it. Null on foot, where the camera follows the walk instead. */
  yaw: number | null;
}

/**
 * Third-person perspective rig. The boom hangs off a pivot at the subject's head and is
 * shortened against the collision world (walls, deck slabs, ramps), so the camera follows
 * Cody into the parking deck instead of cutting the building away like the iso view does.
 */
export class ChaseCamera {
  readonly camera: PerspectiveCamera;
  /** Boom pivot at the subject's head; other systems use it as the view's focus. */
  readonly target = new Vector3();
  /** Unit vector from the pivot toward the camera. */
  readonly viewDir = new Vector3(0, 0.3, -1).normalize();
  /** Heading the camera looks along (actor yaw convention: forward = (sin, cos)). */
  yaw = 0;
  /** Q/E and mouse look-around while driving; springs back behind the vehicle when released. */
  private offset = 0;
  /** Mouse tilt added to the rig's boom pitch. */
  private pitchOffset = 0;
  /** Mouse movement waiting for the next update, in pixels. */
  private mouseX = 0;
  private mouseY = 0;
  /** Seconds since the mouse last moved the view. */
  private idle = Infinity;
  private boom = 0;
  private zoomScale = 1;
  private fovBoost = 0;
  private aspect = 1;
  private fit = 1;
  private readonly shaker = new Shake(0.3);
  private snap = true;
  private readonly aim = new Vector3();
  private readonly jitter = new Vector3();
  private readonly pivot: V3 = [0, 0, 0];
  private readonly want: V3 = [0, 0, 0];

  constructor() {
    // nothing past the fog's far end is visible, so don't draw it: the sky pass paints the skyline there
    const { fov, fogFar } = TUNING.camera.chase;
    this.camera = new PerspectiveCamera(fov, 1, 0.15, fogFar + 15);
  }

  /** Viewport size in CSS px. */
  setViewport(w: number, h: number): void {
    this.aspect = w / h;
    this.fit = viewFit(w, h);
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
  }

  zoomBy(steps: number): void {
    this.zoomScale = clamp(this.zoomScale * Math.pow(ZOOM_STEP, steps), 0.5, 2.2);
  }

  addTrauma(t: number): void {
    this.shaker.add(t);
  }

  /** Put the camera straight behind `yaw` on the next update, skipping the easing (mode switch, teleport). */
  snapBehind(yaw: number): void {
    this.yaw = yaw;
    this.offset = 0;
    this.pitchOffset = 0;
    this.idle = Infinity;
    this.snap = true;
  }

  /** Mouse look, in pixels: right turns the view right, down tilts it down. */
  look(dx: number, dy: number): void {
    this.mouseX += dx;
    this.mouseY += dy;
  }

  /** Horizontal unit vector the camera looks along (screen "up" for walking). */
  screenUp(out: Vector3): Vector3 {
    const y = this.yaw + this.offset;
    return out.set(Math.sin(y), 0, Math.cos(y));
  }

  screenRight(out: Vector3): Vector3 {
    const f = this.screenUp(out);
    return out.set(-f.z, 0, f.x);
  }

  /** Center for the sun's shadow box: ahead of the camera, where most of the view is. */
  shadowFocus(out: Vector3): Vector3 {
    return this.screenUp(out).multiplyScalar(30).add(this.target);
  }

  /** `orbit` is the Q/E axis: -1 looks left, 1 looks right. Mouse movement comes in through look(). */
  update(dt: number, s: ChaseSubject, orbit: number, world: CollisionWorld): void {
    const C = TUNING.camera.chase;
    const R = C[s.kind];
    const snap = this.snap;
    this.snap = false;

    // the pivot is exact in x/z so the boom always starts in the open; eased vertically over steps and hops
    const py = s.pos.y + R.pivot;
    this.target.set(s.pos.x, snap ? py : damp(this.target.y, py, 10, dt), s.pos.z);

    const mx = this.mouseX * C.mouseSens;
    const my = this.mouseY * C.mouseSens;
    this.mouseX = 0;
    this.mouseY = 0;
    this.idle = mx || my ? 0 : this.idle + dt;
    this.pitchOffset = clamp(this.pitchOffset + my, C.pitchMin - R.pitch, C.pitchMax - R.pitch);
    const settled = !orbit && this.idle > C.recenterDelay;

    const hs = Math.hypot(s.vel.x, s.vel.z);
    if (s.yaw !== null) {
      this.yaw = snap ? s.yaw : dampAngle(this.yaw, s.yaw, 3.2, dt);
      this.offset = clamp(this.offset - orbit * C.orbitRate * dt - mx, -Math.PI, Math.PI);
      // let go of Q/E and the mouse for a moment and the view swings back behind the vehicle
      if (settled) {
        this.offset = damp(this.offset, 0, 2.5, dt);
        this.pitchOffset = damp(this.pitchOffset, 0, 2.5, dt);
      }
    } else {
      // on foot the view stays wherever it was left, including a look-around carried out of a vehicle
      this.yaw += this.offset - orbit * C.orbitRate * dt - mx;
      this.offset = 0;
      if (hs > 0.5 && this.idle > C.recenterDelay) {
        // swing in behind Cody only while he walks away from the camera; strafing and backing up leave it be
        const along = (s.vel.x * Math.sin(this.yaw) + s.vel.z * Math.cos(this.yaw)) / hs;
        const rate = 2.4 * Math.max(0, along) * Math.min(1, hs / TUNING.player.walk);
        this.yaw = dampAngle(this.yaw, Math.atan2(s.vel.x, s.vel.z), rate, dt);
      }
    }

    const yaw = this.yaw + this.offset;
    const pitch = R.pitch + this.pitchOffset;
    const len = R.dist * this.zoomScale;
    const flat = Math.cos(pitch) * len;
    const p = this.pivot;
    p[0] = this.target.x;
    p[1] = this.target.y;
    p[2] = this.target.z;
    const w = this.want;
    w[0] = p[0] - Math.sin(yaw) * flat;
    w[1] = p[1] + Math.sin(pitch) * len;
    w[2] = p[2] - Math.cos(yaw) * flat;
    // under a deck slab, flatten the boom rather than shorten it
    const ceil = Math.min(world.ceilingAt(p[0], p[2], 0.3, p[1]), world.ceilingAt(w[0], w[2], 0.3, p[1]));
    if (w[1] > ceil - C.pad) w[1] = Math.max(p[1], ceil - C.pad);

    // walls pull the camera in at once; it eases back out when the way clears
    const dx = w[0] - p[0];
    const dy = w[1] - p[1];
    const dz = w[2] - p[2];
    const full = Math.hypot(dx, dy, dz);
    const free = world.raycast(p, w, C.pad) * full;
    this.boom = snap || free < this.boom ? free : damp(this.boom, free, 3, dt);
    const k = full > 1e-6 ? this.boom / full : 0;
    const cam = this.camera;
    cam.position.set(p[0] + dx * k, p[1] + dy * k, p[2] + dz * k);
    const floor = world.groundAt(cam.position.x, cam.position.z, cam.position.y, 0) + 0.3;
    if (cam.position.y < floor) cam.position.y = floor;

    cam.position.add(this.shaker.update(dt, this.jitter));

    // look a little past the pivot so the subject sits low in frame with the road ahead visible
    const ahead = s.yaw !== null ? 3 : 1;
    this.aim.set(p[0] + Math.sin(yaw) * ahead, p[1] + 0.4, p[2] + Math.cos(yaw) * ahead);
    cam.lookAt(this.aim);

    const speedK = s.yaw !== null ? clamp(hs / TUNING.truck.maxSpeed, 0, 1) : 0;
    this.fovBoost = damp(this.fovBoost, speedK * C.fovBoost, 3, dt);
    cam.fov = this.verticalFov();
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this.viewDir.subVectors(cam.position, this.target).normalize();
  }

  /**
   * `fov` spans the screen's short side, narrowed on small screens like the iso zoom; past
   * `maxHFov` across, the vertical view is trimmed instead. The speed boost scales on top.
   */
  private verticalFov(): number {
    const C = TUNING.camera.chase;
    const tanHalf = (deg: number) => Math.tan((deg * Math.PI) / 360);
    let t = (tanHalf(C.fov) * this.fit) / Math.min(1, this.aspect);
    t = Math.min(t, tanHalf(C.maxHFov) / this.aspect);
    t *= tanHalf(C.fov + this.fovBoost) / tanHalf(C.fov);
    return (Math.atan(t) * 360) / Math.PI;
  }
}
