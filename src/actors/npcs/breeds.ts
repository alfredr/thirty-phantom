import { Vector3 } from 'three';

import { buildRandy, ROAST_LIFT } from '@/actors/models/randy';
import { buildTrashFire, CAN_TOP } from '@/actors/models/trash-fire';
import type { Mind } from '@/engine/sim/mind';
import type { SmokeSpec } from '@/fx/smoke';
import type { Merchant } from '@/game/items/shop';
import type { Exchange } from '@/game/items/trades';
import type { NpcDef } from '@/world/level-data';

import { feedItems, type NpcEvent, type Pitch, proximityPitch, type Work } from './behaviors';
import type { FireSpec } from './fire';
import type { Npc } from './npcs';
import { coatSeller, type NpcModel } from './presentation';
import type { ThrowSpec } from './throwing';

/** Tire release height above Cody’s feet, in meters. */
const HANDS = 1.1;

export interface NpcBreed {
  readonly name: string;
  model(): NpcModel;
  readonly fire?: FireSpec;
  readonly throwing?: ThrowSpec;
  readonly smoke?: SmokeSpec & { active(n: Npc): boolean };
  readonly attention?: { readonly reach: number; readonly level: number };
  pitch?(n: Npc): Mind<Npc, Pitch, NpcEvent>;
  work?(n: Npc): Mind<Npc, Work, NpcEvent>;
  readonly shop?: Merchant;
  readonly trades: readonly Exchange[];
}

/** NPC kinds compose models, behaviors, stock, and exchanges. Factories create state for each instance. */
export const NPC_BREEDS: Readonly<Record<NpcDef['id'], NpcBreed>> = {
  randy: {
    name: 'RANDY',
    model: () => {
      const rig = buildRandy();
      return {
        ...coatSeller(rig, ROAST_LIFT),
        smokeOrigin: rig.pocket,
        props: { burner: rig.phone, badge: rig.badge },
        palm: { burner: rig.palmPhone },
        hands: { leftHand: rig.leftHand, rightHand: rig.rightHand },
      };
    },
    smoke: {
      every: 0.16,
      life: 1.8,
      size: [0.12, 0.65],
      rise: 0.65,
      scatter: 0.18,
      color: 0xaaa2b0,
      alpha: 0.6,
      active: (n) => !!n.stock?.slotOf('moltenKeys'),
    },
    fire: { model: buildTrashFire, rim: CAN_TOP },
    throwing: { windup: 0.45, flight: 0.8, speed: 14, arc: 0.8, arcPerMeter: 0.15 },
    attention: { reach: 5, level: 2 },
    pitch: proximityPitch({ rest: 4, hold: 3.5 }),
    work: feedItems({
      every: 0.35,
      after: 0.5,
      launch: (n, from) => n.fire?.feed('tire', from),
      finished: (n, reward) => n.world.fed(reward),
    }),
    shop: {
      title: "RANDY'S WARES",
      stock: [
        { kind: 'burner', count: 1 },
        ...Array.from({ length: 5 }, () => ({ kind: 'brisket' as const, count: 128 })),
      ],
      reach: 2.8,
      level: 2,
      offered: (n) => !!n.fire && !!n.pitch?.in('pitching'),
      browsing: (n) => !!n.pitch?.in('browsing'),
      open: (n) => {
        n.send({ type: 'browse' });
      },
      close: (n) => {
        n.send({ type: 'browseEnded' });
      },
    },
    trades: [
      {
        take: 'tire',
        give: { kind: 'brisket', perItem: 1 },
        reach: 2.4,
        level: 2,
        offered: (n) => !!n.fire,
        ready: (n) => !!n.work?.in('idle'),
        start: (n, from, count, reward) => {
          n.send({ type: 'given', n: count, reward, from: new Vector3(from.x, from.y + HANDS, from.z) });
        },
      },
    ],
  },
};
