import type { Action, Focus } from '../../core/input';
import { Bindings } from '../../engine/ui/binding';
import { el } from '../dom';
import { keyText } from '../hud';
import type { Messages } from './messages';
import '../burner.css';
import './phone.css';

/** Real milliseconds the phone stays up after coming up by itself (a text) before it slides back to the edge. */
const HOLD = 9000;
/** How far an app's screen scrolls for each up or down (px). */
const SCROLL = 48;
/** The keys that open apps from the home screen, in order. */
const APP_KEYS: readonly Action[] = ['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7', 'slot8', 'slot9'];

/** An app on the phone: a screen of its own, built once and redrawn while it's showing. */
export interface PhoneApp {
  readonly id: string;
  readonly name: string;
  /** Its icon on the home screen (HTML: an inline SVG). */
  readonly icon: string;
  /** Builds its screen inside `root`, once. */
  mount(root: HTMLElement): void;
  /** Its screen came up (true) or went away (false). */
  shown?(on: boolean): void;
  /** Its screen is up this frame: redraw what changed. */
  update?(): void;
  /** How many things on it Cody hasn't seen yet (new texts), for a badge on its icon. */
  unseen?(): number;
}

/** What the phone reads from the game. */
export interface PhoneStatus {
  /** The time on its status bar. */
  time(): string;
}

/**
 * Cody's phone: Randy's burner. ~ (or the phone button) brings it up on its
 * home screen of apps; it also comes up by itself when Randy texts or calls,
 * and slides back to a strip at the edge after (click or tap that to bring
 * it back). Up in Cody's hand, its keys are its own: 1 to 9 open an app, the
 * arrows or Tab move between them and Enter opens one, Esc goes back and then
 * puts it away. The task right now sits in a line under the clock, phone up or
 * not.
 */
export class Phone {
  /** It sounds off (for the game's 'phone' event): starts ringing, stops ringing, a text lands. */
  onBuzz: ((what: 'ring' | 'hangup' | 'text') => void) | null = null;
  /** The task right now, as shown under the clock (null for none). */
  goalText: string | null = null;
  private readonly frame: HTMLDivElement;
  private readonly badges = new Map<PhoneApp, HTMLElement>();
  private readonly bodies = new Map<PhoneApp, HTMLElement>();
  private readonly icons: HTMLElement[] = [];
  private readonly pages = new Map<PhoneApp, HTMLElement>();
  private readonly home: HTMLElement;
  private readonly goalEl: HTMLDivElement;
  private readonly views = new Bindings();
  /** The app on screen, or null for the home screen. */
  private app: PhoneApp | null = null;
  /** The home screen's highlighted app. */
  private pick = 0;
  /** Cody has it up (he opened it): it stays till he puts it away, and its keys are its own. */
  private held = false;
  private unfocus: (() => void) | null = null;
  private lower = 0;
  /** Its apps, home screen order: Randy's texts first. */
  readonly apps: readonly PhoneApp[];

