import { Injectable } from '@angular/core';
import { Engine, EngineError, EngineInfo } from './engine';
import { Activity, Attempt, AttemptSummary, Mode, PartScore, SoundsLike, TextItem } from './models';

/** The Python prototype engine (engine/server.py), for working in a browser. */
export const DEV_ENGINE = 'http://127.0.0.1:8770';

/** The Python prototype engine, over HTTP: for development and screenshots in a plain browser. */
@Injectable()
export class HttpEngine extends Engine {
  private async http<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(DEV_ENGINE + path, init);
    } catch {
      throw new EngineError('The speech engine is not running. Start it with: python engine/server.py');
    }
    const body = await res.json();
    if (!res.ok || body?.error) throw new EngineError(body?.error ?? `engine error ${res.status}`);
    return body as T;
  }

  private post<T>(path: string, data: unknown): Promise<T> {
    return this.http<T>(path, { method: 'POST', body: JSON.stringify(data) });
  }

  async info(): Promise<EngineInfo> {
    const health = await this.http<{ data: string; whisper: boolean }>('/api/health');
    return {
      data: health.data,
      models: { whisper: health.whisper, aligner: true },
      sizes: { whisper: 0, aligner: 0 },
    };
  }

  async downloadModels(): Promise<void> {
    throw new EngineError('Only the desktop app downloads the speech models');
  }

  texts() {
    return this.http<TextItem[]>('/api/texts');
  }

  addText(text: string, title: string, mode: Mode) {
    return this.post<TextItem>('/api/texts', { text, title, mode });
  }

  updateText(id: string, change: { title?: string; mode?: Mode; opened?: boolean }) {
    return this.post<TextItem>('/api/texts/update', { id, ...change });
  }

  deleteText(id: string) {
    return this.post<void>('/api/texts/delete', { id });
  }

  scores(textId: string) {
    return this.http<Record<string, PartScore>>(`/api/scores?text=${textId}`);
  }

  attempts(textId: string, part: string) {
    return this.http<AttemptSummary[]>(`/api/attempts?text=${textId}&part=${encodeURIComponent(part)}`);
  }

  attempt(textId: string, part: string, id: string) {
    return this.http<Attempt>(`/api/attempt?text=${textId}&part=${encodeURIComponent(part)}&id=${id}`);
  }

  check(textId: string, part: string, audio: Blob) {
    return this.http<Attempt>(`/api/check?text=${textId}&part=${encodeURIComponent(part)}`, {
      method: 'POST',
      headers: { 'Content-Type': audio.type || 'audio/wav' },
      body: audio,
    });
  }

  // the Python prototype keeps no tries of single words
  async checkWord(_textId: string, _word: string, _audio: Blob): Promise<never> {
    throw new EngineError('Word practice needs the desktop app');
  }

  async wordAttempts(_textId: string, _word: string): Promise<never> {
    throw new EngineError('Word practice needs the desktop app');
  }

  async wordAttempt(_textId: string, _word: string, _id: string): Promise<never> {
    throw new EngineError('Word practice needs the desktop app');
  }

  activity() {
    return this.http<Activity>('/api/activity');
  }

  soundsLike(word: string) {
    return this.http<SoundsLike>(`/api/pron?w=${encodeURIComponent(word)}`);
  }

  audioUrl(path: string) {
    return `${DEV_ENGINE}/files/${this.relative(path)}`;
  }
}
