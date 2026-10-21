import { ChangeDetectionStrategy, Component, ElementRef, inject, resource, signal, viewChild } from '@angular/core';
import { Engine } from '../core/engine';
import { Sound } from '../core/sound';
import { Theme, ThemeChoice } from '../core/theme';
import { UpdateCheck, Updates } from '../core/updates';
import { Icon } from '../shared/icon';

@Component({
  selector: 'app-settings',
  imports: [Icon],
  template: `
    <dialog #dialog (close)="(0)" (click)="backdrop($event)">
      <div class="box" tabindex="-1" autofocus>
        <header>
          <h2>Settings</h2>
          <button class="btn ghost icon" (click)="close()" aria-label="Close"><app-icon name="close" /></button>
        </header>

        <section>
          <span class="eyebrow">Reference voice</span>
          <p class="hint">
            The voice that reads your texts and single words. Voices marked “online” send the text (never your recordings) to the provider.
          </p>
          <div class="row">
            <select class="field" [value]="sound.voiceName()" (change)="sound.setVoice($any($event.target).value)">
              @for (voice of sound.voices(); track voice.name) {
                <option [value]="voice.name">{{ voice.name }} · {{ voice.lang }}{{ voice.localService ? '' : ' · online' }}</option>
              }
            </select>
            <button class="btn" (click)="sound.speak('Parrot reads it, you repeat it.', 1, null)">
              <app-icon name="play" [size]="14" /> Try
            </button>
          </div>
          @if (!sound.canSpeak()) {
            <p class="bad">No system voice found. Add an English voice in your system's settings.</p>
          }
        </section>

        <section>
          <span class="eyebrow">Appearance</span>
          <div class="seg">
            @for (option of themes; track option) {
              <button [class.on]="theme.choice() === option" (click)="theme.set(option)">
                {{ option[0].toUpperCase() + option.slice(1) }}
              </button>
            }
          </div>
        </section>

        <section>
          <span class="eyebrow">Speech engine</span>
          @if (health.value(); as info) {
            <p class="ok">
              <span class="dot"></span>
              {{ info.models.whisper && info.models.aligner ? 'Ready, on this computer' : 'Speech models not downloaded yet' }}
            </p>
            <p class="hint">
              Texts and recordings are kept on this computer, in<br /><code>{{ info.data }}</code>
            </p>
          } @else if (health.error()) {
            <p class="bad">The speech engine is not answering.</p>
          }
        </section>

        <section>
          <span class="eyebrow">Updates</span>
          @if (version.value(); as current) {
            <div class="update">
              <span>Parrot {{ current }}</span>
              <button class="btn" (click)="checkForUpdates(current)" [disabled]="update().state === 'checking'">
                {{ update().state === 'checking' ? 'Checking…' : 'Check for updates' }}
              </button>
            </div>
            @let check = update();
            <p class="hint" [class.bad]="check.state === 'failed'" role="status">
              @if (check.state === 'latest') {
                You have the latest version ({{ check.version }}).
              } @else if (check.state === 'newer') {
                Parrot {{ check.release.version }} is out.
                <a [href]="check.release.url" target="_blank" rel="noopener" (click)="openRelease($event)">Download it</a>
              } @else if (check.state === 'failed') {
                {{ check.message }}
              } @else {
                Asks GitHub for the latest version, only when you click.
              }
            </p>
          } @else if (!version.isLoading()) {
            <p class="hint">A development build: there is no version to check.</p>
          }
        </section>
      </div>
    </dialog>
  `,
  styles: `
    dialog {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 0;
      width: min(520px, calc(100vw - 32px));
      background: var(--surface);
      color: var(--ink);
      box-shadow: var(--shadow-lg);
    }
    dialog::backdrop {
      background: rgba(0, 0, 0, 0.35);
    }
    .box {
      padding: 18px 22px 22px;
      outline: none;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      h2 {
        margin: 0;
        font-size: 18px;
      }
    }
    section {
      margin-top: 18px;
      > .eyebrow {
        display: block;
      }
    }
    .row {
      display: flex;
      gap: 8px;
      margin-top: 8px;
      // the menu and the button side by side: one height (the button's, a comfortable click target)
      > * {
        height: 44px;
      }
      select {
        flex: 1;
        min-width: 0;
      }
    }
    .seg {
      margin-top: 8px;
    }
    .update {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-top: 8px;
    }
    .hint {
      color: var(--ink-2);
      font-size: 13px;
      margin: 4px 0 0;
    }
    code {
      font-size: 12px;
      word-break: break-all;
    }
    .ok,
    .bad {
      margin: 6px 0 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .bad {
      color: var(--wrong-ink);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Settings {
  protected sound = inject(Sound);
  protected theme = inject(Theme);
  private engine = inject(Engine);
  private dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  protected readonly themes: ThemeChoice[] = ['system', 'light', 'dark'];
  private updates = inject(Updates);
  private check = signal(0);
  protected health = resource({ params: () => this.check(), loader: () => this.engine.info() });
  /** the running version, read from the app (no network); none in a plain browser */
  protected version = resource({ loader: () => this.updates.current() });
  protected update = signal<UpdateCheck>({ state: 'idle' });

  /** Ask GitHub for the latest release: only ever on this click. */
  protected async checkForUpdates(current: string) {
    this.update.set({ state: 'checking' });
    this.update.set(await this.updates.check(current));
  }

  /** The link opens in the system browser, not in the app. */
  protected openRelease(event: MouseEvent) {
    event.preventDefault();
    this.updates.open((event.currentTarget as HTMLAnchorElement).href).catch(() => {});
  }

  open() {
    this.check.update((count) => count + 1);
    this.dialog().nativeElement.showModal();
  }

  close() {
    this.dialog().nativeElement.close();
  }

  protected backdrop(event: MouseEvent) {
    if (event.target === this.dialog().nativeElement) this.close();
  }
}
