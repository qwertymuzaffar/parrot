//! Text to the phonemes Kokoro reads: a port of misaki's English rules (hexgrad/misaki, Apache 2.0), the phonemizer
//! Kokoro was trained with, without its part-of-speech tagger. Its two lexicons are built in (us_gold and us_silver,
//! 180,000 words in Kokoro's own symbols). A word in neither is read from the CMU dictionary's sounds, and a word in
//! none of them by the Naval Research Laboratory's letter-to-sound rules (nrl.rs).
//!
//! The symbols are the IPA with one character per sound: A is eɪ, I is aɪ, O is oʊ, W is aʊ, Y is ɔɪ, ʤ and ʧ the
//! affricates, ɾ the flapped t of "water", ᵊ and ᵻ reduced vowels; ˈ and ˌ stand before the stressed vowel. The
//! punctuation that shapes a reading (, . ; : ! ? — … and quotes) goes through; anything else is said as nothing.

use crate::{nrl, numbers};
use flate2::read::GzDecoder;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

const PRIMARY: char = 'ˈ';
const SECONDARY: char = 'ˌ';
const VOWELS: &str = "AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ";
const CONSONANTS: &str = "bdfhjklmnpstvwzðŋɡɹɾʃʒʤʧθ";
/// the sounds that count double when weighing which word of a compound keeps its stress
const DIPHTHONGS: &str = "AIOQWYʤʧ";
/// the sounds a t is flapped after, before an unstressed vowel ("waited": wˈAɾᵻd)
const TAUS: &str = "AIOWYiuæɑəɛɪɹʊʌ";
const PUNCTS: &str = ";:,.!?—…\"“”";
const NON_QUOTE_PUNCTS: &str = ";:,.!?—…";
/// what a word may contain besides letters and digits, said as nothing
const JUNK: &str = "',-._‘’/";

fn is_vowel(character: char) -> bool {
    VOWELS.contains(character)
}

/// A gold entry: how the word is said, and how when nothing follows it ("her" at the end of a phrase keeps its stress).
struct Entry {
    default: String,
    alone: Option<String>,
}

struct Lexicon {
    gold: HashMap<String, Entry>,
    silver: HashMap<String, String>,
}

static LEXICON: LazyLock<Lexicon> = LazyLock::new(|| {
    let gold = unpack(include_bytes!("../assets/us_gold.json.gz"))
        .into_iter()
        .filter_map(|(word, value)| {
            let entry = match value {
                Value::String(phonemes) => Entry { default: phonemes, alone: None },
                Value::Object(by_tag) => Entry {
                    default: by_tag.get("DEFAULT")?.as_str()?.to_string(),
                    alone: by_tag.get("None").and_then(Value::as_str).map(String::from),
                },
                _ => return None,
            };
            Some((word, entry))
        })
        .collect();
    let silver = unpack(include_bytes!("../assets/us_silver.json.gz"))
        .into_iter()
        .filter_map(|(word, value)| Some((word, value.as_str()?.to_string())))
        .collect();
    Lexicon { gold, silver }
});

fn unpack(gz: &[u8]) -> serde_json::Map<String, Value> {
    serde_json::from_reader(GzDecoder::new(gz)).expect("a lexicon")
}

fn capitalize(word: &str) -> String {
    let mut characters = word.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().collect::<String>() + &characters.as_str().to_lowercase(),
        None => String::new(),
    }
}

/// A lexicon entry as misaki finds it: the word itself, or a lowercase word by its capitalised form and the other way
/// round ("Berlin" is listed, "berlin" is asked for).
fn grown<'a, T>(map: &'a HashMap<String, T>, word: &str) -> Option<&'a T> {
    if let Some(found) = map.get(word) {
        return Some(found);
    }
    if word.chars().count() < 2 {
        return None;
    }
    let lower = word.to_lowercase();
    if word == lower {
        map.get(&capitalize(word))
    } else if word == capitalize(&lower) {
        map.get(&lower)
    } else {
        None
    }
}

impl Lexicon {
    fn gold(&self, word: &str) -> Option<&Entry> {
        grown(&self.gold, word)
    }

    fn silver(&self, word: &str) -> Option<&str> {
        grown(&self.silver, word).map(String::as_str)
    }
}

/// What is known of the word after this one, read right to left: whether it starts with a vowel (None after
/// punctuation or at the end), whether it is "to", and whether it is a letter said by its name.
#[derive(Clone, Copy, Default)]
struct Ctx {
    future_vowel: Option<bool>,
    future_to: bool,
    future_letter: bool,
}

#[derive(Clone, Debug)]
struct Tok {
    text: String,
    /// whether a space follows it in the text
    space: bool,
    phonemes: Option<String>,
    /// the first piece of a word written without spaces ("well-known": "well")
    is_head: bool,
    /// the currency sign before a number ("$5.50": the 5.50 carries '$')
    currency: Option<char>,
    /// whether its phonemes are set off by a space from the piece before ("2nd": "sˈɛkənd" needs none)
    prespace: bool,
    alias: Option<&'static str>,
}

/// A word of the text: one token, or the pieces of one written without spaces ("well-known", "startup,").
enum Word {
    One(Tok),
    Group(Vec<Tok>),
}

