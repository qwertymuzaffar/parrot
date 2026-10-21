import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Library } from '../core/library';
import { TextItem } from '../core/models';
import { Session } from '../core/session';
import { Home } from './home';

describe('the home screen when the texts cannot be loaded', () => {
  /** render the home screen with the engine failing as given */
  async function render(error: string) {
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
    await fixture.whenStable();
    return (fixture.nativeElement as HTMLElement).querySelector('.down')!.textContent!.replace(/\s+/g, ' ').trim();
  }

  it('gives the engine’s own reason (there is nothing for the user to start)', async () => {
    const shown = await render('Could not open the database: disk I/O error');
    expect(shown).toContain('Could not open the database: disk I/O error');
    expect(shown).not.toContain('python');
  });
});
