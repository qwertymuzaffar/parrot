import { Injectable, signal } from '@angular/core';
import { Mode } from '../core/models';

/** What Home has on it that outlives Home, which is made anew every time it shows (back from a text, a talk): the text
 * being written and not yet added, and how far down the texts were scrolled. Kept while Parrot runs. */
@Injectable({ providedIn: 'root' })
export class HomeState {
  readonly draft = signal('');
  readonly draftTitle = signal('');
  readonly draftMode = signal<Mode>('sentences');
  /** how far the texts column was scrolled (px): not a signal, nothing on screen follows it */
  scroll = 0;
}
