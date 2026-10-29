import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  OnInit,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Engine, EngineInfo, IN_APP } from './core/engine';
import { Library } from './core/library';
import { Session } from './core/session';
import { Theme } from './core/theme';
import { Home } from './home/home';
import { Practice } from './practice/practice';
import { Settings } from './settings/settings';
import { Talking } from './core/talking';
import { TalkPreview } from './talk/talk-preview';
import { Setup } from './setup/setup';
import { focusIn, refocus } from './shared/focus';

/** each screen, by the element that draws it: its main heading is where focus goes when it opens */
const SCREENS = { setup: 'app-setup', preview: 'app-talk-preview', practice: 'app-practice', home: 'app-home' };

/** How long the window waits for the engine's first answer before it says it is waiting (ms). */
export const SLOW_START_MS = 4_000;

@Component({
  selector: 'app-root',
  imports: [Home, Practice, Settings, Setup, TalkPreview],
  template: `
    <!-- the strip under the macOS window buttons: drags the window, as the hidden title bar did -->
    <div class="titlebar" data-tauri-drag-region></div>
    <!-- nothing but the ground until the engine has answered: a screen drawn before might be one it contradicts -->
    @if (setup() === undefined) {
      @if (slow()) {
        <p class="waiting" role="status"><span class="spinner"></span> The speech engine hasn't answered yet. Parrot is still waiting.</p>
      }
    } @else if (setup(); as info) {
      <app-setup [info]="info" (done)="ready()" />
    } @else if (talking.checking()) {
      <app-talk-preview />
    } @else if (session.view() === 'practice') {
      <app-practice (settings)="settings().open()" />
    } @else {
      <app-home (settings)="settings().open()" />
    }
    <app-settings />
  `,
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit {
  protected session = inject(Session);
  protected talking = inject(Talking);
  private library = inject(Library);
  private engine = inject(Engine);
  private theme = inject(Theme);
  protected settings = viewChild.required(Settings);
  /** the first launch: the speech models still to download; null once Parrot is ready, undefined until the engine
   * has said which */
  protected setup = signal<EngineInfo | null | undefined>(undefined);
  /** the engine is slow to answer at the start: the window says so rather than stay blank */
  protected slow = signal(false);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private injector = inject(Injector);
  /** the screen shown, as the template picks it */
  private readonly screen = computed(() => {
    const setup = this.setup();
    if (setup === undefined) return 'waiting';
    if (setup) return 'setup';
    return this.talking.checking() ? 'preview' : this.session.view();
  });

  constructor() {
    // a new screen takes the old one's place, and the button pressed on it (a text opened, a new text, Home) goes with
    // it: focus goes to the new screen's heading, so a screen reader says where the user is. Not for the first screen
    // after the start, and not from the Settings dialog
    let shown = 'waiting';
    effect(() => {
      const screen = this.screen();
      const from = shown;
      shown = screen;
      if (screen === from || from === 'waiting' || screen === 'waiting') return;
      untracked(() => {
        if (document.activeElement?.closest('app-settings') || !focusIn(this.host.nativeElement)) return;
        refocus(() => this.host.nativeElement.querySelector<HTMLElement>(`${SCREENS[screen]} h1[tabindex="-1"]`), this.injector);
      });
    });
  }

  async ngOnInit() {
    // in the desktop app on macOS the title bar is hidden and the window buttons sit over the app
    if (IN_APP && /Mac/.test(navigator.userAgent)) document.documentElement.classList.add('mac-app');
    this.theme.apply();
    const slow = window.setTimeout(() => this.slow.set(true), SLOW_START_MS);
    // a talk left from the last run is known too, so the Just talk card is drawn as it will stay
    const [info] = await Promise.all([this.engine.info().catch(() => null), this.talking.asked]);
    clearTimeout(slow);
    if (info && !(info.models.whisper && info.models.aligner)) {
      this.setup.set(info);
      return;
    }
    await this.ready();
  }

  protected async ready() {
    this.setup.set(null);
    await this.library.loadTexts();
    this.library.loadActivity();
  }
}
