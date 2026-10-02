import { PALETTE } from '../../render/palette';
import { buildPerson, type Outfit } from './person';
import type { CharacterRig } from './rig';

/** Foxy's uniform: red jacket with orange piping, black slacks, bellhop cap, bow tie. */
export const VALET_OUTFIT: Outfit = {
  top: '#c23a2e',
  trim: PALETTE.foxy,
  bottom: '#1b1622',
  shirt: PALETTE.bone,
  tie: true,
  skin: '#d9a07a',
  shoes: '#1a0f14',
  hair: '#2a1a12',
  hat: 'cap',
};

export function buildValet(skin = VALET_OUTFIT.skin): CharacterRig {
  return buildPerson({ ...VALET_OUTFIT, skin });
}
