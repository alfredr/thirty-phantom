import { Color, type Group, Matrix4, Vector3 } from 'three';

import { baked, type Instanced, instanced, type Model } from '@/actors/models/part';
import { CollisionWorld } from '@/engine/physics/collision';
import type { EmissiveChannel, MaterialLibrary } from '@/render/materials';

import { DECOR, type DecorHit, type DecorKind, hitOf, type LocalBox, worldBox } from './decor-models';
import type { DecorDef } from './level-data';
import type { PropKind, PropSpec } from './props';

/** Glowing decor (petals, the fountain's water, a shelter's ad panel) follows the neon signs' day and night levels. */
const GLOW: EmissiveChannel = 'neon';

export interface BuiltDecor {
  /** Static decor geometry batched by material. */
  root: Group;
  /** Breakable decor registered with the world's Props system. */
  props: PropSpec[];
  /** Visual occluders such as tree crowns, used for cutaway probes without blocking movement. */
  sight: CollisionWorld;
}

const _s = new Vector3();

/** Write the decor's translation, yaw, scale, and local-X stretch into `out`, then return it. */
export function decorMatrix(d: DecorDef, out = new Matrix4()): Matrix4 {
  const s = d.scale ?? 1;
  return out
    .makeRotationY(d.yaw)
    .scale(_s.set(s * (d.stretch ?? 1), s, s))
    .setPosition(d.pos[0], d.pos[1], d.pos[2]);
}

/** Transform local decor boxes into world-space bounds, ignoring yaw for round decor. */
function placed(list: readonly LocalBox[], d: DecorDef): LocalBox[] {
  const turn = DECOR[d.kind].round ? 0 : d.yaw;
  return list.map((b) => worldBox(b, d.pos, turn, d.scale ?? 1, d.stretch ?? 1));
}

/**
 * Build decor meshes, visual occluders, and breakable props. Batch standing geometry by material and allocate instances
 * for toppled pieces. Add breakable collision here; static collision must already be in the level boxes. Throw if a
 * breakable decor definition has no collision boxes.
 */
export function buildDecor(defs: readonly DecorDef[], mats: MaterialLibrary, collision: CollisionWorld): BuiltDecor {
  const models = new Map<DecorKind, Model<string>>();
  const modelOf = (k: DecorKind): Model<string> => {
    let m = models.get(k);
    if (!m) {
      models.set(k, (m = DECOR[k].model()));
    }

    return m;
  };

  const bake = baked(defs.map((d) => ({ model: modelOf(d.kind), at: decorMatrix(d) })));
  bake.root.name = 'decor';

  for (const { mat } of bake.materials) {
    if (mat.emissiveIntensity > 0) {
      mats.register(mat, GLOW);
    }
  }

  // Group breakable pieces by kind while retaining their indices in the static batch.
  const hits = defs.map((d) => hitOf(d.kind, d.scale ?? 1));
  const copies = new Map<DecorKind, number[]>();
  defs.forEach((d, i) => {
    if (!hits[i]) {
      return;
    }

    const list = copies.get(d.kind);
    if (list) {
      list.push(i);
    } else {
      copies.set(d.kind, [i]);
    }
  });
  const kinds = new Map<DecorKind, PropKind>();
  for (const [k, list] of copies) {
    const hit = DECOR[k].hit as DecorHit;
    let draw: Instanced<string> | null = null;
    if (hit.as === 'topple') {
      draw = instanced(modelOf(k), list.length);

      for (const m of Object.values(draw.mats)) {
        if (m.emissiveIntensity > 0) {
          mats.register(m, GLOW);
        }
      }
    }

    const fall = hit.as === 'topple' ? hit : { height: 0, wide: 0, down: 0 };
    kinds.set(k, {
      name: k,
      draw,
      baked: { show: (slot, on) => bake.show(list[slot] as number, on) },
      height: fall.height,
      wide: fall.wide,
      down: fall.down,
      // Round decor can fall in any direction; other pieces fall along their local axes.
      square: !DECOR[k].round,
      shatter: hit.as === 'shatter',
      debris: hit.debris.map((c) => new Color(c)),
      keep: hit.keep,
    });
  }

  const sight = new CollisionWorld();
  const props: PropSpec[] = [];
  const slots = new Map<DecorKind, number>();
  defs.forEach((d, i) => {
    const spec = DECOR[d.kind];
    const crowns = placed(spec.sight ?? [], d).map(([min, max]) => sight.add(min, max));
    const hit = hits[i];
    const kind = kinds.get(d.kind);
    if (!hit || !kind) {
      return;
    }

    const slot = slots.get(d.kind) ?? 0;
    slots.set(d.kind, slot + 1);
    const [solid, ...parts] = placed(spec.solids, d).map(([min, max]) =>
      collision.add(min, max, { knockdown: true, heavy: hit.by === 'truck' }),
    );
    if (!solid) {
      throw new Error(`decor ${d.kind} breaks but has no solids`);
    }

    const [x, y, z] = d.pos;
    props.push({
      kind,
      slot,
      x,
      y,
      z,
      yaw: d.yaw,
      stretch: d.stretch ?? 1,
      scale: d.scale ?? 1,
      solid,
      parts,
      sight: crowns,
    });
  });
  return { root: bake.root, props, sight };
}
