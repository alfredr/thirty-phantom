import type { Camera, Vector3 } from 'three';
import type { VehicleForm } from '../actors/vehicle';
import { SOUND_ON } from '../audio/flags';
import { urlFlag } from '../engine/core/url-flags';
import type { Focus } from '../engine/input/input';
import { Bindings } from '../engine/ui/binding';
import { el } from '../engine/ui/dom';
import type { CamMode, CamView } from '../game/game';
import { GameClock, type Phase } from '../game/game-clock';
import type { Objective } from '../game/story/objectives';
import type { LevelData } from '../world/level-data';
import { ClockFace } from './clock-face';
import { type InvItem, InventoryStrip } from './inventory';
import { OccupancySign } from './occupancy-sign';
import { GhastDial } from './ghast-dial';
import { type MapView, Minimap } from './minimap';
import { ObjectiveMarks } from './objective-marks';
import { SpeedGauge } from './speed-gauge';
import { touchGlyph } from './touch-controls';
import { type Wares, WaresPanel } from './wares';
import './hud.css';
import { type Control, isControl, keyName } from '../game/controls';

/**
 * Key caps for actions, labelled for the device in use when drawn: the key on a keyboard, the
 * on-screen button on a touch screen, or TAP where touch has no button. Each cap carries its
 * action, so on touch tapping it does that action (touch-controls.ts).
 */
export const kbd = (...actions: Control[]): string => actions.map((a) => `<kbd data-action="${a}">${capLabel(a)}</kbd>`).join('');

function capLabel(a: Control): string {
  if (!document.body.classList.contains('touch')) return keyName(a);
  return touchGlyph(a) ?? 'TAP';
}

/** `text` with each `{action}` in it, e.g. `{hop} ROCK IT OVER`, replaced by that action's key cap. */
export function keyText(text: string): string {
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (isControl(name) ? kbd(name) : m));
}

/** On foot the map lives in the phone (its Map app); 'corner' puts it back in the screen's corner as well. */
const MAP_ON_FOOT: 'phone' | 'corner' = 'phone';

/** Every key and what it does, for the phone's Help app: made when it's shown, so the caps match the device in use. */
export const helpRows = (): [keys: string, what: string][] => [
  [kbd('forward', 'left', 'back', 'right'), 'walk'],
  [kbd('interact'), 'steal / get in / talk'],
  [kbd('pay'), 'tip the valet'],
  [kbd('inventory'), 'items: eat, use'],
  [kbd('phone'), 'phone: texts, tasks, map'],
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
  [kbd('help'), 'this list'],
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
  choices: { action: Control; label: string; off?: boolean }[];
}

/** What the status displays show: the game's state as they read it, once a frame. */
export interface HudStatus {
  /** 'title' till play starts; then 'drive' at the wheel (or turning into the truck), else 'foot'. */
  mode(): HudMode;
  hours(): number;
  phase(): Phase;
  day(): number;
  cash(): number;
  /** The occupancy board: the badge log, cars really in the deck, phantoms in spots, and spots in all. */
  ledger(): { logged: number; actual: number; phantom: number; max: number };
  /** What's on the dash while he drives; null on foot. */
  dash(): DashState | null;
  /** The truck's ghost tank (0..1) and whether he's burning it, while he drives the truck; null otherwise. */
  ghast(): { fill: number; burning: boolean } | null;
}

export interface DashState {
  speed: number;
  form: VehicleForm;
  /** What it's called (VehicleBreed.label). */
  label: string;
  airborne: boolean;
}

