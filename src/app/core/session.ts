import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { Clips } from './clips';
import { Engine } from './engine';
import { errorMessage, Library } from './library';
import { Attempt, AttemptSummary, Mode, Part, PartScore, TextItem } from './models';
import { Playback } from './playback';
import { MIC_LOST, micError, Recorder } from './recorder';
import { readSetting, writeSetting } from './settings';
import { bare, distinctKeys, splitText } from './split';

/** a part's tries as they go on screen with it: its newest in full, and what went wrong loading them */
interface Tries {
  history: AttemptSummary[];
  attempt: Attempt | null;
  failed: string | null;
}

const UNPRACTISED: Tries = { history: [], attempt: null, failed: null };

/** The text open for practice: its parts, the part being practised, its tries, and recording a new one. */
@Injectable({ providedIn: 'root' })
export class Session {
  private engine = inject(Engine);
  private clips = inject(Clips);
  private library = inject(Library);
  private playback = inject(Playback);
  private recorder = inject(Recorder);

  readonly view = signal<'home' | 'practice'>('home');
  /** the text clicked, while its parts and scores are fetched: its card says it is coming */
  readonly opening = signal<string | null>(null);
  private openId = signal<string | null>(null);
  /** the open text, as the library has it now */
  readonly text = computed(() => this.library.texts().find((item) => item.id === this.openId()) ?? null);
  readonly parts = signal<Part[]>([]);
  readonly index = signal(0);
  readonly scores = signal<Record<string, PartScore>>({});

  readonly result = signal<Attempt | null>(null);
  readonly history = signal<AttemptSummary[]>([]);
  /** the takes being scored, each by its text and part: only that part waits for its score, not every text */
  private scoring = signal<{ textId: string; partKey: string }[]>([]);
  /** a take of the part shown is being scored: the part says so, and its Record waits */
  readonly checking = computed(() => {
    const textId = this.openId();
    const key = this.part()?.key;
    return this.scoring().some((take) => take.textId === textId && take.partKey === key);
  });
  /** a take of a part of the open text is being scored: the text's words wait for it, or it would be filed under words
   * the text no longer has */
  readonly checkingText = computed(() => this.scoring().some((take) => take.textId === this.openId()));
  /** how many loads (a text's parts and scores, a mode's save) are under way */
  private loads = signal(0);
  /** a text or mode is loading, and the screen still shows the parts before. No take starts meanwhile: it would be of
   * the part shown, and filed where the user was not reading. */
  readonly loading = computed(() => this.loads() > 0);
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
  /** counts the opens and builds begun: one that finds a newer one begun (another text opened, Home, a talk) gives
   * way to it */
  private builds = 0;
  /** the part being gone to while its tries load (see goTo) */
  private going: number | null = null;
  /** counts the times the part shown, or the try on it, changed: a part's tries or a try that land after such a
   * change are not what is shown any more, and are dropped */
  private shows = 0;
  /** what went wrong with this text: a take, its parts or tries, the microphone. Not the library's (a text that
   * would not be added, renamed or deleted, the list that would not load): Home says those, and shown here they read
   * as the open text's. */
  readonly error = this.failure.asReadonly();

  constructor() {
    // the open text has gone from the library (deleted as it was opened, or not in the list the engine gave): the
    // practice screen would have no title, no words and dead controls
    effect(() => {
      if (this.view() === 'practice' && this.openId() && !this.text()) this.home();
    });
  }

