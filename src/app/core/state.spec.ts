import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Clips } from './clips';
import { Engine, EngineError } from './engine';
import { Library } from './library';
import { Activity, Attempt, Mode, PartScore, TextItem, WordStatus } from './models';
import { Playback } from './playback';
import { Recorder, TakeFor } from './recorder';
import { Session } from './session';
import { Sound, Track } from './sound';
import { bare, partKey } from './split';
import { WordPractice } from './word-practice';
import { TriesChart } from '../practice/tries-chart';

const TEXT = 'Hello there. How are you? I am fine.';
const ID = '95e3ac5665';

/** An attempt at `part`, its words judged as given (status per word, in order). */
function attempt(id: string, part: string, score: number, statuses: WordStatus[] = []): Attempt {
  const words = part.split(' ').map((word, wordIndex) => ({
    w: word,
    t: [wordIndex * 0.5, wordIndex * 0.5 + 0.4] as [number, number],
    score: 0.9,
    ref: null,
    status: statuses[wordIndex] ?? ('good' as WordStatus),
    heard: null,
    extra: '',
  }));
  return { id, when: '2026-10-20T12:00:00', text: part, heard: part, words, duration: 2, wpm: 140, score, audio: `texts/${ID}/${id}.wav` };
}

/** The engine, kept in memory: one text, and the tries of each part (oldest first). */
class FakeEngine extends Engine {
  library: TextItem[] = [];
  tries: Record<string, Attempt[]> = {};
  /** the tries of words said alone, by the word in lower case without its punctuation (oldest first) */
  wordTries: Record<string, Attempt[]> = {};
  /** what the next take is scored as, and the next take of a word alone */
  nextCheck: Attempt | null = null;
  nextWordCheck: Attempt | null = null;
  /** the engine has stopped answering: every call fails */
  down = false;
  /** why the next delete of a try is refused, if it is */
  refuseDelete: string | null = null;
  calls: string[] = [];
  /** calls held back until the test lets them through, by call ("attempt t1", "scores <text id>") */
  private held = new Map<string, Promise<void>>();

  /** Hold a call back; the function returned lets it (and any made meanwhile) through. */
  hold(call: string) {
    let release!: () => void;
    this.held.set(call, new Promise<void>((resolve) => (release = resolve)));
    return () => {
      this.held.delete(call);
      release();
    };
  }

  /** log a call, and wait while it is held back */
  private async pass(call: string) {
    this.calls.push(call);
    await this.held.get(call);
  }

  private answer() {
    if (this.down) throw new EngineError('The speech engine is not running.');
  }

  item(change: Partial<TextItem> = {}): TextItem {
    return {
      id: ID,
      title: 'Greeting',
      text: TEXT,
      words: 8,
      created: '2026-10-20T10:00:00',
      opened: null,
      mode: 'sentences',
      practised: 0,
      average: null,
      scores: {},
      ...change,
    };
  }

