import type { MatKey } from '../render/materials';
import type { SignStyle } from '../render/signs';
import type { V3 } from '../render/geometry';
import type { DecorKind } from './decor-models';

export type { V3 };

/**
 * JSON-serializable level description. The procedural generator produces one,
 * and ?level=<url> loads one from a file. Everything is axis-aligned boxes, ramps
 * (boxes with a sloped top) and point/rect markers.
 */
export interface LevelData {
  version: 1;
  name: string;
  boxes: BoxDef[];
  ramps: RampDef[];
  signs: SignDef[];
  lamps: LampDef[];
  spots: SpotDef[];
  paths: PathDef[];
  parked: ParkedCarDef[];
  /** Parking stalls outside the deck (lots): where townsfolk park when they drive in. */
  bays: BayDef[];
  puddles: PuddleDef[];
  ghostZones: ZoneDef[];
  gates: GateDef[];
  clocks: ClockDef[];
  /** Valet stands: talk to a valet by day and he parks your car. */
  valets: ValetDef[];
  /** Iron fence runs; cars knock their panels over. */
  fences: FenceDef[];
  /** Ramp guardrails and wall-top railings; cars knock their panels over too. */
  rails: RailDef[];
  /** Footprints dug out below street level (the deck's basement, its stair shaft): no ground plane at y=0 there. */
  pits: ZoneDef[];
  /** People who hang about for Cody to talk to. */
  npcs: NpcDef[];
  /** Elevators: their shafts are boxes like the rest, these are the cabs that run in them (world/elevators.ts). */
  elevators: ElevatorDef[];
  /** Landscaping and street furniture: trees, hedges, flowers, benches, a fountain, a gazebo, bus shelters. */
  decor: DecorDef[];
  /** Buildings you can walk into: doors, a core, and rooms grown from a seed (world/interiors.ts). */
  buildings: BuildingDef[];
  playerSpawn: V3;
  deck: DeckNav;
}

export interface BoxDef {
  min: V3;
  max: V3;
  mat: MatKey;
  /** Material for the +Y face (roofs). */
  top?: MatKey;
  /** Collides (default true). */
  solid?: boolean;
  /** Slime drips along the top or bottom outer edges. */
  drip?: 'top' | 'bottom';
  /** Monster trucks can smash through it at speed. */
  breakable?: boolean;
  /** Vertex color multiplier, for variation. */
  tint?: number;
  /** Boxes in a facade material: how the facade shader paints them (world/facade-layout.ts). Without one, a wall with FACADE's defaults. */
  facade?: FacadeDef;
}

/**
 * What the facade shader paints on a box: storeys of windows, plain trim
 * (cornices, ledges, balcony slabs), striped awning canvas, or a room's
 * surfaces inside a walk-in (plain paint lit at night like the rooms the
 * windows fake, so a building looks the same when its real rooms appear).
 */
export type FacadeKind = 'wall' | 'trim' | 'awning' | 'room';
/** Window patterns: one window per bay, a band across each storey, two tall lights per bay, or a curtain wall of glass. */
export type WindowStyle = 'punched' | 'ribbon' | 'paired' | 'grid';
/** A ground floor that fronts the street: shop windows with a door, lobby glass with doors in the middle, or windows with a front door. */
export type StreetFront = 'shop' | 'lobby' | 'entry';

/**
 * A building's walls, for a box in a facade material: a ground floor, storeys
 * above it, and a whole number of window bays across each face, so windows
 * line up with its edges and floors. The facade shader draws the windows and
 * the rooms behind them from this; fields left out take FACADE's defaults.
 */
export interface FacadeDef {
  kind: FacadeKind;
  /** Wall color (hex). An awning's stripes alternate it with off-white. */
  paint?: string;
  /** Walls: storey height (m) above the ground floor. */
  storey?: number;
  /** Walls: ground floor height (m) above the box's base. */
  ground?: number;
  /** Walls: the bay width (m) each face aims for. */
  bay?: number;
  windows?: WindowStyle;
  /** Walls: blank wall (m) kept under the top for a cornice; storeys stop below it. */
  cap?: number;
  /** Walls: faces whose ground floor fronts the street, and how. The rest have windows there like the floors above. */
  street?: Partial<Record<Facing, StreetFront>>;
}

