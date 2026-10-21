import { clearMocks, mockConvertFileSrc, mockIPC } from '@tauri-apps/api/mocks';
import { EngineError } from './engine';
import { TauriEngine } from './tauri-engine';

describe('TauriEngine', () => {
  let calls: { cmd: string; args: unknown }[];

  beforeEach(() => {
    calls = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'info') return { data: '/data', models: { whisper: true, aligner: true }, sizes: { whisper: 1, aligner: 2 } };
      if (cmd === 'attempt') throw 'not found: 20260101-120000';
      return [];
    });
  });

  afterEach(() => clearMocks());

  it('calls the commands with the argument names src-tauri/src/lib.rs takes', async () => {
    const engine = new TauriEngine();
    await engine.texts();
    await engine.addText('Hello there.', 'Greeting', 'sentences');
    await engine.updateText('95e3ac5665', { opened: true });
    await engine.deleteText('95e3ac5665');
    await engine.scores('95e3ac5665');
    await engine.attempts('95e3ac5665', 'Hello there.');
    await engine.wordAttempts('95e3ac5665', 'there.');
    await engine.wordAttempt('95e3ac5665', 'there.', '20260101-120000');
    await engine.deleteAttempt('95e3ac5665', 'Hello there.', '20260101-120000');
    await engine.deleteWordAttempt('95e3ac5665', 'there.', '20260101-120000');
    await engine.activity();
    await engine.soundsLike('things');
    await engine.trashSize();
    await engine.emptyTrash();
    await engine.openDataFolder();
    expect(calls).toEqual([
      { cmd: 'texts', args: {} },
      { cmd: 'add_text', args: { text: 'Hello there.', title: 'Greeting', mode: 'sentences' } },
      { cmd: 'update_text', args: { id: '95e3ac5665', opened: true } },
      { cmd: 'delete_text', args: { id: '95e3ac5665' } },
      { cmd: 'scores', args: { text: '95e3ac5665' } },
      { cmd: 'attempts', args: { text: '95e3ac5665', part: 'Hello there.' } },
      { cmd: 'word_attempts', args: { text: '95e3ac5665', word: 'there.' } },
      { cmd: 'word_attempt', args: { text: '95e3ac5665', word: 'there.', id: '20260101-120000' } },
      { cmd: 'delete_attempt', args: { text: '95e3ac5665', part: 'Hello there.', id: '20260101-120000' } },
      { cmd: 'delete_word_attempt', args: { text: '95e3ac5665', word: 'there.', id: '20260101-120000' } },
      { cmd: 'activity', args: {} },
      { cmd: 'pron', args: { w: 'things' } },
      { cmd: 'trash_size', args: {} },
      { cmd: 'empty_trash', args: {} },
      { cmd: 'open_data_folder', args: {} },
    ]);
  });

  it('sends a take as the raw body, with the text and what was read in the headers', async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (...args: unknown[]) => unknown } }).__TAURI_INTERNALS__;
    const invoke = vi.spyOn(internals, 'invoke');
    const engine = new TauriEngine();
    await engine.check('95e3ac5665', 'Hello there.', new Blob(['take']));
    await engine.checkWord('95e3ac5665', '“there,”', new Blob(['take']));
    // the body's bytes as numbers: the Uint8Array is made in the page, not in the test's own realm
    const take = [...'take'].map((char) => char.charCodeAt(0));
    const sent = invoke.mock.calls.map(([cmd, body, options]) => [cmd, Array.from(body as Uint8Array), options]);
    expect(sent).toEqual([
      ['check', take, { headers: { 'x-text': '95e3ac5665', 'x-part': 'Hello%20there.' } }],
      ['check_word', take, { headers: { 'x-text': '95e3ac5665', 'x-word': '%E2%80%9Cthere%2C%E2%80%9D' } }],
    ]);
  });

  it('turns a failed command into an EngineError with its message', async () => {
    const failed = new TauriEngine().attempt('95e3ac5665', 'Hello there.', '20260101-120000');
    await expect(failed).rejects.toBeInstanceOf(EngineError);
    await expect(failed).rejects.toThrow('not found: 20260101-120000');
  });

  it('finds saved recordings in the data folder it was told about', async () => {
    mockConvertFileSrc('macos');
    const engine = new TauriEngine();
    await engine.info();
    expect(engine.audioUrl('/files/texts/95e3ac5665/p-1/take.wav')).toBe(engine.audioUrl('texts/95e3ac5665/p-1/take.wav'));
    expect(decodeURIComponent(engine.audioUrl('texts/95e3ac5665/p-1/take.wav'))).toContain('/data/texts/95e3ac5665/p-1/take.wav');
  });
});
