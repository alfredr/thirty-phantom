import {
  type AnimationAction,
  AnimationMixer,
  type AnimationClip,
  Group,
  type Object3D,
  Quaternion,
  Vector3,
} from 'three';

import { clamp, damp } from '@/engine/core/math';

import { buildCodyDay, buildCodyNight, CODY_DAY, CODY_NIGHT } from './cody';
import { stride } from './person';
import type { CharacterRig } from './rig';

export type CodyForm = 'day' | 'night';

/** Player-facing interface shared by imported and procedural character models. */
export interface CharacterModel {
  readonly root: Object3D;
  setForm(form: CodyForm): void;
  /** Select a riding pose with hips at the root, or restore the standing pose. */
  seat(on: boolean): void;
  /** @param speed horizontal speed in m/s */
  animate(dt: number, speed: number, grounded: boolean): void;
  offer(amount: number): void;
  readonly palm: Object3D;
}

const OFFER_RATE = 7;
const OFFER_DOWN = 0.35;
const OFFER_IN = 0.2;
const _shoulder = new Vector3();
const _elbow = new Vector3();
const _arm = new Vector3();
const _want = new Vector3();
const _turn = new Quaternion();
const _parent = new Quaternion();
const _bone = new Quaternion();
const _root = new Quaternion();

type Clip = 'idle' | 'walk' | 'run' | 'ride';
const CLIPS: readonly Clip[] = ['idle', 'walk', 'run', 'ride'];

/** Rigged GLB (public/assets/models/cody.glb): idle/walk/run/ride clips, day_* and night_* outfit meshes. */
export class GltfCharacter implements CharacterModel {
  readonly root = new Group();
  private readonly mixer: AnimationMixer;
  private readonly actions: Partial<Record<Clip, AnimationAction>> = {};
  private readonly outfits: Record<CodyForm, Object3D[]> = { day: [], night: [] };
  private readonly inner: Object3D;
  /** Standing hip height used to align the riding pose with the saddle. */
  private readonly hip: number;
  private form: CodyForm = 'day';
  private seated = false;
  private t = 0;
  readonly palm = new Group();
  private readonly upperArm: Object3D | null;
  private readonly forearm: Object3D | null;
  private offering = 0;
  private offered = 0;

  constructor(scene: Object3D, clips: AnimationClip[]) {
    this.inner = scene;
    this.root.add(scene);
    const bone = (name: string): Object3D | null =>
      scene.getObjectByName(name) ?? scene.getObjectByName(name.replace('.', '')) ?? null;
    this.upperArm = bone('upper_arm.R');
    this.forearm = bone('forearm.R');
    (bone('hand.R') ?? scene).add(this.palm);
    scene.traverse((o) => {
      if (o.name.startsWith('day_')) {
        this.outfits.day.push(o);
      }

      if (o.name.startsWith('night_')) {
        this.outfits.night.push(o);
      }
    });
    scene.updateWorldMatrix(true, true);
    this.hip = scene.getObjectByName('hips')?.getWorldPosition(new Vector3()).y ?? CODY_DAY.hip;
    this.mixer = new AnimationMixer(scene);

    for (const name of CLIPS) {
      const clip = clips.find((c) => c.name === name);
      if (!clip) {
        continue;
      }

      const a = this.mixer.clipAction(clip);
      a.play();
      a.setEffectiveWeight(name === 'idle' ? 1 : 0);
      this.actions[name] = a;
    }

    this.setForm('day');
  }

  setForm(form: CodyForm): void {
    this.form = form;

    for (const o of this.outfits.day) {
      o.visible = form === 'day';
    }

    for (const o of this.outfits.night) {
      o.visible = form === 'night';
    }
  }

  seat(on: boolean): void {
    this.seated = on;
  }

  offer(amount: number): void {
    this.offering = clamp(amount, 0, 1);
  }

  animate(dt: number, speed: number, grounded: boolean): void {
    this.pose(dt, speed, grounded);
    this.offered = damp(this.offered, this.offering, OFFER_RATE, dt);

    if (this.offered > 0.01) {
      this.reachOut(this.offered);
    }
  }

