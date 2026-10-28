import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { IN_APP } from '../core/engine';
import { Library } from '../core/library';
import { Session } from '../core/session';
import { forgetSetting, readSetting, writeSetting } from '../core/settings';
import { Icon } from '../shared/icon';
import { Logo } from '../shared/logo';
import { band } from '../shared/score';
import { matchesSearch } from '../shared/search';

/** the texts column can be dragged between these */
const NARROWEST = 200;
const WIDEST = 400;
/** the room the other columns keep whatever the drag: the right column's 332 px, and the centre as wide as it is in
 * the smallest window (960 px, in tauri.conf.json), so the stage is never crushed */
const OTHERS = 332 + (960 - NARROWEST - 332);
const SETTING = 'texts-width';

function clamp(value: number, least: number, most: number) {
  return Math.min(Math.max(value, least), most);
}

/** the width the column was last dragged to on this computer, if any */
function kept(): number | null {
  const width = Number(readSetting(SETTING, ''));
  return width > 0 ? width : null;
}

/** Your texts, always at hand while practising. The column's right edge is dragged to make room for long titles. */
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
          [class.opening]="text.id === session.opening()"
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

    <!-- the smallest window has no room to give: no edge to drag then -->
    @if (widest() > narrowest) {
      <div
        class="edge"
        role="separator"
        aria-orientation="vertical"
        aria-label="Width of the texts column"
        [attr.aria-valuemin]="narrowest"
        [attr.aria-valuemax]="widest()"
        [attr.aria-valuenow]="width()"
        tabindex="0"
        title="Drag to resize. Double-click to put it back."
        (pointerdown)="grab($event)"
        (pointermove)="drag($event)"
        (pointerup)="release()"
        (pointercancel)="release()"
        (lostpointercapture)="release()"
        (dblclick)="reset()"
        (keydown)="key($event)"
      ></div>
    }
  `,
  styles: `
    :host {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: calc(18px + var(--titlebar)) 14px 12px;
      border-right: 1px solid var(--line);
      background: var(--side);
      min-height: 0;
    }
    :host(.dragging) {
      cursor: col-resize;
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
        // a text taking a moment to open: shown after the moment every open takes
        &.opening {
          cursor: progress;
          opacity: 0.7;
          transition: opacity 0.15s 0.25s;
        }
      }
      .what {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }
      // a long title, such as the prompt a talk was about, wraps once before it is cut
      .t {
        font-weight: 500;
        overflow-wrap: anywhere;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
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
    // the right edge, astride the border: a line shows it while it is under the pointer, focused or dragged
    .edge {
      position: absolute;
      top: 0;
      bottom: 0;
      right: -4px;
      width: 9px;
      z-index: 1;
      cursor: col-resize;
      outline: none;
      touch-action: none;
      &::after {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        left: 3px;
        width: 3px;
        border-radius: 2px;
        background: var(--accent);
        opacity: 0;
        transition: opacity 0.15s;
      }
      &:hover::after,
      &:focus-visible::after {
        opacity: 1;
      }
    }
    :host(.dragging) .edge::after {
      opacity: 1;
    }
  `,
  host: { '[style.width.px]': 'width()', '[class.dragging]': 'dragging()', '(window:resize)': 'measure()' },
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

  /** the width the column was dragged to, or null for the window's own */
  private readonly dragged = signal(kept());
  private readonly windowWidth = signal(window.innerWidth);
  protected readonly narrowest = NARROWEST;
  /** as wide as the window has room for */
  protected readonly widest = computed(() => clamp(this.windowWidth() - OTHERS, NARROWEST, WIDEST));
  /** the column's width: the one dragged to, or a fifth of the window (236 px from 1240 px up), held to the room there is */
  protected readonly width = computed(() =>
    Math.round(clamp(this.dragged() ?? clamp(0.191 * this.windowWidth(), NARROWEST, 236), NARROWEST, this.widest())),
  );
  protected readonly dragging = signal(false);
  /** where the edge was taken hold of, and how wide the column was then */
  private grabbed = { x: 0, width: 0 };

  protected measure() {
    this.windowWidth.set(window.innerWidth);
  }

  protected grab(event: PointerEvent) {
    if (event.button !== 0) return;
    // no text selected along the way, and no focus ring for a drag by the mouse
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    this.grabbed = { x: event.clientX, width: this.width() };
    this.dragging.set(true);
  }

  protected drag(event: PointerEvent) {
    if (!this.dragging()) return;
    this.resize(this.grabbed.width + event.clientX - this.grabbed.x);
  }

  protected release() {
    if (!this.dragging()) return;
    this.dragging.set(false);
    this.keep();
  }

  /** the arrows nudge the edge, Home and End take it to its ends, Enter puts it back */
  protected key(event: KeyboardEvent) {
    switch (event.key) {
      case 'ArrowLeft':
        this.resize(this.width() - 16);
        break;
      case 'ArrowRight':
        this.resize(this.width() + 16);
        break;
      case 'Home':
        this.resize(NARROWEST);
        break;
      case 'End':
        this.resize(this.widest());
        break;
      case 'Enter':
        this.reset();
        break;
      default:
        return;
    }
    event.preventDefault();
    if (event.key !== 'Enter') this.keep();
  }

  protected reset() {
    this.dragged.set(null);
    forgetSetting(SETTING);
  }

  private resize(px: number) {
    this.dragged.set(clamp(px, NARROWEST, this.widest()));
  }

  private keep() {
    writeSetting(SETTING, String(this.width()));
  }
}