/// The phonemes of `text`, words separated by spaces, the punctuation that shapes a reading kept.
pub fn phonemize(text: &str) -> String {
    let text = text.replace(['‘', '’'], "'");
    let chunks: Vec<&str> = text.split_whitespace().collect();
    let mut words: Vec<Word> = vec![];
    for (index, chunk) in chunks.iter().enumerate() {
        let next_is_number = chunks.get(index + 1).is_some_and(|next| next.starts_with(|character: char| character.is_ascii_digit()));
        words.extend(retokenize(chunk, index + 1 < chunks.len(), next_is_number));
    }
    let mut ctx = Ctx::default();
    for word in words.iter_mut().rev() {
        match word {
            Word::One(tok) => {
                if tok.phonemes.is_none() {
                    tok.phonemes = word_phonemes(tok, &ctx).or_else(|| fallback(&tok.text));
                }
                ctx = token_context(ctx, tok.phonemes.as_deref(), tok);
            }
            Word::Group(toks) => ctx = resolve_group(toks, ctx),
        }
    }
    let mut out = String::new();
    for word in &words {
        let (phonemes, space) = match word {
            Word::One(tok) => (tok.phonemes.clone().unwrap_or_default(), tok.space),
            Word::Group(toks) => (merged_phonemes(toks), toks.last().is_some_and(|tok| tok.space)),
        };
        out.push_str(&phonemes);
        if space {
            out.push(' ');
        }
    }
    out.trim_end().to_string()
}

/// The pieces of a chunk of text written without spaces: letters, numbers and punctuation apart, as misaki cuts them.
fn subtokens(chunk: &str) -> Vec<String> {
    let mut out = pieces(chunk);
    // an abbreviation the lexicon lists with its full stop ("Dr.", "etc.") keeps it
    let mut at = 0;
    while at + 1 < out.len() {
        if out[at + 1] == "." && LEXICON.gold.contains_key(&format!("{}.", out[at])) {
            out[at].push('.');
            out.remove(at + 1);
        }
        at += 1;
    }
    out
}

fn pieces(chunk: &str) -> Vec<String> {
    let characters: Vec<char> = chunk.chars().collect();
    let count = characters.len();
    let mut out = vec![];
    let mut at = 0;
    let digit = |index: usize| characters.get(index).is_some_and(char::is_ascii_digit);
    while at < count {
        let character = characters[at];
        let start = at;
        if digit(at) || (character == '-' && at == 0 && digit(1)) || ((character == '.' || character == ',') && digit(at + 1)) {
            // a number: digits with a comma or point between them ("1,000.50", ".5", "-3" at the start)
            if !digit(at) {
                at += 1;
            }
            at += 1;
            loop {
                if digit(at) {
                    at += 1;
                } else if (characters[at.min(count - 1)] == ',' || characters[at.min(count - 1)] == '.') && at < count && digit(at + 1) {
                    at += 2;
                } else {
                    break;
                }
            }
        } else if character.is_alphabetic() {
            // letters with apostrophes inside ("don't"), cut where lowercase meets a capital ("iPhone", "McDonald")
            at += 1;
            if characters.get(1).is_some_and(|second| second.is_uppercase())
                && characters.get(2).is_some_and(|third| third.is_lowercase())
                && start == 0
                && character.is_uppercase()
            {
                // "ABc": the first capital alone
            } else {
                loop {
                    if at < count && characters[at].is_alphabetic() {
                        if characters[at].is_uppercase() && characters[at - 1].is_lowercase() {
                            break;
                        }
                        at += 1;
                    } else if at + 1 < count && characters[at] == '\'' && characters[at + 1].is_alphabetic() {
                        at += 2;
                    } else {
                        break;
                    }
                }
            }
        } else if character == '-' || character == '_' {
            while at < count && (characters[at] == '-' || characters[at] == '_') {
                at += 1;
            }
        } else if character == '\'' {
            while at < count && characters[at] == '\'' {
                at += 1;
            }
        } else {
            at += 1;
        }
        out.push(characters[start..at].iter().collect());
    }
    out
}

/// A chunk's tokens: punctuation said as itself, a currency sign handed to its number, and the rest grouped to be
/// looked up together or apart.
fn retokenize(chunk: &str, space_after: bool, next_is_number: bool) -> Vec<Word> {
    let subs = subtokens(chunk);
    let last = subs.len().saturating_sub(1);
    let mut words: Vec<Word> = vec![];
    let mut currency: Option<char> = None;
    for (index, text) in subs.iter().enumerate() {
        let mut tok = Tok {
            text: text.clone(),
            space: index == last && space_after,
            phonemes: None,
            is_head: true,
            currency: None,
            prespace: false,
            alias: None,
        };
        let mut characters = text.chars();
        let single = match (characters.next(), characters.next()) {
            (Some(character), None) => Some(character),
            _ => None,
        };
        match single {
            Some(sign @ ('$' | '£' | '€')) => {
                currency = Some(sign);
                tok.phonemes = Some(String::new());
            }
            Some('-' | '–') if last == 0 => tok.phonemes = Some("—".into()),
            Some('"') => tok.phonemes = Some(if index == 0 { "“" } else { "”" }.into()),
            Some(mark) if PUNCTS.contains(mark) || mark == '(' || mark == ')' => tok.phonemes = Some(mark.to_string()),
            _ => {}
        }
        if tok.phonemes.is_none() {
            if let Some(sign) = currency {
                // the sign goes to the last of the numbers after it
                let another = subs.get(index + 1).is_some_and(|next| is_number(next, true)) || (index == last && next_is_number);
                if !is_number(text, true) {
                    currency = None;
                } else if !another {
                    tok.currency = Some(sign);
                }
            } else if index > 0 && index < last && text == "2" {
                let before = subs[index - 1].chars().last().is_some_and(char::is_alphabetic);
                let after = subs[index + 1].chars().next().is_some_and(char::is_alphabetic);
                if before && after {
                    tok.alias = Some("to");
                }
            }
        }
        if tok.alias.is_some() || tok.phonemes.is_some() {
            words.push(Word::One(tok));
        } else if let Some(Word::Group(group)) = words.last_mut()
            && group.last().is_some_and(|previous| !previous.space)
        {
            tok.is_head = false;
            group.push(tok);
        } else {
            words.push(Word::Group(vec![tok]));
        }
    }
    words
        .into_iter()
        .map(|word| match word {
            Word::Group(mut group) if group.len() == 1 => Word::One(group.pop().unwrap()),
            word => word,
        })
        .collect()
}

