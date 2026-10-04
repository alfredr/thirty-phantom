import type { Camera, Vector3 } from 'three';
import type { CarKind, VehicleForm } from '../actors/vehicle';
import { type Action, type Focus, isAction, keyName } from '../core/input';
import { SOUND_ON } from '../audio/flags';
import { urlFlag } from '../core/url-flags';
import type { CamMode, CamView } from '../game/game';
import { GameClock, type Phase } from '../game/game-clock';
import type { Objective } from '../game/objectives';
import type { LevelData } from '../world/level-data';
import { ClockFace } from './clock-face';
import { el } from './dom';
import { type InvItem, InventoryStrip } from './inventory';
import { OccupancySign } from './occupancy-sign';
import { GhastDial } from './ghast-dial';
import { type MapView, Minimap } from './minimap';
import { ObjectiveMarks } from './objective-marks';
import { SpeedGauge } from './speed-gauge';
import { touchGlyph } from './touch-controls';
import { type Wares, WaresPanel } from './wares';
import './hud.css';

/**
 * Key caps for actions, labelled for the device in use when drawn: the key on a keyboard, the
 * on-screen button on a touch screen, or TAP where touch has no button. Each cap carries its
 * action, so on touch tapping it does that action (touch-controls.ts).
 */
export const kbd = (...actions: Action[]): string => actions.map((a) => `<kbd data-action="${a}">${capLabel(a)}</kbd>`).join('');

function capLabel(a: Action): string {
  if (!document.body.classList.contains('touch')) return keyName(a);
  return touchGlyph(a) ?? 'TAP';
}

/** `text` with each `{action}` in it, e.g. `{hop} ROCK IT OVER`, replaced by that action's key cap. */
export function keyText(text: string): string {
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (isAction(name) ? kbd(name) : m));
}

const HELP: [keys: string, what: string][] = [
  [kbd('forward', 'left', 'back', 'right'), 'walk'],
  [kbd('interact'), 'steal / get in / talk'],
  [kbd('pay'), 'tip the valet'],
  [kbd('inventory'), 'items: eat, use'],
  [`${kbd('interact')} ${kbd('pay')}`, 'elevator: call, floor up / down'],
  [kbd('summon'), 'summon skeletons (night, on foot)'],
  [kbd('boost'), 'burn GhASt (monster truck)'],
  [kbd('run'), 'run'],
  [kbd('rotateLeft', 'rotateRight'), 'rotate / look around'],
  [kbd('camera'), 'camera: top-down / chase / auto'],
  ['<kbd>MOUSE</kbd>', 'look (chase: click to grab, Esc frees)'],
  [kbd('hop'), 'hop'],
  ['<kbd>WHEEL</kbd>', 'zoom'],
  [kbd('fastForward'), 'hold to fast-forward'],
  [kbd('nextPhase'), 'skip to next phase'],
  // no mute key when there's no sound (?sound=0)
  ...(SOUND_ON ? [[kbd('mute'), 'sound on / off'] satisfies [string, string]] : []),
  [kbd('help'), 'hide this'],
];

const LOGO = `<div class="title-30 slime-text">30</div>
  <div class="title-name slime-text">PHANTOM CODYS</div>`;

const TITLE = `${LOGO}
  <div class="title-sub">A HAUNTED PARKING DECK TECH DEMO</div>
  <div class="title-keys">${kbd('forward', 'left', 'back', 'right')} move/drive &nbsp; ${kbd('interact')} get in/out &nbsp; ${kbd('hop')} jump &nbsp; ${kbd('run')} run/drift &nbsp; ${kbd('rotateLeft', 'rotateRight')} rotate &nbsp; ${kbd('camera')} camera &nbsp; ${kbd('help')} help</div>
  <div class="title-go">CLICK OR PRESS ${keyName('start')} TO HAUNT</div>`;

const VICTORY = `${LOGO}
  <div class="title-sub">THE GARAGE IS FULL. OF NOBODY.</div>`;

const SUN_ICON =
  '<svg class="phase-icon" viewBox="-12 -12 24 24"><circle r="4.5"/><path d="M0-11v3.5M0 7.5V11M-11 0h3.5M7.5 0H11M-7.8-7.8l2.5 2.5M5.3 5.3l2.5 2.5M-7.8 7.8l2.5-2.5M5.3-5.3l2.5-2.5"/></svg>';
const MOON_ICON = '<svg class="phase-icon" viewBox="-12 -12 24 24"><path d="M3.5-9.3A9.94 9.94 0 1 0 9.3 3.5 7.5 7.5 0 0 1 3.5-9.3z"/></svg>';

/** A banknote pointing right from the cash coin's center, turned `deg` clockwise. */
const bill = (deg: number): string =>
  `<g transform="rotate(${deg})"><rect class="bill" x="10" y="-14" width="56" height="28" rx="3"/>` +
  '<rect class="bill-line" x="14" y="-10" width="48" height="20" rx="2"/><ellipse class="bill-seal" cx="44" cy="0" rx="6" ry="7"/></g>';
