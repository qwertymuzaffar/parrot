//! Readings by the engine's voice, kept: a text read by one of Kokoro's voices at a speed goes in the data folder as a
//! WAV file, with when each word is said beside it, so the window plays it and lights the words as they come.
//!
//! ```text
//! readings/<voice>/<sha1 of the words>-<speed>.wav    the reading, 24 kHz mono
//! readings/<voice>/<sha1 of the words>-<speed>.json   when each word starts and ends (seconds)
//! ```
//!
//! A reading is made once and kept: the folder is capped (CAP), the readings not played for longest going first, and
//! emptied with the trash. The texts' own files are never touched: a reading is a copy the engine can make again.

use crate::audio::Pcm;
use crate::disk;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// How much the readings may take on disk (bytes): about 20 minutes of reading, a dozen texts at every speed.
pub const CAP: u64 = 300_000_000;

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

/// The reading kept at `place`, if both its files are there and read; it counts as played now, so it stays while others
/// go (see trim).
pub fn load(data: &Path, place: &str) -> Option<Reading> {
    let times = std::fs::read(data.join(format!("{place}.json"))).ok()?;
    let words: Vec<[f64; 2]> = serde_json::from_slice(&times).ok()?;
    let wav = std::fs::OpenOptions::new().write(true).open(data.join(format!("{place}.wav"))).ok()?;
    let _ = wav.set_modified(SystemTime::now());
    Some(Reading { audio: format!("{place}.wav"), words })
}

/// Bring the readings under `cap` bytes: the ones not played for longest go first, each with its words' times. A
/// reading made just now is as good as played.
pub fn trim(data: &Path, cap: u64) {
    let mut readings: Vec<(SystemTime, PathBuf, u64)> = vec![];
    for voice in std::fs::read_dir(dir(data)).into_iter().flatten().flatten() {
        for entry in std::fs::read_dir(voice.path()).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|extension| extension == "wav")
                && let Ok(metadata) = entry.metadata()
            {
                let times = std::fs::metadata(path.with_extension("json")).map(|metadata| metadata.len()).unwrap_or(0);
                readings.push((metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH), path, metadata.len() + times));
            }
        }
    }
    let mut total: u64 = readings.iter().map(|(_, _, size)| size).sum();
    readings.sort_by_key(|(played, _, _)| *played);
    for (_, wav, size) in readings {
        if total <= cap {
            break;
        }
        if let Err(error) = std::fs::remove_file(&wav) {
            log::warn!("could not remove the reading {}: {error}", wav.display());
            continue;
        }
        let _ = std::fs::remove_file(wav.with_extension("json"));
        total -= size;
    }
}

/// Remove every reading (with the trash emptied): they are made again as texts are opened.
pub fn clear(data: &Path) {
    let folder = dir(data);
    if let Err(error) = std::fs::remove_dir_all(&folder)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        log::warn!("could not remove the readings in {}: {error}", folder.display());
    }
}

/// The folder of the readings.
fn dir(data: &Path) -> PathBuf {
    data.join("readings")
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

    /// Keep `seconds` of silence as a reading at `place`, last played at `age` seconds before now.
    fn kept(data: &Path, place: &str, seconds: usize, age: u64) -> PathBuf {
        let pcm = Pcm { samples: vec![0.0; 24000 * seconds], rate: 24000 };
        save(data, place, &pcm, &[[0.0, seconds as f64]]).unwrap();
        let wav = data.join(format!("{place}.wav"));
        let played = SystemTime::now() - std::time::Duration::from_secs(age);
        std::fs::OpenOptions::new().write(true).open(&wav).unwrap().set_modified(played).unwrap();
        wav
    }

    #[test]
    fn a_reading_kept_is_found_again_and_counts_as_played_now() {
        let data = std::env::temp_dir().join(format!("parrot-readings-load-{}", std::process::id()));
        let wav = kept(&data, "readings/af_heart/abc-1", 1, 3600);
        let reading = load(&data, "readings/af_heart/abc-1").unwrap();
        assert_eq!(reading, Reading { audio: "readings/af_heart/abc-1.wav".into(), words: vec![[0.0, 1.0]] });
        let since = SystemTime::now().duration_since(std::fs::metadata(&wav).unwrap().modified().unwrap()).unwrap();
        assert!(since.as_secs() < 60, "played now");
        // without its words' times, or its WAV, it is no reading
        std::fs::remove_file(data.join("readings/af_heart/abc-1.json")).unwrap();
        assert!(load(&data, "readings/af_heart/abc-1").is_none());
        assert!(load(&data, "readings/af_heart/nothing-1").is_none());
        std::fs::remove_dir_all(&data).unwrap();
    }

    #[test]
    fn the_readings_are_kept_under_the_cap_the_longest_unplayed_going_first() {
        let data = std::env::temp_dir().join(format!("parrot-readings-trim-{}", std::process::id()));
        let old = kept(&data, "readings/af_heart/old-1", 2, 3000);
        let older = kept(&data, "readings/bm_george/older-1", 2, 6000);
        let new = kept(&data, "readings/af_heart/new-0.75", 2, 10);
        let size = |path: &Path| std::fs::metadata(path).map(|metadata| metadata.len()).unwrap_or(0);
        let each = size(&new) + size(&new.with_extension("json"));
        // room for two: the oldest goes, with its times; the rest stay
        trim(&data, 2 * each + 10);
        assert!(!older.exists() && !older.with_extension("json").exists());
        assert!(old.exists() && new.exists());
        // under the cap: nothing goes
        trim(&data, 2 * each + 10);
        assert!(old.exists() && new.exists());
        clear(&data);
        assert!(!data.join("readings").exists());
        // nothing to clear is fine
        clear(&data);
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
