import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Engine } from './engine';
import { Library } from './library';
import { Playback } from './playback';
import { Recorder } from './recorder';
import { Session } from './session';
import { Settling } from './settling';
import { Talking } from './talking';
import { WordPractice } from './word-practice';

/** The real recorder with the microphone stood in for: open at once, settled when the test says, sound when it says. */
function microphone(recorder: Recorder) {
  const settling = new Settling();
  const inner = recorder as unknown as Record<string, unknown>;
  inner['open'] = async () => {
    inner['ctx'] = { state: 'running', sampleRate: 48000, close: () => {}, resume: async () => {} };
    inner['settling'] = settling;
    inner['analyser'] = { fftSize: 4, getByteTimeDomainData: () => {} };
    inner['node'] = { disconnect: () => {} };
    inner['stream'] = { getTracks: () => [] };
  };
  const capture = inner['capture'] as (samples: Float32Array, rate: number) => void;
  return {
    settled: () => (settling as unknown as { finish(): void }).finish(),
    sound: () => capture.call(recorder, new Float32Array(128).fill(0.1), 48000),
  };
}

/** Let the microphone's waits and the awaits after them run. */
const tick = () => vi.advanceTimersByTimeAsync(0);

describe('starting again while a cancelled start waits for the microphone to settle', () => {
  let recorder: Recorder;
  let mic: ReturnType<typeof microphone>;
  /** the word selected in the open text */
  let selected: ReturnType<typeof signal<number | null>>;

  beforeEach(() => {
    vi.useFakeTimers();
    selected = signal<number | null>(0);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: Engine,
          useValue: {
            talkLeft: async () => null,
            talkStart: async () => {},
            talkFeed: async () => [],
            talkStop: () => new Promise(() => {}),
            wordAttempts: async () => [],
          },
        },
        { provide: Library, useValue: {} },
        {
          provide: Session,
          useValue: { whenOpening() {}, text: signal({ id: 'text' }), words: signal(['Hello', 'there.']), selected },
        },
        { provide: Playback, useValue: { stop() {} } },
      ],
    });
    recorder = TestBed.inject(Recorder);
    mic = microphone(recorder);
  });

  afterEach(() => vi.useRealTimers());

  it('a talk records with its card recording, and Stop stops it', async () => {
    const talking = TestBed.inject(Talking);
    void talking.start();
    await tick();
    expect([talking.state(), recorder.preparing()]).toEqual(['recording', true]);
    // Cancel during "Getting the microphone ready…"
    await talking.stop();
    expect([talking.state(), recorder.owner()]).toEqual(['idle', null]);
    void talking.start();
    await tick();
    // the microphone settles: both starts were waiting on it
    mic.settled();
    await tick();
    mic.sound();
    await tick();
    expect([talking.state(), recorder.recording(), recorder.owner()]).toEqual(['recording', true, 'free']);
    void talking.stop();
    await vi.advanceTimersByTimeAsync(300);
    expect([talking.state(), recorder.recording(), recorder.owner()]).toEqual(['writing', false, null]);
  });

  it("a word's take is not stopped by the start of a word left while the microphone got ready", async () => {
    const practice = TestBed.inject(WordPractice);
    TestBed.tick();
    void practice.toggleRecord();
    await tick();
    expect([recorder.preparing(), recorder.owner()]).toEqual([true, 'word']);
    // another word is clicked: the take of the first one is dropped
    selected.set(1);
    TestBed.tick();
    expect(recorder.owner()).toBeNull();
    void practice.toggleRecord();
    await tick();
    mic.settled();
    await tick();
    mic.sound();
    await tick();
    expect([practice.recording(), recorder.owner()]).toEqual([true, 'word']);
  });
});
