import { Activity, Attempt, AttemptSummary, KeptTalk, LeftTalk, Mode, PartScore, SoundsLike, Talk, TalkProgress, TextItem } from './models';

/** True inside the desktop app: the engine is built in. In a plain browser (development, screenshots) the
 * interface runs on a demo engine kept in memory instead. */
export const IN_APP = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export class EngineError extends Error {}

/** What the engine says when writing down a talk was cancelled (src-tauri/src/talk.rs). */
export const TALK_CANCELLED = 'the writing-down was cancelled';

export interface EngineInfo {
  data: string;
  /** whether each speech model is downloaded */
  models: Record<'whisper' | 'aligner', boolean>;
  sizes: Record<'whisper' | 'aligner', number>;
}

export interface ModelProgress {
  model: 'whisper' | 'aligner';
  received: number;
  total: number;
}

/** What the interface asks of the speech engine. The app provides the one it runs on (app.config.ts):
 * TauriEngine inside the desktop app, DemoEngine in a plain browser. */
export abstract class Engine {
  /** Where the data is kept and whether the speech models are ready. */
  abstract info(): Promise<EngineInfo>;

  /** Download the missing speech models, reporting progress. */
  abstract downloadModels(onProgress: (progress: ModelProgress) => void): Promise<void>;

  abstract texts(): Promise<TextItem[]>;

  abstract addText(text: string, title: string, mode: Mode): Promise<TextItem>;

  abstract updateText(id: string, change: { title?: string; mode?: Mode; opened?: boolean }): Promise<TextItem>;

  abstract deleteText(id: string): Promise<void>;

  abstract scores(textId: string): Promise<Record<string, PartScore>>;

  abstract attempts(textId: string, part: string): Promise<AttemptSummary[]>;

  abstract attempt(textId: string, part: string, id: string): Promise<Attempt>;

  /** Delete one try of a part, its recording too; the part's scores are counted again from the tries left. */
  abstract deleteAttempt(textId: string, part: string, id: string): Promise<void>;

  /** Score a take (a WAV recording) of one part of a text. */
  abstract check(textId: string, part: string, audio: Blob): Promise<Attempt>;

  /** Score a take of one word of a text said alone. Word tries are kept apart: they never count toward the part's
   * or the text's scores. Their score is the word's sound match; its verdict says whether speech recognition heard it. */
  abstract checkWord(textId: string, word: string, audio: Blob): Promise<Attempt>;

  /** The tries of one word said alone, newest first (every place the word is in the text shares them). */
  abstract wordAttempts(textId: string, word: string): Promise<AttemptSummary[]>;

  abstract wordAttempt(textId: string, word: string, id: string): Promise<Attempt>;

  abstract deleteWordAttempt(textId: string, word: string, id: string): Promise<void>;

  /** Start a talk recorded at `rate` (Hz): speech with no text in front of it. One at a time; a talk not kept is dropped. */
  abstract talkStart(rate: number): Promise<void>;

  /** More of the talk under way, as recorded. It is at most 10 minutes. */
  abstract talkFeed(samples: Int16Array): Promise<void>;

  /** Stop the talk and write down what was said, reporting progress; rejects with TALK_CANCELLED when cancelled. */
  abstract talkStop(onProgress: (progress: TalkProgress) => void): Promise<Talk>;

  /** Stop writing down the talk; its recording is kept, to write down again or discard. */
  abstract talkCancel(): Promise<void>;

  /** Keep the talk as a text: `text` is what was said, as the user corrected it; the recording is its first take. */
  abstract talkKeep(text: string, title: string): Promise<KeptTalk>;

  /** Drop the talk and its recording. */
  abstract talkDiscard(): Promise<void>;

  /** The talk left from the last time Parrot ran, if any (its writing-down follows with talkStop, or talkDiscard). */
  abstract talkLeft(): Promise<LeftTalk | null>;

  abstract activity(): Promise<Activity>;

  /** How much the deleted texts in the trash take, in bytes. They are erased for good 30 days after. */
  abstract trashSize(): Promise<number>;

  /** Erase the deleted texts now; what is left in the trash, in bytes. */
  abstract emptyTrash(): Promise<number>;

  /** Show the data folder in the computer's file manager. */
  abstract openDataFolder(): Promise<void>;

  /** The words never counted as misheard, in every text (lower case, see nameKey). */
  abstract names(): Promise<string[]>;

  /** Mark a word as a name, or not, from the next take on; the names after. */
  abstract setName(word: string, name: boolean): Promise<string[]>;

  abstract soundsLike(word: string): Promise<SoundsLike>;

  /** URL of a saved recording (paths from the first engine start with /files/). */
  abstract audioUrl(path: string): string;

  /** A saved recording's path inside the data folder. */
  protected relative(path: string) {
    return path.replace(/^\/?files\//, '').replace(/^\//, '');
  }
}
