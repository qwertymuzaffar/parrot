import { effect, inject, Injectable, Injector, Signal, untracked } from '@angular/core';
import { Engine } from './engine';
import { Part } from './models';
import { Playback, RATES } from './playback';
import { Recorder } from './recorder';
import { Sound, speedFor } from './sound';

/** What the queue follows: the text open for practice (none on Home), its parts, the part on screen, and whether a
 * take of the text is being scored or its parts loaded, which comes first. */
export interface Opened {
  text: Signal<{ id: string } | null>;
  parts: Signal<Part[]>;
  index: Signal<number>;
  busy: Signal<boolean>;
}

/** A reading to make: the words, and the speed. */
export interface Planned {
  text: string;
  speed: number;
}

/** The readings of `parts` to make, in order: the part on screen (`index`) at the chosen `rate` first, then its
 * neighbours, nearest first, then the rest; then every part at the other speeds, the nearer speed first. A part said
 * more than once ("Thank you.") is one reading. */
export function plan(parts: Part[], index: number, rate: number): Planned[] {
  const texts: string[] = [];
  for (let step = 0; step < parts.length; step++) {
    const partIndex = step % 2 ? index + Math.ceil(step / 2) : index - step / 2;
    const text = parts[partIndex]?.text;
    if (text != null && !texts.includes(text)) texts.push(text);
  }
  for (const part of parts) if (!texts.includes(part.text)) texts.push(part.text);
  const speeds = [
    speedFor(rate),
    ...RATES.filter((other) => other !== rate).sort((left, right) => Math.abs(rate - left) - Math.abs(rate - right)),
  ];
  return speeds.flatMap((speed) => texts.map((text) => ({ text, speed })));
}

/**
 * Readings made ahead: while a text is open and the engine's voice is the one chosen, its parts are read in the
 * background (see plan), so Listen plays at once. One at a time, and not while a take is recorded or scored (the take
 * comes first); another text opened starts its own queue, Home ends it, another voice starts it again. A reading asked
 * for is not asked for again this run, made or refused: the engine keeps the readings it made, and Listen says why one
 * could not be.
 */
@Injectable({ providedIn: 'root' })
export class ReadAhead {
  private engine = inject(Engine);
  private playback = inject(Playback);
  private recorder = inject(Recorder);
  private sound = inject(Sound);
  private injector = inject(Injector);
  private opened: Opened | null = null;
  /** the readings asked for this run, by voice, speed and words */
  private asked = new Set<string>();
  /** wakes the queue when it has nothing to do and something changes */
  private wake: (() => void) | null = null;
  private running = false;

  /** Follow the open text: its parts are read ahead from now on. */
  follow(opened: Opened) {
    this.opened = opened;
    // whatever `next` looks at changing wakes the queue
    effect(
      () => {
        this.next();
        this.wake?.();
      },
      { injector: this.injector },
    );
    if (!this.running) {
      this.running = true;
      void this.loop();
    }
  }

  /** The next reading to make, if any: none while there is nothing to read ahead (no text open, a system voice chosen,
   * everything asked for) or while a take comes first. */
  private next(): { text: string; voice: string; speed: number } | null {
    const opened = this.opened;
    const voice = this.sound.voice()?.engine?.id;
    if (!opened || !voice) return null;
    if (!opened.text() || opened.busy() || this.recorder.owner()) return null;
    for (const { text, speed } of plan(opened.parts(), opened.index(), this.playback.rate())) {
      if (!this.asked.has(`${voice}|${speed}|${text}`)) return { text, voice, speed };
    }
    return null;
  }

  private async loop() {
    for (;;) {
      const item = untracked(() => this.next());
      if (!item) {
        await new Promise<void>((resolve) => (this.wake = resolve));
        this.wake = null;
        continue;
      }
      try {
        await this.engine.reading(item.text, item.voice, item.speed);
      } catch {
        // refused (the voice missing, the disk full): Listen asks again and says why
      }
      this.asked.add(`${item.voice}|${item.speed}|${item.text}`);
    }
  }
}
