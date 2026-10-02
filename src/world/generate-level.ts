import { blockRect, generateCity } from './gen-city';
import { generateDeck } from './gen-deck';
import { generateLandscape } from './gen-landscape';
import type { LevelData } from './level-data';
import { LevelWriter } from './level-writer';

/** The default level: a 3x3 block city with the haunted deck in the middle block, landscaped. */
export function generateLevel(seed = 30): LevelData {
  const w = new LevelWriter('phantom-city');
  generateCity(w, seed);
  const [x0, z0] = blockRect(1, 1);
  generateDeck(w, [x0, 0, z0 + 6], seed + 1);
  // last, so it only fills ground the city and the deck left open
  generateLandscape(w, seed + 2);
  return w.data;
}
