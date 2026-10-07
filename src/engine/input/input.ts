import { type Release, releaseOnce } from '@/engine/core/disposable';
import { clamp } from '@/engine/core/math';

/** KeyboardEvent codes for each control. The first code supplies its HUD label. */
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
 * Reserve controls for a UI surface. The topmost layer accepting a key receives its press before world input is
 * updated. controls() may change with the layer’s current state.
 */
export interface FocusLayer<C extends string> {
  controls(): readonly C[];
  press(control: C, key: KeyPress): void;
}

/** The stack of focus layers, newest on top. Input offers every key press to it first. */
export class Focus<C extends string> {
  private readonly layers: { layer: FocusLayer<C> }[] = [];

  constructor(private readonly keys: KeyTable<C>) {}

  /** Adds a layer above the others. The returned function removes it. */
  add(layer: FocusLayer<C>): Release {
    const entry = { layer };
    this.layers.push(entry);

    return releaseOnce(() => {
      const i = this.layers.indexOf(entry);
      if (i >= 0) {
        this.layers.splice(i, 1);
      }
    });
  }

  /** Return whether a focus layer currently reserves this control. */
  owns(control: C): boolean {
    return this.layers.some(({ layer }) => layer.controls().includes(control));
  }

  /** Dispatch to the topmost layer accepting this key. Return whether the press was handled. */
  route(code: string, key: KeyPress): boolean {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i]?.layer;
      const control = layer?.controls().find((c) => this.keys[c].some((k) => k === code));
      if (layer && control) {
        layer.press(control, key);
        return true;
      }
    }

    return false;
  }
}

/** Display labels for key codes that need explicit mapping. */
const CAPS: Readonly<Record<string, string>> = { Backquote: '~', Escape: 'ESC' };

/** Convert a KeyboardEvent code into a display label, such as KeyF → F or ShiftLeft → SHIFT. */
export function keyCap(code: string): string {
  return CAPS[code] ?? code.replace(/^Key|Left$|Right$/g, '').toUpperCase();
}

/** Keyboard, pointer, wheel, and touch input with per-frame key press detection. */
export class Input<C extends string> {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private wheel = 0;
  private mouseX = 0;
  private mouseY = 0;
  private lockEl: HTMLElement | null = null;
  private dragging = false;
  /** Suppress world input reads while preserving focus-layer key dispatch, such as during cutscenes. */
  muted = false;
  /** UI layers that receive key presses before world controls. */
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

      // Consumed key presses must not enter world input state.
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
        // Preserve native scrolling inside HUD scroll regions.
        // Event targets can be non-elements; check before calling closest().
        // oxlint-disable-next-line phantom/no-instanceof
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

  /** Return the stick component for a direction, or zero for an unrelated control. */
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

  /** Set touch stick components in [-1, 1]: x points right and y points forward. Use (0, 0) on release. */
  setStick(x: number, y: number): void {
    this.stickX = x;
    this.stickY = y;
  }

  /** Accumulate pointer movement in pixels, including touch drags. */
  look(dx: number, dy: number): void {
    this.mouseX += dx;
    this.mouseY += dy;
  }

  /** Accumulate zoom steps. Positive values zoom out. */
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

      // Support both void and Promise results, including rejected pointer lock requests.
      if (document.pointerLockElement !== el) {
        void Promise.resolve(el.requestPointerLock()).catch(() => undefined);
      }
    });
    window.addEventListener('mouseup', () => (this.dragging = false));
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== el && !this.dragging) {
        return;
      }

      // Limit spurious movement reported when pointer lock begins.
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
   * Inject a key press through the focus stack. Accept a KeyboardEvent code such as 'KeyW', not a control name.
   * Unconsumed presses last until endFrame() and do not change held-key state.
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
