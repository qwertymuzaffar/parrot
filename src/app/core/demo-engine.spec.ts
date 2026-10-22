import { TestBed } from '@angular/core/testing';
import { appConfig } from '../app.config';
import { DemoEngine } from './demo-engine';
import { Engine, EngineError, TALK_CANCELLED } from './engine';
import { partKey, sentences } from './split';

describe('DemoEngine', () => {
  it('is the engine the app runs on in a plain browser', () => {
    TestBed.configureTestingModule({ providers: appConfig.providers });
    expect(TestBed.inject(Engine)).toBeInstanceOf(DemoEngine);
  });

  it('has its speech models, so the browser goes straight to the texts', async () => {
    expect((await new DemoEngine().info()).models).toEqual({ whisper: true, aligner: true });
  });

  it('serves sample texts, the last opened first, with the scores of their practised parts', async () => {
    const engine = new DemoEngine();
    const [lights, opened, other] = await engine.texts();
    expect([lights.title, opened.title, other.title]).toEqual(['The northern lights', 'Introducing yourself', 'A weather report']);
    expect(opened.id).toMatch(/^[0-9a-f]{10}$/);
    expect([lights.average, opened.practised, opened.average, other.practised]).toEqual([88, 2, 91, 0]);
    const first = sentences(opened.text)[0];
    expect(opened.scores[await partKey(first)]).toEqual({ last: 88, best: 88, tries: 2 });

    const tries = await engine.attempts(opened.id, first);
    expect(tries.map((each) => each.score)).toEqual([88, 71]);
    const oldest = await engine.attempt(opened.id, first, tries[1].id);
    expect(oldest.words.filter((word) => word.status !== 'good').map((word) => word.w)).toEqual(['software', 'engineer']);

    const activity = await engine.activity();
    expect(activity.days).toHaveLength(7);
    expect([activity.tries, activity.average]).toEqual([5, 85]);
  });

  it('mishears things as sinks, and has the sounds of the sample words', async () => {
    const engine = new DemoEngine();
    const [lights] = await engine.texts();
    const take = await engine.check(lights.id, lights.text, new Blob());
    const off = take.words.filter((word) => word.status !== 'good');
    expect(off.map((word) => [word.w, word.status, word.heard])).toEqual([
      ['beautiful', 'unclear', null],
      ['things', 'wrong', 'sinks'],
    ]);
    expect([take.score, take.heard]).toEqual([94, lights.text.replace('things', 'sinks')]);
    expect(off[1].letters!.slice(0, 3)).toEqual([0.2, 0.2, 0.62]);
    expect((await engine.soundsLike('Things,')).ipa).toBe('/ˈθɪŋz/');
    expect(await engine.soundsLike('constructor')).toEqual({});
  });

  it('keeps texts added, changed and deleted while the page is open', async () => {
    const engine = new DemoEngine();
    const added = await engine.addText('  Hello   there. ', 'Greeting', 'whole');
    expect([added.id, added.text, added.words, added.mode]).toEqual(['95e3ac5665', 'Hello there.', 2, 'whole']);
    await engine.updateText(added.id, { title: 'Hi', opened: true });
    expect((await engine.texts())[0].title).toBe('Hi');
    await engine.deleteText(added.id);
    expect((await engine.texts()).map((text) => text.id)).not.toContain(added.id);
    await expect(engine.addText(' ', '', 'whole')).rejects.toThrow(new EngineError('the text is empty'));
  });

  it('scores a take without hearing it, and plays it back from where it was recorded', async () => {
    const engine = new DemoEngine();
    const { id } = await engine.addText('Hello there, everybody.', '', 'whole');
    const take = await engine.check(id, 'Hello there, everybody.', new Blob(['take'], { type: 'audio/wav' }));
    expect(take.words.map((word) => word.status)).toEqual(['good', 'good', 'unclear']);
    expect(engine.audioUrl(take.audio)).toMatch(/^blob:/);
    expect((await engine.scores(id))[await partKey('Hello there, everybody.')].tries).toBe(1);

    const word = await engine.checkWord(id, 'there,', new Blob(['take']));
    expect((await engine.wordAttempts(id, 'There')).map((each) => each.id)).toEqual([word.id]);
    const again = await engine.checkWord(id, 'there', new Blob(['take']));
    expect([word.score, word.words[0].status, again.score, again.words[0].status]).toEqual([64, 'unclear', 81, 'good']);
    await expect(engine.check(id, 'Goodbye.', new Blob())).rejects.toBeInstanceOf(EngineError);
  });

  it('writes down any talk as the same few sentences, and keeps it as a text with the recording as its take', async () => {
    const engine = new DemoEngine();
    await expect(engine.talkKeep('Hi.', '')).rejects.toThrow('write the talk down first');
    await engine.talkStart(8000);
    await engine.talkFeed(new Int16Array(8000).fill(1000));
    await engine.talkFeed(new Int16Array(4000).fill(-1000));
    const progress: number[] = [];
    const talk = await engine.talkStop(({ done, total }) => progress.push(done / total));
    expect(progress).toEqual([0.25, 0.5, 0.75, 1]);
    expect(talk.words.filter((word) => word.status !== 'good').map((word) => word.w)).toEqual(['really']);
    expect(talk.pauses).toEqual([[9, 1.4]]);
    expect(talk.words.every((word) => word.heard === null)).toBe(true);

    // "Berlin" was "Bern", and "Alex" is a name
    await engine.setName('Alex', true);
    const meant = talk.heard.replace('Berlin', 'Bern');
    const kept = await engine.talkKeep(meant, 'About me');
    expect([kept.text.title, kept.text.mode, kept.text.spoken, kept.text.text]).toEqual(['About me', 'whole', true, meant]);
    const bern = kept.attempt.words[6];
    expect([bern.w, bern.status, bern.heard]).toEqual(['Bern', 'wrong', 'berlin']);
    expect(kept.attempt.words.filter((word) => word.status === 'unclear').map((word) => word.w)).toEqual(['really']);
    expect(engine.audioUrl(kept.attempt.audio)).toMatch(/^blob:/);
    expect((await engine.attempts(kept.text.id, meant)).map((each) => each.id)).toEqual([kept.attempt.id]);
    await expect(engine.talkKeep(meant, '')).rejects.toBeInstanceOf(EngineError);
  });

  it('cancels writing down a talk, keeping it, and discards it', async () => {
    const engine = new DemoEngine();
    await expect(engine.talkStop(() => {})).rejects.toThrow('there is no talk');
    await engine.talkStart(8000);
    await expect(engine.talkStop(() => {})).rejects.toThrow('Nothing was heard');
    await engine.talkFeed(new Int16Array(800));
    const stopping = engine.talkStop(() => {});
    await engine.talkCancel();
    await expect(stopping).rejects.toThrow(TALK_CANCELLED);
    expect((await engine.talkStop(() => {})).heard).toContain('Berlin');
    await engine.talkDiscard();
    await expect(engine.talkStop(() => {})).rejects.toThrow('there is no talk');
    await expect(engine.talkFeed(new Int16Array(1))).rejects.toThrow('no talk is being recorded');
  });

  it('refuses a talk over thirty minutes', async () => {
    const engine = new DemoEngine();
    await engine.talkStart(100);
    await engine.talkFeed(new Int16Array(100 * 1800));
    await expect(engine.talkFeed(new Int16Array(100 * 10))).rejects.toThrow('at most 30 minutes');
  });
});
