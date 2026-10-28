import { NO_ERRORS_SCHEMA, signal, WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Attempt, Part } from '../core/models';
import { Playback } from '../core/playback';
import { Recorder } from '../core/recorder';
import { Session } from '../core/session';
import { Names } from '../core/names';
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
    checkingText: signal(false),
    loading: signal(false),
    recording: signal(false),
    error: signal<string | null>(null),
    selected: signal<number | null>(null),
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
        { provide: Names, useValue: { has: (word: string) => word === 'Muzaffar' } },
        {
          provide: Playback,
          useValue: {
            nowRef: signal(null),
            nowMine: signal(null),
            playing: signal<string | null>(null),
            paused: signal(false),
            rate: signal(1),
            voiceMissing: signal(false),
          },
        },
        { provide: Recorder, useValue: { owner: signal(null), elapsed: signal(0), warm() {} } },
        { provide: WordPractice, useValue: { checking: signal(false) } },
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
    expect([!!document.querySelector('.card.score'), document.querySelector('.heard-line')?.textContent]).toEqual([
      true,
      'HeardHow are you?',
    ]);
  });

  it('shows nothing of the try before while a new take is scored', async () => {
    const fixture = await render();
    session.selected.set(1);
    session.checking.set(true);
    await fixture.whenStable();
    expect(caption()).toBe('Listening to your take…');
    const cards = [...document.querySelectorAll('.cards > *')].map((card) => card.className.replace(/ng-\S+/g, '').trim());
    expect([cards, document.querySelector('.heard-line'), document.querySelector('.w.sel')]).toEqual([
      ['card hint-card listening', 'keys'],
      null,
      null,
    ]);
  });

  // not the caption, but the screen as it renders here: the dock under it
  it("keeps Stop's room in the dock while nothing plays, so the record button doesn't move when it shows", async () => {
    const fixture = await render();
    const playback = TestBed.inject(Playback) as unknown as { playing: WritableSignal<string | null> };
    const stop = document.querySelector('.dock .stop')!;
    expect(stop.classList.contains('idle')).toBe(true);
    playback.playing.set('ref');
    await fixture.whenStable();
    expect([document.querySelector('.dock .stop'), stop.classList.contains('idle')]).toEqual([stop, false]);
  });
});
