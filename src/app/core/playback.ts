import { inject, Injectable, signal } from '@angular/core';
import { Clips } from './clips';
import { Engine } from './engine';
import { Attempt } from './models';
import { readSetting, writeSetting } from './settings';
import { Sound } from './sound';
import { bare } from './split';

/** Listening: the reference reading and my takes, whole or word by word, with the word being spoken lit up. */
@Injectable({ providedIn: 'root' })
export class Playback {
  private engine = inject(Engine);
  private clips = inject(Clips);
  private sound = inject(Sound);

  /** which sentence-length track is playing, if any, and whether it is paused */
  readonly playing = this.sound.playing.asReadonly();
  readonly paused = this.sound.paused.asReadonly();
  /** the reference was asked for, and the system has no voice to read it */
  readonly voiceMissing = this.sound.voiceMissing.asReadonly();
  /** the word being spoken: in the reference line and in your own */
  readonly nowRef = signal<number | null>(null);
  readonly nowMine = signal<number | null>(null);
  readonly rate = signal(Number(readSetting('rate', '1')));

  /** every play chain (mine, then the reference) checks this, so Stop really stops it */
  private run = 0;
  /** the word clip cut last: one cut short by the next leaves the highlight to it */
  private wordClip: string | null = null;

  setRate(rate: number) {
    this.rate.set(rate);
    writeSetting('rate', String(rate));
  }

  /** The reference reading of a part, with the word being spoken lit up. */
  playReference(text: string) {
    const starts: number[] = [];
    let offset = 0;
    for (const word of text.split(' ')) {
      starts.push(offset);
      offset += word.length + 1;
    }
    return this.sound
      .speak(text, this.rate(), 'ref', (charIndex) => this.nowRef.set(starts.findLastIndex((start) => start <= charIndex)))
      .then(() => this.nowRef.set(null));
  }

  playMine(attempt: Attempt) {
    return this.sound
      .play(this.engine.audioUrl(attempt.audio), 'mine', (seconds) =>
        this.nowMine.set(attempt.words.findIndex((word) => word.t && seconds >= word.t[0] - 0.02 && seconds <= word.t[1] + 0.06)),
      )
      .then(() => this.nowMine.set(null));
  }

  /** Pause or resume the reading, or start it: a comparison under way stops there (pausing one doesn't). */
  toggleReference(text: string) {
    if (this.sound.playing() === 'ref') return this.sound.togglePause();
    this.run++;
    this.playReference(text);
  }

  toggleMine(attempt: Attempt) {
    if (this.sound.playing() === 'mine') return this.sound.togglePause();
    this.run++;
    this.playMine(attempt);
  }

  /** My take, then the reference reading. */
  compare(attempt: Attempt, text: string) {
    return this.chain(
      () => this.playMine(attempt),
      400,
      () => this.playReference(text),
    );
  }

  stop() {
    this.run++;
    this.sound.stop();
    this.nowRef.set(null);
    this.nowMine.set(null);
  }

  /** How a word should sound: spoken on its own by the reference voice. */
  sayWord(word: string, slow = false) {
    if (!word) return;
    this.run++;
    this.sound.speak(bare(word), slow ? 0.55 : 0.85, null);
  }

  /** A word as it was said, cut out of my take. */
  playMyWord(attempt: Attempt, wordIndex: number) {
    if (attempt.words[wordIndex]?.t) this.run++;
    return this.cutMyWord(attempt, wordIndex);
  }

  /** A try of one word said alone, played whole (it lights up nothing in the part). */
  playWordTry(attempt: Attempt) {
    this.run++;
    return this.sound.playClip(this.engine.audioUrl(attempt.audio));
  }

  /** A word as I said it, then as it should sound. */
  compareWord(attempt: Attempt, wordIndex: number, word: string) {
    // my word is the chain's first step: it must not start a chain of its own, or the chain stops after it
    return this.chain(
      () => this.cutMyWord(attempt, wordIndex),
      350,
      () => this.sayWord(word),
    );
  }

  private cutMyWord(attempt: Attempt, wordIndex: number) {
    const word = attempt.words[wordIndex];
    if (!word?.t) return Promise.resolve();
    const before = attempt.words
      .slice(0, wordIndex)
      .reverse()
      .find((other) => other.t);
    const after = attempt.words.slice(wordIndex + 1).find((other) => other.t);
    const from = Math.max(before?.t ? before.t[1] : 0, word.t[0] - 0.03);
    const to = Math.min(after?.t ? after.t[0] : word.t[1] + 0.12, word.t[1] + 0.04);
    this.nowMine.set(wordIndex);
    return this.clips.cut(attempt.audio, from, to).then(async (url) => {
      this.wordClip = url;
      // the clip ends when it plays out, or when anything else is played or stopped
      await this.sound.playClip(url);
      URL.revokeObjectURL(url);
      if (this.wordClip === url) this.nowMine.set(null);
    });
  }

  /** Play one thing, wait a moment, then the next, unless something else was played or stopped meanwhile. */
  private async chain(first: () => Promise<void>, gap: number, then: () => void) {
    const run = ++this.run;
    await first();
    if (run !== this.run) return;
    await new Promise((resolve) => setTimeout(resolve, gap));
    if (run === this.run) then();
  }
}
