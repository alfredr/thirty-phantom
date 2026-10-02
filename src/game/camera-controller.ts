import { urlChoice } from '../core/url-flags';

export type CamMode = 'iso' | 'chase' | 'auto';
export type CamView = 'iso' | 'chase';

const KEY = '30pc.camera';
const MODES: readonly CamMode[] = ['iso', 'chase', 'auto'];
const TOUCH_MODES: readonly CamMode[] = ['iso', 'chase'];

interface CameraEffects {
  snapBehind(yaw: number): void;
  releasePointer(): void;
  setView(view: CamView): void;
  showMode(mode: CamMode, hint: boolean): void;
  changed(mode: CamMode): void;
}

function savedMode(): CamMode | null {
  try {
    const value = localStorage.getItem(KEY);
    return MODES.find((mode) => mode === value) ?? null;
  } catch {
    return null;
  }
}

/** Camera preferences and transitions. Game decides when to synchronize the view. */
export class CameraController {
  private currentMode: CamMode;
  private currentView: CamView = 'iso';
  private hinted: boolean;

  constructor(
    private readonly effects: CameraEffects,
    private readonly touch: boolean,
    override = urlChoice('cam', MODES),
  ) {
    const saved = savedMode();
    this.currentMode = this.normalize(override ?? saved ?? 'auto');
    this.hinted = saved !== null;
  }

  get mode(): CamMode { return this.currentMode; }
  get view(): CamView { return this.currentView; }

  /** Scripted changes do not overwrite the player's saved preference. */
  set(mode: CamMode): void {
    this.currentMode = this.normalize(mode);
  }

  /** Advance and remember the player's choice, then notify the HUD and tutorial. */
  cycle(): void {
    const modes = this.touch ? TOUCH_MODES : MODES;
    this.currentMode = modes[(modes.indexOf(this.currentMode) + 1) % modes.length] ?? 'iso';
    try {
      localStorage.setItem(KEY, this.currentMode);
    } catch {
      // The choice still applies when browser storage is unavailable.
    }
    this.hinted = true;
    this.effects.showMode(this.currentMode, false);
    this.effects.changed(this.currentMode);
  }

  /** Titles and cutscenes use iso; touch devices always use chase while riding. */
  sync(playing: boolean, cutscene: boolean, ride: { yaw: number } | null, playerYaw: number): void {
    const chase = playing && !cutscene && (this.currentMode === 'chase' || (ride !== null && (this.currentMode === 'auto' || this.touch)));
    const view = chase ? 'chase' : 'iso';
    if (view === this.currentView) return;
    this.currentView = view;
    if (chase) this.effects.snapBehind(ride?.yaw ?? playerYaw);
    else this.effects.releasePointer();
    this.effects.setView(view);
    if (chase && !this.hinted && !this.touch) {
      this.hinted = true;
      this.effects.showMode(this.currentMode, true);
    }
  }

  private normalize(mode: CamMode): CamMode {
    return this.touch && mode === 'auto' ? 'iso' : mode;
  }
}
