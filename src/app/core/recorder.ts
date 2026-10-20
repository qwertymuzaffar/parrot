import { Injectable, signal } from '@angular/core';
import { wav } from './clips';

/** Collects the microphone's samples on the audio thread and posts them in blocks. */
const CAPTURE = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('parrot-capture', Capture);
`;

/** Who a take is recorded for: the part being practised (a sentence take) or the word selected, said alone. */
export type TakeFor = 'part' | 'word';

/** What to say when the microphone would not start. */
export const micError = (error: unknown) => `No microphone: ${(error as Error).message}. Allow Parrot to use the microphone.`;

/** how long a take goes on after Stop is clicked */
const AFTER_STOP_MS = 250;

/**
 * The microphone: one take at a time, with its length and a level for the meter. A take is plain PCM made into a
 * WAV file, the same on every system (no browser codec to decode in the engine).
 */
@Injectable({ providedIn: 'root' })
export class Recorder {
  readonly recording = signal(false);
  /** who the take is for, from the click that starts it until it stops: only they stop it */
  readonly owner = signal<TakeFor | null>(null);
  readonly elapsed = signal(0);
  /** 0-1, the loudest sample of the last few milliseconds */
  readonly level = signal(0);
  /** the level every 100 ms of the take so far, for the live waveform */
  readonly trace = signal<number[]>([]);
  /** the microphone's name, once the browser has told us */
  readonly device = signal('');

  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private timer = 0;
  private idle = 0;
  private capturing = false;
  private blocks: Float32Array[] = [];
  /** the last half second before the take started, so a word begun right on the click is kept */
  private preroll: Float32Array[] = [];
  private flowing: (() => void) | null = null;

  /** Open the microphone and the capture (the slow part, a second or more the first time); it then stays open for
   * two minutes after a take, so the next take starts at once. */
  private async open(): Promise<void> {
    if (this.ctx) return;
    // made and resumed while the click still counts: after waiting for the microphone (a second or more, longer with
    // the permission prompt) WebKit keeps a new audio context suspended, and nothing would be recorded
    const ctx = new AudioContext();
    // not awaited: a resume that isn't allowed may never settle, and start() gives up when no sound arrives
    ctx.resume().catch(() => {});
    try {
      // the microphone as it is: the engine evens out a take's level and filters its rumble itself, while the
      // browser's gain control and noise suppression adapt as they go, so a take right after the microphone opens
      // came out 25 dB quieter for its first seconds, then cut out and jumped to full level
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
    } catch (error) {
      ctx.close();
      throw error;
    }
    const url = URL.createObjectURL(new Blob([CAPTURE], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const source = ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(ctx, 'parrot-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (this.capturing) {
        this.blocks.push(event.data);
        this.flowing?.();
        this.flowing = null;
      } else {
        this.preroll.push(event.data);
        let buffered = this.preroll.reduce((sum, block) => sum + block.length, 0);
        while (buffered - this.preroll[0].length > ctx.sampleRate / 2) buffered -= this.preroll.shift()!.length;
      }
    };
    source.connect(node);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    source.connect(this.analyser);
    this.ctx = ctx;
    this.node = node;
    this.device.set(this.stream.getAudioTracks()[0]?.label ?? '');
  }

  /** Let the microphone go (the system's microphone light turns off). */
  private close() {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.ctx?.close();
    this.ctx = this.node = this.analyser = this.stream = null;
    this.preroll = [];
  }

  async start(owner: TakeFor): Promise<void> {
    if (this.capturing) return; // a second click while the microphone opens
    clearTimeout(this.idle);
    this.capturing = true;
    this.owner.set(owner);
    try {
      await this.open();
    } catch (error) {
      this.capturing = false;
      this.owner.set(null);
      throw error;
    }
    const ctx = this.ctx!;
    if (ctx.state !== 'running') await ctx.resume();
    // the take begins with the half second before the click, and shows as recording once sound arrives
    this.blocks = [...this.preroll];
    this.preroll = [];
    const arrived = new Promise<boolean>((resolve) => (this.flowing = () => resolve(true)));
    if (!(await Promise.race([arrived, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))]))) {
      // recording on would only make a silent take: say so now rather than after it
      this.capturing = false;
      this.owner.set(null);
      this.flowing = null;
      this.close();
      throw new Error('no sound came through');
    }

    const analyser = this.analyser!;
    const buf = new Uint8Array(analyser.fftSize);
    const t0 = performance.now();
    let peak100 = 0;
    let last = t0;
    this.trace.set([]);
    this.recording.set(true);
    this.timer = window.setInterval(() => {
      this.elapsed.set((performance.now() - t0) / 1000);
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const sample of buf) peak = Math.max(peak, Math.abs(sample - 128));
      const level = Math.min(1, peak / 100);
      this.level.set(level);
      peak100 = Math.max(peak100, level);
      if (performance.now() - last >= 100) {
        this.trace.update((trace) => [...trace, peak100]);
        peak100 = 0;
        last = performance.now();
      }
    }, 25);
  }

  /** Stop and return the take as a WAV file. */
  async stop(): Promise<Blob> {
    if (!this.ctx || !this.capturing) return new Blob();
    clearInterval(this.timer);
    this.recording.set(false);
    this.level.set(0);
    // keep listening a moment after the click: a take stopped right as a word ends would lose its last sound, and a
    // short word with it (the owner stays set, so no other take starts meanwhile)
    await new Promise((resolve) => setTimeout(resolve, AFTER_STOP_MS));
    this.capturing = false;
    const rate = this.ctx.sampleRate;
    this.owner.set(null);
    this.idle = window.setTimeout(() => this.close(), 120_000);
    const total = this.blocks.reduce((sum, block) => sum + block.length, 0);
    const pcm = new Int16Array(total);
    let at = 0;
    for (const block of this.blocks) {
      for (let sampleIndex = 0; sampleIndex < block.length; sampleIndex++) {
        pcm[at + sampleIndex] = Math.max(-1, Math.min(1, block[sampleIndex])) * 32767;
      }
      at += block.length;
    }
    this.blocks = [];
    return wav(pcm, rate);
  }
}
