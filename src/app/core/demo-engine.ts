import { Injectable } from '@angular/core';
import { wav } from './clips';
import { Engine, EngineError, EngineInfo, TALK_CANCELLED } from './engine';
import {
  Activity,
  Attempt,
  AttemptSummary,
  KeptTalk,
  Mode,
  PartScore,
  SoundsLike,
  Talk,
  TalkProgress,
  TextItem,
  WordStatus,
} from './models';
import { nameKey } from './names';
import { bare, partKey, sentences } from './split';

/** What the demo engine keeps of a text: what the store keeps in its text.txt and meta.json. */
interface DemoText {
  id: string;
  title: string;
  text: string;
  mode: Mode;
  created: string;
  opened: string | null;
  /** the tries of each part, by its words (oldest first) */
  tries: Map<string, Attempt[]>;
  /** the tries of each word said alone, by the word in lower case without its punctuation (oldest first) */
  wordTries: Map<string, Attempt[]>;
  /** it began as a talk */
  spoken?: boolean;
}

/** What the demo engine "hears" in any talk: one word sounded off, and a long pause after "ago". */
const DEMO_TALK = "Hi, I'm Alex. I moved to Berlin three years ago for a job at a small startup, and I really like it here.";
const DEMO_UNCLEAR = 19; // "really"
const DEMO_PAUSE_AFTER = 9; // "ago"

const DAY = 86_400_000;

/** The scores of the tries of a word said alone, one after another. */
const WORD_TRIES = [64, 81, 92];

/** The words the demo "mishears", and what it hears instead: the site's screenshots show a misheard word. */
const MISHEARD: Record<string, string> = { things: 'sinks' };

/** What the dictionary says of the sample texts' words, so the word card has a spelling and IPA to show. */
const SOUNDS: Record<string, SoundsLike> = {
  beautiful: {
    spell: [
      ['byoo', true],
      ['tuh', false],
      ['fl', false],
    ],
    ipa: '/ˈbju.tə.fəl/',
  },
  berlin: {
    spell: [
      ['br', false],
      ['lin', true],
    ],
    ipa: '/bɚˈlɪn/',
  },
  engineer: {
    spell: [
      ['ehn', true],
      ['juh', false],
      ['nir', true],
    ],
    ipa: '/ˈɛn.dʒəˈnɪɹ/',
  },
  lights: { spell: [['laits', true]], ipa: '/ˈlaɪts/' },
  northern: {
    spell: [
      ['nawr', true],
      ['dhrn', false],
    ],
    ipa: '/ˈnɔɹ.ðɚn/',
  },
  really: {
    spell: [
      ['ri', true],
      ['lee', false],
    ],
    ipa: '/ˈɹɪ.li/',
  },
  software: {
    spell: [
      ['sawf', true],
      ['twehr', false],
    ],
    ipa: '/ˈsɔfˌtwɛɹ/',
  },
  startup: {
    spell: [
      ['staar', true],
      ['tuhp', false],
    ],
    ipa: '/ˈstɑɹˌtʌp/',
  },
  things: { spell: [['thingz', true]], ipa: '/ˈθɪŋz/' },
  three: { spell: [['three', true]], ipa: '/ˈθɹi/' },
};

/** Texts as someone might paste them, with a few tries already made, so every screen has something to show. */
const SAMPLES: { title: string; mode: Mode; text: string; daysAgo: number; tries: [number, number, Record<number, WordStatus>][] }[] = [
  {
    title: 'The northern lights',
    mode: 'whole',
    text: 'The northern lights are one of the most beautiful things you can see in the night sky.',
    daysAgo: 4,
    tries: [
      [0, 82, { 8: 'unclear', 9: 'wrong' }],
      [0, 88, { 9: 'unclear' }],
    ],
  },
  {
    title: 'Introducing yourself',
    mode: 'sentences',
    text:
      "Hi, I'm Alex, and I work as a software engineer in Berlin. I moved here three years ago for a job at a small startup. " +
      'In my free time I like hiking, cooking and reading about history.',
    daysAgo: 3,
    // [sentence, score, the words not heard well]: two tries of the first sentence, one of the second
    tries: [
      [0, 71, { 8: 'unclear', 9: 'wrong' }],
      [0, 88, { 9: 'unclear' }],
      [1, 94, {}],
    ],
  },
  {
    title: 'A weather report',
    mode: 'short',
    text:
      'Tomorrow will start cloudy, with a chance of light rain in the north. ' +
      'By the afternoon, the sun should break through and temperatures will rise to around eighteen degrees.',
    daysAgo: 1,
    tries: [],
  },
];

