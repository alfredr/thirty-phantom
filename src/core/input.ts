import { clamp } from './math';

const BLOCKED = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab']);
const SHIFT: [string, string] = ['ShiftLeft', 'ShiftRight'];

/** Every key the game reads, by action. The first code is the one the HUD shows. */
export const KEYS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  run: SHIFT,
  drift: SHIFT,
  hop: ['Space'],
  interact: ['KeyF'],
  pay: ['KeyG'],
  /** Opens the item menu, and steps through it while it's open. */
  inventory: ['KeyI'],
  summon: ['KeyX'],
  /** Hold in the monster truck: burn GhASt for a boost. */
  boost: ['KeyB'],
  rotateLeft: ['KeyQ'],
  rotateRight: ['KeyE'],
  camera: ['KeyC'],
  help: ['KeyH'],
  /** Sound on and off (src/audio/ reads it straight off the keyboard). */
  mute: ['KeyM'],
  fastForward: ['KeyT'],
  nextPhase: ['KeyN'],
  start: ['Enter', 'Space'],
  // dev: only does anything while a code change is waiting
  reload: ['KeyR'],
  // Menus and panels take these while they're open, through focus layers.
  menuUp: ['ArrowUp'],
  menuDown: ['ArrowDown', 'Tab'],
  cancel: ['Escape'],
  confirm: ['Enter'],
  slot1: ['Digit1'],
  slot2: ['Digit2'],
  slot3: ['Digit3'],
  slot4: ['Digit4'],
  slot5: ['Digit5'],
  slot6: ['Digit6'],
  slot7: ['Digit7'],
  slot8: ['Digit8'],
  slot9: ['Digit9'],
} satisfies Record<string, [string, ...string[]]>;

export type Action = keyof typeof KEYS;

export function isAction(name: string): name is Action {
  return Object.hasOwn(KEYS, name);
}

/** The details of a key press that a focus layer may care about. */
export interface KeyPress {
  readonly repeat: boolean;
  readonly shift: boolean;
}

/**
 * Something that takes keys before the world does: a conversation, a sign, a menu, a shop. It
 * says which controls it takes right now; the top layer that takes a key's control gets the
 * press, and the world never sees that key.
 */
export interface FocusLayer {
  controls(): readonly Action[];
  press(control: Action, key: KeyPress): void;
}

/** The stack of focus layers, newest on top. Input offers every key press to it first. */
export class Focus {
  private readonly layers: FocusLayer[] = [];

  /** Adds a layer above the others. The returned function removes it. */
  add(layer: FocusLayer): () => void {
    this.layers.push(layer);
    return () => {
      const i = this.layers.indexOf(layer);
      if (i >= 0) this.layers.splice(i, 1);
    };
  }

  /** Whether any layer takes `control` right now, so the world shouldn't offer anything for it. */
  owns(control: Action): boolean {
    return this.layers.some((layer) => layer.controls().includes(control));
  }

  /** Offers a key press to the layers, top first. True if a layer took it. */
  route(code: string, key: KeyPress): boolean {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i];
      const control = layer?.controls().find((c) => KEYS[c].some((k) => k === code));
      if (layer && control) {
        layer.press(control, key);
        return true;
      }
    }
    return false;
  }
}

/** How the HUD names an action's key: KeyF -> F, ShiftLeft -> SHIFT, Space -> SPACE. */
export function keyName(action: Action): string {
  return KEYS[action][0].replace(/^Key|Left$|Right$/g, '').toUpperCase();
}

