import type { Focus } from '@/engine/input/input';
import { Bindings } from '@/engine/ui/binding';
import { el } from '@/engine/ui/dom';
import type { Control } from '@/game/controls';

import '@/ui/burner.css';
import { keyText } from '@/ui/hud';

import type { CallLine, Calls } from './calls';
import type { Messages } from './messages';
import { type CallOptions, type Outreach, OutreachQueue, type TextOptions } from './outreach';
import { type GameTime, type Stamp, stampAt } from './stamp';

import './phone.css';

export type { CallLine } from './calls';
export type { CallOptions, Outreach, TextOptions } from './outreach';

/** Vertical scroll distance per menu control press, in CSS pixels. */
const SCROLL = 48;
/** The keys that open apps from the home screen, in order. */
const APP_KEYS: readonly Control[] = ['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7', 'slot8', 'slot9'];

/** Phone application lifecycle: mount once, receive selection changes, and update while the phone is raised. */
export interface PhoneApp {
  readonly id: string;
  readonly name: string;
  /** Home-screen icon as HTML markup, typically inline SVG. */
  readonly icon: string;
  /** Builds its screen inside `root`, once. */
  mount(root: HTMLElement): void;
  /** Notify selection or deselection of this app, independently of the phone’s raised state. */
  shown?(on: boolean): void;
  /** Refresh the selected app while the phone is raised. */
  update?(): void;
  /** Unread count shown in the app’s home-screen badge. */
  unseen?(): number;
  press?(control: Control): boolean;
}

/** What the phone reads from the game. */
export interface PhoneStatus {
  /** The time on its status bar. */
  time(): string;
  /** The current task, or null. */
  goal(): string | null;
  how(): string | null;
  now(): GameTime;
}

/**
 * Manage the burner phone’s applications, text pop-ups, and call screen. Manual opening holds the phone onscreen and
 * reserves navigation controls. Texts and calls take turns through one queue; calls remain raised until ended. The
 * current task appears separately beneath the HUD clock.
 */
export class Phone {
  /** Notify the game when ringing starts, ringing stops, or a text arrives. */
  onBuzz: ((what: 'ring' | 'hangup' | 'text') => void) | null = null;
  quiet: () => boolean = () => false;
  private readonly queue: OutreachQueue;
  private readonly pop: HTMLDivElement;
  private readonly popMsg: HTMLElement;
  private readonly popFoot: HTMLElement;
  private ringAt: Stamp | null = null;
  private readonly frame: HTMLDivElement;
  private readonly badges = new Map<PhoneApp, HTMLElement>();
  private readonly bodies = new Map<PhoneApp, HTMLElement>();
  private readonly icons: HTMLElement[] = [];
  private readonly pages = new Map<PhoneApp, HTMLElement>();
  private readonly home: HTMLElement;
  private readonly views = new Bindings();
  /** The app on screen, or null for the home screen. */
  private app: PhoneApp | null = null;
  /** The home screen's highlighted app. */
  private pick = 0;
  /** Whether manually opened; held phones reserve controls and do not retract automatically. */
  private held = false;
  private unfocus: (() => void) | null = null;
  /** Applications in home-screen order, with messages first. */
  readonly apps: readonly PhoneApp[];

