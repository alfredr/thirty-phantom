import type { Group } from 'three';

import { box, build, cylinder, group, model, solid } from './part';

const BODY = { w: 0.2, h: 0.38, d: 0.32 };

export function buildGasCan(): Group {
  const body = box(BODY.w, BODY.h, BODY.d).on(0);
  return build(
    model(
      {
        paint: { color: '#c0261d', roughness: 0.45, metalness: 0.25 },
        trim: { color: '#3a1410', roughness: 0.6 },
        cap: { color: '#e8c33a', roughness: 0.4, metalness: 0.3 },
      },
      [
        solid(body, 'paint'),
        solid(body.sized(BODY.w + 0.012, 0.03, BODY.d * 0.7).y(BODY.h * 0.5), 'trim'),
        solid(body.sized(0.04, 0.05, 0.16).on(body).move(0, 0, -0.06), 'trim'),
        solid(body.sized(0.05, 0.02, 0.18).on(body).move(0, 0.05, -0.06), 'trim'),
        group({ at: [0, BODY.h + 0.04, BODY.d / 2 - 0.04], rot: [0.7, 0, 0] }, [
          cylinder(0.025, 0.12, 8, 'cap', { at: [0, 0.05, 0] }),
        ]),
      ],
    ),
  ).root;
}
