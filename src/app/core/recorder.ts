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

/**
 * The microphone: one take at a time, with its length and a level for the meter. A take is plain PCM made into a
 * WAV file, the same on every system (no browser codec to decode in the engine).
 */
@Injectable({ providedIn: 'root' })
export class Recorder {
  readonly recording = signal(false);
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
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const ctx = new AudioContext();
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

  async start(): Promise<void> {
    if (this.capturing) return; // a second click while the microphone opens
    clearTimeout(this.idle);
    this.capturing = true;
    try {
      await this.open();
    } catch (error) {
      this.capturing = false;
      throw error;
    }
    const ctx = this.ctx!;
    if (ctx.state !== 'running') await ctx.resume();
    // the take begins with the half second before the click, and shows as recording once sound arrives
    this.blocks = [...this.preroll];
    this.preroll = [];
    const arrived = new Promise<void>((resolve) => (this.flowing = resolve));
    await Promise.race([arrived, new Promise((resolve) => setTimeout(resolve, 3000))]);

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
    // let the last block arrive from the audio thread
    await new Promise((resolve) => setTimeout(resolve, 60));
    this.capturing = false;
    const rate = this.ctx.sampleRate;
    this.recording.set(false);
    this.level.set(0);
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
