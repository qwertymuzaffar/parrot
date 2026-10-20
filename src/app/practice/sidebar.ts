import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { IN_APP } from '../core/engine';
import { Library } from '../core/library';
import { Session } from '../core/session';
import { Icon } from '../shared/icon';
import { Logo } from '../shared/logo';
import { band } from '../shared/score';
import { matchesSearch } from '../shared/search';

/** Your texts, always at hand while practising. */
@Component({
  selector: 'app-sidebar',
  imports: [Icon, Logo],
  template: `
    <button class="brand" (click)="session.home()" title="Home">
      <app-logo [size]="34" />
      <span>
        <b>Parrot</b>
        <small>say it right</small>
      </span>
    </button>

    <button class="btn primary new" (click)="session.home()"><app-icon name="plus" [size]="16" /> New text</button>

    <label class="search">
      <app-icon name="search" [size]="15" />
      <span class="sr-only">Search texts</span>
      <input placeholder="Search texts" [value]="query()" (input)="query.set($any($event.target).value)" />
    </label>

    <span class="eyebrow">Your texts</span>
    <nav aria-label="Your texts">
      @for (text of shown(); track text.id) {
        <button
          [class.on]="text.id === session.text()?.id"
          [attr.aria-current]="text.id === session.text()?.id ? 'page' : null"
          (click)="session.open(text.id)"
        >
          <span class="what">
            <span class="t">{{ text.title }}</span>
            <span class="m">{{ text.words }} words · {{ text.practised ? text.practised + ' practised' : 'new' }}</span>
          </span>
          @if (text.average != null) {
            <span class="pill" [class]="band(text.average)">{{ text.average }}%</span>
          }
        </button>
      }
    </nav>

    <footer>
      <span class="dot" [class]="library.engineState()"></span>
      <span class="status" [title]="library.error() ?? ''">{{ status() }}</span>
      <button class="btn ghost square" (click)="settings.emit()" aria-label="Settings"><app-icon name="settings" [size]="17" /></button>
    </footer>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: calc(18px + var(--titlebar)) 14px 12px;
      border-right: 1px solid var(--line);
      background: var(--side);
      min-height: 0;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 2px 6px 6px;
      border: 0;
      background: none;
      text-align: left;
      span {
        display: flex;
        flex-direction: column;
      }
      b {
        font-family: var(--display);
        font-size: 20px;
        letter-spacing: -0.02em;
        line-height: 1;
      }
      small {
        font-size: 12px;
        color: var(--muted);
      }
    }
    .new {
      height: 40px;
      border-radius: 11px;
    }
    .search {
      display: flex;
      align-items: center;
      gap: 8px;
      height: 36px;
      border-radius: 10px;
      padding: 0 10px;
      background: var(--surface);
      border: 1px solid var(--line);
      color: var(--muted);
      input {
        border: 0;
        outline: 0;
        background: transparent;
        width: 100%;
        color: var(--ink);
      }
      &:focus-within {
        border-color: var(--accent);
      }
    }
    .eyebrow {
      padding: 4px 6px 0;
    }
    nav {
      flex: 1;
      min-height: 0;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 4px;
      button {
        display: flex;
        align-items: center;
        gap: 10px;
        text-align: left;
        padding: 9px 10px;
        border-radius: 11px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--ink-2);
        &:hover {
          background: var(--surface-2);
        }
        &.on {
          border-color: var(--line);
          background: var(--surface);
          color: var(--ink);
          box-shadow: var(--shadow-sm);
          .t {
            font-weight: 600;
          }
        }
      }
      .what {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }
      .t {
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .m {
        font-size: 12px;
        color: var(--muted);
      }
    }
    footer {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 2px 0 8px;
      border-top: 1px solid var(--line);
      font-size: 12px;
      color: var(--muted);
      .status {
        flex: 1;
      }
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--bar);
      &.ready {
        background: var(--accent);
      }
      &.down {
        background: var(--rec);
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Sidebar {
  protected library = inject(Library);
  protected session = inject(Session);
  readonly settings = output<void>();
  protected band = band;
  protected query = signal('');
  protected readonly shown = computed(() => {
    const search = this.query();
    return this.library.texts().filter((text) => matchesSearch(search, text.title, text.text));
  });
  /** the engine is built into the desktop app: when it fails there, it is not for the user to start */
  private readonly down = IN_APP ? 'Engine error' : 'Engine not running';
  protected readonly status = computed(
    () => ({ checking: 'Starting…', ready: 'On-device · ready', down: this.down })[this.library.engineState()],
  );
}
