//! How a word sounds, from the CMU Pronouncing Dictionary (built into the app, BSD-style licence, about 135,000
//! words of American English): a respelling with the stressed syllable marked ("an·SR" for answer, the way Google
//! shows it) and its IPA.

use flate2::read::GzDecoder;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::LazyLock;

static DICT: LazyLock<HashMap<String, Vec<String>>> = LazyLock::new(|| {
    let mut raw = String::new();
    GzDecoder::new(&include_bytes!("../assets/cmudict.dict.gz")[..]).read_to_string(&mut raw).expect("cmudict");
    let mut out = HashMap::new();
    for line in raw.lines() {
        let line = line.split('#').next().unwrap_or("");
        let mut parts = line.split_whitespace();
        if let Some(word) = parts.next()
            && !word.contains('(')
        {
            out.insert(word.to_string(), parts.map(String::from).collect());
        }
    }
    out
});

/// respelling and IPA of each vowel
fn vowel(phone: &str) -> Option<(&'static str, &'static str)> {
    Some(match phone {
        "AA" => ("aa", "ɑ"),
        "AE" => ("a", "æ"),
        "AH" => ("uh", "ʌ"),
        "AO" => ("aw", "ɔ"),
        "AW" => ("ow", "aʊ"),
        "AY" => ("ai", "aɪ"),
        "EH" => ("eh", "ɛ"),
        "ER" => ("ur", "ɝ"),
        "EY" => ("ay", "eɪ"),
        "IH" => ("i", "ɪ"),
        "IY" => ("ee", "i"),
        "OW" => ("oh", "oʊ"),
        "OY" => ("oy", "ɔɪ"),
        "UH" => ("u", "ʊ"),
        "UW" => ("oo", "u"),
        _ => return None,
    })
}

/// respelling and IPA of each consonant
fn consonant(phone: &str) -> (&'static str, &'static str) {
    match phone {
        "B" => ("b", "b"),
        "CH" => ("ch", "tʃ"),
        "D" => ("d", "d"),
        "DH" => ("dh", "ð"),
        "F" => ("f", "f"),
        "G" => ("g", "ɡ"),
        "HH" => ("h", "h"),
        "JH" => ("j", "dʒ"),
        "K" => ("k", "k"),
        "L" => ("l", "l"),
        "M" => ("m", "m"),
        "N" => ("n", "n"),
        "NG" => ("ng", "ŋ"),
        "P" => ("p", "p"),
        "R" => ("r", "ɹ"),
        "S" => ("s", "s"),
        "SH" => ("sh", "ʃ"),
        "T" => ("t", "t"),
        "TH" => ("th", "θ"),
        "V" => ("v", "v"),
        "W" => ("w", "w"),
        "Y" => ("y", "j"),
        "Z" => ("z", "z"),
        "ZH" => ("zh", "ʒ"),
        _ => ("", ""),
    }
}

/// consonant clusters that can start an English syllable
static ONSETS: LazyLock<HashSet<Vec<&'static str>>> = LazyLock::new(|| {
    "P R|P L|B R|B L|T R|D R|K R|K L|G R|G L|F R|F L|TH R|SH R|S P|S T|S K|S M|S N|S L|S W|T W|D W|K W|G W|TH W|\
     S P R|S T R|S K R|S P L|S K W|P Y|B Y|K Y|F Y|M Y|V Y|HH Y|G Y|S K Y|S P Y"
        .split('|')
        .map(|onset| onset.split(' ').collect())
        .collect()
});

/// Every vowel a syllable; the consonants between two vowels go to the second as the longest legal onset
/// ("six-teen": S IH K | S T IY N).
fn syllables(phones: &[String]) -> Vec<(&[String], Option<u8>)> {
    let vi: Vec<usize> =
        (0..phones.len()).filter(|&phone_index| phones[phone_index].ends_with(|character: char| character.is_ascii_digit())).collect();
    if vi.is_empty() {
        return vec![(phones, None)];
    }
    let mut cuts = vec![0];
    for vowel_pair in vi.windows(2) {
        let mid: Vec<&str> = phones[vowel_pair[0] + 1..vowel_pair[1]].iter().map(String::as_str).collect();
        let mut onset_len = 0;
        for candidate_len in (1..=mid.len()).rev() {
            let tail = mid[mid.len() - candidate_len..].to_vec();
            if (candidate_len == 1 && mid[mid.len() - 1] != "NG") || ONSETS.contains(&tail) {
                onset_len = candidate_len;
                break;
            }
        }
        cuts.push(vowel_pair[1] - onset_len);
    }
    cuts.push(phones.len());
    cuts.windows(2)
        .zip(&vi)
        .map(|(bounds, &vowel_index)| {
            let stress = phones[vowel_index].chars().last().and_then(|stress_mark| stress_mark.to_digit(10)).map(|digit| digit as u8);
            (&phones[bounds[0]..bounds[1]], stress)
        })
        .collect()
}

