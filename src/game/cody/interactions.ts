import type { Vector3 } from 'three';

import type { Player } from '@/actors/player';
import type { Vehicle } from '@/actors/vehicle';
import { TUNING } from '@/config';
import type { Input } from '@/engine/input/input';
import { Doing, resolveFully } from '@/engine/sim/action';
import { bestOffers } from '@/engine/sim/offers';
import type { Control } from '@/game/controls';
import type { Inventory, ItemActionId } from '@/game/items/inventory';
import { ITEM_BREEDS, type ItemKind, isItemKind } from '@/game/items/item-breeds';
import { NPC_NAMES, type Npc } from '@/game/randy/npcs';
import type { RandyTalk } from '@/game/randy/talk';
import type { ValetService } from '@/game/valets/valet';
import type { InvItem } from '@/ui/inventory';
import type { Elevators } from '@/world/elevators';

import {
  CallElevator,
  type CodyAction,
  type CodyCandidate,
  Eat,
  GetOut,
  GiveTires,
  InteractWithVehicle,
  PickFloor,
  type Play,
  RANK,
  RockOver,
  Summon,
  TalkToRandy,
  TalkToValet,
} from './cody-actions';

/** Maximum vertical distance to a vehicle Cody could enter, in meters. */
const ENTER_HEIGHT = 1.8;
const PROMPT_CONTROLS: readonly Control[] = ['hop', 'interact', 'pay'];
const ACT_CONTROLS: readonly Control[] = ['interact', 'pay', 'summon', 'hop'];

/** Sources of nearby interaction candidates; Play supplies action rules and effects. */
interface InteractionWorld {
  readonly player: Pick<Player, 'pos'>;
  readonly vehicles: readonly Vehicle[];
  readonly valet: Pick<ValetService, 'talkable'>;
  readonly randyTalk: Pick<RandyTalk, 'talkable'>;
  readonly elevators: Pick<Elevators, 'cabAt' | 'landingAt'>;
  playing(): boolean;
  blocked(): boolean;
}

interface InteractionView {
  prompt(text: string | null, control?: Control): void;
  refused(reason: string): void;
  performed(action: CodyAction): void;
  failed(action: CodyAction, reason: string): void;
}

/** Discovers, resolves and performs Cody's keyboard and inventory actions. */
export class Interactions {
  private readonly offerSources = new Set<() => CodyAction | null>();
  private readonly doing: Doing<Play, Play>;

  constructor(
    private readonly play: Play,
    private readonly world: InteractionWorld,
    private readonly input: Pick<Input<Control>, 'focus' | 'wasPressed'>,
    private readonly view: InteractionView,
  ) {
    this.doing = new Doing({
      lost: () => false,
      end: () => undefined,
      performed: (action) => view.performed(action),
      failed: (action, reason) => {
        if (reason) {
          view.refused(reason);
        }

        view.failed(action, reason);
      },
    });
  }

  addOffer(source: () => CodyAction | null): () => void {
    this.offerSources.add(source);
    return () => this.offerSources.delete(source);
  }

  /** Resolve item actions at selection time because targets may have moved since the menu was rendered. */
  useItem(kind: string, id: string): void {
    if (!isItemKind(kind)) {
      return;
    }

    const offer = this.itemOffers(kind).find((o) => o.id === id);
    if (offer) {
      this.doing.do(this.play, offer.action);
    }
  }

  giveTires(to: Npc): boolean {
    return 'done' in this.doing.do(this.play, new GiveTires({ to, name: NPC_NAMES[to.def.id] }));
  }

  inventoryView(inventory: Inventory): InvItem[] {
    return inventory.list().map(([kind, count]) => ({
      kind,
      name: ITEM_BREEDS[kind].name,
      icon: ITEM_BREEDS[kind].icon,
      note: ITEM_BREEDS[kind].note,
      count,
      actions: this.itemOffers(kind).map(({ id, label }) => ({ id, label })),
    }));
  }

