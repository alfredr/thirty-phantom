import { blockRect, generateCity } from './gen-city';
import { generateDeck } from './gen-deck';
import { generateLandscape } from './gen-landscape';
import type { LevelData } from './level-data';
import { LevelWriter } from './level-writer';

/**
 * Generate the seeded default city, placing the haunted deck in the central
 * block and landscaping available space.
 */
export function generateLevel(seed = 30): LevelData {
  const w = new LevelWriter('phantom-city');
  generateCity(w, seed);
  const [x0, z0] = blockRect(1, 1);
  generateDeck(w, [x0, 0, z0 + 6], seed + 1);
  // Generate landscaping last so it can avoid the city and deck geometry.
  generateLandscape(w, seed + 2);
  return w.data;
}
