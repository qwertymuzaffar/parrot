import { ChangeDetectionStrategy, Component, inject, OnInit, signal, viewChild } from '@angular/core';
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