  async info(): Promise<never> {
    throw new Error('not used');
  }
  async downloadModels(): Promise<never> {
    throw new Error('not used');
  }
  async texts() {
    this.calls.push('texts');
    this.answer();
    return [...this.library];
  }
  async addText(text: string, title: string, mode: Mode) {
    this.calls.push(`addText ${title}`);
    if (!text.trim()) throw new EngineError('the text is empty');
    const added = this.item({ id: 'abcdef0123', text, title, mode });
    this.library.unshift(added);
    return added;
  }
  async updateText(id: string, change: { title?: string; mode?: Mode; opened?: boolean }) {
    await this.pass(`updateText ${JSON.stringify(change)}`);
    this.answer();
    const index = this.library.findIndex((item) => item.id === id);
    const { opened, ...rest } = change;
    this.library[index] = { ...this.library[index], ...rest, ...(opened ? { opened: '2026-10-20T12:00:00' } : {}) };
    return this.library[index];
  }
  async deleteText(id: string) {
    this.calls.push(`deleteText ${id}`);
    this.answer();
    this.library = this.library.filter((item) => item.id !== id);
  }
  async scores(textId: string) {
    await this.pass(`scores ${textId}`);
    this.answer();
    const scores: Record<string, PartScore> = {};
    for (const [part, tries] of Object.entries(this.tries)) {
      if (!tries.length) continue;
      scores[await partKey(part)] = { last: tries.at(-1)!.score, best: Math.max(...tries.map((each) => each.score)), tries: tries.length };
    }
    return scores;
  }
  async attempts(_textId: string, part: string) {
    this.calls.push(`attempts ${part}`);
    this.answer();
    return [...(this.tries[part] ?? [])].reverse().map(({ id, when, score, wpm, duration }) => ({ id, when, score, wpm, duration }));
  }
  async attempt(_textId: string, part: string, id: string) {
    await this.pass(`attempt ${id}`);
    this.answer();
    return this.tries[part].find((each) => each.id === id)!;
  }
  async deleteAttempt(_textId: string, part: string, id: string) {
    this.calls.push(`deleteAttempt ${id}`);
    if (this.refuseDelete) throw new EngineError(this.refuseDelete);
    this.tries[part] = (this.tries[part] ?? []).filter((each) => each.id !== id);
  }
  async check(_textId: string, part: string) {
    this.calls.push(`check ${part}`);
    if (!this.nextCheck) throw new EngineError('Nothing was heard in the recording. Is the microphone on?');
    (this.tries[part] ??= []).push(this.nextCheck);
    return this.nextCheck;
  }
  async checkWord(_textId: string, word: string) {
    this.calls.push(`checkWord ${word}`);
    if (!this.nextWordCheck) throw new EngineError('Nothing was heard in the recording. Is the microphone on?');
    (this.wordTries[bare(word).toLowerCase()] ??= []).push(this.nextWordCheck);
    return this.nextWordCheck;
  }
  async wordAttempts(_textId: string, word: string) {
    this.calls.push(`wordAttempts ${word}`);
    const tries = this.wordTries[bare(word).toLowerCase()] ?? [];
    return [...tries].reverse().map(({ id, when, score, wpm, duration }) => ({ id, when, score, wpm, duration }));
  }
  async wordAttempt(_textId: string, word: string, id: string) {
    this.calls.push(`wordAttempt ${id}`);
    return this.wordTries[bare(word).toLowerCase()].find((each) => each.id === id)!;
  }
  async deleteWordAttempt(_textId: string, word: string, id: string) {
    this.calls.push(`deleteWordAttempt ${id}`);
    if (this.refuseDelete) throw new EngineError(this.refuseDelete);
    const key = bare(word).toLowerCase();
    this.wordTries[key] = (this.wordTries[key] ?? []).filter((each) => each.id !== id);
  }
  async trashSize(): Promise<never> {
    throw new Error('not used');
  }
  async emptyTrash(): Promise<never> {
    throw new Error('not used');
  }
  async openDataFolder(): Promise<never> {
    throw new Error('not used');
  }
  async activity(): Promise<Activity> {
    return { days: [], tries: 0, average: null };
  }
  async soundsLike() {
    return {};
  }
  audioUrl(path: string) {
    return `audio:${path}`;
  }
}

/** Plays nothing: it logs what would play, and a test ends it (end) or it is stopped. */
class FakeSound {
  readonly playing = signal<Track | null>(null);
  readonly paused = signal(false);
  readonly voiceMissing = signal(false);
  log: string[] = [];
  onWord?: (charIndex: number) => void;
  onTime?: (seconds: number) => void;
  private finish: (() => void) | null = null;

  private start(entry: string, track: Track | null) {
    this.stop();
    this.log.push(entry);
    this.playing.set(track);
    return new Promise<void>((resolve) => (this.finish = resolve));
  }
  speak(text: string, rate = 1, track: Track | null = 'ref', onWord?: (charIndex: number) => void) {
    this.onWord = onWord;
    return this.start(`speak "${text}" at ${rate}`, track);
  }
  play(url: string, track: Track, onTime?: (seconds: number) => void) {
    this.onTime = onTime;
    return this.start(`play ${url}`, track);
  }
  playClip(url: string) {
    return this.start(`clip ${url}`, null);
  }
  togglePause() {
    this.log.push('toggle pause');
    this.paused.update((paused) => !paused);
  }
  /** the current sound plays to its end */
  end() {
    const finish = this.finish;
    this.finish = null;
    this.playing.set(null);
    finish?.();
  }
  stop() {
    this.end();
  }
}

class FakeClips {
  async peaks() {
    return [0.5, 1];
  }
  async cut(url: string, from: number, to: number) {
    return `${url}#${from.toFixed(2)}-${to.toFixed(2)}`;
  }
}

class FakeRecorder {
  readonly recording = signal(false);
  readonly owner = signal<TakeFor | null>(null);
  readonly elapsed = signal(0);
  readonly preparing = signal(false);
  micAllowed = true;
  warm() {}
  async start(owner: TakeFor) {
    if (!this.micAllowed) throw new Error('Permission denied');
    this.owner.set(owner);
    this.recording.set(true);
  }
  async stop() {
    this.recording.set(false);
    this.owner.set(null);
    return new Blob(['take'], { type: 'audio/wav' });
  }
}

