import { TestBed } from '@angular/core/testing';
import { Engine, EngineError, EngineVoice, KOKORO_VOICES, Reading } from './engine';
import { Sound, speedFor, voiceLabel, wordAt } from './sound';

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

/** An audio element that plays nothing: what it was given to play, and whether it is playing. */
class FakeAudio {
  src = '';
  paused = true;
  currentTime = 0;
  onended: (() => void) | null = null;
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

describe('the reference voice', () => {
  /** the engine, with its own voices or none, and the readings it gives (or why it can't) */
  let engineVoices: EngineVoice[];
  let readings: { asked: [string, string, number][]; give: () => Promise<Reading> };
  let audios: FakeAudio[];
  /** let pending promises settle */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** a Sound on a fresh injector, over the engine as set up */
  function fresh() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: Engine,
          useValue: {
            voices: () => engineVoices,
            reading: (text: string, voice: string, speed: number) => {
              readings.asked.push([text, voice, speed]);
              return readings.give();
            },
            audioUrl: (path: string) => `audio:${path}`,
          },
        },
      ],
    });
    return TestBed.inject(Sound);
  }

  beforeEach(() => {
    engineVoices = [];
    readings = {
      asked: [],
      give: async () => ({
        audio: 'readings/af_heart/abc-1.wav',
        words: [
          [0.1, 0.5],
          [0.6, 1.0],
        ],
      }),
    };
    audios = [];
    vi.stubGlobal(
      'Audio',
      class extends FakeAudio {
        constructor() {
          super();
          audios.push(this);
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('is the best one the machine has, a Premium or Enhanced voice before the compact ones, unless one was chosen', () => {
    fakeSynthesis(VOICES);
    const sound = fresh();
    const names = sound.voices().map((voice) => voice.id);
    expect(names).toEqual(['Ava (Premium)', 'Zoe (Premium)', 'Evan (Enhanced)', 'Samantha', 'Daniel', 'Google US English']);
    expect(sound.voice()?.id).toBe('Ava (Premium)');
    // the choice made is kept over the ranking, until the voice chosen is gone from the machine
    sound.setVoice('Daniel');
    expect(fresh().voice()?.id).toBe('Daniel');
    fakeSynthesis(VOICES.slice(0, 3));
    expect(fresh().voice()?.id).toBe('Zoe (Premium)');
  });

  it("is listed by name, grade and place, with the system's novelty voices left out", () => {
    fakeSynthesis(VOICES);
    const labels = fresh()
      .voices()
      .map((voice) => voice.label);
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
    const sound = fresh();
    expect(warmed).toEqual(['Ava (Premium)']);
    sound.setVoice('Daniel');
    sound.setVoice('Daniel');
    expect(warmed).toEqual(['Ava (Premium)', 'Daniel']);
    // not while a reading is under way: the warming word would make it wait
    sound.speak('Hello there.');
    sound.setVoice('Zoe (Premium)');
    expect([spoken, warmed]).toEqual([['Hello there.'], ['Ava (Premium)', 'Daniel']]);
  });

  it('is given abbreviations spelled out, and a capital letter alone as a word', () => {
    const { spoken } = fakeSynthesis(VOICES);
    const sound = fresh();
    sound.speak('so I asked the GSA owner');
    sound.sayWord('I', 0.85);
    sound.sayWord('GSA', 0.85);
    expect(spoken).toEqual(['so I asked the G S A owner', 'I.', 'G S A']);
  });

  it('starts without speech synthesis, and says there is no voice rather than staying silent', async () => {
    // jsdom has no speech synthesis, as some webviews (WebKitGTK) have none
    expect(typeof speechSynthesis).toBe('undefined');
    const sound = fresh();
    expect([sound.canSpeak(), sound.voiceMissing()]).toEqual([false, false]);
    await sound.speak('Hello there.');
    expect([sound.voiceMissing(), sound.playing()]).toEqual([true, null]);
    sound.stop();
  });

  it('says there is no voice while the system lists none, and reads once it does', async () => {
    const voices: SpeechSynthesisVoice[] = [];
    const { synthesis, spoken, warmed } = fakeSynthesis(voices);
    const sound = fresh();
    await sound.speak('Hello there.');
    expect([sound.voiceMissing(), spoken, warmed]).toEqual([true, [], []]);
    voices.push(SAMANTHA);
    synthesis.onvoiceschanged?.();
    expect([sound.canSpeak(), sound.voiceMissing(), sound.voice()?.id, warmed]).toEqual([true, false, 'Samantha', ['Samantha']]);
    sound.speak('Hello there.');
    expect([spoken, sound.playing()]).toEqual([['Hello there.'], 'ref']);
  });

  describe("the engine's own", () => {
    beforeEach(() => (engineVoices = KOKORO_VOICES));

    it("comes first, Heart reading unless a voice was chosen, with the system's voices after", () => {
      fakeSynthesis(VOICES);
      const sound = fresh();
      expect(sound.voices().slice(0, 2)).toEqual([
        { id: 'kokoro:af_heart', label: 'Heart, Kokoro, US', engine: KOKORO_VOICES[0] },
        { id: 'kokoro:af_bella', label: 'Bella, Kokoro, US', engine: KOKORO_VOICES[1] },
      ]);
      expect(
        sound
          .voices()
          .map((voice) => voice.id)
          .slice(8),
      ).toEqual(['Ava (Premium)', 'Zoe (Premium)', 'Evan (Enhanced)', 'Samantha', 'Daniel', 'Google US English']);
      expect([sound.voice()?.id, sound.canSpeak()]).toEqual(['kokoro:af_heart', true]);
      sound.setVoice('Daniel');
      expect(fresh().voice()?.id).toBe('Daniel');
      sound.setVoice('kokoro:bm_george');
      expect(fresh().voice()?.label).toBe('George, Kokoro, UK');
    });

    it('is there without speech synthesis, so a system without a voice reads all the same', async () => {
      const sound = fresh();
      expect([sound.canSpeak(), sound.voice()?.id, sound.voices().length]).toEqual([true, 'kokoro:af_heart', 8]);
      sound.speak('Hello there.');
      await settle();
      expect([sound.voiceMissing(), sound.playing(), readings.asked.length]).toEqual([false, 'ref', 1]);
    });

    it('reads from the reading the engine makes, played as a recording, and says it is getting ready meanwhile', async () => {
      const sound = fresh();
      const lit: number[] = [];
      const reading = sound.speak('Hello there.', 0.75, 'ref', (wordIndex) => lit.push(wordIndex));
      expect([sound.playing(), sound.preparing(), readings.asked]).toEqual(['ref', true, [['Hello there.', 'af_heart', 0.75]]]);
      await settle();
      const [player] = audios;
      expect([sound.preparing(), sound.playing(), player.src, player.paused]).toEqual([
        false,
        'ref',
        'audio:readings/af_heart/abc-1.wav',
        false,
      ]);
      player.onended?.();
      player.paused = true;
      sound.stop();
      await reading;
      expect(sound.playing()).toBeNull();
      // the word being said is the last whose start has passed, a moment early
      const words: [number, number][] = [
        [0.1, 0.5],
        [0.6, 1.0],
      ];
      expect([wordAt(words, 0), wordAt(words, 0.09), wordAt(words, 0.55), wordAt(words, 0.58), wordAt(words, 2)]).toEqual([-1, 0, 0, 1, 1]);
    });

    it('reads a word alone and the speeds the readings are made at, no slower than the slowest Listen speed', async () => {
      const sound = fresh();
      sound.sayWord('things', 0.85);
      sound.sayWord('things', 0.55);
      sound.speak('Hello there.', 0.6);
      sound.speak('Hello there.', 1);
      expect(readings.asked).toEqual([
        ['things', 'af_heart', 0.85],
        ['things', 'af_heart', 0.6],
        ['Hello there.', 'af_heart', 0.6],
        ['Hello there.', 'af_heart', 1],
      ]);
      expect([speedFor(0.55), speedFor(0.6), speedFor(0.75), speedFor(1)]).toEqual([0.6, 0.6, 0.75, 1]);
    });

    it('stopped, or asked again, while the reading is made plays nothing when it comes', async () => {
      const sound = fresh();
      let give!: (reading: Reading) => void;
      readings.give = () => new Promise((resolve) => (give = resolve));
      const first = sound.speak('Hello there.');
      sound.stop();
      expect([sound.playing(), sound.preparing()]).toEqual([null, false]);
      give({ audio: 'readings/first.wav', words: [] });
      await first;
      expect(audios[0].src).toBe('');
      // Listen pressed again while the reading is made: not wanted after all, rather than paused
      sound.speak('Hello there.');
      sound.togglePause();
      expect([sound.playing(), readings.asked.length]).toEqual([null, 2]);
      // a second reading asked for replaces the first, which never plays
      const second = sound.speak('Second one.');
      const giveSecond = give;
      sound.speak('Third one.');
      giveSecond({ audio: 'readings/second.wav', words: [] });
      await second;
      await settle();
      expect(audios[0].src).toBe('');
    });

    it('says in plain words why a reading could not be made, until one can', async () => {
      const sound = fresh();
      readings.give = () => Promise.reject(new EngineError("Parrot's disk is full: free up some space, then try again"));
      await sound.speak('Hello there.');
      expect([sound.failure(), sound.playing(), sound.preparing()]).toEqual([
        "Parrot's disk is full: free up some space, then try again",
        null,
        false,
      ]);
      readings.give = async () => ({ audio: 'readings/af_heart/abc-1.wav', words: [] });
      sound.speak('Hello there.');
      await settle();
      expect([sound.failure(), sound.playing()]).toEqual([null, 'ref']);
    });
  });
});
