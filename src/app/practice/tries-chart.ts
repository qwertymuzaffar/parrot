import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { errorMessage } from '../core/library';
import { Part } from '../core/models';
import { Session } from '../core/session';
import { Icon } from '../shared/icon';

/** Every try of the part as a bar, oldest first; click one to see it, or delete the one shown. */
@Component({
  selector: 'app-tries-chart',
  imports: [Icon],
  template: `
    <div class="head">
      @if (asking(); as id) {
        <span class="ask">Delete this try and its recording?</span>
        <span class="acts">
          <button class="btn ghost small" (click)="confirming.set(null)">Keep</button>
          <button class="btn danger small" (click)="remove(id)">Delete</button>
        </span>
      } @else {
        <span class="eyebrow">Tries of this part</span>
        <span class="acts">
          <span class="hint">{{ session.history().length > 6 ? 'last 6 of ' : '' }}{{ session.history().length }}</span>
          @if (session.result(); as shown) {
            <button
              class="btn ghost small icon"
              [disabled]="session.checking() || session.recording()"
              (click)="confirming.set(shown.id)"
              aria-label="Delete the try shown"
              title="Delete the try shown"
            >
              <app-icon name="trash" [size]="15" />
            </button>
          }
        </span>
      }
    </div>
    @if (failure(); as failure) {
      <p class="error">{{ failure }}</p>
    }
    <div class="bars">
      @for (attempt of tries(); track attempt.id) {
        <button type="button" [class.on]="attempt.on" (click)="session.showAttempt(attempt.id)" [title]="attempt.title">
          <b>{{ attempt.score }}</b>
          <span class="bar" [style.height.px]="attempt.h"></span>
          <span class="time">{{ attempt.time }}</span>
        </button>
      }
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 16px 18px;
      min-height: 0;
    }
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 36px;
    }
    .acts {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .icon {
      width: 36px;
      padding: 0;
    }
    .hint {
      font-size: 12px;
      color: var(--muted);
    }
    .ask {
      font-size: 13px;
      color: var(--ink-2);
    }
    .error {
      margin: 0;
      font-size: 13px;
      color: var(--wrong-ink);
    }
    .bars {
      flex: 1;
      overflow: hidden;
      display: flex;
      align-items: flex-end;
      gap: 8px;
      min-height: 80px;
    }
    .bars button {
      // bars share the width and may get narrow: nothing in them sets a minimum
      flex: 1 1 0;
      min-width: 0;
      max-width: 52px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 5px;
      border: 0;
      background: transparent;
      padding: 0;
      color: var(--ink-2);
    }
    b {
      font-size: 12px;
      font-weight: 700;
      color: var(--ink);
      font-variant-numeric: tabular-nums;
    }
    .bar {
      width: 100%;
      max-width: 38px;
      border-radius: 8px 8px 4px 4px;
      background: var(--bar);
      transition: height 0.3s;
    }
    .on .bar {
      background: var(--accent);
    }
    .time {
      font-size: 10px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      max-width: 100%;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TriesChart {
  protected session = inject(Session);
  /** the try asked about deleting: the question goes once another try or part is shown */
  protected confirming = signal<string | null>(null);
  protected readonly asking = computed(() => {
    const id = this.confirming();
    return id && id === this.session.result()?.id ? id : null;
  });
  /** why a try could not be deleted, said only on the part it was of */
  private error = signal<{ part: Part | null; message: string } | null>(null);
  protected readonly failure = computed(() => {
    const error = this.error();
    return error && error.part === this.session.part() ? error.message : null;
  });
  protected readonly tries = computed(() => {
    const shown = this.session.result()?.id;
    return this.session
      .history()
      .slice(0, 6)
      .reverse()
      .map((attempt) => ({
        id: attempt.id,
        score: attempt.score,
        on: attempt.id === shown,
        h: 8 + Math.round(Math.max(0, attempt.score) * 0.6),
        time: `${attempt.id.slice(9, 11)}:${attempt.id.slice(11, 13)}`,
        title: `${attempt.id.slice(6, 8)}/${attempt.id.slice(4, 6)} ${attempt.id.slice(9, 11)}:${attempt.id.slice(11, 13)} · ${attempt.wpm} words a minute`,
      }));
  });

  protected async remove(id: string) {
    this.confirming.set(null);
    const part = this.session.part();
    try {
      await this.session.deleteAttempt(id);
      this.error.set(null);
    } catch (error) {
      this.error.set({ part, message: errorMessage(error) });
    }
  }
}
