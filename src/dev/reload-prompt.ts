import { keyName } from '@/game/controls';
// The development plugin injects this independently of game startup, so reload prompts
// still work after a boot failure. Code updates wait for the player to reload.

const files = new Set<string>();

/**
 * Reload when development changes are pending. The game calls this from its
 * reload shortcut.
 */
export function reloadIfPending(): void {
  if (files.size) {
    location.reload();
  }
}

if (import.meta.hot) {
  let toast: HTMLDivElement | undefined;

  const render = (): void => {
    if (!toast) {
      toast = document.createElement('div');
      toast.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:9999;display:flex;align-items:center;gap:10px;' +
        'padding:8px 10px 8px 14px;background:#0d0716ee;border:1px solid #9dff2e;border-radius:6px;' +
        'color:#e8e0f0;font:12px/1.3 ui-monospace,monospace;box-shadow:0 4px 18px #000a';
      toast.innerHTML =
        '<span></span>' +
        '<button data-act="reload" style="font:inherit;padding:3px 9px;border:0;border-radius:4px;background:#9dff2e;color:#0d0716;cursor:pointer">Reload (' +
        keyName('reload') +
        ')</button>' +
        '<button data-act="dismiss" title="Dismiss until the next change" style="font:inherit;padding:3px 6px;border:0;background:none;color:#e8e0f0;cursor:pointer">&times;</button>';
      toast.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).dataset.act;
        if (act === 'reload') {
          location.reload();
        } else if (act === 'dismiss') {
          toast?.remove();
        }
      });
    }

    const list = [...files];
    const label = toast.querySelector('span')!;
    label.textContent =
      list.length === 1
        ? `Change ready: ${list[0]}`
        : `${list.length} changes ready`;
    label.title = list.join('\n');

    if (!toast.isConnected) {
      document.body.appendChild(toast);
    }
  };

  import.meta.hot.on('reload-prompt:ready', ({ file }: { file: string }) => {
    files.add(file);
    render();
  });
}
