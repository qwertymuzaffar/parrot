//! A talk: speech with no text in front of it (a story, an interview answer). The interface sends the recording in
//! blocks while it is made, into a file under talks/, so a long talk never sits in memory or crosses to the engine in
//! one piece. When it stops, Whisper writes down what was said and the aligner scores every word of that.

use crate::text::{self, WordResult, WordStatus};
use crate::{Listen, MICROPHONE_WITHHELD, NOTHING_HEARD, audio};
use regex::Regex;
use serde::Serialize;
use std::fs::{self, File};
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};

/// The longest talk (seconds). The interface stops at this; the engine refuses blocks a little past it.
pub const LONGEST: f64 = 600.0;
const SLACK: f64 = 5.0;
/// Whisper hears a talk in stretches at most this long, cut at its pauses (it reads 30-second windows).
const STRETCH: f64 = 25.0;

pub const CANCELLED: &str = "the writing-down was cancelled";
const NO_WORDS: &str = "Parrot couldn't make out any words. Speak a little closer to the microphone, and try again.";

/// What Whisper writes for sounds that aren't words: [BLANK_AUDIO], [Music], (laughs), * coughs *.
static NOT_WORDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[[^\]]*\]|\([^)]*\)|\*[^*]*\*").unwrap());

/// What was heard in a talk, word by word.
#[derive(Serialize, Debug)]
pub struct Heard {
    /// what Whisper wrote down: the text the words are judged against until the user corrects it
    pub heard: String,
    pub words: Vec<WordResult>,
    pub duration: f64,
    pub wpm: i64,
    pub score: i64,
    /// the long pauses: the word each comes after, and how long it is (seconds)
    pub pauses: Vec<(usize, f64)>,
}

struct Talk {
    path: PathBuf,
    /// open while the talk is recorded; closed when it is written down
    writer: Option<hound::WavWriter<BufWriter<File>>>,
    rate: u32,
    samples: u64,
    /// the file holds the cleaned recording (written down once, so a second writing-down doesn't clean it again)
    cleaned: bool,
}

/// The talk under way, if any: one at a time.
pub struct Talks {
    dir: PathBuf,
    current: Mutex<Option<Talk>>,
    cancel: AtomicBool,
}

impl Talks {
    /// The talks in `dir`. A talk left there when Parrot quit is gone: nothing can be done with it yet.
    pub fn open(dir: PathBuf) -> Self {
        let _ = fs::remove_dir_all(&dir);
        Talks { dir, current: Mutex::new(None), cancel: AtomicBool::new(false) }
    }

    fn current(&self) -> MutexGuard<'_, Option<Talk>> {
        self.current.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Start a talk recorded at `rate`, dropping one not kept.
    pub fn start(&self, rate: u32) -> Result<(), String> {
        if !(8000..=192_000).contains(&rate) {
            return Err(format!("a talk can't be recorded at {rate} Hz"));
        }
        self.discard()?;
        fs::create_dir_all(&self.dir).map_err(|error| error.to_string())?;
        let path = self.dir.join(format!("{}.wav", chrono::Local::now().format("%Y%m%d-%H%M%S")));
        let spec = hound::WavSpec { channels: 1, sample_rate: rate, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let writer = hound::WavWriter::create(&path, spec).map_err(|error| error.to_string())?;
        *self.current() = Some(Talk { path, writer: Some(writer), rate, samples: 0, cleaned: false });
        Ok(())
    }

    /// More of the talk: 16-bit little-endian samples, as recorded.
    pub fn feed(&self, bytes: &[u8]) -> Result<(), String> {
        let mut current = self.current();
        let talk = current.as_mut().ok_or("no talk is being recorded")?;
        let writer = talk.writer.as_mut().ok_or("the talk has stopped")?;
        let (samples, rest) = bytes.as_chunks::<2>();
        if !rest.is_empty() {
            return Err("a block of a talk must be whole 16-bit samples".into());
        }
        let count = samples.len() as u64;
        if (talk.samples + count) as f64 > (LONGEST + SLACK) * talk.rate as f64 {
            return Err(format!("a talk can be at most {} minutes", LONGEST / 60.0));
        }
        for sample in samples {
            writer.write_sample(i16::from_le_bytes(*sample)).map_err(|error| error.to_string())?;
        }
        talk.samples += count;
        Ok(())
    }

    /// Stop writing down the talk at the next stretch. The recording is kept, to write down again or discard.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    /// Drop the talk and its recording (cancelling a writing-down under way first).
    pub fn discard(&self) -> Result<(), String> {
        self.cancel();
        let mut current = self.current();
        if let Some(talk) = current.take() {
            drop(talk.writer);
            fs::remove_file(&talk.path)
                .or_else(|error| if error.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(error.to_string()) })?;
        }
        Ok(())
    }

