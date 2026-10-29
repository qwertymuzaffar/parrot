import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Part } from '../core/models';
import { Playback } from '../core/playback';
import { Recorder } from '../core/recorder';
import { Session } from '../core/session';
import { Names } from '../core/names';
import { WordPractice } from '../core/word-practice';
import { Practice } from './practice';

const PARTS: Part[] = [
  { label: '1', text: 'Hello there, my friend.', sub: false, w0: 0, key: 'p-1' },
  { label: '2', text: 'How are you?', sub: false, w0: 4, key: 'p-2' },
  { label: '3', text: 'I am fine.', sub: false, w0: 7, key: 'p-3' },
];

/** The session as the screen reads it: three parts, the first one shown; choosing a part shows it. */
function threeParts() {
  const index = signal(0);
  const words = signal(PARTS[0].text.split(' '));
  return {
    text: signal({ id: 'text', title: 'Greeting', words: 10, mode: 'sentences' }),
    part: signal(PARTS[0]),
    parts: signal(PARTS),
    index,
    scores: signal({ [PARTS[0].key]: { last: 70, best: 70, tries: 1 } }),
    progress: signal({ total: 3, done: 1, avg: 70 }),
    words,
    result: signal(null),
    history: signal([]),
    previousScore: signal(null),
    troubleWords: signal([]),
    preparing: signal(false),
    checking: signal(false),
    checkingText: signal(false),
    loading: signal(false),
    recording: signal(false),
    error: signal<string | null>(null),
    selected: signal<number | null>(null),
    peaks: signal(null),
    bars: 92,
    select: vi.fn((partIndex: number) => {
      index.set(partIndex);
      words.set(PARTS[partIndex].text.split(' '));
    }),
    toggleRecord: vi.fn(),
  };
}

/** Focus as a keyboard user has it on the practice screen: the screen attached to the page, and Enter on a button. */
describe('keyboard focus on the practice screen', () => {
  let session: ReturnType<typeof threeParts>;

  beforeEach(() => {
    session = threeParts();
    TestBed.configureTestingModule({
      providers: [
        { provide: Session, useValue: session },
        { provide: Names, useValue: { has: () => false } },
        {
          provide: Playback,
          useValue: {
            nowRef: signal(null),
            nowMine: signal(null),
            playing: signal<string | null>(null),
            paused: signal(false),
            rate: signal(1),
            voiceMissing: signal(false),
            stop: vi.fn(),
          },
        },
        {
          provide: Recorder,
          useValue: { owner: signal(null), elapsed: signal(0), trace: signal([]), level: signal(0), device: signal(''), warm() {} },
        },
        { provide: WordPractice, useValue: { checking: signal(false) } },
      ],
    });
    // the screen alone: the sidebar, waveform and cards around it have their own state
    TestBed.overrideComponent(Practice, { set: { imports: [], schemas: [NO_ERRORS_SCHEMA] } });
    Element.prototype.scrollIntoView = () => {};
  });

  async function render() {
    const fixture = TestBed.createComponent(Practice);
    document.body.append(fixture.nativeElement);
    await fixture.whenStable();
    return fixture;
  }

  afterEach(() => document.body.replaceChildren());

  const steps = () => [...document.querySelectorAll<HTMLButtonElement>('.steps button')];
  /** Enter on a focused button: a key, then the click it makes */
  const enter = (target: HTMLElement) => {
    target.focus();
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    target.click();
  };

  it('keeps focus on the step chosen, which becomes the current one', async () => {
    const fixture = await render();
    const second = steps()[1];
    enter(second);
    await fixture.whenStable();
    expect(session.select).toHaveBeenCalledWith(1);
    // the same button, now the current step
    expect([document.activeElement, steps()[1], second.getAttribute('aria-current'), second.classList.contains('current')]).toEqual([
      second,
      second,
      'step',
      true,
    ]);
    expect(steps()[0].getAttribute('aria-current')).toBeNull();
  });

  it('keeps focus on Record across a take, which is not pressed again while it is checked', async () => {
    const fixture = await render();
    const record = document.querySelector<HTMLButtonElement>('.record')!;
    enter(record);
    session.recording.set(true);
    await fixture.whenStable();
    session.recording.set(false);
    session.checking.set(true);
    await fixture.whenStable();
    expect([document.activeElement, record.disabled, record.getAttribute('aria-busy')]).toEqual([record, false, 'true']);
    session.checking.set(false);
    await fixture.whenStable();
    expect([document.activeElement, record.getAttribute('aria-busy')]).toEqual([record, null]);
  });

  it('goes to the new part’s step when the part goes from under focus (a word of it), not to the page', async () => {
    const fixture = await render();
    const lastWord = document.querySelectorAll<HTMLElement>('.sentence .w')[3];
    lastWord.focus();
    // the arrow down: the next part, of fewer words
    session.select(1);
    await fixture.whenStable();
    expect(document.activeElement).toBe(steps()[1]);
  });

  it('leaves focus on the page as the part changes from the keyboard, so Space still means Listen', async () => {
    const fixture = await render();
    (document.activeElement as HTMLElement | null)?.blur();
    // a key, and then the part changes as the arrow's shortcut changes it
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    session.select(1);
    await fixture.whenStable();
    expect(document.activeElement).toBe(document.body);
  });

  it('leaves focus elsewhere where it is as the part changes', async () => {
    const fixture = await render();
    const outside = document.body.appendChild(document.createElement('input'));
    outside.focus();
    session.select(2);
    await fixture.whenStable();
    expect(document.activeElement).toBe(outside);
  });
});
