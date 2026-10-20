import { Recorder, TakeFor } from './recorder';
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
    capturing: () => inner['capturing'] as boolean,
    /** start a take; the test then lets the microphone open with a timer tick */
    start: (owner: TakeFor) => {
      const started = recorder.start(owner);
      started.catch(() => {});
      return started;
    },
  };
}

describe('Recorder', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

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
});
