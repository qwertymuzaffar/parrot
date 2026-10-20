import { soundUnits } from './sounds';
import { soundTip } from './tips';

/** the tip for each sound of a word, as the word card would show it */
const tips = (word: string) => {
  const units = soundUnits(
    word,
    [...word].map(() => 1),
  );
  return units.map((unit, index) => soundTip(unit.text, index, units.length));
};

describe('soundTip', () => {
  it('says how to make the sounds learners most often miss', () => {
    expect(tips('think')[0]).toContain('between your teeth');
    expect(tips('very')[0]).toContain('top teeth on your lower lip');
    expect(tips('well')[0]).toContain('Round your lips');
    expect(tips('sing')[2]).toContain('through your nose, with no g');
  });

  it('treats other spellings of a sound as that sound', () => {
    expect(tips('phone')[0]).toBe(tips('fine')[0]);
    expect(tips('back')[2]).toContain('back of your tongue');
    expect(tips('tall')[2]).toBe(tips('lot')[0]);
  });

  it('asks to finish a word that often loses its last sound', () => {
    expect(tips('loud')[2]).toMatch(/^Finish the word with it/);
    expect(tips('paste')[3]).toMatch(/^Finish the word with it/);
    expect(tips('do')[0]).not.toMatch(/^Finish/);
  });

  it('keeps vowels, y as a vowel, c and g general rather than guess', () => {
    expect(tips('sound')[1]).toMatch(/^A vowel/);
    expect(tips('happy').at(-1)).toMatch(/^A vowel/);
    expect(tips('yes')[0]).toContain('as at the start of "yes"');
    expect(tips('city')[0]).toBe(tips('gem')[0]);
    expect(tips('city')[0]).toMatch(/^Listen with Slowly/);
  });

  it('names the silent letter of a pair', () => {
    expect(tips('know')[0]).toBe('The k is silent: say just the n.');
    expect(tips('lamb').at(-1)).toBe('The b is silent: end on the m.');
  });
});
