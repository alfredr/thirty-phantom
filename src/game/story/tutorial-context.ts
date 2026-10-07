import type { Vector3 } from 'three';

import type { Npc } from '@/actors/npcs/npcs';
import type { Vehicle } from '@/actors/vehicles/vehicle';
import type { MindEvent } from '@/engine/sim/mind';
import type { CamView } from '@/game/camera-controller';
import type { Crossing, SpotRuntime } from '@/game/deck/garage';
import type { Pose } from '@/game/driving/reset';
import type { Game } from '@/game/game';
import type { Signpost } from '@/ui/signpost';
import type { LevelData, RampDef } from '@/world/level-data';

import type { RoofScene } from './roof-scene';
import type { Access } from './story-access';
import type { StoryCamera } from './story-camera';
import type { StoryClock } from './story-clock';
import type { Goals } from './story-goals';
import type { Outreach } from './story-outreach';
import type { Recovery } from './story-recovery';

export interface RoofStage {
  readonly spot: SpotRuntime;
  readonly truck: Vector3;
  readonly yaw: number;
  readonly turn: 'LEFT' | 'RIGHT';
  readonly randy: Vector3;
  readonly randyYaw: number;
  readonly window: Vector3;
  readonly toss: Vector3;
  readonly ramp: RampDef;
  readonly start: Pose;
  readonly lip: Vector3;
  readonly roof: number;
}

export interface Imprint {
  readonly at: Vector3;
  readonly title: string;
  readonly meta: string;
}

export interface TutorialProgress {
  firstPhantom: Imprint | null;
  noticedSmell: boolean;
  readonly viewsSeen: Set<CamView>;
}

export interface TutorialContext {
  readonly game: Game;
  readonly level: LevelData;
  readonly clock: StoryClock;
  readonly goals: Goals;
  readonly outreach: Outreach;
  readonly access: Access;
  readonly recovery: Recovery;
  send(e: TutorialEvent): void;
  readonly camera: StoryCamera;
  readonly sign: Signpost;
  readonly progress: TutorialProgress;
  readonly roofScene: RoofScene;
  readonly pickup: Vehicle;
  readonly randy: Npc;
  readonly stage: RoofStage;
  readonly touch: boolean;
  startErrand(): void;
  rememberFirstNight(): void;
  announcePhantomCody(): void;
  showDayPresentation(): void;
}

export type TutorialEvent =
  | MindEvent<'entered', { v: Vehicle; possessed: boolean }>
  | MindEvent<'exited', { spot: SpotRuntime | null }>
  | MindEvent<'crossing', { crossing: Crossing }>
  | MindEvent<'swallowed'>
  | MindEvent<'boosted'>
  | MindEvent<'summoned'>
  | MindEvent<'spooked'>
  | MindEvent<'phantom', { imprint: Imprint }>
  | MindEvent<'hotwired', { v: Vehicle }>
  | MindEvent<'nightfall'>
  | MindEvent<'sunrise'>
  | MindEvent<'talk', { tires: number }>;
