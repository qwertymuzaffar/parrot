import { TestBed } from '@angular/core/testing';
import { Clips } from './clips';
import { Engine } from './engine';

/** the length of each take in samples, by URL: what decoding it gives */
const lengths = new Map<string, number>();

/** Decodes a take to a buffer of the length given for it (its samples are kept short: only the length counts). */
class FakeAudioContext {
  async decodeAudioData(bytes: ArrayBuffer) {
    const length = lengths.get(new TextDecoder().decode(bytes))!;
    return { length, numberOfChannels: 1, sampleRate: 48000, getChannelData: () => new Float32Array([0.5, 1]) };
  }
}

/** In the browser demo the engine reads no recording: the interface decodes them itself. */
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
    TestBed.configureTestingModule({
      providers: [{ provide: Engine, useValue: { peaks: async () => null, clip: async () => null, audioUrl: (path: string) => path } }],
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

/** In the desktop app the engine reads the recordings: nothing is decoded in the window. */
describe('takes the engine reads', () => {
  const engine = { peaks: vi.fn(), clip: vi.fn(), audioUrl: (path: string) => `audio:${path}` };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({ providers: [{ provide: Engine, useValue: engine }] });
  });

  it('draws a recording from the peaks the engine reads', async () => {
    engine.peaks.mockResolvedValue([0.2, 1]);
    expect(await TestBed.inject(Clips).peaks('talks/long.wav', 2)).toEqual([0.2, 1]);
    expect(engine.peaks).toHaveBeenCalledWith('talks/long.wav', 2);
  });

  it('cuts a word from the samples the engine reads, faded, with a little quiet after', async () => {
    engine.clip.mockResolvedValue({ rate: 8000, samples: new Int16Array(800).fill(16384) });
    const url = await TestBed.inject(Clips).cut('talks/long.wav', 3, 3.1);
    expect(engine.clip).toHaveBeenCalledWith('talks/long.wav', 3, 3.1);
    const bytes = await (await fetch(url)).arrayBuffer();
    const pcm = new Int16Array(bytes, 44);
    // 0.1 s of the word and 0.05 s of quiet; the word faded in over 12 ms, then at half the loudest
    expect(pcm.length).toBe(800 + 400);
    expect([pcm[0], pcm[200], pcm[1000]]).toEqual([0, 16383, 0]);
    URL.revokeObjectURL(url);
  });
});
