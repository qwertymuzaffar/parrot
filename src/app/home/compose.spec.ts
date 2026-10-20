import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Library } from '../core/library';
import { Mode, TextItem } from '../core/models';
import { Session } from '../core/session';
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
});
