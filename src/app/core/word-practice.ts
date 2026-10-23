import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { Engine } from './engine';
import { errorMessage } from './library';
import { Attempt, AttemptSummary } from './models';
import { Playback } from './playback';
import { micError, Recorder } from './recorder';
import { Session } from './session';
import { bare } from './split';

/** The word practised: the text it is in, the word as written there ("there,"), and the folder its tries share. */
interface PractisedWord {
  textId: string;
  word: string;
  key: string;
}

/**
 * Practising the selected word on its own: its own tries, and recording a new one. Word tries are kept apart from
 * the part's: they never change its take, its scores, the text's progress or the week's activity.
 */
@Injectable({ providedIn: 'root' })
export class WordPractice {
  private engine = inject(Engine);
  private session = inject(Session);
  private playback = inject(Playback);
  private recorder = inject(Recorder);

  /** the word selected in the session; the same word elsewhere in the text, or in another case, is the same one */
  readonly practised = computed<PractisedWord | null>(
    () => {
      const text = this.session.text();
      const wordIndex = this.session.selected();
      const word = wordIndex == null ? '' : (this.session.words()[wordIndex] ?? '');
      return text && bare(word) ? { textId: text.id, word, key: `${text.id} ${bare(word).toLowerCase()}` } : null;
    },
    { equal: (first, second) => first?.key === second?.key },
  );
  /** the word's tries, newest first, and the newest in full */
  readonly tries = signal<AttemptSummary[]>([]);
  readonly latest = signal<Attempt | null>(null);
  readonly checking = signal(false);
  readonly error = signal<string | null>(null);
  /** a take of the word is being recorded (not one of the part) */
  readonly recording = computed(() => this.recorder.recording() && this.recorder.owner() === 'word');
  readonly preparing = computed(() => this.recorder.preparing() && this.recorder.owner() === 'word');
  /** the word the take being recorded is of */
  private taking: PractisedWord | null = null;
  /** counts the takes begun: one whose start finds a newer one begun leaves the microphone to it */
  private starts = 0;

  constructor() {
    effect(() => {
      const practised = this.practised();
      untracked(() => {
        // a take of a word no longer shown is dropped, not scored
        if (this.recorder.owner() === 'word' && this.taking?.key !== practised?.key) void this.recorder.stop();
        this.load(practised);
      });
    });
  }

  private async load(practised: PractisedWord | null) {
    this.tries.set([]);
    this.latest.set(null);
    this.error.set(null);
    if (!practised) return;
    try {
      const tries = await this.engine.wordAttempts(practised.textId, practised.word);
      if (!this.still(practised)) return;
      this.tries.set(tries);
      if (!tries.length) return;
      const latest = await this.engine.wordAttempt(practised.textId, practised.word, tries[0].id);
      if (this.still(practised)) this.latest.set(latest);
    } catch (error) {
      if (this.still(practised)) this.error.set(errorMessage(error));
    }
  }

  /** whether the word is still the one shown */
  private still(practised: PractisedWord) {
    return this.practised()?.key === practised.key;
  }

  /** Delete one try of the word, and show the tries left. */
  async deleteTry(id: string) {
    const practised = this.practised();
    if (!practised || this.recorder.owner() === 'word' || this.checking()) return;
    this.playback.stop();
    try {
      await this.engine.deleteWordAttempt(practised.textId, practised.word, id);
      const tries = await this.engine.wordAttempts(practised.textId, practised.word);
      const latest = tries.length ? await this.engine.wordAttempt(practised.textId, practised.word, tries[0].id) : null;
      if (!this.still(practised)) return;
      this.tries.set(tries);
      this.latest.set(latest);
      this.error.set(null);
    } catch (error) {
      if (this.still(practised)) this.error.set(errorMessage(error));
    }
  }

  async toggleRecord() {
    // the microphone may be busy with a take of the part (Session): that take is not this one to finish
    if (this.recorder.owner() === 'word' && this.recorder.recording()) return this.finishRecording();
    const practised = this.practised();
    if (this.recorder.owner() || this.checking() || !practised) return;
    this.playback.stop();
    this.taking = practised;
    const run = ++this.starts;
    try {
      await this.recorder.start('word');
    } catch (error) {
      if (run === this.starts) this.error.set(micError(error));
      return;
    }
    // dropped while the microphone got ready, and another take started since: that one is not this one to stop
    if (run !== this.starts) return;
    this.error.set(null);
    // another word was chosen while the microphone opened
    if (!this.still(practised)) await this.recorder.stop();
  }

  private async finishRecording() {
    const practised = this.taking!;
    // scoring from the click on, while the take's last moment is still being recorded
    this.checking.set(true);
    const blob = await this.recorder.stop();
    try {
      const attempt = await this.engine.checkWord(practised.textId, practised.word, blob);
      const tries = await this.engine.wordAttempts(practised.textId, practised.word);
      if (!this.still(practised)) return;
      this.tries.set(tries);
      this.latest.set(attempt);
      this.error.set(null);
    } catch (error) {
      if (this.still(practised)) this.error.set(errorMessage(error));
    } finally {
      this.checking.set(false);
    }
  }
}