/** Everything the interface does with the app's state, so the scenarios below don't depend on where it lives. */
function practiceApp() {
  const library = TestBed.inject(Library);
  const session = TestBed.inject(Session);
  const playback = TestBed.inject(Playback);
  const text = () => session.part()!.text;
  const shown = () => session.result()!;
  return {
    loadTexts: () => library.loadTexts(),
    texts: () => library.texts(),
    loaded: () => library.loaded(),
    engineState: () => library.engineState(),
    error: () => session.error(),
    view: () => session.view(),
    add: (text: string, title: string, mode: Mode) => session.add(text, title, mode),
    rename: (id: string, title: string) => library.rename(id, title),
    remove: (id: string) => library.remove(id),
    open: (id: string, index?: number) => session.open(id, index),
    home: () => session.home(),
    text: () => session.text(),
    parts: () => session.parts(),
    index: () => session.index(),
    part: () => session.part(),
    words: () => session.words(),
    scores: () => session.scores(),
    progress: () => session.progress(),
    setMode: (mode: Mode) => session.setMode(mode),
    select: (partIndex: number) => session.select(partIndex),
    next: () => session.next(),
    previous: () => session.previous(),
    result: () => session.result(),
    history: () => session.history(),
    peaks: () => session.peaks(),
    previousScore: () => session.previousScore(),
    troubleWords: () => session.troubleWords(),
    showAttempt: (id: string) => session.showAttempt(id),
    deleteAttempt: (id: string) => session.deleteAttempt(id),
    selected: () => session.selected(),
    selectWord: (wordIndex: number | null) => session.selectWord(wordIndex),
    rate: () => playback.rate(),
    setRate: (rate: number) => playback.setRate(rate),
    nowRef: () => playback.nowRef(),
    nowMine: () => playback.nowMine(),
    playReference: () => playback.playReference(text()),
    playMine: () => playback.playMine(shown()),
    toggleReference: () => playback.toggleReference(text()),
    toggleMine: () => playback.toggleMine(shown()),
    compare: () => playback.compare(shown(), text()),
    stop: () => playback.stop(),
    sayWord: (wordIndex: number, slow?: boolean) => playback.sayWord(session.words()[wordIndex], slow),
    playMyWord: (wordIndex: number) => playback.playMyWord(shown(), wordIndex),
    compareWord: (wordIndex: number) => playback.compareWord(shown(), wordIndex, session.words()[wordIndex]),
    toggleRecord: () => session.toggleRecord(),
    checking: () => session.checking(),
    recording: () => session.recording(),
    playWordTry: (attempt: Attempt) => playback.playWordTry(attempt),
  };
}

