import { computed, inject, Injectable, signal } from '@angular/core';
import { Engine, EngineVoice } from './engine';
import { errorMessage } from './library';
import { readSetting, writeSetting } from './settings';
import { forVoice, wordForVoice } from './voice-text';

export type Track = 'ref' | 'mine';

/** A voice to read with: one of the engine's own (Kokoro's, the same on every computer), or one of the system's. */
export interface Voice {
  /** what the choice is kept as: "kokoro:af_heart" for the engine's, the system voice's name for the system's */
  id: string;
  /** as the list of voices shows it: "Heart, Kokoro, US", "Ava, Premium, US" */
  label: string;
  engine?: EngineVoice;
  system?: SpeechSynthesisVoice;
}

/** The voices not offered: macOS's novelty and legacy voices (Albert, Bad News, Bells, Bubbles, Zarvox… and the
 * Eloquence family), of no use for practising and more of them than the voices worth choosing. */
const NOVELTY = /^com\.apple\.(speech\.synthesis\.voice|eloquence)\./;

/** Where a voice's English is from, as a list says it. */
const PLACES: Record<string, string> = {
  US: 'US',
  GB: 'UK',
  AU: 'Australia',
  IE: 'Ireland',
  IN: 'India',
  ZA: 'South Africa',
  CA: 'Canada',
  NZ: 'New Zealand',
  SG: 'Singapore',
};

/** A system voice as the list of voices shows it: "Ava, Premium, US", "Daniel, UK", "Google US English, US, online".
 * The name without the grade macOS puts in brackets after it or the language Windows puts after a dash, then the
 * grade, the place its English is from, and whether it sends the text out to a provider. */
export function voiceLabel(voice: SpeechSynthesisVoice): string {
  const grade = /\((Premium|Enhanced)\)/.exec(voice.name)?.[1];
  const name = voice.name.replace(/\s*\((Premium|Enhanced)\)/, '').replace(/\s*-\s*English\s*\(.*\)$/, '');
  const region: string | undefined = voice.lang.split(/[-_]/)[1];
  let place: string | undefined = region && PLACES[region];
  if (region && !place) {
    try {
      place = new Intl.DisplayNames(['en'], { type: 'region' }).of(region) ?? region;
    } catch {
      place = region;
    }
  }
  return [name, grade, place, voice.localService ? '' : 'online'].filter(Boolean).join(', ');
}

/** The speed the engine's voice reads at for a rate of the system voice's (1 as the voice speaks): the slowest it
 * goes is the slowest Listen speed, so a word said slowly on its card is read that slow too. */
export function speedFor(rate: number): number {
  return Math.max(0.6, rate);
}

/** Which word of a reading is being said at `seconds`, from when each starts: the last whose start has passed (a
 * moment early, as the eye should lead the ear), -1 before the first. */
export function wordAt(words: [number, number][], seconds: number): number {
  return words.findLastIndex(([from]) => from - 0.02 <= seconds);
}

/**
 * Everything that makes a sound: the reference voice (the engine's own, played from the reading it makes, or one of
 * the system's English voices through the Web Speech API), saved recordings with a time callback for the word
 * highlight, and single-word clips. One thing plays at a time: starting anything stops the rest.
 */
@Injectable({ providedIn: 'root' })
export class Sound {
  private engine = inject(Engine);

  /** the voices to choose from: the engine's own first, then the system's English ones, best first */
  readonly voices = signal<Voice[]>([]);
  /** the voice chosen, by id; "" until one is chosen, and the first of the list reads */
  readonly voiceId = signal<string>(readSetting('voice', ''));
  /** the voice that reads: the one chosen, while the list has it, else the first of the list */
  readonly voice = computed(() => {
    const list = this.voices();
    return list.find((voice) => voice.id === this.voiceId()) ?? list[0] ?? null;
  });
  /** which sentence-length track is playing, if any (single words don't count) */
  readonly playing = signal<Track | null>(null);
  readonly paused = signal(false);
  /** the engine is making the reading asked for: the interface says it is getting ready */
  readonly preparing = signal(false);
  /** why the engine could not make the last reading asked of it, in plain words; gone with the next it could */
  readonly failure = signal<string | null>(null);
  /** whether there is a voice to read with (some systems list theirs a moment after start) */
  readonly canSpeak = signal(false);
  /** the reference voice was asked for when there was none: the interface says so, rather than staying silent */
  readonly voiceMissing = signal(false);

