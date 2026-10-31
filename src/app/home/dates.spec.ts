import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Library } from '../core/library';
import { TextItem } from '../core/models';
import { Recorder } from '../core/recorder';
import { Session } from '../core/session';
import { splitText } from '../core/split';
import { Talking } from '../core/talking';
import { HomeState } from './home-state';
import { Home } from './home';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

/** A text opened (or, never opened, added) `days` ago. */
const text = (id: string, title: string, days: number, opened: boolean): TextItem => ({
  id,
  title,
  text: `${title}. It is a short text.`,
  words: 7,
  created: ago(opened ? days + 1 : days),
  opened: opened ? ago(days) : null,
  mode: 'whole',
  practised: 0,
  average: null,
  scores: {},
});

const TEXTS = [
  text('a1b2c3d4e5', 'Opened now', 0, true),
  text('b1b2c3d4e5', 'Added yesterday', 1.2, false),
  text('c1b2c3d4e5', 'Opened ten days ago', 10, true),
  text('d1b2c3d4e5', 'Added a month ago', 31, false),
];

describe("a card's date on the home screen", () => {
  let fixture: ReturnType<typeof TestBed.createComponent<Home>>;

  beforeEach(async () => {
    for (const each of TEXTS) await splitText(each.text, each.mode);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: Library,
          useValue: {
            texts: signal(TEXTS),
            error: signal(null),
            activity: signal(null),
            loaded: signal(true),
            engineState: signal('ready'),
          },
        },
        { provide: Session, useValue: { opening: signal(null) } },
        {
          provide: Talking,
          useValue: {
            state: signal('idle'),
            failure: signal(null),
            stopReason: signal(null),
            unfinished: signal(null),
            prompts: signal(null),
            prompt: signal(null),
          },
        },
        { provide: Recorder, useValue: { owner: signal(null) } },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.inject(HomeState).draft.set('');
  });

  const dates = () =>
    [...fixture.nativeElement.querySelectorAll('.texts li.text .meta')].map((meta) => meta.textContent.split('·').at(-1).trim());

  it('says today, yesterday, or the day and month in the language of the computer', () => {
    const short = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    fixture = TestBed.createComponent(Home);
    fixture.detectChanges();
    expect(dates()).toEqual(['today', 'yesterday', short(TEXTS[2].opened!), short(TEXTS[3].created)]);
  });

  it('does not make a date format for each card every time Home is checked, as a big library made Home slow', () => {
    // each call makes a formatter of its own: about 30 ms per 1,000 cards, on every key typed and every return to Home
    const perCall = vi.spyOn(Date.prototype, 'toLocaleDateString');
    fixture = TestBed.createComponent(Home);
    fixture.detectChanges();
    // a key typed in the new text checks Home again, every card with it
    for (const typed of ['H', 'He', 'Hel']) {
      TestBed.inject(HomeState).draft.set(typed);
      fixture.detectChanges();
    }
    expect([dates().length, perCall.mock.calls.length]).toEqual([4, 0]);
  });
});
