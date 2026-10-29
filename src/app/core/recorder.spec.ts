import { audioContext, MIC_LOST, micError, Recorder, TakeFor, TakeHooks } from './recorder';
import { Settling } from './settling';

/** The recorder with the microphone stood in for: open at once, settled when the test says, sound when it says,
 * unplugged when it says. */
function microphone() {
  const recorder = new Recorder();
  let settling = new Settling();
  const ctx = { state: 'running', sampleRate: 48000, close: vi.fn(), resume: vi.fn(async () => {}) };
  const inner = recorder as unknown as Record<string, unknown>;
  let track = new EventTarget();
  let opens = 0;
  inner['open'] = async () => {
    if (inner['ctx']) return;
    opens++;
    track = new EventTarget();
    const stream = { getTracks: () => [], getAudioTracks: () => [track] };
    inner['ctx'] = ctx;
    inner['settling'] = settling;
    inner['analyser'] = { fftSize: 4, getByteTimeDomainData: () => {} };
    inner['node'] = { disconnect: () => {} };
    inner['stream'] = stream;
    (inner['follow'] as (stream: unknown) => void).call(recorder, stream);
  };
  const capture = inner['capture'] as (samples: Float32Array, rate: number) => void;
  return {
    recorder,
    ctx,
    settled: () => (settling as unknown as { finish(): void }).finish(),
    /** the next open's capture comes up afresh, to settle again */
    unsettle: () => (settling = new Settling()),
    /** the microphone is unplugged */
    unplug: () => track.dispatchEvent(new Event('ended')),
    opens: () => opens,
    /** a block of sound from the microphone */
    sound: () => capture.call(recorder, new Float32Array(128).fill(0.1), 48000),
    /** a block of a quiet room */
    quiet: () => capture.call(recorder, new Float32Array(128).fill(0.001), 48000),
    capturing: () => inner['capturing'] as boolean,
    /** start a take; the test then lets the microphone open with a timer tick */
    start: (owner: TakeFor, hooks?: TakeHooks) => {
      const started = recorder.start(owner, hooks);
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

  describe('opening the microphone ahead of a take', () => {
    beforeEach(() => localStorage.setItem('parrot.mic', 'granted'));
    afterEach(() => localStorage.removeItem('parrot.mic'));

    it('opens it only once the microphone has been allowed, so the permission prompt comes with a take', () => {
      localStorage.removeItem('parrot.mic');
      const mic = microphone();
      mic.recorder.warm();
      expect(mic.opens()).toBe(0);
    });

    it('keeps it open while on the record button, and lets it go soon after leaving with no take begun', async () => {
      const mic = microphone();
      mic.recorder.warm();
      await vi.advanceTimersByTimeAsync(0);
      expect(mic.opens()).toBe(1);
      // still on the button a minute on: open
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mic.ctx.close).not.toHaveBeenCalled();
      mic.recorder.cool();
      await vi.advanceTimersByTimeAsync(4_900);
      expect(mic.ctx.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(mic.ctx.close).toHaveBeenCalledTimes(1);
    });

    it('lets it go after two minutes all the same when the pointer never leaves', async () => {
      const mic = microphone();
      mic.recorder.warm();
      await vi.advanceTimersByTimeAsync(119_000);
      expect(mic.ctx.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_100);
      expect(mic.ctx.close).toHaveBeenCalledTimes(1);
    });

    it('keeps it open its two minutes after a take, for the next one, though the pointer leaves', async () => {
      const mic = microphone();
      mic.settled();
      mic.recorder.warm();
      const started = mic.start('part');
      await vi.advanceTimersByTimeAsync(0);
      mic.sound();
      await started;
      const stopping = mic.recorder.stop();
      await vi.advanceTimersByTimeAsync(250);
      await stopping;
      mic.recorder.cool();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mic.ctx.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_100);
      expect([mic.opens(), mic.ctx.close.mock.calls.length]).toEqual([1, 1]);
    });

    it('leaves a take under way alone', async () => {
      const mic = microphone();
      mic.settled();
      const started = mic.start('part');
      await vi.advanceTimersByTimeAsync(0);
      mic.sound();
      await started;
      mic.recorder.cool();
      await vi.advanceTimersByTimeAsync(10_000);
      expect([mic.recorder.recording(), mic.ctx.close.mock.calls.length]).toEqual([true, 0]);
    });
  });

  it('says a take is getting ready from the click until it records, or until it gives up', async () => {
    const mic = microphone();
    const started = mic.start('part');
    // the microphone still opening
    expect([mic.recorder.preparing(), mic.recorder.recording()]).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(0);
    mic.settled();
    await vi.advanceTimersByTimeAsync(0);
    // settled, and waiting for its first sound
    expect([mic.recorder.preparing(), mic.recorder.recording()]).toEqual([true, false]);
    mic.sound();
    await started;
    expect([mic.recorder.preparing(), mic.recorder.recording()]).toEqual([false, true]);
    const stopping = mic.recorder.stop();
    await vi.advanceTimersByTimeAsync(300);
    await stopping;
    // no sound comes through
    const silent = mic.start('part');
    expect(mic.recorder.preparing()).toBe(true);
    await vi.advanceTimersByTimeAsync(3100);
    await expect(silent).rejects.toThrow('no sound came through');
    expect([mic.recorder.preparing(), mic.recorder.owner()]).toEqual([false, null]);
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
    const started = mic.start('free', { sink: (pcm, rate) => sent.push(pcm.length / rate) });
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
    const started = mic.start('free', { sink: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    mic.quiet();
    await started;
    await vi.advanceTimersByTimeAsync(4000);
    mic.quiet();
    expect(mic.recorder.quietFor()).toBeGreaterThanOrEqual(4000);
    mic.sound();
    expect(mic.recorder.quietFor()).toBeLessThan(10);
  });

  it('a take recorded when the microphone goes ends and says so, and the next take opens a microphone again', async () => {
    const mic = microphone();
    mic.settled();
    const lost = vi.fn();
    const started = mic.start('part', { lost });
    await vi.advanceTimersByTimeAsync(0);
    mic.sound();
    await started;
    expect(mic.recorder.recording()).toBe(true);
    mic.unplug();
    expect(lost).toHaveBeenCalledOnce();
    expect([mic.recorder.recording(), mic.recorder.owner(), mic.capturing(), mic.ctx.close.mock.calls.length]).toEqual([
      false,
      null,
      false,
      1,
    ]);
    // the next take asks for the microphone again, rather than taking silence from the one gone
    const next = mic.start('part');
    await vi.advanceTimersByTimeAsync(0);
    mic.sound();
    await next;
    expect([mic.opens(), mic.recorder.recording()]).toEqual([2, true]);
  });

  it('a talk keeps what was said up to the moment the microphone went', async () => {
    const mic = microphone();
    mic.settled();
    const sent: number[] = [];
    const lost = vi.fn();
    const started = mic.start('free', { sink: (pcm) => sent.push(pcm.length), lost });
    await vi.advanceTimersByTimeAsync(0);
    mic.sound();
    await started;
    for (let block = 0; block < 9; block++) mic.sound();
    mic.unplug();
    expect([sent, lost.mock.calls.length, mic.recorder.owner()]).toEqual([[1280], 1, null]);
  });

  it('a take getting ready when the microphone goes fails at once, saying so', async () => {
    const mic = microphone();
    mic.unsettle();
    const lost = vi.fn();
    const started = mic.start('word', { lost });
    await vi.advanceTimersByTimeAsync(0);
    expect(mic.recorder.preparing()).toBe(true);
    mic.unplug();
    const error = await started.catch((thrown: unknown) => thrown);
    expect(micError(error)).toBe(MIC_LOST);
    expect([lost.mock.calls.length, mic.recorder.preparing(), mic.recorder.owner(), mic.capturing()]).toEqual([0, false, null, false]);
  });

  it('a take being stopped when the microphone goes is kept, and one not under way is untouched by it', async () => {
    const mic = microphone();
    mic.settled();
    const lost = vi.fn();
    const started = mic.start('part', { lost });
    await vi.advanceTimersByTimeAsync(0);
    mic.sound();
    await started;
    mic.sound();
    const stopping = mic.recorder.stop();
    mic.unplug();
    await vi.advanceTimersByTimeAsync(250);
    expect((await stopping).size).toBeGreaterThan(44);
    expect([lost.mock.calls.length, mic.ctx.close.mock.calls.length]).toEqual([0, 1]);
    // the microphone kept open between takes is let go, so the next take opens one again
    const next = mic.start('word');
    await vi.advanceTimersByTimeAsync(0);
    mic.sound();
    await next;
    const stopped = mic.recorder.stop();
    await vi.advanceTimersByTimeAsync(250);
    await stopped;
    mic.unplug();
    expect([mic.opens(), mic.ctx.close.mock.calls.length, lost.mock.calls.length]).toEqual([2, 2, 0]);
    const third = mic.start('part');
    await vi.advanceTimersByTimeAsync(0);
    expect(mic.opens()).toBe(3);
    mic.sound();
    await third;
  });
});
