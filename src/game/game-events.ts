import type { Vector3 } from 'three';

import type { Vehicle } from '@/actors/vehicles/vehicle';

import type { CamMode } from './camera-controller';
import type { CodyAction } from './cody/cody-actions';
import type { RideEvents } from './cody/cody-ride';
import type { Crossing, SpotRuntime } from './deck/garage';
import type { ImpactEvents } from './driving/impacts';
import type { Phase } from './game-clock';
import type { ItemDeed } from './story/triggers';

/** Events shared by gameplay, tutorial, audio, and visual effects. */
export type GameEvents = RideEvents &
  ImpactEvents & {
    keysFound: { plate: string };
    start: null;
    /**
     * The play update completed; payload is elapsed seconds. Shared simulation
     * and rendering follow afterward.
     */
    frame: number;
    /**
     * Report a new traffic-driver fright response to phantom Cody or the
     * truck.
     */
    spooked: { car: Vehicle };
    /**
     * Report an inventory deed. Use game.triggers for accumulated item
     * milestones.
     */
    item: ItemDeed;
    /** Report a player-selected camera mode. */
    camera: CamMode;
    /**
     * Report collected ghosts, the resulting normalized GhASt fill, and the
     * world-space intake position.
     */
    swallowed: { n: number; tank: number; at: Vector3 };
    /** Report the start of GhASt burning. */
    boosted: null;
    /** Emitted after a successful summon, with the number of skeletons raised. */
    summoned: { n: number };
    /**
     * Report a new phantom imprint after an unlogged exit, including
     * placement, optional home spot, total count, and game time.
     */
    phantom: {
      at: Vector3;
      yaw: number;
      spot: SpotRuntime | null;
      n: number;
      hours: number;
      day: number;
    };
    /**
     * Report a horn event with a copied car position and normalized impatience
     * for audio and visual intensity.
     */
    honk: { car: Vehicle; at: Vector3; anger: number };
    /** Report a tire entering Randy’s fire. */
    stoked: { at: Vector3 };
    sfx: { name: ScriptSound; at: Vector3 };
    /** Request smoke at a character’s ground position through game.puff. */
    puff: { at: Vector3 };
    /** Report collected cash, wallet contents, or glovebox money in dollars. */
    money: { kind: 'cash' | 'wallet' | 'glovebox'; amount: number };
    /**
     * Report the start of Cody’s form-change effect with the target phase and
     * position.
     */
    outfit: { form: Phase; at: Vector3 };
    /**
     * Report a new pedestrian fright response, including a driver leaving a
     * vehicle.
     */
    fright: { at: Vector3 };
    /** Phone notification events for ringing, hangup, and incoming text. */
    phone: 'ring' | 'hangup' | 'text';
    crossing: Crossing;
    nightfall: null;
    sunrise: null;
    /** Report a quest transition; the tutorial uses the tutorial quest ID. */
    step: { quest: string; step: string };
    /** Report a performed Cody action to interested systems. */
    performed: { action: CodyAction };
    /** Report an action failure and its reason. */
    failed: { action: CodyAction; reason: string };
    reset: { v: Vehicle };
  };

type ScriptSound =
  | 'keys-clink'
  | 'gas-glug'
  | 'fire-flare'
  | 'engine-cough'
  | 'engine-roar';
