import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Recorder } from '../core/recorder';
import { LONGEST_TALK, StopReason, Talking } from '../core/talking';
import { Icon } from '../shared/icon';

/** What to say of a talk that stopped by itself. */
export function stopNote(reason: StopReason | null) {
  if (reason === 'quiet') return 'Stopped after 2 quiet minutes.';
  if (reason === 'longest') return `Stopped at the ${LONGEST_TALK / 60}-minute limit.`;
  return '';
}

/** m:ss */
export function clock(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Just talk: the card on Home that records a talk and writes it down. Checking it is the preview's (TalkPreview). */
@Component({
  selector: 'app-talk-card',
  imports: [Icon],
  template: `
    <section class="card talk" aria-labelledby="talk-title">
      <h2 id="talk-title">Just talk</h2>
      @switch (talking.state()) {
        @case ('recording') {
          @if (talking.recording()) {
            <div class="live" role="status">
              <span class="rec-dot"></span>
              <b>Listening…</b>
              <span class="time" [class.ending]="talking.left() <= 60">
                {{ talking.left() <= 60 ? clock(talking.left()) + ' left' : clock(recorder.elapsed()) }}
              </span>
            </div>
            <div class="meter" aria-hidden="true"><i [style.width.%]="recorder.level() * 100"></i></div>
            <div class="go">
              <span class="hint">Stop when you're done. Esc also stops.</span>
              <button class="btn primary stop" (click)="talking.stop()"><app-icon name="stop" [size]="14" /> Stop</button>
            </div>
          } @else {
            <!-- the microphone opening and settling: a word said now would be lost, so the card says to wait -->
            <p class="hint" role="status">Getting the microphone ready. Start talking when it says Listening.</p>
            <div class="go">
              <button class="btn ghost" (click)="talking.stop()">Cancel</button>
              <button class="btn primary" disabled aria-busy="true"><span class="spinner light"></span> Preparing…</button>
            </div>
          }
        }
        @case ('writing') {
          <div class="live" role="status">
            <span class="spinner"></span>
            <span>Writing down what you said… {{ Math.round(talking.progress() * 100) }}%</span>
          </div>
          <div class="progress" role="progressbar" aria-label="Writing it down" [attr.aria-valuenow]="Math.round(talking.progress() * 100)">
            <i [style.width.%]="talking.progress() * 100"></i>
          </div>
          <div class="go">
            <span class="hint">{{ note() }}</span>
            <button class="btn" (click)="talking.cancel()">Cancel</button>
          </div>
        }
        @case ('stopped') {
          <p class="hint" role="status">The recording is kept. Write it down again, or let it go.</p>
          <div class="go">
            <button class="btn ghost" (click)="talking.discard()">Discard</button>
            <button class="btn primary" (click)="talking.writeDown()">Write it down</button>
          </div>
        }
        @default {
          <p class="hint">
            Tell a story or answer an interview question, with nothing to read. Parrot writes down what you said and shows how each word
            came out.
          </p>
          <div class="go">
            <span class="hint">Up to {{ LONGEST_TALK / 60 }} minutes</span>
            <button class="btn primary" [disabled]="recorder.owner() != null" (click)="talking.start()">
              <app-icon name="mic" [size]="16" /> Start talking
            </button>
          </div>
        }
      }
      @if (talking.failure(); as failure) {
        <p class="error" role="alert">{{ note() }} {{ failure }}</p>
      }
    </section>
  `,
  styles: `
    .talk {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 18px;
    }
    h2 {
      font-size: 17px;
      font-weight: 700;
      margin: 0;
    }
    .hint {
      color: var(--muted);
      font-size: 13px;
      margin: 0;
    }
    .live {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
    }
    .time {
      margin-left: auto;
      font-variant-numeric: tabular-nums;
      color: var(--ink-2);
    }
    .time.ending {
      color: var(--rec);
      font-weight: 700;
    }
    .meter,
    .progress {
      height: 8px;
      border-radius: 8px;
      background: var(--surface-2);
      overflow: hidden;
    }
    .meter i,
    .progress i {
      display: block;
      height: 100%;
      border-radius: 8px;
      background: var(--accent);
      transition: width 0.2s;
    }
    .go {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
    }
    .go .hint {
      margin-right: auto;
    }
    .error {
      margin: 0;
      font-size: 13px;
      color: var(--wrong-ink);
    }
    // on the green button: the spinner in the button's own ink
    .spinner.light {
      border-color: color-mix(in srgb, var(--accent-ink) 35%, transparent);
      border-top-color: var(--accent-ink);
    }
  `,
  host: { '(document:keydown.escape)': 'escape()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TalkCard {
  protected talking = inject(Talking);
  protected recorder = inject(Recorder);
  protected readonly Math = Math;
  protected readonly LONGEST_TALK = LONGEST_TALK;
  protected readonly clock = clock;
  protected readonly note = computed(() => stopNote(this.talking.stopReason()));

  protected escape() {
    if (this.talking.recording()) void this.talking.stop();
  }
}
