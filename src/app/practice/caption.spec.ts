import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Attempt, Part } from '../core/models';
import { Playback } from '../core/playback';
import { Recorder } from '../core/recorder';
import { Session } from '../core/session';
import { WordPractice } from '../core/word-practice';
import { Practice } from './practice';

const PART: Part = { label: '2', text: 'How are you?', sub: false, w0: 2, key: 'p-2' };
const TRY: Attempt = {
  id: 't1',
  when: '2026-10-20T12:00:00',
  text: PART.text,
  heard: PART.text,
  words: PART.text.split(' ').map((word) => ({ w: word, t: null, score: 0.9, ref: null, status: 'good', heard: null, extra: '' })),
  duration: 2,
  wpm: 140,
  score: 70,
  audio: 't1.wav',
};

/** The session as the screen reads it: a part with a try of it shown. */
function shownSession() {
  return {
    text: signal({ id: 'text', title: 'Greeting', words: 8, mode: 'sentences' }),
    part: signal(PART),
    parts: signal([PART]),
    index: signal(0),
    scores: signal({ [PART.key]: { last: 70, best: 70, tries: 1 } }),
    progress: signal({ total: 1, done: 1, avg: 70 }),
    words: signal(PART.text.split(' ')),
    result: signal<Attempt | null>(TRY),
    history: signal([{ id: TRY.id, when: TRY.when, score: TRY.score, wpm: TRY.wpm, duration: TRY.duration }]),
    previousScore: signal(null),
    troubleWords: signal([]),
    preparing: signal(false),
    checking: signal(false),
    recording: signal(false),
    error: signal<string | null>(null),
    selected: signal(null),
    peaks: signal(null),
    bars: 92,
  };
}

describe('the caption under the part', () => {
  let session: ReturnType<typeof shownSession>;
  const caption = () => document.querySelector('.take .caption')!.textContent!.replace(/\s+/g, ' ').trim();

  beforeEach(() => {
    session = shownSession();
    TestBed.configureTestingModule({
      providers: [
        { provide: Session, useValue: session },
        {
          provide: Playback,
          useValue: { nowRef: signal(null), nowMine: signal(null), playing: signal(null), paused: signal(false), rate: signal(1) },
        },
        { provide: Recorder, useValue: { owner: signal(null), elapsed: signal(0), warm() {} } },
        { provide: WordPractice, useValue: {} },
      ],
    });
    // the screen alone: the sidebar, waveform and cards around it have their own state
    TestBed.overrideComponent(Practice, { set: { imports: [], schemas: [NO_ERRORS_SCHEMA] } });
    Element.prototype.scrollIntoView = () => {};
  });

  /** render the screen and attach it, so the caption can be read from the document */
  async function render() {
    const fixture = TestBed.createComponent(Practice);
    document.body.append(fixture.nativeElement);
    await fixture.whenStable();
    return fixture;
  }

  afterEach(() => document.body.replaceChildren());

  it('describes the try shown', async () => {
    await render();
    expect(caption()).toMatch(/^Your take· 2.0 s · try 1/);
  });

  it('says why a take failed, though the try before it is still shown', async () => {
    const fixture = await render();
    session.error.set('Nothing was heard in the recording. Is the microphone on?');
    await fixture.whenStable();
    expect(caption()).toBe('Nothing was heard in the recording. Is the microphone on?');
  });
});
