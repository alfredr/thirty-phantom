import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Scene,
} from 'three';

import { damp } from '@/engine/core/math';
import type { CollisionWorld, Solid } from '@/engine/physics/collision';
import type { LevelData, RampDef } from '@/world/level-data';

const DEPTH = 0.5;
const SIDE = 0.5;
const WALL = 4;
const POST = { w: 0.14, h: 1.45 };
const PLANK = { h: 0.24, d: 0.09, ys: [0.55, 1.1] };
const SPACING = 1.7;
const RISE = 7;
const ROOF_TOL = 0.3;

interface Barrier {
  readonly root: Group;
  readonly solid: Solid;
}

export class Barriers {
  private readonly list: Barrier[];
  private readonly glow: MeshStandardMaterial;
  private up = false;
  private k = 0;

  constructor(level: LevelData, scene: Scene, collision: CollisionWorld) {
    const wood = new MeshStandardMaterial({
      color: '#1f1030',
      roughness: 0.7,
    });
    this.glow = new MeshStandardMaterial({
      color: '#3b1758',
      emissive: '#b46bff',
      emissiveIntensity: 1.4,
      transparent: true,
      opacity: 0.9,
    });
    const ramps = level.ramps.filter((r) => !r.kicker);
    const roof = Math.max(...ramps.map((r) => r.max[1]));
    this.list = ramps
      .filter((r) => r.max[1] >= roof - ROOF_TOL)
      .map((r) => build(r, roof, wood, this.glow, scene, collision));
    this.raise(false);
    this.k = 0;
    this.pose();
  }

  raise(on: boolean): void {
    this.up = on;

    for (const b of this.list) {
      b.solid.enabled = on;
    }
  }

  update(dt: number, t: number): void {
    this.k = damp(this.k, this.up ? 1 : 0, RISE, dt);
    this.glow.emissiveIntensity = 1.1 + Math.sin(t * 3.1) * 0.35;
    this.pose();
  }

  private pose(): void {
    for (const b of this.list) {
      b.root.visible = this.k > 0.01;
      b.root.scale.y = Math.max(0.01, this.k);
    }
  }
}

function build(
  r: RampDef,
  roof: number,
  wood: MeshStandardMaterial,
  glow: MeshStandardMaterial,
  scene: Scene,
  collision: CollisionWorld,
): Barrier {
  const along = r.axis === 'x' ? 0 : 2;
  const across = along === 0 ? 2 : 0;
  const high = r.dir > 0 ? r.max[along] : r.min[along];
  const a0 = Math.min(high, high + r.dir * DEPTH);
  const a1 = Math.max(high, high + r.dir * DEPTH);
  const c0 = r.min[across] - SIDE;
  const c1 = r.max[across] + SIDE;
  const min: [number, number, number] = [0, roof, 0];
  const max: [number, number, number] = [0, roof + WALL, 0];
  min[along] = a0;
  max[along] = a1;
  min[across] = c0;
  max[across] = c1;
  const solid = collision.add(min, max);
  const root = new Group();
  const mid = (a0 + a1) / 2;
  const width = c1 - c0;
  root.position.set(
    along === 0 ? mid : (c0 + c1) / 2,
    roof,
    along === 0 ? (c0 + c1) / 2 : mid,
  );
  root.rotation.y = along === 0 ? 0 : Math.PI / 2;
  const posts = Math.max(2, Math.round(width / SPACING) + 1);
  for (let i = 0; i < posts; i++) {
    const post = new Mesh(new BoxGeometry(POST.w, POST.h, POST.w), wood);
    post.position.set(0, POST.h / 2, -width / 2 + (width * i) / (posts - 1));
    root.add(post);
  }

  PLANK.ys.forEach((y, i) => {
    const plank = new Mesh(new BoxGeometry(PLANK.d, PLANK.h, width), glow);
    plank.position.set(PLANK.d, y, 0);
    plank.rotation.x = (i === 0 ? 1 : -1) * 0.05;
    root.add(plank);
  });
  scene.add(root);
  return { root, solid };
}
