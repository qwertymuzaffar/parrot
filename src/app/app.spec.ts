import { Component, input, output, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { App, SLOW_START_MS } from './app';
import { Engine, EngineInfo } from './core/engine';
import { Library } from './core/library';
import { Session } from './core/session';
import { Talking } from './core/talking';
import { Theme } from './core/theme';

// the screens stood in for: only which one shows is looked at here
@Component({ selector: 'app-home', template: '<h1 tabindex="-1">Your texts</h1><button>A text</button>' })
class HomeStandIn {
  readonly settings = output<void>();
}
@Component({ selector: 'app-practice', template: '<h1 tabindex="-1">A text</h1><button>Home</button>' })
class PracticeStandIn {
  readonly settings = output<void>();
}
@Component({ selector: 'app-talk-preview', template: '<button>Home</button><h1 tabindex="-1">Check what you said</h1>' })
class PreviewStandIn {}
@Component({ selector: 'app-setup', template: 'setup' })
class SetupStandIn {
  readonly info = input<EngineInfo>();
  readonly done = output<void>();
}
@Component({ selector: 'app-settings', template: '<button>Close</button>' })
class SettingsStandIn {
  open() {}
}

const INFO: EngineInfo = { data: '/data', models: { whisper: true, aligner: true }, sizes: { whisper: 1, aligner: 1 } };

/** a promise and the function that settles it */
function later<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (settle = resolve));
  return { promise, settle };
}

describe('the window as Parrot starts', () => {
  let info: ReturnType<typeof later<EngineInfo>>;
  let asked: ReturnType<typeof later<void>>;
  let library: { loadTexts: ReturnType<typeof vi.fn>; loadActivity: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    info = later<EngineInfo>();
    asked = later<void>();
    library = { loadTexts: vi.fn().mockResolvedValue(undefined), loadActivity: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        { provide: Engine, useValue: { info: () => info.promise } },
        { provide: Talking, useValue: { asked: asked.promise, checking: signal(false) } },
        { provide: Session, useValue: { view: signal('home') } },
        { provide: Library, useValue: library },
        { provide: Theme, useValue: { apply: vi.fn() } },
      ],
    });
    TestBed.overrideComponent(App, { set: { imports: [HomeStandIn, SetupStandIn, SettingsStandIn] } });
  });

  afterEach(() => vi.useRealTimers());

  async function render() {
    const fixture = TestBed.createComponent(App);
    const element: HTMLElement = fixture.nativeElement;
    const update = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await fixture.whenStable();
    };
    const shown = () => ['app-home', 'app-setup', '.waiting'].filter((screen) => element.querySelector(screen));
    await update();
    return { element, update, shown };
  }

  it('draws Home only once the engine has answered and said whether a talk was left', async () => {
    const app = await render();
    expect(app.shown()).toEqual([]);
    info.settle(INFO);
    await app.update();
    // the Just talk card would show a new talk, then the one left from last time
    expect(app.shown()).toEqual([]);
    asked.settle();
    await app.update();
    expect([app.shown(), library.loadTexts.mock.calls.length]).toEqual([['app-home'], 1]);
  });

  it('draws Setup on a first launch, never Home before it', async () => {
    const app = await render();
    asked.settle();
    await app.update();
    expect(app.shown()).toEqual([]);
    info.settle({ ...INFO, models: { whisper: false, aligner: true } });
    await app.update();
    expect([app.shown(), library.loadTexts.mock.calls.length]).toEqual([['app-setup'], 0]);
  });

  it('says the engine has not answered after a few seconds, and goes on when it does', async () => {
    vi.useFakeTimers();
    const fixture = TestBed.createComponent(App);
    const element: HTMLElement = fixture.nativeElement;
    await vi.advanceTimersByTimeAsync(SLOW_START_MS - 1);
    fixture.detectChanges();
    expect(element.querySelector('.waiting')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    fixture.detectChanges();
    expect(element.querySelector('.waiting')!.textContent!.trim()).toBe("The speech engine hasn't answered yet. Parrot is still waiting.");
    info.settle(INFO);
    asked.settle();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect([!!element.querySelector('.waiting'), !!element.querySelector('app-home')]).toEqual([false, true]);
  });
});

describe('focus as the window goes from screen to screen', () => {
  const view = signal<'home' | 'practice'>('home');
  const checking = signal(false);

  beforeEach(() => {
    view.set('home');
    checking.set(false);
    TestBed.configureTestingModule({
      providers: [
        { provide: Engine, useValue: { info: async () => INFO } },
        { provide: Talking, useValue: { asked: Promise.resolve(), checking } },
        { provide: Session, useValue: { view } },
        { provide: Library, useValue: { loadTexts: vi.fn().mockResolvedValue(undefined), loadActivity: vi.fn() } },
        { provide: Theme, useValue: { apply: vi.fn() } },
      ],
    });
    TestBed.overrideComponent(App, { set: { imports: [HomeStandIn, PracticeStandIn, PreviewStandIn, SettingsStandIn] } });
  });

  afterEach(() => document.body.replaceChildren());

  async function render() {
    const fixture = TestBed.createComponent(App);
    const element: HTMLElement = fixture.nativeElement;
    document.body.append(element);
    const update = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await fixture.whenStable();
    };
    await update();
    /** Enter on the screen's button */
    const enter = (screen: string) => {
      const button = element.querySelector<HTMLElement>(`${screen} button`)!;
      button.focus();
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    };
    const focused = () => (document.activeElement === document.body ? null : document.activeElement!.textContent);
    return { element, update, enter, focused };
  }

  it('leaves focus alone on the first screen', async () => {
    const app = await render();
    expect([!!app.element.querySelector('app-home'), app.focused()]).toEqual([true, null]);
  });

  it('puts it on the heading of each new screen: a text opened, Home, the check of a talk, and Home from there', async () => {
    const app = await render();
    app.enter('app-home');
    view.set('practice');
    await app.update();
    expect(app.focused()).toBe('A text');
    app.enter('app-practice');
    view.set('home');
    await app.update();
    expect(app.focused()).toBe('Your texts');
    app.enter('app-home');
    checking.set(true);
    await app.update();
    expect(app.focused()).toBe('Check what you said');
    app.enter('app-talk-preview');
    checking.set(false);
    await app.update();
    expect(app.focused()).toBe('Your texts');
  });

  it('leaves it in the Settings dialog', async () => {
    const app = await render();
    app.enter('app-settings');
    view.set('practice');
    await app.update();
    expect(app.focused()).toBe('Close');
  });
});
