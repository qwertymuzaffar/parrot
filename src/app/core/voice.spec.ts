import { TestBed } from '@angular/core/testing';
import { Sound } from './sound';

/** A system voice, as speech synthesis lists it. */
const SAMANTHA = { name: 'Samantha', lang: 'en-US', localService: true } as SpeechSynthesisVoice;

describe('the reference voice', () => {
  afterEach(() => vi.unstubAllGlobals());

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
