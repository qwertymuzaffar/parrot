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
    TestBed.overrideComponent(Practice, { set: { imports: [], template: '<div class="page"><button>Mine</button></div>' } });
    const fixture = TestBed.createComponent(Practice);
    fixture.detectChanges();
    page = fixture.nativeElement.querySelector('.page');
    button = fixture.nativeElement.querySelector('button');
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