/**
 * An engine kept in memory, for working on the interface in a plain browser (`ng serve`) and for screenshots: a
 * couple of sample texts and tries, and whatever is added while the page is open. It hears nothing: a take is
 * given a made-up score, every word good but its longest and "things" (heard as "sinks"), and keeps its recording
 * only until the page reloads.
 * Only the desktop app (TauriEngine) really scores speech.
 */
@Injectable()
export class DemoEngine extends Engine {
  private library: DemoText[] = [];
  private readonly ready = this.seed();
  private takes = 0;
  private nameList: string[] = [];
  /** the talk under way: what was fed in, and what was heard once written down */
  private talk: { rate: number; blocks: Int16Array[]; samples: number; written: Talk | null } | null = null;
  private cancelled = false;

  private async seed() {
    for (const sample of SAMPLES) {
      const created = new Date(Date.now() - sample.daysAgo * DAY);
      const text = await this.store(sample.text, sample.title, sample.mode, created);
      // the samples practised were opened a few hours ago, the first most recently
      text.opened = sample.tries.length ? stamp(new Date(Date.now() - DAY / 4 - (SAMPLES.indexOf(sample) * DAY) / 24)).when : null;
      const parts = sentences(text.text);
      sample.tries.forEach(([sentenceIndex, score, verdicts], tryIndex) => {
        const part = parts[sentenceIndex];
        const when = new Date(created.getTime() + (tryIndex + 1) * (DAY * 0.6));
        listOf(text.tries, part).push(judged(part, score, verdicts, '', when));
      });
    }
  }

  private async store(text: string, title: string, mode: Mode, created = new Date()): Promise<DemoText> {
    const body = norm(text);
    if (!body) throw new EngineError('the text is empty');
    // the store's id: the first 10 hex digits of the SHA-1 of the words
    const id = (await partKey(body)).slice(2);
    let kept = this.library.find((each) => each.id === id);
    if (!kept) {
      kept = { id, title: '', text: body, mode, created: stamp(created).when, opened: null, tries: new Map(), wordTries: new Map() };
      this.library.push(kept);
    }
    kept.title = title.trim() || kept.title || body.split(' ').slice(0, 6).join(' ') + '…';
    kept.mode = mode;
    return kept;
  }

  private async find(id: string) {
    await this.ready;
    const text = this.library.find((each) => each.id === id);
    if (!text) throw new EngineError(`not found: ${id}`);
    return text;
  }

  async info(): Promise<EngineInfo> {
    return {
      data: 'nowhere: this is the browser demo, which forgets everything on reload',
      models: { whisper: true, aligner: true },
      sizes: { whisper: 0, aligner: 0 },
    };
  }

  async downloadModels(): Promise<void> {}

  async texts() {
    await this.ready;
    const items = await Promise.all(this.library.map((text) => item(text)));
    return items.sort((left, right) => (right.opened ?? right.created).localeCompare(left.opened ?? left.created));
  }

  async addText(text: string, title: string, mode: Mode) {
    await this.ready;
    return item(await this.store(text, title, mode));
  }

  async updateText(id: string, change: { title?: string; mode?: Mode; opened?: boolean }) {
    const text = await this.find(id);
    if (change.title?.trim()) text.title = change.title.trim();
    if (change.mode) text.mode = change.mode;
    if (change.opened) text.opened = stamp(new Date()).when;
    return item(text);
  }

  async deleteText(id: string) {
    const text = await this.find(id);
    this.library = this.library.filter((each) => each !== text);
  }

  async scores(textId: string) {
    return scores(await this.find(textId));
  }

  async attempts(textId: string, part: string) {
    return summaries((await this.find(textId)).tries.get(norm(part)));
  }

  async attempt(textId: string, part: string, id: string) {
    return pick((await this.find(textId)).tries.get(norm(part)), id);
  }

