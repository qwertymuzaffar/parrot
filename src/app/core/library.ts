import { inject, Injectable, signal } from '@angular/core';
import { Engine, EngineError } from './engine';
import { Activity, Mode, TextItem } from './models';
import { forgetSplits } from './split';

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
  /** counts the loads begun and the changes made: a load that lands after a newer load, or after a change (a rename,
   * delete, mode or add made meanwhile), carries a list older than what is shown, and is dropped */
  private loads = 0;

  async loadTexts() {
    const load = ++this.loads;
    try {
      const texts = await this.engine.texts();
      if (load !== this.loads) return;
      this.texts.set(texts);
      this.engineState.set('ready');
      this.error.set(null);
    } catch (error) {
      if (load !== this.loads) return;
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
      this.changed((list) => [added, ...list.filter((item) => item.id !== added.id)]);
      this.error.set(null);
      return added;
    } catch (error) {
      this.error.set(errorMessage(error));
      return null;
    }
  }

  async rename(id: string, title: string) {
    await this.change(async () => this.replace(await this.engine.updateText(id, { title })));
  }

  /** Change a text's words (the tries of the parts that changed are scored again); throws why it couldn't. */
  async editText(id: string, text: string, onProgress: (done: number, total: number) => void) {
    const before = this.texts().find((item) => item.id === id);
    const saved = await this.engine.editText(id, text, ({ done, total }) => onProgress(done, total));
    // the old words are nobody's now: their splits go with them
    if (before && before.text !== saved.text) forgetSplits(before.text);
    this.replace(saved);
  }

  async setMode(id: string, mode: Mode) {
    this.replace(await this.engine.updateText(id, { mode }));
  }

  async remove(id: string) {
    await this.change(async () => {
      // its splits go with it (split again on demand should the delete fail)
      const text = this.texts().find((item) => item.id === id);
      if (text) forgetSplits(text.text);
      await this.engine.deleteText(id);
      this.changed((list) => list.filter((item) => item.id !== id));
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
    this.changed((list) => list.map((item) => (item.id === saved.id ? saved : item)));
  }

  /** The list as changed by hand, from the engine's answer: a load begun before the change is older than this. */
  private changed(change: (list: TextItem[]) => TextItem[]) {
    this.loads++;
    this.texts.update(change);
  }
}

export function errorMessage(error: unknown) {
  return error instanceof EngineError ? error.message : String(error);
}
