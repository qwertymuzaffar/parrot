import { fitTo } from './fit';

/**
 * A sentence box of 316 × 400 px whose text measures as `width(size, wrapped)` across, in the type size set on it
 * (33 px, the sentence's own, when none is); the layout engine is stood in for, as jsdom has none.
 */
function sentenceBox(width: (size: number, wrapped: boolean) => number, height = () => 0) {
  const sentence = document.createElement('p');
  document.body.append(sentence);
  const size = () => parseFloat(sentence.style.fontSize) || 33;
  const wrapped = () => sentence.style.getPropertyValue('--word-wrap') === 'anywhere';
  vi.spyOn(sentence, 'scrollWidth', 'get').mockImplementation(() => width(size(), wrapped()));
  vi.spyOn(sentence, 'scrollHeight', 'get').mockImplementation(() => height());
  vi.spyOn(sentence, 'clientWidth', 'get').mockReturnValue(316);
  vi.spyOn(sentence, 'clientHeight', 'get').mockReturnValue(400);
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({ fontSize: '33px' } as CSSStyleDeclaration);
  return sentence;
}

describe('fitting a sentence to its box', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('shrinks a long word until it fits whole, without breaking it', () => {
    // "Pneumonoultramicroscopic" is 340 px wide at 33 px: it fits at 30
    const sentence = sentenceBox((size) => Math.round(340 * (size / 33)));
    expect(fitTo(sentence)).toBe(30);
    expect([sentence.style.fontSize, sentence.style.getPropertyValue('--word-wrap')]).toEqual(['30px', '']);
  });

  it('breaks a word too wide for the box even at the smallest type, a URL, at the sentence’s own size', () => {
    const sentence = sentenceBox((size, wrapped) => (wrapped ? 316 : Math.round(900 * (size / 33))));
    expect(fitTo(sentence)).toBe(33);
    expect([sentence.style.fontSize, sentence.style.getPropertyValue('--word-wrap')]).toEqual(['', 'anywhere']);
  });

  it('keeps a sentence that fits at its own size', () => {
    const sentence = sentenceBox(() => 300);
    expect(fitTo(sentence)).toBe(33);
    expect([sentence.style.fontSize, sentence.style.getPropertyValue('--word-wrap')]).toEqual(['', '']);
  });

  it('shrinks a sentence too tall for the box, down to 18 px at most', () => {
    const sentence = sentenceBox(
      () => 300,
      () => 1000,
    );
    expect(fitTo(sentence)).toBe(18);
  });

  it('lets a word fit whole again when the box grows', () => {
    let box = 316;
    const sentence = sentenceBox((size, wrapped) => (wrapped ? box : Math.round(900 * (size / 33))));
    fitTo(sentence);
    box = 1000;
    vi.spyOn(sentence, 'clientWidth', 'get').mockReturnValue(box);
    expect(fitTo(sentence)).toBe(33);
    expect(sentence.style.getPropertyValue('--word-wrap')).toBe('');
  });
});
