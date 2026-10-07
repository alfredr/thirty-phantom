import { Vector3 } from 'three';

import type { Player } from '@/actors/player';
import { VEHICLE_BREEDS } from '@/actors/vehicles/breeds';
import type { Vehicle } from '@/actors/vehicles/vehicle';
import { TUNING } from '@/config';
import type { Focus } from '@/engine/input/input';
import { helpRows, Hud, type DashState } from '@/ui/hud';
import type { InvItem } from '@/ui/inventory';
import {
  Help,
  MapApp,
  type PhantomReport,
  Phantoms,
  Photos,
  Tasks,
} from '@/ui/phone/apps';
import { Calls } from '@/ui/phone/calls';
import { Messages } from '@/ui/phone/messages';
import { Phone } from '@/ui/phone/phone';
import type { Wares } from '@/ui/wares';
import type { LevelData } from '@/world/level-data';

import type { CodyRide } from './cody/cody-ride';
import type { CodyState } from './cody/cody-state';
import type { GhostFuel } from './cody/ghost-fuel';
import type { Control } from './controls';
import { type Garage, spotLabel } from './deck/garage';
import type { GameCamera } from './game-camera';
import { GameClock } from './game-clock';
import type { GameEvents } from './game-events';
import type { Money } from './items/money';
import type { Said } from './story/conversation';
import type { Objectives } from './story/objectives';

type UiState = {
  clock: GameClock;
  garage: Garage;
  vehicles: readonly Vehicle[];
  objectives: Objectives;
  player: Player;
  cody: CodyState;
  ride: CodyRide;
  fuel: GhostFuel;
  money: Money;
  camera: GameCamera;
  playing(): boolean;
  inventory(): readonly InvItem[];
  wares(): Wares | null;
  resetOffered(): boolean;
  project(at: Vector3): { x: number; y: number } | null;
};

type UiActions = {
  start(): void;
  item(kind: string, action: string): void;
  buy(slot: string, count: number): void;
  buzz(what: GameEvents['phone']): void;
  quiet(): boolean;
};

/** Read live game state for the HUD, phone apps, and world markers. */
export class GameUi {
  readonly hud: Hud;
  readonly phone: Phone;
  private readonly up = new Vector3();

  constructor(
    container: HTMLElement,
    focus: Focus<Control>,
    level: LevelData,
    private readonly state: UiState,
    actions: UiActions,
  ) {
    const { clock, garage, vehicles, objectives, ride, cody, fuel } = state;
    this.hud = new Hud(container, focus);
    this.hud.bind({
      mode: () =>
        !state.playing()
          ? 'title'
          : ride.driving || ride.transform
            ? 'drive'
            : 'foot',
      summon: () => state.playing() && ride.onFoot && cody.can('summon'),
      hours: () => clock.hours,
      phase: () => clock.phase,
      day: () => clock.day,
      cash: () => state.money.cash,
      inventory: () => state.inventory(),
      wares: () => state.wares(),
      ledger: () => ({
        logged: garage.logged,
        actual: garage.actual(vehicles),
        phantom: garage.phantomOccupancy(vehicles),
        max: TUNING.garage.spots,
      }),
      dash: () => this.dashboard(),
      ghast: () =>
        ride.driving?.breed.boost
          ? { fill: fuel.fill, burning: fuel.burning }
          : null,
      reset: () => state.resetOffered(),
    });
    this.phone = new Phone(
      this.hud.root,
      focus,
      {
        time: () => GameClock.format(clock.hours),
        goal: () => objectives.goal,
        how: () => objectives.how,
        now: () => ({ hours: clock.hours, day: clock.day }),
      },
      new Messages(),
      new Calls(),
      [
        new Tasks({
          goal: () => objectives.goal,
          how: () => objectives.how,
          aim: () => `FILL ALL ${TUNING.garage.spots} SPOTS WITH PHANTOMS.`,
          marks: () => objectives.list,
        }),
        new Phantoms(() => this.phantomReport()),
        new MapApp(),
        new Photos(),
        new Help(helpRows),
      ],
    );
    this.phone.onBuzz = (what) => actions.buzz(what);
    this.phone.quiet = () => actions.quiet();
    this.hud.initMap(level);
    this.hud.onStart(() => actions.start());
    this.hud.onItemAction = (kind, id) => actions.item(kind, id);
    this.hud.onBuy = (slot, n) => actions.buy(slot, n);
    this.hud.setCamera(state.camera.controls.view);
  }

  private dashboard(): DashState | null {
    const { ride } = this.state;
    const v = ride.driving;
    if (v) {
      return {
        speed: v.speed,
        form: v.form,
        label: v.breed.label,
        airborne: !v.grounded && !v.crashing,
      };
    }

    return ride.transform
      ? {
          speed: 0,
          form: 'truck',
          label: VEHICLE_BREEDS.truck.label,
          airborne: false,
        }
      : null;
  }

  private phantomReport(): PhantomReport {
    const { garage, vehicles } = this.state;
    return {
      onBoard: garage.phantomOccupancy(vehicles),
      spots: TUNING.garage.spots,
      escapes: garage.phantoms,
      logged: garage.logged,
      inDeck: garage.actual(vehicles),
      where: garage.spots.filter((s) => s.phantom).map(spotLabel),
    };
  }

  showBubble(said: Said | null): void {
    const head = said && this.state.project(said.at);
    this.hud.setBubble(
      said && head
        ? { ...head, who: said.who, line: said.line, choices: said.choices }
        : null,
    );
  }

  /** Cutscenes hide world markers while retaining map markers. */
  updateObjectives(): void {
    const { ride, player, objectives, camera } = this.state;
    const me = ride.vehicle ?? player;
    const list = objectives.list;
    this.hud.setObjectives(
      camera.shots.top ? [] : list,
      camera.view.camera,
      (p) => this.state.project(p),
      me.pos,
    );
    const up = camera.view.screenUp(this.up);
    this.hud.setMap(
      {
        x: me.pos.x,
        z: me.pos.z,
        yaw: me.yaw,
        upX: up.x,
        upZ: up.z,
        driving: ride.vehicle !== null,
        marks: [...list, ...objectives.pins].map((o) => ({
          x: o.at.x,
          z: o.at.z,
          kind: o.kind,
          color: o.color,
        })),
      },
      this.phone.showing('map') ? this.phone.body('map') : null,
    );
  }
}
