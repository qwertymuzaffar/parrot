import { audioContext, Recorder, Sink, TakeFor } from './recorder';
import { Settling } from './settling';

/** The recorder with the microphone stood in for: open at once, settled when the test says, sound when it says. */
function microphone() {
  const recorder = new Recorder();
  const settling = new Settling();
  const ctx = { state: 'running', sampleRate: 48000, close: vi.fn(), resume: vi.fn(async () => {}) };
  const inner = recorder as unknown as Record<string, unknown>;
  inner['open'] = async () => {
    inner['ctx'] = ctx;
    inner['settling'] = settling;
    inner['analyser'] = { fftSize: 4, getByteTimeDomainData: () => {} };
    inner['node'] = { disconnect: () => {} };
    inner['stream'] = { getTracks: () => [] };
  };
  const capture = inner['capture'] as (samples: Float32Array, rate: number) => void;
  return {
    recorder,
    ctx,
    settled: () => (settling as unknown as { finish(): void }).finish(),
    /** a block of sound from the microphone */
    sound: () => capture.call(recorder, new Float32Array(128).fill(0.1), 48000),
    /** a block of a quiet room */
    quiet: () => capture.call(recorder, new Float32Array(128).fill(0.001), 48000),
    capturing: () => inner['capturing'] as boolean,
    /** start a take; the test then lets the microphone open with a timer tick */
    start: (owner: TakeFor, sink?: Sink) => {
      const started = recorder.start(owner, sink);
      started.catch(() => {});
      return started;
    },
  };
}

describe('Recorder', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('records at 48 kHz whatever the microphone runs at, or at its rate where none can be asked for', () => {
    const made: (AudioContextOptions | undefined)[] = [];
    const context = {} as AudioContext;
    expect(audioContext((options) => (made.push(options), context))).toBe(context);
    const refusing = (options?: AudioContextOptions) => {
      made.push(options);
      if (options) throw new DOMException('not supported', 'NotSupportedError');
      return context;
    };
    expect(audioContext(refusing)).toBe(context);
    expect(made).toEqual([{ sampleRate: 48000 }, { sampleRate: 48000 }, undefined]);
  });

  it('a take stopped while the microphone is still preparing gives up quietly and keeps the microphone', async () => {
    const mic = microphone();
    const started = mic.start('word');
    await vi.advanceTimersByTimeAsync(0);
    expect([mic.recorder.preparing(), mic.recorder.owner()]).toEqual([true, 'word']);
    expect((await mic.recorder.stop()).size).toBe(0);
    expect([mic.recorder.preparing(), mic.recorder.owner(), mic.capturing()]).toEqual([false, null, false]);
    // the microphone settles and sound flows afterwards: the start that was under way has nothing to say
    mic.settled();
    await vi.advanceTimersByTimeAsync(0);
    mic.sound();
    await vi.advanceTimersByTimeAsync(3100);
    await expect(started).resolves.toBeUndefined();
    expect([mic.recorder.recording(), mic.ctx.close.mock.calls.length]).toEqual([false, 0]);
  });

  it('a take begun after one was stopped while waiting for sound is untouched by it', async () => {
    const mic = microphone();
    mic.settled();
    const first = mic.start('word');
    await vi.advanceTimersByTimeAsync(0);
    expect(mic.recorder.owner()).toBe('word');
    await mic.recorder.stop();
    const second = mic.start('part');
    await vi.advanceTimersByTimeAsync(0);
    mic.sound();
    await vi.advanceTimersByTimeAsync(0);
    await second;
    expect([mic.recorder.recording(), mic.recorder.owner()]).toEqual([true, 'part']);
    // three seconds on, the first take's wait for sound runs out: nothing happens to the second
    await vi.advanceTimersByTimeAsync(3100);
    await first;
    expect([mic.recorder.recording(), mic.recorder.owner(), mic.capturing()]).toEqual([true, 'part', true]);
    expect(mic.ctx.close).not.toHaveBeenCalled();
    mic.sound();
    const stopping = mic.recorder.stop();
    await vi.advanceTimersByTimeAsync(250);
    expect((await stopping).size).toBeGreaterThan(44);
    expect([mic.recorder.recording(), mic.recorder.owner()]).toEqual([false, null]);
  });

  it('a second Stop in the moment after the first changes nothing', async () => {
    const mic = microphone();
    mic.settled();
    const started = mic.start('part');
    await vi.advanceTimersByTimeAsync(0);
    mic.sound();
    await vi.advanceTimersByTimeAsync(0);
    await started;
    const first = mic.recorder.stop();
    const second = mic.recorder.stop();
    await vi.advanceTimersByTimeAsync(250);
    expect((await second).size).toBe(0);
    expect((await first).size).toBeGreaterThan(44);
    expect(mic.capturing()).toBe(false);
  });

  it('a take with no sound within three seconds fails and lets the microphone go', async () => {
    const mic = microphone();
    mic.settled();
    const started = mic.start('part');
    await vi.advanceTimersByTimeAsync(3000);
    await expect(started).rejects.toThrow('no sound came through');
    expect([mic.recorder.owner(), mic.capturing(), mic.ctx.close.mock.calls.length]).toEqual([null, false, 1]);
  });

  it('sends a talk on in blocks of two seconds as it is recorded, and its last sound when it stops', async () => {
    const mic = microphone();
    mic.settled();
    const sent: number[] = [];
    const started = mic.start('free', (pcm, rate) => sent.push(pcm.length / rate));
    await vi.advanceTimersByTimeAsync(0);
    mic.sound();
    await started;
    expect([mic.recorder.recording(), mic.recorder.owner()]).toEqual([true, 'free']);
    // 3 s of sound: one block sent on, the rest held until it stops
    for (let block = 0; block < 1125; block++) mic.sound();
    expect(sent.map((secs) => secs.toFixed(2))).toEqual(['2.00']);
    const stopping = mic.recorder.stop();
    await vi.advanceTimersByTimeAsync(300);
    expect((await stopping).size).toBe(0);
    expect(sent.reduce((sum, secs) => sum + secs, 0).toFixed(2)).toBe('3.00');
    // the next take of a part is kept whole again
    const part = mic.start('part');
    await vi.advanceTimersByTimeAsync(0);
    mic.sound();
    await part;
    for (let block = 0; block < 10; block++) mic.sound();
    const stopped = mic.recorder.stop();
    await vi.advanceTimersByTimeAsync(300);
    expect((await stopped).size).toBeGreaterThan(44);
    expect(sent).toHaveLength(2);
  });

  it('knows how long a take has gone without sound', async () => {
    const mic = microphone();
    mic.settled();
    expect(mic.recorder.quietFor()).toBe(0);
    const started = mic.start('free', () => {});
    await vi.advanceTimersByTimeAsync(0);
    mic.quiet();
    await started;
    await vi.advanceTimersByTimeAsync(4000);
    mic.quiet();
    expect(mic.recorder.quietFor()).toBeGreaterThanOrEqual(4000);
    mic.sound();
    expect(mic.recorder.quietFor()).toBeLessThan(10);
  });
});
