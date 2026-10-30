import { TestBed } from '@angular/core/testing';
import { Sound, voiceLabel } from './sound';

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
  // macOS's novelty voices and the Eloquence family: English, but not offered
  { name: 'Zarvox', voiceURI: 'com.apple.speech.synthesis.voice.Zarvox', lang: 'en-US', localService: true },
  { name: 'Bad News', voiceURI: 'com.apple.speech.synthesis.voice.BadNews', lang: 'en-US', localService: true },
  { name: 'Eddy (English (US))', voiceURI: 'com.apple.eloquence.en-US.Eddy', lang: 'en-US', localService: true },
] as SpeechSynthesisVoice[];

/** An utterance as the window makes one: its text, and the voice and volume set on it. */
class Utterance {
  voice: SpeechSynthesisVoice | null = null;
  volume = 1;
  constructor(readonly text: string) {}
}

/** The system's speech synthesis with `voices`, noting what it is given to speak: the texts read aloud, and the
 * voices warmed (a word said without sound). */
function fakeSynthesis(voices: SpeechSynthesisVoice[]) {
  const spoken: string[] = [];
  const warmed: string[] = [];
  const synthesis = {
    getVoices: () => voices,
    speak: (utterance: Utterance) => (utterance.volume === 0 ? warmed.push(utterance.voice?.name ?? '') : spoken.push(utterance.text)),
    cancel() {},
    onvoiceschanged: null as (() => void) | null,
  };
  vi.stubGlobal('speechSynthesis', synthesis);
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
  return { synthesis, spoken, warmed };
}

describe('the reference voice', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('is the best one the machine has, a Premium or Enhanced voice before the compact ones, unless one was chosen', () => {
    fakeSynthesis(VOICES);
    const sound = TestBed.inject(Sound);
    const names = sound.voices().map((voice) => voice.name);
    expect(names).toEqual(['Ava (Premium)', 'Zoe (Premium)', 'Evan (Enhanced)', 'Samantha', 'Daniel', 'Google US English']);
    expect(sound.voiceName()).toBe('Ava (Premium)');
    // the choice made is kept over the ranking, until the voice chosen is gone from the machine
    sound.setVoice('Daniel');
    TestBed.resetTestingModule();
    expect(TestBed.inject(Sound).voiceName()).toBe('Daniel');
    TestBed.resetTestingModule();
    fakeSynthesis(VOICES.slice(0, 3));
    expect(TestBed.inject(Sound).voiceName()).toBe('Zoe (Premium)');
  });

  it("is listed by name, grade and place, with the system's novelty voices left out", () => {
    fakeSynthesis(VOICES);
    const labels = TestBed.inject(Sound).voices().map(voiceLabel);
    expect(labels).toEqual([
      'Ava, Premium, US',
      'Zoe, Premium, US',
      'Evan, Enhanced, US',
      'Samantha, US',
      'Daniel, UK',
      'Google US English, US, online',
    ]);
    const label = (name: string, lang: string) => voiceLabel({ name, lang, localService: true } as SpeechSynthesisVoice);
    expect(label('Karen', 'en-AU')).toBe('Karen, Australia');
    expect(label('Moira', 'en-IE')).toBe('Moira, Ireland');
    // Windows puts the language after a dash; a voice may name no place at all
    expect(label('Microsoft Zira Desktop - English (United States)', 'en-US')).toBe('Microsoft Zira Desktop, US');
    expect(label('Lee', 'en-GB-oed')).toBe('Lee, UK');
    expect(label('Lee', 'en')).toBe('Lee');
    expect(label('Lee', 'en-150')).toBe('Lee, Europe');
  });

  it("is warmed as soon as it is known, and when another is chosen, so its first words don't wait for it to load", () => {
    const { spoken, warmed } = fakeSynthesis(VOICES);
    const sound = TestBed.inject(Sound);
    expect(warmed).toEqual(['Ava (Premium)']);
    sound.setVoice('Daniel');
    sound.setVoice('Daniel');
    expect(warmed).toEqual(['Ava (Premium)', 'Daniel']);
    // not while a reading is under way: the warming word would make it wait
    sound.speak('Hello there.');
    sound.setVoice('Zoe (Premium)');
    expect([spoken, warmed]).toEqual([['Hello there.'], ['Ava (Premium)', 'Daniel']]);
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
    const { synthesis, spoken, warmed } = fakeSynthesis(voices);
    const sound = TestBed.inject(Sound);
    await sound.speak('Hello there.');
    expect([sound.voiceMissing(), spoken, warmed]).toEqual([true, [], []]);
    voices.push(SAMANTHA);
    synthesis.onvoiceschanged?.();
    expect([sound.canSpeak(), sound.voiceMissing(), sound.voiceName(), warmed]).toEqual([true, false, 'Samantha', ['Samantha']]);
    sound.speak('Hello there.');
    expect([spoken, sound.playing()]).toEqual([['Hello there.'], 'ref']);
  });
});