/// The pieces of a word written without spaces, looked up as a whole first ("don't"), then in the longest runs the
/// lexicon knows, a piece at a time last; punctuation and hyphens among them are said as nothing.
fn resolve_group(toks: &mut [Tok], mut ctx: Ctx) -> Ctx {
    let (mut left, mut right) = (0, toks.len());
    while left < right {
        let merged =
            if toks[left..right].iter().any(|tok| tok.alias.is_some() || tok.phonemes.is_some()) { None } else { Some(merge(&toks[left..right])) };
        let phonemes = merged.as_ref().and_then(|tok| word_phonemes(tok, &ctx));
        if let (Some(phonemes), Some(merged)) = (phonemes, merged) {
            ctx = token_context(ctx, Some(&phonemes), &merged);
            toks[left].phonemes = Some(phonemes);
            for tok in &mut toks[left + 1..right] {
                tok.phonemes = Some(String::new());
            }
            right = left;
            left = 0;
        } else if left + 1 < right {
            left += 1;
        } else {
            right -= 1;
            let tok = &mut toks[right];
            if tok.phonemes.is_none() {
                tok.phonemes = if tok.text.chars().all(|character| JUNK.contains(character)) { Some(String::new()) } else { fallback(&tok.text) };
                ctx = token_context(ctx, tok.phonemes.as_deref(), tok);
            }
            left = 0;
        }
    }
    resolve_tokens(toks);
    ctx
}

fn merge(toks: &[Tok]) -> Tok {
    Tok {
        text: toks.iter().map(|tok| tok.text.as_str()).collect(),
        space: toks.last().is_some_and(|tok| tok.space),
        phonemes: None,
        is_head: toks[0].is_head,
        currency: toks.iter().filter_map(|tok| tok.currency).max(),
        prespace: toks[0].prespace,
        alias: None,
    }
}

fn merged_phonemes(toks: &[Tok]) -> String {
    let mut out = String::new();
    for tok in toks {
        let phonemes = tok.phonemes.as_deref().unwrap_or("");
        if tok.prespace && !out.is_empty() && !out.ends_with(' ') && !phonemes.is_empty() {
            out.push(' ');
        }
        out.push_str(phonemes);
    }
    out
}

/// A compound's pieces: whether they are said with spaces between ("2nd" isn't, "3.5kg" is), and which keep their
/// primary stress when more than half of them have one ("well-known": wˌɛlnˈOn).
fn resolve_tokens(toks: &mut [Tok]) {
    let text: String = toks.iter().map(|tok| if tok.space { format!("{} ", tok.text) } else { tok.text.clone() }).collect();
    let text = text.trim_end();
    let classes: std::collections::HashSet<u8> = text
        .chars()
        .filter(|character| !JUNK.contains(*character))
        .map(|character| {
            if character.is_alphabetic() {
                0
            } else if character.is_numeric() {
                1
            } else {
                2
            }
        })
        .collect();
    let prespace = text.contains(' ') || text.contains('/') || classes.len() > 1;
    let count = toks.len();
    for (index, tok) in toks.iter_mut().enumerate() {
        if tok.phonemes.is_none() {
            if index + 1 == count && text.chars().count() == 1 && text.chars().all(|character| NON_QUOTE_PUNCTS.contains(character)) {
                tok.phonemes = Some(text.to_string());
            } else if tok.text.chars().all(|character| JUNK.contains(character)) {
                tok.phonemes = Some(String::new());
            }
        } else if index > 0 {
            tok.prespace = prespace;
        }
    }
    if prespace {
        return;
    }
    let mut indices: Vec<(bool, usize, usize)> = toks
        .iter()
        .enumerate()
        .filter_map(|(index, tok)| {
            tok.phonemes
                .as_deref()
                .filter(|phonemes| !phonemes.is_empty())
                .map(|phonemes| (phonemes.contains(PRIMARY), stress_weight(phonemes), index))
        })
        .collect();
    if indices.len() == 2 && toks[indices[0].2].text.chars().count() == 1 {
        let index = indices[1].2;
        toks[index].phonemes = toks[index].phonemes.as_deref().map(|phonemes| apply_stress(phonemes, Some(-0.5)));
        return;
    }
    if indices.len() < 2 || indices.iter().filter(|(primary, _, _)| *primary).count() <= indices.len().div_ceil(2) {
        return;
    }
    indices.sort();
    for &(_, _, index) in &indices[..indices.len() / 2] {
        toks[index].phonemes = toks[index].phonemes.as_deref().map(|phonemes| apply_stress(phonemes, Some(-0.5)));
    }
}

fn stress_weight(phonemes: &str) -> usize {
    phonemes.chars().map(|character| if DIPHTHONGS.contains(character) { 2 } else { 1 }).sum()
}

fn token_context(ctx: Ctx, phonemes: Option<&str>, tok: &Tok) -> Ctx {
    let mut future_vowel = ctx.future_vowel;
    if let Some(phonemes) = phonemes.filter(|phonemes| !phonemes.is_empty())
        && let Some(first) =
            phonemes.chars().find(|character| is_vowel(*character) || CONSONANTS.contains(*character) || NON_QUOTE_PUNCTS.contains(*character))
    {
        future_vowel = if NON_QUOTE_PUNCTS.contains(first) { None } else { Some(is_vowel(first)) };
    }
    let mut characters = tok.text.chars();
    let future_letter = matches!((characters.next(), characters.next()), (Some(letter), None) if letter.is_ascii_uppercase());
    Ctx { future_vowel, future_to: matches!(tok.text.as_str(), "to" | "To" | "TO"), future_letter }
}

