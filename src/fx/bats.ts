import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type Object3D, type Vector3 } from 'three';

import { TAU } from '@/engine/core/math';
import { Rng } from '@/engine/core/rng';
import { withCutaway } from '@/render/materials';
import { PALETTE } from '@/render/palette';

interface Bat {
  root: Group;
  wingL: Object3D;
  wingR: Object3D;
  phase: number;
  radius: number;
  height: number;
  speed: number;
  wobble: number;
}

/** Animate bats circling the deck, visible as night falls. */
export class Bats {
  readonly root = new Group();
  private readonly bats: Bat[] = [];
  private t = 0;

  constructor(
    private readonly center: Vector3,
    count = 14,
  ) {
    const rng = new Rng(13);
    const mat = withCutaway(
      new MeshStandardMaterial({ color: '#160b22', roughness: 0.8, emissive: '#5a1f9a', emissiveIntensity: 0.9 }),
    );
    const eye = withCutaway(
      new MeshStandardMaterial({ color: PALETTE.red, emissive: PALETTE.red, emissiveIntensity: 3 }),
    );
    const bodyGeo = new BoxGeometry(0.34, 0.3, 0.6);
    const wingGeo = new BoxGeometry(0.9, 0.05, 0.75);
    wingGeo.translate(0.45, 0, 0);
    const tipGeo = new BoxGeometry(0.55, 0.05, 0.45);
    tipGeo.translate(1.15, 0, 0.1);
    const scallop = new BoxGeometry(0.3, 0.05, 0.25);
    scallop.translate(0.6, 0, -0.45);
    const eyeGeo = new BoxGeometry(0.07, 0.07, 0.04);
    const earGeo = new BoxGeometry(0.08, 0.16, 0.08);
    for (let i = 0; i < count; i++) {
      const root = new Group();
      const body = new Mesh(bodyGeo, mat);
      root.add(body);

      for (const s of [-1, 1]) {
        const e = new Mesh(earGeo, mat);
        e.position.set(s * 0.1, 0.22, 0.18);
        root.add(e);
        const ey = new Mesh(eyeGeo, eye);
        ey.position.set(s * 0.08, 0.06, 0.31);
        root.add(ey);
      }

      const mk = (side: number): Object3D => {
        const pivot = new Group();
        pivot.position.x = side * 0.15;
        pivot.scale.x = side;
        pivot.add(new Mesh(wingGeo, mat), new Mesh(tipGeo, mat), new Mesh(scallop, mat));
        root.add(pivot);
        return pivot;
      };

      const wingL = mk(-1);
      const wingR = mk(1);
      const s = rng.range(0.55, 0.85);
      root.scale.setScalar(s);
      this.root.add(root);
      this.bats.push({
        root,
        wingL,
        wingR,
        phase: rng.range(0, TAU),
        radius: rng.range(18, 44),
        height: rng.range(38, 58),
        speed: rng.range(0.25, 0.5) * (rng.chance(0.5) ? 1 : -1),
        wobble: rng.range(0.5, 2),
      });
    }
  }

  update(dt: number, nightness: number): void {
    this.t += dt;
    this.root.visible = nightness > 0.15;

    if (!this.root.visible) {
      return;
    }

    for (const b of this.bats) {
      const a = b.phase + this.t * b.speed;
      const r = b.radius + Math.sin(this.t * b.wobble + b.phase) * 4;
      const x = this.center.x + Math.cos(a) * r;
      const z = this.center.z + Math.sin(a) * r * 0.8;
      const y = b.height + Math.sin(this.t * 1.3 + b.phase) * 2;
      // Align each bat with its actual movement direction.
      const pos = b.root.position;
      const dx = x - pos.x;
      const dy = y - pos.y;
      const dz = z - pos.z;
      if (dx * dx + dy * dy + dz * dz > 1e-6) {
        b.root.rotation.y = Math.atan2(dx, dz);
      }

      pos.set(x, y, z);
      const flap = Math.sin(this.t * 16 + b.phase * 3);
      b.wingL.rotation.z = flap * 0.7;
      b.wingR.rotation.z = flap * 0.7;
    }
  }
}
