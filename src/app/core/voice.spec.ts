import { TestBed } from '@angular/core/testing';
import { Sound } from './sound';

/** A system voice, as speech synthesis lists it. */
const SAMANTHA = {
  name: 'Samantha',
  voiceURI: 'com.apple.voice.compact.en-US.Samantha',
  lang: 'en-US',
  localService: true,
} as SpeechSynthesisVoice;

/** macOS's voices as WebKit lists them: the Premium and Enhanced ones a user downloads carry the grade in their names
 * and URIs; the compact ones come with the system. One from a provider, one in another language. */
const VOICES = [
  SAMANTHA,
  { name: 'Evan (Enhanced)', voiceURI: 'com.apple.voice.enhanced.en-US.Evan', lang: 'en-US', localService: true },
  { name: 'Zoe (Premium)', voiceURI: 'com.apple.voice.premium.en-US.Zoe', lang: 'en-US', localService: true },
  { name: 'Daniel', voiceURI: 'com.apple.voice.compact.en-GB.Daniel', lang: 'en-GB', localService: true },
  { name: 'Ava (Premium)', voiceURI: 'com.apple.voice.premium.en-US.Ava', lang: 'en-US', localService: true },
  { name: 'Google US English', voiceURI: 'Google US English', lang: 'en-US', localService: false },
  { name: 'Anna', voiceURI: 'com.apple.voice.compact.de-DE.Anna', lang: 'de-DE', localService: true },
] as SpeechSynthesisVoice[];

describe('the reference voice', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('is the best one the machine has, a Premium or Enhanced voice before the compact ones, unless one was chosen', () => {
    vi.stubGlobal('speechSynthesis', { getVoices: () => VOICES, speak() {}, cancel() {}, onvoiceschanged: null });
    const sound = TestBed.inject(Sound);
    const names = sound.voices().map((voice) => voice.name);
    expect(names).toEqual(['Ava (Premium)', 'Zoe (Premium)', 'Evan (Enhanced)', 'Samantha', 'Daniel', 'Google US English']);
    expect(sound.voiceName()).toBe('Ava (Premium)');
    // the choice made is kept over the ranking, until the voice chosen is gone from the machine
    sound.setVoice('Daniel');
    TestBed.resetTestingModule();
    expect(TestBed.inject(Sound).voiceName()).toBe('Daniel');
    TestBed.resetTestingModule();
    vi.stubGlobal('speechSynthesis', { getVoices: () => VOICES.slice(0, 3), speak() {}, cancel() {}, onvoiceschanged: null });
    expect(TestBed.inject(Sound).voiceName()).toBe('Zoe (Premium)');
  });

  it('starts without speech synthesis, and says there is no voice rather than staying silent', async () => {
    // jsdom has no speech synthesis, as some webviews (WebKitGTK) have none
    expect(typeof speechSynthesis).toBe('undefined');
    const sound = TestBed.inject(Sound);
    expect([sound.canSpeak(), sound.voiceMissing()]).toEqual([false, false]);
    await sound.speak('Hello there.');
    expect([sound.voiceMissing(), sound.playing()]).toEqual([true, null]);
    sound.stop();
  });

  it('says there is no voice while the system lists none, and reads once it does', async () => {
    const voices: SpeechSynthesisVoice[] = [];
    const spoken: string[] = [];
    const synthesis = {
      getVoices: () => voices,
      speak: (utterance: { text: string }) => spoken.push(utterance.text),
      cancel() {},
      onvoiceschanged: null as (() => void) | null,
    };
    vi.stubGlobal('speechSynthesis', synthesis);
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        constructor(readonly text: string) {}
      },
    );
    const sound = TestBed.inject(Sound);
    await sound.speak('Hello there.');
    expect([sound.voiceMissing(), spoken]).toEqual([true, []]);
    voices.push(SAMANTHA);
    synthesis.onvoiceschanged?.();
    expect([sound.canSpeak(), sound.voiceMissing(), sound.voiceName()]).toEqual([true, false, 'Samantha']);
    sound.speak('Hello there.');
    expect([spoken, sound.playing()]).toEqual([['Hello there.'], 'ref']);
  });
});
