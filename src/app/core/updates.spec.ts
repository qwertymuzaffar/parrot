import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { isNewer, Updates, versionParts } from './updates';

describe('isNewer', () => {
  it('compares major.minor.patch as numbers', () => {
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('0.10.0', '0.2.0')).toBe(true);
    expect(isNewer('0.2.0', '0.10.0')).toBe(false);
    expect(isNewer('0.2.1', '0.2.0')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.1.9', '0.2.0')).toBe(false);
  });

  it('reads tags with a leading v and ignores a pre-release or build suffix', () => {
    expect(versionParts('v0.10.2-beta.1')).toEqual([0, 10, 2]);
    expect(isNewer('v0.3.0', '0.2.0')).toBe(true);
    expect(isNewer('0.3.0-beta.1', '0.3.0')).toBe(false);
    expect(isNewer('0.3.0', '0.3.0-rc.2')).toBe(false);
    expect(isNewer('0.3.0+build.7', '0.2.0')).toBe(true);
  });

  it('never calls something that is not a version newer', () => {
    expect(versionParts('nightly')).toBeNull();
    expect(isNewer('nightly', '0.2.0')).toBe(false);
    expect(isNewer('0.3', '0.2.0')).toBe(false);
  });
});

describe('Updates', () => {
  let calls: { cmd: string; args: unknown }[];
  let answer: () => unknown;

  beforeEach(() => {
    calls = [];
    answer = () => ({ version: '0.3.0', url: 'https://github.com/qwertymuzaffar/parrot/releases/tag/v0.3.0' });
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      return answer();
    });
  });

  afterEach(() => clearMocks());

  it('asks the engine for the latest release, and says whether it is newer', async () => {
    const updates = new Updates();
    expect(await updates.check('0.2.0')).toEqual({
      state: 'newer',
      release: { version: '0.3.0', url: 'https://github.com/qwertymuzaffar/parrot/releases/tag/v0.3.0' },
    });
    expect(await updates.check('0.3.0')).toEqual({ state: 'latest', version: '0.3.0' });
    expect(calls).toEqual([
      { cmd: 'latest_release', args: {} },
      { cmd: 'latest_release', args: {} },
    ]);
  });

  it("passes on the engine's reason when GitHub can't be asked", async () => {
    answer = () => {
      throw "Couldn't reach GitHub. Are you online?";
    };
    expect(await new Updates().check('0.2.0')).toEqual({ state: 'failed', message: "Couldn't reach GitHub. Are you online?" });
  });

  it('has no version to check in a plain browser', async () => {
    expect(await new Updates().current()).toBeNull();
  });
});