/** What a building's ground floor is inside: a shop (or diner), an office lobby, or a home's entrance hall. */
export type BuildingUse = 'shop' | 'diner' | 'lobby' | 'hall';

/**
 * A building you can walk into. Its facade box draws the outside (and doesn't
 * collide); from this the level gets, up front, collision for a shell with real
 * door openings and for the ground floor's rooms, so Cody and walkers can route
 * in. The rooms' meshes are built only while Cody is near (world/interiors.ts),
 * and until then the windows show interior-mapped rooms.
 */
export interface BuildingDef {
  /** The shell: the facade box's footprint, from the ground to the roof. */
  min: V3;
  max: V3;
  /** Its walls' layout, as on its facade box: the ground floor's real openings follow it, so they line up with the painted ones. */
  facade: FacadeDef;
  /** Storeys above the ground floor (not walk-in yet: the core leads up to them). */
  storeys: number;
  use: BuildingUse;
  doors: DoorDef[];
  /** The stair or elevator core up to the floors above: its footprint (x0, z0, x1, z1). Walled off for now (upper floors aren't built). */
  core: { kind: 'stair' | 'elevator'; rect: [number, number, number, number] } | null;
  /** Interior paint (hex): walls of the rooms. */
  paint: string;
  /** The rooms grow from this. */
  seed: number;
}

/** A doorway in a building's ground floor: the side it's on, its centre along the wall (x on z sides, z on x sides), width and height above the floor. */
export interface DoorDef {
  facing: Facing;
  at: number;
  width: number;
  height: number;
}

export interface RampDef {
  min: V3;
  max: V3;
  axis: 'x' | 'z';
  dir: 1 | -1;
  /** Surface height at the low end. The high end is max[1]. Solid fills down to min[1]. */
  low: number;
  mat: MatKey;
  /** Stunt kicker (hazard striped, slime edge). */
  kicker?: boolean;
}

export type Facing = 'x+' | 'x-' | 'z+' | 'z-';

export interface SignDef {
  /** Center of the sign face. */
  pos: V3;
  size: [number, number];
  facing: Facing;
  style: SignStyle;
  lines: string[];
}

export type LampColor = 'green' | 'purple' | 'warm';
export type LampKind = 'street' | 'ceiling' | 'flood';

export interface LampDef {
  pos: V3;
  color: LampColor;
  kind: LampKind;
}

export interface SpotDef {
  id: number;
  center: V3;
  size: [number, number];
  /** Yaw a vehicle should face when parked (0 = +z). */
  yaw: number;
  level: number;
}

export interface PathDef {
  points: V3[];
}

export interface ParkedCarDef {
  pos: V3;
  yaw: number;
}

/** A parking stall: where a car parked in it stands, and the way it faces (either way round will do). */
export interface BayDef {
  pos: V3;
  yaw: number;
}

export interface PuddleDef {
  pos: V3;
  r: number;
}

export interface ZoneDef {
  min: V3;
  max: V3;
}

export interface GateDef {
  kind: 'entry' | 'exit';
  /** Zone in which crossing the deck footprint counts as a badge scan. */
  min: V3;
  max: V3;
  /** Barrier arm hinge, arm extends along `armDir` for `armLength`. */
  hinge: V3;
  armDir: Facing;
  armLength: number;
}

export interface ValetDef {
  /** Where the first valet waits (feet); the rest of the crew lines up along -x. */
  pos: V3;
  /** Yaw the valets face while they wait (0 = +z). */
  yaw: number;
  /** How many valets work the stand (default 2). */
  crew?: number;
}

/** A straight run of iron fence: its footprint box, along its longer horizontal axis, standing on min[1]. */
export interface FenceDef {
  min: V3;
  max: V3;
}

/**
 * A straight run of guardrail (along a ramp edge, rising with it) or railing (along a wall top),
 * from a to b along x or z: the feet of its end posts.
 */
