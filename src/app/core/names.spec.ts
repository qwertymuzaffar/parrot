import { TestBed } from '@angular/core/testing';
import { Engine, EngineError } from './engine';
import { nameKey, Names } from './names';

describe('names', () => {
  it('are kept as the engine keeps them: lower case, bare, without a possessive', () => {
    expect(nameKey('Muzaffar’s')).toBe('muzaffar');
    expect(nameKey('“Tashkent,”')).toBe('tashkent');
    expect(nameKey("O'Brien's")).toBe("o'brien");
    expect(nameKey('...')).toBe('');
  });

  it('load from the engine, and marking one updates the list or says why it could not', async () => {
    let list = ['tashkent'];
    const engine = {
      names: async () => list,
      setName: async (word: string, name: boolean) => {
        if (word === 'New York') throw new EngineError('“New York” can’t be a name');
        list = name ? [...list, nameKey(word)].sort() : list.filter((kept) => kept !== nameKey(word));
        return list;
      },
    };
    TestBed.configureTestingModule({ providers: [{ provide: Engine, useValue: engine }] });
    const names = TestBed.inject(Names);
    await names.load();
    expect(names.has('Tashkent.')).toBe(true);
    await names.set('Muzaffar', true);
    expect(names.list()).toEqual(['muzaffar', 'tashkent']);
    expect(names.has('muzaffar’s')).toBe(true);
    await names.set('New York', true);
    expect(names.error()).toBe('“New York” can’t be a name');
    await names.set('Tashkent', false);
    expect([names.list(), names.error()]).toEqual([['muzaffar'], null]);
  });

  it('are none when the engine cannot list them', async () => {
    TestBed.configureTestingModule({ providers: [{ provide: Engine, useValue: {} }] });
    const names = TestBed.inject(Names);
    await names.load();
    expect(names.has('anything')).toBe(false);
  });
});
