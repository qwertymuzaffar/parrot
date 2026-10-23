import { computed, inject, Injectable, signal } from '@angular/core';
import { Clips } from './clips';
import { Engine } from './engine';
import { errorMessage, Library } from './library';
import { Attempt, AttemptSummary, Mode, Part, PartScore, TextItem } from './models';
import { Playback } from './playback';
import { micError, Recorder } from './recorder';
import { readSetting, writeSetting } from './settings';
import { bare, splitText } from './split';

/** The text open for practice: its parts, the part being practised, its tries, and recording a new one. */
@Injectable({ providedIn: 'root' })
export class Session {
  private engine = inject(Engine);
  private clips = inject(Clips);
  private library = inject(Library);
  private playback = inject(Playback);
  private recorder = inject(Recorder);

  readonly view = signal<'home' | 'practice'>('home');
  private openId = signal<string | null>(null);
  /** the open text, as the library has it now */
  readonly text = computed(() => this.library.texts().find((item) => item.id === this.openId()) ?? null);
  readonly parts = signal<Part[]>([]);
  readonly index = signal(0);
  readonly scores = signal<Record<string, PartScore>>({});

  readonly result = signal<Attempt | null>(null);
  readonly history = signal<AttemptSummary[]>([]);
  readonly checking = signal(false);
  /** a take of the part is being recorded (not one of a word said alone) */
  readonly recording = computed(() => this.recorder.recording() && this.recorder.owner() === 'part');
  readonly preparing = computed(() => this.recorder.preparing() && this.recorder.owner() === 'part');
  readonly selected = signal<number | null>(null);
  /** the loudness of the shown try, for the waveform (null while loading) */
  readonly peaks = signal<number[] | null>(null);
  readonly bars = 92;

  private failure = signal<string | null>(null);
  /** the text and part a take is of, from its start: it is scored against them, wherever the user has gone since */
  private taking: { text: TextItem; part: Part } | null = null;
  /** counts the builds begun: a build that finds a newer one begun (another text opened) gives way to it */
  private builds = 0;
  /** what went wrong last: with this text, else with the library */
  readonly error = computed(() => this.failure() ?? this.library.error());

  readonly part = computed(() => this.parts()[this.index()] ?? null);
  readonly words = computed(() => this.part()?.text.split(' ') ?? []);
  readonly progress = computed(() => {
    const parts = this.parts();
    const scores = this.scores();
    const done = parts.filter((part) => scores[part.key]);
    const avg = done.length ? Math.round(done.reduce((sum, part) => sum + scores[part.key].last, 0) / done.length) : null;
    return { total: parts.length, done: done.length, avg };
  });

  /** the score of the try before the one shown */
  readonly previousScore = computed(() => {
    const result = this.result();
    const history = this.history();
    const shownIndex = history.findIndex((attempt) => attempt.id === result?.id);
    return shownIndex >= 0 && shownIndex + 1 < history.length ? history[shownIndex + 1].score : null;
  });
  /** words of the shown try that came out wrong, for the reading tips */
  readonly troubleWords = computed(() =>
    (this.result()?.words ?? []).filter((word) => word.status === 'wrong').map((word) => bare(word.w)),
  );

  /** what is waited for before a text opens: a talk being recorded stops (Talking, which needs this service) */
  private beforeOpen: (() => Promise<void>)[] = [];

  /** Run `hook`, and wait for it, before a text opens. */
  whenOpening(hook: () => Promise<void>) {
    this.beforeOpen.push(hook);
  }

  /** Open a text at a part: the given one, else where it was left. */
  async open(id: string, index?: number) {
    const text = this.library.texts().find((item) => item.id === id);
    if (!text) return;
    for (const hook of this.beforeOpen) await hook();
    this.playback.stop();
    await this.dropTake();
    this.recorder.warm();
    this.failure.set(null);
    this.openId.set(id);
    this.view.set('practice');
    writeSetting('text', id);
    this.engine.updateText(id, { opened: true }).catch(() => {});
    await this.build(text.mode, index != null ? String(index) : readSetting(`part:${id}:${text.mode}`, '0'));
  }

  /** Add a text and open it; null if the engine would not add it (library.error() says why). */
  async add(text: string, title: string, mode: Mode) {
    const added = await this.library.add(text, title, mode);
    if (added) await this.open(added.id);
    return added;
  }

  home() {
    this.playback.stop();
    void this.dropTake();
    this.failure.set(null);
    this.view.set('home');
    this.library.loadTexts();
    this.library.loadActivity();
  }

  async setMode(mode: Mode) {
    const text = this.text();
    if (!text || text.mode === mode || this.takeUnderWay()) return;
    const w0 = this.part()?.w0 ?? 0;
    this.playback.stop();
    try {
      await this.library.setMode(text.id, mode);
    } catch (error) {
      this.failure.set(errorMessage(error));
      return;
    }
    // another text opened while the mode was saved
    if (this.text()?.id !== text.id) return;
    await this.build(mode, null, w0);
  }

