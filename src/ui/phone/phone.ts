import type { Focus } from '@/engine/input/input';
import { Bindings } from '@/engine/ui/binding';
import { el } from '@/engine/ui/dom';
import type { Control } from '@/game/controls';

import '@/ui/burner.css';
import { keyText } from '@/ui/hud';

import type { Messages } from './messages';

import './phone.css';

/** Wall-clock delay in milliseconds before an automatic notification retracts to the screen edge. */
const HOLD = 9000;
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
}

/** What the phone reads from the game. */
export interface PhoneStatus {
  /** The time on its status bar. */
  time(): string;
  /** The current task, or null. */
  goal(): string | null;
}

/**
 * Manage the burner phone’s applications, notifications, and call screen. Manual opening holds the phone onscreen and
 * reserves navigation controls. Automatic notifications retract to an edge tab after HOLD; calls remain raised until
 * ended. The current task appears separately beneath the HUD clock.
 */
export class Phone {
  /** Notify the game when ringing starts, ringing stops, or a text arrives. */
  onBuzz: ((what: 'ring' | 'hangup' | 'text') => void) | null = null;
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
  private lower = 0;
  /** Applications in home-screen order, with messages first. */
  readonly apps: readonly PhoneApp[];

  constructor(
    hud: HTMLElement,
    private readonly focus: Focus<Control>,
    status: PhoneStatus,
    readonly messages: Messages,
    others: readonly PhoneApp[],
  ) {
    const apps = [messages, ...others];
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
    this.views.add({
      read: () => status.goal(),
      draw: (task) => {
        goal.classList.toggle('on', !!task);
        goal.innerHTML = task ? keyText(task) : '';
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
    this.raise(false);
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
    window.clearTimeout(this.lower);
    this.frame.classList.remove('up', 'peek');
  }

  /** Show a notification app temporarily unless the phone is manually held. */
  notify(id: string): void {
    if (this.held) {
      return;
    }

    this.go(this.apps.find((a) => a.id === id) ?? null);
    this.raise();
  }

  /** End any call, optionally raise Messages, and queue HTML text with `{action}` key-cap placeholders. */
  text(msg: string): void {
    this.hangUp();
    this.notify('messages');
    this.messages.text(msg);
  }

  /** Randy's face (a data URL), for his contact and the call screen. */
  setAvatar(url: string): void {
    for (const a of this.frame.querySelectorAll<HTMLElement>('.burner-avatar')) {
      a.style.backgroundImage = `url(${url})`;
    }
  }

  /** Raise the incoming-call screen and start ringing without automatic retraction. */
  call(): void {
    this.frame.classList.add('calling');
    this.onBuzz?.('ring');
    this.raise(false);
  }

  /** End ringing and restore the previous screen. Retract to the edge unless the phone is manually held. */
  endCall(): void {
    this.hangUp();

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
    this.putAway();
  }

  /** Refresh status bindings and unread badges, then update the selected app if the phone is raised. */
  update(): void {
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
      return ['phone', 'cancel', 'menuUp', 'menuDown'];
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

    app?.shown?.(true);
    this.showScreen();
  }

  private showScreen(): void {
    this.frame.dataset.screen = this.app?.id ?? 'home';
    this.home.classList.toggle('on', !this.app);

    for (const [app, page] of this.pages) {
      page.classList.toggle('on', app === this.app);
    }

    this.icons.forEach((icon, i) => icon.classList.toggle('picked', i === this.pick));
  }

  private hangUp(): void {
    if (!this.frame.classList.contains('calling')) {
      return;
    }

    this.frame.classList.remove('calling');
    this.onBuzz?.('hangup');
  }

  /** Raise the phone and optionally schedule edge retraction after HOLD milliseconds. */
  private raise(lower = true): void {
    this.frame.classList.remove('peek');
    this.frame.classList.add('up');
    window.clearTimeout(this.lower);

    if (lower) {
      this.lower = window.setTimeout(() => this.peek(), HOLD);
    }
  }

  private peek(): void {
    window.clearTimeout(this.lower);

    if (this.held) {
      return;
    }

    this.frame.classList.remove('up');
    this.frame.classList.add('peek');
  }
}
