import { inject, Injectable } from '@angular/core';
import { Engine } from './engine';

/** The decoded audio kept at most, in samples (4 bytes each): about 60 MB, five minutes at 48 kHz. A take decodes
 * at the device's rate, so a whole text read for a few minutes weighs as much as a hundred sentences. */
const CACHED_SAMPLES = 15_000_000;

/**
 * Takes as audio the interface can cut: the loudness for the waveform, and a single word cut out exactly, slowed
 * down without lowering the pitch. The engine reads them from the recording when it can (a long talk is never
 * decoded in the window); otherwise (the browser demo) takes are decoded here, and cached (a few at most are in use
 * at a time).
 */
@Injectable({ providedIn: 'root' })
export class Clips {
  private engine = inject(Engine);
  private ctx: AudioContext | null = null;
  private cache = new Map<string, Promise<AudioBuffer>>();
  /** the samples of each take decoded and still cached, oldest first */
  private samples = new Map<string, number>();

  private decode(url: string): Promise<AudioBuffer> {
    let decoded = this.cache.get(url);
    if (!decoded) {
      this.ctx ??= new AudioContext();
      const ctx = this.ctx;
      decoded = fetch(url)
        .then((response) => response.arrayBuffer())
        .then((bytes) => ctx.decodeAudioData(bytes));
      decoded.then(
        (buffer) => this.keep(url, buffer),
        () => this.cache.delete(url),
      );
      this.cache.set(url, decoded);
    }
    return decoded;
  }

  /** Count a decoded take, and drop the oldest while the cache holds too much (never the take just decoded). */
  private keep(url: string, buffer: AudioBuffer) {
    this.samples.set(url, buffer.length * buffer.numberOfChannels);
    let total = [...this.samples.values()].reduce((sum, count) => sum + count, 0);
    for (const [oldUrl, count] of this.samples) {
      if (total <= CACHED_SAMPLES || oldUrl === url) break;
      this.samples.delete(oldUrl);
      this.cache.delete(oldUrl);
      total -= count;
    }
  }

  /** The loudest sample of each of sliceCount equal slices of a recording (a take's audio), scaled so the loudest
   * slice is 1. */
  async peaks(audio: string, sliceCount: number): Promise<number[]> {
    const drawn = await this.engine.peaks(audio, sliceCount);
    if (drawn) return drawn;
    const data = (await this.decode(this.engine.audioUrl(audio))).getChannelData(0);
    const size = Math.max(1, Math.floor(data.length / sliceCount));
    const out: number[] = [];
    for (let sliceIndex = 0; sliceIndex < sliceCount; sliceIndex++) {
      let loudest = 0;
      const sliceEnd = Math.min(data.length, (sliceIndex + 1) * size);
      for (let sampleIndex = sliceIndex * size; sampleIndex < sliceEnd; sampleIndex++) {
        loudest = Math.max(loudest, Math.abs(data[sampleIndex]));
      }
      out.push(loudest);
    }
    const top = Math.max(...out) || 1;
    return out.map((peak) => peak / top);
  }

  /** A stretch of a recording (a take's audio) as a WAV file (an object URL): played with playbackRate below 1 and
   * pitch preserved, it slows down without the voice dropping, and it stops exactly where the word ends. */
  async cut(audio: string, from: number, to: number): Promise<string> {
    const clip = await this.engine.clip(audio, from, to);
    if (clip)
      return shaped(
        Float32Array.from(clip.samples, (sample) => sample / 32768),
        clip.rate,
      );
    const buf = await this.decode(this.engine.audioUrl(audio));
    const rate = buf.sampleRate;
    const firstSample = Math.max(0, Math.floor(from * rate));
    const endSample = Math.min(buf.length, Math.ceil(to * rate));
    return shaped(buf.getChannelData(0).subarray(firstSample, endSample), rate);
  }
}

/** A word's samples as a WAV file (an object URL), faded in and out so it doesn't click, with a little silence after
 * so the end isn't clipped. */
function shaped(src: Float32Array, rate: number) {
  const fade = Math.min(Math.floor(rate * 0.012), Math.floor(src.length / 4));
  const pcm = new Int16Array(src.length + Math.floor(rate * 0.05));
  for (let sampleIndex = 0; sampleIndex < src.length; sampleIndex++) {
    const gain = sampleIndex < fade ? sampleIndex / fade : sampleIndex > src.length - fade ? (src.length - sampleIndex) / fade : 1;
    pcm[sampleIndex] = Math.max(-1, Math.min(1, src[sampleIndex] * gain)) * 32767;
  }
  return URL.createObjectURL(wav(pcm, rate));
}

/** 16-bit mono PCM as a WAV file. */
export function wav(pcm: Int16Array, rate: number): Blob {
  const head = new DataView(new ArrayBuffer(44));
  const text = (offset: number, label: string) =>
    [...label].forEach((char, charIndex) => head.setUint8(offset + charIndex, char.charCodeAt(0)));
  text(0, 'RIFF');
  head.setUint32(4, 36 + pcm.byteLength, true);
  text(8, 'WAVEfmt ');
  head.setUint32(16, 16, true);
  head.setUint16(20, 1, true);
  head.setUint16(22, 1, true);
  head.setUint32(24, rate, true);
  head.setUint32(28, rate * 2, true);
  head.setUint16(32, 2, true);
  head.setUint16(34, 16, true);
  text(36, 'data');
  head.setUint32(40, pcm.byteLength, true);
  return new Blob([head, pcm.buffer as ArrayBuffer], { type: 'audio/wav' });
}
