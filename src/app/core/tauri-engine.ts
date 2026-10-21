import { Injectable } from '@angular/core';
import { convertFileSrc, invoke, InvokeArgs, InvokeOptions } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Engine, EngineError, EngineInfo, ModelProgress } from './engine';
import { Activity, Attempt, AttemptSummary, Mode, PartScore, SoundsLike, TextItem } from './models';

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

  trashSize() {
    return this.call<number>('trash_size');
  }

  emptyTrash() {
    return this.call<number>('empty_trash');
  }

  openDataFolder() {
    return this.call<void>('open_data_folder');
  }

  soundsLike(word: string) {
    return this.call<SoundsLike>('pron', { w: word });
  }

  audioUrl(path: string) {
    return convertFileSrc(`${this.dataDir}/${this.relative(path)}`);
  }
}
