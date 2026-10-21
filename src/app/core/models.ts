export type Mode = 'whole' | 'sentences' | 'short';

export interface TextItem {
  id: string;
  title: string;
  text: string;
  words: number;
  created: string;
  opened: string | null;
  mode: Mode;
  /** parts recorded at least once, and their average latest score */
  practised: number;
  average: number | null;
  /** the scores of every recorded part, by part key */
  scores: Record<string, PartScore>;
}

/** One part of a text that is read and recorded on its own. */
export interface Part {
  /** "3" or "3.2" (third sentence, its second short part) */
  label: string;
  text: string;
  /** a continuation of the sentence above it in the list */
  sub: boolean;
  /** index of its first word in the whole text: keeps the place when the mode changes */
  w0: number;
  /** the folder the engine keeps its tries in: p-<sha1 of the words> */
  key: string;
}

export type WordStatus = 'good' | 'unclear' | 'wrong';

export interface WordResult {
  w: string;
  t: [number, number] | null;
  score: number | null;
  ref: number | null;
  status: WordStatus;
  /** what speech recognition heard instead ("" = nothing), null when it heard the word */
  heard: string | null;
  extra: string;
  /** how surely each character was heard (takes from before 0.1.2 have none) */
  letters?: (number | null)[];
}

export interface Attempt {
  id: string;
  when: string;
  text: string;
  heard: string;
  words: WordResult[];
  duration: number;
  wpm: number;
  score: number;
  audio: string;
  /** the long pauses: the word each comes after, and how long it is (seconds); tries before 0.4 have none */
  pauses?: [number, number][];
}

export interface AttemptSummary {
  id: string;
  when: string;
  score: number;
  wpm: number;
  duration: number;
}

export interface PartScore {
  last: number;
  best: number;
  tries: number;
}

export interface SoundsLike {
  spell?: [string, boolean][];
  ipa?: string;
}

export interface Activity {
  days: { date: string; tries: number }[];
  tries: number;
  average: number | null;
}
