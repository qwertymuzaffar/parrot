import { TestBed } from '@angular/core/testing';
import { Clips } from './clips';
import { Engine } from './engine';
import { Attempt } from './models';
import { Playback } from './playback';
import { Sound } from './sound';

/** An audio element that plays nothing: it starts at once, unless a test holds its start back to make it fail. */
class FakeAudio {
  src = '';
  paused = true;
  currentTime = 0;
  onended: (() => void) | null = null;
  /** fail the start held back (as a browser does when the source changes before it began) */
  failStart: (() => void) | null = null;
  holdStart = false;

  play() {
    this.paused = false;
    if (!this.holdStart) return Promise.resolve();
    return new Promise<void>((_resolve, reject) => (this.failStart = () => reject(new DOMException('replaced', 'AbortError'))));
  }
  pause() {
    this.paused = true;
  }
}

describe('sound', () => {
  let audios: FakeAudio[];
  /** let pending promises settle */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** whether a promise has settled by now */
  async function over(promise: Promise<unknown>) {
    let settled = false;
    promise.then(() => (settled = true));
    await settle();
    return settled;
  }

  beforeEach(() => {
    audios = [];
    vi.stubGlobal(
      'Audio',
      class extends FakeAudio {
        constructor() {
          super();
          audios.push(this);
        }
      },
    );
    vi.stubGlobal('speechSynthesis', { getVoices: () => [], cancel() {}, speak() {}, onvoiceschanged: null });
  });

  afterEach(() => vi.unstubAllGlobals());

  describe('a word clip', () => {
    let sound: Sound;
    /** the element clips play in (the first is for whole takes) */
    const clipAudio = () => audios[1];

    beforeEach(() => (sound = TestBed.inject(Sound)));

    it('ends when it plays out', async () => {
      const playing = sound.playClip('blob:word');
      clipAudio().onended?.();
      expect(await over(playing)).toBe(true);
    });

    it('ends when it is stopped, so whoever waits on it can clean up', async () => {
      const playing = sound.playClip('blob:word');
      sound.stop();
      expect(await over(playing)).toBe(true);
    });

    it('ends when anything else is played', async () => {
      const first = sound.playClip('blob:first');
      const second = sound.playClip('blob:second');
      expect(await over(first)).toBe(true);
      sound.play('audio:take.wav', 'mine');
      expect(await over(second)).toBe(true);
    });

    it("that fails to start once the next has begun doesn't end the next", async () => {
      clipAudio().holdStart = true;
      sound.playClip('blob:first');
      const failFirst = clipAudio().failStart!;
      clipAudio().holdStart = false;
      const second = sound.playClip('blob:second');
      failFirst();
      expect(await over(second)).toBe(false);
    });
  });

  describe('a word cut from my take', () => {
    const take: Attempt = {
      id: 't1',
      when: '2026-10-20T12:00:00',
      text: 'How are you?',
      heard: 'How are you?',
      words: ['How', 'are', 'you?'].map((word, wordIndex) => ({
        w: word,
        t: [wordIndex * 0.5, wordIndex * 0.5 + 0.4] as [number, number],
        score: 0.9,
        ref: null,
        status: 'good' as const,
        heard: null,
        extra: '',
      })),
      duration: 2,
      wpm: 140,
      score: 70,
      audio: 't1.wav',
    };
    let freed: string[];
    let revoke: typeof URL.revokeObjectURL;

    beforeEach(() => {
      freed = [];
      revoke = URL.revokeObjectURL;
      URL.revokeObjectURL = (url: string) => freed.push(url);
      let cuts = 0;
      TestBed.configureTestingModule({
        providers: [
          { provide: Engine, useValue: { audioUrl: (path: string) => `audio:${path}` } },
          { provide: Clips, useValue: { cut: async () => `blob:cut-${++cuts}` } },
        ],
      });
    });

    afterEach(() => (URL.revokeObjectURL = revoke));

    it('is freed when stopped, or cut short by the next', async () => {
      const playback = TestBed.inject(Playback);
      playback.playMyWord(take, 1);
      await settle();
      playback.playMyWord(take, 2);
      await settle();
      expect([freed, playback.nowMine()]).toEqual([['blob:cut-1'], 2]);
      playback.stop();
      await settle();
      expect([freed, playback.nowMine()]).toEqual([['blob:cut-1', 'blob:cut-2'], null]);
    });
  });
});
