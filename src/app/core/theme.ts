import { Injectable, signal } from '@angular/core';
import { readSetting, writeSetting } from './settings';

export type ThemeChoice = 'system' | 'light' | 'dark';

/** Light, dark or as the system is: remembered on this device and set on the page as its data-theme. */
@Injectable({ providedIn: 'root' })
export class Theme {
  readonly choice = signal<ThemeChoice>(readSetting<ThemeChoice>('theme', 'system'));

  set(theme: ThemeChoice) {
    this.choice.set(theme);
    writeSetting('theme', theme);
    this.apply();
  }

  /** puts the choice on the page; 'system' leaves it to the system's colour scheme */
  apply() {
    const theme = this.choice();
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }
}
