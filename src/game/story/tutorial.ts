import { Vector3 } from 'three';

import type { Vehicle } from '@/actors/vehicles/vehicle';
import { TUNING } from '@/config';
import { el } from '@/engine/ui/dom';
import type { VehicleAccess } from '@/game/cody/cody-ride';
import { spotLabel } from '@/game/deck/garage';
import type { Game } from '@/game/game';
import { GameClock } from '@/game/game-clock';
import { Dialogue } from '@/ui/dialogue';
import { ITEM_ICONS } from '@/ui/item-icons';
import { Signpost } from '@/ui/signpost';
import { wantsTouch } from '@/ui/touch-controls';
import type { LevelData } from '@/world/level-data';

import { Barriers } from './barriers';
import { Director } from './director';
import { fillPoint, RoofScene } from './roof-scene';
import { Access } from './story-access';
import { StoryCamera } from './story-camera';
import { StoryClock } from './story-clock';
import { Goals } from './story-goals';
import { Outreach } from './story-outreach';
import { Recovery } from './story-recovery';
import { BEATS, type BeatId, type Cast, ERRAND, type ErrandId, type TutorialEvent } from './tutorial-beats';
import { moltenKeys, Scenes, type Stage, stagedView, stageOn } from './tutorial-scenes';

/** Persist completion of the whole tutorial, or of part 1 at the first escape so a reload restarts part 2. */
const DONE_KEY = '30pc.tutorial';
const PART1_KEY = '30pc.tutorial.part1';
const START_HOUR = 17.5;
const PLATE = '30-CODY-01';
const TALK_HEIGHT = 1.2;
const FLARE_TOP = 4;
const ZOOM_MIN = 10.5;
const ZOOM_MAX = 24;
const ZOOM_PER_METER = 1.7;
const ZOOM_PAD = 2;
const LIFT = -0.03;
const RING_HINT = 4;
const HEAD = 2.5;
const GLOW = '<span class="glow"></span>';
const WISPS = '<i class="wisp"></i>'.repeat(3);

interface Settings {
  randyTalk: boolean;
  trades: boolean;
  skipAfterEating: boolean;
  keepEscaped: boolean;
  vehicleAccess: VehicleAccess;
}

/**
 * Wire the game into the tutorial's beat directors. The opening night (part 1) runs from the roof at 5:30 PM through
 * the first escape; day 2 and night 2 (part 2) follow, and a reload during part 2 restarts it at the next morning. The
 * beats themselves live in tutorial-beats.ts and their mechanics in tutorial-scenes.ts.
 */
export class Tutorial {
  private wanted = !remembered(DONE_KEY);
  private active = false;
  private readonly dialogue: Dialogue;
  private readonly sign: Signpost;
  private readonly barriers: Barriers;
  private readonly clock: StoryClock;
  private readonly goals: Goals;
  private readonly outreach: Outreach;
  private readonly recovery: Recovery;
  private readonly scenes: Scenes;
  private readonly camera: StoryCamera;
  private readonly gas: RoofScene;
  private access: Access | null = null;
  private cast: Cast | null = null;
  private main: Director<Cast, TutorialEvent, BeatId> | null = null;
  private errand: Director<Cast, TutorialEvent, ErrandId> | null = null;
  private settings: Settings | null = null;
  private t = 0;
  private readonly head = new Vector3();

  /** Whether this run is active. game/save.ts uses this to suppress normal progress restoration and writes. */
  get running(): boolean {
    return this.active;
  }