export interface RailDef {
  style: 'guardrail' | 'railing';
  a: V3;
  b: V3;
  /** Horizontal unit vector off the side it guards: a guardrail's beam faces the other way, and a panel knocked loose without a push goes over this way. */
  out: [number, number];
}

export interface ClockDef {
  /** Center of the dial face. */
  pos: V3;
  facing: Facing;
  size: number;
}

/**
 * A piece of landscaping or street furniture, drawn from its model (world/decor-models.ts).
 * Its collision, if it has any, is ordinary solid boxes the generator writes beside it,
 * except for pieces vehicles break (DECOR[kind].hit by kind and size: benches, street trees,
 * hedges, bus shelters), which are props with their own solids.
 */
export interface DecorDef {
  kind: DecorKind;
  /** Its base, on the ground it stands on. */
  pos: V3;
  /** Yaw (0 = facing +z); a piece cars knock over turns in quarter turns only. */
  yaw: number;
  /** Uniform size (default 1). */
  scale?: number;
  /** Stretch along its own x (default 1): a hedge fit to its run. */
  stretch?: number;
}

export interface NpcDef {
  /** Who it is: picks the model and what they say. */
  id: 'randy';
  /** Feet. */
  pos: V3;
  yaw: number;
  /** A fire they keep going in a trash can (its base), if they have one: Randy roasts over it. */
  fire?: V3;
}

/**
 * An elevator: a shaft with a landing door at each stop and a cab that runs
 * between them. world/elevator-shaft.ts writes the shaft's walls and doorways
 * as ordinary boxes and adds one of these; the cab, the doors and the call
 * buttons are built from it at runtime (world/elevators.ts).
 */
export interface ElevatorDef {
  /** The shaft's inside, which is the cab's footprint: from its pit's floor up to the highest stop's headroom. */
  min: V3;
  max: V3;
  /** Width of the landing doors, centered on the side of the shaft a stop faces. */
  door: number;
  /** Lowest first. */
  stops: ElevatorStop[];
  /**
   * In a walk-in building (world/interior-layout.ts): it runs and collides from
   * the start like any other, but its cab and doors are drawn only while the
   * building's rooms are (world/interiors.ts).
   */
  indoors?: boolean;
}

/** A floor an elevator stops at. */
export interface ElevatorStop {
  /** Floor height of the landing, where the cab's floor stands when it's here. */
  y: number;
  /** The side of the shaft its landing door is on. */
  facing: Facing;
  /** What the cab's panel calls it ('BASEMENT', 'LEVEL 3'). */
  label: string;
}

export interface DeckNav {
  min: V3;
  max: V3;
  /** Floor heights from the ground floor up. */
  floors: number[];
}

/** Yaw (rotation about +Y) that turns a +Z-facing plane to the given facing. */
export function facingYaw(f: Facing): number {
  switch (f) {
    case 'z+':
      return 0;
    case 'x+':
      return Math.PI / 2;
    case 'z-':
      return Math.PI;
    case 'x-':
      return -Math.PI / 2;
  }
}

export function emptyLevel(name: string): LevelData {
  return {
    version: 1,
    name,
    boxes: [],
    ramps: [],
    signs: [],
    lamps: [],
    spots: [],
    paths: [],
    parked: [],
    bays: [],
    puddles: [],
    ghostZones: [],
    gates: [],
    clocks: [],
    valets: [],
    fences: [],
    rails: [],
    pits: [],
    npcs: [],
    elevators: [],
    decor: [],
    buildings: [],
    playerSpawn: [0, 0, 0],
    deck: { min: [0, 0, 0], max: [1, 1, 1], floors: [0] },
  };
}

/** Light validation for levels loaded from JSON (Blender exports). */
export function parseLevel(json: unknown): LevelData {
  const d = json as Partial<LevelData>;
  if (!d || d.version !== 1 || !Array.isArray(d.boxes)) throw new Error('not a v1 level file');
  const base = emptyLevel(d.name ?? 'custom');
  return { ...base, ...d } as LevelData;
}
