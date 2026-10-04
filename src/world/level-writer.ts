import type { MatKey } from '@/render/materials';
import type { SignStyle } from '@/render/signs';

import type { DecorKind } from './decor-models';
import {
  emptyLevel,
  type BoxDef,
  type BuildingDef,
  type DecorDef,
  type Facing,
  type LampColor,
  type LampKind,
  type LevelData,
  type RampDef,
  type V3,
} from './level-data';

/** Optional box properties beyond bounds and material. */
type BoxExtra = Omit<BoxDef, 'min' | 'max' | 'mat'>;

/** Convenience wrapper for authoring LevelData in a local coordinate frame. */
export class LevelWriter {
  readonly data: LevelData;
  private ox = 0;
  private oy = 0;
  private oz = 0;

  constructor(name: string, data?: LevelData) {
    this.data = data ?? emptyLevel(name);
  }

  /** Run `fn` with `o` added to the current coordinate offset, then restore the previous offset on normal return. */
  at(o: V3, fn: () => void): void {
    const prev: V3 = [this.ox, this.oy, this.oz];
    this.ox += o[0];
    this.oy += o[1];
    this.oz += o[2];
    fn();
    [this.ox, this.oy, this.oz] = prev;
  }

  p(v: V3): V3 {
    return [v[0] + this.ox, v[1] + this.oy, v[2] + this.oz];
  }

  box(min: V3, max: V3, mat: MatKey, extra: BoxExtra = {}): BoxDef {
    const b: BoxDef = {
      min: this.p([Math.min(min[0], max[0]), Math.min(min[1], max[1]), Math.min(min[2], max[2])]),
      max: this.p([Math.max(min[0], max[0]), Math.max(min[1], max[1]), Math.max(min[2], max[2])]),
      mat,
      ...extra,
    };
    this.data.boxes.push(b);
    return b;
  }

  /** Box from a center-bottom point and size. */
  block(
    cx: number,
    y: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    mat: MatKey,
    extra: BoxExtra = {},
  ): BoxDef {
    return this.box([cx - sx / 2, y, cz - sz / 2], [cx + sx / 2, y + sy, cz + sz / 2], mat, extra);
  }

  /** A rim `t` thick around the rectangle x0..x1, z0..z1, from y0 up to y1 (parapets, pond and fountain edges). */
  frame(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    t: number,
    y0: number,
    y1: number,
    mat: MatKey,
    extra: BoxExtra = {},
  ): void {
    this.box([x0, y0, z0], [x1, y1, z0 + t], mat, extra);
    this.box([x0, y0, z1 - t], [x1, y1, z1], mat, extra);
    this.box([x0, y0, z0 + t], [x0 + t, y1, z1 - t], mat, extra);
    this.box([x1 - t, y0, z0 + t], [x1, y1, z1 - t], mat, extra);
  }

  ramp(min: V3, max: V3, axis: 'x' | 'z', dir: 1 | -1, low: number, mat: MatKey, kicker = false): RampDef {
    const r: RampDef = {
      min: this.p(min),
      max: this.p(max),
      axis,
      dir,
      low: low + this.oy,
      mat,
      kicker: kicker || undefined,
    };
    this.data.ramps.push(r);
    return r;
  }

  sign(pos: V3, size: [number, number], facing: Facing, style: SignStyle, lines: string[]): void {
    this.data.signs.push({ pos: this.p(pos), size, facing, style, lines });
  }

  lamp(pos: V3, color: LampColor, kind: LampKind): void {
    this.data.lamps.push({ pos: this.p(pos), color, kind });
  }

  /**
   * Append decor in the current coordinate frame. `yaw` is in radians; optional scale and stretch apply uniformly and
   * along local X respectively. Return the appended definition.
   */
  decor(kind: DecorKind, pos: V3, yaw = 0, extra: Pick<DecorDef, 'scale' | 'stretch'> = {}): DecorDef {
    const d: DecorDef = { kind, pos: this.p(pos), yaw, ...extra };
    this.data.decor.push(d);
    return d;
  }

  /** Append a building after translating its bounds, doors, and core into the current frame. Return the new definition. */
  building(def: BuildingDef): BuildingDef {
    const along = (f: Facing): number => (f === 'z+' || f === 'z-' ? this.ox : this.oz);
    const b: BuildingDef = {
      ...def,
      min: this.p(def.min),
      max: this.p(def.max),
      doors: def.doors.map((d) => ({ ...d, at: d.at + along(d.facing) })),
      core: def.core && {
        ...def.core,
        rect: [
          def.core.rect[0] + this.ox,
          def.core.rect[1] + this.oz,
          def.core.rect[2] + this.ox,
          def.core.rect[3] + this.oz,
        ],
      },
    };
    this.data.buildings.push(b);
    return b;
  }

  puddle(pos: V3, r: number): void {
    this.data.puddles.push({ pos: this.p(pos), r });
  }

  /** A car left parked at `pos`, facing `yaw`. */
  parked(pos: V3, yaw: number): void {
    this.data.parked.push({ pos: this.p(pos), yaw });
  }

  /** A parking stall for a car standing at `pos`, facing `yaw`. */
  bay(pos: V3, yaw: number): void {
    this.data.bays.push({ pos: this.p(pos), yaw });
  }
}
