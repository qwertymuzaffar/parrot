import { Mode, Part } from './models';

/** Abbreviations a sentence does not end at (the engine's text.rs has the same lists): a title before a name ("Mr.
 * Smith", "St. Louis", "e.g. Python"), and a page, volume or number before its digits ("p. 12", "vol. 3", "No. 5"; the
 * word "no." can end a sentence, so only "No." is one). "etc." and "Jr." often end a sentence, so they are not here. */
const TITLES = new Set(['mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'st.', 'mt.', 'vs.', 'e.g.', 'i.e.']);
const NUMBERED = new Set(['p.', 'pp.', 'vol.', 'fig.', 'ch.']);

/** Whether the sentence goes on after `word` (one that could end it) into the words `next`. */
function abbreviated(word: string, next: string): boolean {
  const written = word.replace(/^["“(]+/, '');
  const lower = written.toLowerCase();
  return TITLES.has(lower) || ((NUMBERED.has(lower) || written === 'No.') && /^["“(]?[0-9]/.test(next));
}

/**
 * Sentences: a sentence ends at . ! or ? followed by a space and a capital, a digit or a quote,
 * so "Node.js" and "e.g. the" stay whole, but not at an abbreviation such as "Mr." or "p." before its name or number.
 */
export function sentences(text: string): string[] {
  // the text cut wherever a sentence could end, with the spaces of each cut kept at the odd indexes
  const pieces = text.split(/((?<=[.!?]["”’)]*)\s+(?=["“(]?[A-Z0-9]))/);
  const out: string[] = [];
  let sentence = pieces[0];
  for (let index = 1; index < pieces.length; index += 2) {
    const next = pieces[index + 1];
    if (abbreviated(/\S*$/.exec(sentence)![0], next)) sentence += pieces[index] + next;
    else {
      out.push(sentence);
      sentence = next;
    }
  }
  out.push(sentence);
  return out.map((each) => each.trim()).filter(Boolean);
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
  // how many words from each one on until a punctuated one, counted once from the end: scanning ahead from every
  // word took seconds on a long sentence with no punctuation (a pasted transcript)
  const unpunctuated = new Array<number>(words.length + 1).fill(0);
  for (let wordIndex = words.length - 1; wordIndex >= 0; wordIndex--)
    unpunctuated[wordIndex] = isPunct(words[wordIndex]) ? 0 : unpunctuated[wordIndex + 1] + 1;
  let start = 0;
  for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
    const len = wordIndex - start + 1;
    const left = words.length - wordIndex - 1;
    if (left === 0) {
      out.push([start, wordIndex + 1]);
      break;
    }
    // not before "and TypeScript," when a comma follows a word or two later: that cut comes a moment later
    const toPunct = unpunctuated[wordIndex + 1];
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

/** The keys of `parts`, each once, in reading order: a part said more than once ("Thank you.") is one part to practise,
 * and a take of it is a take of every copy (the engine keeps the tries by key). */
export const distinctKeys = (parts: Part[]) => [...new Set(parts.map((part) => part.key))];

/** each text split, by mode and words: the same words always split the same way, so they are split (and hashed) once.
 * Kept for the texts the library has (see forgetSplits): the splits of words edited away or deleted would otherwise
 * stay for the session, hundreds of KB per edit of a long text. */
const splits = new Map<string, Part[]>();

const MODES: Mode[] = ['whole', 'sentences', 'short'];

/** The parts of a text split before, at once; undefined if it hasn't been. */
export function splitKnown(text: string, mode: Mode): Part[] | undefined {
  return splits.get(mode + '\n' + text);
}

/** Forget the splits of `text`, in every mode: no text has these words any more (edited, or deleted). */
export function forgetSplits(text: string) {
  for (const mode of MODES) splits.delete(mode + '\n' + text);
}

export async function splitText(text: string, mode: Mode): Promise<Part[]> {
  const known = splitKnown(text, mode);
  if (known) return known;
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
  const parts = await Promise.all(out.map(async (part) => ({ ...part, key: await partKey(part.text) })));
  splits.set(mode + '\n' + text, parts);
  return parts;
}

/** A word to say: one with a letter or a digit in it ("!!!", "---" and a zero-width space are none). */
const isWord = (word: string) => /[\p{L}\p{N}]/u.test(word);

/** How many words to say `text` has: a text with none is not taken, by the window or the engine. */
export const wordCount = (text: string) => text.split(/\s+/).filter(isWord).length;

/** Whether a word reads in English: it has a letter a to z under its marks ("café", "naïve") or a digit, said as a
 * number. "привет", "東京" and "ß" do not: Parrot hears English only, and matches a word by its a-to-z letters. */
const readsInEnglish = (word: string) => /[a-z0-9]/i.test(word.normalize('NFD'));

/** Whether Parrot can check `text`: no more than half its words to say are in another alphabet, as the engine counts
 * them. A name or a few words in one are fine; a text in one would score 0% whatever is said, so it is not taken, by
 * the window or the engine. A text with no words passes here: wordCount turns it away. */
export function inEnglish(text: string): boolean {
  const words = text.split(/\s+/).filter(isWord);
  return words.filter((word) => !readsInEnglish(word)).length * 2 <= words.length;
}

/** A word without the punctuation around it, for the dictionary and the voice: at its ends only, as the engine trims it
 * ("2.5" and "Node.js" keep theirs). */
export const bare = (word: string) => word.replace(/^[.,;:!?"“”()]+|[.,;:!?"“”()]+$/g, '');

/** How a word said alone is kept, as the engine keeps it (store.rs `word_key`): without the punctuation around it, lower
 * case, and each letter written one way (NFC), so "The", "the," and a "café" whose é was typed as e and a mark are each
 * one word with one set of tries. */
export const wordKey = (word: string) => bare(word.trim()).normalize('NFC').toLowerCase();
