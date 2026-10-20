/** How to say a sound, for the one a take got least right. Keyed by how the sound is spelled, as soundUnits groups
 * a word ("th", "ng", "ck"); vowels are left general, since their spelling doesn't tell which vowel it is ("ou" in
 * "sound" and "you"). */
const CONSONANTS: Record<string, string> = {
  th: 'Put the tip of your tongue lightly between your teeth and push air (or your voice) out, so it is not a t, d, s or z.',
  r: 'Pull the tip of your tongue back without touching the roof of your mouth, lips a little rounded: no tap or roll.',
  l: 'Touch the ridge just behind your top teeth with the tip of your tongue and let the voice flow around its sides.',
  v: 'Rest your top teeth on your lower lip and push your voice through: it should buzz, not pop like a b.',
  w: 'Round your lips as for "oo", then open them; your teeth stay off your lip, so it is not a v.',
  ng: 'Lift the back of your tongue as for a k and let the sound out through your nose, with no g after it.',
  f: 'Rest your top teeth on your lower lip and blow air out, without voice.',
  h: 'Just breathe out, as when fogging a mirror, without scraping your throat.',
  sh: 'Round your lips a little and push air over the middle of your tongue: a hush, wider than s.',
  ch: 'Start with your tongue on the ridge behind your top teeth, as for t, and release it into sh.',
  j: 'Like ch with your voice on: tongue on the ridge behind your top teeth, released into a buzz.',
  s: 'Tongue tip just behind your top teeth, and a thin stream of air: a hiss, or a buzz like z in words like "is" and "dogs".',
  z: 'Like s with your voice on: it should buzz.',
  p: 'Close both lips and open them with a small puff of air.',
  b: 'Close both lips and open them with your voice already on.',
  t: 'Touch the ridge behind your top teeth with the tip of your tongue and release it cleanly.',
  d: 'Touch the ridge behind your top teeth with the tip of your tongue and release it with your voice on.',
  k: 'Lift the back of your tongue against the roof of your mouth and release it with a small puff.',
  m: 'Close your lips and hum through your nose.',
  n: 'Tongue tip on the ridge behind your top teeth, and hum through your nose.',
  y: 'Raise the middle of your tongue towards the roof of your mouth, as at the start of "yes".',
  qu: 'A k going straight into a w: round your lips as you release it.',
  x: 'A k and an s together: ks.',
  kn: 'The k is silent: say just the n.',
  gn: 'The g is silent: say just the n.',
  mb: 'The b is silent: end on the m.',
  wr: 'The w is silent: say just the r, tongue pulled back without touching the roof of your mouth.',
};

/** spellings of the same sound as one of the above */
const SAME: Record<string, string> = { ph: 'f', ck: 'k', dg: 'j', wh: 'w', ss: 's', ff: 'f', ll: 'l', rr: 'r' };

/** sounds a word often loses at its end */
const DROPPED_AT_THE_END = new Set(['t', 'd', 'k', 'p', 'b', 's', 'z']);

const VOWEL =
  'A vowel: copy how wide your mouth opens and how long the vowel lasts. Listen with Slowly, then use Compare to hear the difference.';

/** A tip for the sound at `index` of a word's `count` sounds, spelled as soundUnits gives it. c and g ("city", "gem")
 * and other spellings of more than one sound get the general tip rather than a wrong one. */
export function soundTip(spelling: string, index: number, count: number): string {
  const last = index === count - 1;
  let letters = spelling.toLowerCase().replace(/'/g, '');
  // a silent final e goes with the sound before it ("te" in "paste")
  if (last && letters.length > 1 && letters.endsWith('e') && !/[aeiou]/.test(letters[0])) letters = letters.slice(0, -1);
  // y is a consonant only before a vowel at the start ("yes"), else a vowel ("happy")
  if (/^[aeiou]/.test(letters) || (letters[0] === 'y' && (letters.length > 1 || index > 0))) return VOWEL;
  const doubled = letters.length === 2 && letters[0] === letters[1] ? letters[0] : letters;
  const sound = SAME[letters] ?? SAME[doubled] ?? doubled;
  const tip = CONSONANTS[sound];
  if (!tip) return 'Listen with Slowly, then use Compare to hear how yours differs.';
  return last && DROPPED_AT_THE_END.has(sound) ? `Finish the word with it: don't drop it. ${tip}` : tip;
}
