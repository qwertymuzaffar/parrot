import { signal, Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Engine } from '../core/engine';
import { LeftTalk, Talk, WordResult, WordStatus } from '../core/models';
import { Names } from '../core/names';
import { Playback } from '../core/playback';
import { Recorder } from '../core/recorder';
import { StopReason, Talking, TalkState } from '../core/talking';
import { clock, lastWords, length, since, TalkCard } from './talk-card';
import { TalkPreview } from './talk-preview';

/** The talk's state, stood in for: the screens only show it and pass on clicks. */
function standIn() {
  return {
    state: signal<TalkState>('idle'),
    preparing: signal(false),
    recording: signal(false),
    left: signal(1800),
    progress: signal(0),
    talk: signal<Talk | null>(null),
    stopReason: signal<StopReason | null>(null),
    failure: signal<string | null>(null),
    heardSoFar: signal(''),
    unfinished: signal<LeftTalk | null>(null),
    prompts: signal<string | null>(null),
    prompt: signal<string | null>(null),
    about: signal<string | null>(null),
    draft: signal<{ said: string; title: string } | null>(null),
    start: vi.fn(),
    leave: vi.fn(),
    checkUnfinished: vi.fn(),
    choosePrompts: vi.fn(),
    anotherPrompt: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    writeDown: vi.fn(),
    keep: vi.fn(),
    discard: vi.fn(),
  };
}

const word = (w: string, status: WordStatus, at: number): WordResult => ({
  w,
  t: [at, at + 0.4],
  score: status === 'good' ? 0.92 : 0.41,
  ref: null,
  status,
  heard: null,
  extra: '',
  letters: [...w].map(() => (status === 'good' ? 0.92 : 0.41)),
});

const TALK: Talk = {
  heard: 'I moved here three years ago.',
  words: [
    word('I', 'good', 0),
    word('moved', 'good', 0.5),
    word('here', 'good', 1),
    word('three', 'unclear', 2.9),
    word('years', 'good', 3.4),
    word('ago.', 'good', 3.9),
  ],
  duration: 75,
  wpm: 118,
  score: 83,
  pauses: [[2, 1.5]],
  audio: 'talks/20261021-100000.wav',
};

