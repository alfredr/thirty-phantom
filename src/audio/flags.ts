import { TUNING } from '@/config';
import { urlParam } from '@/engine/core/url-flags';

const flag = urlParam('sound');

/**
 * Enable audio using the URL override or the configured default. Disabled
 * audio is never imported.
 */
export const SOUND_ON: boolean =
  flag === null ? TUNING.audio.on : flag !== '0';

/** Log audio cues when the URL explicitly enables sound. */
const SOUND_LOG: boolean = SOUND_ON && flag !== null;

/** Write a prefixed console message when audio logging is enabled. */
export function soundLog(
  line: string,
  level: 'info' | 'debug' = 'info',
): void {
  if (SOUND_LOG) {
    console[level](`[sound] ${line}`);
  }
}
