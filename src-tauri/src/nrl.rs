//! Letter-to-sound rules for a word no dictionary knows (a name, a brand): the Naval Research Laboratory's 329 rules
//! (Elovitz, Johnson, McHugh and Shore, NRL Report 7948, 1976; a work of the US government, public domain), as
//! transcribed in greg-kennedy/p5-NRL-TextToPhoneme (Unlicense). Each rule is `left[letters]right=/sounds/`: the
//! letters are read as the sounds when what is before and after them matches, and the first rule that fits wins.
//! The sounds are ARPAbet, as the CMU dictionary's, plus AX (the schwa), NX (ng) and WH.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::LazyLock;

struct Rule {
    left: Vec<char>,
    letters: Vec<char>,
    right: Vec<char>,
    sounds: Vec<String>,
}

/// the rules by the letter they start with, in the order they are tried
static RULES: LazyLock<HashMap<char, Vec<Rule>>> = LazyLock::new(|| {
    let groups: HashMap<String, Value> = serde_json::from_str(include_str!("../assets/nrl-rules.json")).expect("the NRL rules");
    let mut out = HashMap::new();
    for (group, rules) in groups {
        let Some(letter) = group.chars().next().filter(|_| group.len() == 1) else {
            continue; // the punctuation and digit groups: words come here as letters only
        };
        let parsed = rules.as_array().into_iter().flatten().filter_map(Value::as_str).filter_map(parse).collect();
        out.insert(letter, parsed);
    }
    out
});

fn parse(rule: &str) -> Option<Rule> {
    let (context, sounds) = rule.rsplit_once("=/")?;
    let sounds = sounds.strip_suffix('/')?;
    let (left, rest) = context.split_once('[')?;
    let (letters, right) = rest.split_once(']')?;
    Some(Rule {
        left: left.chars().collect(),
        letters: letters.chars().collect(),
        right: right.chars().collect(),
        sounds: sounds.split_whitespace().filter(|sound| !sound.starts_with('<')).map(String::from).collect(),
    })
}

fn vowel(character: char) -> bool {
    "AEIOUY".contains(character)
}

fn consonant(character: char) -> bool {
    character.is_ascii_uppercase() && !vowel(character)
}

/// The sounds of `word`, in reading order. Letters outside A to Z are skipped.
pub fn sounds(word: &str) -> Vec<String> {
    let text: Vec<char> = std::iter::once(' ')
        .chain(word.to_uppercase().chars().filter(|character| character.is_ascii_uppercase() || *character == '\''))
        .chain(std::iter::once(' '))
        .collect();
    let mut out = vec![];
    let mut at = 1;
    while at + 1 < text.len() {
        let Some(rules) = RULES.get(&text[at]) else {
            at += 1;
            continue;
        };
        let fitting = rules.iter().find(|rule| {
            text[at..].starts_with(&rule.letters) && right_fits(&text, at + rule.letters.len(), &rule.right) && left_fits(&text, at, &rule.left)
        });
        match fitting {
            Some(rule) => {
                out.extend(rule.sounds.iter().cloned());
                at += rule.letters.len();
            }
            None => at += 1,
        }
    }
    out
}

/// Whether the context before `at` is `left`, matched from its end backwards.
fn left_fits(text: &[char], at: usize, left: &[char]) -> bool {
    let mut cursor = at as isize - 1;
    let look = |cursor: isize| -> Option<char> { usize::try_from(cursor).ok().and_then(|index| text.get(index)).copied() };
    for symbol in left.iter().rev() {
        match symbol {
            '#' => {
                let mut count = 0;
                while look(cursor).is_some_and(vowel) {
                    cursor -= 1;
                    count += 1;
                }
                if count == 0 {
                    return false;
                }
            }
            ':' => {
                while look(cursor).is_some_and(consonant) {
                    cursor -= 1;
                }
            }
            '^' | '.' | '+' => {
                let fits = look(cursor).is_some_and(|character| match symbol {
                    '^' => consonant(character),
                    '.' => "BDVGJLMNRWZ".contains(character),
                    _ => "EIY".contains(character),
                });
                if !fits {
                    return false;
                }
                cursor -= 1;
            }
            '&' | '@' => {
                let (singles, before_h) = if *symbol == '&' { ("SCGZXJ", "CS") } else { ("TSRDLZNJ", "TCS") };
                match look(cursor) {
                    Some(character) if singles.contains(character) => cursor -= 1,
                    Some('H') if look(cursor - 1).is_some_and(|character| before_h.contains(character)) => cursor -= 2,
                    _ => return false,
                }
            }
            symbol => {
                if look(cursor) != Some(*symbol) {
                    return false;
                }
                cursor -= 1;
            }
        }
    }
    true
}