describe('Just talk', () => {
  let talking: ReturnType<typeof standIn>;
  const recorder = { owner: signal(null), level: signal(0.4), elapsed: signal(0) };
  const playback = {
    playing: signal(null),
    paused: signal(false),
    nowMine: signal<number | null>(null),
    sayWord: vi.fn(),
    playMyWord: vi.fn(),
    compareWord: vi.fn(),
    toggleMine: vi.fn(),
    stop: vi.fn(),
  };

  /** marking a name that fails leaves the list as it was, as this one always does */
  const names = { has: (each: string) => ['Alex', 'here'].includes(each), set: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    talking = standIn();
    TestBed.configureTestingModule({
      providers: [
        { provide: Talking, useValue: talking },
        { provide: Recorder, useValue: recorder },
        { provide: Playback, useValue: playback },
        { provide: Names, useValue: names },
        { provide: Engine, useValue: {} },
      ],
    });
  });

  async function render<T>(component: Type<T>) {
    const fixture = TestBed.createComponent(component);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    const text = () => element.textContent!.replace(/\s+/g, ' ').trim();
    const button = (label: RegExp) => [...element.querySelectorAll('button')].find((each) => label.test(each.textContent!))!;
    const update = () => fixture.whenStable();
    return { element, text, button, update };
  }

  describe('the card on Home', () => {
    it('starts a talk, unless the microphone is busy', async () => {
      const card = await render(TalkCard);
      expect(card.text()).toContain('Tell a story or answer an interview question');
      card.button(/Start talking/).click();
      expect(talking.start).toHaveBeenCalled();
    });

    it('offers sets of prompts to talk about, one shown at a time', async () => {
      const card = await render(TalkCard);
      expect(card.element.querySelector('.prompt')).toBeNull();
      // talking about anything is chosen when no set is
      expect(card.button(/Anything/).getAttribute('aria-pressed')).toBe('true');
      expect(card.button(/Small talk/).getAttribute('aria-pressed')).toBe('false');
      card.button(/Small talk/).click();
      expect(talking.choosePrompts).toHaveBeenCalledWith('small-talk');
      talking.prompts.set('small-talk');
      talking.prompt.set('How was your weekend?');
      await card.update();
      expect(card.button(/Small talk/).getAttribute('aria-pressed')).toBe('true');
      expect(card.element.querySelector('.prompt')!.textContent).toBe('How was your weekend?');
      card.element.querySelector<HTMLButtonElement>('[aria-label="Another question"]')!.click();
      expect(talking.anotherPrompt).toHaveBeenCalled();
      expect(card.button(/Anything/).getAttribute('aria-pressed')).toBe('false');
      // the set chosen, clicked again, stays chosen; Anything turns the questions off
      card.button(/Small talk/).click();
      expect(talking.choosePrompts).toHaveBeenCalledTimes(1);
      card.button(/Anything/).click();
      expect(talking.choosePrompts).toHaveBeenLastCalledWith(null);
      // and the prompt talked about stays in view while talking
      talking.about.set('How was your weekend?');
      talking.state.set('recording');
      talking.recording.set(true);
      await card.update();
      expect(card.element.querySelector('.prompt')!.textContent).toBe('How was your weekend?');
    });

    it('says to wait while the microphone gets ready, and lets the talk be called off', async () => {
      talking.state.set('recording');
      const card = await render(TalkCard);
      expect(card.text()).toContain('Getting the microphone ready. Start talking when it says Listening.');
      const preparing = card.button(/Preparing/);
      expect([preparing.disabled, preparing.getAttribute('aria-busy')]).toEqual([true, 'true']);
      expect(card.text()).not.toContain('Listening…');
      card.button(/Cancel/).click();
      expect(talking.stop).toHaveBeenCalled();
    });

    it('shows the time while listening, and the time left in the last minute', async () => {
      talking.state.set('recording');
      talking.recording.set(true);
      recorder.elapsed.set(83);
      const card = await render(TalkCard);
      expect(card.text()).toContain('Listening… 1:23');
      talking.left.set(45);
      await card.update();
      expect(card.text()).toContain('0:45 left');
      // what was heard so far, as it comes, in a box there from the start so Stop doesn't move
      const soFar = card.element.querySelector('.so-far')!;
      expect([soFar.textContent!.trim(), soFar.classList.contains('empty')]).toEqual(['Your words show here as Parrot hears them.', true]);
      talking.heardSoFar.set('I moved here three years ago');
      await card.update();
      expect(card.element.querySelector('.so-far')).toBe(soFar);
      expect([soFar.textContent!.trim(), soFar.classList.contains('empty')]).toEqual(['I moved here three years ago', false]);
      card.button(/Stop/).click();
      expect(talking.stop).toHaveBeenCalled();
      // Esc stops it too
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(talking.stop).toHaveBeenCalledTimes(2);
    });

    it('is not stopped by an Esc that closes a dialog or leaves a field', async () => {
      talking.state.set('recording');
      talking.recording.set(true);
      await render(TalkCard);
      const esc = (target: EventTarget) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      // closing Settings
      const dialog = document.body.appendChild(document.createElement('dialog'));
      dialog.setAttribute('open', '');
      esc(dialog);
      dialog.remove();
      // leaving the title being renamed, or the new text's fields
      for (const tag of ['input', 'textarea']) {
        const field = document.body.appendChild(document.createElement(tag));
        esc(field);
        field.remove();
      }
      expect(talking.stop).not.toHaveBeenCalled();
      esc(document.body);
      expect(talking.stop).toHaveBeenCalledTimes(1);
    });

    it('tells a screen reader what changes, not the clock, the words heard or each step written down', async () => {
      const spoken = (card: { element: HTMLElement }) =>
        [...card.element.querySelectorAll('[role=status], [aria-live]')].map((region) => region.textContent!.trim());
      talking.state.set('recording');
      talking.recording.set(true);
      recorder.elapsed.set(83);
      talking.heardSoFar.set('I moved here three years ago');
      const card = await render(TalkCard);
      expect(spoken(card)).toEqual(['Listening…', '']);
      talking.left.set(45);
      await card.update();
      expect(spoken(card)).toEqual(['Listening…', 'One minute left.']);
      talking.state.set('writing');
      talking.progress.set(0.4);
      await card.update();
      expect(spoken(card)).toEqual(['Writing down what you said…']);
    });

    it('says it is stopping, with nothing to press, until it is written down', async () => {
      talking.state.set('stopping');
      const card = await render(TalkCard);
      expect(card.element.querySelector('[role=status]')!.textContent!.trim()).toBe('Stopping…');
      expect(card.element.querySelectorAll('button').length).toBe(0);
    });

    it('shows how far writing it down has got, with a Cancel', async () => {
      talking.state.set('writing');
      talking.progress.set(0.4);
      talking.stopReason.set('longest');
      const card = await render(TalkCard);
      expect(card.text()).toContain('Writing down what you said… 40%');
      expect(card.text()).toContain('Stopped at the 30-minute limit.');
      expect(card.element.querySelector('[role=progressbar]')!.getAttribute('aria-valuenow')).toBe('40');
      card.button(/Cancel/).click();
      expect(talking.cancel).toHaveBeenCalled();
    });

    it('cancels writing it down on Esc too, unless the Esc closes a dialog or leaves a field', async () => {
      talking.state.set('writing');
      await render(TalkCard);
      const esc = (target: EventTarget) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const dialog = document.body.appendChild(document.createElement('dialog'));
      dialog.setAttribute('open', '');
      esc(dialog);
      dialog.remove();
      const field = document.body.appendChild(document.createElement('input'));
      esc(field);
      field.remove();
      expect(talking.cancel).not.toHaveBeenCalled();
      esc(document.body);
      expect([talking.cancel.mock.calls.length, talking.stop.mock.calls.length]).toEqual([1, 0]);
    });

    it('offers to write a stopped talk down again, or discard it', async () => {
      talking.state.set('stopped');
      talking.failure.set('speech recognition failed');
      const card = await render(TalkCard);
      expect(card.element.querySelector('[role=alert]')!.textContent).toContain('speech recognition failed');
      card.button(/Write it down/).click();
      expect(talking.writeDown).toHaveBeenCalled();
      // its recording may be long: discarding asks first
      card.button(/^\s*Discard\s*$/).click();
      await card.update();
      expect([talking.discard.mock.calls.length, card.text()]).toEqual([
        0,
        expect.stringContaining('Discard this talk and its recording?'),
      ]);
      card.element.querySelector<HTMLButtonElement>('.btn.danger')!.click();
      expect(talking.discard).toHaveBeenCalled();
    });

    it('says why a quiet talk had nothing in it', async () => {
      talking.stopReason.set('quiet');
      talking.failure.set('Nothing was heard in the recording. Is the microphone on?');
      const card = await render(TalkCard);
      expect(card.element.querySelector('[role=alert]')!.textContent!.trim()).toBe(
        'Stopped after 2 quiet minutes. Nothing was heard in the recording. Is the microphone on?',
      );
    });

    it('offers a talk left from last time, to write down or discard, before a new one', async () => {
      talking.unfinished.set({ started: '2026-10-21T14:05:00', duration: 185, heard: null });
      const card = await render(TalkCard);
      expect(card.text()).toMatch(/You have an unfinished talk from .+, 3 min\. It was not written down yet\./);
      expect(card.text()).not.toContain('Start talking');
      card.button(/Write it down/).click();
      expect(talking.writeDown).toHaveBeenCalled();
      // discarding asks first
      card.button(/^\s*Discard\s*$/).click();
      await card.update();
      expect(card.text()).toContain('Discard this talk and its recording?');
      card.element.querySelector<HTMLButtonElement>('.btn.danger')!.click();
      expect(talking.discard).toHaveBeenCalled();
    });

    it('offers to check a talk left written down', async () => {
      talking.unfinished.set({ started: '2026-10-21T14:05:00', duration: 40, heard: TALK });
      const card = await render(TalkCard);
      expect(card.text()).toContain('40 s. It was written down, but not saved.');
      card.button(/Check it/).click();
      expect(talking.checkUnfinished).toHaveBeenCalled();
    });

    it('says when a talk was left, and how long it is', () => {
      const now = new Date(2026, 9, 22, 9, 0);
      expect(since('2026-10-22T08:05:00', now)).toBe('today at 08:05');
      expect(since('2026-10-21T23:59:00', now)).toBe('yesterday');
      expect(since('2026-10-19T10:00:00', now)).toBe('on 19 October');
      expect([length(0.2), length(45), length(185)]).toEqual(['1 s', '45 s', '3 min']);
    });

    it('shows the end of what was heard so far', () => {
      const many = Array.from({ length: 40 }, (_, index) => `w${index}`).join(' ');
      expect(lastWords(many, 3)).toBe('…w37 w38 w39');
      expect(lastWords('just a few', 3)).toBe('just a few');
    });

    it('counts minutes and seconds', () => {
      expect([clock(0), clock(9.7), clock(83), clock(600)]).toEqual(['0:00', '0:09', '1:23', '10:00']);
    });
  });

  describe('the check before keeping it', () => {
    beforeEach(() => {
      talking.state.set('preview');
      talking.talk.set(TALK);
    });

    it('shows each word as it came out, the long pauses, the pace and the score', async () => {
      const preview = await render(TalkPreview);
      const words = [...preview.element.querySelectorAll<HTMLButtonElement>('.words .w')];
      expect(words.map((each) => each.textContent!.trim())).toEqual(['I', 'moved', 'here', 'three', 'years', 'ago.']);
      expect(words[3].classList).toContain('unclear');
      expect(words[3].getAttribute('aria-label')).toBe('three — sounded off');
      expect(preview.element.querySelector('.pause')!.getAttribute('aria-label')).toBe('a pause of 1.5 seconds');
      expect(preview.text()).toContain('118 words a minute · 1 min 15 s');
      expect(preview.text()).toContain('1 sounded off · 1 pause over a second');
    });

    it('underlines a name in the line, which stays in it', async () => {
      const preview = await render(TalkPreview);
      const name = preview.element.querySelector<HTMLButtonElement>('.words .w.name')!;
      expect(name.textContent!.trim()).toBe('here');
      expect(getComputedStyle(name).display).not.toBe('flex');
    });

    it('opens a word: how it sounded, how to say its weak sound, and hearing it every way', async () => {
      const preview = await render(TalkPreview);
      preview.element.querySelectorAll<HTMLButtonElement>('.words .w')[3].click();
      await preview.update();
      const card = preview.element.querySelector('.word')!;
      expect(card.textContent).toContain('three');
      expect(card.textContent).toContain('41% sound match');
      expect(card.querySelector('.tip')).not.toBeNull();
      preview.button(/Hear it/).click();
      preview.button(/Compare/).click();
      expect(playback.sayWord).toHaveBeenCalledWith('three');
      expect(playback.compareWord.mock.calls[0].slice(1)).toEqual([3, 'three']);
      // played back from the talk's own recording
      expect(playback.compareWord.mock.calls[0][0].audio).toBe('talks/20261021-100000.wav');
    });

    it('unticks "A name" again when the word could not be marked', async () => {
      const preview = await render(TalkPreview);
      preview.element.querySelectorAll<HTMLButtonElement>('.words .w')[3].click();
      await preview.update();
      const box = preview.element.querySelector<HTMLInputElement>('.word .name input')!;
      box.click();
      await preview.update();
      expect(names.set).toHaveBeenCalledWith('three', true);
      expect(box.checked).toBe(false);
    });

    it('keeps what was said, as corrected, with its title', async () => {
      const preview = await render(TalkPreview);
      const said = preview.element.querySelector<HTMLTextAreaElement>('textarea')!;
      expect(said.value).toBe('I moved here three years ago.');
      said.value = 'I moved here tree years ago.';
      said.dispatchEvent(new Event('input'));
      const title = preview.element.querySelector<HTMLInputElement>('#talk-title-field')!;
      expect(title.placeholder).toBe('I moved here three years ago.…');
      title.value = 'Moving';
      title.dispatchEvent(new Event('input'));
      await preview.update();
      preview.button(/Save and practise/).click();
      expect(talking.keep).toHaveBeenCalledWith('I moved here tree years ago.', 'Moving');
    });

    it('asks before discarding a talk, however short', async () => {
      talking.talk.set({ ...TALK, duration: 8 });
      const preview = await render(TalkPreview);
      preview.button(/^\s*Discard\s*$/).click();
      await preview.update();
      expect(talking.discard).not.toHaveBeenCalled();
      expect(preview.text()).toContain('Discard this talk and its recording?');
      preview.button(/Keep it/).click();
      await preview.update();
      preview.button(/^\s*Discard\s*$/).click();
      await preview.update();
      preview.element.querySelector<HTMLButtonElement>('.btn.danger')!.click();
      expect(talking.discard).toHaveBeenCalled();
    });

    it("can't be left or discarded while it is being saved", async () => {
      talking.state.set('keeping');
      const preview = await render(TalkPreview);
      expect([preview.button(/Home/).disabled, preview.button(/^\s*Discard\s*$/).disabled]).toEqual([true, true]);
    });

    it('goes Home leaving the talk unfinished, with what was typed, and shows that again when it comes back', async () => {
      const preview = await render(TalkPreview);
      const said = preview.element.querySelector<HTMLTextAreaElement>('textarea')!;
      said.value = 'I moved here tree years ago.';
      said.dispatchEvent(new Event('input'));
      preview.button(/Home/).click();
      expect([talking.leave.mock.calls[0], talking.discard.mock.calls.length]).toEqual([['I moved here tree years ago.', ''], 0]);

      talking.draft.set({ said: 'I moved here tree years ago.', title: 'Moving' });
      const again = await render(TalkPreview);
      expect(again.element.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('I moved here tree years ago.');
      expect(again.element.querySelector<HTMLInputElement>('#talk-title-field')!.value).toBe('Moving');
    });

    it('titles the text by the prompt talked about', async () => {
      // not the one showing now, after another one was asked for
      talking.about.set('Tell me about yourself.');
      talking.prompt.set('Why should we hire you?');
      const preview = await render(TalkPreview);
      expect(preview.element.querySelector<HTMLInputElement>('#talk-title-field')!.value).toBe('Tell me about yourself');
      preview.button(/Save and practise/).click();
      expect(talking.keep).toHaveBeenCalledWith(TALK.heard, 'Tell me about yourself');
    });

    it('says why it could not be kept', async () => {
      talking.failure.set('The speech engine is not running.');
      const preview = await render(TalkPreview);
      expect(preview.element.querySelector('[role=alert]')!.textContent).toContain('The speech engine is not running.');
    });
  });

  /** Focus as a keyboard user has it: the screens attached to the page, and keys pressed (Enter on a button). */
  describe('keyboard focus', () => {
    async function attached<T>(component: Type<T>) {
      const fixture = TestBed.createComponent(component);
      document.body.append(fixture.nativeElement);
      await fixture.whenStable();
      const element: HTMLElement = fixture.nativeElement;
      const button = (label: RegExp) => [...element.querySelectorAll('button')].find((each) => label.test(each.textContent!))!;
      /** Enter on a focused button: a key, then the click it makes */
      const enter = (target: HTMLElement) => {
        target.focus();
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        target.click();
      };
      return { element, button, enter, update: () => fixture.whenStable() };
    }
    const focused = () => document.activeElement?.textContent?.replace(/\s+/g, ' ').trim() ?? null;

    afterEach(() => document.body.replaceChildren());

    it('goes on through the card as a talk is started, stopped and written down, never to the page', async () => {
      const card = await attached(TalkCard);
      // drawn: focus stays where it was
      expect(document.activeElement).toBe(document.body);
      card.enter(card.button(/Start talking/));
      talking.state.set('recording');
      await card.update();
      expect(focused()).toBe('Cancel');
      talking.recording.set(true);
      await card.update();
      expect(focused()).toBe('Stop');
      card.enter(card.button(/Stop/));
      talking.state.set('stopping');
      await card.update();
      talking.state.set('writing');
      await card.update();
      expect(focused()).toBe('Cancel');
      card.enter(card.button(/Cancel/));
      talking.state.set('stopped');
      await card.update();
      expect(focused()).toBe('Write it down');
    });

    it('goes to Keep it when asked whether to discard, and back to Discard after it', async () => {
      talking.state.set('stopped');
      const card = await attached(TalkCard);
      card.enter(card.button(/^\s*Discard\s*$/));
      await card.update();
      expect(focused()).toBe('Keep it');
      card.enter(card.button(/Keep it/));
      await card.update();
      expect(focused()).toBe('Discard');
      // the same for a talk left from last time
      talking.state.set('idle');
      talking.unfinished.set({ started: '2026-10-21T10:00:00Z', duration: 75, heard: null });
      await card.update();
      card.enter(card.button(/^\s*Discard\s*$/));
      await card.update();
      expect(focused()).toBe('Keep it');
    });

    it('is not taken from somewhere else on Home as the talk changes', async () => {
      const card = await attached(TalkCard);
      const title = document.body.appendChild(document.createElement('input'));
      title.focus();
      talking.state.set('recording');
      talking.recording.set(true);
      await card.update();
      expect(document.activeElement).toBe(title);
    });

    it('is not put on the card for a click, which left it on the page', async () => {
      const card = await attached(TalkCard);
      card.button(/Start talking/).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      card.button(/Start talking/).click();
      talking.state.set('recording');
      talking.recording.set(true);
      await card.update();
      expect(document.activeElement).toBe(document.body);
    });

    it('goes to Keep it on the check screen too, back to Discard, and back to Save when a save fails', async () => {
      talking.talk.set(TALK);
      talking.state.set('preview');
      const preview = await attached(TalkPreview);
      preview.enter(preview.button(/^\s*Discard\s*$/));
      await preview.update();
      expect(focused()).toBe('Keep it');
      preview.enter(preview.button(/Keep it/));
      await preview.update();
      expect(focused()).toBe('Discard');
      preview.enter(preview.button(/Save and practise/));
      talking.state.set('keeping');
      await preview.update();
      talking.state.set('preview');
      talking.failure.set('The speech engine is not running.');
      await preview.update();
      expect(focused()).toBe('Save and practise');
    });
  });
});
