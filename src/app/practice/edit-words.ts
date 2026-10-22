import { ChangeDetectionStrategy, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { errorMessage, Library } from '../core/library';
import { Playback } from '../core/playback';
import { Session } from '../core/session';
import { Icon } from '../shared/icon';

/** Fixing the words of the text open: the tries of each part whose words change are scored again against them. */
@Component({
  selector: 'app-edit-words',
  imports: [Icon],
  template: `
    <dialog #dialog (click)="backdrop($event)" (cancel)="busy() && $event.preventDefault()" aria-labelledby="edit-words-title">
      <div class="box">
        <header>
          <h2 id="edit-words-title">Edit the words</h2>
          <button class="btn ghost icon" (click)="close()" [disabled]="busy()" aria-label="Close"><app-icon name="close" /></button>
        </header>
        <p class="hint">
          Fix a word, or add or remove some. The tries of each part you change are scored again from their recordings, against its words
          now; the other parts keep theirs as they are.
        </p>
        <textarea
          class="field"
          aria-label="The text"
          [value]="words()"
          [disabled]="busy()"
          (input)="words.set($any($event.target).value)"
        ></textarea>
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
          } @else {
            <button class="btn ghost" (click)="close()">Cancel</button>
            <button class="btn primary" [disabled]="!words().trim()" (click)="save()">Save</button>
          }
        </div>
      </div>
    </dialog>
  `,
  styles: `
    dialog {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 0;
      width: min(620px, calc(100vw - 32px));
      background: var(--surface);
      color: var(--ink);
      box-shadow: var(--shadow-lg);
    }
    dialog::backdrop {
      background: rgba(0, 0, 0, 0.35);
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
  private dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly words = signal('');
  protected readonly busy = signal(false);
  protected readonly done = signal(0);
  protected readonly total = signal(0);
  protected readonly failure = signal<string | null>(null);

  open() {
    const text = this.session.text();
    if (!text) return;
    this.words.set(text.text);
    this.failure.set(null);
    this.dialog().nativeElement.showModal();
  }

  close() {
    if (!this.busy()) this.dialog().nativeElement.close();
  }

  protected backdrop(event: MouseEvent) {
    if (event.target === this.dialog().nativeElement) this.close();
  }

  protected async save() {
    const text = this.session.text();
    if (!text) return;
    this.playback.stop();
    this.busy.set(true);
    this.failure.set(null);
    this.done.set(0);
    this.total.set(0);
    try {
      await this.library.editText(text.id, this.words(), (done, total) => {
        this.done.set(done);
        this.total.set(total);
      });
      // its parts may have changed: open it again where it was
      await this.session.open(text.id, this.session.index());
      this.busy.set(false);
      this.close();
    } catch (error) {
      this.busy.set(false);
      this.failure.set(errorMessage(error));
    }
  }
}
