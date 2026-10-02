import { BufferGeometry, Float32BufferAttribute, Group, Line, LineBasicMaterial } from 'three';
import { FX_LAYER } from '../render/layers';
import { PALETTE } from '../render/palette';
import type { Polyline } from '../world/polyline';

const COLORS: Record<string, string> = { car: PALETTE.slime, truck: PALETTE.purpleHot, person: PALETTE.foxy };

/** ?nav: draws the last few planned routes, lifted a little off the ground. */
export class NavDebug {
  readonly root = new Group();
  private readonly lines: Line[] = [];
  private readonly mats = new Map<string, LineBasicMaterial>();

  show(path: Polyline, kind: string): void {
    const pos: number[] = [];
    for (const p of path.points) pos.push(p.x, p.y + 0.35, p.z);
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    let mat = this.mats.get(kind);
    if (!mat) this.mats.set(kind, (mat = new LineBasicMaterial({ color: COLORS[kind] ?? '#ffffff', depthTest: false, toneMapped: false })));
    const line = new Line(g, mat);
    line.layers.set(FX_LAYER);
    line.renderOrder = 10;
    this.root.add(line);
    this.lines.push(line);
    while (this.lines.length > 12) {
      const old = this.lines.shift() as Line;
      this.root.remove(old);
      old.geometry.dispose();
    }
  }
}