  /**
   * Resolve one offer per control, update prompts, and perform pressed actions. Show a refusal when resolution fails.
   * Focus layers consume their controls before this update.
   */
  update(): void {
    const { offers, refusals } = bestOffers(this.play, this.candidates());
    // Hide prompts for controls currently owned by a focus layer.
    const shown = PROMPT_CONTROLS.flatMap((control) => {
      const offer = offers.get(control);
      return offer?.label && !this.input.focus.owns(control) ? [offer] : [];
    });
    const [first] = shown;
    this.view.prompt(
      first ? shown.map(({ control, label }) => `{${control}} ${label}`).join(' &nbsp;') : null,
      first?.control,
    );

    for (const control of ACT_CONTROLS) {
      if (!this.input.wasPressed(control)) {
        continue;
      }

      const offer = offers.get(control);
      const reason = refusals.get(control);
      if (offer) {
        this.doing.do(this.play, offer.action);
      } else if (reason) {
        this.view.refused(reason);
      }
    }
  }

  /** Collect candidates for the current context. Order vehicle candidates by distance before resolution. */
  private candidates(): CodyCandidate[] {
    if (this.world.blocked()) {
      return [];
    }

    const out: CodyCandidate[] = [];
    const v = this.play.ride();
    if (v) {
      const { handOverSpeed, talkReach } = TUNING.valet;
      const valet =
        v.form === 'car' && v.grounded && Math.abs(v.speed) < handOverSpeed
          ? this.world.valet.talkable(v.pos, talkReach.car, this.play.conditions.valetsOnShift())
          : null;
      if (valet) {
        out.push({ control: 'interact', rank: RANK.valet, action: new TalkToValet({ valet }) });
      }

      out.push({ control: 'interact', rank: RANK.getOut, action: new GetOut({ car: v }) });

      if (v.crashing && v.resting) {
        out.push({ control: 'hop', rank: RANK.getOut, action: new RockOver() });
      }

      return out;
    }

    const p = this.world.player.pos;
    for (const source of this.offerSources) {
      const action = source();
      if (action) {
        out.push({ control: 'interact', rank: RANK.script, action });
      }
    }

    const valet = this.world.valet.talkable(p, TUNING.valet.talkReach.foot, this.play.conditions.valetsOnShift());
    if (valet) {
      out.push({ control: 'interact', rank: RANK.valet, action: new TalkToValet({ valet }) });
    }

    const randy = this.world.randyTalk.talkable(p);
    if (randy) {
      out.push({ control: 'interact', rank: RANK.randy, action: new TalkToRandy({ randy }) });
    }

    const cab = this.world.elevators.cabAt(p);
    const landing = cab ? null : this.world.elevators.landingAt(p, TUNING.elevator.callReach);
    if (cab) {
      out.push({ control: 'interact', rank: RANK.elevator, action: new PickFloor({ cab, dir: 1 }) });
      out.push({ control: 'pay', rank: RANK.elevator, action: new PickFloor({ cab, dir: -1 }) });
    } else if (landing && !landing.elevator.openAt(landing.stop)) {
      out.push({
        control: 'interact',
        rank: RANK.elevator,
        action: new CallElevator({ elevator: landing.elevator, stop: landing.stop }),
      });
    }

    for (const car of this.vehiclesInReach(p)) {
      out.push({ control: 'interact', rank: RANK.vehicle, action: new InteractWithVehicle({ car }) });
    }

    out.push({ control: 'summon', rank: 0, action: new Summon() });
    return out;
  }

  /** Return nearby, available vehicles in distance order for action resolution. */
  private vehiclesInReach(p: Vector3): Vehicle[] {
    const near = this.world.vehicles.filter(
      (v) =>
        v.role !== 'player' &&
        !v.status &&
        Math.abs(v.pos.y - p.y) < ENTER_HEIGHT &&
        v.pos.distanceTo(p) < v.breed.enterReach,
    );
    return near.sort((a, b) => a.pos.distanceTo(p) - b.pos.distanceTo(p));
  }

  /** Resolve supported inventory actions and omit any that currently fail. */
  private itemOffers(kind: ItemKind): { id: ItemActionId; action: CodyAction; label: string }[] {
    const candidates: [ItemActionId, CodyAction][] = [];
    if (kind === 'brisket') {
      candidates.push(['eat', new Eat()]);
    }

    const taker = kind === 'tire' && this.world.playing() ? this.play.tireTaker() : null;
    if (taker) {
      candidates.push(['give', new GiveTires({ to: taker, name: NPC_NAMES[taker.def.id] })]);
    }

    return candidates.flatMap(([id, action]) => {
      const resolved = resolveFully(this.play, action);
      return 'fail' in resolved ? [] : [{ id, action: resolved, label: resolved.label(this.play) }];
    });
  }
}
