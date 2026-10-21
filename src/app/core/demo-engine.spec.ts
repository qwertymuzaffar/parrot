import { TestBed } from '@angular/core/testing';
import { appConfig } from '../app.config';
import { DemoEngine } from './demo-engine';
import { Engine, EngineError } from './engine';
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
    const [opened, other] = await engine.texts();
    expect([opened.title, other.title]).toEqual(['Introducing yourself', 'A weather report']);
    expect(opened.id).toMatch(/^[0-9a-f]{10}$/);
    expect([opened.practised, opened.average, other.practised]).toEqual([2, 91, 0]);
    const first = sentences(opened.text)[0];
    expect(opened.scores[await partKey(first)]).toEqual({ last: 88, best: 88, tries: 2 });

    const tries = await engine.attempts(opened.id, first);
    expect(tries.map((each) => each.score)).toEqual([88, 71]);
    const oldest = await engine.attempt(opened.id, first, tries[1].id);
    expect(oldest.words.filter((word) => word.status !== 'good').map((word) => word.w)).toEqual(['software', 'engineer']);

    const activity = await engine.activity();
    expect(activity.days).toHaveLength(7);
    expect([activity.tries, activity.average]).toEqual([3, 84]);
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
    await expect(engine.check(id, 'Goodbye.', new Blob())).rejects.toBeInstanceOf(EngineError);
  });
});
