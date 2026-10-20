import { TestBed } from '@angular/core/testing';
import { appConfig } from '../app.config';
import { Engine, EngineError } from './engine';
import { DEV_ENGINE, HttpEngine } from './http-engine';

describe('HttpEngine', () => {
  let requests: { url: string; init?: RequestInit }[];
  let reply: { status: number; body: unknown };

  beforeEach(() => {
    requests = [];
    reply = { status: 200, body: [] };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('is the engine the app runs on in a plain browser', () => {
    TestBed.configureTestingModule({ providers: appConfig.providers });
    expect(TestBed.inject(Engine)).toBeInstanceOf(HttpEngine);
  });

  it('asks the Python engine at the paths engine/server.py serves', async () => {
    const engine = new HttpEngine();
    await engine.texts();
    await engine.attempts('95e3ac5665', 'Hello & bye?');
    await engine.soundsLike('things');
    await engine.addText('Hello there.', 'Greeting', 'sentences');
    expect(requests.map((request) => request.url)).toEqual([
      `${DEV_ENGINE}/api/texts`,
      `${DEV_ENGINE}/api/attempts?text=95e3ac5665&part=Hello%20%26%20bye%3F`,
      `${DEV_ENGINE}/api/pron?w=things`,
      `${DEV_ENGINE}/api/texts`,
    ]);
    expect(requests[3].init?.method).toBe('POST');
    expect(JSON.parse(requests[3].init?.body as string)).toEqual({ text: 'Hello there.', title: 'Greeting', mode: 'sentences' });
  });

  it('reports what the Python engine has as EngineInfo', async () => {
    reply.body = { data: '/data', whisper: false };
    expect(await new HttpEngine().info()).toEqual({
      data: '/data',
      models: { whisper: false, aligner: true },
      sizes: { whisper: 0, aligner: 0 },
    });
  });

  it("turns the engine's error, or its absence, into an EngineError", async () => {
    reply = { status: 404, body: { error: 'not found: 95e3ac5665' } };
    await expect(new HttpEngine().scores('95e3ac5665')).rejects.toThrow(new EngineError('not found: 95e3ac5665'));
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(new HttpEngine().texts()).rejects.toThrow(/not running/);
  });

  it('says that practising a word alone needs the desktop app', async () => {
    const engine = new HttpEngine();
    await expect(engine.wordAttempts('95e3ac5665', 'there')).rejects.toThrow(new EngineError('Word practice needs the desktop app'));
    await expect(engine.checkWord('95e3ac5665', 'there', new Blob())).rejects.toBeInstanceOf(EngineError);
    expect(requests).toEqual([]);
  });

  it('serves saved recordings from its files folder', () => {
    expect(new HttpEngine().audioUrl('/files/texts/95e3ac5665/p-1/take.wav')).toBe(`${DEV_ENGINE}/files/texts/95e3ac5665/p-1/take.wav`);
  });
});
