/** Small per-device preferences (voice, speed, theme, last place). Nothing here is needed for the app to work. */
export function readSetting<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem('parrot.' + key) as T) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeSetting(key: string, value: string) {
  try {
    localStorage.setItem('parrot.' + key, value);
  } catch {
    /* private mode or storage blocked: the setting just isn't remembered */
  }
}

export function forgetSetting(key: string) {
  try {
    localStorage.removeItem('parrot.' + key);
  } catch {
    /* nothing was kept, then */
  }
}
