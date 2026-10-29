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
import { sentences, shortRanges, splitKnown, splitText, wordCount } from '../core/split';
import { Library } from '../core/library';
import { Session } from '../core/session';
import { Icon } from '../shared/icon';
import { HomeState } from './home-state';
import { TalkCard } from '../talk/talk-card';
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
  imports: [Icon, Logo, TalkCard],
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
  /** the text being written, kept when Home goes (a text opened, a talk checked) and back with it */
  private kept = inject(HomeState);
  protected draft = this.kept.draft;
  protected draftTitle = this.kept.draftTitle;
  protected draftMode = this.kept.draftMode;
  /** the draft is with the engine, being added */
  protected adding = signal(false);
  protected renaming = signal<string | null>(null);
  protected confirming = signal<string | null>(null);
  /** the texts whose delete is with the engine: their cards don't open meanwhile, or the text would open and then
   * vanish from under the practice screen */
  protected deleting = signal<ReadonlySet<string>>(new Set());
  private renameField = viewChild<ElementRef<HTMLInputElement>>('renameField');
  private textsColumn = viewChild.required<ElementRef<HTMLElement>>('textsColumn');

  /** the draft's words to say: punctuation alone is none, and a draft with none can't be added */
  protected readonly words = computed(() => wordCount(this.draft()));
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

  /** splits the texts not split before; split.ts keeps each split, so Home, made anew on every return, has the cards
   * of those at once instead of none while they load (an empty grid, no Continue) */
  private readonly splitting = resource({
    params: () => this.library.texts().filter((text) => !splitKnown(text.text, text.mode)),
    loader: ({ params }) => Promise.all(params.map((text) => splitText(text.text, text.mode))),
  });

  /** every text split the way it is practised, with a colour per part */
  private readonly cards = computed(() => {
    // a text split since is known now: its card is made
    this.splitting.status();
    return this.library.texts().flatMap((text): Card[] => {
      const parts = splitKnown(text.text, text.mode);
      if (!parts) return [];
      const cells = parts.map((part) => band(text.scores[part.key]?.last) || 'none');
      const saved = Number(readSetting(`part:${text.id}:${text.mode}`, '0'));
      const order = [...parts.keys()].map((partIndex) => (partIndex + saved) % parts.length);
      const nextIndex = order.find((partIndex) => !text.scores[parts[partIndex].key]) ?? saved;
      return [{ t: text, parts, cells, next: parts[nextIndex] ?? null, nextIndex }];
    });
  });

  protected readonly shown = computed(() => {
    const search = this.query();
    return this.cards().filter((card) => matchesSearch(search, card.t.title, card.t.text));
  });

  /** the text opened last */
  protected readonly resume = computed(() => {
    const list = this.cards();
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

  constructor() {
    // back on Home, the texts are scrolled to where they were left (their cards are there from the first frame)
    afterNextRender(() => {
      const column = this.textsColumn().nativeElement;
      column.scrollTop = this.kept.scroll;
      column.addEventListener('scroll', () => (this.kept.scroll = column.scrollTop), { passive: true });
    });
  }

  protected ring(card: Card) {
    const total = card.parts.length || 1;
    const done = card.parts.filter((part) => card.t.scores[part.key]).length;
    return { done, total, dash: ringDash(done, total) };
  }

  protected async start() {
    const text = this.draft().trim();
    if (!this.words() || this.adding()) return;
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
    if (this.deleting().has(card.t.id)) return;
    this.session.open(card.t.id, card.nextIndex);
  }

  /** the title becomes a field, focused and selected (autofocus only works for the first one) */
  protected startRename(id: string) {
    this.renaming.set(id);
    afterNextRender(() => this.renameField()?.nativeElement.select(), { injector: this.injector });
  }

  protected saveRename(text: TextItem) {
    const field = this.renameField()?.nativeElement;
    if (field) void this.rename(text, field.value);
  }

  protected async rename(text: TextItem, title: string) {
    this.renaming.set(null);
    if (title.trim() && title.trim() !== text.title) await this.library.rename(text.id, title.trim());
  }

  protected async remove(text: TextItem) {
    this.confirming.set(null);
    this.deleting.update((ids) => new Set(ids).add(text.id));
    try {
      await this.library.remove(text.id);
    } finally {
      // gone, or kept if the engine wouldn't delete it (the error says why): its card opens again
      this.deleting.update((ids) => new Set([...ids].filter((id) => id !== text.id)));
    }
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