  constructor(
    private readonly game: Game,
    private readonly level: LevelData,
  ) {
    this.dialogue = new Dialogue({ left: 'RANDY ROLSEN', right: 'CODY' }, game.input.focus);
    this.dialogue.addLook('left', 'smoke', `${GLOW}${WISPS}`);
    this.dialogue.addLook('left', 'molten', `${GLOW}<div class="held">${ITEM_ICONS.moltenKeys}</div>${WISPS}`);
    this.sign = new Signpost(game.hud.root, game.input.focus);
    this.barriers = new Barriers(level, game.scene, game.world.collision);
    this.clock = new StoryClock(game.clock);
    this.goals = new Goals(game.objectives, () => this.me());
    this.outreach = new Outreach(
      game.phone,
      this.dialogue,
      {
        show: (line) => {
          game.bubble = line ? { at: this.head, who: line.who, line: line.say, choices: [] } : null;
        },
      },
      { left: 'RANDY', right: 'CODY' },
      () => game.clock.pace,
      game.input.focus,
      {
        ring: (first) => {
          if (first) {
            game.hud.toast('INCOMING CALL', '{interact} ANSWER', '', RING_HINT);
          }
        },
        answered: (first) => {
          if (first) {
            game.hud.clearToasts();
          }
        },
      },
    );
    this.recovery = new Recovery(game);
    this.scenes = new Scenes(
      game,
      (e) => this.send(e),
      () => this.cast,
    );
    this.camera = new StoryCamera(game);
    this.gas = new RoofScene(game);
    this.titleLink();
    const ev = game.events;
    ev.on('start', () => this.begin());
    ev.on('frame', (dt) => this.frame(dt));
    ev.on('entered', ({ v, possessed }) => this.send({ type: 'entered', v, possessed }));
    ev.on('exited', ({ spot }) => {
      this.camera.restore();
      this.send({ type: 'exited', spot });
    });
    ev.on('crossing', (crossing) => this.send({ type: 'crossing', crossing }));
    ev.on('swallowed', () => this.send({ type: 'swallowed' }));
    ev.on('boosted', () => this.send({ type: 'boosted' }));
    ev.on('summoned', () => this.send({ type: 'summoned' }));
    ev.on('spooked', () => this.send({ type: 'spooked' }));
    ev.on('hotwired', ({ v }) => this.send({ type: 'hotwired', v }));
    ev.on('camera', () => this.camera.chose());
    ev.on('phantom', ({ at, spot, n, hours, day }) => {
      const title = n === 1 ? '1ST PHANTOM' : `PHANTOM #${n}`;
      const meta = `${spot ? `${spotLabel(spot)}. ` : ''}${GameClock.format(hours)}, NIGHT ${day}`;
      this.send({ type: 'phantom', imprint: { at: at.clone(), title, meta } });
    });
    ev.on('nightfall', () => this.send({ type: 'nightfall' }));
    ev.on('sunrise', () => this.send({ type: 'sunrise' }));
  }

  /** Add the title's skip/replay toggle. The click also reaches the title's game-start handler. */
  private titleLink(): void {
    const title = document.querySelector<HTMLElement>('.hud-title');
    if (!title) {
      return;
    }

    const link = el('div', 'title-tut', title, this.wanted ? 'SKIP TUTORIAL' : 'REPLAY TUTORIAL');
    link.addEventListener('click', () => {
      this.wanted = !this.wanted;

      if (this.wanted) {
        forget(PART1_KEY);
      } else {
        remember(DONE_KEY);
      }
    });
  }

  private begin(): void {
    const g = this.game;
    const randy = g.npcs.find('randy');
    const stage = stageOn(this.level, g.garage, (x, z) => g.world.collision.groundAt(x, z, 2, 0));
    if (!this.wanted || !randy || !stage) {
      return;
    }

    this.active = true;
    const settings: Settings = {
      randyTalk: g.randyTalk.enabled,
      trades: g.trades.enabled,
      skipAfterEating: g.skipAfterEating,
      keepEscaped: g.keepEscaped,
      vehicleAccess: g.vehicleAccess,
    };
    this.settings = settings;
    g.randyTalk.enabled = false;
    g.skipAfterEating = false;
    const access = new Access(g, () => this.cast?.pickup ?? null, this.barriers, settings);
    this.access = access;
    const { randy: face, cody } = g.portraits;
    this.dialogue.setPortrait('left', face);
    this.dialogue.setPortrait('right', cody);
    g.phone.setAvatar(face);
    g.hud.clearToasts();
    const pickup = g.park(stage.truck, stage.yaw, 'pickup');
    pickup.plate = PLATE;
    g.garage.checkIn(stage.spot, pickup);
    const cast: Cast = {
      game: g,
      level: this.level,
      clock: this.clock,
      goals: this.goals,
      outreach: this.outreach,
      access,
      recovery: this.recovery,
      scenes: this.scenes,
      camera: this.camera,
      sign: this.sign,
      chapter: { imprint: null, smelled: false, views: new Set() },
      gas: this.gas,
      pickup,
      randy,
      stage,
      touch: wantsTouch(),
      startErrand: () => this.errand?.start('cooled'),
      remember: (part) => remember(part === 1 ? PART1_KEY : DONE_KEY),
      bam: () => {
        g.hud.toast('BAM.', 'PHANTOM CODY', '', 2.6);
        this.dialogue.setPortrait('right', g.portraits.codyNight);
      },
      wake: () => {
        g.hud.showLedger(true);
        this.camera.restore();
        this.dialogue.setPortrait('right', g.portraits.cody);
      },
    };
    this.cast = cast;
    this.main = new Director(BEATS, cast, {
      prefix: 'beat',
      moved: (id) => this.moved(id),
    });
    this.errand = new Director(ERRAND, cast, {
      prefix: 'errand',
      moved: (id) => g.events.emit('step', { quest: 'tutorial-keys', step: id ?? 'over' }),
    });

    if (remembered(PART1_KEY)) {
      this.morning(cast);
    } else {
      this.opening(cast, stage);
    }
  }