  private reachOut(k: number): void {
    const arm = this.upperArm;
    const elbow = this.forearm;
    const parent = arm?.parent;
    if (!arm || !elbow || !parent) {
      return;
    }

    this.root.updateWorldMatrix(true, true);
    arm.getWorldPosition(_shoulder);
    elbow.getWorldPosition(_elbow);
    _arm.subVectors(_elbow, _shoulder).normalize();
    this.root.getWorldQuaternion(_root);
    _want.set(-OFFER_IN, -OFFER_DOWN, 1).normalize().applyQuaternion(_root);
    _turn.setFromUnitVectors(_arm, _want);
    arm.getWorldQuaternion(_bone);
    parent.getWorldQuaternion(_parent);
    _bone.premultiply(_turn).premultiply(_parent.invert());
    arm.quaternion.slerp(_bone, k);
  }

  private pose(dt: number, speed: number, grounded: boolean): void {
    this.t += dt;
    const { idle, walk, run, ride } = this.actions;
    ride?.setEffectiveWeight(this.seated ? 1 : 0);

    if (this.seated) {
      idle?.setEffectiveWeight(0);
      walk?.setEffectiveWeight(0);
      run?.setEffectiveWeight(0);
      this.mixer.update(dt);
      this.inner.position.y = -this.hip;
      return;
    }

    // Match gait blend and playback rate to ground speed to reduce foot sliding.
    const w = grounded ? clamp((speed - 0.4) / 2.5, 0, 1) : 0.3;
    const r = grounded ? clamp((speed - 7) / 3, 0, 1) : 0;
    idle?.setEffectiveWeight(1 - w);
    walk?.setEffectiveWeight(w * (1 - r));
    run?.setEffectiveWeight(w * r);
    walk?.setEffectiveTimeScale(Math.max(0.6, speed / 3.4));
    run?.setEffectiveTimeScale(Math.max(0.8, speed / 9.5));
    this.mixer.update(dt);
    this.inner.position.y = this.form === 'night' ? 0.14 + Math.sin(this.t * 2.4) * 0.07 : 0;
  }
}

/** Riding limb angles in radians for the procedural rig, which has no knee joints. */
const SIT_LEGS = -1.45;
const SIT_ARMS = -1.2;
const PALM_DOWN = 0.62;
const OFFER_LIFT = 1.25;

/** Box-built fallback when no GLB is configured. */
export class ProceduralCharacter implements CharacterModel {
  readonly root = new Group();
  private readonly rigs: Record<CodyForm, CharacterRig>;
  private readonly palms: Record<CodyForm, Group> = { day: new Group(), night: new Group() };
  private offering = 0;
  private offered = 0;
  private form: CodyForm = 'day';
  private seated = false;
  private walk = 0;
  private t = 0;

  constructor() {
    this.rigs = { day: buildCodyDay(), night: buildCodyNight() };
    this.root.add(this.rigs.day.root, this.rigs.night.root);

    for (const form of ['day', 'night'] as const) {
      this.rigs[form].armR.add(this.palms[form]);
      this.palms[form].position.set(0, -PALM_DOWN, 0);
    }

    this.setForm('day');
  }

  get palm(): Object3D {
    return this.palms[this.form];
  }

  offer(amount: number): void {
    this.offering = clamp(amount, 0, 1);
  }

  setForm(form: CodyForm): void {
    this.form = form;
    this.rigs.day.root.visible = form === 'day';
    this.rigs.night.root.visible = form === 'night';
  }

  seat(on: boolean): void {
    this.seated = on;
    this.rigs.day.root.position.y = on ? -CODY_DAY.hip : 0;
    this.rigs.night.root.position.y = on ? -CODY_NIGHT.hip : 0;
  }

  animate(dt: number, hs: number): void {
    this.t += dt;

    if (this.seated) {
      const r = this.rigs[this.form];
      r.legL.rotation.x = r.legR.rotation.x = SIT_LEGS;
      r.armL.rotation.x = r.armR.rotation.x = SIT_ARMS;
      r.body.position.y = 0;
      return;
    }

    this.walk += hs * dt * 1.6;
    const r = this.rigs[this.form];
    const amp = Math.min(1, hs / 6);
    const bob = stride(r, this.walk * 2.2, amp);
    this.offered = damp(this.offered, this.offering, OFFER_RATE, dt);
    r.armR.rotation.x += (-OFFER_LIFT - r.armR.rotation.x) * this.offered;

    if (this.form === 'night') {
      r.body.position.y = 0.12 + Math.sin(this.t * 2.4) * 0.06 + bob;

      if (r.robe) {
        r.robe.rotation.x = -amp * 0.18 + Math.sin(this.t * 3) * 0.03;
      }
    } else {
      r.body.position.y = bob;
    }
  }
}