  constructor(
    hud: HTMLElement,
    private readonly focus: Focus<Control>,
    private readonly status: PhoneStatus,
    readonly messages: Messages,
    readonly calls: Calls,
    others: readonly PhoneApp[],
  ) {
    const apps = [messages, calls, ...others];
    this.apps = apps;
    messages.landed = () => this.buzz();
    this.frame = el('div', 'burner', hud);
    const screen = el('div', 'burner-screen', this.frame);
    el('div', 'burner-notch', screen);
    const bar = el('div', 'burner-status', screen);
    const time = el('span', 'time', bar, '');
    el('span', 'bars', bar, '<i></i><i></i><i></i><i></i>');
    this.views.add({ read: () => status.time(), draw: (t) => (time.textContent = t) });
    const home = el('div', 'phone-home', screen);
    this.home = home;
    apps.forEach((app, i) => {
      const icon = el(
        'button',
        'phone-icon',
        home,
        `<span class="glyph">${app.icon}</span><span class="name">${app.name}</span>`,
      );
      icon.dataset.act = 'app';
      icon.addEventListener('click', () => this.go(app));
      this.badges.set(app, el('span', 'badge', icon, ''));
      this.icons[i] = icon;
      const page = el('div', 'phone-app', screen);
      page.dataset.app = app.id;
      this.pages.set(app, page);
      const head = el('div', 'phone-bar', page);
      const back = el('button', 'back', head, '&lt;');
      back.addEventListener('click', () => this.go(null));
      el('span', 'title', head, app.name);
      const body = el('div', 'phone-body', page);
      // engine/input/input.ts preserves wheel scrolling inside data-scroll elements.
      body.dataset.scroll = '';
      this.bodies.set(app, body);
      app.mount(body);
    });
    const call = el('div', 'burner-call', screen);
    el('div', 'big burner-avatar', call);
    el('div', 'name', call, 'RANDY ROLSEN');
    el('div', 'state', call, 'INCOMING CALL');
    el('div', 'buttons', call, '<i class="no"></i><i class="ok"></i>');
    const goal = el('div', 'burner-goal', hud);
    const how = el('div', 'burner-how', hud);
    this.views.add({
      read: () => status.goal(),
      draw: (task) => {
        goal.classList.toggle('on', !!task);
        goal.innerHTML = task ? keyText(task) : '';
      },
    });
    this.views.add({
      read: () => (status.goal() ? status.how() : null),
      draw: (line) => {
        how.classList.toggle('on', !!line);
        how.innerHTML = line ? keyText(line) : '';
      },
    });
    this.pop = el('div', 'text-pop', hud);
    const card = el('div', 'text-pop-card', this.pop);
    const head = el('div', 'text-pop-head', card);
    el('div', 'burner-avatar', head);
    el('div', 'text-pop-who', head, '<span class="name">RANDY</span><span class="sub">NEW TEXT</span>');
    this.popMsg = el('div', 'text-pop-msg', card);
    this.popFoot = el('div', 'text-pop-foot', card);
    card.addEventListener('click', () => this.queue.acknowledge());
    this.queue = new OutreachQueue({
      show: (msg, opts) => this.showPop(msg, opts),
      hide: () => this.pop.classList.remove('on'),
      fly: () => this.flyPop(),
      land: (msg) => this.messages.post(msg, stampAt(this.status.now())),
      ring: () => this.ring(),
    });
    focus.add({
      controls: () => (this.queue.awaitingKey ? ['interact'] : []),
      press: (_control, { repeat }) => {
        if (!repeat) {
          this.queue.acknowledge();
        }
      },
    });
    // Tapping the retracted tab manually opens the previously selected app.
    this.frame.addEventListener('click', () => {
      if (this.frame.classList.contains('peek')) {
        this.open(this.app?.id);
      }
    });
    this.showScreen();
  }

  /** Close a held phone when no app is requested or that app is selected; otherwise open the requested screen. */
  toggle(id?: string): void {
    if (this.held && (!id || this.app?.id === id)) {
      this.putAway();
    } else {
      this.open(id);
    }
  }

  /** Raise and hold the phone on app `id`, or home when the ID is absent or unknown. Reserve phone controls. */
  open(id?: string): void {
    this.held = true;
    this.raise();
    this.go(this.apps.find((a) => a.id === id) ?? null);
    this.unfocus ??= this.focus.add({
      controls: () => this.controls(),
      press: (control) => this.press(control),
    });
  }

  /** Hide the phone, cancel automatic retraction, and release reserved controls. */
  putAway(): void {
    this.held = false;
    this.unfocus?.();
    this.unfocus = null;
    this.frame.classList.remove('up', 'peek');
  }

  text(msg: string, opts?: TextOptions): void {
    this.queue.text(msg, opts);
  }

  queueCall(start: () => void, opts?: CallOptions): void {
    this.queue.queueCall(start, opts);
  }

  drop(key: string): void {
    this.queue.drop(key);
  }

  get popupVisible(): boolean {
    return this.queue.visible;
  }

  get pending(): number {
    return this.queue.pending;
  }

  get calling(): boolean {
    return this.queue.calling;
  }

  get outreaches(): readonly Outreach[] {
    return this.queue.history;
  }

  get elapsed(): number {
    return this.queue.elapsed;
  }

  /** Randy's face (a data URL), for his contact, the call screen and text pop-ups. */
  setAvatar(url: string): void {
    for (const a of [this.frame, this.pop].flatMap((root) => [
      ...root.querySelectorAll<HTMLElement>('.burner-avatar'),
    ])) {
      a.style.backgroundImage = `url(${url})`;
    }
  }

  endCall(lines?: readonly CallLine[]): void {
    const at = this.ringAt;
    this.ringAt = null;
    this.hangUp();
    this.queue.endCall();

    if (at) {
      this.calls.log('RANDY', at, lines ?? []);
    }

    if (!this.held) {
      this.peek();
    }
  }

  /** Restart the visual vibration animation and emit the text sound event. */
  buzz(): void {
    this.frame.classList.remove('buzz');
    void this.frame.offsetWidth;
    this.frame.classList.add('buzz');
    this.onBuzz?.('text');
  }

  /** End the call and put the phone away when the tutorial finishes. */
  close(): void {
    this.hangUp();
    this.queue.endCall();
    this.putAway();
  }

  /** Run the text and call queue, refresh status bindings and unread badges, then update the selected app if raised. */
  update(dt: number): void {
    this.queue.update(dt, this.quiet());
    this.views.update();

    for (const [app, badge] of this.badges) {
      const n = app.unseen?.() ?? 0;
      const text = n > 0 ? String(n) : '';
      if (badge.textContent !== text) {
        badge.textContent = text;
      }
    }

    if (this.app && this.frame.classList.contains('up')) {
      this.app.update?.();
    }
  }