#[derive(Serialize)]
pub struct SoundsLike {
    /// the syllables, each with whether it carries the main stress
    pub spell: Vec<(String, bool)>,
    pub ipa: String,
}

pub fn sounds_like(word: &str) -> Option<SoundsLike> {
    let lower = word.to_lowercase().replace('\u{2019}', "'");
    let mut spell = vec![];
    let mut ipas = vec![];
    for part in lower.split(['-', '–', '—', '/']).filter(|piece| !piece.is_empty()) {
        let letters: String = part.chars().filter(|character| character.is_ascii_lowercase() || *character == '\'').collect();
        let phones = DICT.get(letters.trim_matches('\''))?;
        let mut ipa = vec![];
        for (syl, stress) in syllables(phones) {
            let (mut respelling, mut syllable_ipa) = (String::new(), String::new());
            for (phone_index, phone) in syl.iter().enumerate() {
                let digit = phone.chars().last().filter(|character| character.is_ascii_digit());
                let base = if digit.is_some() { &phone[..phone.len() - 1] } else { phone.as_str() };
                match (digit, vowel(base)) {
                    (Some(stress_digit), Some((mut spelled, mut sound))) => {
                        if stress_digit == '0' {
                            let rest: Vec<&str> = syl[phone_index + 1..].iter().map(String::as_str).collect();
                            match base {
                                "ER" => (spelled, sound) = ("r", "ɚ"),
                                // a weak "uh" before a final n or l after a consonant is the syllabic n/l ("shn", "tl")
                                "AH" if phone_index > 0 && (rest == ["N"] || rest == ["L"]) => (spelled, sound) = ("", "ə"),
                                "AH" => (spelled, sound) = ("uh", "ə"),
                                _ => {}
                            }
                        }
                        respelling.push_str(spelled);
                        syllable_ipa.push_str(sound);
                    }
                    _ => {
                        let (spelled, sound) = consonant(base);
                        respelling.push_str(spelled);
                        syllable_ipa.push_str(sound);
                    }
                }
            }
            spell.push((respelling, stress == Some(1)));
            ipa.push(match stress {
                Some(1) => format!("ˈ{syllable_ipa}"),
                Some(2) => format!("ˌ{syllable_ipa}"),
                _ => syllable_ipa,
            });
        }
        ipas.push(ipa.join(".").replace(".ˈ", "ˈ").replace(".ˌ", "ˌ"));
    }
    Some(SoundsLike { spell, ipa: format!("/{}/", ipas.join(" ")) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spelled(word: &str) -> String {
        sounds_like(word)
            .unwrap()
            .spell
            .iter()
            .map(|(syllable, stressed)| if *stressed { syllable.to_uppercase() } else { syllable.clone() })
            .collect::<Vec<_>>()
            .join("·")
    }

    #[test]
    fn respellings_match_the_python_engine() {
        assert_eq!(spelled("answer"), "AN·sr");
        assert_eq!(spelled("sixteen"), "sik·STEEN");
        assert_eq!(spelled("eleventh"), "i·LEH·vuhnth");
        assert_eq!(spelled("station"), "STAY·shn");
        assert_eq!(spelled("things"), "THINGZ");
        assert_eq!(sounds_like("answer").unwrap().ipa, "/ˈæn.sɚ/");
        assert_eq!(spelled("GPS-guided"), "GEE·pee·EHS·GAI·duhd");
    }

    #[test]
    fn unknown_words_have_no_respelling() {
        assert!(sounds_like("Cougaar").is_none());
    }
}
