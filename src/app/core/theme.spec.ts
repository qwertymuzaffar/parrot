import { TestBed } from '@angular/core/testing';
import { Theme } from './theme';
// public/theme.js, run from index.html before the stylesheet so a cold start paints in the chosen theme
import early from '../../../public/theme.js' with { loader: 'text' };

describe('Theme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('starts as the system theme and leaves the page to it', () => {
    const theme = TestBed.inject(Theme);
    theme.apply();
    expect(theme.choice()).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('remembers a choice and sets it on the page, until the system theme is chosen again', () => {
    const theme = TestBed.inject(Theme);
    theme.set('dark');
    expect(localStorage.getItem('parrot.theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    theme.set('system');
    expect(localStorage.getItem('parrot.theme')).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('reads the remembered choice', () => {
    localStorage.setItem('parrot.theme', 'light');
    const theme = TestBed.inject(Theme);
    theme.apply();
    expect(theme.choice()).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

describe('Theme before the app starts', () => {
  const run = () => new Function(early)();

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('sets a chosen light or dark theme on the page, as Theme does', () => {
    for (const choice of ['dark', 'light'] as const) {
      localStorage.setItem('parrot.theme', choice);
      run();
      expect(document.documentElement.getAttribute('data-theme')).toBe(choice);
      document.documentElement.removeAttribute('data-theme');
      TestBed.inject(Theme).apply();
      expect(document.documentElement.getAttribute('data-theme')).toBe(choice);
      TestBed.resetTestingModule();
    }
  });

  it('leaves the page to the system when the system theme, nothing or something else is kept', () => {
    run();
    for (const kept of ['system', '"dark"', 'blue']) {
      localStorage.setItem('parrot.theme', kept);
      run();
    }
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('leaves the page to the system when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(run).not.toThrow();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    vi.restoreAllMocks();
  });
});