  readonly part = computed(() => this.parts()[this.index()] ?? null);
  readonly words = computed(() => this.part()?.text.split(' ') ?? []);
  /** how much of the text is practised, counted over its distinct parts (see distinctKeys) */
  readonly progress = computed(() => {
    const keys = distinctKeys(this.parts());
    const scores = this.scores();
    const done = keys.filter((key) => scores[key]);
    const avg = done.length ? Math.round(done.reduce((sum, key) => sum + scores[key].last, 0) / done.length) : null;
    return { total: keys.length, done: done.length, avg };
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
    // this open's turn, from the click: another text clicked, Home or a talk started meanwhile takes the screen instead
    const build = ++this.builds;
    for (const hook of this.beforeOpen) await hook();
    if (build !== this.builds) return;
    this.playback.stop();
    await this.dropTake();
    if (build !== this.builds) return;
    writeSetting('text', id);
    this.engine.updateText(id, { opened: true }).catch(() => {});
    // the text shows (and the practice screen, from Home) once its parts and scores are in
    this.opening.set(id);
    try {
      await this.build(text, text.mode, index != null ? String(index) : readSetting(`part:${id}:${text.mode}`, '0'));
    } finally {
      // open, or given way: its card no longer says it is coming (unless clicked again meanwhile, and still coming)
      if (this.opening() === id) this.opening.set(null);
    }
  }

  /** Add a text and open it; null if the engine would not add it (library.error() says why). */
  async add(text: string, title: string, mode: Mode) {
    const build = this.builds;
    const added = await this.library.add(text, title, mode);
    // the user opened a text, or went elsewhere, while it was added: it waits in the library
    if (added && build === this.builds) await this.open(added.id);
    return added;
  }

  home() {
    this.playback.stop();
    void this.dropTake();
    this.failure.set(null);
    this.view.set('home');
    this.dropOpening();
    this.library.loadTexts();
    this.library.loadActivity();
  }

  /** Drop the open of a text still under way: Home, or a talk, has the screen now, and the text would take it when its
   * parts and scores land. */
  dropOpening() {
    this.builds++;
    this.opening.set(null);
  }

  async setMode(mode: Mode) {
    const text = this.text();
    if (!text || text.mode === mode || this.takeUnderWay()) return;
    const w0 = this.part()?.w0 ?? 0;
    this.playback.stop();
    try {
      await this.whileLoading(this.library.setMode(text.id, mode));
    } catch (error) {
      this.failure.set(errorMessage(error));
      return;
    }
    // another text opened while the mode was saved
    if (this.text()?.id !== text.id) return;
    await this.build(text, mode, null, w0);
  }

  /** `work` counts as loading while it runs: no take starts meanwhile. */
  private async whileLoading<T>(work: Promise<T>) {
    this.loads.update((count) => count + 1);
    try {
      return await work;
    } finally {
      this.loads.update((count) => count - 1);
    }
  }

  /** Split a text and go to a part: the saved one, or the one holding word w0. The text, its parts, their scores and
   * the part with its newest try go on screen together once all are in, so the new words never show with the try of
   * the part left, nor a part number past the end of the new parts (no part at all). */
  private async build(text: TextItem, mode: Mode, savedIndex: string | null, w0?: number) {
    const build = ++this.builds;
    const parts = await this.whileLoading(splitText(text.text, mode));
    if (build !== this.builds) return;
    // scores that can't be loaded are not "nothing practised yet": say so
    let scores: Record<string, PartScore> = {};
    let failed: string | null = null;
    try {
      scores = await this.whileLoading(this.engine.scores(text.id));
    } catch (error) {
      failed = errorMessage(error);
    }
    if (build !== this.builds) return;
    let partIndex = w0 != null ? parts.findLastIndex((part) => part.w0 <= w0) : Number(savedIndex ?? 0);
    // a saved place that isn't one of the parts (damaged storage: 1.5, -1, abc) is the first part
    if (!(Number.isInteger(partIndex) && partIndex >= 0 && partIndex < parts.length)) partIndex = 0;
    // the part's newest try comes with it (see goTo)
    const part = parts[partIndex];
    const tries = part && scores[part.key] ? await this.whileLoading(this.triesOf(text, part, () => build === this.builds)) : UNPRACTISED;
    if (build !== this.builds) return;
    // a take under way (none should be: no take starts while loading) is of the part still shown, so it is dropped
    // rather than filed where the user was not reading
    if (this.takeUnderWay()) await this.dropTake();
    if (build !== this.builds) return;
    this.openId.set(text.id);
    this.view.set('practice');
    this.parts.set(parts);
    this.scores.set(scores);
    // in the same moment: the part with its own try, not the try of the part left
    this.shows++;
    this.put(partIndex, tries);
    // after put, which clears the error of the part left
    if (failed) this.failure.set(failed);
  }

  async select(partIndex: number) {
    const text = this.text();
    const parts = this.parts();
    // a take of the part under way stays on its part: moving on would record one part as another
    if (!text || partIndex < 0 || partIndex >= parts.length || this.takeUnderWay()) return;
    this.playback.stop();
    await this.goTo(partIndex);
  }

  /** Go to part `partIndex` of the open text. A practised part goes on screen once its newest try is in, the two
   * together: shown without it first, the part flashed the "How it works" card and a chart with no try on it. */
  private async goTo(partIndex: number) {
    const text = this.text()!;
    const part = this.parts()[partIndex];
    const show = ++this.shows;
    // nothing to wait for
    if (!this.scores()[part.key]) return this.put(partIndex, UNPRACTISED);
    this.going = partIndex;
    // the part shown stays until then, so no take starts meanwhile: it would be of the part being left
    const tries = await this.whileLoading(this.triesOf(text, part, () => show === this.shows));
    // the user moved on again while the tries loaded: these are not the tries to show
    if (show === this.shows) this.put(partIndex, tries);
  }

  /** A part's tries, and its newest in full, while `still()` holds; what went wrong if they can't be loaded. */
  private async triesOf(text: TextItem, part: Part, still: () => boolean): Promise<Tries> {
    let history: AttemptSummary[] = [];
    try {
      history = await this.engine.attempts(text.id, part.text);
      const attempt = history.length && still() ? await this.engine.attempt(text.id, part.text, history[0].id) : null;
      return { history, attempt, failed: null };
    } catch (error) {
      return { history, attempt: null, failed: errorMessage(error) };
    }
  }

  /** Put part `partIndex` of the open text on screen with its tries, all in the same moment. */
  private put(partIndex: number, tries: Tries) {
    const text = this.text()!;
    this.going = null;
    this.index.set(partIndex);
    this.history.set(tries.history);
    this.selected.set(null);
    // what went wrong was on the part left (a take that failed, the microphone), unless the tries would not load
    this.failure.set(tries.failed);
    if (tries.attempt) this.show(tries.attempt);
    else this.result.set(null);
    writeSetting(`part:${text.id}:${text.mode}`, String(partIndex));
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

  /** the part after the one being gone to, or shown: keys pressed quickly step on from each other */
  next() {
    this.select((this.going ?? this.index()) + 1);
  }

  previous() {
    this.select((this.going ?? this.index()) - 1);
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
    if (this.recorder.owner() || this.checking() || this.loading() || !text || !part) return;
    this.playback.stop();
    const taking = (this.taking = { text, part });
    try {
      // the microphone going while the take is recorded ends it there: it is dropped, and the screen says why
      await this.recorder.start('part', { lost: () => this.lost(taking) });
      // the screen moved on while the microphone got ready: a take of the part left is dropped, not filed there
      if (this.taking === taking && (this.text()?.id !== text.id || this.part() !== part)) return await this.dropTake();
      this.failure.set(null);
    } catch (error) {
      this.failure.set(micError(error));
    }
  }

  private lost(taking: { text: TextItem; part: Part }) {
    if (this.taking === taking) this.taking = null;
    this.failure.set(MIC_LOST);
  }

  private async finishRecording() {
    const { text, part } = this.taking!;
    this.taking = null;
    // scoring from the click on, while the take's last moment is still being recorded
    const scored = { textId: text.id, partKey: part.key };
    this.scoring.update((takes) => [...takes, scored]);
    const blob = await this.recorder.stop();
    try {
      const attempt = await this.engine.check(text.id, part.text, blob);
      // another text opened meanwhile: the try is kept with its own, and shows when that one opens
      if (this.text()?.id !== text.id) return void this.library.loadTexts();
      this.scores.update((scores) => ({
        ...scores,
        [part.key]: {
          last: attempt.score,
          best: Math.max(attempt.score, scores[part.key]?.best ?? 0),
          tries: (scores[part.key]?.tries ?? 0) + 1,
        },
      }));
      this.library.loadTexts();
      // on the way to a part (see goTo): the tries it is loading may be from before the take, so they are loaded again
      if (this.going != null) {
        if (this.parts()[this.going] === part) void this.goTo(this.going);
        return;
      }
      if (this.part() !== part) return;
      // the take is the part's newest try: a list of its tries on its way from before is stale
      const show = ++this.shows;
      const history = await this.engine.attempts(text.id, part.text);
      // the user moved on, to another part or text, while the tries loaded: the take is shown when they come back
      if (show !== this.shows) return;
      this.history.set(history);
      this.show(attempt);
      const first = attempt.words.findIndex((word) => word.status !== 'good');
      this.selected.set(first >= 0 ? first : null);
      this.failure.set(null);
    } catch (error) {
      if (this.text()?.id === text.id) this.failure.set(errorMessage(error));
    } finally {
      this.scoring.update((takes) => takes.filter((take) => take !== scored));
    }
  }
}