const BILLS = `<svg class="cash-bills" viewBox="0 0 100 100"><g transform="translate(30 50)">${[-34, -10, 14].map(bill).join('')}</g></svg>`;

/** "1:03 PM" with each digit in a fixed-width cell and two cells for the hour, so the clock never changes width. */
function clockCells(t: string): string {
  const [, h = '', m = '', ap = ''] = /^(\d+):(\d+) (\w+)$/.exec(t) ?? [];
  const cells = (d: string) => [...d].map((c) => `<i>${c}</i>`).join('');
  return `<span class="hh">${cells(h)}</span>:${cells(m)}<span class="ap">${ap}</span>`;
}

export type HudMode = 'title' | 'foot' | 'drive';

/** Each camera mode's name, and a note on what it does. */
const CAM_NAMES: Readonly<Record<CamMode, readonly [name: string, note: string]>> = {
  iso: ['TOP-DOWN', ''],
  chase: ['CHASE CAM', ''],
  auto: ['AUTO CAM', 'CHASE WHEN DRIVING'],
};

/** An NPC's speech bubble, pinned over them on screen. */
export interface Bubble {
  /** Screen position of the speaker's head, CSS pixels. */
  x: number;
  y: number;
  who: string;
  line: string;
  choices: { action: Action; label: string; off?: boolean }[];
}

export interface DashState {
  speed: number;
  form: VehicleForm;
  /** Which civilian car it is (form 'car'). */
  kind?: CarKind;
  airborne: boolean;
}

const STOLEN: Readonly<Record<CarKind, string>> = { sedan: 'STOLEN SEDAN', pickup: 'STOLEN PICKUP', motorcycle: 'STOLEN MOTORCYCLE' };

/** Per-frame setters only touch the DOM when what they show changes; this is what they last showed. */
type Shown = 'time' | 'phase' | 'cash' | 'prompt' | 'bubble' | 'form' | 'air' | 'ghast';

/** The DOM overlay: clock, occupancy board and cash, prompts, speech bubbles, dash, toasts, title and victory screens. */
export class Hud {
  readonly root: HTMLDivElement;
  private readonly clock = new ClockFace();
  private readonly digits: HTMLElement;
  private readonly phaseEl: HTMLElement;
  private readonly cashEl: HTMLElement;
  private readonly inv: InventoryStrip;
  private readonly wares: WaresPanel;
  private readonly sign: OccupancySign;
  private readonly prompt: HTMLElement;
  private readonly bubble: HTMLElement;
  private readonly help: HTMLElement;
  private readonly dash: HTMLElement;
  private readonly dashUnit: HTMLElement;
  /** Where the minimap docks while driving. */
  private readonly dashScreen: HTMLElement;
  private readonly gauge: SpeedGauge;
  private readonly ghast: GhastDial;
  private readonly camEl: HTMLElement;
  private readonly marks: ObjectiveMarks;
  private map: Minimap | null = null;
  private camTimer = 0;
  private readonly dashForm: HTMLElement;
  private readonly toasts: HTMLElement;
  private readonly title: HTMLElement;
  private readonly victory: HTMLElement;
  private readonly hudBits: HTMLElement[];
  private readonly fps: HTMLElement | null;
  /** The game's handler for an item action picked in the inventory (eat the brisket). */
  onItemAction: ((kind: string, actionId: string) => void) | null = null;
  /** The game's handler for buying from Randy: `n` from slot `slotId` (the whole stack can be more than Cody can pay for). */
  onBuy: ((slotId: string, n: number) => void) | null = null;
  private readonly shown = new Map<Shown, string | boolean>();

