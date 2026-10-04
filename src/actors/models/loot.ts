import type { Group } from 'three';

import { box, build, model, NO_CAST, solid } from './part';

/** Collectible money models: a banded cash stack or a wallet. */
export type LootKind = 'cash' | 'wallet';

const BILL = '#6fbf5e';
const BAND = '#efe0a8';
const LEATHER = '#5a3424';
/** Emissive intensity that keeps dropped bills visible at night. */
const BILL_GLOW = 0.35;

/** A stack of bills with a paper band, resting on y=0, long side along z. */
export function cash() {
  const stack = box(0.16, 0.07, 0.3).on(0);
  return model(
    {
      bill: { color: BILL, emissive: BILL, emissiveIntensity: BILL_GLOW, roughness: 0.85 },
      band: { color: BAND, roughness: 0.8 },
    },
    [solid(stack, 'bill'), solid(stack.sized(0.17, 0.075, 0.06), 'band', NO_CAST)],
  );
}

/** A folded leather wallet, bills showing at the top edge. */
export function wallet() {
  const body = box(0.2, 0.06, 0.14).on(0);
  return model(
    {
      leather: { color: LEATHER, roughness: 0.65 },
      bill: { color: BILL, emissive: BILL, emissiveIntensity: BILL_GLOW, roughness: 0.85 },
    },
    [
      solid(body, 'leather'),
      solid(
        body
          .sized(0.17, 0.02, 0.1)
          .on(body.top - 0.01)
          .move(0, 0, 0.03),
        'bill',
        NO_CAST,
      ),
    ],
  );
}

export function buildLoot(kind: LootKind): Group {
  return kind === 'cash' ? build(cash()).root : build(wallet()).root;
}
