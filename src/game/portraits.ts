import type { WebGLRenderer } from 'three';
import type { CharacterModel } from '../actors/models/character';
import { buildRandy } from '../actors/models/randy';
import { renderPortrait } from '../render/portrait';

export interface Portraits {
  randy: string;
  cody: string;
  codyNight: string;
}

/** Each portrait's side, in pixels. */
const SIZE = 256;

/**
 * The dialogue portraits, as PNG data URLs: Randy (coat closed, on the left,
 * looking right) and Cody by day and by night (on the right, looking left).
 * `cody` makes a fresh Cody model to pose (the game's assets.character()).
 */
export function makePortraits(renderer: WebGLRenderer, cody: () => CharacterModel): Portraits {
  const randy = buildRandy();
  const c = cody();
  c.setForm('day');
  c.animate(0, 0, true);
  const day = renderPortrait(renderer, c.root, 'left', SIZE);
  c.setForm('night');
  c.animate(0, 0, true);
  const night = renderPortrait(renderer, c.root, 'left', SIZE);
  return { randy: renderPortrait(renderer, randy.root, 'right', SIZE), cody: day, codyNight: night };
}
