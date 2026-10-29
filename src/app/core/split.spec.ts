import { bare, forgetSplits, inEnglish, sentences, shortRanges, splitKnown, splitText, wordCount } from './split';

describe('the splits kept', () => {
  it('keeps a split by its words and mode, and forgets the splits of words gone in every mode', async () => {
    const old = 'One two. Three four.';
    const edited = 'One two. Three five.';
    for (const mode of ['whole', 'sentences', 'short'] as const) await splitText(old, mode);
    await splitText(edited, 'sentences');
    expect([splitKnown(old, 'whole')?.length, splitKnown(old, 'sentences')?.length, splitKnown(old, 'short')?.length]).toEqual([1, 2, 2]);
    forgetSplits(old);
    expect([splitKnown(old, 'whole'), splitKnown(old, 'sentences'), splitKnown(old, 'short')]).toEqual([undefined, undefined, undefined]);
    expect(splitKnown(edited, 'sentences')?.length).toBe(2);
  });
});

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

  // the same cases as text.rs sentences_are_cut_as_the_interface_cuts_them, so the window and the engine agree
  it('keeps a title with its name and a page or volume with its number', () => {
    expect(
      sentences(
        'Mr. Smith arrived at 10 a.m. and left at 2.5 p.m. Dr. Who stayed. The U.S. team won 3.5 to 2. See p. 12 of vol. 3 for details.',
      ),
    ).toEqual([
      'Mr. Smith arrived at 10 a.m. and left at 2.5 p.m.',
      'Dr. Who stayed.',
      'The U.S. team won 3.5 to 2.',
      'See p. 12 of vol. 3 for details.',
    ]);
    expect(sentences('Ask Mrs. Lee and (Prof. Kim) about No. 5, e.g. Fig. 2 in ch. 3 and pp. 10 to 12. Then go.')).toEqual([
      'Ask Mrs. Lee and (Prof. Kim) about No. 5, e.g. Fig. 2 in ch. 3 and pp. 10 to 12.',
      'Then go.',
    ]);
  });

  it('still ends a sentence at "etc.", at the word "no." and at a page with no number after it', () => {
    expect(sentences('We had tea, cake, etc. Then we left. He said no. 5 days later he came. Turn the p. The end.')).toEqual([
      'We had tea, cake, etc.',
      'Then we left.',
      'He said no.',
      '5 days later he came.',
      'Turn the p.',
      'The end.',
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

  it('cuts a pasted transcript with no punctuation, 20,000 words, without stalling the window', () => {
    const words = Array.from({ length: 20_000 }, (_, wordIndex) => ['so', 'we', 'talked', 'about', 'the', 'plan'][wordIndex % 6]);
    const t0 = performance.now();
    const ranges = shortRanges(words);
    // scanning ahead from every word took about 3 s here
    expect(performance.now() - t0).toBeLessThan(200);
    expect([ranges.length, ranges.every(([start, end]) => end - start <= 22), ranges.at(-1)![1]]).toEqual([1667, true, 20_000]);
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

describe('wordCount', () => {
  it('counts the words with a letter or a digit in them, in any alphabet', () => {
    expect(['Hello there.', '... !!! ??? --- ***', '\u200B', 'привет — мир, 東京 2.5'].map(wordCount)).toEqual([2, 0, 0, 4]);
  });
});

describe('inEnglish', () => {
  // the engine's store.rs checks the same texts the same way
  it('turns away a text most of whose words have no letter a to z under their marks', () => {
    expect(['Привет, как дела?', '東京へ行きます', 'ß ß', 'Hello, привет мир!'].map(inEnglish)).toEqual([false, false, false, false]);
  });

  it('takes a few names or words in another alphabet, accents, and numbers', () => {
    expect(
      ['I flew from Tokyo to Moscow and said Привет to everyone.', 'Hello, привет!', 'Café au lait, naïve', '1 2 3', '...'].map(inEnglish),
    ).toEqual([true, true, true, true, true]);
  });
});
