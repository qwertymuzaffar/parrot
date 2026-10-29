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

  it('says why the release did not open in the browser, and where it is', async () => {
    const url = 'https://github.com/qwertymuzaffar/parrot/releases/tag/v0.10.0';
    updates.answer = async () => ({ version: '0.10.0', url });
    updates.open = () => Promise.reject(`Parrot couldn't open your browser; the page is at ${url}`);
    const { element, button, click } = await settings();
    await click(button());
    const alert = () => element.querySelector('[role=alert]')?.textContent!.trim();
    expect(alert()).toBeUndefined();
    await click(element.querySelector<HTMLAnchorElement>('[role=status] a')!);
    expect(alert()).toBe(`Parrot couldn't open your browser; the page is at ${url}`);
    // opened the next time, or checked again: the failure goes
    updates.open = async () => {};
    await click(element.querySelector<HTMLAnchorElement>('[role=status] a')!);
    expect(alert()).toBeUndefined();
  });

  it('lists the names, and removes one', async () => {
    names = ['muzaffar', 'tashkent'];
    const { element, click } = await settings();
    const listed = () => [...element.querySelectorAll('.names li')].map((item) => item.textContent!.trim());
    expect(listed()).toEqual(['muzaffar', 'tashkent']);
    await click(element.querySelector<HTMLElement>('[aria-label="Remove tashkent from the names"]')!);
    expect(listed()).toEqual(['muzaffar']);
  });

  it('keeps focus in the names as one is removed: the next one, else the one before, else their heading', async () => {
    names = ['alex', 'muzaffar', 'tashkent'];
    const { element, click } = await settings();
    document.body.append(element);
    // open: what is in a closed dialog takes no focus
    element.querySelector('dialog')!.setAttribute('open', '');
    const remove = async (name: string) => {
      const button = element.querySelector<HTMLElement>(`[aria-label="Remove ${name} from the names"]`)!;
      button.focus();
      await click(button);
    };
    const focused = () => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent;
    await remove('muzaffar');
    expect(focused()).toBe('Remove tashkent from the names');
    await remove('tashkent');
    expect(focused()).toBe('Remove alex from the names');
    await remove('alex');
    expect(focused()).toBe('Names');
    element.remove();
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
  async function settings(engine: {
    info: () => Promise<unknown>;
    trashSize: () => Promise<number>;
    openDataFolder?: () => Promise<void>;
  }) {
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

  it('says out loud why the data folder did not open', async () => {
    const said = "Parrot couldn't open the data folder; it is at the path shown above";
    const { element, click } = await settings({
      info,
      trashSize: async () => 0,
      openDataFolder: () => Promise.reject(new EngineError(said)),
    });
    await click('Open data folder');
    expect(element.querySelector('[role=alert]')!.textContent!.trim()).toBe(said);
  });
});

describe('Settings: opening again', () => {
  // jsdom has no modal dialogs
  const showModal = HTMLDialogElement.prototype.showModal;
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true;
    };
  });
  afterAll(() => {
    HTMLDialogElement.prototype.showModal = showModal;
  });

  it('keeps the engine and trash lines while they are asked again, then shows the new answers', async () => {
    let answer = () => {};
    let bytes = 2_000_000;
    const later = () => new Promise<void>((resolve) => (answer = resolve));
    let waiting = Promise.resolve();
    TestBed.configureTestingModule({
      providers: [
        { provide: Updates, useValue: new FakeUpdates() },
        {
          provide: Engine,
          useValue: {
            info: async () => {
              await waiting;
              return { data: '/data', models: { whisper: true, aligner: true }, sizes: {} };
            },
            trashSize: async () => {
              await waiting;
              return bytes;
            },
            names: async () => [],
          },
        },
        { provide: Sound, useValue: { voices: signal([]), voiceName: signal(''), canSpeak: signal(true), setVoice() {}, speak() {} } },
      ],
    });
    const fixture = TestBed.createComponent(Settings);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    const lines = () =>
      [...element.querySelectorAll('section')]
        .filter((each) => ['Speech engine', 'Texts and recordings'].includes(each.querySelector('.eyebrow')!.textContent!.trim()))
        .flatMap((each) => [...each.querySelectorAll('p, button')].map((line) => line.textContent!.replace(/\s+/g, ' ').trim()));
    const shown = [
      'Ready, on this computer',
      'Kept on this computer, in/data',
      'A deleted text stays in the trash for 30 days, then Parrot erases it for good.',
      'Open data folder',
      'Empty trash · 2 MB',
    ];
    expect(lines()).toEqual(shown);

    // opened with the engine slow to answer: everything stays as it was
    waiting = later();
    bytes = 5_000_000;
    fixture.componentInstance.open();
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
    expect(lines()).toEqual(shown);

    answer();
    await fixture.whenStable();
    expect(lines()).toEqual([...shown.slice(0, -1), 'Empty trash · 5 MB']);
  });
});

