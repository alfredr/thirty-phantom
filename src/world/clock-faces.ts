import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type Object3D, PlaneGeometry } from 'three';

import { TAU } from '@/engine/core/math';
import { withCutaway, type MaterialLibrary } from '@/render/materials';
import { PALETTE } from '@/render/palette';
import { signMaterial, signTextures } from '@/render/signs';

import { facingYaw, type ClockDef } from './level-data';

/** Working clock dials with hour and minute hands driven by the game clock. */
export class ClockFaces {
  readonly root = new Group();
  private readonly hands: { hour: Object3D; minute: Object3D }[] = [];

  constructor(defs: ClockDef[], mats: MaterialLibrary) {
    const dialMat = signMaterial(signTextures('dial', [], 1, 1, 3), 0.6);
    mats.register(dialMat, 'signs');
    const handMat = withCutaway(new MeshStandardMaterial({ color: '#140920', roughness: 0.4, metalness: 0.3 }));
    const tipMat = withCutaway(
      new MeshStandardMaterial({ color: '#2a0d47', emissive: PALETTE.purpleHot, emissiveIntensity: 2.5 }),
    );
    mats.register(tipMat, 'neon');

    for (const d of defs) {
      const g = new Group();
      g.position.set(d.pos[0], d.pos[1], d.pos[2]);
      g.rotation.y = facingYaw(d.facing);
      const dial = new Mesh(new PlaneGeometry(d.size, d.size), dialMat);
      dial.position.z = 0.02;
      dial.receiveShadow = true;
      g.add(dial);

      const mk = (len: number, width: number, z: number): Object3D => {
        const pivot = new Group();
        pivot.position.z = z;
        const geo = new BoxGeometry(width, len, 0.08);
        geo.translate(0, len / 2 - width * 0.6, 0);
        const hand = new Mesh(geo, handMat);
        hand.castShadow = true;
        pivot.add(hand);
        const tip = new Mesh(new BoxGeometry(width * 1.3, width * 1.3, 0.1), tipMat);
        tip.position.y = len - width * 0.9;
        pivot.add(tip);
        g.add(pivot);
        return pivot;
      };

      const hour = mk(d.size * 0.25, 0.22, 0.09);
      const minute = mk(d.size * 0.38, 0.14, 0.15);
      const hub = new Mesh(new BoxGeometry(0.34, 0.34, 0.12), handMat);
      hub.position.z = 0.2;
      g.add(hub);
      this.hands.push({ hour, minute });
      this.root.add(g);
    }
  }

  /** @param hours decimal hours, 0..24 */
  update(hours: number): void {
    const m = (hours % 1) * TAU;
    const h = ((hours % 12) / 12) * TAU;
    for (const c of this.hands) {
      c.minute.rotation.z = -m;
      c.hour.rotation.z = -h;
    }
  }
}
