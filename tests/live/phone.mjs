export const steps = {
  popup: () => document.querySelector('.text-pop')?.classList.contains('on') ?? false,
};

export function textPopsUpTakesFAndLandsInMessages() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(30);
  const landed = [];
  g.phone.text('READ ME. {interact} TO CLOSE.', { landed: () => landed.push('first') });
  sim.run(2);
  const shown = sim.popup() && g.phone.popupVisible;
  const owned = g.input.focus.owns('interact');
  const before = g.phone.messages.unseen();
  g.input.press('KeyF');
  sim.run(30);
  const after = g.phone.messages.unseen();
  const stamp = document.querySelector('.burner-msg:last-child .burner-stamp')?.textContent ?? '';
  return {
    ok:
      shown &&
      owned &&
      !g.input.focus.owns('interact') &&
      after === before + 1 &&
      landed.length === 1 &&
      /\d:\d\d [AP]M/.test(stamp),
    shown,
    owned,
    unseen: [before, after],
    landed,
    stamp,
  };
}

export function quietHoldsPopupsAndTheGapSpacesThem() {
  const g = window.__game;
  const sim = window.__sim;
  g.start();
  sim.run(30);
  g.phone.text('FIRST', { brief: 1 });
  sim.run(2);
  const firstShown = sim.popup();
  sim.run(30);
  const shot = g.cameraShots.take({ focus: g.player.pos.clone(), zoom: 30 });
  let rang = 0;
  g.phone.queueCall(() => rang++);
  g.phone.text('SECOND', { brief: 1 });
  sim.run(30 * 40);
  const heldByCutscene = rang === 0 && !sim.popup();
  shot();
  sim.run(2);
  const calling = rang === 1 && g.phone.calling;
  sim.run(30 * 5);
  g.phone.endCall([{ who: 'RANDY', say: 'HI.' }]);
  sim.run(30 * 29);
  const waiting = !sim.popup();
  sim.run(30 * 2);
  const second = sim.popup();
  sim.run(30 * 3);
  const log = g.phone.outreaches.map((o) => ({
    kind: o.kind,
    start: Math.round(o.start),
    end: o.end && Math.round(o.end),
  }));
  const gaps = g.phone.outreaches.slice(1).map((o, i) => Math.round(o.start - (g.phone.outreaches[i].end ?? Infinity)));
  return {
    ok: firstShown && heldByCutscene && calling && waiting && second && gaps.every((s) => s >= 30),
    firstShown,
    heldByCutscene,
    calling,
    waiting,
    second,
    gaps,
    log,
  };
}
