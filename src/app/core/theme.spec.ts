import { TestBed } from '@angular/core/testing';
import { Theme } from './theme';

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
