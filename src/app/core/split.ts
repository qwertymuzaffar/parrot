import { Mode, Part } from './models';

/**
 * Sentences: a sentence ends at . ! or ? followed by a space and a capital, a digit or a quote,
 * so "Node.js" and "e.g. the" stay whole.
 */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?]["”’)]*)\s+(?=["“(]?[A-Z0-9])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

const CONJUNCTION = /^(and|but|or|which|where|when|while|because|so|then|that|who)$/i;
const isPunct = (word: string) => /[,;:—–)]$|[.!?]["”’)]*$/.test(word);

/**
 * Short parts of one sentence, as [start, end) word ranges: cut after , ; : — once a part has 4+ words,
 * before and/but/which… once it has 10+, anywhere at 16 unless a comma or full stop is two words away,
 * and always at 22.
 */
export function shortRanges(words: string[]): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
    const len = wordIndex - start + 1;
    const left = words.length - wordIndex - 1;
    if (left === 0) {
      out.push([start, wordIndex + 1]);
      break;
    }
    // not before "and TypeScript," when a comma follows a word or two later: that cut comes a moment later
    let toPunct = 0;
    while (wordIndex + 1 + toPunct < words.length && !isPunct(words[wordIndex + 1 + toPunct])) toPunct++;
    const cut =
      (isPunct(words[wordIndex]) && len >= 4 && left >= 3) ||
      (len >= 10 && CONJUNCTION.test(words[wordIndex + 1]) && left >= 4 && toPunct > 2) ||
      (len >= 16 && toPunct > 2) ||
      len >= 22;
    if (cut) {
      out.push([start, wordIndex + 1]);
      start = wordIndex + 1;
    }
  }
  return out;
}

/** The engine's folder name for a part: p- and the first 10 hex digits of the SHA-1 of its words. */
export async function partKey(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text.split(/\s+/).join(' '));
  const hash = await crypto.subtle.digest('SHA-1', bytes);
  const hex = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return 'p-' + hex.slice(0, 10);
}

export async function splitText(text: string, mode: Mode): Promise<Part[]> {
  const out: Omit<Part, 'key'>[] = [];
  let w0 = 0;
  const list = mode === 'whole' ? [text.split(/\s+/).join(' ')] : sentences(text);
  list.forEach((sentence, sentenceIndex) => {
    const words = sentence.split(' ');
    const ranges = mode === 'short' ? shortRanges(words) : [[0, words.length] as [number, number]];
    ranges.forEach(([start, end], rangeIndex) => {
      out.push({
        label: ranges.length > 1 ? `${sentenceIndex + 1}.${rangeIndex + 1}` : `${sentenceIndex + 1}`,
        text: words.slice(start, end).join(' '),
        sub: rangeIndex > 0,
        w0: w0 + start,
      });
    });
    w0 += words.length;
  });
  return Promise.all(out.map(async (part) => ({ ...part, key: await partKey(part.text) })));
}

/** A word without the punctuation around it, for the dictionary and the voice: at its ends only, as the engine trims it
 * ("2.5" and "Node.js" keep theirs). */
export const bare = (word: string) => word.replace(/^[.,;:!?"“”()]+|[.,;:!?"“”()]+$/g, '');
