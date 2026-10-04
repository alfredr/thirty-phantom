/** Inline SVG markup referenced by ItemBreed.icon for shop slots and inventory tags. */
export const ITEM_ICONS = {
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
