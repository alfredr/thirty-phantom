import { clamp } from '@/engine/core/math';

/** Each control's keys (KeyboardEvent codes), by control. The first is the one a HUD shows. */
export type KeyTable<C extends string> = Readonly<Record<C, readonly [string, ...string[]]>>;

/** The controls a touch stick pushes, one per direction. */
export interface StickControls<C extends string> {
  readonly left: C;
  readonly right: C;
  readonly forward: C;
  readonly back: C;
}

/** Keys whose browser default (scrolling, moving focus) the game never wants. */
const BLOCKED = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab']);
/** The details of a key press that a focus layer may care about. */
export interface KeyPress {
  readonly repeat: boolean;
  readonly shift: boolean;
}

/**
 * Something that takes keys before the world does: a conversation, a sign, a menu, a shop. It says which controls it
 * takes right now; the top layer that takes a key's control gets the press, and the world never sees that key.
 */
export interface FocusLayer<C extends string> {
  controls(): readonly C[];
  press(control: C, key: KeyPress): void;
}

/** The stack of focus layers, newest on top. Input offers every key press to it first. */
export class Focus<C extends string> {
  private readonly layers: FocusLayer<C>[] = [];

  constructor(private readonly keys: KeyTable<C>) {}

  /** Adds a layer above the others. The returned function removes it. */
  add(layer: FocusLayer<C>): () => void {
    this.layers.push(layer);

    return () => {
      const i = this.layers.indexOf(layer);
      if (i >= 0) {
        this.layers.splice(i, 1);
      }
    };
  }

  /** Whether any layer takes `control` right now, so the world shouldn't offer anything for it. */
  owns(control: C): boolean {
    return this.layers.some((layer) => layer.controls().includes(control));
  }

  /** Offers a key press to the layers, top first. True if a layer took it. */
  route(code: string, key: KeyPress): boolean {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i];
      const control = layer?.controls().find((c) => this.keys[c].some((k) => k === code));
      if (layer && control) {
        layer.press(control, key);
        return true;
      }
    }

    return false;
  }
}

/** Key caps for codes whose name isn't what's printed on the key. */
const CAPS: Readonly<Record<string, string>> = { Backquote: '~', Escape: 'ESC' };

/** What's printed on a key: KeyF -> F, ShiftLeft -> SHIFT, Space -> SPACE, Backquote -> ~. */
export function keyCap(code: string): string {
  return CAPS[code] ?? code.replace(/^Key|Left$|Right$/g, '').toUpperCase();
}

/** Keyboard + wheel state with per-frame edge detection, read by control (see KeyTable). */
export class Input<C extends string> {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private wheel = 0;
  private mouseX = 0;
  private mouseY = 0;
  private lockEl: HTMLElement | null = null;
  private dragging = false;
  /**
   * A cutscene has the controls: every read comes back empty (keys, stick, mouse, wheel). Focus layers still get their
   * keys.
   */
  muted = false;
  /** Conversations, signs and menus, which take keys before the world. */
  readonly focus: Focus<C>;
  /** Analog stick (touch): x to the right, y forward, each -1..1. axis() adds it to the keys. */
  private stickX = 0;
  private stickY = 0;

  constructor(
    private readonly keys: KeyTable<C>,
    private readonly stick: StickControls<C>,
  ) {
    this.focus = new Focus(keys);
    window.addEventListener('keydown', (e) => {
      if (BLOCKED.has(e.code)) {
        e.preventDefault();
      }

      // A conversation, sign or menu that takes this key gets it, and the world doesn't.
      if (this.focus.route(e.code, { repeat: e.repeat, shift: e.shiftKey })) {
        e.preventDefault();
        return;
      }

      if (!e.repeat) {
        this.pressed.add(e.code);
      }

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
        // over something on the HUD that scrolls (the phone's screen), the wheel scrolls it rather than zooming
        if (e.target instanceof Element && e.target.closest('[data-scroll]')) {
          return;
        }

        this.wheel += Math.sign(e.deltaY);
        e.preventDefault();
      },
      { passive: false },
    );
  }

  isDown(control: C): boolean {
    return !this.muted && this.keys[control].some((c) => this.down.has(c));
  }

  wasPressed(control: C): boolean {
    return !this.muted && this.keys[control].some((c) => this.pressed.has(c));
  }

  axis(neg: C, pos: C): number {
    if (this.muted) {
      return 0;
    }

    const keys = (this.isDown(pos) ? 1 : 0) - (this.isDown(neg) ? 1 : 0);
    return clamp(keys + this.analog(pos) - this.analog(neg), -1, 1);
  }

  /** How far the stick pushes toward one of its controls, 0..1. */
  private analog(c: C): number {
    const s = this.stick;
    if (c === s.right) {
      return Math.max(0, this.stickX);
    }

    if (c === s.left) {
      return Math.max(0, -this.stickX);
    }

    if (c === s.forward) {
      return Math.max(0, this.stickY);
    }

    if (c === s.back) {
      return Math.max(0, -this.stickY);
    }

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
   * Mouse look on `el`. A click captures the pointer while `wantLock()` holds (Esc releases it); dragging with the left
   * button also looks, for browsers that refuse the capture.
   */
  attachPointer(el: HTMLElement, wantLock: () => boolean): void {
    this.lockEl = el;
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !wantLock()) {
        return;
      }

      this.dragging = true;

      // older browsers return nothing here; newer ones reject if the user backs out of the capture
      if (document.pointerLockElement !== el) {
        void Promise.resolve(el.requestPointerLock()).catch(() => undefined);
      }
    });
    window.addEventListener('mouseup', () => (this.dragging = false));
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== el && !this.dragging) {
        return;
      }

      // Chrome can report one huge jump right after the capture starts
      this.mouseX += clamp(e.movementX, -200, 200);
      this.mouseY += clamp(e.movementY, -200, 200);
    });
  }

  releasePointer(): void {
    this.dragging = false;

    if (this.lockEl && document.pointerLockElement === this.lockEl) {
      document.exitPointerLock();
    }
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

  /**
   * A press from outside the keyboard (a tap on a key cap, a test, the debug console), routed like a key: open layers
   * first. Takes key codes ('KeyW'), not controls.
   */
  press(code: string): void {
    if (this.focus.route(code, { repeat: false, shift: false })) {
      return;
    }

    this.pressed.add(code);
  }

  hold(code: string, isDown: boolean): void {
    if (isDown) {
      this.down.add(code);
    } else {
      this.down.delete(code);
    }
  }
}
