import { bare, sentences, shortRanges } from './split';

describe('sentences', () => {
  it('splits at a full stop followed by a capital', () => {
    expect(sentences('Hi, I am Sam. I build apps! Do you?')).toEqual(['Hi, I am Sam.', 'I build apps!', 'Do you?']);
  });

  it('keeps names with dots and abbreviations whole', () => {
    expect(sentences('I used Node.js and Express, e.g. for APIs. Then Java.')).toEqual([
      'I used Node.js and Express, e.g. for APIs.',
      'Then Java.',
    ]);
  });
});

describe('shortRanges', () => {
  const cut = (sentence: string) => shortRanges(sentence.split(' ')).map(([start, end]) => sentence.split(' ').slice(start, end).join(' '));

  it('cuts a long sentence at commas', () => {
    expect(
      cut(
        'I have about eleven years of professional experience in software development, since 2015, and almost all of it is front-end work.',
      ),
    ).toEqual([
      'I have about eleven years of professional experience in software development,',
      'since 2015, and almost all of it is front-end work.',
    ]);
  });

  it('does not cut two words before a full stop', () => {
    expect(cut('A group of sunspots about sixteen times as wide as the Earth had been firing flares for days.')).toEqual([
      'A group of sunspots about sixteen times as wide as the Earth had been firing flares for days.',
    ]);
  });

  it('leaves a short sentence alone', () => {
    expect(cut('Thank you for your time.')).toEqual(['Thank you for your time.']);
  });
});

describe('bare', () => {
  it('drops the punctuation around a word, as the engine does, and keeps what is inside it', () => {
    expect(['“Hello,', '(there)', 'you?!', '2.5', 'Node.js', 'e.g.', "don't"].map(bare)).toEqual([
      'Hello',
      'there',
      'you',
      '2.5',
      'Node.js',
      'e.g',
      "don't",
    ]);
  });
});
