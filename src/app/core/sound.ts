import { Injectable, signal } from '@angular/core';
import { readSetting, writeSetting } from './settings';

export type Track = 'ref' | 'mine';

/**
 * Everything that makes a sound: the reference voice (the system's English voices, through the Web Speech API),
 * saved recordings with a time callback for the word highlight, and single-word clips.
 * One thing plays at a time: starting anything stops the rest.
 */
@Injectable({ providedIn: 'root' })
export class Sound {
  readonly voices = signal<SpeechSynthesisVoice[]>([]);
  readonly voiceName = signal<string>(readSetting('voice', ''));
  /** which sentence-length track is playing, if any (single words don't count) */
  readonly playing = signal<Track | null>(null);
  readonly paused = signal(false);

  private player = new window.Audio();
  private clip = new window.Audio();
  private frame = 0;
  private onTime: ((seconds: number) => void) | null = null;
  private onEnd: (() => void) | null = null;
  private synthMode = false;
  private utterance: SpeechSynthesisUtterance | null = null;
  private synth: { text: string; rate: number; onWord?: (charIndex: number) => void; from: number; at: number } | null = null;

  constructor() {
    const load = () => {
      const pref = ['Samantha', 'Ava', 'Allison', 'Alex', 'Daniel', 'Google US English'];
      const rank = (voice: SpeechSynthesisVoice) => {
        const prefIndex = pref.findIndex((name) => voice.name.includes(name));
        return (prefIndex < 0 ? 50 : prefIndex) + (voice.localService ? 0 : 100);
      };
      const list = speechSynthesis.getVoices().filter((voice) => voice.lang.startsWith('en'));
      this.voices.set(list.sort((left, right) => rank(left) - rank(right)));
      if (!list.some((voice) => voice.name === this.voiceName()) && list.length) this.voiceName.set(list[0].name);
    };
    speechSynthesis.onvoiceschanged = load;
    load();
    this.player.onended = () => this.ended();
  }

  setVoice(name: string) {
    this.voiceName.set(name);
    writeSetting('voice', name);
  }

  /** The reference reading of a text by the system voice; onWord gets the character index of each word. */
  speak(text: string, rate = 1, track: Track | null = 'ref', onWord?: (charIndex: number) => void): Promise<void> {
    this.stop();
    return new Promise((resolve) => {
      this.synth = { text, rate, onWord, from: 0, at: 0 };
      this.onEnd = resolve;
      this.synthMode = true;
      this.playing.set(track);
      this.utter(0);
    });
  }

  /** Speak the reading from a character on. Pausing a voice is unreliable in browsers (some voices ignore it), so a
   * pause stops the reading and remembers the word it reached, and resuming speaks the rest from that word. */
  private utter(from: number) {
    const synth = this.synth!;
    synth.from = from;
    const utterance = new SpeechSynthesisUtterance(synth.text.slice(from));
    utterance.voice = this.voices().find((voice) => voice.name === this.voiceName()) ?? null;
    utterance.lang = 'en-US';
    utterance.rate = synth.rate;
    utterance.onboundary = (event) => {
      if (event.name !== 'word') return;
      synth.at = from + event.charIndex;
      synth.onWord?.(synth.at);
    };
    utterance.onend = utterance.onerror = () => {
      // cancel() ends the previous utterance a moment later: only the current one may finish the reading
      if (this.utterance === utterance) this.ended();
    };
    this.utterance = utterance;
    speechSynthesis.speak(utterance);
  }

  /** A whole recording (or a clip URL) with a time callback for the highlight. */
  play(url: string, track: Track, onTime?: (seconds: number) => void): Promise<void> {
    this.stop();
    return new Promise((resolve) => {
      this.player.src = url;
      this.onTime = onTime ?? null;
      this.onEnd = resolve;
      this.playing.set(track);
      this.player
        .play()
        .then(() => this.tick())
        .catch(() => this.ended());
    });
  }

  /** A single word or a word try; it ends when it plays out, or when anything else is played or stopped. */
  playClip(url: string): Promise<void> {
    this.stop();
    return new Promise((resolve) => {
      this.onEnd = resolve;
      // only this clip may end itself: one replaced while starting fails to play after the next has begun
      const ended = () => this.onEnd === resolve && this.ended();
      this.clip.src = url;
      this.clip.onended = ended;
      this.clip.play().catch(ended);
    });
  }

  togglePause() {
    if (!this.playing()) return;
    if (this.synthMode) {
      if (this.paused()) {
        this.paused.set(false);
        this.utter(this.synth!.at);
      } else {
        this.utterance = null;
        speechSynthesis.cancel();
        this.paused.set(true);
      }
    } else if (this.player.paused) {
      this.player.play().then(() => this.tick());
      this.paused.set(false);
    } else {
      this.player.pause();
      this.paused.set(true);
    }
  }

  stop() {
    speechSynthesis.cancel();
    this.player.pause();
    this.clip.pause();
    const end = this.onEnd;
    this.reset();
    end?.();
  }

  private tick() {
    cancelAnimationFrame(this.frame);
    const step = () => {
      this.onTime?.(this.player.currentTime);
      if (!this.player.paused) this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  private ended() {
    const end = this.onEnd;
    this.reset();
    end?.();
  }

  private reset() {
    cancelAnimationFrame(this.frame);
    this.onTime = this.onEnd = null;
    this.synthMode = false;
    this.utterance = null;
    this.synth = null;
    this.playing.set(null);
    this.paused.set(false);
  }
}
