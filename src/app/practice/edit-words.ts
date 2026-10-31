import { ChangeDetectionStrategy, Component, computed, ElementRef, inject, signal, viewChild } from '@angular/core';
import { errorMessage, Library } from '../core/library';
import { Playback } from '../core/playback';
import { Recorder } from '../core/recorder';
import { Session } from '../core/session';
import { inEnglish, wordCount } from '../core/split';
import { WordPractice } from '../core/word-practice';

/** How long the engine may go without a word (a report of progress) before the user is offered to give up waiting (ms). */
export const STUCK_MS = 15_000;

/** Fixing the words of the text open: the tries of each part whose words change are scored again against them. */
@Component({
  selector: 'app-edit-words',
  template: `
    <!-- a sheet, as on the desktop: down from the top of the window, closed with Cancel, Save or Esc, not with an × or
         a click beside it -->
    <dialog #dialog class="sheet" (cancel)="escape($event)" aria-labelledby="edit-words-title">
      <div class="box">
        <header>
          <h2 id="edit-words-title">Edit the words</h2>
        </header>
        <p class="hint">
          Fix a word, or add or remove some. The tries of each part you change are scored again from their recordings, against its words
          now; the other parts keep theirs as they are.
        </p>
        <!-- the words are what the dialog is for: it opens with the cursor in them, not on Close -->
        <textarea
          class="field"
          aria-label="The text"
          autofocus
          [value]="words()"
          [disabled]="busy()"
          (input)="words.set($any($event.target).value)"
        ></textarea>
        @if (!inEnglish(words())) {
          <p class="hint">Parrot checks English only</p>
        }
        @if (failure(); as failure) {
          <p class="error" role="alert">{{ failure }}</p>
        }
        <div class="go">
          @if (busy()) {
            <span class="hint" role="status">
              <span class="spinner"></span>
              @if (total()) {
                Scoring the tries again: {{ done() }} of {{ total() }}
              } @else {
                Saving…
              }
            </span>
            <!-- the engine has gone quiet: a way out, with the edit kept -->
            @if (stuck()) {
              <button class="btn ghost" (click)="giveUp()">Cancel</button>
            }
          } @else {
            <button class="btn ghost" (click)="close()">Cancel</button>
            <button class="btn primary" [disabled]="!wordCount(words()) || !inEnglish(words())" (click)="save()">Save</button>
          }
        </div>
      </div>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(620px, calc(100vw - 32px));
    }
    .box {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 18px 22px 22px;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 0 -22px;
      padding: 0 22px 14px;
      border-bottom: 1px solid var(--line);
    }
    h2 {
      margin: 0;
      font-size: 18px;
    }
    .hint {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    textarea {
      min-height: 220px;
      resize: vertical;
      font: inherit;
      line-height: 1.5;
    }
    .error {
      margin: 0;
      font-size: 13px;
      color: var(--wrong-ink);
    }
    .go {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditWords {
  private library = inject(Library);
  private session = inject(Session);
  private playback = inject(Playback);
  private recorder = inject(Recorder);
  private wordPractice = inject(WordPractice);
  private dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly words = signal('');
  protected readonly wordCount = wordCount;
  protected readonly inEnglish = inEnglish;
  protected readonly busy = signal(false);
  protected readonly done = signal(0);
  protected readonly total = signal(0);
  protected readonly failure = signal<string | null>(null);
  /** the engine has not been heard from for STUCK_MS: the user may give up waiting */
  protected readonly stuck = signal(false);
  private stuckTimer = 0;
  /** counts the saves: a save the user gave up waiting for has nothing more to say in the dialog */
  private edits = 0;
  /** a take being recorded or checked: the words wait for it, or it would be filed under words the text no longer has */
  readonly taking = computed(() => !!this.recorder.owner() || this.session.checkingText() || this.wordPractice.checking());

  open() {
    const text = this.session.text();
    if (!text || this.taking()) return;
    this.words.set(text.text);
    this.failure.set(null);
    this.dialog().nativeElement.showModal();
  }

  close() {
    if (!this.busy()) this.dialog().nativeElement.close();
  }

  /** Esc closes the dialog; while a save is under way it does nothing, unless the engine has gone quiet: then it gives up
   * waiting, as Cancel does. */
  protected escape(event: Event) {
    if (!this.busy()) return;
    event.preventDefault();
    if (this.stuck()) this.giveUp();
  }

  protected async save() {
    const text = this.session.text();
    if (!text) return;
    if (this.taking()) {
      this.failure.set('A take is being checked: save once it is done.');
      return;
    }
    this.playback.stop();
    const edit = ++this.edits;
    this.busy.set(true);
    this.failure.set(null);
    this.done.set(0);
    this.total.set(0);
    this.heard();
    try {
      await this.library.editText(text.id, this.words(), (done, total) => {
        if (edit !== this.edits) return;
        this.done.set(done);
        this.total.set(total);
        this.heard();
      });
      if (edit !== this.edits) {
        // the user gave up waiting, but the words are changed now: the text shows them if it is still open
        if (this.session.text()?.id === text.id) void this.session.open(text.id, this.session.index());
        return;
      }
      // its parts may have changed: open it again where it was
      await this.session.open(text.id, this.session.index());
      this.busy.set(false);
      this.close();
    } catch (error) {
      if (edit !== this.edits) return;
      this.busy.set(false);
      this.failure.set(errorMessage(error));
    } finally {
      if (edit === this.edits) this.quiet();
    }
  }

  /** Stop waiting for the engine: the edit stays in the box, to save again or close. */
  protected giveUp() {
    if (!this.busy()) return;
    this.edits++;
    this.quiet();
    this.busy.set(false);
    this.failure.set("The speech engine hasn't answered. Your edit is still here: save it again, or close.");
  }

  /** The engine was heard from: it has STUCK_MS again before the user is offered to give up. */
  private heard() {
    this.quiet();
    this.stuckTimer = window.setTimeout(() => this.stuck.set(true), STUCK_MS);
  }

  private quiet() {
    clearTimeout(this.stuckTimer);
    this.stuck.set(false);
  }
}
