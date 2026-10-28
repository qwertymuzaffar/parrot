import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Attempt, WordResult, WordStatus } from '../core/models';
import { Playback } from '../core/playback';
import { Recorder } from '../core/recorder';
import { Session } from '../core/session';
import { Names } from '../core/names';
import { WordPractice } from '../core/word-practice';
import { Practice } from './practice';

/** The practice screen's keyboard shortcuts and screen-reader labels, over stand-ins for the state (the real template
 * is replaced by one button and a stand-in for the page, so the shortcuts meet a focused control and the page). */
describe('the practice screen', () => {
  const session = {
    recording: signal(false),
    result: signal<Attempt | null>(null),
    previousScore: signal<number | null>(null),
    text: signal(null),
    words: signal<string[]>([]),
    index: signal(0),
    selected: signal<number | null>(null),
    part: signal({ text: 'Hello there.' }),
    toggleRecord: vi.fn(),
    next: vi.fn(),
    selectWord: vi.fn(),
  };
  const playback = { toggleReference: vi.fn(), stop: vi.fn() };
  let page: HTMLElement;
  let button: HTMLButtonElement;
  let box: HTMLInputElement;
  let field: HTMLInputElement;
  let labels: {
    wordLabel(wordIndex: number, word: string): string;
    stepLabel(label: string, score?: number): string;
    pauseAfter(wordIndex: number): number | null;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        { provide: Session, useValue: session },
        { provide: Names, useValue: { has: (word: string) => word === 'Muzaffar' } },
        { provide: Playback, useValue: playback },
        { provide: Recorder, useValue: { warm: vi.fn(), owner: signal(null) } },
        { provide: WordPractice, useValue: { toggleRecord: vi.fn() } },
      ],
    });
    TestBed.overrideComponent(Practice, {
      set: { imports: [], template: '<div class="page"><button>Mine</button><input type="checkbox" /><input /></div>' },
    });
    const fixture = TestBed.createComponent(Practice);
    fixture.detectChanges();
    page = fixture.nativeElement.querySelector('.page');
    button = fixture.nativeElement.querySelector('button');
    [box, field] = fixture.nativeElement.querySelectorAll('input');
    labels = fixture.componentInstance as never;
  });

  /** presses `key` with focus on `target`; true if the screen took the key (the browser's own action was prevented) */
  function press(target: HTMLElement, key: string) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it('listens on Space away from the controls', () => {
    expect(press(page, ' ')).toBe(true);
    expect(playback.toggleReference).toHaveBeenCalledWith('Hello there.');
  });

  it('leaves Space to a focused button, so it presses the button', () => {
    expect(press(button, ' ')).toBe(false);
    expect(playback.toggleReference).not.toHaveBeenCalled();
  });

  it('keeps the letter and arrow shortcuts on a focused button', () => {
    expect(press(button, 'r')).toBe(true);
    expect(session.toggleRecord).toHaveBeenCalled();
    expect(press(button, 'ArrowRight')).toBe(true);
    expect(session.next).toHaveBeenCalled();
  });

  it('leaves a key to a control that took it for itself', () => {
    button.addEventListener('keydown', (event) => event.preventDefault(), { once: true });
    expect(press(button, 'ArrowRight')).toBe(true);
    expect(session.next).not.toHaveBeenCalled();
  });

  it('keeps the shortcuts on a focused box to tick, but leaves it Space to tick it', () => {
    expect(press(box, ' ')).toBe(false);
    expect(playback.toggleReference).not.toHaveBeenCalled();
    // Esc closes the word card even with focus on its "A name" box
    expect(press(box, 'Escape')).toBe(true);
    expect([playback.stop.mock.calls.length, session.selectWord.mock.calls]).toEqual([1, [[null]]]);
  });

  it('leaves every key to a field being typed in', () => {
    for (const key of [' ', 'r', 'ArrowRight', 'Escape']) expect(press(field, key)).toBe(false);
    expect([session.toggleRecord, session.next, playback.stop, playback.toggleReference].some((each) => each.mock.calls.length)).toBe(
      false,
    );
  });

  it('says how each word came out and each part scored, which the screen shows in colour', () => {
    const word = (w: string, status: WordStatus, heard: string | null = null): WordResult => ({
      w,
      t: null,
      score: null,
      ref: null,
      status,
      heard,
      extra: '',
    });
    session.result.set({
      words: [word('Hello', 'good'), word('there', 'wrong', 'their'), word('now', 'wrong', ''), word('again', 'unclear')],
    } as Attempt);
    expect(['Hello', 'there', 'now', 'again'].map((each, wordIndex) => labels.wordLabel(wordIndex, each))).toEqual([
      'Hello',
      'there — misheard as “their”',
      'now — not heard',
      'again — sounded off',
    ]);
    expect(labels.stepLabel('3', 64)).toBe('Sentence 3, 64%');
    expect(labels.stepLabel('4')).toBe('Sentence 4, not practised');
  });

  it('says which words are names', () => {
    session.result.set(null);
    expect(labels.wordLabel(0, 'Muzaffar')).toBe('Muzaffar, a name');
    expect(labels.wordLabel(1, 'here')).toBe('here');
  });

  it('marks a long pause after the word it follows', () => {
    session.result.set({ words: [], pauses: [[1, 1.8]] } as unknown as Attempt);
    expect([0, 1, 2].map((wordIndex) => labels.pauseAfter(wordIndex))).toEqual([null, 1.8, null]);
    // a try from before 0.4 has no pauses
    session.result.set({ words: [] } as unknown as Attempt);
    expect(labels.pauseAfter(1)).toBeNull();
  });
});

/** The sentence is fitted to its box again whenever the centre changes size, so a texts column dragged wider refits
 * it as a resized window does. */
describe('the practice screen when the centre changes size', () => {
  let watch: ResizeObserverCallback | undefined;

  beforeEach(() => {
    watch = undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          watch = callback;
        }
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    TestBed.configureTestingModule({
      providers: [
        {
          provide: Session,
          useValue: {
            recording: signal(false),
            result: signal(null),
            previousScore: signal(null),
            text: signal(null),
            words: signal([]),
            index: signal(0),
            selected: signal(null),
            part: signal({ text: '' }),
          },
        },
        { provide: Names, useValue: { has: () => false } },
        { provide: Playback, useValue: {} },
        { provide: Recorder, useValue: { warm: vi.fn(), owner: signal(null) } },
        { provide: WordPractice, useValue: { checking: signal(false) } },
      ],
    });
    TestBed.overrideComponent(Practice, { set: { imports: [], template: '<main #centre><p #sentence>Hello there.</p></main>' } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('fits the sentence again', () => {
    const fixture = TestBed.createComponent(Practice);
    fixture.detectChanges();
    expect(watch).toBeDefined();
    const fit = vi.spyOn(fixture.componentInstance as unknown as { fit(): void }, 'fit');
    watch!([], {} as ResizeObserver);
    expect(fit).toHaveBeenCalled();
  });
});