  constructor(container: HTMLElement, focus: Focus) {
    const root = el('div', '', container);
    root.id = 'hud';
    this.root = root;

    // under everything else on the HUD
    this.marks = new ObjectiveMarks(root);
    const logo = el('div', 'hud-logo slime-text', root);
    el('span', 'n30', logo, '30');
    el('span', 'name', logo, 'PHANTOM<br>CODYS');

    const status = el('div', 'hud-status plate', root);
    const clock = el('div', 'hud-clock', status);
    clock.appendChild(this.clock.svg);
    const cr = el('div', 'clock-read', clock);
    this.digits = el('div', 'clock-digits', cr, '');
    this.phaseEl = el('div', 'clock-phase', cr, '');
    this.sign = new OccupancySign(status);

    const cash = el('div', 'hud-cash', status, BILLS);
    this.cashEl = el('div', 'cash-coin', cash, '');
    this.inv = new InventoryStrip(root, (kind, id) => this.onItemAction?.(kind, id), focus);
    this.wares = new WaresPanel(root, (id, n) => this.onBuy?.(id, n), focus);

    this.prompt = el('div', 'hud-prompt plate', root);
    this.bubble = el('div', 'hud-bubble plate', root);
    this.help = el('div', 'hud-help plate hide', root, HELP.map(([keys, what]) => `<span class="keys">${keys}</span><span>${what}</span>`).join(''));

    // one dash unit: the minimap's screen in the middle, the speedometer and GhASt pods on its ends
    const dash = el('div', 'hud-dash', root);
    this.dashUnit = el('div', 'dash-unit', dash);
    this.gauge = new SpeedGauge(el('div', 'dash-wing left', this.dashUnit));
    this.dashScreen = el('div', 'dash-screen plate', this.dashUnit);
    this.ghast = new GhastDial(el('div', 'dash-wing right', this.dashUnit));
    this.dashForm = el('div', 'dash-form plate', dash, 'STOLEN SEDAN');
    this.dash = dash;

    this.toasts = el('div', 'hud-toasts', root);
    this.camEl = el('div', 'hud-cam plate', root);
    this.title = el('div', 'hud-title', container, TITLE);
    this.victory = el('div', 'hud-victory hide', container, VICTORY);
    this.hudBits = [logo, status, this.inv.root, this.wares.root, this.help, this.marks.root];
    this.fps = urlFlag('fps') ? el('div', 'fps', root, '') : null;
    this.setMode('title');
  }

  /** True (and remembered) if `value` differs from what `key` last showed. */
  private changed(key: Shown, value: string | boolean): boolean {
    if (this.shown.get(key) === value) return false;
    this.shown.set(key, value);
    return true;
  }

  /** Clicking the title starts the game; the start key is read by Game like any other. */
  onStart(cb: () => void): void {
    this.title.addEventListener('click', () => {
      if (!this.title.classList.contains('hide')) cb();
    });
  }

  setMode(m: HudMode): void {
    this.root.dataset.mode = m;
    this.title.classList.toggle('hide', m !== 'title');
    for (const b of this.hudBits) b.style.display = m === 'title' ? 'none' : '';
    this.dash.classList.toggle('show', m === 'drive');
    this.help.style.visibility = m === 'drive' ? 'hidden' : '';
  }

  /** Prompt placement depends on where the camera puts Cody on screen. */
  setCamera(v: CamView): void {
    this.root.dataset.cam = v;
  }

  /**
   * Name the camera mode just picked, beside its key, for a moment. `flash` is for a player who
   * hasn't found the key yet: it blinks, and says what it does.
   */
  showCamera(m: CamMode, flash: boolean): void {
    const [name, note] = CAM_NAMES[m];
    const what = flash ? `<b>SWITCH CAMERA</b><small>NOW: ${name}${note ? ` · ${note}` : ''}</small>` : `<b>${name}</b>${note ? `<small>${note}</small>` : ''}`;
    const c = this.camEl;
    c.innerHTML = `${kbd('camera')}<span>${what}</span>`;
    c.classList.remove('show', 'flash');
    void c.offsetWidth;
    c.classList.add('show');
    c.classList.toggle('flash', flash);
    window.clearTimeout(this.camTimer);
    this.camTimer = window.setTimeout(() => c.classList.remove('show', 'flash'), flash ? 5000 : 1800);
  }

  toggleHelp(): void {
    this.help.classList.toggle('hide');
  }

  setClock(hours: number, phase: Phase, day: number): void {
    this.clock.set(hours);
    const t = GameClock.format(hours);
    if (this.changed('time', t)) {
      this.digits.innerHTML = clockCells(t);
      this.gauge.time.textContent = t;
    }
    if (this.changed('phase', `${phase}${day}`)) {
      this.root.dataset.phase = phase;
      this.phaseEl.innerHTML = phase === 'day' ? `${SUN_ICON}DAY ${day}` : `${MOON_ICON}NIGHT ${day}`;
    }
  }

  /** The minimap's city, baked once from the level (desktop only: touch screens hide it). */
  initMap(level: LevelData): void {
    this.map = new Minimap(this.root, level);
    this.hudBits.push(this.map.root);
  }

  /** Where the minimap is this frame: in the corner on foot, in the dash while driving. null hides it. */
  setMap(v: MapView | null): void {
    const m = this.map;
    if (!m) return;
    // touch screens have no room for it beside the controls
    const on = !!v && !document.body.classList.contains('touch');
    m.root.classList.toggle('off', !on);
    if (!on) return;
    m.dock(v.driving ? this.dashScreen : null, this.root);
    this.dashUnit.classList.toggle('with-map', v.driving);
    m.draw(v);
  }

  /** Objective markers this frame (ui/objective-marks.ts): `project` puts a world point on screen, `from` is Cody. */
  setObjectives(list: readonly Objective[], cam: Camera, project: (p: Vector3) => { x: number; y: number } | null, from: Vector3): void {
    this.marks.update(list, cam, project, from);
  }

