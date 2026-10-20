import { inject, Injectable, signal } from '@angular/core';
import { Engine, EngineError } from './engine';
import { Activity, Mode, TextItem } from './models';

/** The texts kept for practice, and the week's activity. */
@Injectable({ providedIn: 'root' })
export class Library {
  private engine = inject(Engine);

  readonly texts = signal<TextItem[]>([]);
  readonly loaded = signal(false);
  readonly engineState = signal<'checking' | 'ready' | 'down'>('checking');
  readonly activity = signal<Activity | null>(null);
  /** why the texts could not be loaded, added, renamed or deleted */
  readonly error = signal<string | null>(null);
  /** the next try at loading the texts while the engine is down: one at a time, however often loading fails */
  private retry: ReturnType<typeof setTimeout> | null = null;

  async loadTexts() {
    try {
      this.texts.set(await this.engine.texts());
      this.engineState.set('ready');
      this.error.set(null);
    } catch (error) {
      this.engineState.set('down');
      this.error.set(errorMessage(error));
      // try again until the engine is up, so starting it is enough
      this.retry ??= setTimeout(() => {
        this.retry = null;
        if (this.engineState() === 'down') this.loadTexts().then(() => this.loadActivity());
      }, 3000);
    } finally {
      this.loaded.set(true);
    }
  }

  async loadActivity() {
    this.activity.set(await this.engine.activity().catch(() => null));
  }

  /** Add a text; null if the engine would not. */
  async add(text: string, title: string, mode: Mode) {
    try {
      const added = await this.engine.addText(text, title, mode);
      this.texts.update((list) => [added, ...list.filter((item) => item.id !== added.id)]);
      return added;
    } catch (error) {
      this.error.set(errorMessage(error));
      return null;
    }
  }

  async rename(id: string, title: string) {
    await this.change(async () => this.replace(await this.engine.updateText(id, { title })));
  }

  async setMode(id: string, mode: Mode) {
    this.replace(await this.engine.updateText(id, { mode }));
  }

  async remove(id: string) {
    await this.change(async () => {
      await this.engine.deleteText(id);
      this.texts.update((list) => list.filter((item) => item.id !== id));
    });
  }

  /** Make a change the user asked for; if the engine won't, say why (the text stays as it was). */
  private async change(make: () => Promise<void>) {
    try {
      await make();
      this.error.set(null);
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  private replace(saved: TextItem) {
    this.texts.update((list) => list.map((item) => (item.id === saved.id ? saved : item)));
  }
}

export function errorMessage(error: unknown) {
  return error instanceof EngineError ? error.message : String(error);
}
