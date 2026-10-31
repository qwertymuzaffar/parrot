import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { IN_APP } from './engine';

/** The Practice menu's items: each does what its key does on the practice screen. */
export type PracticeAction = 'listen' | 'record' | 'mine' | 'previous' | 'next' | 'stop';
export const PRACTICE_ACTIONS: readonly PracticeAction[] = ['listen', 'record', 'mine', 'previous', 'next', 'stop'];
/** What the app menu (src-tauri/src/menu.rs) asks of the window, by the id of the item chosen. */
export type MenuAction = 'new' | 'settings' | 'find' | 'home' | PracticeAction;

/** The app menu's side in the window: an item chosen comes here, and whoever acts on it (the window, the practice
 * screen) listens; the screen shown goes back to the menu, which enables the items that act on it. In a plain browser
 * there is no menu: nothing comes, and nothing is told. */
@Injectable({ providedIn: 'root' })
export class Menu {
  private readonly handlers = new Set<(action: MenuAction) => void>();

  /** Take the menu's events, inside the desktop app. */
  async connect() {
    if (!IN_APP) return;
    await listen<MenuAction>('menu', (event) => this.fire(event.payload));
  }

  /** Act on the items chosen; the function given back stops it. */
  on(handler: (action: MenuAction) => void) {
    this.handlers.add(handler);
    return () => void this.handlers.delete(handler);
  }

  /** An item chosen (or, in a test, as if one were). */
  fire(action: MenuAction) {
    for (const handler of [...this.handlers]) handler(action);
  }

  /** The screen the window shows: the menu enables the items that act on it. */
  screen(name: string) {
    if (IN_APP) void invoke('set_screen', { screen: name }).catch(() => undefined);
  }
}
