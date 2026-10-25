import { Injectable } from '@angular/core';
import { convertFileSrc, invoke, InvokeArgs, InvokeOptions } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Engine, EngineError, EngineInfo, ModelProgress } from './engine';
import { Activity, Attempt, AttemptSummary, KeptTalk, LeftTalk, Mode, PartScore, SoundsLike, Talk, TalkProgress, TextItem } from './models';

/** How long the window waits for a command (ms). Generous, so that only a command that will never answer (a deadlock,
 * a hung model load, a disk that blocks) reaches it; until then such a command left its control disabled for the
 * session, as nothing else could end the wait. */
export const LIMIT_MS = 30_000;
/** a take's check: this, and three times the take's length on top (a long take takes long to write down and align) */
export const CHECK_LIMIT_MS = 60_000;
/** a command that reports progress (a download, a talk written down): this long between two reports */
export const PROGRESS_LIMIT_MS = 120_000;
/** a text's words changed: its tries are scored again one by one, and a try can be a long take */
export const EDIT_LIMIT_MS = 300_000;
/** what the window says when it stops waiting */
export const NO_ANSWER = "The speech engine hasn't answered. Try again, or restart Parrot.";

/** How long the window waits for a command: `ms` from `wait()`, and `ms` again from each `more()` (a report of
 * progress). `wait` gives the command's answer, or NO_ANSWER once the time is up; an answer that comes after is
 * dropped. */
export class Patience {
  private timer = 0;
  private giveUp!: (why: EngineError) => void;
  private readonly gaveUp = new Promise<never>((_, reject) => (this.giveUp = reject));

  constructor(private readonly ms: number) {
    this.gaveUp.catch(() => {});
  }

  more() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.giveUp(new EngineError(NO_ANSWER)), this.ms);
  }

  wait<T>(work: Promise<T>): Promise<T> {
    this.more();
    return Promise.race([work, this.gaveUp]).finally(() => clearTimeout(this.timer));
  }
}

/** How long a WAV recording is (seconds), from its header; 0 when it is not one. */
export function wavSeconds(bytes: Uint8Array) {
  if (bytes.byteLength < 44) return 0;
  const header = new DataView(bytes.buffer, bytes.byteOffset, 44);
  const perSecond = header.getUint32(24, true) * header.getUint16(22, true) * (header.getUint16(34, true) / 8);
  return perSecond ? (bytes.byteLength - 44) / perSecond : 0;
}

/** The engine built into the desktop app (src-tauri), called through Tauri commands. */
@Injectable()
export class TauriEngine extends Engine {
  private dataDir = '';

  /** `patience` is how long to wait for the answer; null waits for ever (the talk's sound, see talkFeed). */
  private async call<T>(
    cmd: string,
    args?: InvokeArgs,
    options?: InvokeOptions,
    patience: Patience | null = new Patience(LIMIT_MS),
  ): Promise<T> {
    try {
      const work = invoke<T>(cmd, args, options);
      return await (patience ? patience.wait(work) : work);
    } catch (error) {
      throw error instanceof EngineError ? error : new EngineError(typeof error === 'string' ? error : String(error));
    }
  }

  async info() {
    const info = await this.call<EngineInfo>('info');
    this.dataDir = info.data;
    return info;
  }

  async downloadModels(onProgress: (progress: ModelProgress) => void) {
    const patience = new Patience(PROGRESS_LIMIT_MS);
    const stop = await listen<ModelProgress>('model-progress', (event) => {
      patience.more();
      onProgress(event.payload);
    });
    try {
      await this.call('download_models', undefined, undefined, patience);
    } finally {
      stop();
    }
  }

  texts() {
    return this.call<TextItem[]>('texts');
  }

  addText(text: string, title: string, mode: Mode) {
    return this.call<TextItem>('add_text', { text, title, mode });
  }

  updateText(id: string, change: { title?: string; mode?: Mode; opened?: boolean }) {
    return this.call<TextItem>('update_text', { id, ...change });
  }

  deleteText(id: string) {
    return this.call<void>('delete_text', { id });
  }

  scores(textId: string) {
    return this.call<Record<string, PartScore>>('scores', { text: textId });
  }