  async check(textId: string, part: string, audio: Blob) {
    const text = await this.find(textId);
    if (!part.trim() || !text.text.includes(norm(part))) throw new EngineError('that part is not in the text; reload');
    const words = norm(part).split(' ');
    const verdicts: Record<number, WordStatus> = {};
    words.forEach((word, wordIndex) => misheard(word) && (verdicts[wordIndex] = 'wrong'));
    const longest = words.reduce(
      (best, word, wordIndex) => (verdicts[wordIndex] || bare(word).length <= bare(words[best] ?? '').length ? best : wordIndex),
      -1,
    );
    if (longest >= 0) verdicts[longest] = 'unclear';
    const score = Math.round(100 - (100 * Object.keys(verdicts).length) / words.length / 2);
    const attempt = judged(part, score, verdicts, URL.createObjectURL(audio), new Date(), this.takes++);
    listOf(text.tries, part).push(attempt);
    return attempt;
  }

  async checkWord(textId: string, word: string, audio: Blob) {
    const text = await this.find(textId);
    const said = bare(word.trim()).toLowerCase();
    if (!said || !text.text.split(' ').some((each) => bare(each).toLowerCase() === said)) {
      throw new EngineError('that word is not in the text; reload');
    }
    // each try of a word alone comes out a little better: its first sound weak at first, then clear
    const tries = listOf(text.wordTries, said);
    const score = WORD_TRIES[Math.min(tries.length, WORD_TRIES.length - 1)];
    const attempt = judged(
      bare(word.trim()),
      score,
      tries.length ? {} : { 0: 'unclear' },
      URL.createObjectURL(audio),
      new Date(),
      this.takes++,
    );
    attempt.words[0].score = score / 100;
    tries.push(attempt);
    return attempt;
  }

  async wordAttempts(textId: string, word: string) {
    return summaries((await this.find(textId)).wordTries.get(bare(word.trim()).toLowerCase()));
  }

  async wordAttempt(textId: string, word: string, id: string) {
    return pick((await this.find(textId)).wordTries.get(bare(word.trim()).toLowerCase()), id);
  }

  async deleteAttempt(textId: string, part: string, id: string) {
    remove((await this.find(textId)).tries.get(norm(part)), id);
  }

  async deleteWordAttempt(textId: string, word: string, id: string) {
    remove((await this.find(textId)).wordTries.get(bare(word.trim()).toLowerCase()), id);
  }

  // a deleted text is gone at once here: nothing waits in a trash
  async trashSize() {
    return 0;
  }

  async emptyTrash() {
    return 0;
  }

  async openDataFolder(): Promise<never> {
    throw new EngineError('Opening the data folder needs the desktop app');
  }

  async talkStart(rate: number) {
    this.talk = { rate, blocks: [], samples: 0, written: null };
  }

  async talkFeed(samples: Int16Array) {
    const talk = this.talk;
    if (!talk || talk.written) throw new EngineError('no talk is being recorded');
    if (talk.samples + samples.length > 1805 * talk.rate) throw new EngineError('a talk can be at most 30 minutes');
    talk.blocks.push(samples.slice());
    talk.samples += samples.length;
    // what it "hears" while the talk is recorded: the next few words of the talk every few blocks
    if (talk.blocks.length % 3) return [];
    const words = DEMO_TALK.split(' ');
    const heard = words.slice(talk.blocks.length * 2 - 6, talk.blocks.length * 2).join(' ');
    return heard ? [heard] : [];
  }

  /** Writes down the same few sentences whatever was said, a quarter of the talk every quarter second. */
  async talkStop(onProgress: (progress: TalkProgress) => void): Promise<Talk> {
    const talk = this.talk;
    if (!talk) throw new EngineError('there is no talk to write down');
    if (!talk.samples) throw new EngineError('Nothing was heard in the recording. Is the microphone on?');
    this.cancelled = false;
    const total = Math.round((talk.samples / talk.rate) * 100) / 100;
    for (let quarter = 1; quarter <= 4; quarter++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (this.cancelled) throw new EngineError(TALK_CANCELLED);
      onProgress({ done: (total * quarter) / 4, total });
    }
    const attempt = judged(DEMO_TALK, 0, { [DEMO_UNCLEAR]: 'unclear' }, '', new Date());
    for (const word of attempt.words.slice(DEMO_PAUSE_AFTER + 1)) word.t = word.t && [word.t[0] + 1.4, word.t[1] + 1.4];
    const words = attempt.words;
    const duration = words.at(-1)!.t![1] + 0.3;
    talk.written = {
      audio: URL.createObjectURL(wav(joined(talk.blocks, talk.samples), talk.rate)),
      heard: DEMO_TALK,
      words,
      duration,
      wpm: Math.round((words.length / duration) * 60),
      score: Math.round((100 * (words.length - 1)) / words.length),
      pauses: [[DEMO_PAUSE_AFTER, 1.4]],
    };
    return talk.written;
  }

