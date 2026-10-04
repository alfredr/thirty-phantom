import type { Camera, Vector3 } from 'three';

import type { VehicleForm } from '@/actors/vehicles/vehicle';
import { SOUND_ON } from '@/audio/flags';
import { urlFlag } from '@/engine/core/url-flags';
import type { Focus } from '@/engine/input/input';
import { Bindings } from '@/engine/ui/binding';
import { el } from '@/engine/ui/dom';
import { type Control, isControl, keyName } from '@/game/controls';
import type { CamMode, CamView } from '@/game/game';
import { GameClock, type Phase } from '@/game/game-clock';
import type { Objective } from '@/game/story/objectives';
import type { LevelData } from '@/world/level-data';

import { ClockFace } from './clock-face';
import { GhastDial } from './ghast-dial';
import { type InvItem, InventoryStrip, sameInventory } from './inventory';
import { type MapView, Minimap } from './minimap';
import { ObjectiveMarks } from './objective-marks';
import { OccupancySign } from './occupancy-sign';
import { SpeedGauge } from './speed-gauge';
import { touchGlyph } from './touch-controls';
import { type Wares, WaresPanel, sameWares } from './wares';

import './hud.css';

/**
 * Render action key caps for the current input device. Use keyboard labels, touch button labels, or TAP when no touch
 * button exists. data-action allows touch-controls.ts to dispatch a tap through the same control.
 */
export const kbd = (...actions: Control[]): string =>
  actions.map((a) => `<kbd data-action="${a}">${capLabel(a)}</kbd>`).join('');

function capLabel(a: Control): string {
  if (!document.body.classList.contains('touch')) {
    return keyName(a);
  }

  return touchGlyph(a) ?? 'TAP';
}

/** Replace recognized `{action}` placeholders with device-appropriate key caps. Preserve unknown placeholders. */
export function keyText(text: string): string {
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (isControl(name) ? kbd(name) : m));
}

/** Choose whether walking shows a desktop corner map in addition to the phone’s Map app. */
const MAP_ON_FOOT: 'phone' | 'corner' = 'phone';

