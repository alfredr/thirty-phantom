import {
  Color,
  Group,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Scene,
  Vector3,
} from 'three';

import type { Vehicle } from '@/actors/vehicles/vehicle';
import type { Emitter } from '@/engine/core/events';
import { PURPLE, SLIME, WHITE } from '@/fx/colors';
import { CubeParticles } from '@/fx/cube-particles';
import { Exhaust } from '@/fx/exhaust';
import { Honks } from '@/fx/honks';
import { SpriteFx } from '@/fx/sprite-fx';
import type { GameRenderer } from '@/render/game-renderer';
import { softInk, withCutaway } from '@/render/materials';

import type { FxKit } from './deck/transform-sequence';
import { playEffects, type Stage } from './effects';
import type { Phase } from './game-clock';
import type { GameEvents } from './game-events';

const BONE = new Color('#efe6ff');
const DIRT = new Color('#3a2a22');
const OUTFIT_PUFF = new Color(0.6, 0.3, 1.4);
const TIRE_SMOKE = new Color('#221c28');
const EMBER = new Color(2.4, 0.9, 0.2);
const SPLAT_LIFE: [number, number] = [0.25, 0.5];

/** Shared particle pools and visual effects for gameplay. */
export class GameEffects implements FxKit {
  readonly root = new Group();
  readonly slime = new CubeParticles(
    softInk(withCutaway(new MeshBasicMaterial({ toneMapped: false }))),
    600,
  );
  readonly debris = new CubeParticles(
    withCutaway(new MeshStandardMaterial({ roughness: 0.9 })),
    300,
    34,
  );
  readonly sprites = new SpriteFx(120);
  readonly exhaust = new Exhaust(this.sprites);
  private readonly honks = new Honks();
  private flashAmount = 0;
  private readonly flashColor = new Color();
  private readonly at = new Vector3();
  private readonly velocity = new Vector3();
  private readonly splatSize: [number, number] = [0, 0];

  constructor(
    readonly scene: Scene,
    readonly shake: (trauma: number) => void,
  ) {
    this.root.add(
      this.slime.mesh,
      this.debris.mesh,
      this.sprites.root,
      this.honks.root,
    );
  }

  bind(
    events: Emitter<GameEvents>,
    feedback: Pick<Stage, 'ride' | 'toast' | 'groundAt'>,
  ): void {
    playEffects(events, {
      ...feedback,
      slime: this.slime,
      debris: this.debris,
      sprites: this.sprites,
      shake: this.shake,
      flash: (amount, color) => this.flash(amount, color),
    });
  }

  tireFire(at: Vector3): void {
    this.at.copy(at).setY(at.y + 1);
    this.sprites.spray(
      this.at,
      7,
      0.7,
      [1.2, 2.6],
      TIRE_SMOKE,
      0.35,
      1.5,
      [1.4, 2.4],
      'puff',
      0.85,
    );
    this.debris.burst(
      this.at,
      14,
      2.5,
      [0.03, 0.07],
      [0.6, 1.3],
      EMBER,
      2.2,
      at.y,
    );
  }

  skeletonRise(at: Vector3): void {
    this.debris.burst(
      this.at.copy(at).setY(at.y + 0.2),
      14,
      5,
      [0.1, 0.25],
      [0.8, 1.5],
      DIRT,
      0.9,
      at.y,
    );
    this.slime.burst(at, 8, 3, [0.08, 0.16], [0.5, 0.9], SLIME, 0.6, at.y);
  }

  skeletonCrumble(at: Vector3): void {
    this.debris.burst(
      this.at.copy(at).setY(at.y + 0.9),
      18,
      4,
      [0.08, 0.22],
      [1.5, 2.5],
      BONE,
      0.5,
      at.y,
    );
  }

  death(at: Vector3): void {
    this.sprites.spray(
      this.at.copy(at).setY(at.y + 0.6),
      3,
      2,
      [1.6, 2.6],
      WHITE,
      1.2,
      2.4,
      1.4,
      'ghost',
      0.8,
    );
  }

  splat(at: Vector3, size: number): void {
    this.splatSize[0] = size * 0.25;
    this.splatSize[1] = size * 0.5;
    this.slime.burst(
      this.at.copy(at).setY(at.y + 0.05),
      4,
      1.6,
      this.splatSize,
      SPLAT_LIFE,
      SLIME,
      0.5,
      at.y,
    );
  }

  hop(at: Vector3): void {
    this.slime.burst(at, 10, 4, [0.12, 0.25], [0.6, 1], SLIME, 0.6, at.y);
  }

  codySmoke(at: Vector3): void {
    this.at.set(
      at.x + (Math.random() - 0.5) * 1.5,
      at.y + Math.random() * 2,
      at.z + (Math.random() - 0.5) * 1.5,
    );
    this.sprites.emit(
      this.at,
      this.velocity.set(0, 2, 0),
      OUTFIT_PUFF,
      0.4,
      1.6,
      0.8,
      'puff',
      0.8,
    );
  }

  codyChanged(at: Vector3, phase: Phase): void {
    this.at.copy(at).setY(at.y + 1);
    this.slime.burst(
      this.at,
      30,
      6,
      [0.1, 0.3],
      [0.8, 1.6],
      phase === 'day' ? PURPLE : SLIME,
      1,
      at.y,
    );
    this.sprites.spray(
      this.at,
      5,
      3,
      [2, 4],
      WHITE,
      1,
      2.2,
      1.4,
      'ghost',
      0.9,
    );
    this.shake(0.25);
  }

  honk(car: Vehicle, anger: number): void {
    this.honks.pop(
      this.at.copy(car.pos).setY(car.pos.y + car.rig.height + 0.2),
      anger,
    );
  }

  update(dt: number, vehicles: readonly Vehicle[], nightness: number): void {
    this.slime.update(dt);
    this.debris.update(dt);
    this.exhaust.update(dt, vehicles, nightness);
    this.sprites.update(dt);
    this.honks.update(dt);
  }

  flash(amount: number, color = '#9dff3a'): void {
    this.flashAmount = Math.max(this.flashAmount, amount);
    this.flashColor.set(color);
  }

  /** Apply after day/night grading and fades. */
  applyFlash(dt: number, gfx: GameRenderer): void {
    this.flashAmount = Math.max(0, this.flashAmount - dt * 1.8);
    gfx.grade.uniforms.flash.value = this.flashAmount * this.flashAmount;
    gfx.grade.uniforms.flashColor.value.copy(this.flashColor);
  }
}
