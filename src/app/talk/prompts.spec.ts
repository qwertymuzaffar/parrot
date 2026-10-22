import { asTitle, pick, PROMPT_SETS } from './prompts';

describe('prompts', () => {
  it('come in sets of about ten, interview first', () => {
    expect(PROMPT_SETS.map((set) => set.key)).toEqual(['interview', 'small-talk', 'presentations']);
    expect(PROMPT_SETS.every((set) => set.prompts.length >= 8 && new Set(set.prompts).size === set.prompts.length)).toBe(true);
  });

  it('picks another prompt than the one shown', () => {
    const [interview] = PROMPT_SETS;
    expect(pick(interview, null, () => 0)).toBe('Tell me about yourself.');
    expect(pick(interview, 'Tell me about yourself.', () => 0)).toBe('Why do you want this job?');
    expect(pick(interview, null, () => 0.999)).toBe('Why should we hire you?');
    expect(pick({ key: 'one', label: 'One', prompts: ['Only this.'] }, 'Only this.')).toBe('Only this.');
  });

  it('titles a text by its prompt, without the full stop', () => {
    expect([asTitle('Tell me about yourself.'), asTitle('Why should we hire you?')]).toEqual([
      'Tell me about yourself',
      'Why should we hire you?',
    ]);
  });
});
