import { keyCap, type StickControls } from '@/engine/input/input';

const SHIFT: [string, string] = ['ShiftLeft', 'ShiftRight'];

/** Keyboard bindings by control. The HUD displays the first binding. */
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
  /** Open the inventory or advance its selection. */
  inventory: ['KeyI'],
  /** Toggle the phone panel. */
  phone: ['Backquote'],
  summon: ['KeyX'],
  /** Hold to spend GhASt on a monster truck boost. */
  boost: ['KeyB'],
  rotateLeft: ['KeyQ'],
  rotateRight: ['KeyE'],
  camera: ['KeyC'],
  help: ['KeyH'],
  map: ['KeyM'],
  /** Toggle sound; src/audio/ reads this binding directly. */
  mute: ['KeyK'],
  fastForward: ['KeyT'],
  nextPhase: ['KeyN'],
  start: ['Enter', 'Space'],
  reset: ['KeyR'],
  // Reload a pending development update. R resets a stuck vehicle instead while the reset prompt shows.
  reload: ['KeyR'],
  // Focus layers reserve these controls for open menus and panels.
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

/** A named keyboard action. */
export type Control = keyof typeof KEYS;

export function isControl(name: string): name is Control {
  return Object.hasOwn(KEYS, name);
}

/** Movement actions driven by the touch stick. */
export const STICK: StickControls<Control> = {
  left: 'left',
  right: 'right',
  forward: 'forward',
  back: 'back',
};

/** Return the display label for the primary binding. */
export function keyName(control: Control): string {
  return keyCap(KEYS[control][0]);
}
