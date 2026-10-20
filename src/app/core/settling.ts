/** zero blocks in a row that make the dropout (about 25 ms; a stray one or two happen on their own) */
const DROPOUT_BLOCKS = 6;
/** zeros this soon after the first sound are the capture starting, not the switch */
const IGNORE_FIRST_MS = 500;
/** with no dropout seen, settled after this long */
export const SETTLE_MAX_MS = 5000;

/**
 * When a freshly opened microphone can be recorded from. On macOS the capture comes up quiet and a few seconds in
 * switches to its real level, 25 dB louder, with a short dropout of exact zeros at the switch: a take begun before it
 * has its first words far under the rest, and often lost. Settled at that dropout, or after SETTLE_MAX_MS.
 */
export class Settling {
  settled = false;
  private firstAt: number | null = null;
  private zeroBlocks = 0;
  private waiting: (() => void)[] = [];

  /** Each block of samples as it comes from the microphone, and the time it came (ms). */
  block(samples: Float32Array, now: number) {
    if (this.settled) return;
    this.firstAt ??= now;
    this.zeroBlocks = samples.every((sample) => sample === 0) ? this.zeroBlocks + 1 : 0;
    const dropout = this.zeroBlocks >= DROPOUT_BLOCKS && now - this.firstAt >= IGNORE_FIRST_MS;
    if (dropout || now - this.firstAt >= SETTLE_MAX_MS) this.finish();
  }

  done(): Promise<void> {
    return this.settled ? Promise.resolve() : new Promise((resolve) => this.waiting.push(resolve));
  }

  private finish() {
    this.settled = true;
    for (const resolve of this.waiting) resolve();
    this.waiting = [];
  }
}
