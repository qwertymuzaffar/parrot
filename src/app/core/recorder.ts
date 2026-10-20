import { Injectable, signal } from '@angular/core';
import { wav } from './clips';
import { readSetting, writeSetting } from './settings';
import { Settling, SETTLE_MAX_MS } from './settling';

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
/** how long the microphone stays open with nothing recorded and no one about, before it is let go */
const IDLE_MS = 120_000;

/**
 * The microphone: one take at a time, with its length and a level for the meter. A take is plain PCM made into a
 * WAV file, the same on every system (no browser codec to decode in the engine).
 */
@Injectable({ providedIn: 'root' })
export class Recorder {
  readonly recording = signal(false);
  /** a take is waiting for the microphone to settle (see Settling) */
  readonly preparing = signal(false);
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
  private opening: Promise<void> | null = null;
  private settling: Settling | null = null;
  private lastWarm = 0;
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
  private open(): Promise<void> {
    if (this.ctx) return Promise.resolve();
    this.opening ??= this.openNow().finally(() => (this.opening = null));
    return this.opening;
  }

  private async openNow(): Promise<void> {
    // made and resumed while the click still counts: after waiting for the microphone (a second or more, longer with
    // the permission prompt) WebKit keeps a new audio context suspended, and nothing would be recorded
    const ctx = new AudioContext();
    // not awaited: a resume that isn't allowed may never settle, and start() gives up when no sound arrives
    ctx.resume().catch(() => {});
    try {
      // with the browser's gain control and noise suppression, which the engine's thresholds were set with; without
      // them the noise floor came out 8 dB higher, and the quiet start of a take is the capture coming up (Settling),
      // not them
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (error) {
      ctx.close();
      throw error;
    }
    writeSetting('mic', 'granted');
    const url = URL.createObjectURL(new Blob([CAPTURE], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const source = ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(ctx, 'parrot-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
    const settling = new Settling();
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      settling.block(event.data, performance.now());
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
    this.settling = settling;
    this.device.set(this.stream.getAudioTracks()[0]?.label ?? '');
  }

  /** Open the microphone ahead of a take, so it has settled by the time one starts: on opening a text, and whenever
   * the user does something while practising. Only once the microphone has been allowed, so the permission prompt
   * comes with the first take, not with opening a text. */
  warm() {
    if (this.capturing) return;
    const now = performance.now();
    if (this.ctx && now - this.lastWarm < 10_000) return;
    if (readSetting<'granted' | ''>('mic', '') !== 'granted') return;
    this.lastWarm = now;
    clearTimeout(this.idle);
    this.idle = window.setTimeout(() => this.close(), IDLE_MS);
    this.open().catch(() => {});
  }

  /** Let the microphone go (the system's microphone light turns off). */
  private close() {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.ctx?.close();
    this.ctx = this.node = this.analyser = this.stream = this.settling = null;
    this.preroll = [];
  }

  async start(owner: TakeFor): Promise<void> {
    if (this.capturing) return; // a second click while the microphone opens
    clearTimeout(this.idle);
    this.capturing = true;
    this.owner.set(owner);
    try {
      await this.open();
      // the capture comes up quiet and switches to its real level a few seconds in: a take must not start before
      if (!this.settling!.settled) {
        this.preparing.set(true);
        await Promise.race([this.settling!.done(), new Promise((resolve) => setTimeout(resolve, SETTLE_MAX_MS + 1000))]);
      }
    } catch (error) {
      this.capturing = false;
      this.owner.set(null);
      throw error;
    } finally {
      this.preparing.set(false);
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
    this.idle = window.setTimeout(() => this.close(), IDLE_MS);
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
