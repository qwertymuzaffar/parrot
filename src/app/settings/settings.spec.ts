import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Engine } from '../core/engine';
import { Sound } from '../core/sound';
import { Release, Updates } from '../core/updates';
import { Settings } from './settings';

/** Updates as the desktop app has them, without Tauri: the version, and a latest release a test sets. */
class FakeUpdates extends Updates {
  answer: () => Promise<Release> = async () => ({ version: '0.2.0', url: 'https://github.com/qwertymuzaffar/parrot/releases/tag/v0.2.0' });
  asked = 0;
  opened: string[] = [];

  override async current() {
    return '0.2.0';
  }
  override latest() {
    this.asked++;
    return this.answer();
  }
  override async open(url: string) {
    this.opened.push(url);
  }
}

describe('Settings: check for updates', () => {
  let updates: FakeUpdates;

  async function settings() {
    TestBed.configureTestingModule({
      providers: [
        { provide: Updates, useValue: updates },
        { provide: Engine, useValue: { info: async () => ({ data: '/data', models: { whisper: true, aligner: true }, sizes: {} }) } },
        { provide: Sound, useValue: { voices: signal([]), voiceName: signal(''), setVoice() {}, speak() {} } },
      ],
    });
    const fixture = TestBed.createComponent(Settings);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    const button = () => [...element.querySelectorAll('button')].find((each) => /Check/.test(each.textContent!))!;
    const status = () => element.querySelector('[role=status]')!.textContent!.replace(/\s+/g, ' ').trim();
    const click = async (target: HTMLElement) => {
      target.click();
      await fixture.whenStable();
    };
    return { element, button, status, click };
  }

  beforeEach(() => (updates = new FakeUpdates()));

  it('shows the version and asks nothing until the button is clicked', async () => {
    const { element, button, status } = await settings();
    expect(element.querySelector('.update')!.textContent).toContain('Parrot 0.2.0');
    expect(button().textContent!.trim()).toBe('Check for updates');
    expect(status()).toBe('Asks GitHub for the latest version, only when you click.');
    expect(updates.asked).toBe(0);
  });

  it('says when this is the latest version', async () => {
    const { button, status, click } = await settings();
    await click(button());
    expect(updates.asked).toBe(1);
    expect(status()).toBe('You have the latest version (0.2.0).');
  });

  it('links to a newer release, opened in the system browser', async () => {
    updates.answer = async () => ({ version: '0.10.0', url: 'https://github.com/qwertymuzaffar/parrot/releases/tag/v0.10.0' });
    const { element, button, status, click } = await settings();
    await click(button());
    expect(status()).toBe('Parrot 0.10.0 is out. Download it');
    const link = element.querySelector<HTMLAnchorElement>('[role=status] a')!;
    expect([link.href, link.target, link.rel]).toEqual([
      'https://github.com/qwertymuzaffar/parrot/releases/tag/v0.10.0',
      '_blank',
      'noopener',
    ]);
    await click(link);
    expect(updates.opened).toEqual(['https://github.com/qwertymuzaffar/parrot/releases/tag/v0.10.0']);
  });

  it('says why when GitHub cannot be asked, and can ask again', async () => {
    updates.answer = () => Promise.reject("Couldn't reach GitHub. Are you online?");
    const { button, status, click } = await settings();
    await click(button());
    expect(status()).toBe("Couldn't reach GitHub. Are you online?");
    updates.answer = async () => ({ version: '0.2.0', url: '' });
    await click(button());
    expect(status()).toBe('You have the latest version (0.2.0).');
  });
});
