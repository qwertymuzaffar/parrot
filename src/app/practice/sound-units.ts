import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { SoundUnit } from '../core/sounds';

/** A word as the sounds that spell it, each coloured by how surely it was heard (its score on hover). */
@Component({
  selector: 'app-sound-units',
  template: `
    @for (unit of units(); track $index) {
      <span class="unit" [class]="unit.level" [title]="unit.score == null ? '' : pct(unit.score) + '%'">{{ unit.text }}</span>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .unit {
      font-size: 20px;
      font-weight: 600;
      line-height: 1;
      padding: 7px 9px;
      border-radius: 8px;
      background: var(--good-bg);
      color: var(--good-ink);
      &.warn {
        background: var(--warn-bg);
        color: var(--warn-ink);
        box-shadow: inset 0 -2px 0 var(--warn-line);
      }
      &.bad {
        background: var(--wrong-bg);
        color: var(--wrong-ink);
        box-shadow: inset 0 -2px 0 var(--wrong-ink);
      }
      &.none {
        background: var(--surface-2);
        color: var(--muted);
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SoundUnits {
  readonly units = input.required<SoundUnit[]>();
  protected pct = (score: number) => Math.round(score * 100);
}
