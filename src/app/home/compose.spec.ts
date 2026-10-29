import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Library } from '../core/library';
import { Mode, TextItem } from '../core/models';
import { Recorder } from '../core/recorder';
import { Session } from '../core/session';
import { Talking } from '../core/talking';
import { Home } from './home';

/** The library as the home screen reads it: no texts yet, the engine up. */
function emptyLibrary() {
  return {
    texts: signal<TextItem[]>([]),
    error: signal<string | null>(null),
    activity: signal(null),
    loaded: signal(true),
    engineState: signal('ready'),
  };
}

describe('a new text on the home screen', () => {
  let library: ReturnType<typeof emptyLibrary>;
  /** why the engine refuses the next text added; null: it adds it */
  let refusal: string | null;
  let adding: Promise<unknown>;

  beforeEach(async () => {
    refusal = null;
    library = emptyLibrary();
    const session = {
      add: (text: string, title: string, mode: Mode) =>
        (adding = Promise.resolve().then(() => {
          library.error.set(refusal);
          return refusal ? null : { id: 'abcdef0123', text, title, mode };
        })),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: Library, useValue: library },
        { provide: Session, useValue: session },
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
    const fixture = TestBed.createComponent(Home);
    document.body.append(fixture.nativeElement);
    await fixture.whenStable();
  });

  afterEach(() => document.body.replaceChildren());

  const textarea = () => document.querySelector<HTMLTextAreaElement>('.compose textarea')!;
  const shownError = () => document.querySelector('.compose .error')?.textContent?.trim() ?? null;

  /** paste a text, press Start, and let the screen catch up with the engine's answer */
  async function start(text: string) {
    textarea().value = text;
    textarea().dispatchEvent(new Event('input'));
    TestBed.tick();
    document.querySelector<HTMLButtonElement>('.compose .go .btn')!.click();
    await adding;
    await new Promise((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
  }

  it('keeps the text pasted, and says why, when the engine would not add it', async () => {
    refusal = 'Could not save the text: the disk is full.';
    await start('Hello there. How are you?');
    expect([textarea().value, shownError()]).toEqual(['Hello there. How are you?', 'Could not save the text: the disk is full.']);
  });

  it('clears the text once it is added', async () => {
    await start('Hello there. How are you?');
    expect([textarea().value, shownError()]).toEqual(['', null]);
  });

  const hint = () => document.querySelector('.compose .go .hint')!.textContent!.replace(/\s+/g, ' ').trim();
  const startButton = () => document.querySelector<HTMLButtonElement>('.compose .go .btn')!;

  it('counts only words with a letter or a digit, and one word as one', () => {
    for (const [text, counted] of [
      ['Hello', '1 word ·'],
      ['... !!! Hello, 42 ??? --- ***', '2 words ·'],
    ]) {
      textarea().value = text;
      textarea().dispatchEvent(new Event('input'));
      TestBed.tick();
      expect([hint().startsWith(counted), startButton().disabled]).toEqual([true, false]);
    }
  });

  it('does not take a text with no words, as it does not take an empty one', async () => {
    for (const wordless of ['\u200B', '... !!! ??? --- ***']) {
      await start(wordless);
      expect([hint(), startButton().disabled, textarea().value]).toEqual(['Parrot reads it to you, then listens to you.', true, wordless]);
    }
  });

  it('does not take a text in another alphabet, and says Parrot checks English only', async () => {
    for (const foreign of ['Привет, как дела?', '東京へ行きます']) {
      await start(foreign);
      expect([hint(), startButton().disabled, textarea().value]).toEqual(['Parrot checks English only', true, foreign]);
    }
    // a name in another alphabet in an English text is fine
    await start('We said Привет in Tokyo.');
    expect([textarea().value, shownError()]).toEqual(['', null]);
  });
});