  constructor(
    hud: HTMLElement,
    private readonly focus: Focus,
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
      const icon = el('button', 'phone-icon', home, `<span class="glyph">${app.icon}</span><span class="name">${app.name}</span>`);
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
      // the wheel scrolls it, not the camera (core/input.ts)
      body.dataset.scroll = '';
      this.bodies.set(app, body);
      app.mount(body);
    });
    const call = el('div', 'burner-call', screen);
    el('div', 'big burner-avatar', call);
    el('div', 'name', call, 'RANDY ROLSEN');
    el('div', 'state', call, 'INCOMING CALL');
    el('div', 'buttons', call, '<i class="no"></i><i class="ok"></i>');
    this.goalEl = el('div', 'burner-goal', hud);
    // back up from the edge for another look
    this.frame.addEventListener('click', () => {
      if (this.frame.classList.contains('peek')) this.open(this.app?.id);
    });
    this.showScreen();
  }

  /** Up (on the home screen, or on app `id`) if it's away, or away if it's up. */
  toggle(id?: string): void {
    if (this.held && (!id || this.app?.id === id)) this.putAway();
    else this.open(id);
  }

  /** Cody brings it up, on app `id` or the home screen. It stays up till he puts it away. */
  open(id?: string): void {
    this.held = true;
    this.raise(false);
    this.go(this.apps.find((a) => a.id === id) ?? null);
    this.unfocus ??= this.focus.add({
      controls: () => this.controls(),
      press: (control) => this.press(control),
    });
  }

  /** Cody puts it away: off the screen, and its keys go back to the world. */
  putAway(): void {
    this.held = false;
    this.unfocus?.();
    this.unfocus = null;
    window.clearTimeout(this.lower);
    this.frame.classList.remove('up', 'peek');
  }

  /** Shows app `id` (a text came in): up by itself for a while if Cody hasn't got it up, then back to the edge. */
  notify(id: string): void {
    if (this.held) return;
    this.go(this.apps.find((a) => a.id === id) ?? null);
    this.raise();
  }

  /** A text from Randy: up comes the phone on his thread (if Cody hasn't got it up), he types, it lands. HTML is allowed, and `{action}` becomes its key cap. */
  text(msg: string): void {
    this.hangUp();
    this.notify('messages');
    this.messages.text(msg);
  }

  /** Randy's face (a data URL), for his contact and the call screen. */
  setAvatar(url: string): void {
    for (const a of this.frame.querySelectorAll<HTMLElement>('.burner-avatar')) a.style.backgroundImage = `url(${url})`;
  }

  /** Randy ringing: the incoming-call screen, the phone up and buzzing, till endCall. */
  call(): void {
    this.frame.classList.add('calling');
    this.onBuzz?.('ring');
    this.raise(false);
  }

  /** The call's over: back to what was on screen, and (unless Cody has it up) back to the edge. */
  endCall(): void {
    this.hangUp();
    if (!this.held) this.peek();
  }

  /** What to do now, under the clock; null clears it. HTML is allowed, and `{action}` becomes its key cap. */
  goal(task: string | null): void {
    this.goalText = task;
    this.goalEl.classList.toggle('on', !!task);
    if (task) this.goalEl.innerHTML = keyText(task);
  }

  /** It buzzes in his hand (a text landed). */
  buzz(): void {
    this.frame.classList.remove('buzz');
    void this.frame.offsetWidth;
    this.frame.classList.add('buzz');
    this.onBuzz?.('text');
  }

  /** Put away for good (the tutorial's over): no call, no goal. */
  close(): void {
    this.hangUp();
    this.putAway();
    this.goal(null);
  }

  /** Once a frame: the status bar, the badges, and the app on screen. */
  update(): void {
    this.views.update();
    for (const [app, badge] of this.badges) {
      const n = app.unseen?.() ?? 0;
      const text = n > 0 ? String(n) : '';
      if (badge.textContent !== text) badge.textContent = text;
    }
    if (this.app && this.frame.classList.contains('up')) this.app.update?.();
  }

  /** Whether app `id` is on screen with the phone up. */
  showing(id: string): boolean {
    return this.app?.id === id && this.frame.classList.contains('up');
  }

  /** The app body for app `id` (where it draws), whether or not it's showing. */
  body(id: string): HTMLElement | null {
    const app = this.apps.find((a) => a.id === id);
    return app ? (this.bodies.get(app) ?? null) : null;
  }

  private controls(): readonly Action[] {
    if (this.app) return ['phone', 'cancel', 'menuUp', 'menuDown'];
    return ['phone', 'cancel', 'menuUp', 'menuDown', 'confirm', ...APP_KEYS.slice(0, this.apps.length)];
  }

  private press(control: Action): void {
    if (control === 'phone') this.putAway();
    else if (control === 'cancel') {
      if (this.app) this.go(null);
      else this.putAway();
    } else if (this.app) {
      const body = this.bodies.get(this.app);
      if (body) body.scrollTop += control === 'menuUp' ? -SCROLL : control === 'menuDown' ? SCROLL : 0;
    } else if (control === 'menuUp' || control === 'menuDown') {
      const n = this.apps.length;
      this.pick = (this.pick + (control === 'menuUp' ? n - 1 : 1)) % n;
      this.showScreen();
    } else if (control === 'confirm') {
      this.go(this.apps[this.pick] ?? null);
    } else {
      const i = APP_KEYS.indexOf(control);
      if (i >= 0) this.go(this.apps[i] ?? null);
    }
  }

  /** App `app` on screen, or the home screen. */
  private go(app: PhoneApp | null): void {
    if (app === this.app) return;
    this.app?.shown?.(false);
    this.app = app;
    if (app) this.pick = Math.max(0, this.apps.indexOf(app));
    app?.shown?.(true);
    this.showScreen();
  }

  private showScreen(): void {
    this.frame.dataset.screen = this.app?.id ?? 'home';
    this.home.classList.toggle('on', !this.app);
    for (const [app, page] of this.pages) page.classList.toggle('on', app === this.app);
    this.icons.forEach((icon, i) => icon.classList.toggle('picked', i === this.pick));
  }

  private hangUp(): void {
    if (!this.frame.classList.contains('calling')) return;
    this.frame.classList.remove('calling');
    this.onBuzz?.('hangup');
  }

  /** Pan the phone in, and (unless `lower` is off) back to the edge after a while. */
  private raise(lower = true): void {
    this.frame.classList.remove('peek');
    this.frame.classList.add('up');
    window.clearTimeout(this.lower);
    if (lower) this.lower = window.setTimeout(() => this.peek(), HOLD);
  }

  private peek(): void {
    window.clearTimeout(this.lower);
    if (this.held) return;
    this.frame.classList.remove('up');
    this.frame.classList.add('peek');
  }
}
