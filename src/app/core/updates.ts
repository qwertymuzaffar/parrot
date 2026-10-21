import { Injectable } from '@angular/core';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { IN_APP } from './engine';

/** A release of Parrot on GitHub. */
export interface Release {
  /** "0.3.0" (the tag without its leading v) */
  version: string;
  /** the release's page, with its notes and installers */
  url: string;
}

export type UpdateCheck =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'latest'; version: string }
  | { state: 'newer'; release: Release }
  | { state: 'failed'; message: string };

/** major.minor.patch of a version or tag ("v0.10.2-beta.1" -> [0, 10, 2]); a pre-release or build suffix is
 * ignored, and null if it isn't a version at all. */
export function versionParts(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Whether `latest` is a later version than `current`, part by part as numbers (0.10.0 is after 0.9.0). */
export function isNewer(latest: string, current: string): boolean {
  const [latestParts, currentParts] = [versionParts(latest), versionParts(current)];
  if (!latestParts || !currentParts) return false;
  const differing = latestParts.findIndex((part, partIndex) => part !== currentParts[partIndex]);
  return differing >= 0 && latestParts[differing] > currentParts[differing];
}

/**
 * Whether a newer Parrot is out. Nothing is asked until the user clicks "Check for updates" in Settings, and then the
 * engine asks GitHub (the webview itself reaches no outside host). A plain browser runs a development build: there is
 * no version to check.
 */
@Injectable({ providedIn: 'root' })
export class Updates {
  /** The running version; null in a plain browser. */
  current(): Promise<string | null> {
    return IN_APP ? getVersion() : Promise.resolve(null);
  }

  latest(): Promise<Release> {
    return invoke<Release>('latest_release');
  }

  /** Open a release page in the system browser, which a link in the app's webview doesn't reach. */
  async open(url: string): Promise<void> {
    if (IN_APP) await invoke<void>('open_url', { url });
    else window.open(url, '_blank', 'noopener');
  }

  async check(current: string): Promise<UpdateCheck> {
    try {
      const release = await this.latest();
      return isNewer(release.version, current) ? { state: 'newer', release } : { state: 'latest', version: current };
    } catch (error) {
      return { state: 'failed', message: typeof error === 'string' ? error : "Couldn't check for updates. Try again later." };
    }
  }
}
