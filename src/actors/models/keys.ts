import { box, build, group, model, SIDES, solid, torus } from './part';

/** A slightly enlarged key ring, lying flat for a highlighted ground pickup. */
export function buildKeys() {
  return build(
    model({ metal: { color: 0xded6b9, metalness: 0.6, roughness: 0.35 } }, [
      group({ rot: [-Math.PI / 2, 0, 0] }, [
        torus(0.12, 0.025, 6, 12, 'metal'),
        ...SIDES.map((side) =>
          group({ at: [0, 0, side * 0.025], rot: [0, 0, side * 0.35] }, [
            solid(box(0.045, 0.2, 0.035).y(-0.18), 'metal'),
            ...[-0.21, -0.27].map((y) =>
              solid(box(0.08, 0.035, 0.035).at(0.025, y, 0), 'metal'),
            ),
          ]),
        ),
      ]),
    ]),
  ).root;
}
