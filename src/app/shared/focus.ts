import { afterNextRender, Injector } from '@angular/core';

/** whether the last thing the user did was on the keyboard (a key) rather than the pointer (a click) */
let keyboard = false;
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', () => (keyboard = true), true);
  document.addEventListener('pointerdown', () => (keyboard = false), true);
}

/** Focus is on nothing: the page has it, or the button that had it was disabled (the browser drops it to the page). */
function lost(active: Element | null) {
  return !active || active === document.body || (active instanceof HTMLButtonElement && active.disabled);
}

/** Whether keyboard focus is the block's to put back when the block is redrawn: it is in `block`, or it fell to the page
 * from there on the keyboard user's last step (a button pressed went, or was disabled). Focus anywhere else is the
 * user's, and stays where it is; so does a click's, which leaves focus on the page without a button of its own. */
export function focusIn(block: Element | null | undefined) {
  const active = document.activeElement;
  if (block && active && active !== document.body && block.contains(active)) return true;
  return keyboard && lost(active);
}

/** Once the screen is redrawn, put focus on `target`, if it fell to the page with what was replaced: a keyboard user
 * goes on from there, and a screen reader says where they are, instead of starting again from the top of the window. */
export function refocus(target: () => HTMLElement | null | undefined, injector: Injector) {
  afterNextRender(
    () => {
      if (lost(document.activeElement)) target()?.focus();
    },
    { injector },
  );
}