  private opening(c: Cast, st: Stage): void {
    const g = this.game;
    const r = c.randy;
    g.hud.showLedger(false);
    g.haunt(false);
    g.clock.hours = START_HOUR;
    g.board(c.pickup, true);
    r.place(st.randy, st.randyYaw);
    r.prop('burner').visible = false;
    this.gas.setup(r);

    if (!g.inventory.count('badge')) {
      g.inventory.add('badge');
    }

    const fire = r.fire?.root.position ?? st.randy;
    const door = this.scenes.doorOf(c.pickup).pos;
    const action = [st.window, door, fillPoint(c.pickup), fire, st.randy, ...this.gas.cans.map((o) => o.position)];
    const focus = this.camera.focus.set(0, 0, 0);
    for (const p of action) {
      focus.add(p);
    }

    focus.multiplyScalar(1 / action.length).setY(st.randy.y + TALK_HEIGHT);
    const reach = Math.max(...action.map((p) => Math.hypot(p.x - focus.x, p.z - focus.z)));
    const fx = Math.sin(st.yaw);
    const fz = Math.cos(st.yaw);
    const sights: Vector3[] = [];
    for (const along of [-2.2, 0, 2.2]) {
      for (const across of [-1, 0, 1]) {
        for (const up of [0.6, 1.4]) {
          const p = st.truck.clone();
          p.set(p.x + fx * along + fz * across, p.y + up, p.z + fz * along - fx * across);
          sights.push(p);
        }
      }
    }

    sights.push(...action.map((p) => p.clone().setY(st.randy.y + 1)), fire.clone().setY(fire.y + FLARE_TOP));
    const azimuth = stagedView(g.world.root, sights, st.yaw);
    const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, reach * ZOOM_PER_METER + ZOOM_PAD));
    focus.x -= Math.sin(azimuth) * zoom * LIFT;
    focus.z -= Math.cos(azimuth) * zoom * LIFT;
    this.camera.zoom = zoom;
    g.iso.azimuth = g.iso.azimuthTarget = azimuth;
    g.iso.zoom = g.iso.zoomTarget = zoom;
    g.iso.snapTo(focus);
    this.main?.start('roof');
  }

  private morning(c: Cast): void {
    const g = this.game;
    g.clock.day = 2;
    g.clock.hours = TUNING.clock.sunrise;
    g.announceDay();
    g.hud.showLedger(true);
    g.haunt(true);
    c.pickup.ignition.hotwired = true;
    c.pickup.ignition.transfer('away', c.randy.keys);
    moltenKeys(c);
    this.main?.start('morning');
  }

  private frame(dt: number): void {
    if (!this.cast) {
      return;
    }

    this.t += dt;
    this.head.copy(this.me()).setY(this.me().y + HEAD);
    this.barriers.update(dt, this.t);
    this.outreach.tick(dt);
    this.scenes.tick(dt);
    this.camera.tick(dt);

    if (this.active) {
      this.main?.tick(dt);
    }

    this.errand?.tick(dt);
  }

  private send(e: TutorialEvent): void {
    if (!this.cast) {
      return;
    }

    if (this.active) {
      this.main?.send(e);
    }

    this.errand?.send(e);
  }

  private moved(id: BeatId | null): void {
    this.game.events.emit('step', { quest: 'tutorial', step: id ?? 'over' });

    if (id === null) {
      this.finish();
    }
  }

  private finish(): void {
    const g = this.game;
    remember(DONE_KEY);
    this.wanted = false;
    this.access?.clear();
    this.clock.clear();
    this.recovery.clear();
    this.outreach.close();
    g.phone.close();

    if (this.settings) {
      g.randyTalk.enabled = this.settings.randyTalk;
      g.skipAfterEating = this.settings.skipAfterEating;
      g.vehicleAccess = this.settings.vehicleAccess;
      this.settings = null;
    }

    this.active = false;
  }

  private me(): Vector3 {
    const g = this.game;
    const ride: Vehicle | undefined = g.vehicles.find((v) => v.role === 'player');
    return ride?.pos ?? g.player.pos;
  }
}

function remembered(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function remember(key: string): void {
  try {
    localStorage.setItem(key, '1');
  } catch {
    // If storage is unavailable, completion may not persist to the next visit.
  }
}

function forget(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    return;
  }
}