  /** the system's speech synthesis: some webviews have none (WebKitGTK built without it) */
  private synthesis = typeof speechSynthesis === 'undefined' ? null : speechSynthesis;

  private player = new window.Audio();
  private clip = new window.Audio();
  private frame = 0;
  private onTime: ((seconds: number) => void) | null = null;
  private onEnd: (() => void) | null = null;
  private synthMode = false;
  private utterance: SpeechSynthesisUtterance | null = null;
  /** the voice warmed last (see warm) */
  private warmed = '';
  private synth: { text: string; rate: number; onWord?: (charIndex: number) => void; from: number; at: number } | null = null;

  constructor() {
    const own: Voice[] = this.engine
      .voices()
      .map((voice) => ({ id: `kokoro:${voice.id}`, label: `${voice.name}, Kokoro, ${voice.place}`, engine: voice }));
    const load = () => {
      // the best system voice first: the voices on the machine before those that send the text out to a provider;
      // among them, one the system has added over its compact voices (macOS names these "Ava (Premium)", "Evan
      // (Enhanced)", and so their URIs), then the names known to read well, then the rest
      const pref = ['Samantha', 'Ava', 'Allison', 'Alex', 'Daniel', 'Google US English'];
      const grade = (voice: SpeechSynthesisVoice) => {
        const about = `${voice.name} ${voice.voiceURI}`.toLowerCase();
        return about.includes('premium') ? 0 : about.includes('enhanced') ? 1 : 2;
      };
      const rank = (voice: SpeechSynthesisVoice) => {
        const prefIndex = pref.findIndex((name) => voice.name.includes(name));
        return (voice.localService ? 0 : 1000) + grade(voice) * 100 + (prefIndex < 0 ? 50 : prefIndex);
      };
      const all = this.synthesis?.getVoices() ?? [];
      const system = all
        .filter((voice) => voice.lang.startsWith('en') && !NOVELTY.test(voice.voiceURI))
        .sort((left, right) => rank(left) - rank(right))
        .map((voice) => ({ id: voice.name, label: voiceLabel(voice), system: voice }));
      this.voices.set([...own, ...system]);
      this.canSpeak.set(own.length + system.length > 0);
      if (this.canSpeak()) this.voiceMissing.set(false);
      this.warm();
    };
    if (this.synthesis) this.synthesis.onvoiceschanged = load;
    load();
    this.player.onended = () => this.ended();
  }

  setVoice(id: string) {
    this.voiceId.set(id);
    writeSetting('voice', id);
    this.warm();
  }

  /** Have the system load the system voice chosen before it is first read with: the first words of a voice wait for it
   * to be loaded, up to a second for a large one (macOS's Premium voices), so it says a word without sound as soon as
   * it is known. Not while a reading is under way: a word spoken then would wait behind the reading, and a reading
   * begun meanwhile stops the warming word first, as it stops anything. */
  private warm() {
    const voice = this.voice()?.system;
    if (!voice || !this.synthesis || this.synthMode || this.warmed === voice.name) return;
    this.warmed = voice.name;
    const utterance = new SpeechSynthesisUtterance('Parrot');
    utterance.voice = voice;
    utterance.volume = 0;
    // a word not said (a webview that won't speak before the user has acted, or a reading that stopped it) leaves
    // the voice to be warmed at the next chance
    utterance.onerror = () => {
      if (this.warmed === voice.name) this.warmed = '';
    };
    this.synthesis.speak(utterance);
  }