    /// Stop the recording (if it is still going), then write down what was said and score every word of it.
    /// `progress` gets the seconds written down so far and the talk's length, after each stretch.
    pub fn write_down(&self, listener: &impl Listen, progress: impl Fn(f64, f64)) -> Result<Heard, String> {
        self.cancel.store(false, Ordering::SeqCst);
        let mut current = self.current();
        let talk = current.as_mut().ok_or("there is no talk to write down")?;
        if let Some(writer) = talk.writer.take() {
            writer.finalize().map_err(|error| error.to_string())?;
        }
        let pcm = audio::read_wav(&fs::read(&talk.path).map_err(|error| error.to_string())?)?;
        let pcm = if talk.cleaned {
            pcm
        } else {
            if audio::blank(&pcm) {
                return Err(MICROPHONE_WITHHELD.into());
            }
            let cleaned = audio::clean(pcm).filter(|cleaned| cleaned.seconds() >= audio::SHORTEST_TAKE).ok_or(NOTHING_HEARD)?;
            // the recording kept from here on is the cleaned one, which the words' times are in
            audio::write_wav(&talk.path, &cleaned)?;
            talk.cleaned = true;
            cleaned
        };
        let duration = pcm.seconds();
        let samples = audio::resample(&pcm, 16000);
        drop(pcm);
        let mut said: Vec<String> = vec![];
        let mut times: Vec<text::WordTime> = vec![];
        for stretch in audio::stretches(&samples, 16000, STRETCH) {
            if self.cancel.load(Ordering::SeqCst) {
                return Err(CANCELLED.into());
            }
            // each stretch heard and placed on its own: placing a whole talk at once takes memory in proportion to
            // its length times its letters (hundreds of MB for ten minutes)
            let audio = &samples[stretch.clone()];
            let heard = tidy(&listener.transcribe(audio, &[])?);
            if !heard.is_empty() {
                let offset = stretch.start as f64 / 16000.0;
                let placed = listener.align(audio, &heard)?;
                times.extend(
                    placed
                        .into_iter()
                        .map(|word| text::WordTime { t: word.t.map(|[from, to]| [round3(from + offset), round3(to + offset)]), ..word }),
                );
                said.push(heard);
            }
            progress(stretch.end as f64 / 16000.0, samples.len() as f64 / 16000.0);
        }
        let heard = said.join(" ");
        if heard.is_empty() {
            return Err(NO_WORDS.into());
        }
        // judged against itself: nothing is misheard until the user says what they meant, so the verdicts are the
        // sound scores
        let words = text::judge(&heard, &heard, &times, None);
        let good = words.iter().filter(|word| word.status == WordStatus::Good).count();
        Ok(Heard {
            score: (100.0 * good as f64 / words.len() as f64).round() as i64,
            wpm: (words.len() as f64 / duration * 60.0).round() as i64,
            pauses: text::pauses(&words),
            duration: (duration * 100.0).round() / 100.0,
            heard,
            words,
        })
    }
}