  /** Whether app `id` is on screen with the phone up. */
  showing(id: string): boolean {
    return this.app?.id === id && this.frame.classList.contains('up');
  }

  /** Return the mounted content element for an app ID, or null if unknown. */
  body(id: string): HTMLElement | null {
    const app = this.apps.find((a) => a.id === id);
    return app ? (this.bodies.get(app) ?? null) : null;
  }

  private controls(): readonly Control[] {
    if (this.app) {
      return this.app.press
        ? ['phone', 'cancel', 'menuUp', 'menuDown', 'confirm']
        : ['phone', 'cancel', 'menuUp', 'menuDown'];
    }

    return ['phone', 'cancel', 'menuUp', 'menuDown', 'confirm', ...APP_KEYS.slice(0, this.apps.length)];
  }

  private press(control: Control): void {
    if (control === 'phone') {
      this.putAway();
    } else if (control === 'cancel') {
      if (this.app) {
        this.go(null);
      } else {
        this.putAway();
      }
    } else if (this.app?.press?.(control)) {
      return;
    } else if (this.app) {
      const body = this.bodies.get(this.app);
      if (body) {
        body.scrollTop += control === 'menuUp' ? -SCROLL : control === 'menuDown' ? SCROLL : 0;
      }
    } else if (control === 'menuUp' || control === 'menuDown') {
      const n = this.apps.length;
      this.pick = (this.pick + (control === 'menuUp' ? n - 1 : 1)) % n;
      this.showScreen();
    } else if (control === 'confirm') {
      this.go(this.apps[this.pick] ?? null);
    } else {
      const i = APP_KEYS.indexOf(control);
      if (i >= 0) {
        this.go(this.apps[i] ?? null);
      }
    }
  }

  /** Select an app or home and notify applications whose selection state changes. */
  private go(app: PhoneApp | null): void {
    if (app === this.app) {
      return;
    }

    this.app?.shown?.(false);
    this.app = app;

    if (app) {
      this.pick = Math.max(0, this.apps.indexOf(app));
    }

    this.showScreen();
    app?.shown?.(true);
  }

  private showScreen(): void {
    this.frame.dataset.screen = this.app?.id ?? 'home';
    this.home.classList.toggle('on', !this.app);

    for (const [app, page] of this.pages) {
      page.classList.toggle('on', app === this.app);
    }

    this.icons.forEach((icon, i) => icon.classList.toggle('picked', i === this.pick));
  }

  private ring(): void {
    this.ringAt = stampAt(this.status.now());
    this.frame.classList.add('calling');
    this.onBuzz?.('ring');
    this.raise();
  }

  private showPop(msg: string, opts: TextOptions): void {
    this.popMsg.innerHTML = keyText(msg);
    const pop = this.pop;

    if (pop.classList.contains('fly')) {
      pop.style.transition = 'none';
      pop.classList.remove('fly');
      void pop.offsetWidth;
      pop.style.transition = '';
    }

    pop.classList.remove('brief', 'until', 'key');

    if (opts.until) {
      pop.classList.add('until');
      this.popFoot.innerHTML = '';
    } else if (opts.brief !== undefined) {
      pop.classList.add('brief');
      pop.style.setProperty('--brief', `${opts.brief}s`);
      this.popFoot.innerHTML = '<i class="text-pop-timer"></i>';
    } else {
      pop.classList.add('key');
      this.popFoot.innerHTML = keyText('{interact} OK');
    }

    void pop.offsetWidth;
    pop.classList.add('on');

    if (!this.held && !this.frame.classList.contains('up')) {
      this.frame.classList.add('peek');
    }
  }

  private flyPop(): void {
    const pop = this.pop;
    const card = pop.firstElementChild;
    if (!card) {
      return;
    }

    const from = card.getBoundingClientRect();
    const to = this.frame.getBoundingClientRect();
    const tx = Math.max(to.left, 0) + (Math.min(to.right, window.innerWidth) - Math.max(to.left, 0)) / 2;
    const ty = to.top + to.height * 0.35;
    pop.style.setProperty('--fx', `${tx - (from.left + from.width / 2)}px`);
    pop.style.setProperty('--fy', `${ty - (from.top + from.height / 2)}px`);
    pop.classList.add('fly');
    pop.classList.remove('on');
  }

  private hangUp(): void {
    if (!this.frame.classList.contains('calling')) {
      return;
    }

    this.frame.classList.remove('calling');
    this.onBuzz?.('hangup');
  }

  private raise(): void {
    this.frame.classList.remove('peek');
    this.frame.classList.add('up');
  }

  private peek(): void {
    if (this.held) {
      return;
    }

    this.frame.classList.remove('up');
    this.frame.classList.add('peek');
  }
}
