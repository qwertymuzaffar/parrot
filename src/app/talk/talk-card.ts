import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Recorder } from '../core/recorder';
import { LONGEST_TALK, StopReason, Talking } from '../core/talking';
import { focusIn, refocus } from '../shared/focus';
import { Icon } from '../shared/icon';
import { PROMPT_SETS } from './prompts';

/** What to say of a talk that stopped by itself. */
export function stopNote(reason: StopReason | null) {
  if (reason === 'quiet') return 'Stopped after 2 quiet minutes.';
  if (reason === 'longest') return `Stopped at the ${LONGEST_TALK / 60}-minute limit.`;
  if (reason === 'microphone') return 'Stopped when the microphone was disconnected.';
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
            <!-- there from the start, and one height for the whole talk: Stop stays under the pointer as the words come.
              Not read out: it would talk over the speaker, and into the microphone -->
            @let soFar = talking.heardSoFar();
            <p class="so-far" [class.empty]="!soFar">
              <span>{{ soFar ? lastWords(soFar) : 'Your words show here as Parrot hears them.' }}</span>
            </p>
            <div class="go">
              <span class="hint">Stop when you're done. Esc also stops.</span>
              <button class="btn primary stop" (click)="talking.stop()" #lead><app-icon name="stop" [size]="14" /> Stop</button>
            </div>
          } @else {
            <!-- the microphone opening and settling: a word said now would be lost, so the card says to wait -->
            <p class="hint" role="status">Getting the microphone ready. Start talking when it says Listening.</p>
            <div class="go">
              <button class="btn ghost" (click)="talking.stop()" #lead>Cancel</button>
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
            <button class="btn" (click)="talking.cancel()" #lead>Cancel</button>
          </div>
        }
        @case ('stopped') {
          <p class="hint" role="status">The recording is kept. Write it down again, or let it go.</p>
          <div class="go">
            @if (confirming()) {
              <span class="hint">Discard this talk and its recording?</span>
              <button class="btn ghost small" (click)="confirming.set(false)" #keepIt>Keep it</button>
              <button class="btn danger small" (click)="discard()">Discard</button>
            } @else {
              <button class="btn ghost" (click)="confirming.set(true)" #discardButton>Discard</button>
              <button class="btn primary" (click)="talking.writeDown()" #lead>Write it down</button>
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
                <button class="btn ghost small" (click)="confirming.set(false)" #keepIt>Keep it</button>
                <button class="btn danger small" (click)="discard()">Discard</button>
              } @else {
                <button class="btn ghost" (click)="confirming.set(true)" #discardButton>Discard</button>
                @if (left.heard) {
                  <button class="btn primary" (click)="talking.checkUnfinished()" #lead>Check it</button>
                } @else {
                  <button class="btn primary" (click)="talking.writeDown()" #lead>Write it down</button>
                }
              }
            </div>
          } @else {
            <p class="hint">
              Tell a story or answer an interview question, with nothing to read. Parrot writes down what you said and shows how each word
              came out.
            </p>
            <!-- one chip always chosen: talking about anything is a choice in view, not a set turned off again -->
            <div class="sets" role="group" aria-label="Something to talk about">
              <button
                type="button"
                class="chip"
                [class.on]="talking.prompts() === null"
                [attr.aria-pressed]="talking.prompts() === null"
                (click)="talking.choosePrompts(null)"
              >
                Anything
              </button>
              @for (set of sets; track set.key) {
                <button
                  type="button"
                  class="chip"
                  [class.on]="talking.prompts() === set.key"
                  [attr.aria-pressed]="talking.prompts() === set.key"
                  (click)="talking.prompts() !== set.key && talking.choosePrompts(set.key)"
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
              <button
                class="btn primary"
                [disabled]="recorder.owner() != null"
                (click)="talking.start()"
                (pointerenter)="recorder.warm()"
                (pointerleave)="recorder.cool()"
                (focus)="recorder.warm()"
                (blur)="recorder.cool()"
                #lead
              >
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
      gap: 8px;
      padding: 14px 16px;
    }
    h2 {
      font-size: 15px;
      font-weight: 600;
      margin: 0;
    }
    .hint {
      color: var(--muted);
      font-size: 12px;
      margin: 0;
    }
    .live {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
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
      height: 6px;
      border-radius: 6px;
      background: var(--surface-2);
      overflow: hidden;
    }
    .meter i,
    .progress i {
      display: block;
      height: 100%;
      border-radius: 6px;
      background: var(--accent);
      transition: width 0.2s;
    }
    // as high as a button: the small ones of a confirm don't shrink the card under the pointer
    .go {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      min-height: 32px;
    }
    .go .hint {
      margin-right: auto;
    }
    .error {
      margin: 0;
      font-size: 12px;
      color: var(--wrong-ink);
    }
    .so-far {
      margin: 0;
      padding: 8px 10px;
      border-radius: 6px;
      background: var(--surface-2);
      color: var(--ink-2);
      font-size: 13px;
      line-height: 1.5;
      user-select: text;
      -webkit-user-select: text;
    }
    // three lines, the newest at the foot: the lines before are cut off at the top, a whole line at a time
    .so-far span {
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      height: calc(3 * 1.5em);
      overflow: hidden;
    }
    .so-far.empty {
      color: var(--muted);
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
      font-size: 12px;
      font-weight: 500;
      padding: 3px 10px;
      border-radius: 99px;
    }
    // the chosen chip has the outline and the fill, at the same weight: a bolder label is wider and would move the others
    .chip.on {
      border-color: var(--accent);
      background: var(--good-bg);
      color: var(--ink);
    }
    .asked {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .prompt {
      flex: 1;
      font-size: 14px;
      font-weight: 500;
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
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private injector = inject(Injector);
  /** what to press next in each state: Stop while talking, Cancel while it is written down, Write it down when stopped */
  private lead = viewChild<ElementRef<HTMLElement>>('lead');
  private keepIt = viewChild<ElementRef<HTMLElement>>('keepIt');
  private discardButton = viewChild<ElementRef<HTMLElement>>('discardButton');

  constructor() {
    // each state draws the card anew, and the button pressed goes with it: focus goes on to what is pressed next (asked
    // whether to discard, to Keep it; kept, back to Discard), not to the page. Not when Home is drawn: nothing was pressed
    let drawn = false;
    let asked = false;
    effect(() => {
      // recording: the microphone getting ready (Cancel), then listening (Stop)
      if (this.talking.state() === 'recording') this.talking.recording();
      const confirming = this.confirming();
      const kept = asked && !confirming;
      asked = confirming;
      if (!drawn) return void (drawn = true);
      untracked(() => {
        if (!focusIn(this.host.nativeElement)) return;
        refocus(() => (confirming ? this.keepIt() : kept ? this.discardButton() : this.lead())?.nativeElement, this.injector);
      });
    });
  }

  protected discard() {
    this.confirming.set(false);
    void this.talking.discard();
  }

  /** Esc stops a talk, and cancels writing it down, as the card's button does then, unless it is closing a dialog
   * (Settings) or leaving a field (a title being renamed), as on the practice screen */
  protected escape(event: Event) {
    const el = event.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || document.querySelector('dialog[open]')) return;
    if (this.talking.recording()) void this.talking.stop();
    else if (this.talking.state() === 'writing') this.talking.cancel();
  }
}
