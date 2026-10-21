import { Activity, Attempt, AttemptSummary, Mode, PartScore, SoundsLike, TextItem } from './models';

/** True inside the desktop app: the engine is built in. In a plain browser (development, screenshots) the
 * interface runs on a demo engine kept in memory instead. */
export const IN_APP = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export class EngineError extends Error {}

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

  /** Score a take (a WAV recording) of one part of a text. */
  abstract check(textId: string, part: string, audio: Blob): Promise<Attempt>;

  /** Score a take of one word of a text said alone. Word tries are kept apart: they never count toward the part's
   * or the text's scores. Their score is the word's sound match; its verdict says whether speech recognition heard it. */
  abstract checkWord(textId: string, word: string, audio: Blob): Promise<Attempt>;

  /** The tries of one word said alone, newest first (every place the word is in the text shares them). */
  abstract wordAttempts(textId: string, word: string): Promise<AttemptSummary[]>;

  abstract wordAttempt(textId: string, word: string, id: string): Promise<Attempt>;

  abstract activity(): Promise<Activity>;

  abstract soundsLike(word: string): Promise<SoundsLike>;

  /** URL of a saved recording (paths from the first engine start with /files/). */
  abstract audioUrl(path: string): string;

  /** A saved recording's path inside the data folder. */
  protected relative(path: string) {
    return path.replace(/^\/?files\//, '').replace(/^\//, '');
  }
}
