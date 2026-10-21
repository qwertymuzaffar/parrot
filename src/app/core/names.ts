import { inject, Injectable, signal } from '@angular/core';
import { Engine } from './engine';
import { errorMessage } from './library';

/** How a word is kept in the names list, as the engine keeps it: lower case, without the punctuation around it or a
 * possessive 's. */
export function nameKey(word: string) {
  return word
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .toLowerCase()
    .replace(/['’]s$/, '');
}

/** The words never counted as misheard, in every text: names, which speech recognition writes as some other word
 * every time. A name is still judged by how clearly it was said. */
@Injectable({ providedIn: 'root' })
export class Names {
  private engine = inject(Engine);

  readonly list = signal<string[]>([]);
  /** why a word could not be marked or unmarked */
  readonly error = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  async load() {
    try {
      this.list.set(await this.engine.names());
    } catch {
      // without the list every word counts as it always did; marking one tries the engine again
    }
  }

  has(word: string) {
    return this.list().includes(nameKey(word));
  }

  /** Mark a word as a name, or not: from the next take on, in every text. */
  async set(word: string, name: boolean) {
    try {
      this.list.set(await this.engine.setName(word, name));
      this.error.set(null);
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }
}
