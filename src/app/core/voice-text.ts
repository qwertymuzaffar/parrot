/** Short words in capitals that are said as words, not letter by letter: left to the voice as written. Also a few
 * words written in capitals for weight ("NOT", "ALL"), which spelled out would make no sense. */
const SAID_AS_WORDS = new Set([
  'ACID',
  'AIDS',
  'AJAX',
  'ARIA',
  'ASAP',
  'BIOS',
  'CORS',
  'CRUD',
  'DOM',
  'FOMO',
  'GIF',
  'GUI',
  'IKEA',
  'JPEG',
  'JSON',
  'LAMP',
  'LEGO',
  'NASA',
  'NATO',
  'OPEC',
  'PIN',
  'RAID',
  'RAM',
  'REST',
  'ROM',
  'SASS',
  'SIM',
  'SOAP',
  'SWOT',
  'WASM',
  'WIFI',
  'YAML',
  'YOLO',
  'ZIP',
  'ALL',
  'AND',
  'BUT',
  'MUST',
  'NEW',
  'NO',
  'NOT',
  'NOW',
  'ONLY',
  'THE',
  'VERY',
  'YES',
  'YOU',
]);

/** a word of two to four capitals, maybe with a plural or possessive s, in whatever punctuation surrounds it */
const ABBREVIATION = /^([("“‘']*)([A-Z]{2,4})(s|'s|’s)?([.,;:!?)"”’']*)$/;
/** a number in Roman numerals ("World War II", "Henry VIII"): the voice reads it as the number, spelled it would not */
const ROMAN = /^[IVX]+$/;

/** An abbreviation in capitals spelled out with spaces ("GSA" → "G S A", "APIs" → "A P I's"), so that a voice that
 * doesn't know it says its letters rather than reading it as a word. Any other word is left as it is. */
function spelled(word: string) {
  const match = ABBREVIATION.exec(word);
  if (!match || SAID_AS_WORDS.has(match[2]) || ROMAN.test(match[2])) return word;
  const [, before, letters, s, after] = match;
  return before + letters.split('').join(' ') + (s ? "'s" : '') + after;
}

/**
 * A part's text as the voice should get it, and where each of its words (split on spaces, as the screen splits them)
 * starts in it, so the word being spoken can still be lit. A text written all in capitals is left as it is: its words
 * are not abbreviations.
 */
export function forVoice(text: string): { spoken: string; starts: number[] } {
  const shouted = !/[a-z]/.test(text);
  const starts: number[] = [];
  const words: string[] = [];
  let offset = 0;
  for (const word of text.split(' ')) {
    const said = shouted ? word : spelled(word);
    starts.push(offset);
    words.push(said);
    offset += said.length + 1;
  }
  return { spoken: words.join(' '), starts };
}

/** A word to be said on its own (its punctuation already gone). A capital letter alone is read as its name ("capital
 * I"): with a full stop it is read as the word. */
export function wordForVoice(word: string) {
  return /^[A-Z]$/.test(word) ? `${word}.` : spelled(word);
}
