import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Recorder } from '../core/recorder';
import { LONGEST_TALK, StopReason, Talking } from '../core/talking';
import { Icon } from '../shared/icon';
import { PROMPT_SETS } from './prompts';

/** What to say of a talk that stopped by itself. */
export function stopNote(reason: StopReason | null) {
  if (reason === 'quiet') return 'Stopped after 2 quiet minutes.';
  if (reason === 'longest') return `Stopped at the ${LONGEST_TALK / 60}-minute limit.`;
  return '';
}

/** The end of what was heard so far, as much as fits a few lines. */
export function lastWords(text: string, count = 30) {
  const words = text.split(' ');
  return words.length > count ? '…' + words.slice(-count).join(' ') : text;
}

/** m:ss */
export function clock(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** When a talk left from last time was started, as a person says it: today at 14:05, yesterday, on 20 October. */
export function since(started: string, now = new Date()) {
  const then = new Date(started);
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(now) - day(then)) / 86_400_000);
  if (days === 0) return `today at ${String(then.getHours()).padStart(2, '0')}:${String(then.getMinutes()).padStart(2, '0')}`;
  if (days === 1) return 'yesterday';
  return `on ${then.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`;
}

/** How long a talk is, roughly: 45 s, 3 min. */
export function length(seconds: number) {
  return seconds < 60 ? `${Math.max(1, Math.round(seconds))} s` : `${Math.round(seconds / 60)} min`;
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
          @if (talking.about(); as prompt) {
            <q class="prompt">{{ prompt }}</q>
          }
          @if (talking.recording()) {
            <!-- a screen reader is told what changes, not the clock every second over the talk -->
            <div class="live">
              <span class="rec-dot"></span>
              <b role="status">Listening…</b>
              <span class="time" [class.ending]="talking.left() <= 60">
                {{ talking.left() <= 60 ? clock(talking.left()) + ' left' : clock(recorder.elapsed()) }}
              </span>
              <span class="sr-only" role="status">{{ talking.left() <= 60 ? 'One minute left.' : '' }}</span>
            </div>
            <div class="meter" aria-hidden="true"><i [style.width.%]="recorder.level() * 100"></i></div>
            @if (talking.heardSoFar(); as soFar) {
              <!-- not read out: it would talk over the speaker, and into the microphone -->
              <p class="so-far">{{ lastWords(soFar) }}</p>
            }
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
        @case ('stopping') {
          <div class="live" role="status">
            <span class="spinner"></span>
            <span>Stopping…</span>
          </div>
        }
        @case ('writing') {
          <div class="live">
            <span class="spinner"></span>
            <!-- how far it has got is the progress bar's, there to ask for, not read out at every step -->
            <span
              ><span role="status">Writing down what you said…</span>
              <span aria-hidden="true">&ngsp;{{ Math.round(talking.progress() * 100) }}%</span></span
            >
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
            @if (confirming()) {
              <span class="hint">Discard this talk and its recording?</span>
              <button class="btn ghost small" (click)="confirming.set(false)">Keep it</button>
              <button class="btn danger small" (click)="discard()">Discard</button>
            } @else {
              <button class="btn ghost" (click)="confirming.set(true)">Discard</button>
              <button class="btn primary" (click)="talking.writeDown()">Write it down</button>
            }
          </div>
        }
        @default {
          @if (talking.unfinished(); as left) {
            <p class="hint" role="status">
              You have an unfinished talk from {{ since(left.started) }}, {{ length(left.duration) }}.
              {{ left.heard ? 'It was written down, but not saved.' : 'It was not written down yet.' }}
            </p>
            <div class="go">
              @if (confirming()) {
                <span class="hint">Discard this talk and its recording?</span>
                <button class="btn ghost small" (click)="confirming.set(false)">Keep it</button>
                <button class="btn danger small" (click)="discard()">Discard</button>
              } @else {
                <button class="btn ghost" (click)="confirming.set(true)">Discard</button>
                @if (left.heard) {
                  <button class="btn primary" (click)="talking.checkUnfinished()">Check it</button>
                } @else {
                  <button class="btn primary" (click)="talking.writeDown()">Write it down</button>
                }
              }
            </div>
          } @else {
            <p class="hint">
              Tell a story or answer an interview question, with nothing to read. Parrot writes down what you said and shows how each word
              came out.
            </p>
            <div class="sets" role="group" aria-label="Something to talk about">
              @for (set of sets; track set.key) {
                <button
                  type="button"
                  class="chip"
                  [class.on]="talking.prompts() === set.key"
                  [attr.aria-pressed]="talking.prompts() === set.key"
                  (click)="talking.choosePrompts(talking.prompts() === set.key ? null : set.key)"
                >
                  {{ set.label }}
                </button>
              }
            </div>
            @if (talking.prompt(); as prompt) {
              <div class="asked">
                <q class="prompt">{{ prompt }}</q>
                <button
                  type="button"
                  class="btn ghost small icon"
                  aria-label="Another question"
                  title="Another question"
                  (click)="talking.anotherPrompt()"
                >
                  <app-icon name="shuffle" [size]="15" />
                </button>
              </div>
            }
            <div class="go">
              <span class="hint">Up to {{ LONGEST_TALK / 60 }} minutes</span>
              <button class="btn primary" [disabled]="recorder.owner() != null" (click)="talking.start()">
                <app-icon name="mic" [size]="16" /> Start talking
              </button>
            </div>
          }
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
    .so-far {
      margin: 0;
      padding: 10px 12px;
      border-radius: 10px;
      background: var(--surface-2);
      color: var(--ink-2);
      font-size: 14px;
      line-height: 1.5;
    }
    .sets {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .chip {
      border: 1px solid var(--line);
      background: var(--surface);
      color: var(--ink-2);
      font-size: 12.5px;
      font-weight: 500;
      padding: 4px 11px;
      border-radius: 99px;
    }
    .chip.on {
      border-color: var(--accent);
      background: var(--good-bg);
      color: var(--ink);
      font-weight: 600;
    }
    .asked {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .prompt {
      flex: 1;
      font-size: 15px;
      font-weight: 600;
      color: var(--ink);
      quotes: '“' '”';
    }
    // on the green button: the spinner in the button's own ink
    .spinner.light {
      border-color: color-mix(in srgb, var(--accent-ink) 35%, transparent);
      border-top-color: var(--accent-ink);
    }
  `,
  host: { '(document:keydown.escape)': 'escape($event)' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TalkCard {
  protected talking = inject(Talking);
  protected recorder = inject(Recorder);
  protected readonly Math = Math;
  protected readonly LONGEST_TALK = LONGEST_TALK;
  protected readonly sets = PROMPT_SETS;
  protected readonly clock = clock;
  protected readonly lastWords = lastWords;
  protected readonly note = computed(() => stopNote(this.talking.stopReason()));
  protected readonly since = since;
  protected readonly length = length;
  /** asking before a talk kept on the card (left, or stopped) is discarded */
  protected readonly confirming = signal(false);

  protected discard() {
    this.confirming.set(false);
    void this.talking.discard();
  }

  /** Esc stops a talk, unless it is closing a dialog (Settings) or leaving a field (a title being renamed), as on the
   * practice screen */
  protected escape(event: Event) {
    const el = event.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || document.querySelector('dialog[open]')) return;
    if (this.talking.recording()) void this.talking.stop();
  }
}
