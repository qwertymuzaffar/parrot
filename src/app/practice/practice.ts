import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import { Mode } from '../core/models';
import { Playback } from '../core/playback';
import { Recorder } from '../core/recorder';
import { Session } from '../core/session';
import { WordPractice } from '../core/word-practice';
import { Names } from '../core/names';
import { Icon } from '../shared/icon';
import { band } from '../shared/score';
import { ScoreRing } from './score-ring';
import { Sidebar } from './sidebar';
import { TriesChart } from './tries-chart';
import { Waveform } from './waveform';
import { EditWords } from './edit-words';
import { WordCard } from './word-card';

@Component({
  selector: 'app-practice',
  imports: [EditWords, Icon, ScoreRing, Sidebar, TriesChart, Waveform, WordCard],
  templateUrl: './practice.html',
  styleUrl: './practice.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'key($event)', '(document:pointerdown)': 'recorder.warm()', '(window:resize)': 'fit()' },
})
export class Practice {
  protected session = inject(Session);
  protected playback = inject(Playback);
  protected recorder = inject(Recorder);
  private words = inject(WordPractice);
  protected names = inject(Names);
  private injector = inject(Injector);
  readonly settings = output<void>();
  protected band = band;
  private stepper = viewChild<ElementRef<HTMLElement>>('stepper');
  private sentence = viewChild<ElementRef<HTMLElement>>('sentence');
  private wordCard = viewChild(WordCard, { read: ElementRef });
  /** the word whose card was opened from the keyboard: focus goes back to it when the card closes */
  private keyboardWord: { part: number; word: number } | null = null;

  protected readonly modes: { id: Mode; label: string }[] = [
    { id: 'whole', label: 'Whole text' },
    { id: 'sentences', label: 'Sentences' },
    { id: 'short', label: 'Short parts' },
  ];
  protected readonly rates = [0.6, 0.75, 1];

  /** a take of the part is being recorded (a word said alone is recorded in its card) */
  protected readonly recording = this.session.recording;
  /** the try shown, unless a new one is being recorded */
  protected readonly result = computed(() => (this.recording() ? null : this.session.result()));
  protected readonly counts = computed(() => {
    const words = this.result()?.words ?? [];
    return {
      wrong: words.filter((word) => word.status === 'wrong').length,
      unclear: words.filter((word) => word.status === 'unclear').length,
    };
  });
  protected readonly delta = computed(() => {
    const result = this.result();
    const previousScore = this.session.previousScore();
    return result && previousScore != null ? result.score - previousScore : null;
  });
  protected readonly unit = computed(
    () => ({ whole: 'Text', sentences: 'Sentence', short: 'Part' })[this.session.text()?.mode ?? 'sentences'],
  );
  protected readonly size = computed(() => {
    const wordCount = this.session.words().length;
    return wordCount > 120 ? 'xl' : wordCount > 45 ? 'long' : '';
  });

