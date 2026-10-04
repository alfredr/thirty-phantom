import type { PartKind } from '../../actors/models/junk';
import type { SoundOf } from '../../audio/cues';
import { ITEM_ICONS } from '../../ui/item-icons';

/** What Cody can carry: car parts picked up after smashes, Randy's brisket, what's left of his badge, and the burner phone Randy gives him. */
export type ItemKind = PartKind | 'brisket' | 'badge' | 'burner';

/** One kind of thing Cody can carry: everything that differs from one kind to the next. */
export interface ItemBreed {
  /** What the HUD calls it. */
  readonly name: string;
  /** A line about it, shown when he picks it up, for the ones that have one. */
  readonly note?: string;
  /** What picking it up sounds like. */
  readonly sound: SoundOf<'item'>;
  /** Its icon (inline SVG) on the HUD's tags and in Randy's wares, for the ones that have one. */
  readonly icon?: string;
  /** What Randy sells one for (dollars), for what he sells. */
  readonly price?: number;
}

/** A car part: its name, and the clank of picking one up. */
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
  // on the house
  burner: { name: 'BURNER PHONE', note: "RANDY'S NUMBER'S THE ONLY ONE IN IT", sound: 'item-gift', icon: ITEM_ICONS.burner, price: 0 },
};

/** Whether a name (from the HUD, say) is one of the items. */
export function isItemKind(k: string): k is ItemKind {
  return Object.hasOwn(ITEM_BREEDS, k);
}
