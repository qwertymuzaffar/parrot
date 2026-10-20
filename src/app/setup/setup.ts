import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { Engine, EngineInfo, ModelProgress } from '../core/engine';
import { Logo } from '../shared/logo';

// megabytes as Finder and the download page count them
const MB = 1_000_000;

/** The first launch: download the two speech models, with progress, then Parrot works offline. */
@Component({
  selector: 'app-setup',
  imports: [Logo],
  template: `
    <div class="box">
      <app-logo [size]="64" />
      <h1>Getting Parrot ready</h1>
      <p class="lead">
        Parrot listens with two speech models that run on your computer, so your voice never leaves it. They are downloaded once, about
        {{ totalMb() }} MB, and then Parrot works offline.
      </p>

      <ul class="models">
        @for (model of models(); track model.key) {
          <li>
            <div class="row">
              <span class="what"
                ><b>{{ model.name }}</b
                ><span>{{ model.role }}</span></span
              >
              <span class="size">{{ model.ready ? 'Ready' : model.mb + ' MB' }}</span>
            </div>
            <div class="bar"><i [style.width.%]="model.ready ? 100 : model.pct"></i></div>
          </li>
        }
      </ul>

      @if (error()) {
        <p class="error">{{ error() }}</p>
      }

      <button class="btn primary" [disabled]="busy()" (click)="start()">
        {{ busy() ? 'Downloading…' : error() ? 'Try again' : 'Download and start' }}
      </button>
      <p class="fine">
        The models come from Hugging Face (Whisper, MIT licence) and from Parrot's GitHub releases (wav2vec2 trained on Common Voice, Apache
        2.0).
      </p>
    </div>
  `,
  styles: `
    :host {
      display: grid;
      place-items: center;
      height: 100%;
      padding: calc(24px + var(--titlebar)) 24px 24px;
      overflow: auto;
    }
    .box {
      width: min(520px, 100%);
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 14px;
    }
    h1 {
      font-size: 30px;
    }
    .lead {
      margin: 0;
      color: var(--ink-2);
      font-size: 15px;
    }
    .models {
      list-style: none;
      margin: 10px 0 0;
      padding: 0;
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 12px;
      text-align: left;
    }
    li {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px 16px;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .what {
      flex: 1;
      display: flex;
      flex-direction: column;
      span {
        font-size: 13px;
        color: var(--muted);
      }
    }
    .size {
      font-size: 13px;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    .bar {
      height: 6px;
      border-radius: 6px;
      background: var(--surface-2);
      margin-top: 10px;
      overflow: hidden;
      i {
        display: block;
        height: 100%;
        background: var(--accent);
        border-radius: 6px;
        transition: width 0.2s;
      }
    }
    .error {
      margin: 0;
      color: var(--wrong-ink);
      background: var(--wrong-bg);
      border-radius: 10px;
      padding: 8px 12px;
      font-size: 14px;
    }
    .btn {
      margin-top: 6px;
      min-width: 220px;
    }
    .fine {
      margin: 0;
      font-size: 12px;
      color: var(--muted);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Setup {
  private engine = inject(Engine);
  readonly info = input.required<EngineInfo>();
  readonly done = output<void>();

  protected busy = signal(false);
  protected error = signal<string | null>(null);
  private progress = signal<Record<string, ModelProgress>>({});

  protected readonly models = computed(() => {
    const info = this.info();
    const progress = this.progress();
    const row = (key: 'whisper' | 'aligner', name: string, role: string) => {
      const got = progress[key];
      return {
        key,
        name,
        role,
        ready: info.models[key] || (got != null && got.received >= got.total),
        mb: Math.round(info.sizes[key] / MB),
        pct: got ? (100 * got.received) / got.total : 0,
      };
    };
    return [
      row('whisper', 'Speech recognition', 'Whisper small, English: writes down what you said'),
      row('aligner', 'Pronunciation check', 'wav2vec2, many accents: finds each word and scores its sounds'),
    ];
  });
  protected readonly totalMb = computed(() => Math.round((this.info().sizes.whisper + this.info().sizes.aligner) / MB / 10) * 10);

  protected async start() {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.engine.downloadModels((progress) => this.progress.update((all) => ({ ...all, [progress.model]: progress })));
      this.done.emit();
    } catch (error) {
      this.error.set(`${(error as Error).message}. Check your internet connection and try again.`);
    } finally {
      this.busy.set(false);
    }
  }
}