/// Stress as misaki applies it: None leaves the word; -2 strips it; -1, 0 and -0.5 demote a primary to secondary;
/// 0, 0.5 and 1 add a secondary to a word without any; 1 and 2 promote a lone secondary; 2 adds a primary.
fn apply_stress(phonemes: &str, stress: Option<f32>) -> String {
    let Some(stress) = stress else {
        return phonemes.to_string();
    };
    let has_primary = phonemes.contains(PRIMARY);
    let has_secondary = phonemes.contains(SECONDARY);
    let has_vowel = phonemes.chars().any(is_vowel);
    if stress < -1.0 {
        phonemes.replace([PRIMARY, SECONDARY], "")
    } else if stress == -1.0 || ((stress == 0.0 || stress == -0.5) && has_primary) {
        phonemes.replace(SECONDARY, "").replace(PRIMARY, &SECONDARY.to_string())
    } else if (stress == 0.0 || stress == 0.5 || stress == 1.0) && !has_primary && !has_secondary {
        if has_vowel { restress(&format!("{SECONDARY}{phonemes}")) } else { phonemes.to_string() }
    } else if stress >= 1.0 && !has_primary && has_secondary {
        phonemes.replace(SECONDARY, &PRIMARY.to_string())
    } else if stress > 1.0 && !has_primary && !has_secondary {
        if has_vowel { restress(&format!("{PRIMARY}{phonemes}")) } else { phonemes.to_string() }
    } else {
        phonemes.to_string()
    }
}

/// Each stress mark moved to just before the next vowel.
fn restress(phonemes: &str) -> String {
    let characters: Vec<char> = phonemes.chars().collect();
    let mut keyed: Vec<(f32, char)> = characters.iter().enumerate().map(|(index, character)| (index as f32, *character)).collect();
    for (index, character) in characters.iter().enumerate() {
        if (*character == PRIMARY || *character == SECONDARY)
            && let Some(vowel_at) = (index..characters.len()).find(|&candidate| is_vowel(characters[candidate]))
        {
            keyed[index].0 = vowel_at as f32 - 0.5;
        }
    }
    keyed.sort_by(|left, right| left.0.total_cmp(&right.0));
    keyed.into_iter().map(|(_, character)| character).collect()
}

fn lexicon_character(character: char) -> bool {
    character == '\'' || character == '-' || character.is_ascii_alphabetic()
}

/// A token's phonemes from the lexicon (misaki's Lexicon.__call__): the word as written, as a number, or lowercased.
fn word_phonemes(tok: &Tok, ctx: &Ctx) -> Option<String> {
    let word: String = tok.alias.map(String::from).unwrap_or_else(|| tok.text.nfkc().collect());
    let lower = word.to_lowercase();
    let upper = word.to_uppercase();
    let stress = if word == lower {
        None
    } else if word == upper {
        Some(2.0)
    } else {
        Some(0.5)
    };
    if let Some(phonemes) = get_word(&word, stress, ctx) {
        return Some(phonemes);
    }
    if is_number(&word, tok.is_head) {
        return get_number(&word, tok.currency, tok.is_head);
    }
    if !word.chars().all(lexicon_character) {
        return None;
    }
    let tail_lower = word.chars().skip(1).all(|character| !character.is_uppercase());
    if word != lower && (word == upper || tail_lower) {
        return get_word(&lower, stress, ctx);
    }
    None
}

fn get_word(word: &str, stress: Option<f32>, ctx: &Ctx) -> Option<String> {
    if let Some(phonemes) = special_case(word, stress, ctx) {
        return Some(phonemes);
    }
    if is_known(word) {
        return lookup(word, stress, ctx);
    }
    if let Some(stem) = word.strip_suffix("s'")
        && is_known(&format!("{stem}'s"))
    {
        return lookup(&format!("{stem}'s"), stress, ctx);
    }
    if let Some(stem) = word.strip_suffix('\'')
        && is_known(stem)
    {
        return lookup(stem, stress, ctx);
    }
    stem_s(word, stress, ctx).or_else(|| stem_ed(word, stress, ctx)).or_else(|| stem_ing(word, stress.or(Some(0.5)), ctx))
}

/// Function words said by what follows them, symbols said as words, and initialisms said letter by letter.
fn special_case(word: &str, stress: Option<f32>, ctx: &Ctx) -> Option<String> {
    let symbol = match word {
        "%" => Some("percent"),
        "&" => Some("and"),
        "+" => Some("plus"),
        "@" => Some("at"),
        _ => None,
    };
    if let Some(symbol) = symbol {
        return lookup(symbol, None, ctx);
    }
    let dotted = word.trim_matches('.').contains('.') && word.chars().all(|character| character == '.' || character.is_alphabetic());
    if dotted && word.split('.').map(|piece| piece.chars().count()).max().unwrap_or(0) < 3 {
        return get_nnp(word);
    }
    match word {
        "a" => return Some("ɐ".into()),
        // the article, unless a letter is being named ("plan A", "A B C")
        "A" if ctx.future_vowel.is_some() && !ctx.future_letter => return Some("ɐ".into()),
        "am" | "Am" | "AM" => {
            return if ctx.future_vowel.is_none() || word != "am" || stress.is_some_and(|stress| stress > 0.0) {
                Some(LEXICON.gold("am")?.default.clone())
            } else {
                Some("ɐm".into())
            };
        }
        "an" | "An" | "AN" => return Some("ɐn".into()),
        "I" => return Some(format!("{SECONDARY}I")),
        "to" | "To" | "TO" => {
            return Some(match ctx.future_vowel {
                None => LEXICON.gold("to")?.default.clone(),
                Some(false) => "tə".into(),
                Some(true) => "tʊ".into(),
            });
        }
        "the" | "The" | "THE" => return Some(if ctx.future_vowel == Some(true) { "ði" } else { "ðə" }.into()),
        "used" | "Used" | "USED" => return Some(if ctx.future_to { "jˈust" } else { "jˈuzd" }.into()),
        _ => {}
    }
    if word.eq_ignore_ascii_case("vs") || word.eq_ignore_ascii_case("vs.") {
        return lookup("versus", None, ctx);
    }
    None
}

