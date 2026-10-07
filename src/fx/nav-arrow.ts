import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Vector3,
} from 'three';

import { withCutaway } from '@/render/materials';
import { PALETTE } from '@/render/palette';

/**
 * Display a floating chevron pointing from the supplied position toward an
 * objective.
 */
export class NavArrow {
  readonly root = new Group();
  private readonly mat: MeshStandardMaterial;
  private t = 0;
  private color = '';

  constructor() {
    this.mat = withCutaway(
      new MeshStandardMaterial({
        color: '#d6ff9a',
        emissive: PALETTE.slime,
        emissiveIntensity: 2.6,
      }),
    );
    const bar = new BoxGeometry(0.34, 0.34, 1.6);
    const a = new Mesh(bar, this.mat);
    a.position.set(-0.45, 0, 0);
    a.rotation.y = Math.PI / 4;
    const b = new Mesh(bar, this.mat);
    b.position.set(0.45, 0, 0);
    b.rotation.y = -Math.PI / 4;
    const chevron = new Group();
    chevron.add(a, b);
    chevron.position.z = 0.4;
    this.root.add(chevron);
    this.root.visible = false;
  }

  setColor(hex: string): void {
    if (hex === this.color) {
      return;
    }

    this.color = hex;
    this.mat.emissive.set(hex);
  }

  update(
    dt: number,
    from: Vector3 | null,
    height: number,
    to: Vector3 | null,
  ): void {
    this.t += dt;

    if (!from || !to) {
      this.root.visible = false;
      return;
    }

    this.root.visible = true;
    this.root.position.set(
      from.x,
      from.y + height + 1.4 + Math.sin(this.t * 4) * 0.25,
      from.z,
    );
    this.root.rotation.y = Math.atan2(to.x - from.x, to.z - from.z);
  }
}
