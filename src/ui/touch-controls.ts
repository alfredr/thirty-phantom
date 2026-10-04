import { urlFlag } from '@/engine/core/url-flags';
import type { Input } from '@/engine/input/input';
import { el } from '@/engine/ui/dom';
import { type Control, isControl, KEYS } from '@/game/controls';
import './touch.css';

/** Phones and tablets (a coarse pointer), or ?touch to try the controls with a mouse. */
export function wantsTouch(): boolean {
  return urlFlag('touch') || matchMedia('(pointer: coarse)').matches;
}

/** How far the stick's knob travels from where the thumb came down (px), and its dead zone (0..1). */
const STICK_REACH = 52;
const DEAD_ZONE = 0.12;
/** Thumbs that land left of this share of the screen width drive the stick; the rest look and pinch. */
const STICK_SIDE = 0.45;
/** Drag to look: screen pixels to mouse-look pixels. */
const LOOK_GAIN = 1.6;
/** Pinch: change in finger spread (px) per zoom step. */
const PINCH_STEP = 36;

interface ButtonSpec {
  action: Control;
  /** Big glyph, and an optional caption under it. */
  glyph: string;
  caption?: string;
  cls: string;
}

/** Actions the stick does rather than a button. */
const STICK: ReadonlySet<Control> = new Set<Control>(['forward', 'back', 'left', 'right']);

const BUTTONS: readonly ButtonSpec[] = [
  { action: 'interact', glyph: 'F', caption: 'USE', cls: 'use' },
  { action: 'hop', glyph: 'HOP', cls: 'hop' },
  { action: 'run', glyph: 'RUN', caption: 'DRIFT', cls: 'run' },
  { action: 'summon', glyph: '☠', cls: 'small summon' },
  { action: 'boost', glyph: 'BOOST', cls: 'small boost' },
  { action: 'rotateLeft', glyph: '↺', cls: 'small rot-l' },
  { action: 'camera', glyph: 'CAM', cls: 'small cam' },
  { action: 'phone', glyph: '☎', cls: 'small phone' },
  { action: 'rotateRight', glyph: '↻', cls: 'small rot-r' },
];

/** The on-screen button for `action` (the one sending its key, so drift finds RUN), for key caps in HUD text. */
export function touchGlyph(action: Control): string | undefined {
  if (STICK.has(action)) return 'STICK';
  return BUTTONS.find((b) => KEYS[b.action][0] === KEYS[action][0])?.glyph;
}

/**
 * On-screen controls for touch screens, all fed through Input like the keyboard:
 * - a stick under the left thumb, wherever it lands (walk; throttle and steer)
 * - buttons under the right thumb (F use, hop, run / drift, summon on foot, boost in the truck, camera, iso rotate)
 * - drag anywhere else to look (chase view), pinch to zoom
 * - the prompt and speech-bubble choices can be tapped
 * - driving is always in the chase view (game.ts), and CAM switches top-down / chase on foot
 * Off on the title screen, which takes a tap to start. In portrait, a card asks for landscape;
 * turned sideways, where the browser allows it, a card offers fullscreen (it needs that tap).
 */
export class TouchControls {
  readonly root: HTMLDivElement;
  private readonly pad: HTMLDivElement;
  private readonly base: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private stickId = -1;
  private stickX0 = 0;
  private stickY0 = 0;
  /** Fingers dragging to look or pinching, by pointer id. */
  private readonly looks = new Map<number, { x: number; y: number }>();
  private spread = 0;
  private readonly fullCard: HTMLDivElement;
  private readonly fullButton: HTMLDivElement;
  /** "Not now" on the fullscreen card: only the corner button offers it after that. */
  private fullDismissed = false;
  /** iPhones: the home screen is their only fullscreen, so this card says how, once. */
  private readonly homeCard: HTMLDivElement;
  private homeSeen = remembered(HOME_HINT_KEY);