  constructor() {
    // the sentence as large as the card allows: shrink the type until it fits (long texts still scroll at 18 px)
    effect(() => {
      this.session.words();
      this.size();
      this.result();
      queueMicrotask(() => this.fit());
    });
    // keep the current part in view in the stepper
    effect(() => {
      const partIndex = this.session.index();
      queueMicrotask(() =>
        this.stepper()?.nativeElement.children[partIndex]?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }),
      );
    });
    // a card closed from the keyboard (Escape, Close) took focus with it: hand it back to the word, if still on its part
    effect(() => {
      const from = this.keyboardWord;
      if (this.session.selected() != null || !from) return;
      this.keyboardWord = null;
      if (from.part !== untracked(this.session.index)) return;
      afterNextRender(() => document.activeElement === document.body && this.wordButton(from.word)?.focus(), { injector: this.injector });
    });
  }

  protected fit() {
    const el = this.sentence()?.nativeElement;
    if (!el) return;
    el.style.fontSize = '';
    let size = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollHeight > el.clientHeight + 1 && size > 18) {
      size -= 1;
      el.style.fontSize = `${size}px`;
    }
  }

  private wordButton(wordIndex: number) {
    return this.sentence()?.nativeElement.children[wordIndex] as HTMLElement | undefined;
  }

  protected status(wordIndex: number) {
    return this.result()?.words[wordIndex]?.status ?? '';
  }

  /** how long the pause after a word was, when it was a long one (seconds) */
  protected pauseAfter(wordIndex: number) {
    return this.result()?.pauses?.find(([after]) => after === wordIndex)?.[1] ?? null;
  }

  protected heard(wordIndex: number) {
    const word = this.result()?.words[wordIndex];
    return word?.status === 'wrong' ? (word.heard ? `heard “${word.heard}”` : 'not heard') : '';
  }

  /** what a screen reader says for a word: how it came out, which the screen shows in colour */
  protected wordLabel(wordIndex: number, word: string) {
    const result = this.result()?.words[wordIndex];
    const said = this.names.has(word) ? `${word}, a name` : word;
    if (result?.status === 'wrong') return `${said} — ${result.heard ? `misheard as “${result.heard}”` : 'not heard'}`;
    if (result?.status === 'unclear') return `${said} — sounded off`;
    return said;
  }

  /** what a screen reader says for a step: the part and its last score ("Part 3, 64%"), which the bar shows in colour */
  protected stepLabel(label: string, score: number | undefined) {
    return `${this.unit()} ${label}, ${score != null ? `${score}%` : 'not practised'}`;
  }

  protected wordClick(wordIndex: number, event: MouseEvent) {
    this.session.selectWord(wordIndex);
    // a click from Enter or Space has no click count
    this.keyboardWord = event.detail === 0 ? { part: this.session.index(), word: wordIndex } : null;
    // the card says how the word sounds and came out: focus goes there, so a screen reader reads it next
    afterNextRender(() => this.wordCard()?.nativeElement.focus(), { injector: this.injector });
    const shown = this.result();
    const word = shown?.words[wordIndex];
    if (shown && word?.t && word.status !== 'good') this.playback.compareWord(shown, wordIndex, this.session.words()[wordIndex]);
    else this.playback.sayWord(this.session.words()[wordIndex]);
  }

  protected toggleReference() {
    const part = this.session.part();
    if (part) this.playback.toggleReference(part.text);
  }

  protected toggleMine() {
    const shown = this.session.result();
    if (shown) this.playback.toggleMine(shown);
  }

  protected compare() {
    const shown = this.session.result();
    const part = this.session.part();
    if (shown && part) this.playback.compare(shown, part.text);
  }

  /** R records the part, or stops the word being recorded alone (each take is finished by whoever started it) */
  private toggleRecord() {
    if (this.recorder.owner() === 'word') this.words.toggleRecord();
    else this.session.toggleRecord();
  }

  protected pace(wpm: number) {
    return wpm < 120
      ? 'slow · aim 140–165'
      : wpm < 140
        ? 'a little slow · aim 140–165'
        : wpm > 175
          ? 'fast · aim 140–165'
          : 'a natural pace';
  }

  /** the keyboard shortcuts while practising */
  private readonly shortcuts: Record<string, () => void> = {
    ' ': () => this.toggleReference(),
    r: () => this.toggleRecord(),
    R: () => this.toggleRecord(),
    m: () => this.toggleMine(),
    M: () => this.toggleMine(),
    ArrowDown: () => this.session.next(),
    ArrowRight: () => this.session.next(),
    ArrowUp: () => this.session.previous(),
    ArrowLeft: () => this.session.previous(),
    Escape: () => {
      this.playback.stop();
      this.session.selectWord(null);
    },
  };

  protected key(event: KeyboardEvent) {
    this.recorder.warm();
    const el = event.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || event.metaKey || event.ctrlKey || event.altKey) return;
    // Space presses the button that has focus, as everywhere else: it means Listen only away from the controls
    if (event.key === ' ' && el.closest?.('button, a[href], [role="button"]')) return;
    if (document.querySelector('dialog[open]')) return;
    const action = this.shortcuts[event.key];
    if (!action) return;
    action();
    event.preventDefault();
  }
}
