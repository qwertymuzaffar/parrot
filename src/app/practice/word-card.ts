import { ChangeDetectionStrategy, Component, computed, inject, resource, signal } from '@angular/core';
import { Engine } from '../core/engine';
import { Names } from '../core/names';
import { Playback } from '../core/playback';
import { Recorder } from '../core/recorder';
import { Session } from '../core/session';
import { WordResult } from '../core/models';
import { CLEAR_FROM, leastSure, SoundUnit, soundUnits } from '../core/sounds';
import { soundTip } from '../core/tips';
import { bare } from '../core/split';
import { WordPractice } from '../core/word-practice';
import { escapeHtml } from '../shared/html';
import { Icon } from '../shared/icon';
import { band } from '../shared/score';
import { SoundUnits } from './sound-units';

/** One word up close: how it should sound, what went wrong, buttons to hear it both ways, and practising it alone. */
@Component({
  selector: 'app-word-card',
  imports: [Icon, SoundUnits],
  // focus moves here when a word is opened (see Practice.wordClick), so a screen reader reads the card next
  host: { role: 'region', tabindex: '-1', '[attr.aria-label]': 'shown()' },
  template: `
    <div class="head">
      <h2>{{ shown() }}</h2>
      @switch (mine()?.status) {
        @case ('good') {
          <span class="pill good">clear</span>
        }
        @case ('unclear') {
          <span class="pill warn">sounded off</span>
        }
        @case ('wrong') {
          <span class="pill bad">{{ mine()?.heard ? 'misheard' : 'not heard' }}</span>
        }
      }
      <button class="btn ghost small square close" (click)="session.selectWord(null)" aria-label="Close">
        <app-icon name="close" [size]="14" />
      </button>
    </div>

    <div class="sounds">
      <span class="eyebrow">Sounds like</span>
      @if (soundsLike()?.spell; as spell) {
        <span class="spell">
          @for (syllable of spell; track $index; let last = $last) {
            @if (syllable[1]) {
              <b>{{ syllable[0].toUpperCase() }}</b>
            } @else {
              <span>{{ syllable[0] }}</span>
            }
            @if (!last) {
              <i>·</i>
            }
          }
        </span>
        <span class="ipa">{{ soundsLike()?.ipa }}</span>
      } @else if (soundsLike() || !word()) {
        <span class="none">Not in the dictionary. Use Hear it.</span>
      } @else if (sounds.error()) {
        <span class="none">Couldn't look it up. Use Hear it.</span>
      }
    </div>

    @if (mine()?.score != null) {
      <div class="take">
        <div class="take-head">
          <span class="eyebrow">Your take</span>
          <span class="pct" [class]="mine()!.status"
            ><b>{{ pct(mine()!.score) }}%</b> sound match</span
          >
        </div>
        @if (units().length) {
          <app-sound-units [units]="units()" />
        }
        @if (weak(); as weak) {
          <p class="weak" [innerHTML]="weak"></p>
        }
        @if (tip(); as tip) {
          <p class="tip">
            <b>How to say {{ tip.sound }}:</b> {{ tip.text }}
          </p>
        }
      </div>
    }

    @if (why()) {
      <p class="why" [innerHTML]="why()"></p>
    }

    <label class="name">
      <input type="checkbox" [checked]="isName()" (change)="markName($any($event.target))" />
      <span><b>A name</b>: never counted as misheard, in any text{{ isName() ? ', from your next reading on' : '' }}</span>
    </label>
    @if (names.error(); as error) {
      <p class="error">{{ error }}</p>
    }

    @if (practice.tries().length) {
      <div class="take">
        <div class="take-head">
          <span class="eyebrow">Word practice</span>
          @if (tried()?.score != null) {
            <span class="pct" [class.unclear]="tried()!.status !== 'good'"
              ><b>{{ pct(tried()!.score) }}%</b> sound match</span
            >
          }
        </div>
        @if (triedUnits().length) {
          <app-sound-units [units]="triedUnits()" />
        }
        @if (triedWeak(); as weak) {
          <p class="weak" [innerHTML]="weak"></p>
        }
        @if (triedTip(); as tip) {
          <p class="tip">
            <b>How to say {{ tip.sound }}:</b> {{ tip.text }}
          </p>
        }
        @if (triedHeard(); as heard) {
          <p class="weak" [innerHTML]="heard"></p>
        }
        <div class="tried">
          @if (asking(); as id) {
            <span class="ask">Delete this try and its recording?</span>
            <button class="btn ghost small" (click)="confirming.set(null)">Keep</button>
            <button class="btn danger small" (click)="removeTry(id)">Delete</button>
          } @else {
            <button class="btn small" [disabled]="!practice.latest()" (click)="playTry()"><app-icon name="play" [size]="12" /> Play</button>
            <span class="scores" aria-label="Sound match of the last tries, newest first">
              @for (each of practice.tries().slice(0, 6); track each.id) {
                <span class="pill" [class]="band(each.score)">{{ each.score }}%</span>
              }
            </span>
            @if (practice.latest(); as latest) {
              <button
                class="btn ghost small icon"
                [disabled]="practice.checking() || practice.recording()"
                (click)="confirming.set(latest.id)"
                aria-label="Delete the newest try of the word"
                title="Delete the newest try of the word"
              >
                <app-icon name="trash" [size]="15" />
              </button>
            }
          }
        </div>
      </div>
    }
    @if (practice.error(); as error) {
      <p class="error">{{ error }}</p>
    }

    <div class="buttons">
      <button class="btn primary" (click)="sayWord()"><app-icon name="volume" [size]="16" /> Hear it</button>
      <button class="btn" (click)="sayWord(true)"><app-icon name="turtle" [size]="16" /> Slowly</button>
      <button class="btn" [disabled]="!mine()?.t" (click)="playMine()"><app-icon name="play" [size]="13" /> Mine</button>
      <button class="btn" [disabled]="!mine()?.t" (click)="compare()"><app-icon name="swap" [size]="16" /> Compare</button>
      <button
        class="btn record"
        [class.on]="practice.recording()"
        [disabled]="practice.checking() || (recorder.owner() != null && !practice.recording())"
        (click)="practice.toggleRecord()"
        (pointerenter)="recorder.warm()"
        (pointerleave)="recorder.cool()"
        (focus)="recorder.warm()"
        (blur)="recorder.cool()"
        [title]="practice.recording() ? 'Stop and score the word' : 'Record the word on its own: it does not change the sentence’s score'"
      >
        @if (practice.recording()) {
          <app-icon name="stop" [size]="14" /> Stop <span class="time">{{ recorder.elapsed().toFixed(1) }} s</span>
        } @else if (practice.preparing()) {
          <span class="spinner"></span> Getting the microphone ready…
        } @else if (practice.checking()) {
          <span class="spinner"></span> Scoring…
        } @else {
          <app-icon name="mic" [size]="16" /> Record the word
        }
      </button>
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 14px;
      outline: none;
    }
    :host(:focus-visible) {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .head {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    // the word, in the practised text's type
    h2 {
      font-family: var(--display);
      letter-spacing: -0.02em;
      font-size: 28px;
      font-weight: 700;
      user-select: text;
      -webkit-user-select: text;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .close {
      margin-left: auto;
    }
    .sounds {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-height: 56px;
    }
    .spell {
      font-size: 22px;
      font-weight: 500;
      b {
        color: var(--accent);
        font-weight: 800;
      }
      i {
        font-style: normal;
        color: var(--muted);
        margin: 0 4px;
      }
    }
    .ipa {
      font-size: 13px;
      color: var(--muted);
    }
    .none {
      color: var(--muted);
    }
    .take {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .take-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }
    .pct {
      font-size: 13px;
      color: var(--muted);
      b {
        font-size: 18px;
        font-weight: 700;
        color: var(--good-ink);
        font-variant-numeric: tabular-nums;
      }
      &.unclear b {
        color: var(--warn-ink);
      }
      &.wrong b {
        color: var(--wrong-ink);
      }
    }
    .weak {
      margin: 0;
      font-size: 13px;
      color: var(--ink-2);
    }
    .tip {
      margin: 0;
      padding-left: 10px;
      font-size: 13px;
      color: var(--ink-2);
      border-left: 2px solid var(--warn-line);
    }
    .name {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: var(--ink-2);
    }
    .name input {
      width: 16px;
      height: 16px;
      accent-color: var(--accent);
    }
    .why {
      margin: 0;
      font-size: 13px;
      color: var(--ink-2);
      background: var(--surface-2);
      border-radius: 8px;
      padding: 8px 10px;
    }
    .buttons {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
    }
    // ---- practising the word alone
    .tried {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 28px;
      .icon {
        margin-left: auto;
      }
    }
    .ask {
      flex: 1;
      font-size: 13px;
      color: var(--ink-2);
    }
    .scores {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      min-width: 0;
    }
    .error {
      margin: 0;
      font-size: 13px;
      color: var(--wrong-ink);
    }
    .record {
      grid-column: 1 / -1;
      app-icon {
        color: var(--rec);
      }
      &.on {
        border-color: var(--rec);
        color: var(--rec);
      }
    }
    /* a slot as wide as the longest time, in digits of one width, so the label doesn't move as the digits change */
    .time {
      display: inline-block;
      min-width: 5.5ch;
      text-align: left;
      font-weight: 500;
      font-variant-numeric: tabular-nums;
    }
    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid var(--line);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WordCard {
  protected session = inject(Session);
  private playback = inject(Playback);
  protected recorder = inject(Recorder);
  private engine = inject(Engine);
  protected practice = inject(WordPractice);
  protected names = inject(Names);
  protected band = band;
  /** the word try asked about deleting: the question goes once another word or try is shown */
  protected confirming = signal<string | null>(null);
  protected readonly asking = computed(() => {
    const id = this.confirming();
    return id && id === this.practice.latest()?.id ? id : null;
  });
  protected readonly index = this.session.selected;
  protected readonly raw = computed(() => {
    const wordIndex = this.index();
    return wordIndex == null ? '' : (this.session.words()[wordIndex] ?? '');
  });
  protected readonly word = computed(() => bare(this.raw()));
  /** the word as the card heads it: punctuation alone ("!!!") is shown as it is written, not as nothing */
  protected readonly shown = computed(() => this.word() || this.raw());
  protected readonly mine = computed(() => {
    const wordIndex = this.index();
    return wordIndex == null || this.session.recording() ? null : (this.session.result()?.words[wordIndex] ?? null);
  });
  protected readonly sounds = resource({
    params: () => this.word() || undefined,
    loader: ({ params }) => this.engine.soundsLike(params),
  });
  /** how the word sounds; null while it is looked up, or if it couldn't be (reading a failed resource's value throws) */
  protected readonly soundsLike = computed(() => (this.sounds.hasValue() ? this.sounds.value() : null));
  protected pct = (score: number | null) => Math.round((score ?? 0) * 100);
  /** the word's sounds as spelled, coloured by how surely each was heard; a word that passed both checks shows its
   * unsure sounds as fair, never off (single-letter scores are rough, and a clear word should not look wrong) */
  protected readonly units = computed(() => this.unitsOf(this.mine()));
  private unitsOf(mine: WordResult | null): SoundUnit[] {
    if (!mine?.letters) return [];
    const units = soundUnits(mine.w, mine.letters);
    return mine.status === 'good'
      ? units.map((unit) => ({ ...unit, level: unit.level === 'bad' || unit.level === 'warn' ? ('fair' as const) : unit.level }))
      : units;
  }
  /** the sound to work on: the weakest that was off, else for a clear word the least sure one under a clear sound */
  private focusOf(mine: WordResult | null, units: SoundUnit[]) {
    const off = units.filter((unit) => unit.level === 'bad' || unit.level === 'warn');
    const least = off.length ? leastSure(off) : mine?.status === 'good' ? leastSure(units) : null;
    return least && (off.length || least.score! < CLEAR_FROM) ? least : null;
  }
  /** how to say that sound */
  private tipOf(mine: WordResult | null, units: SoundUnit[]) {
    const focus = this.focusOf(mine, units);
    return focus ? { sound: focus.text, text: soundTip(focus.text, units.indexOf(focus), units.length) } : null;
  }
  protected readonly tip = computed(() => this.tipOf(this.mine(), this.units()));
  /** the weakest one or two sounds, in words */
  protected readonly weak = computed(() => this.weakOf(this.mine(), this.units()));
  private weakOf(mine: WordResult | null, units: SoundUnit[]) {
    const off = units
      .filter((unit) => unit.level === 'bad' || unit.level === 'warn')
      .sort((first, second) => first.score! - second.score!)
      .slice(0, 2);
    // a misheard or unclear word is explained below instead
    if (!off.length) return mine?.status === 'good' ? this.closest(mine, units) : '';
    const said = (unit: (typeof off)[0]) =>
      `<b>${escapeHtml(unit.text)}</b> ${unit.level === 'bad' ? 'sounded wrong' : 'sounded off'} (${this.pct(unit.score)}%)`;
    return 'The ' + off.map(said).join(', and the ') + '.';
  }
  /** with no sound off: the one heard least surely, or when all were clear, where the rest of the score is */
  private closest(mine: WordResult | null, units: SoundUnit[]) {
    const focus = this.focusOf(mine, units);
    if (focus) return `The <b>${escapeHtml(focus.text)}</b> was the least sure (${this.pct(focus.score)}%).`;
    if (!leastSure(units)) return '';
    const stress = (this.soundsLike()?.spell?.length ?? 0) > 1 ? ', with the stress on the syllable in capitals' : '';
    return `Every sound came through clearly, so there is nothing specific to fix. To sound closer still, listen with Slowly and match the rhythm${stress}.`;
  }
  /** a sentence or two on what happened, as safe HTML (only <b> around text we escape) */
  protected readonly why = computed(() => {
    const mine = this.mine();
    if (!mine) return this.session.result() ? '' : 'Record this part to see how you said it.';
    const out: string[] = [];
    if (mine.status === 'wrong') {
      out.push(mine.heard ? `Heard as <b>“${escapeHtml(mine.heard)}”</b>.` : 'Speech recognition did not hear this word.');
      // a capitalised word inside the sentence is usually a name
      const wordIndex = this.index() ?? 0;
      if (wordIndex > 0 && /^[A-Z]/.test(this.word()))
        out.push('Names are often heard as a common word: if this is one, mark it as a name below and it won’t count as misheard again.');
    }
    if (mine.status !== 'good' && mine.ref != null) out.push(`The reference voice scored ${this.pct(mine.ref)}% here.`);
    if (mine.extra) out.push(`Extra words heard after it: “${escapeHtml(mine.extra)}”.`);
    return out.join(' ');
  });

  // ---- the word said alone (WordPractice): its newest try, its sounds explained as the take's are
  protected readonly tried = computed(() => this.practice.latest()?.words[0] ?? null);
  protected readonly triedUnits = computed(() => this.unitsOf(this.tried()));
  protected readonly triedWeak = computed(() => this.weakOf(this.tried(), this.triedUnits()));
  protected readonly triedTip = computed(() => this.tipOf(this.tried(), this.triedUnits()));
  /** speech recognition is unsure of one word heard alone: a mishearing is told gently, beside the sound match */
  protected readonly triedHeard = computed(() => {
    const tried = this.tried();
    if (tried?.status !== 'wrong') return '';
    const heard = tried.heard ? `heard <b>“${escapeHtml(tried.heard)}”</b>` : 'did not catch it';
    return `Speech recognition ${heard}: on a single word it can be unsure, so trust the sound match too.`;
  });

  protected readonly isName = computed(() => this.names.has(this.raw()));

  protected async markName(box: HTMLInputElement) {
    await this.names.set(this.raw(), box.checked);
    // a mark that failed leaves the list as it was, so the binding has nothing new to show: the box is put back by hand
    box.checked = this.isName();
  }

  protected sayWord(slow = false) {
    this.playback.sayWord(this.raw(), slow);
  }

  protected playMine() {
    const result = this.session.result();
    if (result) this.playback.playMyWord(result, this.index()!);
  }

  protected compare() {
    const result = this.session.result();
    if (result) this.playback.compareWord(result, this.index()!, this.raw());
  }

  protected playTry() {
    const latest = this.practice.latest();
    if (latest) this.playback.playWordTry(latest);
  }

  protected removeTry(id: string) {
    this.confirming.set(null);
    void this.practice.deleteTry(id);
  }
}
