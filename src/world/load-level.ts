import { generateLevel } from './generate-level';
import type { LevelData } from './level-data';

/** Load and validate a custom level, falling back to the generated city on failure. */
export async function loadLevel(url: string | null): Promise<LevelData> {
  if (url) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const json: unknown = await response.json();
        const { parseLevel } = await import('./parse-level');
        return parseLevel(json);
      }
      console.warn(`[level] ${url}: HTTP ${response.status}, using procedural level`);
    } catch (err) {
      console.warn(`[level] ${url} failed, using procedural level`, err);
    }
  }
  return generateLevel();
}