  async talkCancel() {
    this.cancelled = true;
  }

  /** A word that isn't the one heard at its place is misheard, as that word; the recording plays back as made. */
  async talkKeep(said: string, title: string): Promise<KeptTalk> {
    await this.ready;
    const talk = this.talk;
    if (!talk?.written) throw new EngineError('write the talk down first');
    const text = await this.store(said, title, 'whole');
    text.spoken = true;
    const heard = talk.written.heard.split(' ');
    const verdicts: Record<number, WordStatus> = {};
    text.text.split(' ').forEach((word, wordIndex) => {
      const same = bare(word).toLowerCase() === bare(heard[wordIndex] ?? '').toLowerCase();
      if (!same && !this.nameList.includes(nameKey(word))) verdicts[wordIndex] = 'wrong';
      else if (talk.written!.words[wordIndex]?.status === 'unclear') verdicts[wordIndex] = 'unclear';
    });
    const words = text.text.split(' ').length;
    const score = Math.round((100 * (words - Object.keys(verdicts).length)) / words);
    const attempt = judged(text.text, score, verdicts, talk.written.audio, new Date(), ++this.takes);
    attempt.words.forEach((word, wordIndex) => word.status === 'wrong' && (word.heard = bare(heard[wordIndex] ?? '').toLowerCase()));
    attempt.heard = talk.written.heard;
    listOf(text.tries, text.text).push(attempt);
    this.talk = null;
    return { text: await item(text), attempt };
  }

  async talkDiscard() {
    this.cancelled = true;
    this.talk = null;
  }

  // the demo forgets everything on reload: no talk is ever left
  async talkLeft() {
    return null;
  }

  async activity(): Promise<Activity> {
    await this.ready;
    const days = Array.from({ length: 7 }, (_, daysAgo) => ({ date: stamp(new Date(Date.now() - (6 - daysAgo) * DAY)).date, tries: 0 }));
    const scored: number[] = [];
    for (const attempt of this.library.flatMap((text) => [...text.tries.values()].flat())) {
      const day = days.find((each) => attempt.when.startsWith(each.date));
      if (!day) continue;
      day.tries++;
      scored.push(attempt.score);
    }
    return { days, tries: scored.length, average: mean(scored) };
  }

  async names() {
    return [...this.nameList];
  }

  async setName(word: string, name: boolean) {
    const key = nameKey(word);
    if (!key || /\s/.test(key)) throw new EngineError(`“${word}” can't be a name`);
    this.nameList = this.nameList.filter((kept) => kept !== key);
    if (name) this.nameList = [...this.nameList, key].sort();
    return [...this.nameList];
  }

  async soundsLike(word: string): Promise<SoundsLike> {
    const key = bare(word).toLowerCase();
    return Object.hasOwn(SOUNDS, key) ? SOUNDS[key] : {};
  }

  /** The words change; a part whose words changed takes the tries of the part at the same place before it, scored
   * as the demo scores anything. */
  async editText(id: string, text: string, onProgress: (progress: TalkProgress) => void) {
    const kept = await this.find(id);
    const body = norm(text);
    if (!body) throw new EngineError('the text is empty');
    const before = sentences(kept.text);
    const after = sentences(body);
    const moved = new Map<string, Attempt[]>();
    for (const [part, tries] of kept.tries) {
      const now = body.includes(part) ? part : after[before.indexOf(part)];
      if (now)
        moved.set(now, [
          ...(moved.get(now) ?? []),
          ...tries.map((each) => ({ ...judged(now, each.score, {}, each.audio, new Date(each.when)), id: each.id })),
        ]);
    }
    kept.text = body;
    kept.tries = moved;
    onProgress({ done: 1, total: 1 });
    return item(kept);
  }

  // the recordings are object URLs in the page: the interface decodes them itself
  async peaks() {
    return null;
  }

  async clip() {
    return null;
  }

  /** The tries made here keep their recording as an object URL; the sample tries have none (""), so their
   * waveform stays empty and playing them plays nothing. */
  audioUrl(path: string) {
    return path;
  }
}

/** The blocks of a talk as one recording. */
function joined(blocks: Int16Array[], samples: number) {
  const pcm = new Int16Array(samples);
  let at = 0;
  for (const block of blocks) {
    pcm.set(block, at);
    at += block.length;
  }
  return pcm;
}

