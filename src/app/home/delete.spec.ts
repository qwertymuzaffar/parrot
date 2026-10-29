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

  it('asks its question of a screen reader on Keep and Delete too', async () => {
    button('Delete')!.click();
    await fixture.whenStable();
    /** what a screen reader adds to a button's name: the text of what it is described by */
    const description = (target: HTMLElement) =>
      (target.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent!.trim())
        .join(' ');
    const asked = 'Move it and its recordings to the trash? Parrot erases them for good after 30 days.';
    expect(description(button('Keep')!)).toBe(asked);
    expect(description(button('Delete')!)).toBe(asked);
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

  /** Focus as a keyboard user has it: keys pressed (Enter on a button), the card's button going with what it replaced. */
  describe('keyboard focus', () => {
    const enter = async (target: HTMLElement) => {
      target.focus();
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      target.click();
      await fixture.whenStable();
    };
    const focused = () => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent!.trim();
    /** the card of a title, and its button labelled so */
    const on = (title: string, label: string) =>
      [
        ...[...document.querySelectorAll('.card.text')]
          .find((each) => each.querySelector('h3')?.textContent!.trim() === title)!
          .querySelectorAll<HTMLButtonElement>('button'),
      ].find((each) => each.getAttribute('aria-label') === label || each.textContent!.trim() === label)!;
    const titled = (title: string, id: string): TextItem => ({ ...text, id, title, text: `${title}. Said out loud.`, opened: null });

    it('goes to Keep when asked whether to delete, and back to Delete after it', async () => {
      await enter(button('Delete')!);
      expect(focused()).toBe('Keep');
      await enter(button('Keep')!);
      expect(focused()).toBe('Delete');
      expect(document.activeElement).toBe(button('Delete'));
    });

    it('goes on to the next card after a delete, else the one before, else the heading of the texts', async () => {
      texts.set([titled('First', 'a1'), titled('Second', 'b2'), titled('Third', 'c3')]);
      await fixture.whenStable();
      const remove = async (title: string) => {
        await enter(on(title, 'Delete'));
        await enter(on(title, 'Delete'));
        // nothing to press on the card while the engine moves it to the trash
        expect(document.activeElement).toBe(document.body);
        deleted();
        await fixture.whenStable();
      };
      await remove('Second');
      expect(focused()).toBe('Third');
      await remove('Third');
      expect(focused()).toBe('First');
      await remove('First');
      expect(focused()).toBe('Your texts');
    });

    it('goes back to Delete if the engine keeps the text', async () => {
      TestBed.inject(Library).remove = async () => undefined;
      await enter(button('Delete')!);
      await enter(button('Delete')!);
      expect(document.activeElement).toBe(button('Delete'));
    });

    it('is not put on the card for a click, which left it on the page', async () => {
      button('Delete')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      button('Delete')!.click();
      await fixture.whenStable();
      expect(document.activeElement).toBe(document.body);
    });
  });
});
