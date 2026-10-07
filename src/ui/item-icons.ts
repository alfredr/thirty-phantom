/**
 * Inline SVG markup referenced by ItemBreed.icon for shop slots and inventory
 * tags.
 */
export const ITEM_ICONS = {
  keys:
    '<svg viewBox="0 0 40 36" class="item-icon icon-keys">' +
    '<rect class="fob" x="3.5" y="14.5" width="13" height="19" rx="5"/>' +
    '<circle class="lock" cx="10" cy="21" r="2.1"/><circle class="open" cx="10" cy="27.5" r="2.1"/>' +
    '<g transform="translate(0 1) rotate(30 20.5 18)"><path class="metal" d="M19 12.5h5.5a2.5 2.5 0 0 1 2.5 2.5v.5h8.5a1.5 1.5 0 0 1 1.5 1.5v1.5l-2 2h-1.8l-1.2 1.6h-2.2l-1.2-1.6h-1.6v.5a2.5 2.5 0 0 1-2.5 2.5h-5.5a2.5 2.5 0 0 1-2.5-2.5v-6a2.5 2.5 0 0 1 2.5-2.5z"/>' +
    '<circle class="hole" cx="20.5" cy="18" r="1.6"/></g><circle class="ring" cx="15" cy="10" r="4.8"/>' +
    '</svg>',
  moltenKeys:
    '<svg viewBox="0 0 40 36" class="item-icon icon-keys icon-molten">' +
    '<path class="fob" d="M3.5 19.5a5 5 0 0 1 5-5h3a5 5 0 0 1 5 5v9.5c0 1.6-.5 2.7-1.4 3.4v1.4a1.2 1.2 0 0 1-2.4 0v-.6c-.9.2-2 .3-3.2.3h-.6v1.6a1.1 1.1 0 0 1-2.2 0v-1.9c-2.1-.6-3.2-2.2-3.2-4.6z"/>' +
    '<circle class="lock" cx="10" cy="21" r="2.1"/><circle class="open" cx="10" cy="27.5" r="2.1"/>' +
    '<path class="melt-rim" d="M31.6 28.2c.4 1.2.4 2.6.5 3.6a1.15 1.15 0 0 0 2.3 0c0-1.3-.1-2.6.2-4.4z"/>' +
    '<g transform="translate(0 1) rotate(30 20.5 18)">' +
    '<path class="halo" d="M19 12.5h5.5a2.5 2.5 0 0 1 2.5 2.5v.5h8.5a1.5 1.5 0 0 1 1.5 1.5v1.5l-2 2h-1.8l-1.2 1.6h-2.2l-1.2-1.6h-1.6v.5a2.5 2.5 0 0 1-2.5 2.5h-5.5a2.5 2.5 0 0 1-2.5-2.5v-6a2.5 2.5 0 0 1 2.5-2.5z"/>' +
    '<path class="metal" d="M19 12.5h5.5a2.5 2.5 0 0 1 2.5 2.5v.5h8.5a1.5 1.5 0 0 1 1.5 1.5v1.5l-2 2h-1.8l-1.2 1.6h-2.2l-1.2-1.6h-1.6v.5a2.5 2.5 0 0 1-2.5 2.5h-5.5a2.5 2.5 0 0 1-2.5-2.5v-6a2.5 2.5 0 0 1 2.5-2.5z"/>' +
    '<path class="core" d="M18 15.6a1.6 1.6 0 0 1 1.6-1.6h4.8a1.6 1.6 0 0 1 1.6 1.6v1.2h9.4v2.2h-9.4v1.4a1.6 1.6 0 0 1-1.6 1.6h-4.8a1.6 1.6 0 0 1-1.6-1.6z"/>' +
    '<path class="hotspot" d="M23.4 17.9h11.2"/><circle class="hole" cx="20.5" cy="18" r="1.6"/></g>' +
    '<path class="melt" d="M31.6 28.2c.4 1.2.4 2.6.5 3.6a1.15 1.15 0 0 0 2.3 0c0-1.3-.1-2.6.2-4.4z"/>' +
    '<circle class="bead" cx="33.4" cy="34.6" r=".9"/>' +
    '<circle class="halo" cx="15" cy="10" r="4.8"/><circle class="rim" cx="15" cy="10" r="4.8"/>' +
    '<circle class="ring" cx="15" cy="10" r="4.8"/><circle class="ring-core" cx="15" cy="10" r="4.8"/>' +
    '<path class="wave" d="M27.5 10.5c-3-3 2.5-3.5 0-7M34 14c-3-3 2.5-3.5 0-7"/>' +
    '<g class="embers"><circle cx="25" cy="7" r=".9"/><circle cx="31" cy="6" r=".7"/><circle cx="36.5" cy="11" r=".8"/></g>' +
    '</svg>',
  brisket:
    '<svg viewBox="0 0 40 30" class="item-icon icon-brisket"><path class="bark" d="M4 13c1-6 7-9 15-9 9 0 16 3 17 9 1 7-5 12-16 12S3 20 4 13z"/>' +
    '<path class="cut" d="M8 14c1-4 5-6 12-6s12 2 13 6c0 4-5 7-13 7S8 18 8 14z"/>' +
    '<path class="fat" d="M11 12.5c3-2 15-2 19 0M10 16c4 1.5 16 1.5 21 0"/></svg>',
  // Preserve the burner phone’s antenna, screen, and keypad silhouette.
  burner:
    '<svg viewBox="0 0 26 36" class="item-icon icon-burner"><rect class="nub" x="16" y="0.5" width="3.5" height="5" rx="1"/>' +
    '<rect class="body" x="4" y="3.5" width="18" height="31" rx="3.5"/>' +
    '<rect class="screen" x="7.5" y="7.5" width="11" height="8.5" rx="1.2"/>' +
    '<path class="keys" d="M9 20.5h.01M13 20.5h.01M17 20.5h.01M9 24.5h.01M13 24.5h.01M17 24.5h.01M9 28.5h.01M13 28.5h.01M17 28.5h.01"/></svg>',
} as const;
