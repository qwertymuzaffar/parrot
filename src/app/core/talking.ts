import { computed, inject, Injectable, signal } from '@angular/core';
import { Engine, TALK_CANCELLED } from './engine';
import { errorMessage, Library } from './library';
import { LeftTalk, Talk } from './models';
import { Playback } from './playback';
import { micError, Recorder } from './recorder';
import { pick, PROMPT_SETS } from '../talk/prompts';
import { Session } from './session';
import { readSetting, writeSetting } from './settings';

/** The longest talk (seconds): it stops itself then. The engine refuses much more. */
export const LONGEST_TALK = 1800;
/** A talk stops itself after this long without sound (ms): its speaker walked away, or forgot to stop it. */
export const QUIET_STOP_MS = 120_000;

/**
 * Where a talk is: being recorded; being written down; stopped with its recording kept (a writing-down cancelled
 * or failed), to write down again or discard; written down and shown for checking; being kept as a text.
 */
export type TalkState = 'idle' | 'recording' | 'writing' | 'stopped' | 'preview' | 'keeping';

/** Why a talk stopped: the speaker stopped it, it was quiet too long, or it reached the longest a talk can be. */
export type StopReason = 'you' | 'quiet' | 'longest';

/** What the engine says when a talk had nothing to write down: writing it down again would say the same. */
const NOTHING_IN_IT = /^(Nothing was heard|Parrot couldn't make out|Parrot got only silence)/;

/**
 * A talk: speech with no text in front of it. Recorded and sent on to the engine as it goes, written down when it
 * stops, checked and corrected, then kept as a text whose first take is the talk.
 */
@Injectable({ providedIn: 'root' })
export class Talking {
  private engine = inject(Engine);
  private recorder = inject(Recorder);
  private library = inject(Library);
  private session = inject(Session);
  private playback = inject(Playback);

  readonly state = signal<TalkState>('idle');
  /** how much of the talk is written down, 0 to 1 */
  readonly progress = signal(0);
  /** the talk written down, while it is checked */
  readonly talk = signal<Talk | null>(null);
  readonly stopReason = signal<StopReason | null>(null);
  /** what was heard of the talk while it is recorded */
  readonly heardSoFar = signal('');
  /** what went wrong, said as the interface shows it */
  readonly failure = signal<string | null>(null);
  /** a talk left from the last time Parrot ran, or left on its check screen, until it is written down, checked or discarded */
  readonly unfinished = signal<LeftTalk | null>(null);
  /** what was typed on the check screen of a talk left there: its words as corrected, and its title */
  readonly draft = signal<{ said: string; title: string } | null>(null);
  /** the set of prompts chosen to talk about (its key), remembered between runs; none to talk freely */
  readonly prompts = signal<string | null>(readSetting<string>('talkPrompts', '') || null);
  /** the prompt to talk about, from that set: the title of the text a talk becomes */
  readonly prompt = signal<string | null>(null);

  readonly preparing = computed(() => this.recorder.preparing() && this.recorder.owner() === 'free');
  readonly recording = computed(() => this.recorder.recording() && this.recorder.owner() === 'free');
  /** the talk is written down and being checked: the preview shows */
  readonly checking = computed(() => this.state() === 'preview' || this.state() === 'keeping');
  /** seconds left before the talk stops itself */
  readonly left = computed(() => Math.max(0, LONGEST_TALK - this.recorder.elapsed()));

  /** the talk's sound on its way to the engine, block after block in order */
  private sending: Promise<void> = Promise.resolve();
  private started = false;
  private sendFailed: string | null = null;
  private watch = 0;

  constructor() {
    this.anotherPrompt();
    // asked once, at the start: a talk can only be left by an earlier run
    this.engine.talkLeft().then(
      (left) => this.state() === 'idle' && this.unfinished.set(left),
      () => {},
    );
  }

  /** Talk about a prompt from the set with `key`, or about anything (null). */
  choosePrompts(key: string | null) {
    this.prompts.set(PROMPT_SETS.some((set) => set.key === key) ? key : null);
    writeSetting('talkPrompts', this.prompts() ?? '');
    this.prompt.set(null);
    this.anotherPrompt();
  }

  /** Another prompt from the set chosen. */
  anotherPrompt() {
    const set = PROMPT_SETS.find((each) => each.key === this.prompts());
    this.prompt.set(set ? pick(set, this.prompt()) : null);
  }

  /** Start a talk, unless the microphone is busy with a take. */
  async start() {
    // a talk left from last time is dealt with first: starting another would drop it
    if (this.recorder.owner() || this.unfinished() || !['idle', 'preview', 'stopped'].includes(this.state())) return;
    if (this.state() !== 'idle') await this.discard();
    this.playback.stop();
    this.reset();
    this.state.set('recording');
    this.sending = Promise.resolve();
    this.started = false;
    this.sendFailed = null;
    try {
      await this.recorder.start('free', (pcm, rate) => this.send(pcm, rate));
    } catch (error) {
      this.state.set('idle');
      this.failure.set(micError(error));
      return;
    }
    // stopped before it got going
    if (!this.recording()) {
      if (this.state() === 'recording') this.state.set('idle');
      return;
    }
    this.watch = window.setInterval(() => {
      if (this.recorder.elapsed() >= LONGEST_TALK) void this.stop('longest');
      else if (this.recorder.quietFor() >= QUIET_STOP_MS) void this.stop('quiet');
    }, 250);
  }

  /** The talk's sound so far, sent on in order; the first block starts the talk in the engine. */
  private send(pcm: Int16Array, rate: number) {
    this.sending = this.sending
      .then(async () => {
        if (this.sendFailed) return;
        if (!this.started) {
          await this.engine.talkStart(rate);
          this.started = true;
        }
        const heard = await this.engine.talkFeed(pcm);
        if (heard.length) this.heardSoFar.update((soFar) => [soFar, ...heard].filter(Boolean).join(' '));
      })
      .catch((error) => {
        if (this.sendFailed) return;
        // what was recorded so far may be unusable: the talk stops at once and says why
        this.sendFailed = errorMessage(error);
        void this.abandon(this.sendFailed);
      });
  }

  private async abandon(why: string) {
    clearInterval(this.watch);
    if (this.recorder.owner() === 'free') await this.recorder.stop();
    await this.engine.talkDiscard().catch(() => {});
    this.reset();
    this.failure.set(why);
  }

  /** Stop recording and write the talk down. */
  async stop(reason: StopReason = 'you') {
    if (this.state() !== 'recording') return;
    clearInterval(this.watch);
    const got = this.recording();
    await this.recorder.stop();
    if (!got) {
      // stopped while the microphone was still getting ready: nothing was recorded
      this.state.set('idle');
      return;
    }
    await this.sending;
    if (this.sendFailed) return;
    if (!this.started) {
      this.reset();
      this.failure.set('Nothing was recorded. Is the microphone on?');
      return;
    }
    this.stopReason.set(reason);
    await this.writeDown();
  }

  /** Write the talk down: after it stops, again after it was cancelled or failed, or the talk left from last time. */
  async writeDown() {
    this.unfinished.set(null);
    this.draft.set(null);
    this.state.set('writing');
    this.progress.set(0);
    this.failure.set(null);
    try {
      const talk = await this.engine.talkStop(({ done, total }) => this.progress.set(total ? done / total : 0));
      if (this.state() !== 'writing') return;
      this.talk.set(talk);
      this.state.set('preview');
    } catch (error) {
      if (this.state() !== 'writing') return;
      const why = errorMessage(error);
      if (why === TALK_CANCELLED) {
        this.state.set('stopped');
      } else if (NOTHING_IN_IT.test(why)) {
        await this.engine.talkDiscard().catch(() => {});
        const reason = this.stopReason();
        this.reset();
        this.stopReason.set(reason);
        this.failure.set(why);
      } else {
        this.state.set('stopped');
        this.failure.set(why);
      }
    }
  }

  /** Check the talk left from last time, which was written down then. */
  checkUnfinished() {
    const talk = this.unfinished()?.heard;
    if (!talk || this.state() !== 'idle') return;
    this.unfinished.set(null);
    this.failure.set(null);
    this.talk.set(talk);
    this.state.set('preview');
  }

  /** Leave the talk being checked for later: it stays unfinished, with what was typed, to come back to from the card. */
  leave(said: string, title: string) {
    const talk = this.talk();
    if (this.state() !== 'preview' || !talk) return;
    this.reset();
    this.draft.set({ said, title });
    this.unfinished.set({ started: startedAt(talk.audio), duration: talk.duration, heard: talk });
  }

  /** Stop writing the talk down; the recording is kept. */
  cancel() {
    if (this.state() === 'writing') void this.engine.talkCancel();
  }

  /** Keep the talk as a text (`text` is what was said, as corrected), and open it with the talk as its take. */
  async keep(text: string, title: string) {
    if (this.state() !== 'preview') return;
    this.state.set('keeping');
    this.failure.set(null);
    try {
      const kept = await this.engine.talkKeep(text, title);
      this.reset();
      // the next talk is about something else
      this.anotherPrompt();
      await this.library.loadTexts();
      await this.session.open(kept.text.id, 0);
      const first = kept.attempt.words.findIndex((word) => word.status !== 'good');
      if (first >= 0) this.session.selectWord(first);
    } catch (error) {
      // still the talk being kept: nothing else may have taken the screen meanwhile
      if (this.state() !== 'keeping') return;
      this.state.set('preview');
      this.failure.set(errorMessage(error));
    }
  }

  /** Drop the talk and its recording; not while it is being kept, which may still fail and come back to be checked. */
  async discard() {
    if (this.state() === 'keeping') return;
    clearInterval(this.watch);
    this.unfinished.set(null);
    if (this.state() === 'recording' && this.recorder.owner() === 'free') await this.recorder.stop();
    if (this.state() === 'writing') void this.engine.talkCancel();
    this.reset();
    await this.engine.talkDiscard().catch(() => {});
  }

  private reset() {
    this.state.set('idle');
    this.heardSoFar.set('');
    this.progress.set(0);
    this.talk.set(null);
    this.stopReason.set(null);
    this.failure.set(null);
    this.draft.set(null);
  }
}

/** When the talk recorded at `audio` (talks/20261021-140500.wav) was started, local time; now if it doesn't say. */
function startedAt(audio: string, now = new Date()) {
  const stamp = /(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)\.wav$/.exec(audio);
  if (stamp) return `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}`;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
