import { Vector3 } from 'three';

import type { MindEvent } from '@/engine/sim/mind';
import type { CamMode } from '@/game/camera-controller';
import type { Cutscene, Game } from '@/game/game';

import { Leases, type Part } from './director';

const SCENE_ZOOM = 15;
const TRACK_ZOOM = 24;
const EMERGE = 3;

export class StoryCamera {
  readonly focus = new Vector3();
  zoom = SCENE_ZOOM;
  private readonly shot: Cutscene = { focus: this.focus, zoom: SCENE_ZOOM };
  private readonly scene = new Leases<true>((on) => this.frame(on !== null));
  private release: (() => void) | null = null;
  private tracking: { left: number; at: () => Vector3 } | null = null;
  private saved: CamMode | null = null;

  constructor(private readonly game: Game) {}

  hold(): () => void {
    return this.scene.take(true);
  }

  track(seconds: number, at: () => Vector3): void {
    this.tracking = { left: seconds, at };
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

  cut(camera: Cutscene): () => void {
    const g = this.game;
    const before = g.cutscene;
    g.cutscene = camera;

    return () => {
      if (g.cutscene === camera) {
        g.cutscene = before;
      }
    };
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

export const sceneShot = (): Part<{ readonly camera: StoryCamera }, MindEvent<string>, string> => ({
  create: (_s, c) => ({ stop: c.camera.hold() }),
});
