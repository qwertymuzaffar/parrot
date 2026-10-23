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
  opened: null,
  mode: 'sentences',
  practised: 0,
  average: null,
  scores: {},
};

describe('renaming a text on the home screen', () => {
  let renamed: [string, string][];

  beforeEach(async () => {
    renamed = [];
    TestBed.configureTestingModule({
      providers: [
        {
          provide: Library,
          useValue: {
            texts: signal([text]),
            error: signal(null),
            activity: signal(null),
            loaded: signal(true),
            engineState: signal('ready'),
            rename: async (id: string, title: string) => void renamed.push([id, title]),
          },
        },
        { provide: Session, useValue: { open: () => undefined } },
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

  const button = (label: string) => document.querySelector<HTMLButtonElement>(`.card.text [aria-label="${label}"]`);
  const field = () => document.querySelector<HTMLInputElement>('.card.text input')!;

  it('shows a button to save the title in place of the pencil, which saves what was typed', async () => {
    button('Rename')!.click();
    TestBed.tick();
    expect([button('Rename'), button('Delete'), button('Save the title')].map((b) => !!b)).toEqual([false, false, true]);

    field().value = 'Interview answer';
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button('Save the title')!.dispatchEvent(press);
    // pressing it leaves the field focused, so it isn't saved on blur before the click
    expect(press.defaultPrevented).toBe(true);
    button('Save the title')!.click();
    await Promise.resolve();
    TestBed.tick();
    expect(renamed).toEqual([['abcdef0123', 'Interview answer']]);
    expect([!!button('Rename'), !!button('Save the title')]).toEqual([true, false]);
  });
});
