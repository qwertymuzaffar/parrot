import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  output,
  resource,
  signal,
  viewChild,
} from '@angular/core';
import { Mode, Part, TextItem } from '../core/models';
import { readSetting } from '../core/settings';
import { sentences, shortRanges, splitText } from '../core/split';
import { Library } from '../core/library';
import { Session } from '../core/session';
import { Icon } from '../shared/icon';
import { Logo } from '../shared/logo';
import { ringDash } from '../shared/ring';
import { band } from '../shared/score';
import { matchesSearch } from '../shared/search';

interface Card {
  t: TextItem;
  parts: Part[];
  cells: string[];
  next: Part | null;
  nextIndex: number;
}

@Component({
  selector: 'app-home',
  imports: [Icon, Logo],
  templateUrl: './home.html',
  styleUrl: './home.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Home {
  protected library = inject(Library);
  protected session = inject(Session);
  private injector = inject(Injector);
  readonly settings = output<void>();
  protected band = band;
  protected Math = Math;

  protected query = signal('');
  protected draft = signal('');
  protected draftTitle = signal('');
  protected draftMode = signal<Mode>('sentences');
  /** the draft is with the engine, being added */
  protected adding = signal(false);
  protected renaming = signal<string | null>(null);
  protected confirming = signal<string | null>(null);
  private renameField = viewChild<ElementRef<HTMLInputElement>>('renameField');

  protected readonly words = computed(() => this.draft().trim().split(/\s+/).filter(Boolean).length);
  /** how many parts each way of practising would give the draft */
  protected readonly counts = computed(() => {
    const text = this.draft().trim();
    const list = text ? sentences(text) : [];
    const short = list.reduce((total, sentence) => total + shortRanges(sentence.split(' ')).length, 0);
    return { whole: text ? 1 : 0, sentences: list.length, short };
  });
  protected readonly modes: { id: Mode; label: string; unit: (count: number) => string }[] = [
    { id: 'whole', label: 'Whole text', unit: () => 'in one go' },
    { id: 'sentences', label: 'Sentences', unit: (count) => `${count} sentence${count === 1 ? '' : 's'}` },
    { id: 'short', label: 'Short parts', unit: (count) => `${count} part${count === 1 ? '' : 's'}` },
  ];

  /** every text split the way it is practised, with a colour per part */
  private readonly cards = resource({
    params: () => this.library.texts(),
    loader: ({ params }) =>
      Promise.all(
        params.map(async (text): Promise<Card> => {
          const parts = await splitText(text.text, text.mode);
          const cells = parts.map((part) => band(text.scores[part.key]?.last) || 'none');
          const saved = Number(readSetting(`part:${text.id}:${text.mode}`, '0'));
          const order = [...parts.keys()].map((partIndex) => (partIndex + saved) % parts.length);
          const nextIndex = order.find((partIndex) => !text.scores[parts[partIndex].key]) ?? saved;
          return { t: text, parts, cells, next: parts[nextIndex] ?? null, nextIndex };
        }),
      ),
  });

  protected readonly shown = computed(() => {
    const search = this.query();
    return (this.cards.value() ?? []).filter((card) => matchesSearch(search, card.t.title, card.t.text));
  });

  /** the text opened last */
  protected readonly resume = computed(() => {
    const list = this.cards.value() ?? [];
    const last = readSetting('text', '');
    const opened = [...list].filter((card) => card.t.opened).sort((first, second) => second.t.opened!.localeCompare(first.t.opened!));
    return list.find((card) => card.t.id === last) ?? opened[0] ?? null;
  });

  protected readonly week = computed(() => {
    const activity = this.library.activity();
    const top = Math.max(1, ...(activity?.days.map((day) => day.tries) ?? [1]));
    return (activity?.days ?? []).map((day, dayIndex, all) => ({
      day: new Date(day.date + 'T12:00').toLocaleDateString(undefined, { weekday: 'short' }),
      tries: day.tries,
      h: 6 + Math.round((day.tries / top) * 64),
      tone: dayIndex === all.length - 1 && day.tries ? 'today' : day.tries ? 'some' : 'none',
    }));
  });

  protected readonly practisedParts = computed(() => this.library.texts().reduce((total, text) => total + text.practised, 0));

  protected ring(card: Card) {
    const total = card.parts.length || 1;
    const done = card.parts.filter((part) => card.t.scores[part.key]).length;
    return { done, total, dash: ringDash(done, total) };
  }

  protected async start() {
    const text = this.draft().trim();
    if (!text || this.adding()) return;
    this.adding.set(true);
    try {
      // the draft stays until the text is added: if the engine won't add it, it can be tried again
      if (!(await this.session.add(text, this.draftTitle(), this.draftMode()))) return;
    } finally {
      this.adding.set(false);
    }
    this.draft.set('');
    this.draftTitle.set('');
  }

  protected continue(card: Card) {
    this.session.open(card.t.id, card.nextIndex);
  }

  /** the title becomes a field, focused and selected (autofocus only works for the first one) */
  protected startRename(id: string) {
    this.renaming.set(id);
    afterNextRender(() => this.renameField()?.nativeElement.select(), { injector: this.injector });
  }

  protected async rename(text: TextItem, title: string) {
    this.renaming.set(null);
    if (title.trim() && title.trim() !== text.title) await this.library.rename(text.id, title.trim());
  }

  protected async remove(text: TextItem) {
    this.confirming.set(null);
    await this.library.remove(text.id);
  }

  protected when(iso: string | null) {
    if (!iso) return '';
    const date = new Date(iso);
    const days = Math.floor((Date.now() - date.getTime()) / 86400000);
    if (new Date().toDateString() === date.toDateString()) return 'today';
    if (days < 2) return 'yesterday';
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  protected modeName(mode: Mode) {
    return { whole: 'whole text', sentences: 'sentences', short: 'short parts' }[mode];
  }
}
