import type { Group } from 'three';

import { box, build, cylinder, group, model, NO_CAST, solid, torus } from './part';

/** Collectible vehicle parts released by crashes. */
export type PartKind = 'tire' | 'hubcap' | 'mirror' | 'bumper' | 'headlight' | 'muffler' | 'plate';
export const PART_KINDS: readonly PartKind[] = ['tire', 'hubcap', 'mirror', 'bumper', 'headlight', 'muffler', 'plate'];

const MATS = {
  rubber: { color: '#151118', roughness: 0.95 },
  steel: { color: '#6f6a7a', roughness: 0.45, metalness: 0.6 },
  chrome: { color: '#c9c6d4', roughness: 0.2, metalness: 0.85 },
  plastic: { color: '#2a2530', roughness: 0.7 },
  glass: { color: '#cfd8e8', roughness: 0.1, metalness: 0.3 },
  rust: { color: '#5a3424', roughness: 0.9 },
  plate: { color: '#e8dfa6', roughness: 0.6 },
  ink: { color: '#1a1420', roughness: 0.8 },
};
type Mat = keyof typeof MATS;

/** A tire on its side with its rim still in it. */
const TIRE = { r: 0.3, tube: 0.11, rim: 0.17 };

/** Each part as it lies on the ground (y=0 underneath). */
function part(kind: PartKind) {
  switch (kind) {
    case 'tire':
      return [
        torus<Mat>(TIRE.r, TIRE.tube, 10, 18, 'rubber', { at: [0, TIRE.tube, 0], rot: [Math.PI / 2, 0, 0] }),
        cylinder<Mat>(TIRE.rim, TIRE.tube * 1.6, 12, 'steel', { at: [0, TIRE.tube, 0] }),
      ];
    case 'hubcap':
      return [
        cylinder<Mat>(0.2, 0.03, 14, 'chrome', { at: [0, 0.015, 0] }),
        cylinder<Mat>(0.06, 0.03, 8, 'steel', { at: [0, 0.04, 0], cast: false }),
      ];

    case 'mirror': {
      const housing = box(0.22, 0.14, 0.1).on(0);
      return [
        solid<Mat>(housing, 'plastic'),
        solid<Mat>(housing.sized(0.18, 0.1, 0.01).onFace(housing, '+z', 0.004), 'glass', NO_CAST),
        solid<Mat>(box(0.04, 0.04, 0.12).on(0).move(0.1, 0, -0.08), 'plastic'),
      ];
    }

    case 'bumper': {
      const bar = box(1.1, 0.16, 0.18).on(0);
      return [
        solid<Mat>(bar, 'plastic'),
        solid<Mat>(bar.sized(1.06, 0.04, 0.02).onFace(bar, '+z', 0.004), 'chrome', NO_CAST),
      ];
    }

    case 'headlight': {
      const shell = box(0.3, 0.16, 0.12).on(0);
      return [
        solid<Mat>(shell, 'plastic'),
        solid<Mat>(shell.sized(0.26, 0.12, 0.02).onFace(shell, '+z', 0.004), 'glass', NO_CAST),
      ];
    }

    case 'muffler':
      return [
        cylinder<Mat>(0.12, 0.55, 10, 'rust', { at: [0, 0.12, 0], rot: [0, 0, Math.PI / 2] }),
        cylinder<Mat>(0.035, 0.4, 6, 'steel', { at: [0.45, 0.06, 0], rot: [0, 0, Math.PI / 2] }),
      ];

    case 'plate': {
      const plate = box(0.32, 0.012, 0.16).on(0);
      return [solid<Mat>(plate, 'plate'), solid<Mat>(plate.sized(0.22, 0.004, 0.05).on(plate.top), 'ink', NO_CAST)];
    }
  }
}

/** A car part lying on the ground. */
export function junk(kind: PartKind) {
  return model(MATS, [group({ name: kind }, part(kind))]);
}

export function buildJunk(kind: PartKind): Group {
  return build(junk(kind)).root;
}