fn is_known(word: &str) -> bool {
    let lexicon = &*LEXICON;
    if lexicon.gold(word).is_some() || matches!(word, "%" | "&" | "+" | "@") || lexicon.silver(word).is_some() {
        return true;
    }
    if !word.chars().all(char::is_alphabetic) || !word.chars().all(lexicon_character) {
        return false;
    }
    if word.chars().count() == 1 {
        return true;
    }
    if word == word.to_uppercase() && lexicon.gold(&word.to_lowercase()).is_some() {
        return true;
    }
    // an initialism with a capital tail, said letter by letter
    word.chars().skip(1).all(|character| !character.is_lowercase())
}

fn lookup(word: &str, stress: Option<f32>, ctx: &Ctx) -> Option<String> {
    let lexicon = &*LEXICON;
    let mut word = word.to_string();
    if word == word.to_uppercase() && lexicon.gold(&word).is_none() {
        word = word.to_lowercase();
    }
    let phonemes = match lexicon.gold(&word) {
        Some(entry) => {
            Some(if ctx.future_vowel.is_none() { entry.alone.clone().unwrap_or_else(|| entry.default.clone()) } else { entry.default.clone() })
        }
        None => lexicon.silver(&word).map(String::from),
    };
    match phonemes {
        Some(phonemes) => Some(apply_stress(&phonemes, stress)),
        None => get_nnp(&word),
    }
}

/// A word said letter by letter ("USA": jˌuˌɛsˈA), the last letter stressed.
fn get_nnp(word: &str) -> Option<String> {
    let mut joined = String::new();
    for letter in word.chars().filter(|character| character.is_alphabetic()) {
        joined.push_str(&LEXICON.gold(&letter.to_uppercase().to_string())?.default);
    }
    let demoted = apply_stress(&joined, Some(0.0));
    Some(match demoted.rfind(SECONDARY) {
        Some(at) => format!("{}{PRIMARY}{}", &demoted[..at], &demoted[at + SECONDARY.len_utf8()..]),
        None => demoted,
    })
}

fn last_char(phonemes: &str) -> Option<char> {
    phonemes.chars().last()
}

/// The plural or third person of a stem's phonemes.
fn s_form(stem: &str) -> String {
    match last_char(stem) {
        Some(last) if "ptkfθ".contains(last) => format!("{stem}s"),
        Some(last) if "szʃʒʧʤ".contains(last) => format!("{stem}ᵻz"),
        _ => format!("{stem}z"),
    }
}

fn stem_s(word: &str, stress: Option<f32>, ctx: &Ctx) -> Option<String> {
    let count = word.chars().count();
    let stem = if count > 2 && word.ends_with('s') && !word.ends_with("ss") && is_known(&word[..word.len() - 1]) {
        word[..word.len() - 1].to_string()
    } else if (word.ends_with("'s") || (count > 4 && word.ends_with("es"))) && is_known(&word[..word.len() - 2]) {
        word[..word.len() - 2].to_string()
    } else if count > 4 && word.ends_with("ies") && is_known(&format!("{}y", &word[..word.len() - 3])) {
        format!("{}y", &word[..word.len() - 3])
    } else {
        return None;
    };
    lookup(&stem, stress, ctx).map(|phonemes| s_form(&phonemes))
}

/// The past of a stem's phonemes: "t" after a voiceless sound, "ᵻd" after d or t (a flapped "ɾᵻd" after a vowel).
fn ed_form(stem: &str) -> String {
    let characters: Vec<char> = stem.chars().collect();
    match characters.last() {
        Some(last) if "pkfθʃsʧ".contains(*last) => format!("{stem}t"),
        Some('d') => format!("{stem}ᵻd"),
        Some(last) if *last != 't' => format!("{stem}d"),
        _ if characters.len() < 2 => format!("{stem}ɪd"),
        _ if TAUS.contains(characters[characters.len() - 2]) => format!("{}ɾᵻd", &stem[..stem.len() - 1]),
        _ => format!("{stem}ᵻd"),
    }
}

fn stem_ed(word: &str, stress: Option<f32>, ctx: &Ctx) -> Option<String> {
    let stem = if word.ends_with('d') && !word.ends_with("dd") && is_known(&word[..word.len() - 1]) {
        &word[..word.len() - 1]
    } else if word.ends_with("ed") && !word.ends_with("eed") && is_known(&word[..word.len() - 2]) {
        &word[..word.len() - 2]
    } else {
        return None;
    };
    lookup(stem, stress, ctx).map(|phonemes| ed_form(&phonemes))
}

fn ing_form(stem: &str) -> String {
    let characters: Vec<char> = stem.chars().collect();
    if characters.len() > 1 && characters[characters.len() - 1] == 't' && TAUS.contains(characters[characters.len() - 2]) {
        format!("{}ɾɪŋ", &stem[..stem.len() - 1])
    } else {
        format!("{stem}ɪŋ")
    }
}

fn stem_ing(word: &str, stress: Option<f32>, ctx: &Ctx) -> Option<String> {
    let base = word.strip_suffix("ing")?;
    let characters: Vec<char> = base.chars().collect();
    let doubled = characters.len() >= 2
        && characters[characters.len() - 1] == characters[characters.len() - 2]
        && "bcdgklmnprstvxz".contains(characters[characters.len() - 1]);
    let stem = if is_known(base) {
        base.to_string()
    } else if is_known(&format!("{base}e")) {
        format!("{base}e")
    } else if (doubled || base.ends_with("ck")) && is_known(&base[..base.len() - 1]) {
        base[..base.len() - 1].to_string()
    } else {
        return None;
    };
    lookup(&stem, stress, ctx).map(|phonemes| ing_form(&phonemes))
}

fn is_number(word: &str, is_head: bool) -> bool {
    if !word.chars().any(|character| character.is_ascii_digit()) {
        return false;
    }
    let mut rest = word;
    for suffix in ["ing", "'d", "ed", "'s", "st", "nd", "rd", "th", "s"] {
        if let Some(stripped) = rest.strip_suffix(suffix) {
            rest = stripped;
            break;
        }
    }
    rest.chars()
        .enumerate()
        .all(|(index, character)| character.is_ascii_digit() || character == ',' || character == '.' || (is_head && index == 0 && character == '-'))
}

