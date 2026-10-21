//! Compare what was read with what the speech recognizer heard, word by word.
//!
//! Both sides are turned into the same tokens first: lower case, no punctuation, and numbers as digits whichever
//! way they were written ("nineteen fifty-nine", "1959" -> "#1959"), so only real differences count.

use regex::Regex;
use serde::{Deserialize, Serialize};
use similar::{Algorithm, DiffOp, capture_diff_slices};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

static UNITS: LazyLock<HashMap<&str, i64>> = LazyLock::new(|| {
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen"
        .split(' ')
        .enumerate()
        .map(|(value, word)| (word, value as i64))
        .collect()
});
static TENS: LazyLock<HashMap<&str, i64>> = LazyLock::new(|| {
    "twenty thirty forty fifty sixty seventy eighty ninety".split(' ').enumerate().map(|(index, word)| (word, 10 * (index as i64 + 2))).collect()
});
// "second" is left out on purpose: it is far more often the time unit ("twenty seconds") than the ordinal
static ORDINALS: LazyLock<HashMap<&str, i64>> = LazyLock::new(|| {
    [
        ("first", 1),
        ("third", 3),
        ("fourth", 4),
        ("fifth", 5),
        ("sixth", 6),
        ("seventh", 7),
        ("eighth", 8),
        ("ninth", 9),
        ("tenth", 10),
        ("eleventh", 11),
        ("twelfth", 12),
        ("thirteenth", 13),
        ("fourteenth", 14),
        ("fifteenth", 15),
        ("sixteenth", 16),
        ("seventeenth", 17),
        ("eighteenth", 18),
        ("nineteenth", 19),
        ("twentieth", 20),
        ("thirtieth", 30),
        ("fortieth", 40),
        ("fiftieth", 50),
        ("sixtieth", 60),
        ("seventieth", 70),
        ("eightieth", 80),
        ("ninetieth", 90),
    ]
    .into_iter()
    .collect()
});
static SCALES: LazyLock<HashMap<&str, i64>> = LazyLock::new(|| {
    [("hundred", 100), ("thousand", 1_000), ("million", 1_000_000), ("billion", 1_000_000_000), ("trillion", 1_000_000_000_000)].into_iter().collect()
});
/// words that are the same thing said two ways (text spelling / whisper spelling), or that whisper drops
static SAME: LazyLock<HashMap<&str, &str>> = LazyLock::new(|| {
    [
        ("it's", "its"),
        ("percent", ""),
        ("%", ""),
        ("dollars", ""),
        ("dollar", ""),
        ("fahrenheit", "f"),
        ("degrees", ""),
        ("okay", "ok"),
        ("a.i", "ai"),
        // British spelling in the text; whisper small.en writes American
        ("kilometres", "kilometers"),
        ("metres", "meters"),
        ("litres", "liters"),
        ("centimetres", "centimeters"),
        ("grey", "gray"),
        ("colour", "color"),
        ("colours", "colors"),
        ("plough", "plow"),
        ("ploughs", "plows"),
        ("centre", "center"),
        ("programme", "program"),
        ("favourite", "favorite"),
        ("aluminium", "aluminum"),
        ("travelled", "traveled"),
        ("travelling", "traveling"),
        ("fibre", "fiber"),
        ("theatre", "theater"),
        ("defence", "defense"),
        ("licence", "license"),
        ("neighbour", "neighbor"),
        ("honour", "honor"),
        ("behaviour", "behavior"),
        ("catalogue", "catalog"),
        ("organise", "organize"),
        ("realise", "realize"),
        ("recognise", "recognize"),
        ("analyse", "analyze"),
        ("manoeuvre", "maneuver"),
        ("sulphur", "sulfur"),
        ("practise", "practice"),
        ("mould", "mold"),
        ("storey", "story"),
    ]
    .into_iter()
    .collect()
});
static DIGITS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+(?:[.,]\d+)*(?:st|nd|rd|th)?$").unwrap());
static CLOCK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{1,2}\.[0-5]\d$").unwrap());
static RAW: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d+(?:[.,]\d+)*(?:st|nd|rd|th)?|[a-z][a-z'.]*").unwrap());
static SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(st|nd|rd|th)$").unwrap());

fn is_digits(token: &str) -> bool {
    DIGITS.is_match(token)
}

fn numeric(token: &str) -> bool {
    UNITS.contains_key(token) || TENS.contains_key(token) || ORDINALS.contains_key(token) || SCALES.contains_key(token) || is_digits(token)
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Unit,
    Tens,
    Digits,
    Scale,
}

/// A run of number tokens (words or digits) as one digit string: "sixty eight" -> 68, "nineteen eighty six" -> 1986,
/// "twenty twenty four" -> 2024, "three thirty" -> 330, "a hundred and fifty thousand" -> 150000,
/// "one point three million" -> 1300000, "twenty first" -> 21, and the same from whisper's digits.
/// Juxtaposed groups (a year, a clock time) are joined, later groups padded to two digits.
fn compose(run: &[String]) -> String {
    let mut groups: Vec<f64> = vec![];
    let (mut cur, mut total) = (0f64, 0f64);
    let mut frac: Option<String> = None;
    let mut prev: Option<Kind> = None;
    let fold = |cur: &mut f64, frac: &mut Option<String>| {
        if let Some(digits) = frac.as_ref().filter(|digits| !digits.is_empty()) {
            *cur = format!("{}.{}", *cur as i64, digits).parse().unwrap_or(*cur);
        }
        *frac = None;
    };
    for tok in run {
        let tok = tok.as_str();
        if tok == "a" || tok == "and" {
            if tok == "a" {
                cur = 1.0;
                prev = Some(Kind::Unit);
            }
            continue;
        }
        if tok == "point" {
            frac = Some(String::new());
            continue;
        }
        let (value, kind);
        if is_digits(tok) {
            let mut number = SUFFIX.replace(tok, "").replace(',', "");
            if CLOCK.is_match(&number) {
                number = number.replace('.', ""); // whisper writes "three-thirty" as "3.30": a clock time, not 3.3
            }
            value = number.parse::<f64>().unwrap_or(0.0);
            kind = Kind::Digits;
        } else if let Some(&scale) = SCALES.get(tok) {
            fold(&mut cur, &mut frac);
            if scale == 100 {
                cur = if cur == 0.0 { 1.0 } else { cur } * 100.0;
            } else {
                total += if cur == 0.0 { 1.0 } else { cur } * scale as f64;
                cur = 0.0;
            }
            prev = Some(Kind::Scale);
            continue;
        } else {
            value = *UNITS.get(tok).or(TENS.get(tok)).or(ORDINALS.get(tok)).unwrap_or(&0) as f64;
            kind = if TENS.contains_key(tok) { Kind::Tens } else { Kind::Unit };
        }
        if let Some(fraction_digits) = frac.as_mut() {
            fraction_digits.push_str(&(value as i64).to_string());
            continue;
        }
        // a new group when a number follows one it cannot combine with (19 | 86, 20 | 24, 3 | 30)
        if matches!(prev, Some(Kind::Unit | Kind::Tens | Kind::Digits)) && !(prev == Some(Kind::Tens) && kind == Kind::Unit && value < 10.0) {
            groups.push(total + cur);
            total = 0.0;
            cur = 0.0;
        }
        cur += value;
        prev = Some(kind);
    }
    fold(&mut cur, &mut frac);
    groups.push(total + cur);
    if groups.len() == 1 {
        let value = groups[0];
        return if value.fract() != 0.0 {
            format!("{value:.6}").trim_end_matches('0').trim_end_matches('.').to_string()
        } else {
            format!("{}", value as i64)
        };
    }
    let mut out = format!("{}", groups[0] as i64);
    for group in &groups[1..] {
        out += &format!("{:02}", *group as i64);
    }
    out
}

/// Lower-case word tokens; runs of number words or digits become one "#digits" token.
pub fn toks(text: &str) -> Vec<String> {
    let lowered = text.to_lowercase().replace('\u{2019}', "'").replace(['-', ':'], " ");
    let mut words: Vec<String> = vec![];
    for found in RAW.find_iter(&lowered) {
        let mut word = found.as_str().trim_matches(|character| character == '\'' || character == '.').to_string();
        if word.ends_with("'s") && !numeric(&word[..word.len() - 2]) {
            word.truncate(word.len() - 2);
        }
        if let Some(spelling) = SAME.get(word.as_str()) {
            word = spelling.to_string();
        }
        if !word.is_empty() && !numeric(&word) && word.ends_with('s') {
            // "eighteens" / whisper "18s", "nineties" / "90s", "hundreds"
            let mut stem = word[..word.len() - 1].to_string();
            if stem.ends_with("ie") && TENS.contains_key(format!("{}y", &stem[..stem.len() - 2]).as_str()) {
                stem = format!("{}y", &stem[..stem.len() - 2]);
            }
            let stem_text = stem.as_str();
            if UNITS.contains_key(stem_text) || TENS.contains_key(stem_text) || SCALES.contains_key(stem_text) || is_digits(stem_text) {
                words.push(stem);
                words.push("s".into());
                continue;
            }
        }
        if !word.is_empty() {
            words.push(word);
        }
    }
    let mut out = vec![];
    let mut word_index = 0;
    while word_index < words.len() {
        let word = &words[word_index];
        let nxt = words.get(word_index + 1).map(String::as_str).unwrap_or("");
        let starts = numeric(word) || (word == "a" && SCALES.contains_key(nxt));
        if !starts {
            out.push(word.clone());
            word_index += 1;
            continue;
        }
        let mut run: Vec<String> = vec![];
        while word_index < words.len() {
            let word = words[word_index].as_str();
            let nxt = words.get(word_index + 1).map(String::as_str).unwrap_or("");
            if numeric(word)
                || (word == "a" && SCALES.contains_key(nxt) && run.is_empty())
                || (word == "and" && !run.is_empty() && numeric(nxt))
                || (word == "point" && !run.is_empty() && (UNITS.contains_key(nxt) || is_digits(nxt)))
            {
                run.push(word.to_string());
                word_index += 1;
            } else {
                break;
            }
        }
        out.push(format!("#{}", compose(&run)));
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Op {
    Replace,
    Delete,
    Insert,
}

/// Stretches where the two token lists really differ (joined spellings like "light day" / "lightday" are not).
pub fn diff_ops(old: &[String], new: &[String]) -> Vec<(Op, usize, usize, usize, usize)> {
    capture_diff_slices(Algorithm::Myers, old, new)
        .into_iter()
        .filter_map(|op| match op {
            DiffOp::Equal { .. } => None,
            DiffOp::Delete { old_index, old_len, new_index } => Some((Op::Delete, old_index, old_index + old_len, new_index, new_index)),
            DiffOp::Insert { old_index, new_index, new_len } => Some((Op::Insert, old_index, old_index, new_index, new_index + new_len)),
            DiffOp::Replace { old_index, old_len, new_index, new_len } => {
                Some((Op::Replace, old_index, old_index + old_len, new_index, new_index + new_len))
            }
        })
        .filter(|(_, i1, i2, j1, j2)| old[*i1..*i2].concat() != new[*j1..*j2].concat())
        .collect()
}

/// How alike two words are, 0-1 (difflib's ratio: twice the matching characters over the total).
fn ratio(first: &str, second: &str) -> f64 {
    let (first_chars, second_chars): (Vec<char>, Vec<char>) = (first.chars().collect(), second.chars().collect());
    if first_chars.is_empty() && second_chars.is_empty() {
        return 1.0;
    }
    let matched: usize = capture_diff_slices(Algorithm::Myers, &first_chars, &second_chars)
        .iter()
        .map(|op| if let DiffOp::Equal { len, .. } = op { *len } else { 0 })
        .sum();
    2.0 * matched as f64 / (first_chars.len() + second_chars.len()) as f64
}

/// {index in xs: index in ys}: an in-order pairing that maximises how alike the paired words are
/// (pairs below floor are not made).
pub fn pair_up(xs: &[String], ys: &[String], floor: f64) -> HashMap<usize, usize> {
    let (xs_len, ys_len) = (xs.len(), ys.len());
    let sim: Vec<Vec<f64>> = xs.iter().map(|x_word| ys.iter().map(|y_word| ratio(x_word, y_word)).collect()).collect();
    let mut best = vec![vec![0f64; ys_len + 1]; xs_len + 1];
    for x_index in (0..xs_len).rev() {
        for y_index in (0..ys_len).rev() {
            let take = if sim[x_index][y_index] >= floor { sim[x_index][y_index] + best[x_index + 1][y_index + 1] } else { -1.0 };
            best[x_index][y_index] = take.max(best[x_index + 1][y_index]).max(best[x_index][y_index + 1]);
        }
    }
    let mut out = HashMap::new();
    let (mut x_index, mut y_index) = (0, 0);
    while x_index < xs_len && y_index < ys_len {
        if sim[x_index][y_index] >= floor && (best[x_index][y_index] - (sim[x_index][y_index] + best[x_index + 1][y_index + 1])).abs() < 1e-12 {
            out.insert(x_index, y_index);
            x_index += 1;
            y_index += 1;
        } else if (best[x_index][y_index] - best[x_index + 1][y_index]).abs() < 1e-12 {
            x_index += 1;
        } else {
            y_index += 1;
        }
    }
    out
}

/// For each word of the text: None if whisper heard it, else what it heard instead ("" = nothing);
/// plus the extra words whisper heard after each word.
pub fn heard_words(text: &str, heard: &str) -> (Vec<Option<String>>, Vec<String>) {
    let sw: Vec<&str> = text.split_whitespace().collect();
    // which word owns each token: numbers spelled over several words become one token ("nineteen fifty-nine");
    // a longer prefix can have fewer tokens ("two hundred and" is [#200, and], "two hundred and fifty" is [#250]),
    // so the tokens a later word merges away are given back
    let mut owner: Vec<usize> = vec![];
    for word_index in 0..sw.len() {
        let tokens_so_far = toks(&sw[..=word_index].join(" ")).len();
        owner.truncate(tokens_so_far);
        while owner.len() < tokens_so_far {
            owner.push(word_index);
        }
    }
    let (text_tokens, heard_tokens) = (toks(text), toks(heard));
    let mut wrong: Vec<Option<String>> = vec![None; sw.len()];
    let mut extra: Vec<String> = vec![String::new(); sw.len()];
    let clean = |token: &str| token.replace('#', "");
    let push = |list: &mut String, token: &str| {
        if !list.is_empty() {
            list.push(' ');
        }
        list.push_str(token);
    };
    for (op, i1, i2, j1, j2) in diff_ops(&text_tokens, &heard_tokens) {
        match op {
            Op::Insert => {
                let word_index = if i1 > 0 { owner[i1 - 1] } else { 0 };
                for token in &heard_tokens[j1..j2] {
                    push(&mut extra[word_index], &clean(token));
                }
            }
            Op::Delete => {
                for token_index in i1..i2 {
                    wrong[owner[token_index]] = Some(String::new());
                }
            }
            Op::Replace => {
                // each word paired with the heard word most like it: "suite of about two hundred" heard as "suit"
                // gives "suite" -> "suit", and the rest were not heard
                let pairs = pair_up(&text_tokens[i1..i2], &heard_tokens[j1..j2], 0.4);
                for (text_offset, &word_index) in owner[i1..i2].iter().enumerate() {
                    let heard_as = pairs.get(&text_offset).map(|heard_offset| clean(&heard_tokens[j1 + heard_offset])).unwrap_or_default();
                    wrong[word_index] = Some(match &wrong[word_index] {
                        Some(so_far) if !so_far.is_empty() && !heard_as.is_empty() => format!("{so_far} {heard_as}"),
                        Some(so_far) if !so_far.is_empty() => so_far.clone(),
                        _ => heard_as,
                    });
                }
                let paired: HashSet<usize> = pairs.values().copied().collect();
                for heard_offset in 0..(j2 - j1) {
                    if paired.contains(&heard_offset) {
                        continue;
                    }
                    // heard but matching no word of the text: an extra after the word before it
                    let before = pairs.iter().filter(|(_, paired_offset)| **paired_offset < heard_offset).map(|(text_offset, _)| *text_offset).max();
                    let word_index = match before {
                        Some(text_offset) => owner[i1 + text_offset],
                        None if i1 > 0 => owner[i1 - 1],
                        None => owner[i1],
                    };
                    push(&mut extra[word_index], &clean(&heard_tokens[j1 + heard_offset]));
                }
            }
        }
    }
    // words that own no token of their own share the verdict of the word before ("fifty-nine" of "nineteen fifty-nine")
    let owned: HashSet<usize> = owner.iter().copied().collect();
    for word_index in 1..sw.len() {
        if !owned.contains(&word_index) {
            wrong[word_index] = wrong[word_index - 1].clone();
        }
    }
    (wrong, extra)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct WordTime {
    pub t: Option<[f64; 2]>,
    pub score: Option<f64>,
    /// how surely each character of the word was heard, None for characters that aren't letters (punctuation)
    pub letters: Option<Vec<Option<f64>>>,
}

/// A gap between two words longer than this (seconds) is a long pause: the listener notices it.
pub const LONG_PAUSE: f64 = 1.0;

/// The long pauses in a take: the word each comes after, and how long it is (seconds). Only words that were placed
/// count, so a pause around a word that wasn't heard is measured to the words on either side of it.
pub fn pauses(words: &[WordResult]) -> Vec<(usize, f64)> {
    let placed: Vec<(usize, [f64; 2])> = words.iter().enumerate().filter_map(|(word_index, word)| word.t.map(|t| (word_index, t))).collect();
    placed
        .windows(2)
        .filter_map(|pair| {
            let gap = pair[1].1[0] - pair[0].1[1];
            (gap > LONG_PAUSE).then(|| (pair[0].0, (gap * 100.0).round() / 100.0))
        })
        .collect()
}

/// A word's verdict, saved and sent as "good", "unclear" or "wrong".
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WordStatus {
    Good,
    Unclear,
    Wrong,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WordResult {
    pub w: String,
    pub t: Option<[f64; 2]>,
    pub score: Option<f64>,
    #[serde(rename = "ref")]
    pub reference: Option<f64>,
    pub status: WordStatus,
    pub heard: Option<String>,
    pub extra: String,
    /// the score of each character of the word (takes from before 0.1.2 have none)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub letters: Option<Vec<Option<f64>>>,
}

/// How far a word's sound score may fall below the reference's before it counts as "sounded off", and the plain
/// floor when there is no reference reading. Tuned for the wav2vec2 aligner (see the tests in align.rs).
pub const OFF_VS_REFERENCE: f64 = 0.2;
pub const OFF_BELOW: f64 = 0.75;
pub const OFF_FLOOR: f64 = 0.5;

/// A word's verdict by how clearly it was said alone: good, or unclear (sounded off).
fn by_sound(score: Option<f64>, reference_score: Option<f64>) -> WordStatus {
    match (score, reference_score) {
        (Some(score), Some(reference_score)) if score < OFF_BELOW && reference_score - score > OFF_VS_REFERENCE => WordStatus::Unclear,
        (Some(score), None) if score < OFF_FLOOR => WordStatus::Unclear,
        _ => WordStatus::Good,
    }
}

/// How a word is kept in the names list: lower case, without the punctuation around it or a possessive 's.
pub fn name_key(word: &str) -> String {
    let word = word.trim_matches(|character: char| !character.is_alphanumeric()).to_lowercase();
    word.strip_suffix("'s").or_else(|| word.strip_suffix("’s")).unwrap_or(&word).to_string()
}

/// Names are never misheard: speech recognition writes a name it doesn't know as some other word, every time. A name
/// it misheard keeps what was heard, for information, and is judged by how clearly it was said.
pub fn spare_names(words: &mut [WordResult], names: &[String]) {
    for word in words.iter_mut().filter(|word| word.status == WordStatus::Wrong && names.contains(&name_key(&word.w))) {
        word.status = by_sound(word.score, word.reference);
    }
}

/// Per-word verdicts: good, unclear (sounded off) or wrong (heard as another word, or not heard).
pub fn judge(text: &str, heard: &str, mine: &[WordTime], reference: Option<&[WordTime]>) -> Vec<WordResult> {
    let (wrong, extra) = heard_words(text, heard);
    text.split_whitespace()
        .enumerate()
        .map(|(word_index, word)| {
            let score = mine.get(word_index).and_then(|word_time| word_time.score);
            let reference_score = reference.and_then(|reference_times| reference_times.get(word_index)).and_then(|word_time| word_time.score);
            let status = if wrong[word_index].is_some() { WordStatus::Wrong } else { by_sound(score, reference_score) };
            WordResult {
                w: word.to_string(),
                t: mine.get(word_index).and_then(|word_time| word_time.t),
                score,
                reference: reference_score,
                status,
                heard: wrong[word_index].clone(),
                extra: extra[word_index].clone(),
                letters: mine.get(word_index).and_then(|word_time| word_time.letters.clone()),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn heard(text: &str, recognized: &str) -> Vec<(String, String)> {
        let (verdicts, _) = heard_words(text, recognized);
        text.split_whitespace().zip(verdicts).filter_map(|(word, verdict)| verdict.map(|heard_as| (word.to_string(), heard_as))).collect()
    }

    #[test]
    fn numbers_become_digits() {
        assert_eq!(toks("nineteen fifty-nine"), vec!["#1959"]);
        assert_eq!(toks("in 1959"), vec!["in", "#1959"]);
        assert_eq!(toks("the seventh and the eleventh"), vec!["the", "#7", "and", "the", "#11"]);
        assert_eq!(toks("up to seventy metres."), vec!["up", "to", "#70", "meters"]);
        assert_eq!(toks("about two hundred tests"), toks("about 200 tests"));
        assert_eq!(toks("one point three million"), vec!["#1300000"]);
        assert_eq!(toks("at three thirty"), toks("at 3:30"));
    }

    #[test]
    fn misheard_words_get_what_was_heard() {
        assert_eq!(
            heard("some GPS-guided tractors veered off course or", "some GPS guided tractors weird of course or"),
            vec![("veered".into(), "weird".into()), ("off".into(), "of".into())]
        );
        assert_eq!(
            heard("NASA's Ice Sat Two satellite lost altitude", "NASA's ice set to satellite lost attitude")
                .into_iter()
                .find(|(word, _)| word == "altitude"),
            Some(("altitude".into(), "attitude".into()))
        );
    }

    #[test]
    fn a_dropped_stretch_is_not_heard() {
        let got =
            heard("I built a Playwright suite of about two hundred tests. On the backend side, I started", "I built a playwright suit. I started");
        assert_eq!(got[0], ("suite".into(), "suit".into()));
        assert!(got[1..].iter().all(|(_, heard_as)| heard_as.is_empty()), "{got:?}");
        assert!(got.iter().any(|(word, _)| word == "hundred"));
    }

    #[test]
    fn a_misheard_word_after_a_number_is_the_only_one_wrong() {
        // "two hundred and" has one token more than "two hundred and fifty": the word after must still own its token
        assert_eq!(
            heard("about two hundred and fifty tests passed", "about two hundred and fifty tasks passed"),
            vec![("tests".into(), "tasks".into())]
        );
        assert_eq!(heard("I have one point three apples today", "I have one point three apple today"), vec![("apples".into(), "apple".into())]);
    }

    #[test]
    fn same_words_said_differently_match() {
        assert!(heard("I'm a front-end engineer with ten years in Angular", "I'm a frontend engineer with 10 years in Angular").is_empty());
        assert!(heard("practise the colour", "practice the color").is_empty());
    }

    #[test]
    fn judge_marks_wrong_and_unclear() {
        let text = "the beautiful things";
        let mine = [
            WordTime { t: Some([0.0, 0.2]), score: Some(0.95), letters: None },
            WordTime { t: Some([0.2, 0.7]), score: Some(0.4), letters: None },
            WordTime { t: Some([0.7, 1.0]), score: Some(0.9), letters: None },
        ];
        let reference = vec![WordTime { t: None, score: Some(0.95), letters: None }; 3];
        let results = judge(text, "the beautiful sinks", &mine, Some(&reference));
        assert_eq!(results.iter().map(|word| word.status).collect::<Vec<_>>(), vec![WordStatus::Good, WordStatus::Unclear, WordStatus::Wrong]);
        assert_eq!(results[2].heard.as_deref(), Some("sinks"));
    }

    #[test]
    fn a_name_is_never_misheard_but_can_sound_off() {
        let mine = [
            WordTime { t: None, score: Some(0.9), letters: None },
            WordTime { t: None, score: Some(0.9), letters: None },
            WordTime { t: None, score: Some(0.3), letters: None },
            WordTime { t: None, score: Some(0.9), letters: None },
        ];
        let mut results = judge("Muzaffar's from Tashkent, really", "Mozafar's from Tashken, rarely", &mine, None);
        let names = vec![name_key("Muzaffar's"), name_key("“Tashkent”")];
        assert_eq!(names, vec!["muzaffar", "tashkent"]);
        spare_names(&mut results, &names);
        // the clear name is good, the one said unclearly sounded off, a word that isn't a name stays misheard
        assert_eq!(
            results.iter().map(|word| word.status).collect::<Vec<_>>(),
            vec![WordStatus::Good, WordStatus::Good, WordStatus::Unclear, WordStatus::Wrong]
        );
        assert_eq!(results[2].heard.as_deref(), Some("tashken"), "what was heard is kept");
    }

    #[test]
    fn long_pauses_are_found_between_placed_words() {
        let placed = |t: Option<[f64; 2]>| WordTime { t, score: Some(0.9), letters: None };
        // a 0.6 s gap, then a word not placed, then 1.8 s from "for" to "words"
        let mine = [placed(Some([0.0, 0.4])), placed(Some([1.0, 1.3])), placed(None), placed(Some([3.1, 3.5]))];
        let results = judge("pausing for some words", "pausing for some words", &mine, None);
        assert_eq!(pauses(&results), vec![(1, 1.8)]);
        assert!(pauses(&results[..2]).is_empty());
    }

    #[test]
    fn statuses_keep_their_saved_names() {
        // tries already on disk (from either engine) say "good", "unclear" or "wrong"
        let statuses = [WordStatus::Good, WordStatus::Unclear, WordStatus::Wrong];
        assert_eq!(serde_json::to_string(&statuses).unwrap(), r#"["good","unclear","wrong"]"#);
        assert_eq!(serde_json::from_str::<Vec<WordStatus>>(r#"["good","unclear","wrong"]"#).unwrap(), statuses);
    }
}
