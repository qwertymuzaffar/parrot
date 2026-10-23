import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Library } from '../core/library';
import { TextItem } from '../core/models';
import { Recorder } from '../core/recorder';
import { Session } from '../core/session';
import { splitText } from '../core/split';
import { Talking } from '../core/talking';
import { Home } from './home';

const TEXTS: TextItem[] = [
  {
    id: 'a1b2c3d4e5',
    title: 'Introducing yourself',
    text: 'Hi, I am Sam. I build apps.',
    words: 7,
    created: '2026-10-20T10:00:00Z',
    opened: '2026-10-22T10:00:00Z',
    mode: 'sentences',
    practised: 0,
    average: null,
    scores: {},
  },
  {
    id: 'f6a7b8c9d0',
    title: 'A weather report',
    text: 'Rain is coming. Take an umbrella.',
    words: 6,
    created: '2026-10-21T10:00:00Z',
    opened: null,
    mode: 'whole',
    practised: 0,
    average: null,
    scores: {},
  },
];

describe('coming back to the home screen', () => {
  let texts: ReturnType<typeof signal<TextItem[]>>;
  let fixture: ReturnType<typeof TestBed.createComponent<Home>>;
  let home: HTMLElement;

  beforeEach(async () => {
    // the texts were split before: by the Home left, or by the practice screen
    for (const text of TEXTS) await splitText(text.text, text.mode);
    texts = signal(TEXTS);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: Library,
          useValue: { texts, error: signal(null), activity: signal(null), loaded: signal(true), engineState: signal('ready') },
        },
        { provide: Session, useValue: {} },
        // the Just talk card, at rest
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
    fixture = TestBed.createComponent(Home);
    home = fixture.nativeElement;
    // the first frame: nothing awaited
    fixture.detectChanges();
  });

  const shown = () => ({
    cards: [...home.querySelectorAll('.grid li.text h3')].map((title) => title.textContent!.trim()),
    resume: home.querySelector('.resume .t')?.textContent!.trim() ?? null,
    empty: !!home.querySelector('.grid .empty'),
  });

  it('shows the cards and Continue from the first frame, not “Nothing to practise yet”', () => {
    expect(shown()).toEqual({ cards: ['Introducing yourself', 'A weather report'], resume: 'Introducing yourself', empty: false });
  });

  it('keeps them while the texts load again (a new list of the same texts)', () => {
    texts.set(TEXTS.map((text) => ({ ...text })));
    TestBed.tick();
    expect(shown()).toEqual({ cards: ['Introducing yourself', 'A weather report'], resume: 'Introducing yourself', empty: false });
  });

  it('does not say there is nothing to practise while a new text is being split', async () => {
    texts.set([{ ...TEXTS[1], id: '0123456789', title: 'Something new', text: 'A text never split before.' }]);
    TestBed.tick();
    expect(shown()).toEqual({ cards: [], resume: null, empty: false });
    await fixture.whenStable();
    expect(shown()).toEqual({ cards: ['Something new'], resume: null, empty: false });
  });
});