  /** Randy's stock while his coat's open and Cody's in reach, every frame; null puts it away (ui/wares.ts). */
  setWares(w: Wares | null): void {
    this.wares.set(w);
  }

  /** What Cody's carrying: tags top right, each with its actions (ui/inventory.ts). */
  setInventory(items: readonly InvItem[]): void {
    this.inv.set(items);
  }

  /** Cody's cash, on the coin at the clock plate's right end. It bumps when it goes up. */
  setCash(amount: number): void {
    const s = String(amount);
    const was = this.shown.get('cash');
    if (!this.changed('cash', s)) return;
    this.cashEl.innerHTML = `<small>$</small>${s}`;
    this.cashEl.dataset.len = String(Math.min(s.length, 5));
    if (typeof was === 'string' && amount > Number(was)) {
      this.cashEl.classList.remove('bump');
      void this.cashEl.offsetWidth;
      this.cashEl.classList.add('bump');
    }
  }

  setLedger(logged: number, actual: number, phantom: number, max: number): void {
    this.sign.set(logged, actual, phantom, max);
  }

  /**
   * "F STEAL"-style prompt: `action`'s key cap, then the text, unless the text places its own caps
   * (`{interact} UP {pay} DOWN`). A tap on touch does `action`, or a cap's own. null hides it.
   */
  setPrompt(text: string | null, action: Action = 'interact'): void {
    const s = text === null ? '' : keyText(/\{\w+\}/.test(text) ? text : `{${action}} ${text}`);
    if (!this.changed('prompt', s)) return;
    if (s) {
      this.prompt.innerHTML = s;
      // touch screens tap the prompt to do it
      this.prompt.dataset.action = action;
    }
    this.prompt.classList.toggle('show', !!s);
  }

  /** Show, move or hide the speech bubble. Content is only rebuilt when it changes. */
  setBubble(b: Bubble | null): void {
    const key = b ? `${b.who}|${b.line}|${b.choices.map((c) => `${c.action}${c.label}${c.off ? 0 : 1}`).join('|')}` : '';
    if (this.changed('bubble', key)) {
      if (b) {
        this.bubble.innerHTML =
          `<div class="who">${b.who}</div><div class="line">${b.line}</div>` +
          b.choices.map((c) => `<div class="choice${c.off ? ' off' : ''}" data-action="${c.action}">${kbd(c.action)}${c.label}</div>`).join('');
      }
      this.bubble.classList.toggle('show', !!b);
    }
    if (!b) return;
    this.bubble.style.left = `${Math.round(b.x)}px`;
    this.bubble.style.top = `${Math.round(b.y)}px`;
  }

  /**
   * The truck's ghost tank, 0..1, and whether the boost is burning it; null hides the dial (and,
   * on touch, the BOOST button). Called every frame while it shows.
   */
  setGhast(fill: number | null, burning = false): void {
    const on = fill !== null;
    if (this.changed('ghast', on)) {
      this.ghast.root.classList.toggle('on', on);
      document.body.classList.toggle('ghast-on', on);
      if (!on) this.ghast.reset();
    }
    if (on) this.ghast.set(fill, burning);
  }

  setDash(d: DashState): void {
    this.gauge.set(Math.round(Math.abs(d.speed) * 2.6));
    const label = d.form === 'truck' ? 'PHANTOM MONSTER TRUCK' : STOLEN[d.kind ?? 'sedan'];
    if (this.changed('form', label)) {
      this.dash.dataset.form = d.form;
      this.dashForm.textContent = label;
    }
    if (this.changed('air', d.airborne)) this.gauge.root.classList.toggle('air', d.airborne);
  }

  toast(big: string, small = '', variant: '' | 'purple' | 'warn' = '', life = 2.2): void {
    const t = el('div', `toast ${variant}`, this.toasts);
    t.style.setProperty('--life', `${life}s`);
    el('div', 'big slime-text', t, big);
    if (small) el('div', 'small', t, keyText(small));
    window.setTimeout(() => t.remove(), (life + 0.6) * 1000);
    while (this.toasts.children.length > 3) this.toasts.firstElementChild?.remove();
  }

  /** Hold the occupancy board back (the tutorial brings it in with the first phantom). */
  showLedger(on: boolean): void {
    this.sign.root.classList.toggle('held', !on);
  }

  clearToasts(): void {
    this.toasts.replaceChildren();
  }

  showVictory(): void {
    this.victory.classList.remove('hide');
    this.victory.addEventListener('click', () => this.victory.classList.add('hide'), { once: true });
  }

  setFps(fps: number, info: string): void {
    if (this.fps) this.fps.textContent = `${fps.toFixed(0)} fps ${info}`;
  }
}
