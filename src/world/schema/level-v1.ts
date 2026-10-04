import Type, { type TProperties, type TSchema } from 'typebox';

import { DECOR_KINDS, MAT_KEYS, SIGN_STYLES } from '../level-kinds.ts';

// These schemas run in build tooling. Only their inferred types and generated validators reach the game.
const object = <P extends TProperties>(properties: P) => Type.Object(properties, { additionalProperties: false });
const collection = <T extends TSchema>(item: T) => Type.Optional(Type.Array(item, { default: [] }));
const number = Type.Number();
const positive = Type.Number({ exclusiveMinimum: 0 });
const nonnegative = Type.Number({ minimum: 0 });
const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const material = Type.Enum(MAT_KEYS);

export const V3Schema = Type.Tuple([number, number, number]);
export const FacingSchema = Type.Enum(['x+', 'x-', 'z+', 'z-']);
export const FacadeKindSchema = Type.Enum(['wall', 'trim', 'awning', 'room']);
export const WindowStyleSchema = Type.Enum(['punched', 'ribbon', 'paired', 'grid']);
export const StreetFrontSchema = Type.Enum(['shop', 'lobby', 'entry']);
export const BuildingUseSchema = Type.Enum(['shop', 'diner', 'lobby', 'hall']);
export const LampColorSchema = Type.Enum(['green', 'purple', 'warm']);
export const LampKindSchema = Type.Enum(['street', 'ceiling', 'flood']);

/** Facade dimensions are in meters. A zero ground height omits the storefront band. */
export const FacadeDefSchema = object({
  kind: FacadeKindSchema,
  paint: Type.Optional(Type.String()),
  storey: Type.Optional(positive),
  ground: Type.Optional(nonnegative),
  bay: Type.Optional(positive),
  windows: Type.Optional(WindowStyleSchema),
  cap: Type.Optional(nonnegative),
  street: Type.Optional(
    object({
      'x+': Type.Optional(StreetFrontSchema),
      'x-': Type.Optional(StreetFrontSchema),
      'z+': Type.Optional(StreetFrontSchema),
      'z-': Type.Optional(StreetFrontSchema),
    }),
  ),
});

const bounds = { min: V3Schema, max: V3Schema };
// Positions are at the feet/base; yaw is radians, with zero facing +Z.
const placed = { pos: V3Schema, yaw: number };

export const BoxDefSchema = object({
  ...bounds,
  mat: material,
  /** Material for the top face. */
  top: Type.Optional(material),
  /** Collides unless false. */
  solid: Type.Optional(Type.Boolean()),
  drip: Type.Optional(Type.Enum(['top', 'bottom'])),
  breakable: Type.Optional(Type.Boolean()),
  tint: Type.Optional(nonnegative),
  facade: Type.Optional(FacadeDefSchema),
});

export const DoorDefSchema = object({
  facing: FacingSchema,
  /** Door centre along the wall: X on Z-facing walls, Z on X-facing walls. */
  at: number,
  width: positive,
  height: positive,
});

export const BuildingDefSchema = object({
  ...bounds,
  facade: FacadeDefSchema,
  /** Storeys above ground; elevator access is capped by INTERIOR.liftStoreys. */
  storeys: integer,
  use: BuildingUseSchema,
  doors: Type.Array(DoorDefSchema),
  /** Footprint (x0, z0, x1, z1). Stair cores are closed placeholders. */
  core: Type.Union([
    Type.Null(),
    object({
      kind: Type.Enum(['stair', 'elevator']),
      rect: Type.Tuple([number, number, number, number]),
    }),
  ]),
  paint: Type.String(),
  seed: number,
});

export const RampDefSchema = object({
  ...bounds,
  axis: Type.Enum(['x', 'z']),
  dir: Type.Enum([1, -1]),
  /** Low-end surface height; the high end is max[1]. */
  low: number,
  mat: material,
  kicker: Type.Optional(Type.Boolean()),
});