describe('Settings: emptying the trash, on the keyboard', () => {
  let emptied: () => Promise<number>;

  async function settings() {
    TestBed.configureTestingModule({
      providers: [
        { provide: Updates, useValue: new FakeUpdates() },
        {
          provide: Engine,
          useValue: {
            info: async () => ({ data: '/data', models: { whisper: true, aligner: true }, sizes: {} }),
            names: async () => [],
            trashSize: async () => 2_000_000,
            emptyTrash: () => emptied(),
          },
        },
        { provide: Sound, useValue: { voices: signal([]), voiceName: signal(''), canSpeak: signal(true), setVoice() {}, speak() {} } },
      ],
    });
    const fixture = TestBed.createComponent(Settings);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    document.body.append(element);
    // open: what is in a closed dialog takes no focus
    element.querySelector('dialog')!.setAttribute('open', '');
    const button = (text: string) => [...element.querySelectorAll('button')].find((each) => each.textContent!.trim() === text)!;
    /** Enter on a focused button: a key, then the click it makes */
    const enter = async (target: HTMLElement) => {
      target.focus();
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      target.click();
      await fixture.whenStable();
    };
    return { element, button, enter, update: () => fixture.whenStable() };
  }
  const focused = () => document.activeElement?.textContent!.replace(/\s+/g, ' ').trim();

  beforeEach(() => (emptied = async () => 0));
  afterEach(() => document.body.replaceChildren());

  it('goes to Keep when asked whether to empty it, and back to Empty trash after it', async () => {
    const { button, enter } = await settings();
    await enter(button('Empty trash · 2 MB'));
    expect(focused()).toBe('Keep');
    await enter(button('Keep'));
    expect(focused()).toBe('Empty trash · 2 MB');
  });

  it('stays on the trash once it is emptied, which says so and asks nothing more', async () => {
    const { button, enter } = await settings();
    await enter(button('Empty trash · 2 MB'));
    await enter(button('Empty'));
    expect(focused()).toBe('The trash is empty');
    expect(button('The trash is empty').getAttribute('aria-disabled')).toBe('true');
    // pressed again, it does nothing: there is nothing to erase
    await enter(button('The trash is empty'));
    expect(button('Keep')).toBeUndefined();
    expect(focused()).toBe('The trash is empty');
  });

  it('asks its question of a screen reader on Keep and Empty too', async () => {
    const { button, enter } = await settings();
    await enter(button('Empty trash · 2 MB'));
    /** what a screen reader adds to a button's name: the text of what it is described by */
    const description = (target: HTMLElement) =>
      (target.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent!.trim())
        .join(' ');
    expect(description(button('Keep'))).toBe('Erase 2 MB of deleted texts for good?');
    expect(description(button('Empty'))).toBe('Erase 2 MB of deleted texts for good?');
  });

  it('goes back to Empty trash when it could not be emptied, to try again', async () => {
    emptied = () => Promise.reject(new EngineError('The speech engine is not running.'));
    const { element, button, enter } = await settings();
    await enter(button('Empty trash · 2 MB'));
    await enter(button('Empty'));
    expect(element.textContent).toContain('The speech engine is not running.');
    expect(focused()).toBe('Empty trash · 2 MB');
  });

  it('is not put on the trash for a click, which left it on the page', async () => {
    const { button, update } = await settings();
    button('Empty trash · 2 MB').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    button('Empty trash · 2 MB').click();
    await update();
    expect(button('Keep')).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });
});
