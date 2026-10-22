import { Injectable } from '@angular/core';
import { convertFileSrc, invoke, InvokeArgs, InvokeOptions } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Engine, EngineError, EngineInfo, ModelProgress } from './engine';
import { Activity, Attempt, AttemptSummary, KeptTalk, LeftTalk, Mode, PartScore, SoundsLike, Talk, TalkProgress, TextItem } from './models';

/** The engine built into the desktop app (src-tauri), called through Tauri commands. */
@Injectable()
export class TauriEngine extends Engine {
  private dataDir = '';

  private async call<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
    try {
      return await invoke<T>(cmd, args, options);
    } catch (error) {
      throw new EngineError(typeof error === 'string' ? error : String(error));
    }
  }

  async info() {
    const info = await this.call<EngineInfo>('info');
    this.dataDir = info.data;
    return info;
  }

  async downloadModels(onProgress: (progress: ModelProgress) => void) {
    const stop = await listen<ModelProgress>('model-progress', (event) => onProgress(event.payload));
    try {
      await this.call('download_models');
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
    return this.call<Attempt>('check', bytes, { headers: { 'x-text': textId, 'x-part': encodeURIComponent(part) } });
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

  talkStart(rate: number) {
    return this.call<void>('talk_start', { rate });
  }

  /** the samples as the raw body: little-endian, as typed arrays are on every system Parrot runs on */
  talkFeed(samples: Int16Array) {
    return this.call<string[]>('talk_feed', new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
  }

  async talkStop(onProgress: (progress: TalkProgress) => void) {
    const stop = await listen<TalkProgress>('talk-progress', (event) => onProgress(event.payload));
    try {
      return await this.call<Talk>('talk_stop');
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
