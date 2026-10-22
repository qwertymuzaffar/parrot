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
      // a clip: its rate, then two samples, 1 and -2
      if (cmd === 'clip') return new Uint8Array([0x80, 0xbb, 0, 0, 1, 0, 254, 255]).buffer;
      if (cmd === 'peaks') return [0.5, 1];
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

  it('runs a talk through the talk commands, the sound as the raw body', async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (...args: unknown[]) => unknown } }).__TAURI_INTERNALS__;
    const invoke = vi.spyOn(internals, 'invoke');
    const engine = new TauriEngine();
    await engine.talkStart(48000);
    // two samples, 1 and -2, as 16-bit little-endian bytes; a block cut from a longer buffer sends only its own
    await engine.talkFeed(new Int16Array([7, 1, -2]).subarray(1));
    await engine.talkStop(() => {});
    await engine.talkCancel();
    await engine.talkKeep('Hello there.', '  ');
    await engine.talkKeep('Hello there.', 'Greeting');
    await engine.talkDiscard();
    await engine.talkLeft();
    const sent = invoke.mock.calls
      .filter(([cmd]) => String(cmd).startsWith('talk_'))
      .map(([cmd, body]) => [cmd, body instanceof Uint8Array || ArrayBuffer.isView(body) ? Array.from(body as Uint8Array) : body]);
    expect(sent).toEqual([
      ['talk_start', { rate: 48000 }],
      ['talk_feed', [1, 0, 254, 255]],
      ['talk_stop', {}],
      ['talk_cancel', {}],
      ['talk_keep', { text: 'Hello there.', title: null }],
      ['talk_keep', { text: 'Hello there.', title: 'Greeting' }],
      ['talk_discard', {}],
      ['talk_left', {}],
    ]);
  });

  it('has the engine draw a recording and cut a word from it', async () => {
    const engine = new TauriEngine();
    expect(await engine.peaks('talks/20261021-100000.wav', 92)).toEqual([0.5, 1]);
    const clip = (await engine.clip('texts/95e3ac5665/p-1/t.wav', 1.25, 1.5))!;
    expect([clip.rate, [...clip.samples]]).toEqual([48000, [1, -2]]);
    expect(calls).toEqual([
      { cmd: 'peaks', args: { audio: 'talks/20261021-100000.wav', slices: 92 } },
      { cmd: 'clip', args: { audio: 'texts/95e3ac5665/p-1/t.wav', from: 1.25, to: 1.5 } },
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
