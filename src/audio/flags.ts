import { TUNING } from '../config';
import { urlParam } from '../core/url-flags';

const flag = urlParam('sound');

/** Whether the game has sound: TUNING.audio.on, or ?sound=0 / ?sound (on). Without it the sound code isn't even fetched. */
export const SOUND_ON: boolean = flag === null ? TUNING.audio.on : flag !== '0';

/** With ?sound in the URL the console logs each sound by name as it starts (for listening passes). */
export const SOUND_LOG: boolean = SOUND_ON && flag !== null;

/** A `[sound]` line in the console, with ?sound only. */
export function soundLog(line: string, level: 'info' | 'debug' = 'info'): void {
  if (SOUND_LOG) console[level](`[sound] ${line}`);
}