/// What Whisper wrote, without the sounds that aren't words and with single spaces.
fn tidy(heard: &str) -> String {
    NOT_WORDS.replace_all(heard, " ").split_whitespace().collect::<Vec<_>>().join(" ")
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Hears `heard` in every stretch and places its words half a second apart; remembers each stretch's length.
    struct Stretches {
        heard: &'static str,
        lengths: RefCell<Vec<f64>>,
    }

    impl Listen for Stretches {
        fn align(&self, _audio: &[f32], text: &str) -> Result<Vec<text::WordTime>, String> {
            let word_time = |word_index: usize| {
                let start = word_index as f64 * 0.5;
                text::WordTime { t: Some([start, start + 0.4]), score: Some(if word_index == 1 { 0.3 } else { 0.9 }), letters: None }
            };
            Ok((0..text.split_whitespace().count()).map(word_time).collect())
        }

        fn transcribe(&self, audio: &[f32], _words: &[text::WordTime]) -> Result<String, String> {
            self.lengths.borrow_mut().push(audio.len() as f64 / 16000.0);
            Ok(self.heard.to_string())
        }
    }

    fn talks(name: &str) -> (Talks, PathBuf) {
        let dir = std::env::temp_dir().join(format!("parrot-talks-{name}-{}", std::process::id()));
        (Talks::open(dir.clone()), dir)
    }

    /// `secs` of speech-like sound at `rate` as the interface sends it: bursts of a tone with short quiet between.
    fn speech(rate: u32, secs: f64) -> Vec<u8> {
        (0..(secs * rate as f64) as usize)
            .map(|sample_index| {
                let time = sample_index as f64 / rate as f64;
                let loud = time % 7.0 < 6.5;
                let level = if loud { 0.3 * (2.0 * std::f64::consts::PI * 220.0 * time).sin() } else { 0.0005 };
                (level * 32767.0) as i16
            })
            .flat_map(i16::to_le_bytes)
            .collect()
    }

    #[test]
    fn a_talk_fed_in_blocks_is_written_down_in_stretches() {
        let (talks, dir) = talks("fed");
        talks.start(16000).unwrap();
        // 60 s in blocks of a quarter second, as the interface sends them
        for block in speech(16000, 60.0).chunks(8000) {
            talks.feed(block).unwrap();
        }
        let listener = Stretches { heard: "well [BLANK_AUDIO] the beautiful things", lengths: RefCell::new(vec![]) };
        let reported = RefCell::new(vec![]);
        let heard = talks.write_down(&listener, |done, total| reported.borrow_mut().push((done, total))).unwrap();

        let lengths = listener.lengths.borrow();
        assert!(lengths.len() >= 3 && lengths.iter().all(|secs| *secs <= STRETCH), "{lengths:?}");
        assert_eq!(heard.heard, vec!["well the beautiful things"; lengths.len()].join(" "), "each stretch, without what isn't words");
        assert_eq!(heard.words.len(), 4 * lengths.len());
        // nothing is misheard; the word that sounded off in each stretch is unclear
        assert!(heard.words.iter().all(|word| word.heard.is_none()));
        assert_eq!(heard.words.iter().filter(|word| word.status == WordStatus::Unclear).count(), lengths.len());
        assert_eq!(heard.score, 75);
        // the second stretch's words are placed after the first stretch's end, and the gap between them is a pause
        let second = heard.words[4].t.unwrap()[0];
        assert!(second > lengths[0] - 0.5, "{second} vs {}", lengths[0]);
        assert_eq!(heard.pauses.first().map(|(after, _)| *after), Some(3));
        // progress after each stretch, ending at the whole talk
        let reported = reported.borrow();
        assert_eq!(reported.len(), lengths.len());
        assert!(reported.windows(2).all(|pair| pair[0].0 < pair[1].0));
        assert!((reported.last().unwrap().0 - reported.last().unwrap().1).abs() < 0.01);
        assert!(heard.duration > 55.0 && heard.duration <= 60.0, "{}", heard.duration);
        assert!(!dir.join("texts").exists(), "a talk written down is kept nowhere but talks/");
        talks.discard().unwrap();
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0, "discarding removes the recording");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_cancelled_writing_down_keeps_the_recording() {
        let (talks, dir) = talks("cancel");
        talks.start(16000).unwrap();
        talks.feed(&speech(16000, 40.0)).unwrap();
        // cancelled while the first stretch is heard
        struct Cancelling<'a>(&'a Talks, Stretches);
        impl Listen for Cancelling<'_> {
            fn align(&self, audio: &[f32], text: &str) -> Result<Vec<text::WordTime>, String> {
                self.1.align(audio, text)
            }
            fn transcribe(&self, audio: &[f32], words: &[text::WordTime]) -> Result<String, String> {
                self.0.cancel();
                self.1.transcribe(audio, words)
            }
        }
        let cancelling = Cancelling(&talks, Stretches { heard: "hello there", lengths: RefCell::new(vec![]) });
        assert_eq!(talks.write_down(&cancelling, |_, _| {}).unwrap_err(), CANCELLED);
        assert_eq!(cancelling.1.lengths.borrow().len(), 1, "it stopped after the stretch under way");
        // written down again: from the cleaned recording, all of it this time
        let listener = Stretches { heard: "hello there", lengths: RefCell::new(vec![]) };
        let heard = talks.write_down(&listener, |_, _| {}).unwrap();
        assert_eq!(heard.words.len(), 2 * listener.lengths.borrow().len());
        talks.discard().unwrap();
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_talk_is_at_most_ten_minutes() {
        let (talks, dir) = talks("cap");
        talks.start(8000).unwrap();
        let minute = vec![0u8; 8000 * 2 * 60];
        for _ in 0..10 {
            talks.feed(&minute).unwrap();
        }
        talks.feed(&vec![0u8; 8000 * 2 * 4]).unwrap(); // the slack: blocks still on their way at 10:00
        assert!(talks.feed(&vec![0u8; 8000 * 2 * 2]).unwrap_err().contains("at most 10 minutes"));
        assert!(talks.feed(&[0u8; 3]).unwrap_err().contains("whole 16-bit samples"));
        talks.discard().unwrap();
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn silence_and_withheld_microphones_are_said_as_for_a_take() {
        let (talks, dir) = talks("silent");
        let listener = Stretches { heard: "", lengths: RefCell::new(vec![]) };
        talks.start(16000).unwrap();
        talks.feed(&vec![0u8; 16000 * 2 * 3]).unwrap();
        assert_eq!(talks.write_down(&listener, |_, _| {}).unwrap_err(), MICROPHONE_WITHHELD);
        talks.start(16000).unwrap();
        talks.feed(&speech(16000, 3.0)).unwrap();
        assert_eq!(talks.write_down(&listener, |_, _| {}).unwrap_err(), NO_WORDS, "sound, but no words in it");
        assert!(talks.feed(&[0, 0]).unwrap_err().contains("stopped"));
        talks.discard().unwrap();
        assert!(talks.write_down(&listener, |_, _| {}).is_err(), "nothing left to write down");
        assert!(talks.start(1000).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn talks_left_from_last_time_are_cleared() {
        let dir = std::env::temp_dir().join(format!("parrot-talks-left-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("20261020-101010.wav"), b"half a talk").unwrap();
        let _talks = Talks::open(dir.clone());
        assert!(!dir.exists());
    }
}
