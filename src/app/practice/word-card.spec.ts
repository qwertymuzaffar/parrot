import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Engine, EngineError } from '../core/engine';
import { Names } from '../core/names';
import { Playback } from '../core/playback';
import { Recorder } from '../core/recorder';
import { Session } from '../core/session';
import { WordPractice } from '../core/word-practice';
import { WordCard } from './word-card';

describe('the word card when the dictionary cannot be read', () => {
  let names: Set<string>;
  let recording: ReturnType<typeof signal<boolean>>;
  /** the engine refuses to mark a name: the list stays as it was, and says why */
  let refused: boolean;
  let nameError: ReturnType<typeof signal<string | null>>;
  let selected: ReturnType<typeof signal<number>>;

  beforeEach(() => {
    names = new Set();
    recording = signal(false);
    refused = false;
    nameError = signal(null);
    selected = signal(1);
    const named = signal(0);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: Session,
          useValue: { selected, words: signal(['Hello', 'there.', '!!!']), result: signal(null), recording: signal(false) },
        },
        // the dictionary file is missing or damaged
        { provide: Engine, useValue: { soundsLike: () => Promise.reject(new EngineError('pron: the dictionary is damaged')) } },
        {
          provide: Names,
          useValue: {
            error: nameError,
            has: (word: string) => (named(), names.has(word)),
            set: async (word: string, name: boolean) => {
              if (refused) return nameError.set('the speech engine is not running');
              if (name) names.add(word);
              else names.delete(word);
              named.update((count) => count + 1);
            },
          },
        },
        { provide: Playback, useValue: {} },
        { provide: Recorder, useValue: { owner: signal(null), elapsed: signal(0), warm() {}, cool() {} } },
        {
          provide: WordPractice,
          useValue: {
            tries: signal([]),
            latest: signal(null),
            checking: signal(false),
            preparing: signal(false),
            recording,
            error: signal(null),
          },
        },
      ],
    });
  });

  it('says it could not look the word up, and goes on showing what changes', async () => {
    const fixture = TestBed.createComponent(WordCard);
    const card: HTMLElement = fixture.nativeElement;
    await fixture.whenStable();
    const read = (selector: string) => card.querySelector(selector)?.textContent!.replace(/\s+/g, ' ').trim();
    expect(read('.sounds .none')).toBe("Couldn't look it up. Use Hear it.");

    // the card is not stuck: ticking "A name" and recording the word still show
    card.querySelector<HTMLInputElement>('.name input')!.click();
    await fixture.whenStable();
    expect(read('.name span')).toContain('from your next reading on');
    recording.set(true);
    await fixture.whenStable();
    expect(read('.buttons')).toContain('Stop');
  });

  it('unticks "A name" again when the word could not be marked', async () => {
    refused = true;
    const fixture = TestBed.createComponent(WordCard);
    const card: HTMLElement = fixture.nativeElement;
    await fixture.whenStable();
    const box = card.querySelector<HTMLInputElement>('.name input')!;
    box.click();
    await fixture.whenStable();
    expect(card.querySelector('.name + .error')!.textContent).toContain('the speech engine is not running');
    expect([box.checked, card.querySelector('.name span')!.textContent]).toEqual([false, 'A name: never counted as misheard, in any text']);
  });

  it('heads a word of punctuation alone as it is written, and says it is not in the dictionary', async () => {
    selected.set(2);
    const fixture = TestBed.createComponent(WordCard);
    const card: HTMLElement = fixture.nativeElement;
    await fixture.whenStable();
    expect([
      card.querySelector('h2')!.textContent,
      card.getAttribute('aria-label'),
      card.querySelector('.sounds .none')?.textContent,
    ]).toEqual(['!!!', '!!!', 'Not in the dictionary. Use Hear it.']);
  });
});
