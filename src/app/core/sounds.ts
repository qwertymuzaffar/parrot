/** A word's letters grouped into the units that spell one sound, each with how surely it was heard. */
export interface SoundUnit {
  text: string;
  /** 0-1, the best of its letters (the aligner credits a sound to one of the letters that spell it) */
  score: number | null;
  level: 'good' | 'warn' | 'bad' | 'none';
}

/** consonant pairs spoken as one sound, or with one letter silent */
const PAIRS = new Set(['th', 'sh', 'ch', 'ph', 'wh', 'gh', 'ck', 'ng', 'qu', 'kn', 'wr', 'gn', 'mb', 'dg']);
const VOWEL = /[aeiou]/;

/** Below these a unit sounds off (amber) or wrong (red); set from real takes, where a clearly said sound scores
 * 0.9 or more and a sound said as another one under 0.1. */
export const WARN_BELOW = 0.5;
export const BAD_BELOW = 0.2;

export function level(score: number | null): SoundUnit['level'] {
  if (score == null) return 'none';
  return score < BAD_BELOW ? 'bad' : score < WARN_BELOW ? 'warn' : 'good';
}

/**
 * Group a word ("night") and its per-character scores into sound units ("n", "igh", "t"): vowel teams (with a y, w
 * or gh after them), consonant pairs like th and ng, double letters, and a silent final e with the letter before it.
 * Characters that are not letters are left out.
 */
export function soundUnits(word: string, letters: (number | null)[]): SoundUnit[] {
  const chars = [...word]
    .map((char, charIndex) => ({ char, score: letters[charIndex] ?? null }))
    .filter((entry) => /\p{L}|'/u.test(entry.char) && entry.char !== "'");
  const units: { text: string; scores: (number | null)[] }[] = [];
  const low = (charIndex: number) => chars[charIndex]?.char.toLowerCase() ?? '';
  for (let start = 0; start < chars.length;) {
    let size = 1;
    if (VOWEL.test(low(start))) {
      while (VOWEL.test(low(start + size))) size++;
      if (low(start + size) === 'g' && low(start + size + 1) === 'h') size += 2;
      else if (/[yw]/.test(low(start + size)) && !VOWEL.test(low(start + size + 1))) size++;
    } else if (PAIRS.has(low(start) + low(start + 1)) || (low(start) === low(start + 1) && low(start) !== '')) {
      size = 2;
    }
    // a final e after a consonant is silent: it goes with the sound before it ("paste": p, a, s, te)
    if (
      start + size === chars.length - 1 &&
      low(start + size) === 'e' &&
      !VOWEL.test(low(start + size - 1)) &&
      chars.length > 2 &&
      units.length > 0
    )
      size++;
    const part = chars.slice(start, start + size);
    units.push({
      text: part.map((entry) => entry.char).join(''),
      scores: part.map((entry) => entry.score),
    });
    start += size;
  }
  return units.map((unit) => {
    const known = unit.scores.filter((letterScore): letterScore is number => letterScore != null);
    const score = known.length ? Math.max(...known) : null;
    return { text: unit.text, score, level: level(score) };
  });
}
