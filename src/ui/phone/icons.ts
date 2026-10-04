/** The phone's app icons: small line drawings in the current colour. */
const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  messages: svg('<path d="M4 5h16v11H9l-5 4z"/>'),
  tasks: svg('<path d="M4 6l2 2 3-3M4 13l2 2 3-3M12 7h8M12 14h8M4 19h16"/>'),
  phantoms: svg(
    '<path d="M6 21V10a6 6 0 0 1 12 0v11l-3-2-3 2-3-2z"/><circle cx="9.5" cy="10" r="1"/><circle cx="14.5" cy="10" r="1"/>',
  ),
  map: svg('<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14"/>'),
  photos: svg('<path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="3.5"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01"/>'),
} as const;
