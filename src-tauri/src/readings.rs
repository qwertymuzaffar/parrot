//! Readings by the engine's voice, kept: a text read by one of Kokoro's voices at a speed goes in the data folder as a
//! WAV file, with when each word is said beside it, so the window plays it and lights the words as they come.
//!
//! ```text
//! readings/<voice>/<sha1 of the words>-<speed>.wav    the reading, 24 kHz mono
//! readings/<voice>/<sha1 of the words>-<speed>.json   when each word starts and ends (seconds)
//! ```

use crate::audio::Pcm;
use crate::disk;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// A reading, as the window gets it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Reading {
    /// the WAV file, relative to the data folder
    pub audio: String,
    /// when each word of the text is said: start and end, in seconds
    pub words: Vec<[f64; 2]>,
}

/// Whether `voice` is a name the voices file could have ("af_heart"): lower-case letters and underscores only, so it
/// is safe as a folder name.
pub fn valid_voice(voice: &str) -> bool {
    !voice.is_empty() && voice.len() <= 32 && voice.chars().all(|character| character.is_ascii_lowercase() || character == '_')
}

/// Where the reading of `text` (its words, normalised) by `voice` at `speed` is kept, relative to the data folder and
/// without its extension: readings/af_heart/<sha1>-0.75.
pub fn place(voice: &str, text: &str, speed: f32) -> String {
    format!("readings/{voice}/{}-{speed}", crate::store::sha(text))
}

/// Keep a reading at `place`: its words' times, then the WAV, written whole or not at all.
pub fn save(data: &Path, place: &str, pcm: &Pcm, words: &[[f64; 2]]) -> Result<Reading, String> {
    let wav = data.join(format!("{place}.wav"));
    if let Some(folder) = wav.parent() {
        std::fs::create_dir_all(folder).map_err(disk::said)?;
    }
    let times = serde_json::to_vec(words).map_err(|error| error.to_string())?;
    std::fs::write(data.join(format!("{place}.json")), times).map_err(disk::said)?;
    crate::audio::write_wav(&wav, pcm)?;
    Ok(Reading { audio: format!("{place}.wav"), words: words.to_vec() })
}

pub fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

/// The time of every word, from where the aligner placed them: a word it could not place (digits, which it doesn't
/// know; a word too short to hear) takes the gap between its neighbours, shared with any others unplaced beside it;
/// with none placed at all, the words share the reading evenly.
pub fn fill(placed: &[Option<[f64; 2]>], seconds: f64) -> Vec<[f64; 2]> {
    let count = placed.len();
    let mut out = vec![[0.0; 2]; count];
    let mut index = 0;
    while index < count {
        if let Some(time) = placed[index] {
            out[index] = time;
            index += 1;
            continue;
        }
        // the run of unplaced words from here, and the placed ones (or the reading's ends) on either side of it
        let end = (index..count).find(|&next| placed[next].is_some()).unwrap_or(count);
        let from = if index == 0 { 0.0 } else { out[index - 1][1] };
        let to = if end == count { seconds } else { placed[end].unwrap()[0] };
        let step = (to - from).max(0.0) / (end - index) as f64;
        for (offset, word) in out[index..end].iter_mut().enumerate() {
            *word = [round3(from + step * offset as f64), round3(from + step * (offset + 1) as f64)];
        }
        index = end;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reading_is_kept_under_its_voice_words_and_speed() {
        assert_eq!(place("af_heart", "Hello there.", 0.75), format!("readings/af_heart/{}-0.75", crate::store::sha("Hello there.")));
        assert!(place("af_heart", "Hello there.", 1.0).ends_with("-1"));
        assert!(place("af_heart", "Hello there.", 0.6).ends_with("-0.6"));
        assert!(["af_heart", "bm_george"].iter().all(|voice| valid_voice(voice)));
        assert!(!["", "../texts", "af heart", "Af_Heart", "a".repeat(40).as_str()].iter().any(|voice| valid_voice(voice)));
    }

    #[test]
    fn a_reading_saved_is_a_wav_with_its_words_times_beside_it() {
        let data = std::env::temp_dir().join(format!("parrot-readings-{}", std::process::id()));
        let pcm = Pcm { samples: vec![0.1; 2400], rate: 24000 };
        let reading = save(&data, "readings/af_heart/abc-1", &pcm, &[[0.0, 0.05], [0.05, 0.1]]).unwrap();
        assert_eq!(reading, Reading { audio: "readings/af_heart/abc-1.wav".into(), words: vec![[0.0, 0.05], [0.05, 0.1]] });
        assert_eq!(crate::audio::read_wav_file(&data.join("readings/af_heart/abc-1.wav")).unwrap().samples.len(), 2400);
        let times: Vec<[f64; 2]> = serde_json::from_slice(&std::fs::read(data.join("readings/af_heart/abc-1.json")).unwrap()).unwrap();
        assert_eq!(times, reading.words);
        std::fs::remove_dir_all(&data).unwrap();
    }

    #[test]
    fn a_word_the_aligner_could_not_place_takes_the_gap_between_its_neighbours() {
        let placed = [Some([0.1, 0.5]), None, Some([1.1, 1.5]), None, None];
        assert_eq!(fill(&placed, 3.0), vec![[0.1, 0.5], [0.5, 1.1], [1.1, 1.5], [1.5, 2.25], [2.25, 3.0]]);
        // unplaced at the start, from the reading's start
        assert_eq!(fill(&[None, Some([0.4, 0.9])], 1.0), vec![[0.0, 0.4], [0.4, 0.9]]);
        // none placed: the words share the reading evenly
        assert_eq!(fill(&[None, None], 1.0), vec![[0.0, 0.5], [0.5, 1.0]]);
        assert!(fill(&[], 1.0).is_empty());
    }
}
