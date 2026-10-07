import { Vector3 } from 'three';

import type { Player } from '@/actors/player';
import type { Vehicle } from '@/actors/vehicles/vehicle';
import { TUNING } from '@/config';
import { clamp } from '@/engine/core/math';
import { Leases } from '@/engine/sim/leases';
import { ChaseCamera } from '@/render/chase-camera';
import { Cutaway } from '@/render/cutaway';
import type { GameRenderer } from '@/render/game-renderer';
import { IsoCamera } from '@/render/iso-camera';
import { FX_LAYER } from '@/render/layers';
import type { SunLight } from '@/render/sun-light';
import type { BuiltWorld } from '@/world/build-world';

import { CameraController, type CameraEffects } from './camera-controller';

/** Override the camera's focus and zoom while the game mutes player controls. */
export type Cutscene = {
  focus: Vector3;
  zoom: number;
};

type CameraFrame = {
  player: Player;
  ride: Vehicle | null;
  world: Pick<BuiltWorld, 'collision' | 'sight'>;
  mouse: readonly [number, number];
  turn: number;
};

/** Keep both rigs ready for view changes and apply the active scene's framing. */
export class GameCamera {
  readonly iso = new IsoCamera();
  readonly chase = new ChaseCamera();
  readonly shots = new Leases<Cutscene>();
  readonly controls: CameraController;
  private readonly cutaway = new Cutaway();
  private readonly lead = new Vector3();
  private readonly orbitFocus = new Vector3();
  private readonly projected = new Vector3();
  private readonly shadowAxis = new Vector3();
  private readonly shadowCorners: Vector3[] = [];

  constructor(effects: Omit<CameraEffects, 'snapBehind'>, touch: boolean) {
    this.controls = new CameraController(
      { ...effects, snapBehind: (yaw) => this.chase.snapBehind(yaw) },
      touch,
    );
    this.iso.camera.layers.enable(FX_LAYER);
    this.chase.camera.layers.enable(FX_LAYER);
  }

  get chaseActive(): boolean {
    return this.controls.view === 'chase';
  }

  get view(): IsoCamera | ChaseCamera {
    return this.chaseActive ? this.chase : this.iso;
  }

  beginTitle(center: Vector3): void {
    this.iso.zoom = this.iso.zoomTarget = 74;
    this.iso.snapTo(this.orbitFocus.copy(center).setY(6));
  }

  beginPlay(yaw: number): void {
    this.iso.zoomTarget = TUNING.camera.zoom;
    this.iso.azimuthTarget =
      Math.round((this.iso.azimuth - Math.PI / 4) / (Math.PI / 2)) *
        (Math.PI / 2) +
      Math.PI / 4;
    this.chase.snapBehind(yaw);
  }

  orbit(dt: number, center: Vector3): void {
    this.iso.azimuthTarget += dt * 0.12;
    this.iso.update(dt, this.orbitFocus.copy(center).setY(7), null, 2);
    this.cutaway.off();
  }

  update(dt: number, { player, ride, world, mouse, turn }: CameraFrame): void {
    const cut = this.shots.top;
    const focus = cut ? cut.focus : ride ? ride.pos : player.pos;
    const lead =
      ride && !cut
        ? this.lead.set(
            clamp(ride.vel.x * 0.35, -7, 7),
            0,
            clamp(ride.vel.z * 0.35, -7, 7),
          )
        : null;
    if (cut) {
      this.iso.zoomTarget = cut.zoom;
    }

    // Keep iso tracking during chase view so switching back stays smooth.
    this.iso.update(dt, focus, lead, cut ? 2.5 : ride ? 5 : 6);

    if (this.chaseActive) {
      this.chase.look(...mouse);
      this.chase.update(
        dt,
        {
          kind: ride ? ride.form : 'foot',
          pos: focus,
          vel: ride ? ride.vel : player.vel,
          yaw: ride ? ride.yaw : null,
        },
        turn,
        world.collision,
      );
    }

    player.seenFrom(
      this.chaseActive && !ride ? this.chase.camera.position : null,
      dt,
    );

    if (this.chaseActive) {
      this.cutaway.off();
    } else {
      this.cutaway.update(
        dt,
        focus,
        ride,
        this.iso,
        world.collision,
        world.sight,
      );
    }
  }

  /** Fit iso shadows to the visible corners; chase uses a local focus. */
  fitShadows(lights: SunLight, sunDir: Vector3): void {
    if (this.chaseActive) {
      lights.follow(this.chase.shadowFocus(this.shadowAxis), sunDir);
    } else {
      lights.cover(
        this.iso.shadowCorners(this.shadowCorners),
        sunDir,
        this.iso.screenUp(this.shadowAxis),
      );
    }
  }

  /** Project into CSS pixels using the renderer's current world curvature. */
  toScreen(p: Vector3, gfx: GameRenderer): { x: number; y: number } | null {
    const out = gfx.bend(this.projected.copy(p)).project(this.view.camera);
    if (out.z >= 1) {
      return null;
    }

    const r = gfx.renderer.domElement.getBoundingClientRect();
    return {
      x: r.left + ((out.x + 1) / 2) * r.width,
      y: r.top + ((1 - out.y) / 2) * r.height,
    };
  }
}