  constructor(private readonly input: Input<Control>) {
    document.body.classList.add('touch');
    this.root = el('div', 'touch', document.body);
    this.pad = el('div', 'touch-pad', this.root);
    this.base = el('div', 'touch-stick', this.root);
    this.knob = el('div', 'touch-knob', this.base);
    const buttons = el('div', 'touch-buttons', this.root);
    for (const b of BUTTONS) this.button(buttons, b);
    const rotate = el('div', 'touch-rotate', document.body);
    el('div', 'phone', rotate);
    el('div', 'say', rotate, 'TURN YOUR PHONE<br>SIDEWAYS');
    this.fullCard = el('div', 'touch-full', document.body);
    const go = el('div', 'go', this.fullCard, 'GO FULLSCREEN');
    el('div', 'why', this.fullCard, 'PLAY WITHOUT THE BROWSER BARS');
    const later = el('div', 'later', this.fullCard, 'not now');
    this.fullButton = el('div', 'touch-full-btn', document.body, 'FULLSCREEN');
    go.addEventListener('click', () => void goFullscreen());
    // where pages can't go fullscreen (iPhones), the corner button brings back the home-screen how-to
    this.fullButton.addEventListener('click', () => {
      if (canFullscreen()) void goFullscreen();
      else {
        this.homeSeen = false;
        this.syncFullscreen();
      }
    });
    later.addEventListener('click', () => {
      this.fullDismissed = true;
      this.syncFullscreen();
    });
    this.homeCard = el('div', 'touch-full home', document.body);
    el('div', 'head', this.homeCard, 'PLAY WITHOUT THE BROWSER BARS');
    el(
      'ol',
      'steps',
      this.homeCard,
      `<li>TAP <b>SHARE</b> ${SHARE_ICON} <span>(UNDER <b>•••</b> IF IT'S NOT THERE)</span></li>` +
        '<li>PICK <b>ADD TO HOME SCREEN</b></li>' +
        '<li>START <b>PHANTOM CODYS</b> FROM ITS NEW ICON</li>',
    );
    const gotIt = el('div', 'go', this.homeCard, 'GOT IT');
    gotIt.addEventListener('click', () => {
      this.homeSeen = true;
      remember(HOME_HINT_KEY);
      this.syncFullscreen();
    });
    document.addEventListener('fullscreenchange', () => this.syncFullscreen());
    matchMedia('(orientation: landscape)').addEventListener('change', () => this.syncFullscreen());
    this.syncFullscreen();

    this.pad.addEventListener('pointerdown', (e) => this.padDown(e));
    this.pad.addEventListener('pointermove', (e) => this.padMove(e));
    for (const t of ['pointerup', 'pointercancel'] as const) this.pad.addEventListener(t, (e) => this.padUp(e));
    // the prompt and the speech bubble's choices: a tap does what they say
    document.addEventListener('pointerdown', (e) => {
      const t = (e.target as Element | null)?.closest<HTMLElement>('#hud [data-action]');
      const action = t?.dataset.action;
      if (action && isControl(action)) this.input.press(KEYS[action][0]);
    });
    this.followMode();
  }

