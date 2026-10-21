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

/** Who a take is recorded for: the part being practised (a sentence take), the word selected, said alone, or a talk
 * (speech with no text, sent on to the engine as it is recorded). */
export type TakeFor = 'part' | 'word' | 'free';

/** Where a talk's sound goes as it is recorded: 16-bit samples at the microphone's rate. */
export type Sink = (pcm: Int16Array, rate: number) => void;

/** What to say when the microphone would not start. */
export const micError = (error: unknown) => `No microphone: ${(error as Error).message}. Allow Parrot to use the microphone.`;

/** how long a take goes on after Stop is clicked */
const AFTER_STOP_MS = 250;
/** how long the microphone stays open with nothing recorded and no one about, before it is let go */
const IDLE_MS = 120_000;

/** a talk is sent on in blocks this long */
const SINK_MS = 2000;
/** a sample at least this loud (about -30 dBFS) is sound, not a quiet room */
const SOUND_PEAK = 0.03;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Float samples as 16-bit ones. */
function pcm16(blocks: Float32Array[]) {
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const pcm = new Int16Array(total);
  let at = 0;
  for (const block of blocks) {
    for (let sampleIndex = 0; sampleIndex < block.length; sampleIndex++) {
      pcm[at + sampleIndex] = Math.max(-1, Math.min(1, block[sampleIndex])) * 32767;
    }
    at += block.length;
  }
  return pcm;
}

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
  /** counts takes: stop(), or a newer start(), moves it on, and a start() still under way then gives up quietly */
  private take = 0;
  private stopping = false;
  private blocks: Float32Array[] = [];
  /** the last half second before the take started, so a word begun right on the click is kept */
  private preroll: Float32Array[] = [];
  private flowing: (() => void) | null = null;
  /** a talk's sound goes here as it is recorded, instead of into blocks */
  private sink: Sink | null = null;
  /** the talk's sound not yet sent on */
  private pending: Float32Array[] = [];
  private pendingSamples = 0;
  /** when the take last had sound in it (performance.now()) */
  private lastSound = 0;

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
    const stream = this.stream;
    try {
      const url = URL.createObjectURL(new Blob([CAPTURE], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'parrot-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
      this.settling = new Settling();
      node.port.onmessage = (event: MessageEvent<Float32Array>) => this.capture(event.data, ctx.sampleRate);
      source.connect(node);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      source.connect(this.analyser);
      this.ctx = ctx;
      this.node = node;
    } catch (error) {
      // the microphone light would otherwise stay on with nothing listening
      stream.getTracks().forEach((track) => track.stop());
      ctx.close();
      this.stream = this.settling = this.analyser = null;
      throw error;
    }
    this.device.set(stream.getAudioTracks()[0]?.label ?? '');
  }

  /** Each block of samples from the microphone: into the take, or into the half second kept before one. */
  private capture(samples: Float32Array, rate: number) {
    this.settling?.block(samples, performance.now());
    if (this.capturing) {
      if (samples.some((sample) => sample >= SOUND_PEAK || sample <= -SOUND_PEAK)) this.lastSound = performance.now();
      if (this.sink) {
        this.pending.push(samples);
        this.pendingSamples += samples.length;
        if (this.pendingSamples >= (rate * SINK_MS) / 1000) this.send(rate);
      } else {
        this.blocks.push(samples);
      }
      this.flowing?.();
      this.flowing = null;
    } else {
      this.preroll.push(samples);
      let buffered = this.preroll.reduce((sum, block) => sum + block.length, 0);
      while (buffered - this.preroll[0].length > rate / 2) buffered -= this.preroll.shift()!.length;
    }
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
    clearInterval(this.timer);
    this.node?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.ctx?.close();
    this.ctx = this.node = this.analyser = this.stream = this.settling = null;
    this.preroll = [];
  }

  /** How long the take has gone without sound (ms): a talk stops itself after a long quiet. */
  quietFor() {
    return this.recording() ? performance.now() - this.lastSound : 0;
  }

  /** Send on the talk's sound recorded so far. */
  private send(rate: number) {
    if (!this.pending.length) return;
    const pcm = pcm16(this.pending);
    this.pending = [];
    this.pendingSamples = 0;
    this.sink?.(pcm, rate);
  }

  /** Start a take for `owner`. A talk (`free`) gives `sink` its sound as it is recorded, from the half second before. */
  async start(owner: TakeFor, sink?: Sink): Promise<void> {
    if (this.capturing) return; // a second click while the microphone opens
    const take = ++this.take;
    clearTimeout(this.idle);
    this.capturing = true;
    this.owner.set(owner);
    try {
      await this.open();
      if (take !== this.take) return;
      // the capture comes up quiet and switches to its real level a few seconds in: a take must not start before
      if (!this.settling!.settled) {
        this.preparing.set(true);
        await Promise.race([this.settling!.done(), sleep(SETTLE_MAX_MS + 1000)]);
        this.preparing.set(false);
        if (take !== this.take) return;
      }
      // a resume WebKit never answers would otherwise hold the take for good
      const ctx = this.ctx!;
      if (ctx.state !== 'running') await Promise.race([ctx.resume(), sleep(3000)]);
      if (take !== this.take) return;
    } catch (error) {
      if (take === this.take) this.giveUp();
      throw error;
    }
    // the take begins with the half second before the click, and shows as recording once sound arrives
    if (sink) {
      this.sink = sink;
      this.pending = [...this.preroll];
      this.pendingSamples = this.pending.reduce((sum, block) => sum + block.length, 0);
      this.blocks = [];
    } else {
      this.blocks = [...this.preroll];
    }
    this.preroll = [];
    const arrived = new Promise<boolean>((resolve) => (this.flowing = () => resolve(true)));
    const sound = await Promise.race([arrived, sleep(3000).then(() => false)]);
    if (take !== this.take) return;
    if (!sound) {
      // recording on would only make a silent take: say so now rather than after it
      this.giveUp();
      this.close();
      throw new Error('no sound came through');
    }

    const analyser = this.analyser!;
    const buf = new Uint8Array(analyser.fftSize);
    const t0 = performance.now();
    this.lastSound = t0;
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

  /** A take that never got going is as if it had not been started; the microphone stays open. */
  private giveUp() {
    this.capturing = false;
    this.owner.set(null);
    this.preparing.set(false);
    this.flowing = null;
    this.blocks = [];
    this.sink = null;
    this.pending = [];
    this.pendingSamples = 0;
  }

  /** Stop and return the take as a WAV file. A take stopped before it got going gives nothing, at once. */
  async stop(): Promise<Blob> {
    if (!this.capturing || this.stopping) return new Blob();
    if (!this.recording()) {
      // still opening the microphone or waiting for it to settle: the start under way gives up when it next looks
      this.take++;
      this.giveUp();
      this.idle = window.setTimeout(() => this.close(), IDLE_MS);
      return new Blob();
    }
    this.stopping = true;
    clearInterval(this.timer);
    this.recording.set(false);
    this.level.set(0);
    // keep listening a moment after the click: a take stopped right as a word ends would lose its last sound, and a
    // short word with it (the owner stays set, so no other take starts meanwhile)
    await sleep(AFTER_STOP_MS);
    this.capturing = false;
    this.stopping = false;
    const rate = this.ctx!.sampleRate;
    this.owner.set(null);
    this.idle = window.setTimeout(() => this.close(), IDLE_MS);
    if (this.sink) {
      // a talk: its last sound goes on, and there is nothing to give back
      this.send(rate);
      this.sink = null;
      return new Blob();
    }
    const pcm = pcm16(this.blocks);
    this.blocks = [];
    return wav(pcm, rate);
  }
}
