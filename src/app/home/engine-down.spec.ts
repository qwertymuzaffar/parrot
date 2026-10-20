import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Library } from '../core/library';
import { TextItem } from '../core/models';
import { Session } from '../core/session';
import { Home } from './home';

describe('the home screen when the texts cannot be loaded', () => {
  /** render the home screen, in the desktop app or a plain browser, with the engine failing as given */
  async function render(inApp: boolean, error: string) {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: Library,
          useValue: {
            texts: signal<TextItem[]>([]),
            error: signal(error),
            activity: signal(null),
            loaded: signal(true),
            engineState: signal('down'),
          },
        },
        { provide: Session, useValue: {} },
      ],
    });
    const fixture = TestBed.createComponent(Home);
    fixture.componentInstance['inApp'] = inApp;
    await fixture.whenStable();
    return (fixture.nativeElement as HTMLElement).querySelector('.down')!.textContent!.replace(/\s+/g, ' ').trim();
  }

  it('in the desktop app, gives the engine’s own reason (there is nothing to start)', async () => {
    const shown = await render(true, 'Could not open the database: disk I/O error');
    expect(shown).toContain('Could not open the database: disk I/O error');
    expect(shown).not.toContain('python');
  });

  it('in a browser, says how to start the engine', async () => {
    expect(await render(false, 'The speech engine is not running.')).toContain('python engine/server.py');
  });
});
