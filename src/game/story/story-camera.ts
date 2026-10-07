import { Vector3 } from 'three';

import { type Release, releaseOnce } from '@/engine/core/disposable';
import { Leases } from '@/engine/sim/leases';
import type { CamMode } from '@/game/camera-controller';
import type { Cutscene, Game } from '@/game/game';

const SCENE_ZOOM = 15;
const TRACK_ZOOM = 24;
const EMERGE = 3;

export class StoryCamera {
  readonly focus = new Vector3();
  zoom = SCENE_ZOOM;
  readonly shot: Cutscene = { focus: this.focus, zoom: SCENE_ZOOM };
  private readonly scene = new Leases<true>((on) => this.frame(on !== null));
  private release: (() => void) | null = null;
  private tracking: { left: number; at: () => Vector3 } | null = null;
  private saved: CamMode | null = null;

  constructor(private readonly game: Game) {}

  hold(): Release {
    return this.scene.take(true);
  }

  track(seconds: number, at: () => Vector3): Release {
    const tracking = { left: seconds, at };
    this.tracking = tracking;
    return releaseOnce(() => {
      if (this.tracking === tracking) {
        this.settle();
      }
    });
  }

  settle(): void {
    const cut = this.tracking !== null;
    this.tracking = null;
    this.shot.focus = this.focus;
    this.shot.zoom = this.zoom;

    if (cut) {
      const iso = this.game.iso;
      iso.zoom = iso.zoomTarget = this.zoom;
      iso.snapTo(this.focus);
    }
  }

  tick(dt: number): void {
    const t = this.tracking;
    if (!t) {
      return;
    }

    t.left -= dt;

    if (t.left > 0) {
      this.shot.focus = t.at();
      this.shot.zoom = TRACK_ZOOM;
    } else {
      this.settle();
    }
  }

  cut(camera: Cutscene): Release {
    return this.game.cameraShots.take(camera);
  }

  moonrise(behind: number): void {
    const g = this.game;
    g.haunt(true, EMERGE);
    this.saved = g.cameraMode;
    g.setCamera('chase');
    g.chase.snapBehind(behind);
  }

  chose(): void {
    this.saved = null;
  }

  restore(): void {
    if (this.saved !== null) {
      this.game.setCamera(this.saved);
      this.saved = null;
    }
  }

  private frame(on: boolean): void {
    if (on && !this.release) {
      this.settle();
      this.release = this.cut(this.shot);
    } else if (!on && this.release) {
      this.release();
      this.release = null;
      this.tracking = null;
    }
  }
}
