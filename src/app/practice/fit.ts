/** the smallest type a sentence is shrunk to; a longer text scrolls */
const FLOOR = 18;

/**
 * Shrink a sentence's type until it fits its box, across and down, or to FLOOR; the type size it settled on. A
 * long word is made smaller rather than cut in two; only a word too wide for the box even at FLOOR (a URL) breaks,
 * through `--word-wrap`, which the words' `overflow-wrap` reads, and at the sentence's own size: shrinking would
 * not keep it whole.
 */
export function fitTo(sentence: HTMLElement): number {
  const tooWide = () => sentence.scrollWidth > sentence.clientWidth + 1;
  sentence.style.removeProperty('--word-wrap');
  sentence.style.fontSize = `${FLOOR}px`;
  if (tooWide()) sentence.style.setProperty('--word-wrap', 'anywhere');
  sentence.style.fontSize = '';
  let size = parseFloat(getComputedStyle(sentence).fontSize);
  while ((sentence.scrollHeight > sentence.clientHeight + 1 || tooWide()) && size > FLOOR) {
    size -= 1;
    sentence.style.fontSize = `${size}px`;
  }
  return size;
}