/// Whether the context from `at` on is `right`.
fn right_fits(text: &[char], at: usize, right: &[char]) -> bool {
    let mut cursor = at;
    let look = |cursor: usize| -> Option<char> { text.get(cursor).copied() };
    for symbol in right {
        match symbol {
            '#' => {
                let mut count = 0;
                while look(cursor).is_some_and(vowel) {
                    cursor += 1;
                    count += 1;
                }
                if count == 0 {
                    return false;
                }
            }
            ':' => {
                while look(cursor).is_some_and(consonant) {
                    cursor += 1;
                }
            }
            '^' | '.' | '+' => {
                let fits = look(cursor).is_some_and(|character| match symbol {
                    '^' => consonant(character),
                    '.' => "BDVGJLMNRWZ".contains(character),
                    _ => "EIY".contains(character),
                });
                if !fits {
                    return false;
                }
                cursor += 1;
            }
            '&' | '@' => {
                let (singles, before_h) = if *symbol == '&' { ("SCGZXJ", "CS") } else { ("TSRDLZNJ", "TCS") };
                match look(cursor) {
                    Some(character) if singles.contains(character) => cursor += 1,
                    Some(character) if before_h.contains(character) && look(cursor + 1) == Some('H') => cursor += 2,
                    _ => return false,
                }
            }
            // a suffix: ER, E, ES, ED, ING or ELY
            '%' => {
                let rest: String = text[cursor..].iter().take(3).collect();
                let length = if rest.starts_with("ING") || rest.starts_with("ELY") {
                    3
                } else if rest.starts_with("ER") || rest.starts_with("ES") || rest.starts_with("ED") {
                    2
                } else if rest.starts_with('E') {
                    1
                } else {
                    return false;
                };
                cursor += length;
            }
            symbol => {
                if look(cursor) != Some(*symbol) {
                    return false;
                }
                cursor += 1;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn said(word: &str) -> String {
        sounds(word).join(" ")
    }

    #[test]
    fn every_letter_has_rules_ending_in_a_default() {
        for letter in 'A'..='Z' {
            let rules = &RULES[&letter];
            let last = rules.last().unwrap();
            assert!(last.left.is_empty() && last.right.is_empty() && last.letters == vec![letter], "{letter}");
        }
        assert_eq!(RULES.values().map(Vec::len).sum::<usize>(), 308, "the letter rules; the other 21 are punctuation and digits");
    }

    #[test]
    fn common_words_come_out_as_the_report_says() {
        assert_eq!(said("the"), "DH AX");
        assert_eq!(said("night"), "N AY T");
        assert_eq!(said("station"), "S T EY SH AX N");
        assert_eq!(said("thing"), "TH IH NX");
        assert_eq!(said("quick"), "K W IH K");
        assert_eq!(said("phone"), "F OW N");
        // y between vowels is a vowel to the rules
        assert_eq!(said("priya"), "P R IH IH AX");
        assert_eq!(said("Kosimov"), "K AA Z IH M UW V");
    }

    #[test]
    fn letters_that_are_not_a_to_z_are_skipped() {
        assert_eq!(said("na-ïve"), said("nave"));
        assert_eq!(said(""), "");
    }
}
