import { npcScenes, player } from './npc-scene';

export type RoofPoint =
  | 'handoff'
  | 'keys'
  | 'gasCan'
  | 'bastingCan'
  | 'fillStand'
  | 'fill'
  | 'home'
  | 'fire';
export type RoofAction =
  | 'takeBadge'
  | 'skipBadge'
  | 'holdKeys'
  | 'pocketKeys'
  | 'holdGasCan'
  | 'holdBastingCan'
  | 'pourFuel'
  | 'basteFire'
  | 'markPoured'
  | 'flare'
  | 'dropBastingCan';

export const roof = npcScenes<'randy', RoofPoint, never, RoofAction>();

export type RoofDefinition = Parameters<typeof roof.play>[0];

const STAND_OFF = 0.55;
const GRIP_BEND = 0.5;
const LIFT_BEND = 0.4;

const directRandy = (
  body: RoofDefinition,
  fallback: RoofDefinition,
): RoofDefinition =>
  roof.holding([roof.attention('randy', player)], roof.orElse(body, fallback));

const fetch = (
  point: 'gasCan' | 'bastingCan',
  hold: 'holdGasCan' | 'holdBastingCan',
) =>
  roof.sequence([
    roof.walkTo('randy', point, {
      arrive: STAND_OFF,
      face: roof.point(point),
    }),
    roof.gesture('randy', 'bend', GRIP_BEND),
    roof.custom(hold),
    roof.gesture('randy', 'bend', LIFT_BEND),
  ]);

export const BADGE_HANDOFF = directRandy(
  roof.sequence([
    roof.walkTo('randy', 'handoff', { face: player }),
    roof.custom('takeBadge'),
  ]),
  roof.custom('skipBadge'),
);

export const KEY_PICKUP = directRandy(
  roof.sequence([
    roof.walkTo('randy', 'keys', {
      arrive: STAND_OFF,
      face: roof.point('keys'),
    }),
    roof.gesture('randy', 'bend', 0.55),
    roof.custom('holdKeys'),
    roof.gesture('randy', 'bend', 0.45),
    roof.wait(0.15),
    roof.custom('pocketKeys'),
    roof.face('randy', player),
    roof.wait(0.2),
  ]),
  roof.custom('pocketKeys'),
);

export const POUR_GAS = directRandy(
  roof.sequence([
    fetch('gasCan', 'holdGasCan'),
    roof.walkTo('randy', 'fillStand', { face: roof.point('fill') }),
    roof.face('randy', roof.point('fill')),
    roof.custom('pourFuel'),
    roof.custom('markPoured'),
  ]),
  roof.custom('markPoured'),
);

export const BASTE_FIRE = directRandy(
  roof.sequence([
    fetch('bastingCan', 'holdBastingCan'),
    roof.walkTo('randy', 'home', { face: roof.point('fire') }),
    roof.face('randy', roof.point('fire')),
    roof.custom('basteFire'),
    roof.custom('flare'),
    roof.custom('dropBastingCan'),
    roof.wait(2.2),
  ]),
  roof.sequence([roof.custom('flare'), roof.custom('dropBastingCan')]),
);
