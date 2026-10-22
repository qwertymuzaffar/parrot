import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { Attempt } from '../core/models';
import { Names } from '../core/names';
import { Playback } from '../core/playback';
import { leastSure, SoundUnit, soundUnits } from '../core/sounds';
import { bare } from '../core/split';
import { Talking } from '../core/talking';
import { soundTip } from '../core/tips';
import { ScoreRing } from '../practice/score-ring';
import { SoundUnits } from '../practice/sound-units';
import { Icon } from '../shared/icon';
import { stopNote } from './talk-card';

/** A talk written down, to check before it is kept: each word as it came out, the words to fix, a title. */
@Component({
  selector: 'app-talk-preview',
  imports: [Icon, ScoreRing, SoundUnits],
  template: `
    @if (talking.talk(); as talk) {
      <header class="top">
        <button class="btn ghost" (click)="leave()"><app-icon name="back" [size]="16" /> Home</button>
        <h1>Check what you said</h1>
      </header>

      <div class="body">
        <section class="card said" aria-label="What Parrot heard">
          <div class="head">
            <span class="eyebrow">What Parrot heard</span>
            <button class="btn small" (click)="play()">
              <app-icon [name]="playback.playing() === 'mine' && !playback.paused() ? 'pause' : 'play'" [size]="13" />
              {{ playback.playing() === 'mine' ? (playback.paused() ? 'Resume' : 'Pause') : 'Play it back' }}
            </button>
          </div>
          <p class="words">
            @for (word of talk.words; track $index; let wordIndex = $index) {
              <button
                type="button"
                class="w"
                [class]="word.status"
                [class.now]="playback.nowMine() === wordIndex"
                [class.sel]="selected() === wordIndex"
                [class.name]="names.has(word.w)"
                [attr.aria-label]="word.w + (word.status === 'unclear' ? ' — sounded off' : '')"
                [attr.aria-pressed]="selected() === wordIndex"
                (click)="select(wordIndex)"
              >
                {{ word.w }}
              </button>
              @if (pauseAfter(wordIndex); as gap) {
                <span class="pause" role="img" [attr.aria-label]="'a pause of ' + gap.toFixed(1) + ' seconds'">{{ gap.toFixed(1) }} s</span>
              }
            }
          </p>
          <div class="stats">
            <app-score-ring [score]="talk.score" />
            <div>
              <b>{{ talk.wpm }}</b> words a minute · {{ minutes(talk.duration) }}
              <br />
              <span class="hint">
                {{ unclear() }} sounded off
                @if (talk.pauses.length) {
                  · {{ talk.pauses.length }} pause{{ talk.pauses.length === 1 ? '' : 's' }} over a second
                }
              </span>
              @if (note()) {
                <br /><span class="hint">{{ note() }}</span>
              }
            </div>
          </div>
        </section>

        <div class="side">
          @if (word(); as chosen) {
            <section class="card word" aria-label="The word" tabindex="-1">
              <div class="head">
                <h2>{{ chosen.bare }}</h2>
                <span class="pill" [class]="chosen.result.status === 'good' ? 'good' : 'warn'">{{
                  chosen.result.status === 'good' ? 'clear' : 'sounded off'
                }}</span>
                <button class="btn ghost close" (click)="selected.set(null)" aria-label="Close">
                  <app-icon name="close" [size]="15" />
                </button>
              </div>
              @if (chosen.result.score != null) {
                <span class="hint"
                  ><b>{{ Math.round(chosen.result.score * 100) }}%</b> sound match</span
                >
              }
              @if (chosen.units.length) {
                <app-sound-units [units]="chosen.units" />
              }
              @if (chosen.tip; as tip) {
                <p class="tip">
                  <b>How to say {{ tip.sound }}:</b> {{ tip.text }}
                </p>
              }
              <div class="buttons">
                <button class="btn primary small" (click)="playback.sayWord(chosen.bare)">
                  <app-icon name="volume" [size]="14" /> Hear it
                </button>
                <button class="btn small" (click)="playback.sayWord(chosen.bare, true)">
                  <app-icon name="turtle" [size]="14" /> Slowly
                </button>
                <button class="btn small" [disabled]="!chosen.result.t" (click)="playback.playMyWord(attempt()!, chosen.index)">
                  <app-icon name="play" [size]="12" /> Mine
                </button>
                <button
                  class="btn small"
                  [disabled]="!chosen.result.t"
                  (click)="playback.compareWord(attempt()!, chosen.index, chosen.bare)"
                >
                  <app-icon name="swap" [size]="14" /> Compare
                </button>
              </div>
              <label class="name">
                <input type="checkbox" [checked]="names.has(chosen.bare)" (change)="names.set(chosen.bare, $any($event.target).checked)" />
                <span><b>A name</b>: never counted as misheard, in any text</span>
              </label>
            </section>
          }

          <section class="card fix" aria-label="Keep it">
            <label class="eyebrow" for="said">Not what you said? Fix the words</label>
            <p class="hint">
              Change a word Parrot wrote to the one you meant: it then shows as misheard, with what was heard. That is the word to work on.
            </p>
            <textarea id="said" class="field" [value]="said()" (input)="said.set($any($event.target).value)"></textarea>
            <label class="eyebrow" for="talk-title-field">Title</label>
            <input
              id="talk-title-field"
              class="field"
              [placeholder]="firstWords()"
              [value]="title()"
              (input)="title.set($any($event.target).value)"
            />
            @if (talking.failure(); as failure) {
              <p class="error" role="alert">{{ failure }}</p>
            }
            <div class="go">
              @if (confirming()) {
                <span class="ask">Discard this talk and its recording?</span>
                <button class="btn ghost small" (click)="confirming.set(false)">Keep it</button>
                <button class="btn danger small" (click)="discard()">Discard</button>
              } @else {
                <button class="btn ghost" (click)="askDiscard()">Discard</button>
                <button class="btn primary" [disabled]="!said().trim() || talking.state() === 'keeping'" (click)="keep()">
                  @if (talking.state() === 'keeping') {
                    <span class="spinner"></span> Saving…
                  } @else {
                    Save and practise
                  }
                </button>
              }
            </div>
          </section>
        </div>
      </div>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: calc(var(--titlebar) + 18px) 24px 24px;
      min-height: 100vh;
      background: var(--ground);
    }
    .top {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    h1 {
      font-size: 22px;
      margin: 0;
    }
    .body {
      display: grid;
      grid-template-columns: minmax(0, 1.6fr) minmax(300px, 1fr);
      gap: 16px;
      align-items: start;
    }
    @media (max-width: 900px) {
      .body {
        grid-template-columns: 1fr;
      }
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 18px;
    }
    .side {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .head {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .head .btn {
      margin-left: auto;
    }
    .words {
      margin: 0;
      font-size: 20px;
      line-height: 2;
    }
    .w {
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      padding: 0 3px;
      border-radius: 6px;
      cursor: pointer;
    }
    .w:hover {
      background: var(--surface-2);
    }
    .w.unclear {
      background: var(--warn-bg);
      box-shadow: inset 0 -3px 0 var(--warn-line);
    }
    .w.wrong {
      background: var(--wrong-bg);
      box-shadow: inset 0 -3px 0 var(--wrong-ink);
    }
    .w.now {
      background: var(--now);
      color: var(--now-ink);
    }
    .w.sel {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .w.name {
      text-decoration: underline dotted var(--muted);
      text-underline-offset: 5px;
    }
    .pause {
      display: inline-block;
      margin: 0 4px;
      padding: 0 5px;
      border-radius: 6px;
      background: var(--surface-2);
      color: var(--muted);
      font-size: 11px;
      font-weight: 600;
      vertical-align: middle;
      line-height: 1.6;
    }
    .stats {
      display: flex;
      align-items: center;
      gap: 16px;
      font-size: 14px;
    }
    .hint {
      color: var(--muted);
      font-size: 13px;
      margin: 0;
    }
    h2 {
      font-size: 26px;
      margin: 0;
    }
    .close {
      width: 32px;
      height: 32px;
      padding: 0;
    }
    .tip {
      margin: 0;
      font-size: 13px;
      background: var(--surface-2);
      border-radius: 12px;
      padding: 10px 12px;
    }
    .buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    label.name {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: var(--ink-2);
      cursor: pointer;
    }
    label.name input {
      width: 16px;
      height: 16px;
      accent-color: var(--accent);
    }
    textarea {
      min-height: 160px;
      resize: vertical;
      font: inherit;
      line-height: 1.5;
    }
    .go {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
    }
    .ask {
      margin-right: auto;
      font-size: 13px;
    }
    .error {
      margin: 0;
      font-size: 13px;
      color: var(--wrong-ink);
    }
  `,
  host: { '(document:keydown.escape)': 'selected.set(null)' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TalkPreview {
  protected talking = inject(Talking);
  protected playback = inject(Playback);
  protected names = inject(Names);
  protected readonly Math = Math;

  /** the word looked at */
  protected readonly selected = signal<number | null>(null);
  /** what was said, as the user corrects it: what Parrot heard to begin with */
  protected readonly said = linkedSignal(() => this.talking.talk()?.heard ?? '');
  /** the text's title: empty for each new talk (the text is then titled by its first words) */
  protected readonly title = linkedSignal({ source: () => this.talking.talk(), computation: () => '' });
  protected readonly confirming = signal(false);
  protected readonly note = computed(() => stopNote(this.talking.stopReason()));

  /** the talk as a try, so it plays back and is cut into words as a try is */
  protected readonly attempt = computed((): Attempt | null => {
    const talk = this.talking.talk();
    if (!talk) return null;
    const { heard, words, duration, wpm, score, audio, pauses } = talk;
    return { id: 'talk', when: '', text: heard, heard, words, duration, wpm, score, audio, pauses };
  });
  protected readonly unclear = computed(() => this.talking.talk()?.words.filter((word) => word.status !== 'good').length ?? 0);
  protected readonly firstWords = computed(() => `${(this.talking.talk()?.heard ?? '').split(' ').slice(0, 6).join(' ')}…`);

  /** the word looked at, with its sounds coloured by how surely each was heard and how to say the weakest */
  protected readonly word = computed(() => {
    const index = this.selected();
    const result = index == null ? null : this.talking.talk()?.words[index];
    if (index == null || !result) return null;
    let units: SoundUnit[] = result.letters ? soundUnits(result.w, result.letters) : [];
    // a word that came out clear shows its unsure sounds as fair, never off, as the word card does
    if (result.status === 'good')
      units = units.map((unit) => ({ ...unit, level: unit.level === 'bad' || unit.level === 'warn' ? 'fair' : unit.level }));
    const off = units.filter((unit) => unit.level === 'bad' || unit.level === 'warn');
    const focus = off.length ? leastSure(off) : null;
    const tip = focus ? { sound: focus.text, text: soundTip(focus.text, units.indexOf(focus), units.length) } : null;
    return { index, result, bare: bare(result.w), units, tip };
  });

  protected pauseAfter(wordIndex: number) {
    return this.talking.talk()?.pauses.find(([after]) => after === wordIndex)?.[1] ?? null;
  }

  protected minutes(seconds: number) {
    return seconds < 60 ? `${Math.round(seconds)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
  }

  protected select(wordIndex: number) {
    this.selected.set(this.selected() === wordIndex ? null : wordIndex);
  }

  protected play() {
    const attempt = this.attempt();
    if (attempt) this.playback.toggleMine(attempt);
  }

  protected keep() {
    this.playback.stop();
    void this.talking.keep(this.said(), this.title());
  }

  /** A talk of over a minute is asked about first: it may be a lot to say again. */
  protected askDiscard() {
    if ((this.talking.talk()?.duration ?? 0) > 60) this.confirming.set(true);
    else this.discard();
  }

  protected discard() {
    this.playback.stop();
    this.confirming.set(false);
    void this.talking.discard();
  }

  protected leave() {
    this.askDiscard();
  }
}