export const SignDefSchema = object({
  pos: V3Schema,
  size: Type.Tuple([positive, positive]),
  facing: FacingSchema,
  style: Type.Enum(SIGN_STYLES),
  lines: Type.Array(Type.String()),
});
export const LampDefSchema = object({ pos: V3Schema, color: LampColorSchema, kind: LampKindSchema });
export const SpotDefSchema = object({
  /** IDs and floor indices start at zero. IDs must match array positions. */
  id: integer,
  center: V3Schema,
  size: Type.Tuple([positive, positive]),
  yaw: number,
  level: integer,
});
export const PathDefSchema = object({ points: Type.Array(V3Schema, { minItems: 2 }) });
export const ParkedCarDefSchema = object(placed);
/** Parking stalls outside the deck, used by visitors. */
export const BayDefSchema = object(placed);
export const PuddleDefSchema = object({ pos: V3Schema, r: positive });
export const ZoneDefSchema = object(bounds);
export const GateDefSchema = object({
  ...bounds,
  kind: Type.Enum(['entry', 'exit']),
  hinge: V3Schema,
  armDir: FacingSchema,
  armLength: positive,
});
export const ValetDefSchema = object({ ...placed, crew: Type.Optional(integer) });
export const FenceDefSchema = object(bounds);
export const RailDefSchema = object({
  style: Type.Enum(['guardrail', 'railing']),
  a: V3Schema,
  b: V3Schema,
  /** Horizontal unit vector off the guarded side. */
  out: Type.Tuple([number, number]),
});
export const ClockDefSchema = object({ pos: V3Schema, facing: FacingSchema, size: positive });
export const DecorDefSchema = object({
  ...placed,
  kind: Type.Enum(DECOR_KINDS),
  /** Uniform size and local X stretch; both default to 1 at runtime. */
  scale: Type.Optional(positive),
  stretch: Type.Optional(positive),
});
export const NpcDefSchema = object({ ...placed, id: Type.Literal('randy'), fire: Type.Optional(V3Schema) });
export const ElevatorStopSchema = object({ y: number, facing: FacingSchema, label: Type.String() });
export const ElevatorDefSchema = object({
  /** Shaft interior, from pit floor to the top stop's headroom. */
  ...bounds,
  door: positive,
  /** Stops are ordered from lowest to highest. */
  stops: Type.Array(ElevatorStopSchema, { minItems: 1 }),
  /** Indoor cabins and doors are drawn only while the building is visible. */
  indoors: Type.Optional(Type.Boolean()),
});
export const DeckNavSchema = object({ ...bounds, floors: Type.Array(number, { minItems: 1 }) });

/** Version 1 input. Collections may be omitted; geometry, spawn, and deck bounds are required. */
export const LevelV1Schema = Type.Object(
  {
    version: Type.Literal(1),
    name: Type.Optional(Type.String({ default: 'custom' })),
    boxes: Type.Array(BoxDefSchema),
    playerSpawn: V3Schema,
    deck: DeckNavSchema,
    ramps: collection(RampDefSchema),
    signs: collection(SignDefSchema),
    lamps: collection(LampDefSchema),
    spots: collection(SpotDefSchema),
    paths: collection(PathDefSchema),
    parked: collection(ParkedCarDefSchema),
    bays: collection(BayDefSchema),
    puddles: collection(PuddleDefSchema),
    ghostZones: collection(ZoneDefSchema),
    gates: collection(GateDefSchema),
    clocks: collection(ClockDefSchema),
    valets: collection(ValetDefSchema),
    fences: collection(FenceDefSchema),
    rails: collection(RailDefSchema),
    pits: collection(ZoneDefSchema),
    npcs: collection(NpcDefSchema),
    elevators: collection(ElevatorDefSchema),
    decor: collection(DecorDefSchema),
    buildings: collection(BuildingDefSchema),
  },
  { $id: 'urn:30pc:level:v1', $schema: 'http://json-schema.org/draft-07/schema#', additionalProperties: false },
);

export type LevelFileV1 = Type.Static<typeof LevelV1Schema>;
/** Runtime form after the validator fills the schema's top-level defaults. */
export type LevelData = Required<LevelFileV1>;
export type V3 = Type.Static<typeof V3Schema>;
export type Facing = Type.Static<typeof FacingSchema>;
export type FacadeKind = Type.Static<typeof FacadeKindSchema>;
export type WindowStyle = Type.Static<typeof WindowStyleSchema>;
export type StreetFront = Type.Static<typeof StreetFrontSchema>;
export type BuildingUse = Type.Static<typeof BuildingUseSchema>;
export type LampColor = Type.Static<typeof LampColorSchema>;
export type LampKind = Type.Static<typeof LampKindSchema>;
export type FacadeDef = Type.Static<typeof FacadeDefSchema>;
export type BoxDef = Type.Static<typeof BoxDefSchema>;
export type BuildingDef = Type.Static<typeof BuildingDefSchema>;
export type DoorDef = Type.Static<typeof DoorDefSchema>;
export type RampDef = Type.Static<typeof RampDefSchema>;
export type SignDef = Type.Static<typeof SignDefSchema>;
export type LampDef = Type.Static<typeof LampDefSchema>;
export type SpotDef = Type.Static<typeof SpotDefSchema>;
export type PathDef = Type.Static<typeof PathDefSchema>;
export type ParkedCarDef = Type.Static<typeof ParkedCarDefSchema>;
export type BayDef = Type.Static<typeof BayDefSchema>;
export type PuddleDef = Type.Static<typeof PuddleDefSchema>;
export type ZoneDef = Type.Static<typeof ZoneDefSchema>;
export type GateDef = Type.Static<typeof GateDefSchema>;
export type ValetDef = Type.Static<typeof ValetDefSchema>;
export type FenceDef = Type.Static<typeof FenceDefSchema>;
export type RailDef = Type.Static<typeof RailDefSchema>;
export type ClockDef = Type.Static<typeof ClockDefSchema>;
export type DecorDef = Type.Static<typeof DecorDefSchema>;
export type NpcDef = Type.Static<typeof NpcDefSchema>;
export type ElevatorDef = Type.Static<typeof ElevatorDefSchema>;
export type ElevatorStop = Type.Static<typeof ElevatorStopSchema>;
export type DeckNav = Type.Static<typeof DeckNavSchema>;