  private button(parent: HTMLElement, b: ButtonSpec): void {
    const btn = el('div', `touch-btn ${b.cls}`, parent, `<b>${b.glyph}</b>${b.caption ? `<i>${b.caption}</i>` : ''}`);
    const code = KEYS[b.action][0];
    const release = (): void => {
      btn.classList.remove('on');
      this.input.hold(code, false);
    };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      btn.classList.add('on');
      this.input.press(code);
      this.input.hold(code, true);
    });
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
  }

  private padDown(e: PointerEvent): void {
    e.preventDefault();
    this.pad.setPointerCapture(e.pointerId);
    if (this.stickId < 0 && e.clientX < innerWidth * STICK_SIDE) {
      this.stickId = e.pointerId;
      this.stickX0 = e.clientX;
      this.stickY0 = e.clientY;
      this.base.style.left = `${e.clientX}px`;
      this.base.style.top = `${e.clientY}px`;
      this.base.classList.add('on');
      this.knob.style.transform = '';
      return;
    }
    this.looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.looks.size === 2) this.spread = this.fingerSpread();
  }

  private padMove(e: PointerEvent): void {
    if (e.pointerId === this.stickId) {
      let dx = (e.clientX - this.stickX0) / STICK_REACH;
      let dy = (e.clientY - this.stickY0) / STICK_REACH;
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        dx /= len;
        dy /= len;
      }
      this.knob.style.transform = `translate(${dx * STICK_REACH}px, ${dy * STICK_REACH}px)`;
      // screen up is forward; inside the dead zone the stick rests
      const resting = Math.min(1, len) < DEAD_ZONE;
      this.input.setStick(resting ? 0 : dx, resting ? 0 : -dy);
      return;
    }
    const p = this.looks.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.looks.size >= 2) {
      // spreading the fingers zooms in, as the wheel does rolled forward
      const s = this.fingerSpread();
      while (s - this.spread > PINCH_STEP) {
        this.input.zoom(-1);
        this.spread += PINCH_STEP;
      }
      while (this.spread - s > PINCH_STEP) {
        this.input.zoom(1);
        this.spread -= PINCH_STEP;
      }
      return;
    }
    this.input.look(dx * LOOK_GAIN, dy * LOOK_GAIN);
  }

  private padUp(e: PointerEvent): void {
    if (e.pointerId === this.stickId) {
      this.stickId = -1;
      this.input.setStick(0, 0);
      this.base.classList.remove('on');
      return;
    }
    this.looks.delete(e.pointerId);
    if (this.looks.size === 2) this.spread = this.fingerSpread();
  }

  private fingerSpread(): number {
    const [a, b] = [...this.looks.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  /**
   * Mirror the HUD's mode (title / foot / drive): the controls hide on the title screen, and the
   * buttons for one mode only (boost in the truck) follow it; summon shows while Cody can summon.
   */
  private followMode(): void {
    const hud = document.getElementById('hud');
    if (!hud) return;
    const sync = (): void => {
      this.root.dataset.mode = hud.dataset.mode ?? '';
      this.root.dataset.summon = hud.dataset.summon ?? '';
    };
    new MutationObserver(sync).observe(hud, { attributes: true, attributeFilter: ['data-mode', 'data-summon'] });
    sync();
  }

  /** Offer fullscreen when it's possible and not on yet: the card once held sideways, then the corner button. */
  private syncFullscreen(): void {
    // been fullscreen once: leaving it gets the corner button, not the card again
    if (document.fullscreenElement) this.fullDismissed = true;
    const landscape = matchMedia('(orientation: landscape)').matches;
    const offer = canFullscreen() && !document.fullscreenElement && landscape;
    // Apple phones: only the home screen gets rid of the bars, so the card says how (and the corner button asks again)
    const home = !canFullscreen() && isAppleMobile() && !isHomeScreenApp() && landscape;
    this.fullCard.classList.toggle('on', offer && !this.fullDismissed);
    this.homeCard.classList.toggle('on', home && !this.homeSeen);
    this.fullButton.classList.toggle('on', (offer && this.fullDismissed) || (home && this.homeSeen));
  }
}

const HOME_HINT_KEY = '30pc.homeHint';

/** Mobile Safari (iPhone, iPad) is the browser that knows navigator.standalone. */
function isAppleMobile(): boolean {
  return 'standalone' in navigator;
}

/** Started from the home screen: no browser bars to get rid of. */
function isHomeScreenApp(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
}

function remembered(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function remember(key: string): void {
  try {
    localStorage.setItem(key, '1');
  } catch {
    // storage blocked: the hint comes back next visit
  }
}

/**
 * Android browsers and iPads can put a page fullscreen. iPhones can't (every iPhone browser is
 * Safari underneath), though some report fullscreenEnabled anyway, and the request does nothing.
 */
function canFullscreen(): boolean {
  if (/iPhone|iPod/.test(navigator.userAgent)) return false;
  return document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === 'function';
}

/** Safari's share button: a box with an arrow up out of it. */
const SHARE_ICON =
  '<svg class="share" viewBox="0 0 20 24"><path d="M10 15V2M5.5 6.5 10 2l4.5 4.5M6.5 10H3v12h14V10h-3.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Fullscreen, held in landscape where the browser lets a page lock it. Must run inside a tap. */
async function goFullscreen(): Promise<void> {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
    await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape');
  } catch {
    // not allowed here: the rotate card still asks for landscape
  }
}
