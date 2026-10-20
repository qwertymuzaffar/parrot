import { leastSure, level, soundUnits } from './sounds';

const texts = (word: string) =>
  soundUnits(
    word,
    [...word].map(() => 1),
  ).map((unit) => unit.text);

describe('soundUnits', () => {
  it('groups letters that spell one sound', () => {
    expect(texts('night')).toEqual(['n', 'igh', 't']);
    expect(texts('things')).toEqual(['th', 'i', 'ng', 's']);
    expect(texts('need')).toEqual(['n', 'ee', 'd']);
    expect(texts('Parrot')).toEqual(['P', 'a', 'rr', 'o', 't']);
    expect(texts('paste')).toEqual(['p', 'a', 's', 'te']);
    expect(texts('say')).toEqual(['s', 'ay']);
    expect(texts('you')).toEqual(['y', 'ou']);
  });

  it('leaves out punctuation', () => {
    expect(texts('loud.')).toEqual(['l', 'ou', 'd']);
  });

  it('scores a unit by its best letter', () => {
    // "things" said as "sinks": th low, ng fine though the model gave the sound to the n
    const units = soundUnits('things', [0.028, 0.015, 0.974, 0.974, 0.001, 0.986]);
    expect(units.map((unit) => unit.level)).toEqual(['bad', 'good', 'good', 'good']);
    expect(units[0].score).toBeCloseTo(0.028);
  });

  it('has no level without scores', () => {
    expect(soundUnits('it', []).map((unit) => unit.level)).toEqual(['none', 'none']);
  });
});

describe('leastSure', () => {
  it('finds the sound heard least surely', () => {
    // "out" from a real take, 97% for the word: ou 99%, t 95%
    const least = leastSure(soundUnits('out', [0.988, 0.973, 0.948]));
    expect(least?.text).toBe('t');
    expect(least?.score).toBeCloseTo(0.948);
  });

  it('skips sounds without a score, and finds none when nothing was scored', () => {
    expect(leastSure(soundUnits('it', [null, 0.6]))?.text).toBe('t');
    expect(leastSure(soundUnits('it', []))).toBeNull();
  });
});

describe('level', () => {
  it('tells off, fair and clear sounds apart', () => {
    expect([0.1, 0.3, 0.5, 0.89, 0.9, null].map(level)).toEqual(['bad', 'warn', 'fair', 'fair', 'good', 'none']);
  });
});