  attempts(textId: string, part: string) {
    return this.call<AttemptSummary[]>('attempts', { text: textId, part });
  }

  attempt(textId: string, part: string, id: string) {
    return this.call<Attempt>('attempt', { text: textId, part, id });
  }

  deleteAttempt(textId: string, part: string, id: string) {
    return this.call<void>('delete_attempt', { text: textId, part, id });
  }

  async check(textId: string, part: string, audio: Blob) {
    const bytes = new Uint8Array(await audio.arrayBuffer());
    const patience = new Patience(CHECK_LIMIT_MS + 3 * wavSeconds(bytes) * 1000);
    return this.call<Attempt>('check', bytes, { headers: { 'x-text': textId, 'x-part': encodeURIComponent(part) } }, patience);
  }

  async checkWord(textId: string, word: string, audio: Blob) {
    const bytes = new Uint8Array(await audio.arrayBuffer());
    return this.call<Attempt>('check_word', bytes, { headers: { 'x-text': textId, 'x-word': encodeURIComponent(word) } });
  }

  wordAttempts(textId: string, word: string) {
    return this.call<AttemptSummary[]>('word_attempts', { text: textId, word });
  }

  wordAttempt(textId: string, word: string, id: string) {
    return this.call<Attempt>('word_attempt', { text: textId, word, id });
  }

  deleteWordAttempt(textId: string, word: string, id: string) {
    return this.call<void>('delete_word_attempt', { text: textId, word, id });
  }

  activity() {
    return this.call<Activity>('activity');
  }

  /** The talk's sound is not waited for with a limit: the engine takes a block only once it has written down the
   * stretch before, which can take a while, and the talk flow gives up on it in its own way when the talk stops. */
  talkStart(rate: number) {
    return this.call<void>('talk_start', { rate }, undefined, null);
  }

  /** the samples as the raw body: little-endian, as typed arrays are on every system Parrot runs on */
  talkFeed(samples: Int16Array) {
    return this.call<string[]>('talk_feed', new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), undefined, null);
  }

  async talkStop(onProgress: (progress: TalkProgress) => void) {
    const patience = new Patience(PROGRESS_LIMIT_MS);
    const stop = await listen<TalkProgress>('talk-progress', (event) => {
      patience.more();
      onProgress(event.payload);
    });
    try {
      return await this.call<Talk>('talk_stop', undefined, undefined, patience);
    } finally {
      stop();
    }
  }

  async editText(id: string, text: string, onProgress: (progress: TalkProgress) => void) {
    const patience = new Patience(EDIT_LIMIT_MS);
    const stop = await listen<TalkProgress>('edit-progress', (event) => {
      patience.more();
      onProgress(event.payload);
    });
    try {
      return await this.call<TextItem>('edit_text', { id, text }, undefined, patience);
    } finally {
      stop();
    }
  }

  talkCancel() {
    return this.call<void>('talk_cancel');
  }

  talkKeep(text: string, title: string) {
    return this.call<KeptTalk>('talk_keep', { text, title: title.trim() || null });
  }

  talkDiscard() {
    return this.call<void>('talk_discard');
  }

  talkLeft() {
    return this.call<LeftTalk | null>('talk_left');
  }

  trashSize() {
    return this.call<number>('trash_size');
  }

  emptyTrash() {
    return this.call<number>('empty_trash');
  }

  openDataFolder() {
    return this.call<void>('open_data_folder');
  }

  names() {
    return this.call<string[]>('names');
  }

  setName(word: string, name: boolean) {
    return this.call<string[]>('set_name', { word, name });
  }

  soundsLike(word: string) {
    return this.call<SoundsLike>('pron', { w: word });
  }

  // a long talk would weigh hundreds of MB decoded in the window: the engine reads only what is needed
  peaks(audio: string, slices: number) {
    return this.call<number[]>('peaks', { audio, slices });
  }

  async clip(audio: string, from: number, to: number) {
    const bytes = await this.call<ArrayBuffer>('clip', { audio, from, to });
    return { rate: new DataView(bytes).getUint32(0, true), samples: new Int16Array(bytes, 4) };
  }

  audioUrl(path: string) {
    return convertFileSrc(`${this.dataDir}/${this.relative(path)}`);
  }
}
