import { Color, type Scene, Vector3 } from 'three';
import type { VehicleRig } from '../../actors/models/rig';
import type { Vehicle, VehicleForm } from '../../actors/vehicle';
import { easeOutElastic } from '../../core/math';
import { PURPLE, SLIME, WHITE } from '../../fx/colors';
import type { CubeParticles } from '../../fx/cube-particles';
import type { SpriteFx } from '../../fx/sprite-fx';

export interface FxKit {
  scene: Scene;
  slime: CubeParticles;
  sprites: SpriteFx;
  /** Camera shake on whichever view is active. */
  shake: (trauma: number) => void;
  flash: (amount: number, color?: string) => void;
}

/** Seconds the old body shudders before it pops, then seconds the new one takes to spring out. */
const SHUDDER = 0.55;
const SPRING = 0.85;
const SLIME_PUFF = new Color(0.4, 1.6, 0.2);
const _v = new Vector3();
const _at = new Vector3();

/**
 * Car -> monster truck (and back at sunrise): the old body shudders and lifts,
 * pops in a slime burst, and the new one springs out of it.
 */
export class TransformSequence {
  private t = 0;
  private swapped = false;
  private readonly oldRig: VehicleRig;
  private newRig: VehicleRig | null = null;
  done = false;

  constructor(
    readonly vehicle: Vehicle,
    private readonly to: VehicleForm,
    private readonly build: () => VehicleRig,
    private readonly fx: FxKit,
  ) {
    this.oldRig = vehicle.rig;
    vehicle.role = 'transforming';
    vehicle.vel.set(0, 0, 0);
  }

  update(dt: number): void {
    if (this.done) return;
    this.t += dt;
    const v = this.vehicle;
    const { slime } = this.fx;
    if (!this.swapped) {
      const k = Math.min(1, this.t / SHUDDER);
      const r = this.oldRig.root;
      r.position.set(v.pos.x + (Math.random() - 0.5) * 0.25 * k, v.pos.y + k * 0.6, v.pos.z + (Math.random() - 0.5) * 0.25 * k);
      r.rotation.z = (Math.random() - 0.5) * 0.12 * k;
      r.scale.setScalar(this.oldRig.scale * (1 + Math.sin(this.t * 40) * 0.04 * k));
      if (Math.random() < 0.6) {
        _v.set((Math.random() - 0.5) * 3, Math.random() * 4, (Math.random() - 0.5) * 3);
        slime.spawn(_at.copy(r.position).setY(r.position.y + 1), _v, 0.15 + Math.random() * 0.15, 0.8, SLIME, v.pos.y);
      }
      if (this.t >= SHUDDER) this.swap();
    } else {
      const k = Math.min(1, (this.t - SHUDDER) / SPRING);
      const nr = this.newRig as VehicleRig;
      // springs out to the scale it was built at (sedans are built smaller than modelled)
      nr.root.scale.setScalar(nr.scale * Math.max(0.05, easeOutElastic(k)));
      if (k >= 1) {
        nr.root.scale.setScalar(nr.scale);
        this.done = true;
      }
    }
  }

  private swap(): void {
    this.swapped = true;
    const v = this.vehicle;
    const { scene, slime, sprites, shake, flash } = this.fx;
    scene.remove(this.oldRig.root);
    this.newRig = this.build();
    v.setForm(this.to, this.newRig);
    v.syncRig();
    this.newRig.root.scale.setScalar(this.newRig.scale * 0.1);
    scene.add(this.newRig.root);
    const at = _at.copy(v.pos).setY(v.pos.y + 1.2);
    slime.burst(at, 70, 12, [0.18, 0.55], [1.2, 2.4], SLIME, 1, v.pos.y);
    slime.burst(at, 18, 9, [0.15, 0.35], [1, 1.8], PURPLE, 1, v.pos.y);
    sprites.spray(at, 10, 6, [3, 7], WHITE, 1.5, 3.2, [1.6, 2.6], 'ghost', 0.9);
    sprites.spray(at, 14, 10, [0, 3], SLIME_PUFF, 3, 7, 1.2, 'puff', 0.7);
    shake(0.75);
    flash(this.to === 'truck' ? 0.55 : 0.3, this.to === 'truck' ? '#9dff3a' : '#ffd9b0');
  }
}
