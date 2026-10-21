import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ringDash } from '../shared/ring';
import { band } from '../shared/score';

/** The score of a try as a ring: the share of words that came out clear. */
@Component({
  selector: 'app-score-ring',
  template: `
    <svg viewBox="0 0 64 64" [class]="tone()" role="img" [attr.aria-label]="score() + ' percent of words clear'">
      <circle cx="32" cy="32" r="27" class="track" />
      <circle cx="32" cy="32" r="27" class="value" [attr.stroke-dasharray]="dash()" />
    </svg>
    <div class="num" [class.wide]="score() >= 100" aria-hidden="true">
      <b>{{ score() }}<small>%</small></b>
      <span>clear</span>
    </div>
  `,
  styles: `
    :host {
      position: relative;
      width: 84px;
      height: 84px;
      flex-shrink: 0;
    }
    svg {
      width: 100%;
      height: 100%;
      transform: rotate(-90deg);
    }
    circle {
      fill: none;
      stroke-width: 7;
    }
    .track {
      stroke: var(--surface-2);
    }
    .value {
      stroke-linecap: round;
      transition: stroke-dasharray 0.5s;
    }
    .good .value {
      stroke: var(--accent);
    }
    .warn .value {
      stroke: var(--warn-line);
    }
    .bad .value {
      stroke: var(--wrong-ink);
    }
    .num {
      position: absolute;
      inset: 0;
      display: grid;
      place-content: center;
      text-align: center;
      line-height: 1.05;
    }
    b {
      font-family: var(--display);
      font-size: 24px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    small {
      font-size: 13px;
    }
    // three digits fit inside the ring only a size down
    .wide b {
      font-size: 19px;
    }
    .wide small {
      font-size: 11px;
    }
    span {
      font-size: 11px;
      color: var(--muted);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScoreRing {
  readonly score = input.required<number>();
  protected readonly tone = computed(() => band(this.score()));
  protected readonly dash = computed(() => ringDash(this.score(), 100));
}
