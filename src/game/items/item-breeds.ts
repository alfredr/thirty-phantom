import type { PartKind } from '@/actors/models/junk';
import type { SoundOf } from '@/audio/cues';
import { ITEM_ICONS } from '@/ui/item-icons';

/** Item kinds supported by the inventory and pickup systems. */
export type ItemKind = PartKind | 'brisket' | 'badge' | 'burner';

/** Display, audio, and shop metadata for an item kind. */
export interface ItemBreed {
  /** HUD display name. */
  readonly name: string;
  /** Optional pickup notification detail. */
  readonly note?: string;
  /** Pickup sound cue. */
  readonly sound: SoundOf<'item'>;
  /** Optional inline SVG for inventory and shop displays. */
  readonly icon?: string;
  /** Unit price in dollars, when sold by Randy. */
  readonly price?: number;
}

/** Create metadata for a part using the shared pickup sound. */
const part = (name: string): ItemBreed => ({ name, sound: 'item-part' });

export const ITEM_BREEDS: Readonly<Record<ItemKind, ItemBreed>> = {
  tire: { name: 'TIRE', sound: 'item-tire' },
  hubcap: part('HUBCAP'),
  mirror: part('SIDE MIRROR'),
  bumper: part('BUMPER'),
  headlight: part('HEADLIGHT'),
  muffler: part('MUFFLER'),
  plate: part('LICENSE PLATE'),
  brisket: { name: 'BRISKET', sound: 'item-gift', icon: ITEM_ICONS.brisket, price: 10 },
  badge: { name: 'UNREADABLE BADGE', note: 'COVERED IN BBQ SAUCE', sound: 'item-gift' },

  burner: {
    name: 'BURNER PHONE',
    note: "RANDY'S NUMBER'S THE ONLY ONE IN IT",
    sound: 'item-gift',
    icon: ITEM_ICONS.burner,
    price: 0,
  },
};

/** Test whether a string names a supported item kind. */
export function isItemKind(k: string): k is ItemKind {
  return Object.hasOwn(ITEM_BREEDS, k);
}
