import { FrontSide, Group, type Material, Mesh, MeshBasicMaterial, type Object3D, type Side, SkinnedMesh, Vector3 } from 'three';
import { TUNING } from '../config';
import { clamp, damp, dampAngle, invLerp, type V3 } from '../engine/core/math';
import type { Input } from '../engine/input/input';
import type { CollisionWorld } from '../engine/physics/collision';
import type { Control } from '../game/controls';
import { withCurve } from '../render/curvature';
import { GHOST_LAYER } from '../render/layers';
import type { CharacterModel, CodyForm } from './models/character';

export type { CodyForm };

/** The active camera's ground-plane axes; walking is screen-relative. */
export interface MoveFrame {
  screenUp(out: Vector3): Vector3;
  screenRight(out: Vector3): Vector3;
}

/**
 * A close camera fades Cody out: fully there with it past `far` (m from his body), down to `min`
 * opacity at `near`.
 */
const FADE = { near: 0.4, far: 1.6, min: 0.15 };

/**
 * Faded, Cody is drawn by the ghost pass (GHOST_LAYER) over the finished image. His depth twins
 * lay down his nearest surface first (no color, pushed back a hair so that surface still passes),
 * so only it shows; his shadow twins stay in the main scene to keep casting his shadow.
 */
const DEPTH_TWIN = withCurve(new MeshBasicMaterial({ colorWrite: false, side: FrontSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
const SHADOW_TWIN = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
SHADOW_TWIN.userData.noInk = true;

/** Cody on foot. Screen-relative movement, ledge stepping, a small hop, two outfits. */
export class Player {
  readonly root = new Group();
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  yaw = 0;
  grounded = true;
  form: CodyForm = 'day';
  private readonly up = new Vector3();
  private readonly right = new Vector3();
  /** Every material he's drawn with, as it was before any fade. `hull` is the inverted-hull ink shell. */
  private readonly looks: { mat: Material; opacity: number; transparent: boolean; depthWrite: boolean; side: Side; hull: boolean }[] = [];
  /** His meshes and their layers; while faded they move to the ghost layer. */
  private readonly meshes: { mesh: Mesh; layers: number }[] = [];
  /** Depth-only and shadow-only copies of each mesh, shown while he's faded. */
  private readonly twins: Mesh[] = [];
  private fade = 1;
  private shownFade = 1;

  constructor(private readonly model: CharacterModel) {
    this.root.add(model.root);
    this.setForm('day');
    const meshes: Mesh[] = [];
    model.root.traverse((o) => {
      if ((o as Mesh).isMesh) meshes.push(o as Mesh);
    });
    for (const mesh of meshes) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      let hull = false;
      for (const mat of mats) {
        hull ||= mat.name === 'ink';
        if (this.looks.some((l) => l.mat === mat)) continue;
        this.looks.push({ mat, opacity: mat.opacity, transparent: mat.transparent, depthWrite: mat.depthWrite, side: mat.side, hull: mat.name === 'ink' });
      }
      this.meshes.push({ mesh, layers: mesh.layers.mask });
      if (hull) continue;
      for (const shadow of [false, true]) {
        // a child with no transform of its own, so it moves (and skins) exactly like the mesh
        const mat = shadow ? SHADOW_TWIN : DEPTH_TWIN;
        let twin: Mesh;
        if ((mesh as SkinnedMesh).isSkinnedMesh) {
          const sk = mesh as SkinnedMesh;
          const t = new SkinnedMesh(sk.geometry, mat);
          t.bind(sk.skeleton, sk.bindMatrix);
          twin = t;
        } else twin = new Mesh(mesh.geometry, mat);
        if (!shadow) twin.layers.set(GHOST_LAYER);
        twin.castShadow = shadow && mesh.castShadow;
        twin.receiveShadow = false;
        twin.frustumCulled = mesh.frustumCulled;
        twin.visible = false;
        mesh.add(twin);
        this.twins.push(twin);
      }
    }
  }

  /** See-through right now: the renderer's ghost pass needs to run. */
  get faded(): boolean {
    return this.shownFade < 1;
  }

  /**
   * See-through while a camera at `eye` is right on top of him (the chase boom pulled in by a
   * wall), so he doesn't fill the view; null fades him back in. Faded, only his nearest surface
   * shows (the back of the hoodie, not his face through it), with no ink outline, drawn over
   * the sky by the ghost pass (so the renderer has to run it while `faded`).
   */
  seenFrom(eye: Vector3 | null, dt: number): void {
    let want = 1;
    if (eye) {
      const P = TUNING.player;
      const y = clamp(eye.y, this.pos.y, this.pos.y + P.height);
      const d = Math.hypot(eye.x - this.pos.x, eye.y - y, eye.z - this.pos.z) - P.radius;
      want = FADE.min + (1 - FADE.min) * invLerp(FADE.near, FADE.far, d);
    }
    const f = damp(this.fade, want, 12, dt);
    this.fade = Math.abs(f - want) < 0.005 ? want : f;
    if (this.fade === this.shownFade) return;
    this.shownFade = this.fade;
    const see = this.fade < 1;
    for (const t of this.twins) t.visible = see;
    for (const { mesh, layers } of this.meshes) {
      if (see) mesh.layers.set(GHOST_LAYER);
      else mesh.layers.mask = layers;
    }
    for (const l of this.looks) {
      const m = l.mat;
      if (l.hull) {
        m.visible = !see;
        continue;
      }
      m.opacity = l.opacity * this.fade;
      // the depth twins have already laid down his front surface
      m.depthWrite = l.depthWrite && !see;
      // blending and culling change the shader (OPAQUE, DOUBLE_SIDED), so only then does it need a rebuild
      const transparent = l.transparent || see;
      const side = see ? FrontSide : l.side;
      if (m.transparent !== transparent || m.side !== side) {
        m.transparent = transparent;
        m.side = side;
        m.needsUpdate = true;
      }
    }
  }

  /** Hidden while Cody is in a vehicle. Applies immediately: update() doesn't run while driving. */
  get visible(): boolean {
    return this.root.visible;
  }

  set visible(v: boolean) {
    this.root.visible = v;
  }

  setForm(f: CodyForm): void {
    this.form = f;
    this.model.setForm(f);
  }

  /** Riding: sit astride `saddle` (a bike's, so he leans and tumbles with it), shown. */
  mount(saddle: Object3D): void {
    saddle.add(this.root);
    this.root.position.set(0, 0, 0);
    this.root.rotation.set(0, 0, 0);
    this.model.seat(true);
    this.model.animate(0, 0, true);
    this.visible = true;
  }

  /** Off the bike, back into `world` (place() him next). */
  dismount(world: Object3D): void {
    if (this.root.parent === world) return;
    world.add(this.root);
    this.model.seat(false);
  }

  /** While mounted: keep the riding pose moving. */
  ride(dt: number): void {
    this.model.animate(dt, 0, true);
  }

  update(dt: number, input: Input<Control> | null, frame: MoveFrame, world: CollisionWorld, blockers: { pos: Vector3; r: number }[]): void {
    const P = TUNING.player;
    let mx = 0;
    let mz = 0;
    let run = false;
    let hop = false;
    if (input) {
      const ax = input.axis('left', 'right');
      const ay = input.axis('back', 'forward');
      frame.screenUp(this.up);
      frame.screenRight(this.right);
      mx = this.up.x * ay + this.right.x * ax;
      mz = this.up.z * ay + this.right.z * ax;
      const len = Math.hypot(mx, mz);
      if (len > 1) {
        mx /= len;
        mz /= len;
      }
      run = input.isDown('run');
      hop = input.wasPressed('hop');
    }
    const speed = run ? P.run : P.walk;
    const accel = this.grounded ? 14 : 3;
    this.vel.x = damp(this.vel.x, mx * speed, accel, dt);
    this.vel.z = damp(this.vel.z, mz * speed, accel, dt);
    const oldY = this.pos.y;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    const p: V3 = [this.pos.x, this.pos.y, this.pos.z];
    world.resolveCircle(p, P.radius, P.height, P.stepUp);
    for (const b of blockers) {
      const dx = p[0] - b.pos.x;
      const dz = p[2] - b.pos.z;
      const d = Math.hypot(dx, dz);
      const min = b.r + P.radius;
      if (d < min && d > 1e-4 && Math.abs(b.pos.y - p[1]) < 2.5) {
        p[0] += (dx / d) * (min - d);
        p[2] += (dz / d) * (min - d);
      }
    }
    this.pos.x = p[0];
    this.pos.z = p[2];

    const g = world.groundAt(this.pos.x, this.pos.z, oldY, P.stepUp);
    if (this.grounded && g < oldY - 0.4) this.grounded = false;
    if (this.grounded) {
      this.pos.y = damp(this.pos.y, g, 30, dt);
      if (Math.abs(this.pos.y - g) < 0.02) this.pos.y = g;
      this.vel.y = 0;
      if (hop) {
        this.vel.y = P.hop;
        this.grounded = false;
      }
    }
    if (!this.grounded) {
      this.vel.y -= TUNING.gravity * dt;
      this.pos.y += this.vel.y * dt;
      if (this.pos.y <= g) {
        this.pos.y = g;
        this.vel.y = 0;
        this.grounded = true;
      }
    }

    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (hs > 0.3) this.yaw = dampAngle(this.yaw, Math.atan2(this.vel.x, this.vel.z), 14, dt);
    this.sync(dt, hs);
  }

  place(p: Vector3, yaw: number): void {
    this.pos.copy(p);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.grounded = true;
    this.sync(0, 0);
  }

  private sync(dt: number, hs: number): void {
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw;
    this.model.animate(dt, hs, this.grounded);
  }
}
