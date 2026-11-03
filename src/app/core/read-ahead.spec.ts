import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Engine, EngineError, KOKORO_VOICES } from './engine';
import { Part } from './models';
import { Playback } from './playback';
import { plan, ReadAhead } from './read-ahead';
import { Recorder } from './recorder';
import { Sound, Voice } from './sound';

const part = (label: string, text: string): Part => ({ label, text, sub: false, w0: 0, key: text });
const PARTS = [part('1', 'One.'), part('2', 'Two.'), part('3', 'Three.'), part('4', 'Two.'), part('5', 'Five.')];
const HEART: Voice = { id: 'kokoro:af_heart', label: 'Heart, Kokoro, US', engine: KOKORO_VOICES[0] };

describe('reading ahead', () => {
  it('plans the part on screen first, then its neighbours (the next before the one before), then the rest, then the other speeds, a repeated part once', () => {
    const texts = (planned: { text: string; speed: number }[]) => planned.map(({ text, speed }) => `${text}@${speed}`);
    expect(texts(plan(PARTS, 2, 1))).toEqual([
      'Three.@1',
      'Two.@1',
      'Five.@1',
      'One.@1',
      'Three.@0.75',
      'Two.@0.75',
      'Five.@0.75',
      'One.@0.75',
      'Three.@0.6',
      'Two.@0.6',
      'Five.@0.6',
      'One.@0.6',
    ]);
    expect(texts(plan(PARTS, 0, 0.6)).slice(0, 5)).toEqual(['One.@0.6', 'Two.@0.6', 'Three.@0.6', 'Five.@0.6', 'One.@0.75']);
    expect(texts(plan(PARTS, 4, 0.75)).slice(0, 4)).toEqual(['Five.@0.75', 'Two.@0.75', 'Three.@0.75', 'One.@0.75']);
    expect(plan([], 0, 1)).toEqual([]);
  });

  describe('the queue', () => {
    const asked: string[] = [];
    let refuse: string | null;
    const voice = signal<Voice | null>(HEART);
    const rate = signal(1);
    const owner = signal<string | null>(null);
    const text = signal<{ id: string } | null>({ id: 'text' });
    const parts = signal<Part[]>(PARTS);
    const index = signal(2);
    const busy = signal(false);
    /** let the queue get through what it can */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    /** a change of state reaches the queue through an effect, which runs on the next tick */
    const changed = async () => {
      TestBed.tick();
      await settle();
    };

    beforeEach(() => {
      asked.length = 0;
      refuse = null;
      voice.set(HEART);
      rate.set(1);
      owner.set(null);
      text.set({ id: 'text' });
      parts.set(PARTS);
      index.set(2);
      busy.set(false);
      TestBed.configureTestingModule({
        providers: [
          {
            provide: Engine,
            useValue: {
              reading: async (words: string, voiceId: string, speed: number) => {
                asked.push(`${words} ${voiceId} ${speed}`);
                if (refuse) throw new EngineError(refuse);
                return { audio: 'readings/x.wav', words: [] };
              },
            },
          },
          { provide: Sound, useValue: { voice } },
          { provide: Playback, useValue: { rate } },
          { provide: Recorder, useValue: { owner } },
        ],
      });
    });

    /** the queue starts, following the state as set */
    const start = () => TestBed.inject(ReadAhead).follow({ text, parts, index, busy });

    it('reads the open text ahead in the planned order, each reading once, at the speed chosen', async () => {
      start();
      await changed();
      expect(asked.slice(0, 4)).toEqual(['Three. af_heart 1', 'Two. af_heart 1', 'Five. af_heart 1', 'One. af_heart 1']);
      expect(asked.length).toBe(12);
      // the same text at the same speed is not asked for again; another speed is
      rate.set(0.75);
      await changed();
      expect(asked.length).toBe(12);
    });

    it('waits while a take is recorded or scored, and while the parts load', async () => {
      busy.set(true);
      start();
      await changed();
      expect(asked).toEqual([]);
      busy.set(false);
      owner.set('part');
      await changed();
      expect(asked).toEqual([]);
      owner.set(null);
      await changed();
      expect(asked.length).toBe(12);
    });

    it('reads nothing ahead with a system voice, or no text open, and starts with another voice', async () => {
      voice.set(null);
      start();
      await changed();
      expect(asked).toEqual([]);
      voice.set(HEART);
      text.set(null);
      await changed();
      expect(asked).toEqual([]);
      text.set({ id: 'text' });
      await changed();
      expect(asked.length).toBe(12);
      voice.set({ id: 'kokoro:bm_george', label: 'George, Kokoro, UK', engine: { id: 'bm_george', name: 'George', place: 'UK' } });
      await changed();
      expect(asked.length).toBe(24);
      expect(asked[12]).toBe('Three. bm_george 1');
    });

    it('does not ask again for a reading the engine refused', async () => {
      refuse = 'the voice is missing';
      start();
      await changed();
      expect(asked.length).toBe(12);
      index.set(0);
      await changed();
      expect(asked.length).toBe(12);
    });
  });
});
