import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Library } from '../core/library';
import { TextItem } from '../core/models';
import { Recorder } from '../core/recorder';
import { Session } from '../core/session';
import { Talking } from '../core/talking';
import { Home } from './home';

const text: TextItem = {
  id: 'abcdef0123',
  title: 'My introduction',
  text: 'Hello there. How are you?',
  words: 5,
  created: '2026-10-22T10:00:00Z',
  opened: '2026-10-23T10:00:00Z',
  mode: 'sentences',
  practised: 0,
  average: null,
  scores: {},
};

describe('deleting a text on the home screen', () => {
  let texts: ReturnType<typeof signal<TextItem[]>>;
  let opened: string[];
  let deleted: () => void;
  let fixture: ReturnType<typeof TestBed.createComponent<Home>>;

  beforeEach(async () => {
    texts = signal([text]);
    opened = [];
    TestBed.configureTestingModule({
      providers: [
        {
          provide: Library,
          useValue: {
            texts,
            error: signal(null),
            activity: signal(null),
            loaded: signal(true),
            engineState: signal('ready'),
            // the engine takes a while to move the text to the trash
            remove: (id: string) =>
              new Promise<void>((resolve) => (deleted = () => resolve(texts.update((list) => list.filter((item) => item.id !== id))))),
          },
        },
        { provide: Session, useValue: { open: (id: string) => void opened.push(id), opening: signal(null) } },
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
    document.body.append(fixture.nativeElement);
    await fixture.whenStable();
  });

  afterEach(() => document.body.replaceChildren());

  const card = () => document.querySelector<HTMLElement>('.card.text');
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('.card.text button')].find(
      (each) => each.getAttribute('aria-label') === label || each.textContent!.trim() === label,
    );

  it("doesn't open the text, from its card or Continue, while its delete is with the engine", async () => {
    button('Delete')!.click();
    TestBed.tick();
    button('Delete')!.click();
    TestBed.tick();
    card()!.click();
    card()!.querySelector<HTMLButtonElement>('.open')!.click();
    document.querySelector<HTMLButtonElement>('.resume')!.click();
    expect(opened).toEqual([]);
    expect(card()!.classList).toContain('deleting');
    expect(card()!.textContent).toContain('Moving it to the trash…');
    expect([button('Rename'), button('Delete')]).toEqual([undefined, undefined]);

    deleted();
    await fixture.whenStable();
    expect([card(), document.querySelector('.resume')]).toEqual([null, null]);
  });

  it('opens again if the engine keeps it', async () => {
    TestBed.inject(Library).remove = async () => undefined;
    button('Delete')!.click();
    TestBed.tick();
    button('Delete')!.click();
    await fixture.whenStable();
    expect(card()!.classList).not.toContain('deleting');
    card()!.click();
    expect(opened).toEqual([text.id]);
  });
});
