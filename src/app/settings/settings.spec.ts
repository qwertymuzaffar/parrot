import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Engine, EngineError } from '../core/engine';
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
  let names: string[] = [];

  async function settings() {
    TestBed.configureTestingModule({
      providers: [
        { provide: Updates, useValue: updates },
        {
          provide: Engine,
          useValue: {
            info: async () => ({ data: '/data', models: { whisper: true, aligner: true }, sizes: {} }),
            names: async () => names,
            setName: async (word: string, name: boolean) => (names = name ? [...names, word] : names.filter((kept) => kept !== word)),
          },
        },
        { provide: Sound, useValue: { voices: signal([]), voiceName: signal(''), canSpeak: signal(true), setVoice() {}, speak() {} } },
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

  beforeEach(() => {
    updates = new FakeUpdates();
    names = [];
  });

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

  it('lists the names, and removes one', async () => {
    names = ['muzaffar', 'tashkent'];
    const { element, click } = await settings();
    const listed = () => [...element.querySelectorAll('.names li')].map((item) => item.textContent!.trim());
    expect(listed()).toEqual(['muzaffar', 'tashkent']);
    await click(element.querySelector<HTMLElement>('[aria-label="Remove tashkent from the names"]')!);
    expect(listed()).toEqual(['muzaffar']);
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

describe('Settings when the engine fails', () => {
  async function settings(engine: { info: () => Promise<unknown>; trashSize: () => Promise<number> }) {
    TestBed.configureTestingModule({
      providers: [
        { provide: Updates, useValue: new FakeUpdates() },
        { provide: Engine, useValue: { ...engine, names: async () => [] } },
        { provide: Sound, useValue: { voices: signal([]), voiceName: signal(''), canSpeak: signal(true), setVoice() {}, speak() {} } },
      ],
    });
    const fixture = TestBed.createComponent(Settings);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    /** a section, by its heading: each of its lines and buttons */
    const section = (heading: string) => {
      const found = [...element.querySelectorAll('section')].find(
        (each) => each.querySelector('.eyebrow')!.textContent!.trim() === heading,
      );
      return found ? [...found.querySelectorAll('p, button')].map((each) => each.textContent!.replace(/\s+/g, ' ').trim()) : null;
    };
    const click = async (text: string) => {
      [...element.querySelectorAll('button')].find((each) => each.textContent!.trim() === text)!.click();
      await fixture.whenStable();
    };
    return { element, section, click };
  }

  const info = async () => ({ data: '/data', models: { whisper: true, aligner: true }, sizes: {} });
  const fails = () => Promise.reject(new EngineError('The speech engine is not running.'));

  afterEach(() => localStorage.clear());

  it('says the speech engine is not answering, and the rest still works', async () => {
    const { element, section, click } = await settings({ info: fails, trashSize: async () => 2_000_000 });
    expect(section('Speech engine')).toEqual(['The speech engine is not answering.']);
    expect(section('Texts and recordings')).toEqual([
      'A deleted text stays in the trash for 30 days, then Parrot erases it for good.',
      'Open data folder',
      'Empty trash · 2 MB',
    ]);
    await click('Dark');
    expect(element.querySelector('.seg button.on')!.textContent!.trim()).toBe('Dark');
  });

  it('keeps the data folder button when the trash cannot be measured, and says so', async () => {
    const { section } = await settings({ info, trashSize: fails });
    expect(section('Texts and recordings')).toEqual([
      'Kept on this computer, in/data',
      'Open data folder',
      "Couldn't tell what is in the trash.",
    ]);
  });
});