fn is_currency(word: &str) -> bool {
    match word.split_once('.') {
        None => true,
        Some((_, cents)) => !cents.contains('.') && (cents.chars().count() < 3 || cents.chars().all(|character| character == '0')),
    }
}

/// A number as misaki reads it: a plain one, an ordinal by its suffix, a four-digit year, a decimal, a sum of money,
/// and digits one by one where it isn't the head of its word.
fn get_number(word: &str, currency: Option<char>, is_head: bool) -> Option<String> {
    let suffix_at =
        word.char_indices().rev().take_while(|(_, character)| character.is_ascii_lowercase() || *character == '\'').last().map(|(at, _)| at);
    let (mut number, suffix) = match suffix_at {
        Some(at) if at > 0 => (&word[..at], &word[at..]),
        _ => (word, ""),
    };
    let ctx = Ctx::default();
    let mut result: Vec<String> = vec![];
    let push_words = |said: &str, result: &mut Vec<String>| {
        for piece in said.split(|character: char| !character.is_ascii_alphabetic()).filter(|piece| !piece.is_empty()) {
            if piece != "and"
                && let Some(phonemes) = lookup(piece, if piece == "point" { Some(-2.0) } else { None }, &ctx)
            {
                result.push(phonemes);
            }
        }
    };
    if let Some(rest) = number.strip_prefix('-') {
        result.push(lookup("minus", None, &ctx)?);
        number = rest;
    }
    let digits_one_by_one = |digits: &str, result: &mut Vec<String>| {
        for digit in digits.chars().filter_map(|character| character.to_digit(10)) {
            push_words(&numbers::cardinal(digit as u64), result);
        }
    };
    let plain = number.replace(',', "");
    if !is_head && !number.contains('.') {
        if plain.starts_with('0') || plain.len() > 3 || plain.parse::<u64>().is_err() {
            digits_one_by_one(&plain, &mut result);
        } else if plain.len() == 3 && !plain.ends_with("00") {
            let digits: Vec<char> = plain.chars().collect();
            push_words(&numbers::cardinal(digits[0].to_digit(10)? as u64), &mut result);
            if digits[1] == '0' {
                result.push(lookup("O", Some(-2.0), &ctx)?);
                push_words(&numbers::cardinal(digits[2].to_digit(10)? as u64), &mut result);
            } else {
                push_words(&numbers::cardinal(plain[1..].parse().ok()?), &mut result);
            }
        } else {
            push_words(&numbers::cardinal(plain.parse().ok()?), &mut result);
        }
    } else if number.matches('.').count() > 1 || !is_head {
        for piece in plain.split('.') {
            if piece.is_empty() {
                continue;
            }
            let odd = piece.starts_with('0') || (piece.len() != 2 && piece[1..].chars().any(|character| character != '0'));
            match piece.parse::<u64>() {
                Ok(value) if !odd => push_words(&numbers::cardinal(value), &mut result),
                _ => digits_one_by_one(piece, &mut result),
            }
        }
    } else if let Some((unit, cents)) = currency.and_then(money_units).filter(|_| is_currency(number)) {
        let mut pairs: Vec<(u64, &str)> = plain.split('.').zip([unit, cents]).map(|(amount, unit)| (amount.parse().unwrap_or(0), unit)).collect();
        if pairs.len() > 1 {
            if pairs[1].0 == 0 {
                pairs.truncate(1);
            } else if pairs[0].0 == 0 {
                pairs.remove(0);
            }
        }
        for (index, (amount, unit)) in pairs.into_iter().enumerate() {
            if index > 0 {
                result.push(lookup("and", None, &ctx)?);
            }
            push_words(&numbers::cardinal(amount), &mut result);
            let said = if amount != 1 && unit != "pence" { stem_s(&format!("{unit}s"), None, &ctx) } else { lookup(unit, None, &ctx) };
            result.push(said?);
        }
    } else {
        let ordinal = matches!(suffix, "st" | "nd" | "rd" | "th");
        let said = if let Ok(value) = plain.parse::<u64>() {
            if ordinal {
                numbers::ordinal(value)
            } else if result.is_empty() && number.len() == 4 && !number.contains('.') {
                numbers::year(value)
            } else {
                numbers::cardinal(value)
            }
        } else if let Some((whole, fraction)) = plain.split_once('.') {
            if whole.is_empty() {
                format!(
                    "point {}",
                    fraction
                        .chars()
                        .filter_map(|character| character.to_digit(10))
                        .map(|digit| numbers::cardinal(digit as u64))
                        .collect::<Vec<_>>()
                        .join(" ")
                )
            } else {
                numbers::decimal(whole, fraction)
            }
        } else {
            return None;
        };
        push_words(&said, &mut result);
    }
    if result.is_empty() {
        return None;
    }
    let phonemes = result.join(" ");
    Some(match suffix {
        "s" | "'s" => s_form(&phonemes),
        "ed" | "'d" => ed_form(&phonemes),
        "ing" => ing_form(&phonemes),
        _ => phonemes,
    })
}

fn money_units(sign: char) -> Option<(&'static str, &'static str)> {
    match sign {
        '$' => Some(("dollar", "cent")),
        '£' => Some(("pound", "pence")),
        '€' => Some(("euro", "cent")),
        _ => None,
    }
}