/** Per-frame setters only touch the DOM when what they show changes; this is what they last showed. */
type Shown = 'prompt' | 'bubble' | 'form' | 'air' | 'ghast';

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
  private readonly dash: HTMLElement;
  private readonly dashUnit: HTMLElement;
  /** Where the minimap docks while driving. */
  private readonly dashScreen: HTMLElement;
  private readonly gauge: SpeedGauge;
  private readonly ghast: GhastDial;
  private readonly camEl: HTMLElement;
  private readonly marks: ObjectiveMarks;
  private map: Minimap | null = null;
  /** The map in the phone's Map app: a second map of the same city, so the dash keeps its own. */
  private phoneMap: Minimap | null = null;
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
  /** The status displays, each drawn when what it reads changes. */
  private readonly views = new Bindings();

  constructor(container: HTMLElement, focus: Focus<Control>) {
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
    this.hudBits = [logo, status, this.inv.root, this.wares.root, this.marks.root];
    this.fps = urlFlag('fps') ? el('div', 'fps', root, '') : null;
    this.drawMode('title');
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

  /** Hooks the status displays up to `s`; update() redraws whichever changed. */
  bind(s: HudStatus): void {
    const v = this.views;
    v.add({ read: () => s.mode(), draw: (m) => this.drawMode(m) });
    // the dial's hand moves on every frame the clock runs; the digits only when the minute does
    v.add({ read: () => s.hours(), draw: (h) => this.clock.set(h) });
    v.add({
      read: () => GameClock.format(s.hours()),
      draw: (t) => {
        this.digits.innerHTML = clockCells(t);
        this.gauge.time.textContent = t;
      },
    });
    v.add({
      read: () => ({ phase: s.phase(), day: s.day() }),
      same: (a, b) => a.phase === b.phase && a.day === b.day,
      draw: ({ phase, day }) => {
        this.root.dataset.phase = phase;
        this.phaseEl.innerHTML = phase === 'day' ? `${SUN_ICON}DAY ${day}` : `${MOON_ICON}NIGHT ${day}`;
      },
    });
    v.add({ read: () => s.cash(), draw: (amount, was) => this.drawCash(amount, was) });
    v.add({
      read: () => s.ledger(),
      same: (a, b) => a.logged === b.logged && a.actual === b.actual && a.phantom === b.phantom && a.max === b.max,
      draw: (l) => this.sign.set(l.logged, l.actual, l.phantom, l.max),
    });
    v.add({
      read: () => s.dash(),
      same: (a, b) => a === b || (!!a && !!b && Math.round(a.speed * 2.6) === Math.round(b.speed * 2.6) && a.form === b.form && a.label === b.label && a.airborne === b.airborne),
      draw: (d) => d && this.drawDash(d),
    });
    v.add({
      read: () => s.ghast(),
      same: (a, b) => a === b || (!!a && !!b && a.fill === b.fill && a.burning === b.burning),
      draw: (g) => this.drawGhast(g),
    });
  }

  /** Redraws the status displays whose state has changed. Once a frame. */
  update(): void {
    this.views.update();
  }

  private drawMode(m: HudMode): void {
    this.root.dataset.mode = m;
    this.title.classList.toggle('hide', m !== 'title');
    for (const b of this.hudBits) b.style.display = m === 'title' ? 'none' : '';
    this.dash.classList.toggle('show', m === 'drive');
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
    const what = flash ? `<b>SWITCH CAMERA</b><small>NOW: ${name}${note ? `, ${note}` : ''}</small>` : `<b>${name}</b>${note ? `<small>${note}</small>` : ''}`;
    const c = this.camEl;
    c.innerHTML = `${kbd('camera')}<span>${what}</span>`;
    c.classList.remove('show', 'flash');
    void c.offsetWidth;
    c.classList.add('show');
    c.classList.toggle('flash', flash);
    window.clearTimeout(this.camTimer);
    this.camTimer = window.setTimeout(() => c.classList.remove('show', 'flash'), flash ? 5000 : 1800);
  }

  /** The minimap's city, baked once from the level (desktop only: touch screens hide it). */
  initMap(level: LevelData): void {
    this.map = new Minimap(this.root, level);
    this.phoneMap = new Minimap(this.root, level, this.map);
    this.phoneMap.root.classList.add('off');
    this.hudBits.push(this.map.root);
  }

  /**
   * The minimaps this frame: one in the dash while driving (or, with MAP_ON_FOOT 'corner', in the
   * corner on foot), and one in the phone's Map app while that's up (`phone`, its screen), driving
   * or not. null hides them.
   */
  setMap(v: MapView | null, phone: HTMLElement | null): void {
    const m = this.map;
    const pm = this.phoneMap;
    if (!m || !pm) return;
    // touch screens have no room beside the controls for the dash's or the corner's, but the phone has
    const touch = document.body.classList.contains('touch');
    const dash = !!v && !touch && v.driving;
    const corner = !!v && !touch && !v.driving && MAP_ON_FOOT === 'corner';
    m.root.classList.toggle('off', !dash && !corner);
    this.dashUnit.classList.toggle('with-map', dash);
    if (v && dash) m.dock(this.dashScreen, 'dash');
    else if (v && corner) m.dock(this.root, 'corner');
    if (v && (dash || corner)) m.draw(v);
    pm.root.classList.toggle('off', !v || !phone);
    if (!v || !phone) return;
    pm.dock(phone, 'phone');
    pm.draw(v);
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
  private drawCash(amount: number, was: number | undefined): void {
    const s = String(amount);
    this.cashEl.innerHTML = `<small>$</small>${s}`;
    this.cashEl.dataset.len = String(Math.min(s.length, 5));
    if (was !== undefined && amount > was) {
      this.cashEl.classList.remove('bump');
      void this.cashEl.offsetWidth;
      this.cashEl.classList.add('bump');
    }
  }

  /**
   * "F STEAL"-style prompt: `action`'s key cap, then the text, unless the text places its own caps
   * (`{interact} UP {pay} DOWN`). A tap on touch does `action`, or a cap's own. null hides it.
   */
  setPrompt(text: string | null, action: Control = 'interact'): void {
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

  /** The truck's ghost tank, and whether the boost is burning it; null hides the dial (and, on touch, the BOOST button). */
  private drawGhast(g: { fill: number; burning: boolean } | null): void {
    const on = g !== null;
    if (this.changed('ghast', on)) {
      this.ghast.root.classList.toggle('on', on);
      document.body.classList.toggle('ghast-on', on);
      if (!on) this.ghast.reset();
    }
    if (g) this.ghast.set(g.fill, g.burning);
  }

  private drawDash(d: DashState): void {
    this.gauge.set(Math.round(Math.abs(d.speed) * 2.6));
    if (this.changed('form', d.label)) {
      this.dash.dataset.form = d.form;
      this.dashForm.textContent = d.label;
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
