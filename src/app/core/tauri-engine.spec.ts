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
    await engine.activity();
    await engine.soundsLike('things');
    expect(calls).toEqual([
      { cmd: 'texts', args: {} },
      { cmd: 'add_text', args: { text: 'Hello there.', title: 'Greeting', mode: 'sentences' } },
      { cmd: 'update_text', args: { id: '95e3ac5665', opened: true } },
      { cmd: 'delete_text', args: { id: '95e3ac5665' } },
      { cmd: 'scores', args: { text: '95e3ac5665' } },
      { cmd: 'attempts', args: { text: '95e3ac5665', part: 'Hello there.' } },
      { cmd: 'activity', args: {} },
      { cmd: 'pron', args: { w: 'things' } },
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