/// A word the lexicons don't have: by the CMU dictionary's sounds, else by the letter-to-sound rules.
fn fallback(text: &str) -> Option<String> {
    let letters: String = crate::text::fold(text).chars().filter(|character| character.is_ascii_alphabetic() || *character == '\'').collect();
    if letters.is_empty() {
        return None;
    }
    if let Some(phones) = crate::sounds::phones(&letters.to_lowercase()) {
        return Some(from_arpabet(phones));
    }
    let mut sounds = nrl::sounds(&letters);
    // the rules give no stress: the first full vowel takes it
    let stressed = sounds.iter().position(|sound| sound != "AX" && vowel_sound(sound)).or_else(|| sounds.iter().position(|sound| vowel_sound(sound)));
    if let Some(at) = stressed {
        sounds[at] = format!("{}1", sounds[at]);
    }
    Some(from_arpabet(&sounds))
}

fn vowel_sound(sound: &str) -> bool {
    matches!(
        sound.trim_end_matches(|character: char| character.is_ascii_digit()),
        "AA" | "AE" | "AH" | "AO" | "AW" | "AX" | "AY" | "EH" | "ER" | "EY" | "IH" | "IY" | "OW" | "OY" | "UH" | "UW"
    )
}

/// ARPAbet sounds (with the CMU dictionary's stress digits, or none) in Kokoro's symbols: the stress mark before the
/// vowel, a t flapped before an unstressed vowel, a weak "uh" before a final n said as the syllabic n ("button").
fn from_arpabet(phones: &[String]) -> String {
    let split = |phone: &str| -> (String, Option<u32>) {
        match phone.chars().last().and_then(|character| character.to_digit(10)) {
            Some(digit) => (phone[..phone.len() - 1].to_string(), Some(digit)),
            None => (phone.to_string(), None),
        }
    };
    let parts: Vec<(String, Option<u32>)> = phones.iter().map(|phone| split(phone)).collect();
    // "button": the weak vowel between a t or d and a final n is the n itself
    let syllabic_n = |index: usize| {
        let (base, stress) = &parts[index];
        base == "AH"
            && *stress == Some(0)
            && index > 0
            && matches!(parts[index - 1].0.as_str(), "T" | "D")
            && parts.get(index + 1).is_some_and(|(sound, _)| sound == "N")
            && index + 2 >= parts.len()
    };
    let mut out = String::new();
    for (index, (base, stress)) in parts.iter().enumerate() {
        let next = parts.get(index + 1);
        let unstressed_next = next.is_some_and(|(_, stress)| *stress == Some(0)) && !syllabic_n(index + 1);
        let symbol: String = match base.as_str() {
            "AA" => "ɑ".into(),
            "AE" => "æ".into(),
            "AH" => if *stress == Some(0) { "ə" } else { "ʌ" }.into(),
            "AX" => "ə".into(),
            "AO" => "ɔ".into(),
            "AW" => "W".into(),
            "AY" => "I".into(),
            "EH" => "ɛ".into(),
            "ER" => if *stress == Some(0) { "əɹ" } else { "ɜɹ" }.into(),
            "EY" => "A".into(),
            "IH" => "ɪ".into(),
            "IY" => "i".into(),
            "OW" => "O".into(),
            "OY" => "Y".into(),
            "UH" => "ʊ".into(),
            "UW" => "u".into(),
            "CH" => "ʧ".into(),
            "DH" => "ð".into(),
            "G" => "ɡ".into(),
            "HH" => "h".into(),
            "JH" => "ʤ".into(),
            "NG" | "NX" => "ŋ".into(),
            "R" => "ɹ".into(),
            "SH" => "ʃ".into(),
            "TH" => "θ".into(),
            "WH" => "w".into(),
            "Y" => "j".into(),
            "ZH" => "ʒ".into(),
            "T" if unstressed_next && out.chars().last().is_some_and(|previous| is_vowel(previous) || previous == 'ɹ') => "ɾ".into(),
            other => other.to_lowercase(),
        };
        if syllabic_n(index) {
            continue;
        }
        match stress {
            Some(1) => out.push(PRIMARY),
            Some(2) => out.push(SECONDARY),
            _ => {}
        }
        out.push_str(&symbol);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What misaki itself gives for these (its lexicon, spaCy's tags): the port must say the same.
    #[test]
    fn says_the_demo_texts_as_misaki_does() {
        assert_eq!(
            phonemize("The northern lights are one of the most beautiful things you can see in the night sky."),
            "ðə nˈɔɹðəɹn lˈIts ɑɹ wˈʌn ʌv ðə mˈOst bjˈuɾəfəl θˈɪŋz ju kæn sˈi ɪn ðə nˈIt skˈI."
        );
        assert_eq!(
            phonemize("Good evening, everybody. For those who don't know me, I'm Tom, the best man."),
            "ɡˈʊd ˈivnɪŋ, ˈɛvɹibədi. fˌɔɹ ðOz hˌu dˈOnt nˈO mˌi, ˌIm tˈɑm, ðə bˈɛst mˈæn."
        );
        assert_eq!(
            phonemize("Hi, I'm Alex. I moved to Berlin three years ago for a job at a small startup, and I really like it here."),
            "hˈI, ˌIm ˈælɪks. ˌI mˈuvd tə bəɹlˈɪn θɹˈi jˈɪɹz əɡˈO fɔɹ ɐ ʤˈɑb æt ɐ smˈɔl stˈɑɹɾʌp, ænd ˌI ɹˈiᵊli lˈIk ɪt hˈɪɹ."
        );
        assert_eq!(
            phonemize("They happen when particles from the Sun hit the air high above the Earth."),
            "ðˌA hˈæpən wˌɛn pˈɑɹɾəkᵊlz fɹʌm ðə sˈʌn hˈɪt ði ˈɛɹ hˈI əbˈʌv ði ˈɜɹθ."
        );
        assert_eq!(phonemize("Parrot reads it, you repeat it."), "pˈɛɹət ɹˈidz ɪt, ju ɹəpˈit ɪt.");
        assert_eq!(phonemize("Buttons, kittens, water, better, little, bottle."), "bˈʌtnz, kˈɪtnz, wˈɔɾəɹ, bˈɛɾəɹ, lˈɪɾᵊl, bˈɑɾəl.");
    }

    #[test]
    fn function_words_follow_what_comes_next() {
        assert_eq!(
            phonemize("A man, an apple, the end, the apple, to go, to eat, I am, I'm here."),
            "ɐ mˈæn, ɐn ˈæpᵊl, ði ˈɛnd, ði ˈæpᵊl, tə ɡˌO, tʊ ˈit, ˌI æm, ˌIm hˈɪɹ."
        );
        assert_eq!(
            phonemize("She walked, he jumped, they're waiting; it's a well-known fact."),
            "ʃˌi wˈɔkt, hi ʤˈʌmpt, ðɛɹ wˈAɾɪŋ; ɪts ɐ wˌɛlnˈOn fˈækt."
        );
    }

    #[test]
    fn capitals_are_said_as_words_or_spelled_as_misaki_does() {
        assert_eq!(
            phonemize("ARIA, NASA and IKEA are said as words; the USA is spelled."),
            "ˈɑɹiə, nˈæsə ænd ˌIkˌAˌiˈA ɑɹ sˈɛd æz wˈɜɹdz; ðə jˌuˌɛsˈA ɪz spˈɛld."
        );
        assert_eq!(
            phonemize("The GPS-guided rocket launched on March 1st, 1999."),
            "ðə ʤˌipˌiˈɛsɡˌIdᵻd ɹˈɑkət lˈɔnʧt ˌɔn mˈɑɹʧ fˈɜɹst, nˌIntˈin nˈIndi nˈIn."
        );
        // the letters the interface spells an abbreviation with: "A" is the letter there, not the article
        assert_eq!(phonemize("G S A"), "ʤˈi ˈɛs ˈA");
        assert_eq!(phonemize("A B C."), "ˈA bˈi sˈi.");
        assert_eq!(phonemize("A cat."), "ɐ kˈæt.");
    }

    #[test]
    fn numbers_are_read_as_misaki_reads_them() {
        assert_eq!(
            phonemize("I heard the record in 2023; the 3rd one cost $5.50, not 12 dollars."),
            "ˌI hˈɜɹd ðə ɹˈɛkəɹd ɪn twˈɛnti twˈɛnti θɹˈi; ðə θˈɜɹd wˈʌn kˈɔst fˈIv dˈɑləɹz ænd fˈɪfti sˈɛnts, nˌɑt twˈɛlv dˈɑləɹz."
        );
        assert_eq!(
            phonemize("£3 and €2.50; in 2005 and 2000."),
            "θɹˈi pˈWndz ænd tˈu jˈʊɹOz ænd fˈɪfti sˈɛnts; ɪn tˈu θˈWzᵊnd fˈIv ænd tˈu θˈWzᵊnd."
        );
        assert_eq!(
            phonemize("Dr. Smith paid 100 dollars for 2 tickets to Mr. Jones' show at 6 pm."),
            "dˈɑktəɹ smˈɪθ pˈAd wˈʌn hˈʌndɹəd dˈɑləɹz fɔɹ tˈu tˈɪkəts tə mˈɪstəɹ ʤˈOnz ʃˈO æt sˈɪks pˌiˈɛm."
        );
        // a time, which misaki leaves unread
        assert_eq!(phonemize("at 9:30"), "æt nˈIn:θˈɜɹɾi");
        assert_eq!(phonemize("the 1990s"), "ðə nˌIntˈin nˈIndiz");
    }

    #[test]
    fn punctuation_that_shapes_a_reading_goes_through() {
        assert_eq!(phonemize("“Quoted,” she said — and left… (quietly)."), "“kwˈOɾᵻd,” ʃi sˈɛd — ænd lˈɛft… (kwˈIətli).");
        assert_eq!(phonemize("\"Yes\" - no"), "“jˈɛs” — nˈO");
    }

    #[test]
    fn a_name_the_lexicons_lack_is_read_from_the_dictionary_or_by_rule() {
        // "Priya" is in no lexicon and not in the CMU dictionary: the rules say it, stressing its first vowel
        assert_eq!(phonemize("To Sam and Priya!"), "tə sˈæm ænd pɹˈɪɪə!");
        // in the CMU dictionary (its stress kept), with the t flapped and the schwa before the n dropped
        assert_eq!(from_arpabet(&["K".into(), "AH1".into(), "T".into(), "AH0".into(), "N".into()]), "kˈʌtn");
        assert_eq!(from_arpabet(&["W".into(), "AO1".into(), "T".into(), "ER0".into()]), "wˈɔɾəɹ");
        assert_eq!(fallback("Cougaar").unwrap(), "kˈWɡæɜɹ");
    }

    #[test]
    fn stress_moves_to_the_vowel_and_compounds_share_it() {
        assert_eq!(apply_stress("ʃi", Some(0.5)), "ʃˌi");
        assert_eq!(apply_stress("nˈO", Some(-0.5)), "nˌO");
        assert_eq!(apply_stress("nˈO", Some(-2.0)), "nO");
        assert_eq!(apply_stress("hmm", Some(2.0)), "hmm");
        assert_eq!(restress("ˈstɹIk"), "stɹˈIk");
    }

    #[test]
    fn subtokens_cut_where_misaki_cuts() {
        let cut = |chunk: &str| subtokens(chunk);
        assert_eq!(cut("don't"), vec!["don't"]);
        assert_eq!(cut("startup,"), vec!["startup", ","]);
        assert_eq!(cut("well-known"), vec!["well", "-", "known"]);
        assert_eq!(cut("$5.50"), vec!["$", "5.50"]);
        assert_eq!(cut("1,000.50kg"), vec!["1,000.50", "kg"]);
        assert_eq!(cut("iPhone"), vec!["i", "Phone"]);
        assert_eq!(cut("(quietly)."), vec!["(", "quietly", ")", "."]);
        assert_eq!(cut("Jones'"), vec!["Jones", "'"]);
        assert_eq!(cut("9:30"), vec!["9", ":", "30"]);
    }
}