/** Keyboard + wheel state with per-frame edge detection, read by action (see KEYS). */
export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private wheel = 0;
  private mouseX = 0;
  private mouseY = 0;
  private lockEl: HTMLElement | null = null;
  private dragging = false;
  /** A cutscene has the controls: every read comes back empty (keys, stick, mouse, wheel). Focus layers still get their keys. */
  muted = false;
  /** Conversations, signs and menus, which take keys before the world. */
  readonly focus = new Focus();
  /** Analog stick (touch): x to the right, y forward, each -1..1. axis() adds it to the keys. */
  private stickX = 0;
  private stickY = 0;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (BLOCKED.has(e.code)) e.preventDefault();
      // A conversation, sign or menu that takes this key gets it, and the world doesn't.
      if (this.focus.route(e.code, { repeat: e.repeat, shift: e.shiftKey })) {
        e.preventDefault();
        return;
      }
      if (!e.repeat) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => {
      this.down.clear();
      this.dragging = false;
    });
    window.addEventListener(
      'wheel',
      (e) => {
        this.wheel += Math.sign(e.deltaY);
        e.preventDefault();
      },
      { passive: false },
    );
  }

  isDown(action: Action): boolean {
    return !this.muted && KEYS[action].some((c) => this.down.has(c));
  }

  wasPressed(action: Action): boolean {
    return !this.muted && KEYS[action].some((c) => this.pressed.has(c));
  }

  axis(neg: Action, pos: Action): number {
    if (this.muted) return 0;
    const keys = (this.isDown(pos) ? 1 : 0) - (this.isDown(neg) ? 1 : 0);
    return clamp(keys + this.analog(pos) - this.analog(neg), -1, 1);
  }

  /** How far the stick pushes toward a movement action, 0..1. */
  private analog(a: Action): number {
    if (a === 'right') return Math.max(0, this.stickX);
    if (a === 'left') return Math.max(0, -this.stickX);
    if (a === 'forward') return Math.max(0, this.stickY);
    if (a === 'back') return Math.max(0, -this.stickY);
    return 0;
  }

  /** Touch stick: x to the right, y forward, each -1..1 (0, 0 when let go). */
  setStick(x: number, y: number): void {
    this.stickX = x;
    this.stickY = y;
  }

  /** Look around by this many pixels, as if the mouse moved (touch drag). */
  look(dx: number, dy: number): void {
    this.mouseX += dx;
    this.mouseY += dy;
  }

  /** Zoom by wheel steps: positive zooms out (pinch). */
  zoom(steps: number): void {
    this.wheel += steps;
  }

  /**
   * Mouse look on `el`. A click captures the pointer while `wantLock()` holds (Esc releases it);
   * dragging with the left button also looks, for browsers that refuse the capture.
   */
  attachPointer(el: HTMLElement, wantLock: () => boolean): void {
    this.lockEl = el;
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !wantLock()) return;
      this.dragging = true;
      // older browsers return nothing here; newer ones reject if the user backs out of the capture
      if (document.pointerLockElement !== el) void Promise.resolve(el.requestPointerLock()).catch(() => undefined);
    });
    window.addEventListener('mouseup', () => (this.dragging = false));
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== el && !this.dragging) return;
      // Chrome can report one huge jump right after the capture starts
      this.mouseX += clamp(e.movementX, -200, 200);
      this.mouseY += clamp(e.movementY, -200, 200);
    });
  }

  releasePointer(): void {
    this.dragging = false;
    if (this.lockEl && document.pointerLockElement === this.lockEl) document.exitPointerLock();
  }

  /** Mouse movement in pixels since the last call. */
  consumeMouse(): [number, number] {
    const m: [number, number] = this.muted ? [0, 0] : [this.mouseX, this.mouseY];
    this.mouseX = 0;
    this.mouseY = 0;
    return m;
  }

  consumeWheel(): number {
    const w = this.muted ? 0 : this.wheel;
    this.wheel = 0;
    return w;
  }

  endFrame(): void {
    this.pressed.clear();
  }

  /** A press from outside the keyboard (a tap on a key cap, a test, the debug console), routed like a key: open layers first. Takes key codes ('KeyW'), not actions. */
  press(code: string): void {
    if (this.focus.route(code, { repeat: false, shift: false })) return;
    this.pressed.add(code);
  }

  hold(code: string, isDown: boolean): void {
    if (isDown) this.down.add(code);
    else this.down.delete(code);
  }
}
