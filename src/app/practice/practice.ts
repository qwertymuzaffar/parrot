import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, output, viewChild } from '@angular/core';
import { Mode } from '../core/models';
import { Playback } from '../core/playback';
import { Recorder } from '../core/recorder';
import { Session } from '../core/session';
import { Icon } from '../shared/icon';
import { band } from '../shared/score';
import { ScoreRing } from './score-ring';
import { Sidebar } from './sidebar';
import { TriesChart } from './tries-chart';
import { Waveform } from './waveform';
import { WordCard } from './word-card';

@Component({
  selector: 'app-practice',
  imports: [Icon, ScoreRing, Sidebar, TriesChart, Waveform, WordCard],
  templateUrl: './practice.html',
  styleUrl: './practice.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'key($event)', '(window:resize)': 'fit()' },
})
export class Practice {
  protected session = inject(Session);
  protected playback = inject(Playback);
  protected recorder = inject(Recorder);
  readonly settings = output<void>();
  protected band = band;
  private stepper = viewChild<ElementRef<HTMLElement>>('stepper');
  private sentence = viewChild<ElementRef<HTMLElement>>('sentence');

  protected readonly modes: { id: Mode; label: string }[] = [
    { id: 'whole', label: 'Whole text' },
    { id: 'sentences', label: 'Sentences' },
    { id: 'short', label: 'Short parts' },
  ];
  protected readonly rates = [0.6, 0.75, 1];

  protected readonly recording = this.recorder.recording;
  /** the try shown, unless a new one is being recorded */
  protected readonly result = computed(() => (this.recording() ? null : this.session.result()));
  protected readonly counts = computed(() => {
    const words = this.result()?.words ?? [];
    return { wrong: words.filter((word) => word.status === 'wrong').length, unclear: words.filter((word) => word.status === 'unclear').length };
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

  protected status(wordIndex: number) {
    return this.result()?.words[wordIndex]?.status ?? '';
  }

  protected heard(wordIndex: number) {
    const word = this.result()?.words[wordIndex];
    return word?.status === 'wrong' ? (word.heard ? `heard “${word.heard}”` : 'not heard') : '';
  }

  protected wordClick(wordIndex: number) {
    this.session.selectWord(wordIndex);
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

  protected pace(wpm: number) {
    return wpm < 120 ? 'slow · aim 140–165' : wpm < 140 ? 'a little slow · aim 140–165' : wpm > 175 ? 'fast · aim 140–165' : 'a natural pace';
  }

  /** the keyboard shortcuts while practising */
  private readonly shortcuts: Record<string, () => void> = {
    ' ': () => this.toggleReference(),
    r: () => this.session.toggleRecord(),
    R: () => this.session.toggleRecord(),
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
    const el = event.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    const action = this.shortcuts[event.key];
    if (!action) return;
    action();
    event.preventDefault();
  }
}