function norm(text: string) {
  return text.split(/\s+/).filter(Boolean).join(' ');
}

function listOf(tries: Map<string, Attempt[]>, key: string) {
  const list = tries.get(norm(key)) ?? [];
  tries.set(norm(key), list);
  return list;
}

/** A local time as the store writes it: the date, the time, and a try's id (20261020-153000). */
function stamp(time: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
  const clock = `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
  return { date, when: `${date}T${clock}`, id: `${date.replace(/-/g, '')}-${clock.replace(/:/g, '')}` };
}

function mean(values: number[]) {
  return values.length ? Math.round(values.reduce((total, value) => total + value, 0) / values.length) : null;
}

/** A try of `part`: every word heard and placed, but those in `verdicts` sounded off (unclear) or not heard (wrong). */
function judged(part: string, score: number, verdicts: Record<number, WordStatus>, audio: string, time: Date, take = 0): Attempt {
  const words = norm(part).split(' ');
  const duration = Math.round((0.4 + words.length * 0.38) * 100) / 100;
  const { id, when } = stamp(time);
  return {
    id: take ? `${id}-${take}` : id,
    when,
    text: norm(part),
    heard: words
      .map((word, wordIndex) => (verdicts[wordIndex] === 'wrong' ? (misheard(word) ?? '') : word))
      .filter(Boolean)
      .join(' '),
    words: words.map((word, wordIndex) => {
      const status = verdicts[wordIndex] ?? 'good';
      const start = 0.2 + wordIndex * 0.38;
      const heardAs = status === 'wrong' ? misheard(word) : undefined;
      return {
        w: word,
        t: status === 'wrong' && !heardAs ? null : [start, start + 0.32],
        score: status === 'good' ? 0.86 + (wordIndex % 3) * 0.05 : status === 'unclear' ? 0.58 : heardAs ? 0.31 : null,
        ref: null,
        status,
        heard: status === 'wrong' ? (heardAs ?? '') : null,
        extra: '',
        letters: status === 'wrong' && !heardAs ? undefined : letters(word, status),
      };
    }),
    duration,
    wpm: Math.round((words.length / duration) * 60),
    score,
    audio,
  };
}

/** What the demo hears instead of `word`, if it mishears it. */
function misheard(word: string): string | undefined {
  const key = bare(word).toLowerCase();
  return Object.hasOwn(MISHEARD, key) ? MISHEARD[key] : undefined;
}

/**
 * How surely each letter of a word was heard: a good word's all sure; one that sounded off, its first sound weak and
 * its second only fair; a misheard one, its first sound wrong and the rest fair.
 */
function letters(word: string, status: WordStatus) {
  const first = /^(th|sh|ch|ng|ph|wh)/i.test(word) ? 2 : 1;
  return [...word].map((_, charIndex) => {
    if (status === 'good') return 0.9;
    if (charIndex < first) return status === 'wrong' ? 0.2 : 0.35;
    return status === 'wrong' || charIndex === first ? 0.62 : 0.88;
  });
}

async function scores(text: DemoText) {
  const out: Record<string, PartScore> = {};
  for (const [part, tries] of text.tries) {
    if (!tries.length) continue;
    out[await partKey(part)] = { last: tries.at(-1)!.score, best: Math.max(...tries.map((each) => each.score)), tries: tries.length };
  }
  return out;
}

async function item(text: DemoText): Promise<TextItem> {
  const partScores = await scores(text);
  const last = Object.values(partScores).map((part) => part.last);
  const { id, title, created, opened, mode, spoken = false } = text;
  const words = text.text.split(' ').length;
  return {
    id,
    title,
    text: text.text,
    words,
    created,
    opened,
    mode,
    practised: last.length,
    average: mean(last),
    scores: partScores,
    spoken,
  };
}

function summaries(tries: Attempt[] = []): AttemptSummary[] {
  return [...tries].reverse().map(({ id, when, score, wpm, duration }) => ({ id, when, score, wpm, duration }));
}

function pick(tries: Attempt[] = [], id: string) {
  const attempt = tries.find((each) => each.id === id);
  if (!attempt) throw new EngineError(`no such try: ${id}`);
  return attempt;
}

/** Take a try out of a part's or a word's tries. */
function remove(tries: Attempt[] | undefined, id: string) {
  const index = tries?.findIndex((attempt) => attempt.id === id) ?? -1;
  if (index < 0) throw new EngineError(`not found: ${id}`);
  tries!.splice(index, 1);
}
