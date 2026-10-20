import { SETTLE_MAX_MS, Settling } from './settling';

const noise = () => new Float32Array(128).map(() => Math.random() * 0.01 - 0.005);
const zeros = () => new Float32Array(128);

/** `count` blocks of `kind` from time `from`, 2.67 ms apart as at 48 kHz */
const feed = (settling: Settling, kind: () => Float32Array, count: number, from: number) => {
  for (let index = 0; index < count; index++) settling.block(kind(), from + index * 2.67);
  return from + count * 2.67;
};

describe('Settling', () => {
  it('settles at the dropout that comes with the switch to the real level', () => {
    const settling = new Settling();
    let now = feed(settling, noise, 400, 1000); // about a second of sound
    expect(settling.settled).toBe(false);
    now = feed(settling, zeros, 6, now);
    expect(settling.settled).toBe(true);
  });

  it('ignores a stray zero block or two, and zeros as the capture starts', () => {
    const settling = new Settling();
    let now = feed(settling, zeros, 20, 1000); // the capture starting with zeros
    now = feed(settling, noise, 400, now);
    now = feed(settling, zeros, 2, now);
    now = feed(settling, noise, 10, now);
    expect(settling.settled).toBe(false);
    feed(settling, zeros, 6, now);
    expect(settling.settled).toBe(true);
  });

  it('settles on its own after a while without a dropout', () => {
    const settling = new Settling();
    feed(settling, noise, 100, 1000);
    settling.block(noise(), 1000 + SETTLE_MAX_MS - 1);
    expect(settling.settled).toBe(false);
    settling.block(noise(), 1000 + SETTLE_MAX_MS);
    expect(settling.settled).toBe(true);
  });

  it('lets a take wait for it', async () => {
    const settling = new Settling();
    let done = false;
    const waited = settling.done().then(() => (done = true));
    feed(settling, noise, 400, 1000);
    expect(done).toBe(false);
    feed(settling, zeros, 6, 3000);
    await waited;
    expect(done).toBe(true);
    await settling.done(); // resolved at once from then on
  });
});