  /** Split the open text and go to a part: the saved one, or the one holding word w0. */
  private async build(mode: Mode, savedIndex: string | null, w0?: number) {
    const text = this.text()!;
    const build = ++this.builds;
    const parts = await splitText(text.text, mode);
    if (build !== this.builds) return;
    this.parts.set(parts);
    // scores that can't be loaded are not "nothing practised yet": say so
    let scores: Record<string, PartScore> = {};
    let failed: string | null = null;
    try {
      scores = await this.engine.scores(text.id);
    } catch (error) {
      failed = errorMessage(error);
    }
    if (build !== this.builds) return;
    this.scores.set(scores);
    let partIndex = w0 != null ? parts.findLastIndex((part) => part.w0 <= w0) : Number(savedIndex ?? 0);
    if (!(partIndex >= 0 && partIndex < parts.length)) partIndex = 0;
    await this.select(partIndex);
    // after select, which clears the error of the part left
    if (failed) this.failure.set(failed);
  }

  async select(partIndex: number) {
    const text = this.text();
    const parts = this.parts();
    // a take of the part under way stays on its part: moving on would record one part as another
    if (!text || partIndex < 0 || partIndex >= parts.length || this.takeUnderWay()) return;
    this.playback.stop();
    this.index.set(partIndex);
    this.result.set(null);
    this.history.set([]);
    this.selected.set(null);
    // what went wrong was on the part left (a take that failed, the microphone)
    this.failure.set(null);
    writeSetting(`part:${text.id}:${text.mode}`, String(partIndex));
    const part = parts[partIndex];
    if (!this.scores()[part.key]) return;
    try {
      const history = await this.engine.attempts(text.id, part.text);
      if (this.part() !== part || !history.length) return;
      this.history.set(history);
      const attempt = await this.engine.attempt(text.id, part.text, history[0].id);
      // the user moved on while the try loaded: it is not this part's
      if (this.part() === part) this.show(attempt);
    } catch (error) {
      if (this.part() === part) this.failure.set(errorMessage(error));
    }
  }

  /** Show a try, and load its waveform. */
  private show(attempt: Attempt) {
    this.result.set(attempt);
    this.peaks.set(null);
    this.clips
      .peaks(attempt.audio, this.bars)
      .then((peaks) => this.result() === attempt && this.peaks.set(peaks))
      .catch(() => {});
  }

  next() {
    this.select(this.index() + 1);
  }

  previous() {
    this.select(this.index() - 1);
  }

  async showAttempt(id: string) {
    const text = this.text();
    const part = this.part();
    if (!text || !part) return;
    this.playback.stop();
    try {
      const attempt = await this.engine.attempt(text.id, part.text, id);
      if (this.part() === part) this.show(attempt);
    } catch (error) {
      if (this.part() === part) this.failure.set(errorMessage(error));
    }
  }

  /** Delete one try of the part shown, and show what is left: the part's scores as the engine counts them now, and
   * the newest try left if the deleted one was shown. Throws what the engine said if it would not. */
  async deleteAttempt(id: string) {
    const text = this.text();
    const part = this.part();
    if (!text || !part || this.takeUnderWay() || this.checking()) return;
    this.playback.stop();
    await this.engine.deleteAttempt(text.id, part.text, id);
    this.library.loadTexts();
    const scores = await this.engine.scores(text.id).catch(() => null);
    // another text opened meanwhile: these are not its scores
    if (this.text()?.id !== text.id) return;
    if (scores) this.scores.set(scores);
    if (this.part() !== part) return;
    const history = await this.engine.attempts(text.id, part.text);
    if (this.part() !== part) return;
    this.history.set(history);
    if (this.result()?.id !== id) return;
    if (!history.length) return this.result.set(null);
    const newest = await this.engine.attempt(text.id, part.text, history[0].id);
    if (this.part() === part) this.show(newest);
  }

  selectWord(wordIndex: number | null) {
    this.selected.set(wordIndex);
  }

  // ---- recording

  /** A take of the part is under way: being recorded, or the microphone readied for it. */
  private takeUnderWay() {
    return this.recorder.owner() === 'part';
  }

  /** A take of the part that can't be kept (the user went elsewhere): dropped, not scored. */
  private async dropTake() {
    if (this.takeUnderWay()) await this.recorder.stop();
    this.taking = null;
  }

  async toggleRecord() {
    // the microphone may be busy with a word said alone (WordPractice): that take is not this one to finish
    if (this.takeUnderWay() && this.recorder.recording()) return this.finishRecording();
    const text = this.text();
    const part = this.part();
    if (this.recorder.owner() || this.checking() || !text || !part) return;
    this.playback.stop();
    this.taking = { text, part };
    try {
      await this.recorder.start('part');
      this.failure.set(null);
    } catch (error) {
      this.failure.set(micError(error));
    }
  }

  private async finishRecording() {
    const { text, part } = this.taking!;
    this.taking = null;
    // scoring from the click on, while the take's last moment is still being recorded
    this.checking.set(true);
    const blob = await this.recorder.stop();
    try {
      const attempt = await this.engine.check(text.id, part.text, blob);
      this.scores.update((scores) => ({
        ...scores,
        [part.key]: {
          last: attempt.score,
          best: Math.max(attempt.score, scores[part.key]?.best ?? 0),
          tries: (scores[part.key]?.tries ?? 0) + 1,
        },
      }));
      this.library.loadTexts();
      if (this.part() !== part) return;
      this.history.set(await this.engine.attempts(text.id, part.text));
      this.show(attempt);
      const first = attempt.words.findIndex((word) => word.status !== 'good');
      this.selected.set(first >= 0 ? first : null);
      this.failure.set(null);
    } catch (error) {
      this.failure.set(errorMessage(error));
    } finally {
      this.checking.set(false);
    }
  }
}
