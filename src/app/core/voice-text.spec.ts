import { forVoice, wordForVoice } from './voice-text';

describe('the text the voice is given', () => {
  it('spells out an abbreviation in capitals, keeping its punctuation and s', () => {
    expect(forVoice('so I asked the GSA product owner which date format they wanted').spoken).toBe(
      'so I asked the G S A product owner which date format they wanted',
    );
    expect(forVoice('Our KPIs, the CEO’s goals (and the UK).').spoken).toBe("Our K P I's, the C E O's goals (and the U K).");
  });

  it('leaves the words said as words, capitals for weight, and longer or mixed ones', () => {
    expect(forVoice('NASA and NATO use JSON, NOT XML.').spoken).toBe('NASA and NATO use JSON, NOT X M L.');
    expect(forVoice('I use iOS and SaaS at UNICEF').spoken).toBe('I use iOS and SaaS at UNICEF');
  });

  it('leaves a text written all in capitals as it is', () => {
    expect(forVoice('STOP THE CAR NOW').spoken).toBe('STOP THE CAR NOW');
  });

  it('says where each word starts in what the voice is given', () => {
    const { spoken, starts } = forVoice('the GSA owner');
    expect(starts.map((start) => spoken.slice(start).split(' ')[0])).toEqual(['the', 'G', 'owner']);
    expect(starts).toEqual([0, 4, 10]);
  });

  it('gives a capital letter said alone a full stop, so it is read as the word', () => {
    expect(['I', 'A', 'a', 'GSA', 'NASA', 'you'].map(wordForVoice)).toEqual(['I.', 'A.', 'a', 'G S A', 'NASA', 'you']);
  });
});
