import { keyCap, type StickControls } from '@/engine/input/input';

const SHIFT: [string, string] = ['ShiftLeft', 'ShiftRight'];

/** Every key the game reads, by control. The first code is the one the HUD shows. */
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
  /** Brings Cody's phone up, and puts it away again. */
  phone: ['Backquote'],
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

/** Something the player does with a key: walk forward, interact, open the phone. */
export type Control = keyof typeof KEYS;

export function isControl(name: string): name is Control {
  return Object.hasOwn(KEYS, name);
}

/** The controls the touch stick pushes. */
export const STICK: StickControls<Control> = { left: 'left', right: 'right', forward: 'forward', back: 'back' };

/** How the HUD names a control's key: F, SHIFT, SPACE, ~. */
export function keyName(control: Control): string {
  return keyCap(KEYS[control][0]);
}
