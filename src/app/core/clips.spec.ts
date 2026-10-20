import { TestBed } from '@angular/core/testing';
import { Clips } from './clips';

/** the length of each take in samples, by URL: what decoding it gives */
const lengths = new Map<string, number>();

/** Decodes a take to a buffer of the length given for it (its samples are kept short: only the length counts). */
class FakeAudioContext {
  async decodeAudioData(bytes: ArrayBuffer) {
    const length = lengths.get(new TextDecoder().decode(bytes))!;
    return { length, numberOfChannels: 1, sampleRate: 48000, getChannelData: () => new Float32Array([0.5, 1]) };
  }
}

describe('the decoded takes kept', () => {
  let clips: Clips;
  let fetched: string[];

  beforeEach(() => {
    lengths.clear();
    fetched = [];
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      return { arrayBuffer: async () => new TextEncoder().encode(url).buffer };
    });
    clips = TestBed.inject(Clips);
  });

  afterEach(() => vi.unstubAllGlobals());

  /** load the waveform of each take, as showing it does */
  async function show(...urls: string[]) {
    for (const url of urls) await clips.peaks(url, 2);
  }

  it('keeps many short takes', async () => {
    const sentences = Array.from({ length: 12 }, (_, takeIndex) => `audio:sentence-${takeIndex}.wav`);
    sentences.forEach((url) => lengths.set(url, 3 * 48000));
    await show(...sentences);
    await show(sentences[0]);
    expect(fetched.length).toBe(12);
  });

  it('keeps few long takes, and always the one shown last', async () => {
    const texts = Array.from({ length: 3 }, (_, takeIndex) => `audio:text-${takeIndex}.wav`);
    texts.forEach((url) => lengths.set(url, 3 * 60 * 48000));
    lengths.set('audio:longest.wav', 10 * 60 * 48000);
    await show(...texts);
    await show(texts[0]);
    expect(fetched).toEqual([...texts, texts[0]]);
    await show('audio:longest.wav', 'audio:longest.wav');
    expect(fetched.filter((url) => url === 'audio:longest.wav').length).toBe(1);
  });
});