describe('the practice state', () => {
  let engine: FakeEngine;
  let sound: FakeSound;
  let recorder: FakeRecorder;
  let app: ReturnType<typeof practiceApp>;
  /** let pending promises (engine calls, part keys) settle */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(async () => {
    localStorage.clear();
    engine = new FakeEngine();
    engine.library = [engine.item()];
    sound = new FakeSound();
    recorder = new FakeRecorder();
    TestBed.configureTestingModule({
      providers: [
        { provide: Engine, useValue: engine },
        { provide: Sound, useValue: sound },
        { provide: Clips, useValue: new FakeClips() },
        { provide: Recorder, useValue: recorder },
      ],
    });
    app = practiceApp();
    await app.loadTexts();
  });

  afterEach(() => vi.useRealTimers());

  describe('the library', () => {
    it('loads the texts and marks the engine ready', () => {
      expect(app.texts().map((text) => text.id)).toEqual([ID]);
      expect([app.loaded(), app.engineState(), app.error()]).toEqual([true, 'ready', null]);
    });

    it('says when the engine is down, and loads once it is up', async () => {
      vi.useFakeTimers();
      engine.down = true;
      await app.loadTexts();
      expect([app.engineState(), app.error()]).toEqual(['down', 'The speech engine is not running.']);
      engine.down = false;
      await vi.advanceTimersByTimeAsync(3000);
      expect([app.engineState(), app.error()]).toEqual(['ready', null]);
    });

    it('tries again on one timer, however often loading fails', async () => {
      vi.useFakeTimers();
      engine.down = true;
      await app.loadTexts();
      await app.loadTexts();
      await app.loadTexts();
      engine.calls = [];
      await vi.advanceTimersByTimeAsync(3000);
      expect(engine.calls).toEqual(['texts']);
      await vi.advanceTimersByTimeAsync(3000);
      expect(engine.calls).toEqual(['texts', 'texts']);
    });

    it('adds a text and opens it', async () => {
      await app.add('One more text.', 'New', 'whole');
      expect(app.texts().map((text) => text.id)).toEqual(['abcdef0123', ID]);
      expect([app.view(), app.text()?.id, app.parts().length]).toEqual(['practice', 'abcdef0123', 1]);
    });

    it("reports a text the engine wouldn't add", async () => {
      await app.add('  ', 'Empty', 'whole');
      expect(app.error()).toBe('the text is empty');
      expect(app.view()).toBe('home');
    });

    it('forgets why a text was refused once one is added', async () => {
      await app.add('  ', 'Empty', 'whole');
      await app.add('One more text.', 'New', 'whole');
      expect(app.error()).toBeNull();
    });

    it('renames a text, the open one too', async () => {
      await app.open(ID);
      await app.rename(ID, 'Hi');
      expect([app.texts()[0].title, app.text()?.title]).toEqual(['Hi', 'Hi']);
    });

    it('says why a text could not be renamed or deleted, and keeps it as it was', async () => {
      engine.down = true;
      await app.rename(ID, 'Hi');
      expect([app.texts()[0].title, app.error()]).toEqual(['Greeting', 'The speech engine is not running.']);
      await app.remove(ID);
      expect([app.texts().length, app.error()]).toEqual([1, 'The speech engine is not running.']);
      engine.down = false;
      await app.rename(ID, 'Hi');
      expect([app.texts()[0].title, app.error()]).toEqual(['Hi', null]);
    });

    it('removes a text', async () => {
      await app.remove(ID);
      expect(app.texts()).toEqual([]);
      expect(engine.calls).toContain(`deleteText ${ID}`);
    });
  });

  describe('a text open for practice', () => {
    it('opens at the first part, split into sentences', async () => {
      await app.open(ID);
      expect(app.view()).toBe('practice');
      expect(app.parts().map((part) => part.text)).toEqual(['Hello there.', 'How are you?', 'I am fine.']);
      expect([app.index(), app.words()]).toEqual([0, ['Hello', 'there.']]);
      expect(engine.calls).toContain('updateText {"opened":true}');
    });

    it('opens where it was left, or at the part asked for', async () => {
      await app.open(ID);
      await app.select(2);
      await app.home();
      await app.open(ID);
      expect(app.index()).toBe(2);
      await app.open(ID, 1);
      expect(app.index()).toBe(1);
    });

    it('shows the latest try of a part, its history and waveform', async () => {
      engine.tries['How are you?'] = [attempt('t1', 'How are you?', 60), attempt('t2', 'How are you?', 75, ['good', 'wrong', 'good'])];
      await app.open(ID, 1);
      await settle();
      expect(app.result()?.id).toBe('t2');
      expect(app.history().map((summary) => summary.id)).toEqual(['t2', 't1']);
      expect([app.previousScore(), app.troubleWords(), app.peaks()]).toEqual([60, ['are'], [0.5, 1]]);
      await app.showAttempt('t1');
      await settle();
      expect([app.result()?.id, app.previousScore()]).toEqual(['t1', null]);
    });

    it("doesn't ask for the tries of a part never recorded", async () => {
      await app.open(ID, 2);
      expect(app.result()).toBeNull();
      expect(engine.calls.some((call) => call.startsWith('attempts'))).toBe(false);
    });

    it('moves between parts, staying inside the text', async () => {
      await app.open(ID);
      app.previous();
      await settle();
      expect(app.index()).toBe(0);
      app.next();
      await settle();
      app.next();
      await settle();
      app.next();
      await settle();
      expect(app.index()).toBe(2);
    });

    it('keeps its place when the mode changes', async () => {
      await app.open(ID, 2);
      await app.setMode('whole');
      expect([app.parts().length, app.index(), app.text()?.mode, app.texts()[0].mode]).toEqual([1, 0, 'whole', 'whole']);
      await app.setMode('sentences');
      expect(app.index()).toBe(0);
    });

    it('counts the parts done and their average', async () => {
      engine.tries['Hello there.'] = [attempt('t1', 'Hello there.', 80)];
      engine.tries['I am fine.'] = [attempt('t2', 'I am fine.', 91)];
      await app.open(ID);
      expect(app.progress()).toEqual({ total: 3, done: 2, avg: 86 });
    });

    it("doesn't show a part's try on the part moved to while it loaded", async () => {
      engine.tries['Hello there.'] = [attempt('t1', 'Hello there.', 80, ['wrong', 'good'])];
      const release = engine.hold('attempt t1');
      const opening = app.open(ID, 0);
      await vi.waitFor(() => expect(engine.calls).toContain('attempt t1'));
      app.next();
      await settle();
      release();
      await opening;
      await settle();
      expect([app.index(), app.result(), app.history()]).toEqual([1, null, []]);
    });

    it("doesn't show a try chosen on a part left while it loaded", async () => {
      engine.tries['Hello there.'] = [attempt('t1', 'Hello there.', 60), attempt('t2', 'Hello there.', 80)];
      await app.open(ID, 0);
      const release = engine.hold('attempt t1');
      const showing = app.showAttempt('t1');
      app.next();
      await settle();
      release();
      await showing;
      await settle();
      expect([app.index(), app.result()]).toEqual([1, null]);
    });

    it('opens the text clicked last, where it was left, when an earlier one is still loading', async () => {
      engine.library.push(engine.item({ id: 'b0b0b0b0b0', title: 'Other', text: 'One. Two. Three.' }));
      await app.loadTexts();
      localStorage.setItem(`parrot.part:${ID}:sentences`, '2');
      const releaseFirst = engine.hold(`scores ${ID}`);
      const first = app.open(ID);
      await vi.waitFor(() => expect(engine.calls).toContain(`scores ${ID}`));
      await app.open('b0b0b0b0b0');
      releaseFirst();
      await first;
      await settle();
      expect([app.text()?.id, app.parts().map((part) => part.text), app.index()]).toEqual(['b0b0b0b0b0', ['One.', 'Two.', 'Three.'], 0]);
      expect(localStorage.getItem('parrot.part:b0b0b0b0b0:sentences')).toBe('0');
    });

    it('opens a text clicked while the mode of the one before was saved, in its own mode', async () => {
      engine.library.push(engine.item({ id: 'b0b0b0b0b0', title: 'Other', text: 'One. Two. Three.' }));
      await app.loadTexts();
      await app.open(ID);
      const release = engine.hold('updateText {"mode":"whole"}');
      const changing = app.setMode('whole');
      await app.open('b0b0b0b0b0');
      release();
      await changing;
      await settle();
      expect([app.text()?.id, app.parts().length]).toEqual(['b0b0b0b0b0', 3]);
    });

    it("says the scores couldn't be loaded, rather than showing nothing practised", async () => {
      engine.tries['Hello there.'] = [attempt('t1', 'Hello there.', 80)];
      engine.down = true;
      await app.open(ID);
      expect([app.view(), app.progress().done, app.error()]).toEqual(['practice', 0, 'The speech engine is not running.']);
    });

    it("says a part's tries or a try chosen couldn't be loaded", async () => {
      engine.tries['How are you?'] = [attempt('t1', 'How are you?', 60), attempt('t2', 'How are you?', 75)];
      await app.open(ID);
      engine.down = true;
      app.next();
      await settle();
      expect([app.index(), app.result(), app.error()]).toEqual([1, null, 'The speech engine is not running.']);
      await app.showAttempt('t1');
      expect(app.error()).toBe('The speech engine is not running.');
      engine.down = false;
      app.previous();
      await settle();
      expect(app.error()).toBeNull();
    });

    it("keeps the mode when the engine won't save another, and says why", async () => {
      await app.open(ID);
      engine.down = true;
      await app.setMode('whole');
      expect([app.parts().length, app.text()?.mode, app.error()]).toEqual([3, 'sentences', 'The speech engine is not running.']);
    });

    it('stops anything playing on going home', async () => {
      await app.open(ID);
      app.playReference();
      app.home();
      expect([app.view(), sound.playing()]).toEqual(['home', null]);
    });
  });

  describe('listening', () => {
    beforeEach(async () => {
      engine.tries['How are you?'] = [attempt('t1', 'How are you?', 70, ['good', 'wrong', 'good'])];
      await app.open(ID, 1);
      await settle();
    });

    it('reads the part at the chosen speed and lights up the word being spoken', async () => {
      app.setRate(0.75);
      const done = app.playReference();
      expect(sound.log).toEqual(['speak "How are you?" at 0.75']);
      sound.onWord?.(4);
      expect(app.nowRef()).toBe(1);
      sound.end();
      await done;
      expect(app.nowRef()).toBeNull();
      expect(localStorage.getItem('parrot.rate')).toBe('0.75');
    });

    it('plays my take and lights up the word heard at each moment', async () => {
      const done = app.playMine();
      expect(sound.log).toEqual([`play audio:texts/${ID}/t1.wav`]);
      sound.onTime?.(1.1);
      expect(app.nowMine()).toBe(2);
      sound.end();
      await done;
      expect(app.nowMine()).toBeNull();
    });

    it('pauses what is playing, or starts it', () => {
      app.toggleReference();
      app.toggleReference();
      app.toggleMine();
      app.toggleMine();
      expect(sound.log).toEqual(['speak "How are you?" at 1', 'toggle pause', `play audio:texts/${ID}/t1.wav`, 'toggle pause']);
    });

    it('compares: my take, a short gap, then the reference', async () => {
      vi.useFakeTimers();
      const done = app.compare();
      sound.end();
      await vi.advanceTimersByTimeAsync(399);
      expect(sound.log.length).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(sound.log).toEqual([`play audio:texts/${ID}/t1.wav`, 'speak "How are you?" at 1']);
    });

    it('stopping a comparison stops all of it', async () => {
      vi.useFakeTimers();
      const done = app.compare();
      app.stop();
      await vi.advanceTimersByTimeAsync(1000);
      await done;
      expect(sound.log).toEqual([`play audio:texts/${ID}/t1.wav`]);
      expect([app.nowMine(), app.nowRef()]).toEqual([null, null]);
    });

    it('listening during a comparison reads the reference once, ending the comparison', async () => {
      vi.useFakeTimers();
      const done = app.compare();
      app.toggleReference();
      await vi.advanceTimersByTimeAsync(1000);
      await done;
      expect(sound.log).toEqual([`play audio:texts/${ID}/t1.wav`, 'speak "How are you?" at 1']);
    });

    it('a comparison paused on my take still reads the reference once it is resumed and over', async () => {
      vi.useFakeTimers();
      const done = app.compare();
      app.toggleMine();
      app.toggleMine();
      sound.end();
      await vi.advanceTimersByTimeAsync(400);
      await done;
      expect(sound.log).toEqual([`play audio:texts/${ID}/t1.wav`, 'toggle pause', 'toggle pause', 'speak "How are you?" at 1']);
    });

    it('playing my take during a word comparison ends the comparison', async () => {
      vi.useFakeTimers();
      const done = app.compareWord(1);
      await vi.advanceTimersByTimeAsync(0);
      app.toggleMine();
      await vi.advanceTimersByTimeAsync(1000);
      await done;
      expect(sound.log).toEqual([`clip audio:texts/${ID}/t1.wav#0.47-0.94`, `play audio:texts/${ID}/t1.wav`]);
    });

    it('a word cut short by the next leaves the highlight on the next', async () => {
      app.playMyWord(1);
      await settle();
      app.playMyWord(2);
      await settle();
      expect([sound.log.length, app.nowMine()]).toEqual([2, 2]);
    });

    it('says a word alone, slower on request, without its punctuation', () => {
      app.sayWord(2);
      app.sayWord(2, true);
      expect(sound.log).toEqual(['speak "you" at 0.85', 'speak "you" at 0.55']);
    });

    it('plays a word cut from my take, then the reference word', async () => {
      vi.useFakeTimers();
      const done = app.compareWord(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(sound.log).toEqual([`clip audio:texts/${ID}/t1.wav#0.47-0.94`]);
      expect(app.nowMine()).toBe(1);
      sound.end();
      await vi.advanceTimersByTimeAsync(350);
      await done;
      expect(sound.log.at(-1)).toBe('speak "are" at 0.85');
      expect(app.nowMine()).toBeNull();
    });

    it('stopping a word comparison stops all of it', async () => {
      vi.useFakeTimers();
      const done = app.compareWord(1);
      await vi.advanceTimersByTimeAsync(0);
      app.stop();
      await vi.advanceTimersByTimeAsync(1000);
      await done;
      expect(sound.log).toEqual([`clip audio:texts/${ID}/t1.wav#0.47-0.94`]);
    });

    it('selects a word', () => {
      app.selectWord(2);
      expect(app.selected()).toBe(2);
    });
  });

  describe('recording', () => {
    beforeEach(async () => {
      await app.open(ID, 1);
      await settle();
    });

    it('records a take, scores it and shows it with the first word to work on', async () => {
      app.playReference();
      await app.toggleRecord();
      expect([recorder.recording(), sound.playing()]).toEqual([true, null]);
      engine.nextCheck = attempt('t9', 'How are you?', 67, ['good', 'unclear', 'good']);
      await app.toggleRecord();
      await settle();
      expect([recorder.recording(), app.checking(), app.error()]).toEqual([false, false, null]);
      expect([app.result()?.id, app.selected(), app.history().map((summary) => summary.id)]).toEqual(['t9', 1, ['t9']]);
      expect(Object.values(app.progress())).toEqual([3, 1, 67]);
      expect(engine.calls.filter((call) => call === 'texts').length).toBe(2);
    });

    it('keeps the best score and counts the tries', async () => {
      engine.nextCheck = attempt('t1', 'How are you?', 80);
      await app.toggleRecord();
      await app.toggleRecord();
      engine.nextCheck = attempt('t2', 'How are you?', 50);
      await app.toggleRecord();
      await app.toggleRecord();
      const key = app.part()!.key;
      expect(app.scores()[key]).toEqual({ last: 50, best: 80, tries: 2 });
    });

    it('reports a take that could not be scored', async () => {
      await app.toggleRecord();
      await app.toggleRecord();
      expect([app.error(), app.checking(), app.result()]).toEqual([
        'Nothing was heard in the recording. Is the microphone on?',
        false,
        null,
      ]);
    });

    it("leaves a failed take's error on its part", async () => {
      await app.toggleRecord();
      await app.toggleRecord();
      app.next();
      await settle();
      expect([app.index(), app.error()]).toEqual([2, null]);
    });

    it('asks for the microphone when it is not allowed', async () => {
      recorder.micAllowed = false;
      await app.toggleRecord();
      expect(app.error()).toBe('No microphone: Permission denied. Allow Parrot to use the microphone.');
    });

    it('scores a take against the part it was started on: moving on is refused meanwhile', async () => {
      engine.nextCheck = attempt('t1', 'How are you?', 80);
      await app.toggleRecord();
      app.next();
      await settle();
      await app.setMode('whole');
      expect([app.index(), app.text()?.mode, recorder.recording()]).toEqual([1, 'sentences', true]);
      await app.toggleRecord();
      await settle();
      expect(engine.calls).toContain('check How are you?');
      expect([app.index(), app.result()?.id]).toEqual([1, 't1']);
    });

    it('drops a take, unscored, on going home or opening a text', async () => {
      await app.toggleRecord();
      app.home();
      await settle();
      expect([app.view(), recorder.recording(), recorder.owner()]).toEqual(['home', false, null]);
      await app.open(ID, 2);
      await app.toggleRecord();
      await app.open(ID, 0);
      expect([app.index(), recorder.recording(), engine.calls.some((call) => call.startsWith('check'))]).toEqual([0, false, false]);
    });

    it("doesn't show a take's score on a part left while it was scored", async () => {
      engine.nextCheck = attempt('t1', 'How are you?', 80);
      await app.toggleRecord();
      const scoring = app.toggleRecord();
      void app.select(2);
      await scoring;
      await settle();
      expect([app.index(), app.result()]).toEqual([2, null]);
    });
  });
  describe('deleting a try', () => {
    const PART = 'How are you?';

    beforeEach(async () => {
      engine.tries[PART] = [attempt('t1', PART, 60), attempt('t2', PART, 90), attempt('t3', PART, 40)];
      await app.open(ID, 1);
      await settle();
    });

    it('deletes the try shown, counts the scores again and shows the newest one left', async () => {
      const key = app.part()!.key;
      expect([app.result()?.id, app.scores()[key]]).toEqual(['t3', { last: 40, best: 90, tries: 3 }]);
      const texts = engine.calls.filter((call) => call === 'texts').length;
      await app.deleteAttempt('t3');
      await settle();
      expect(engine.calls).toContain('deleteAttempt t3');
      expect([app.result()?.id, app.history().map((summary) => summary.id)]).toEqual(['t2', ['t2', 't1']]);
      expect(app.scores()[key]).toEqual({ last: 90, best: 90, tries: 2 });
      expect(app.progress()).toEqual({ total: 3, done: 1, avg: 90 });
      expect(engine.calls.filter((call) => call === 'texts').length).toBe(texts + 1);
    });

    it('keeps the try shown when another one is deleted', async () => {
      await app.showAttempt('t1');
      await app.deleteAttempt('t2');
      await settle();
      expect([app.result()?.id, app.history().map((summary) => summary.id)]).toEqual(['t1', ['t3', 't1']]);
      expect(app.scores()[app.part()!.key]).toEqual({ last: 40, best: 60, tries: 2 });
    });

    it('leaves the part unpractised once its last try is deleted', async () => {
      for (const id of ['t3', 't2', 't1']) await app.deleteAttempt(id);
      expect([app.result(), app.history(), app.scores()[app.part()!.key]]).toEqual([null, [], undefined]);
      expect(app.progress().done).toBe(0);
    });

    it("says why a try couldn't be deleted, and keeps it", async () => {
      engine.refuseDelete = 'not found: t3';
      await expect(app.deleteAttempt('t3')).rejects.toThrow('not found: t3');
      expect([app.result()?.id, app.history().length]).toEqual(['t3', 3]);
    });

    it('waits for a take under way', async () => {
      await app.toggleRecord();
      await app.deleteAttempt('t3');
      expect(engine.calls.some((call) => call.startsWith('deleteAttempt'))).toBe(false);
    });

    it('asks first in the tries chart, and keeps the try on Keep', async () => {
      const chart = TestBed.createComponent(TriesChart);
      await chart.whenStable();
      const element: HTMLElement = chart.nativeElement;
      const button = (name: string) =>
        [...element.querySelectorAll('button')].find(
          (each) => each.textContent?.trim() === name || each.getAttribute('aria-label') === name,
        )!;
      button('Delete the try shown').click();
      await chart.whenStable();
      expect(element.querySelector('.ask')?.textContent).toBe('Delete this try and its recording?');
      expect(engine.calls.some((call) => call.startsWith('deleteAttempt'))).toBe(false);
      button('Keep').click();
      await chart.whenStable();
      expect(element.querySelector('.ask')).toBeNull();
      button('Delete the try shown').click();
      await chart.whenStable();
      button('Delete').click();
      await chart.whenStable();
      await settle();
      await chart.whenStable();
      expect(engine.calls).toContain('deleteAttempt t3');
      expect(element.querySelector('.ask')).toBeNull();
      expect([...element.querySelectorAll('.bars b')].map((score) => score.textContent)).toEqual(['60', '90']);
    });

    it('shows in the tries chart why a try could not be deleted', async () => {
      engine.refuseDelete = 'Permission denied';
      const chart = TestBed.createComponent(TriesChart);
      await chart.whenStable();
      const element: HTMLElement = chart.nativeElement;
      element.querySelector<HTMLButtonElement>('[aria-label="Delete the try shown"]')!.click();
      await chart.whenStable();
      element.querySelector<HTMLButtonElement>('.btn.danger')!.click();
      await settle();
      await chart.whenStable();
      expect(element.querySelector('.error')?.textContent).toBe('Permission denied');
    });
  });

  describe('practising a word alone', () => {
    let words: WordPractice;
    /** select a word and let its tries load */
    const choose = async (wordIndex: number | null) => {
      app.selectWord(wordIndex);
      TestBed.tick();
      await settle();
    };

    beforeEach(async () => {
      engine.tries['How are you?'] = [attempt('t1', 'How are you?', 70, ['good', 'wrong', 'good'])];
      await app.open(ID, 1);
      await settle();
      words = TestBed.inject(WordPractice);
    });

    it('loads the tries of the word selected, newest first, and the newest in full', async () => {
      engine.wordTries['you'] = [attempt('w1', 'you', 60), attempt('w2', 'you', 85)];
      await choose(2);
      expect([words.tries().map((summary) => summary.id), words.latest()?.id, words.error()]).toEqual([['w2', 'w1'], 'w2', null]);
      expect(engine.calls).toContain('wordAttempts you?');
      app.playWordTry(words.latest()!);
      expect(sound.log).toEqual([`clip audio:texts/${ID}/w2.wav`]);
      expect(app.nowMine()).toBeNull();
      await choose(0);
      expect([words.tries(), words.latest()]).toEqual([[], null]);
      await choose(null);
      expect(engine.calls.filter((call) => call.startsWith('wordAttempts'))).toEqual(['wordAttempts you?', 'wordAttempts How']);
    });

    it("records a word try and scores it, leaving the part's take and scores as they were", async () => {
      await choose(1);
      const scores = app.scores();
      const progress = app.progress();
      const texts = engine.calls.filter((call) => call === 'texts').length;
      await words.toggleRecord();
      expect([recorder.owner(), words.recording(), app.recording()]).toEqual(['word', true, false]);
      engine.nextWordCheck = attempt('w9', 'are', 72, ['wrong']);
      await words.toggleRecord();
      await settle();
      expect([recorder.recording(), words.checking(), words.error()]).toEqual([false, false, null]);
      expect([words.latest()?.id, words.tries().map((summary) => summary.id)]).toEqual(['w9', ['w9']]);
      expect(engine.calls).toContain('checkWord are');
      expect([app.result()?.id, app.history().map((summary) => summary.id), app.selected()]).toEqual(['t1', ['t1'], 1]);
      expect([app.scores(), app.progress()]).toEqual([scores, progress]);
      expect(engine.calls.filter((call) => call === 'texts').length).toBe(texts);
    });

    it('reports a word try that could not be scored', async () => {
      await choose(1);
      await words.toggleRecord();
      await words.toggleRecord();
      expect([words.error(), words.checking(), words.latest()]).toEqual([
        'Nothing was heard in the recording. Is the microphone on?',
        false,
        null,
      ]);
    });

    it("doesn't finish a word take as a take of the part", async () => {
      await choose(1);
      await words.toggleRecord();
      await app.toggleRecord();
      expect([recorder.recording(), recorder.owner()]).toEqual([true, 'word']);
      expect(engine.calls.some((call) => call.startsWith('check '))).toBe(false);
      engine.nextWordCheck = attempt('w1', 'are', 90);
      await words.toggleRecord();
      expect(engine.calls.filter((call) => call.startsWith('check'))).toEqual(['checkWord are']);
    });

    it("doesn't finish a take of the part as a word take", async () => {
      await choose(1);
      await app.toggleRecord();
      await words.toggleRecord();
      expect([recorder.recording(), recorder.owner(), words.recording()]).toEqual([true, 'part', false]);
      engine.nextCheck = attempt('t2', 'How are you?', 100);
      await app.toggleRecord();
      await settle();
      expect(engine.calls.filter((call) => call.startsWith('check'))).toEqual(['check How are you?']);
      expect([app.result()?.id, words.latest()]).toEqual(['t2', null]);
    });

    it('deletes a word try and shows the ones left, leaving the part as it was', async () => {
      engine.wordTries['you'] = [attempt('w1', 'you', 60), attempt('w2', 'you', 85)];
      await choose(2);
      const scores = app.scores();
      await words.deleteTry('w2');
      expect(engine.calls).toContain('deleteWordAttempt w2');
      expect([words.tries().map((summary) => summary.id), words.latest()?.id, words.error()]).toEqual([['w1'], 'w1', null]);
      expect([app.result()?.id, app.scores()]).toEqual(['t1', scores]);
      await words.deleteTry('w1');
      expect([words.tries(), words.latest()]).toEqual([[], null]);
    });

    it("says why a word try couldn't be deleted", async () => {
      engine.wordTries['you'] = [attempt('w1', 'you', 60)];
      await choose(2);
      engine.refuseDelete = 'not found: w1';
      await words.deleteTry('w1');
      expect([words.error(), words.latest()?.id]).toEqual(['not found: w1', 'w1']);
    });

    it('drops a word take when another word is chosen', async () => {
      await choose(1);
      await words.toggleRecord();
      await choose(2);
      expect([recorder.recording(), recorder.owner()]).toEqual([false, null]);
      expect(engine.calls.some((call) => call.startsWith('checkWord'))).toBe(false);
    });
  });
});
