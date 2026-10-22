import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { WordResult } from '../core/models';

type Tone = 'idle' | 'plain' | 'wrong' | 'unclear' | 'now' | 'live';

/**
 * Your take as bars: the loudness of each slice of the recording, coloured where a word came out wrong
 * (red) or sounded off (amber), and lit while that word plays. While recording, the live level fills in.
 */
@Component({
  selector: 'app-waveform',
  template: `
    @for (bar of shown(); track $index) {
      <span [class]="bar.tone" [style.height.px]="bar.h"></span>
    }
  `,
  styles: `
    :host {
      height: 56px;
      display: flex;
      align-items: center;
      // in a narrow window the gaps narrow too, so every bar still fits
      gap: min(3px, 0.6%);
      padding: 0 2px;
    }
    span {
      flex: 1;
      min-width: 1px;
      border-radius: 3px;
      background: var(--bar);
      transition: height 0.12s;
    }
    .idle {
      background: var(--bar-light);
    }
    .wrong {
      background: var(--wrong-ink);
    }
    .unclear {
      background: var(--warn-line);
    }
    .now {
      background: var(--now);
      box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.15);
    }
    .live {
      background: var(--accent);
    }
  `,
  host: { 'aria-hidden': 'true' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Waveform {
  readonly bars = input(92);
  readonly peaks = input<number[] | null>(null);
  readonly words = input<WordResult[]>([]);
  readonly duration = input(0);
  /** the word playing now, lit in the bars */
  readonly now = input<number | null>(null);
  /** while recording: the level every 100 ms so far */
  readonly live = input<number[] | null>(null);

  protected readonly shown = computed(() => {
    const barCount = this.bars();
    const live = this.live();
    const height = (level: number) => 6 + Math.round(level * 44);
    if (live) {
      const tail = live.slice(-barCount);
      return Array.from({ length: barCount }, (_, barIndex) =>
        barIndex < tail.length ? { h: height(tail[barIndex]), tone: 'live' as Tone } : { h: 6, tone: 'idle' as Tone },
      );
    }
    const peaks = this.peaks();
    if (!peaks?.length) return Array.from({ length: barCount }, () => ({ h: 6, tone: 'idle' as Tone }));
    const duration = this.duration() || 1;
    const words = this.words();
    const now = this.now();
    return peaks.map((peak, barIndex) => {
      const start = (barIndex / peaks.length) * duration;
      const end = ((barIndex + 1) / peaks.length) * duration;
      const wordIndex = words.findIndex((word) => word.t && word.t[0] < end && word.t[1] > start);
      const word = words[wordIndex];
      const tone: Tone =
        wordIndex >= 0 && wordIndex === now ? 'now' : word?.status === 'wrong' ? 'wrong' : word?.status === 'unclear' ? 'unclear' : 'plain';
      return { h: height(peak), tone };
    });
  });
}
