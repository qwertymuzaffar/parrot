import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Library } from '../core/library';
import { TextItem } from '../core/models';
import { Recorder } from '../core/recorder';
import { Session } from '../core/session';
import { Talking } from '../core/talking';
import { Home } from './home';

describe('leaving the home screen and coming back', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: Library,
          useValue: {
            texts: signal<TextItem[]>([]),
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

  afterEach(() => document.body.replaceChildren());

  /** Home as the window shows it: made anew every time the view comes back to it */
  async function show() {
    const fixture = TestBed.createComponent(Home);
    document.body.append(fixture.nativeElement);
    await fixture.whenStable();
    return fixture;
  }

  const type = (selector: string, value: string) => {
    const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    field.value = value;
    field.dispatchEvent(new Event('input'));
  };
  const column = () => document.querySelector<HTMLElement>('.right')!;

  it('keeps the text being written, the way to practise it, and how far the texts were scrolled', async () => {
    const first = await show();
    type('.compose #title', 'Interview: about me');
    type('.compose textarea', 'Hi, I am Sam. I build apps.');
    document.querySelector<HTMLButtonElement>('.compose .modes button[aria-pressed="false"]')!.click();
    column().scrollTop = 1200;
    column().dispatchEvent(new Event('scroll'));
    TestBed.tick();
    // a text opened: the window shows the practice screen in Home's place
    first.destroy();
    document.body.replaceChildren();

    await show();
    expect([
      document.querySelector<HTMLInputElement>('.compose #title')!.value,
      document.querySelector<HTMLTextAreaElement>('.compose textarea')!.value,
      document.querySelector('.compose .modes button[aria-pressed="true"] b')!.textContent,
      column().scrollTop,
    ]).toEqual(['Interview: about me', 'Hi, I am Sam. I build apps.', 'Whole text', 1200]);
  });
});