/** Generate Help app rows when displayed so control labels match the active input device. */
export const helpRows = (): [keys: string, what: string][] => [
  [kbd('forward', 'left', 'back', 'right'), 'walk'],
  [kbd('interact'), 'steal / get in / talk'],
  [kbd('pay'), 'hotwire / tip the valet'],
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
  // Omit the mute shortcut when audio is disabled by ?sound=0.
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
const MOON_ICON =
  '<svg class="phase-icon" viewBox="-12 -12 24 24"><path d="M3.5-9.3A9.94 9.94 0 1 0 9.3 3.5 7.5 7.5 0 0 1 3.5-9.3z"/></svg>';

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

/** Display name and optional explanatory text for each camera mode. */
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

/** Game-state readers consumed by HUD bindings each frame. */
export interface HudStatus {
  /** Presentation mode: title before play, drive while controlling or transforming a vehicle, otherwise foot. */
  mode(): HudMode;
  /** Whether summoning is currently available, controlling visibility of its touch button. */
  summon(): boolean;
  hours(): number;
  phase(): Phase;
  day(): number;
  cash(): number;
  inventory(): readonly InvItem[];
  wares(): Wares | null;
  /** Occupancy counters and total parking capacity. */
  ledger(): { logged: number; actual: number; phantom: number; max: number };
  /** Dashboard state while driving, or null on foot. */
  dash(): DashState | null;
  /** GhASt level in [0, 1] and boost state while driving the truck; null otherwise. */
  ghast(): { fill: number; burning: boolean } | null;
}

/** Visual toast variants for ordinary, deck-related, and warning messages. */
export type ToastTone = '' | 'purple' | 'warn';

export interface DashState {
  speed: number;
  form: VehicleForm;
  /** Vehicle display name from VehicleBreed.label. */
  label: string;
  airborne: boolean;
}

/** Cache keys for HUD values updated only when their visible state changes. */
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
  /** Separate phone map view sharing the dashboard map’s baked city image. */
  private phoneMap: Minimap | null = null;
  private camTimer = 0;
  private readonly dashForm: HTMLElement;
  private readonly toasts: HTMLElement;
  private readonly title: HTMLElement;
  private readonly victory: HTMLElement;
  private readonly hudBits: HTMLElement[];
  private readonly fps: HTMLElement | null;
  /** Game callback for an action selected from the inventory. */
  onItemAction: ((kind: string, actionId: string) => void) | null = null;
  /**
   * The game's handler for buying from Randy: `n` from slot `slotId` (the whole stack can be more than Cody can pay
   * for).
   */
  onBuy: ((slotId: string, n: number) => void) | null = null;
  private readonly shown = new Map<Shown, string | boolean>();
  /** Bindings that redraw status displays when their values change. */
  private readonly views = new Bindings();

  constructor(container: HTMLElement, focus: Focus<Control>) {
    const root = el('div', '', container);
    root.id = 'hud';
    this.root = root;

    // Add objective markers first so later HUD elements cover them.
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

    // Keep the map between the speedometer and GhASt gauge in one dashboard unit.
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

  /** Store the value and return true only when it differs from the cached value. */
  private changed(key: Shown, value: string | boolean): boolean {
    if (this.shown.get(key) === value) {
      return false;
    }

    this.shown.set(key, value);
    return true;
  }

  /** Clicking the title starts the game; the start key is read by Game like any other. */
  onStart(cb: () => void): void {
    this.title.addEventListener('click', () => {
      if (!this.title.classList.contains('hide')) {
        cb();
      }
    });
  }

  /** Register state readers and display callbacks; update() redraws changed values. */
  bind(s: HudStatus): void {
    const v = this.views;
    v.add({ read: () => s.mode(), draw: (m) => this.drawMode(m) });
    v.add({ read: () => s.summon(), draw: (on) => (this.root.dataset.summon = on ? 'on' : '') });
    v.add({ read: () => s.inventory(), same: sameInventory, draw: (items) => this.inv.set(items) });
    v.add({ read: () => s.wares(), same: sameWares, draw: (wares) => this.wares.set(wares) });
    // The dial moves each frame; the digits change only on the minute.
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
      same: (a, b) =>
        a === b ||
        (!!a &&
          !!b &&
          Math.round(a.speed * 2.6) === Math.round(b.speed * 2.6) &&
          a.form === b.form &&
          a.label === b.label &&
          a.airborne === b.airborne),
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

    for (const b of this.hudBits) {
      b.style.display = m === 'title' ? 'none' : '';
    }

    this.dash.classList.toggle('show', m === 'drive');
  }

  /** Prompt placement depends on where the camera puts Cody on screen. */
  setCamera(v: CamView): void {
    this.root.dataset.cam = v;
  }

  /**
   * Show the selected camera mode temporarily. With `flash`, include an introductory control hint and keep the
   * notification visible longer.
   */
  showCamera(m: CamMode, flash: boolean): void {
    const [name, note] = CAM_NAMES[m];
    const what = flash
      ? `<b>SWITCH CAMERA</b><small>NOW: ${name}${note ? `, ${note}` : ''}</small>`
      : `<b>${name}</b>${note ? `<small>${note}</small>` : ''}`;
    const c = this.camEl;
    c.innerHTML = `${kbd('camera')}<span>${what}</span>`;
    c.classList.remove('show', 'flash');
    void c.offsetWidth;
    c.classList.add('show');
    c.classList.toggle('flash', flash);
    window.clearTimeout(this.camTimer);
    this.camTimer = window.setTimeout(() => c.classList.remove('show', 'flash'), flash ? 5000 : 1800);
  }

  /** Create dashboard and phone map views sharing one baked city image. */
  initMap(level: LevelData): void {
    this.map = new Minimap(this.root, level);
    this.phoneMap = new Minimap(this.root, level, this.map);
    this.phoneMap.root.classList.add('off');
    this.hudBits.push(this.map.root);
  }

  /**
   * The minimaps this frame: one in the dash while driving (or, with MAP_ON_FOOT 'corner', in the corner on foot), and
   * one in the phone's Map app while that's up (`phone`, its screen), driving or not. null hides them.
   */
  setMap(v: MapView | null, phone: HTMLElement | null): void {
    const m = this.map;
    const pm = this.phoneMap;
    if (!m || !pm) {
      return;
    }

    // On touch devices, reserve map rendering for the phone to leave room for controls.
    const touch = document.body.classList.contains('touch');
    const dash = !!v && !touch && v.driving;
    const corner = !!v && !touch && !v.driving && MAP_ON_FOOT === 'corner';
    m.root.classList.toggle('off', !dash && !corner);
    this.dashUnit.classList.toggle('with-map', dash);

    if (v && dash) {
      m.dock(this.dashScreen, 'dash');
    } else if (v && corner) {
      m.dock(this.root, 'corner');
    }

    if (v && (dash || corner)) {
      m.draw(v);
    }

    pm.root.classList.toggle('off', !v || !phone);

    if (!v || !phone) {
      return;
    }

    pm.dock(phone, 'phone');
    pm.draw(v);
  }

  /** Objective markers this frame (ui/objective-marks.ts): `project` puts a world point on screen, `from` is Cody. */
  setObjectives(
    list: readonly Objective[],
    cam: Camera,
    project: (p: Vector3) => { x: number; y: number } | null,
    from: Vector3,
  ): void {
    this.marks.update(list, cam, project, from);
  }

  /** Update the cash display and animate increases after the initial draw. */
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
   * "F STEAL"-style prompt: `action`'s key cap, then the text, unless the text places its own caps (`{interact} UP
   * {pay} DOWN`). A tap on touch does `action`, or a cap's own. null hides it.
   */
  setPrompt(text: string | null, action: Control = 'interact'): void {
    const s = text === null ? '' : keyText(/\{\w+\}/.test(text) ? text : `{${action}} ${text}`);
    if (!this.changed('prompt', s)) {
      return;
    }

    if (s) {
      this.prompt.innerHTML = s;
      // The prompt’s default touch action also applies outside its individual key caps.
      this.prompt.dataset.action = action;
    }

    this.prompt.classList.toggle('show', !!s);
  }

  /** Show, move or hide the speech bubble. Content is only rebuilt when it changes. */
  setBubble(b: Bubble | null): void {
    const key = b
      ? `${b.who}|${b.line}|${b.choices.map((c) => `${c.action}${c.label}${c.off ? 0 : 1}`).join('|')}`
      : '';
    if (this.changed('bubble', key)) {
      if (b) {
        this.bubble.innerHTML =
          `<div class="who">${b.who}</div><div class="line">${b.line}</div>` +
          b.choices
            .map(
              (c) =>
                `<div class="choice${c.off ? ' off' : ''}" data-action="${c.action}">${kbd(c.action)}${c.label}</div>`,
            )
            .join('');
      }

      this.bubble.classList.toggle('show', !!b);
    }

    if (!b) {
      return;
    }

    this.bubble.style.left = `${Math.round(b.x)}px`;
    this.bubble.style.top = `${Math.round(b.y)}px`;
  }

  /** Update GhASt level and boost state. Null hides the dial and touch boost button and resets refill detection. */
  private drawGhast(g: { fill: number; burning: boolean } | null): void {
    const on = g !== null;
    if (this.changed('ghast', on)) {
      this.ghast.root.classList.toggle('on', on);
      document.body.classList.toggle('ghast-on', on);

      if (!on) {
        this.ghast.reset();
      }
    }

    if (g) {
      this.ghast.set(g.fill, g.burning);
    }
  }

  private drawDash(d: DashState): void {
    this.gauge.set(Math.round(Math.abs(d.speed) * 2.6));

    if (this.changed('form', d.label)) {
      this.dash.dataset.form = d.form;
      this.dashForm.textContent = d.label;
    }

    if (this.changed('air', d.airborne)) {
      this.gauge.root.classList.toggle('air', d.airborne);
    }
  }

  toast(big: string, small = '', variant: ToastTone = '', life = 2.2): void {
    const t = el('div', `toast ${variant}`, this.toasts);
    t.style.setProperty('--life', `${life}s`);
    el('div', 'big slime-text', t, big);

    if (small) {
      el('div', 'small', t, keyText(small));
    }

    window.setTimeout(() => t.remove(), (life + 0.6) * 1000);

    while (this.toasts.children.length > 3) {
      this.toasts.firstElementChild?.remove();
    }
  }

  /** Control occupancy-board visibility for the tutorial’s first-phantom reveal. */
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
    if (this.fps) {
      this.fps.textContent = `${fps.toFixed(0)} fps ${info}`;
    }
  }
}