  /** The reference reading of a text; onWord gets the index of each word as it is spoken (the words split on spaces,
   * as the screen splits them). */
  speak(text: string, rate = 1, track: Track | null = 'ref', onWord?: (wordIndex: number) => void): Promise<void> {
    const voice = this.voice();
    if (voice?.engine) return this.read(text, voice.engine.id, rate, track, onWord);
    // the text as the system voice should have it (abbreviations spelled out), with where each word starts in it
    const { spoken, starts } = forVoice(text);
    return this.synthesize(spoken, rate, track, onWord && ((charIndex) => onWord(starts.findLastIndex((start) => start <= charIndex))));
  }

  /** A word said on its own (its punctuation already gone), as it should sound. */
  sayWord(word: string, rate: number): Promise<void> {
    const voice = this.voice();
    if (voice?.engine) return this.read(word, voice.engine.id, rate, null);
    return this.synthesize(wordForVoice(word), rate, null);
  }

  /** The reading by the engine's voice: made by the engine (or kept from before), then played as a recording is, the
   * word whose start has passed lit. Until it comes the interface says it is getting ready; a reading that can't be
   * made is said to have failed, in the engine's words. */
  private read(text: string, voice: string, rate: number, track: Track | null, onWord?: (wordIndex: number) => void): Promise<void> {
    this.stop();
    return new Promise((resolve) => {
      this.onEnd = resolve;
      this.playing.set(track);
      this.preparing.set(true);
      this.engine.reading(text, voice, speedFor(rate)).then(
        (reading) => {
          // stopped, or something else played, while it was made: the engine keeps it for the next time
          if (this.onEnd !== resolve) return;
          this.preparing.set(false);
          this.failure.set(null);
          this.start(this.engine.audioUrl(reading.audio), onWord && ((seconds) => onWord(wordAt(reading.words, seconds))), resolve);
        },
        (error) => {
          if (this.onEnd !== resolve) return;
          this.failure.set(errorMessage(error));
          this.ended();
        },
      );
    });
  }

  /** Speak `spoken` through the system voice; onWord gets the character index of each word. */
  private synthesize(spoken: string, rate: number, track: Track | null, onWord?: (charIndex: number) => void): Promise<void> {
    this.stop();
    // without a voice nothing is read (some systems never even end the reading): the interface says why instead
    if (!this.canSpeak()) {
      this.voiceMissing.set(true);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.synth = { text: spoken, rate, onWord, from: 0, at: 0 };
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
    utterance.voice = this.voice()?.system ?? null;
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
    this.synthesis!.speak(utterance);
  }

  /** A whole recording (or a clip URL) with a time callback for the highlight. */
  play(url: string, track: Track, onTime?: (seconds: number) => void): Promise<void> {
    this.stop();
    return new Promise((resolve) => {
      this.onEnd = resolve;
      this.playing.set(track);
      this.start(url, onTime, resolve);
    });
  }

  /** Start the player on `url` for the sound whose end is `resolve`: only that sound may end itself (one replaced
   * while starting fails to play after the next has begun). */
  private start(url: string, onTime: ((seconds: number) => void) | undefined, resolve: () => void) {
    this.player.src = url;
    this.onTime = onTime ?? null;
    const ended = () => this.onEnd === resolve && this.ended();
    this.player
      .play()
      .then(() => this.onEnd === resolve && this.tick())
      .catch(ended);
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
    // a reading still being made has nothing to pause: asked again, it is not wanted after all
    if (this.preparing()) return this.stop();
    if (this.synthMode) {
      if (this.paused()) {
        this.paused.set(false);
        this.utter(this.synth!.at);
      } else {
        this.utterance = null;
        this.synthesis!.cancel();
        this.paused.set(true);
      }
    } else if (this.player.paused) {
      // a resume cut short by something else played is that thing's to handle
      this.player
        .play()
        .then(() => this.tick())
        .catch(() => {});
      this.paused.set(false);
    } else {
      this.player.pause();
      this.paused.set(true);
    }
  }

  stop() {
    this.synthesis?.cancel();
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
    this.preparing.set(false);
  }
}
