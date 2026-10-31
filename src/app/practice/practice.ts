import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import { Menu, PRACTICE_ACTIONS, PracticeAction } from '../core/menu';
import { Mode } from '../core/models';
import { Playback, RATES } from '../core/playback';
import { Recorder } from '../core/recorder';
import { Session } from '../core/session';
import { WordPractice } from '../core/word-practice';
import { Names } from '../core/names';
import { Icon } from '../shared/icon';
import { refocus } from '../shared/focus';
import { band } from '../shared/score';
import { fitTo } from './fit';
import { ScoreRing } from './score-ring';
import { Sidebar } from './sidebar';
import { TriesChart } from './tries-chart';
import { Waveform } from './waveform';
import { EditWords } from './edit-words';
import { WordCard } from './word-card';

/** Keys typed into a field are the field's: a box to tick or a button keeps the shortcuts, as any other control does. */
function typing(el: HTMLElement) {
  if (el.tagName === 'INPUT') return !['checkbox', 'button', 'submit', 'reset'].includes((el as HTMLInputElement).type);
  return el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

@Component({
  selector: 'app-practice',
  imports: [EditWords, Icon, ScoreRing, Sidebar, TriesChart, Waveform, WordCard],
  templateUrl: './practice.html',
  styleUrl: './practice.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'key($event)' },
})
export class Practice {
  protected session = inject(Session);
  protected playback = inject(Playback);
  protected recorder = inject(Recorder);
  private words = inject(WordPractice);
  protected names = inject(Names);
  private menu = inject(Menu);
  private injector = inject(Injector);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private destroyRef = inject(DestroyRef);
  readonly settings = output<void>();
  protected band = band;
  private centre = viewChild<ElementRef<HTMLElement>>('centre');
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
  protected readonly rates = RATES;

  /** a take of the part is being recorded (a word said alone is recorded in its card) */
  protected readonly recording = this.session.recording;
  /** a new take of the part is being recorded or scored: the try before it is not what the screen is about */
  protected readonly newTake = computed(() => this.recording() || this.session.checking());
  /** the try shown, unless a new one is being recorded or scored (one that fails to score leaves the try before) */
  protected readonly result = computed(() => (this.newTake() ? null : this.session.result()));
  /** a take being recorded or checked: the words can't be edited until it is filed (EditWords waits for it too) */
  protected readonly taking = computed(() => !!this.recorder.owner() || this.session.checkingText() || this.words.checking());
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
  /** which try of the part the one shown is, counting from the first: the newest is only one of them */
  protected readonly tryNumber = computed(() => {
    const history = this.session.history();
    const shownIndex = history.findIndex((attempt) => attempt.id === this.result()?.id);
    return shownIndex >= 0 ? history.length - shownIndex : history.length;
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
    // and fitted again whenever the centre changes size: the window resized, or the texts column dragged
    afterNextRender(() => {
      const centre = this.centre()?.nativeElement;
      if (!centre || typeof ResizeObserver === 'undefined') return;
      const watcher = new ResizeObserver(() => this.fit());
      watcher.observe(centre);
      this.destroyRef.onDestroy(() => watcher.disconnect());
    });
    // keep the current part in view in the stepper
    effect(() => {
      const partIndex = this.session.index();
      queueMicrotask(() =>
        this.stepper()?.nativeElement.children[partIndex]?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }),
      );
    });
    // another part, with focus in what went with the part left (its word card, a word of it): focus goes to the new
    // part's step, not to the page. Only from inside the screen: with focus on the page the keys are the screen's
    // shortcuts, and on a step Space would press it rather than Listen
    let opened = true;
    effect(() => {
      const partIndex = this.session.index();
      if (opened) return void (opened = false);
      untracked(() => {
        const active = document.activeElement;
        if (active && active !== document.body && this.host.nativeElement.contains(active))
          refocus(() => this.stepper()?.nativeElement.children[partIndex]?.querySelector('button'), this.injector);
      });
    });
    // a card closed from the keyboard (Escape, Close) took focus with it: hand it back to the word, if still on its part
    effect(() => {
      const from = this.keyboardWord;
      if (this.session.selected() != null || !from) return;
      this.keyboardWord = null;
      if (from.part !== untracked(this.session.index)) return;
      afterNextRender(() => document.activeElement === document.body && this.wordButton(from.word)?.focus(), { injector: this.injector });
    });
    // the Practice menu's items do what the keys do
    this.destroyRef.onDestroy(
      this.menu.on((action) => PRACTICE_ACTIONS.includes(action as PracticeAction) && this.act(action as PracticeAction)),
    );
  }

  protected fit() {
    const el = this.sentence()?.nativeElement;
    if (!el) return;
    fitTo(el);
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

  /** for each step, the label of the first step with the same words when it repeats one ("Thank you." said twice), else
   * null: the copies share their tries and score, and count as one part practised */
  protected readonly repeats = computed(() => {
    const first = new Map<string, string>();
    return this.session.parts().map((part) => {
      const label = first.get(part.key);
      if (label == null) first.set(part.key, part.label);
      return label ?? null;
    });
  });

  /** "Same as sentence 1", for a step that repeats another */
  protected sameAs(stepIndex: number) {
    const label = this.repeats()[stepIndex];
    return label != null ? `Same as ${this.unit().toLowerCase()} ${label}` : null;
  }

  /** what a screen reader says for a step: the part and its last score ("Part 3, 64%"), which the bar shows in colour,
   * and the step it repeats, if it does ("Sentence 3, same as sentence 1, 64%") */
  protected stepLabel(label: string, score: number | undefined, same: string | null = null) {
    return `${this.unit()} ${label}, ${same ? same.toLowerCase() + ', ' : ''}${score != null ? `${score}%` : 'not practised'}`;
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

  /** what the screen does for each key, and for each item of the Practice menu, which names the keys */
  private readonly actions: Record<PracticeAction, () => void> = {
    listen: () => this.toggleReference(),
    record: () => this.toggleRecord(),
    mine: () => this.toggleMine(),
    next: () => this.session.next(),
    previous: () => this.session.previous(),
    stop: () => {
      this.playback.stop();
      this.session.selectWord(null);
    },
  };

  /** the keyboard shortcuts while practising */
  private readonly keys: Record<string, PracticeAction> = {
    ' ': 'listen',
    r: 'record',
    R: 'record',
    m: 'mine',
    M: 'mine',
    ArrowDown: 'next',
    ArrowRight: 'next',
    ArrowUp: 'previous',
    ArrowLeft: 'previous',
    Escape: 'stop',
  };

  /** An item of the Practice menu chosen: not while a sheet is open over the screen, as with the keys. */
  act(action: PracticeAction) {
    if (document.querySelector('dialog[open]')) return;
    this.actions[action]();
  }

  protected key(event: KeyboardEvent) {
    // a control that took the key for itself (the texts column's edge takes the arrows) keeps it
    if (event.defaultPrevented) return;
    const el = event.target as HTMLElement;
    if (typing(el) || event.metaKey || event.ctrlKey || event.altKey) return;
    // Space presses the button or ticks the box that has focus, as everywhere else: it means Listen only away from the controls
    if (event.key === ' ' && el.closest?.('button, a[href], [role="button"], input')) return;
    if (document.querySelector('dialog[open]')) return;
    const action = this.keys[event.key];
    if (!action) return;
    this.actions[action]();
    event.preventDefault();
  }
}
