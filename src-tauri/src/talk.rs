//! A talk: speech with no text in front of it (a story, an interview answer). The interface sends the recording in
//! blocks while it is made, into a file under talks/, so a long talk never sits in memory or crosses to the engine in
//! one piece. When it stops, Whisper writes down what was said and the aligner scores every word of that. Kept, the
//! talk becomes a text (what was said, as the user corrected it) with its recording as the first take.
//!
//! A talk not kept when Parrot quits or crashes is kept for the next start: its recording (whose header is brought up
//! to date after every block) and, beside it, what is known of it so far (`<stamp>.json`: whether the recording is
//! cleaned, and what was heard once it is written down).

use crate::store::{self, Attempt, Store, TextItem};
use crate::text::{self, WordResult, WordStatus};
use crate::{Listen, MICROPHONE_WITHHELD, NOTHING_HEARD, audio, score_take};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::BufWriter;
use std::ops::Range;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Condvar, LazyLock, Mutex, MutexGuard, PoisonError};

/// The longest talk (seconds). The interface stops at this; the engine refuses blocks a little past it.
pub const LONGEST: f64 = 1800.0;
const SLACK: f64 = 5.0;
/// Whisper hears a talk in stretches at most this long, cut at its pauses (it reads 30-second windows).
pub const STRETCH: f64 = 25.0;
/// While a talk is recorded, it is heard in stretches at most this long, so what was said shows soon after.
const LIVE_STRETCH: f64 = 12.0;

pub const CANCELLED: &str = "the writing-down was cancelled";
const NO_WORDS: &str = "Parrot couldn't make out any words. Speak a little closer to the microphone, and try again.";

/// What Whisper writes for sounds that aren't words: [BLANK_AUDIO], [Music], (laughs), * coughs *.
static NOT_WORDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[[^\]]*\]|\([^)]*\)|\*[^*]*\*").unwrap());

/// What was heard in a talk, word by word.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Heard {
    /// what Whisper wrote down: the text the words are judged against until the user corrects it
    pub heard: String,
    pub words: Vec<WordResult>,
    pub duration: f64,
    pub wpm: i64,
    pub score: i64,
    /// the long pauses: the word each comes after, and how long it is (seconds)
    pub pauses: Vec<(usize, f64)>,
    /// the recording (cleaned), relative to the data folder, to play back while the talk is checked
    pub audio: String,
}

struct Talk {
    path: PathBuf,
    /// open while the talk is recorded; closed when it is written down
    writer: Option<hound::WavWriter<BufWriter<File>>>,
    rate: u32,
    samples: u64,
    /// the file holds the cleaned recording (written down once, so a second writing-down doesn't clean it again)
    cleaned: bool,
    /// once written down: the stretches it was heard in (16 kHz samples), what was heard in each and where its words
    /// were placed in it
    written: Option<Vec<Written>>,
    /// once written down: what was heard, as the interface was told
    heard: Option<Heard>,
    /// which talk of the session it is: what is heard of a talk discarded meanwhile is dropped
    generation: u64,
    /// what is heard of it while it is recorded
    live: Live,
}

/// A talk heard while it is recorded, a stretch at a time, so that once it stops only its last stretch is left.
#[derive(Default)]
struct Live {
    /// the sound recorded since the last stretch taken to be heard (at the talk's rate)
    pending: Vec<f32>,
    /// where `pending` starts in the recording (samples at the talk's rate)
    at: usize,
    /// the stretches heard
    heard: Vec<LiveStretch>,
    /// what was heard since the interface last sent a block
    news: Vec<String>,
    /// a stretch is being heard
    busy: bool,
    /// a stretch couldn't be heard: the talk is written down whole once it stops
    broken: bool,
}

/// A stretch of a talk heard while it was recorded: where it is in the recording as recorded (samples at the talk's
/// rate), what was heard, and its words placed in it.
struct LiveStretch {
    from: usize,
    to: usize,
    heard: String,
    placed: Vec<text::WordTime>,
}

/// A stretch of a talk to hear while it is recorded (16 kHz).
pub struct LiveJob {
    generation: u64,
    from: usize,
    to: usize,
    audio: Vec<f32>,
}

/// What is known of a talk beyond its recording, kept beside it so that a talk outlives a quit or a crash.
#[derive(Serialize, Deserialize, Default)]
struct Known {
    cleaned: bool,
    written: Option<Vec<Written>>,
    heard: Option<Heard>,
}

/// A talk left from the last time Parrot ran, not kept: to write down (again) or discard.
#[derive(Serialize, Debug)]
pub struct Left {
    /// when it was started (local time, 2026-10-21T14:05:00)
    pub started: String,
    /// its length (seconds)
    pub duration: f64,
    /// what was heard, if it was written down
    pub heard: Option<Heard>,
}

/// One stretch of a talk written down.
#[derive(Serialize, Deserialize, Clone)]
struct Written {
    stretch: Range<usize>,
    heard: String,
    /// the words heard, placed in the stretch
    placed: Vec<text::WordTime>,
}

/// A talk kept: the text it became, and its recording as the text's first take.
#[derive(Serialize, Debug)]
pub struct Kept {
    pub text: TextItem,
    pub attempt: Attempt,
}

/// Stands in for the models when a talk is kept: what was heard in the stretch is already known, and so is where its
/// words are when the user didn't change them.
struct Reheard<'a, L: Listen> {
    listener: &'a L,
    written: &'a Written,
}

impl<L: Listen> Listen for Reheard<'_, L> {
    fn align(&self, audio: &[f32], text: &str) -> Result<Vec<text::WordTime>, String> {
        if text == self.written.heard { Ok(self.written.placed.clone()) } else { self.listener.align(audio, text) }
    }

    fn transcribe(&self, _audio: &[f32], _words: &[text::WordTime]) -> Result<String, String> {
        Ok(self.written.heard.clone())
    }
}

/// The talk under way, if any: one at a time.
pub struct Talks {
    /// talks/ in the data folder
    dir: PathBuf,
    current: Mutex<Option<Talk>>,
    /// signalled when a stretch heard while recording is done
    heard: Condvar,
    cancel: AtomicBool,
    generation: AtomicU64,
}

impl Talks {
    /// The talks in `dir`. The latest talk left there when Parrot quit (or crashed) is taken up again, as stopped,
    /// if any of it was recorded; anything else there is cleared.
    pub fn open(dir: PathBuf) -> Self {
        let mut files: Vec<PathBuf> = fs::read_dir(&dir).into_iter().flatten().flatten().map(|entry| entry.path()).collect();
        files.sort();
        let latest = files.iter().rfind(|path| path.extension().is_some_and(|extension| extension == "wav")).cloned();
        let left = latest.as_ref().and_then(|path| Talk::left(path));
        for path in files {
            let known = latest.as_ref().is_some_and(|latest| path == *latest || path == latest.with_extension("json"));
            if !(known && left.is_some()) {
                let _ = if path.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
            }
        }
        Talks { dir, current: Mutex::new(left), heard: Condvar::new(), cancel: AtomicBool::new(false), generation: AtomicU64::new(0) }
    }

    /// The talk left from the last time Parrot ran, if it is still here: not yet started again, kept or discarded.
    pub fn left(&self) -> Option<Left> {
        let current = self.current();
        let talk = current.as_ref().filter(|talk| talk.writer.is_none())?;
        let stem = talk.path.file_stem()?.to_string_lossy().to_string();
        let started = chrono::NaiveDateTime::parse_from_str(&stem, "%Y%m%d-%H%M%S").ok()?;
        Some(Left {
            started: started.format("%Y-%m-%dT%H:%M:%S").to_string(),
            duration: (talk.samples as f64 / talk.rate as f64 * 100.0).round() / 100.0,
            heard: talk.heard.clone(),
        })
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
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *self.current() = Some(Talk {
            path,
            writer: Some(writer),
            rate,
            samples: 0,
            cleaned: false,
            written: None,
            heard: None,
            generation,
            live: Live::default(),
        });
        Ok(())
    }

    /// More of the talk: 16-bit little-endian samples, as recorded. Gives what was heard of it since the last block
    /// (stretches heard while it is recorded: see `listen`).
    pub fn feed(&self, bytes: &[u8]) -> Result<Vec<String>, String> {
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
        // the header brought up to date: a crash loses no more than this block
        writer.flush().map_err(|error| error.to_string())?;
        talk.samples += count;
        // not once a stretch couldn't be heard: nothing more is, and the rest of a long talk would sit in memory
        if !talk.live.broken {
            talk.live.pending.extend(samples.iter().map(|sample| i16::from_le_bytes(*sample) as f32 / 32768.0));
        }
        Ok(std::mem::take(&mut talk.live.news))
    }

    /// A stretch of the talk is ready to be heard while it is recorded.
    pub fn ready(&self) -> bool {
        let current = self.current();
        current.as_ref().is_some_and(|talk| {
            talk.writer.is_some() && !talk.live.busy && !talk.live.broken && talk.live.pending.len() as f64 >= (LIVE_STRETCH + 1.0) * talk.rate as f64
        })
    }

    /// Hear the talk being recorded, a stretch at a time, as long as stretches are ready: called after a block comes
    /// in, away from the interface's thread. One at a time; what was heard goes back with the next block.
    pub fn listen(&self, listener: &impl Listen) {
        while let Some(job) = self.take_stretch() {
            let heard = (|| {
                let heard = tidy(&listener.transcribe(&job.audio, &[])?);
                let placed = if heard.is_empty() { vec![] } else { listener.align(&job.audio, &heard)? };
                Ok::<_, String>((heard, placed))
            })();
            self.stretch_heard(&job, heard);
        }
    }

    /// The next stretch of the talk to hear, cut at a pause as a writing-down cuts it, once enough is recorded.
    fn take_stretch(&self) -> Option<LiveJob> {
        let mut current = self.current();
        let talk = current.as_mut()?;
        let rate = talk.rate;
        let live = &mut talk.live;
        if talk.writer.is_none() || live.busy || live.broken || (live.pending.len() as f64) < (LIVE_STRETCH + 1.0) * rate as f64 {
            return None;
        }
        let pending = audio::resample(&audio::Pcm { samples: live.pending.clone(), rate }, 16000);
        let stretch = audio::stretches(&pending, 16000, LIVE_STRETCH).into_iter().next()?;
        let taken = ((stretch.end as f64 * rate as f64 / 16000.0).round() as usize).min(live.pending.len());
        let mut audio = pending[stretch].to_vec();
        audio::high_pass(&mut audio, 16000);
        live.pending.drain(..taken);
        let job = LiveJob { generation: talk.generation, from: live.at, to: live.at + taken, audio };
        live.at += taken;
        live.busy = true;
        Some(job)
    }

    /// What was heard in a stretch taken while the talk is recorded (or why it couldn't be).
    fn stretch_heard(&self, job: &LiveJob, heard: Result<(String, Vec<text::WordTime>), String>) {
        let mut current = self.current();
        if let Some(talk) = current.as_mut().filter(|talk| talk.generation == job.generation) {
            let live = &mut talk.live;
            live.busy = false;
            match heard {
                Ok((heard, _)) if heard.is_empty() => {}
                Ok((heard, placed)) => {
                    live.news.push(heard.clone());
                    live.heard.push(LiveStretch { from: job.from, to: job.to, heard, placed });
                }
                Err(_) => {
                    live.broken = true;
                    live.pending = vec![];
                }
            }
        }
        self.heard.notify_all();
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
            let _ = fs::remove_file(talk.path.with_extension("json"));
            fs::remove_file(&talk.path)
                .or_else(|error| if error.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(error.to_string()) })?;
        }
        Ok(())
    }

    /// Stop the recording (if it is still going), then write down what was said and score every word of it.
    /// `progress` gets the seconds written down so far and the talk's length, after each stretch.
    pub fn write_down(&self, listener: &impl Listen, progress: impl Fn(f64, f64)) -> Result<Heard, String> {
        self.cancel.store(false, Ordering::SeqCst);
        // a stretch being heard while the talk was recorded is waited for: it is part of what is written down
        let current = self.current();
        let mut current =
            self.heard.wait_while(current, |current| current.as_ref().is_some_and(|talk| talk.live.busy)).unwrap_or_else(PoisonError::into_inner);
        let talk = current.as_mut().ok_or("there is no talk to write down")?;
        if let Some(writer) = talk.writer.take() {
            writer.finalize().map_err(|error| error.to_string())?;
        }
        let live = std::mem::take(&mut talk.live);
        let mut trim = None;
        let pcm = audio::read_wav_file(&talk.path)?;
        let pcm = if talk.cleaned {
            pcm
        } else {
            if audio::blank(&pcm) {
                return Err(MICROPHONE_WITHHELD.into());
            }
            let (cleaned, start) = audio::clean_at(pcm).filter(|(cleaned, _)| cleaned.seconds() >= audio::SHORTEST_TAKE).ok_or(NOTHING_HEARD)?;
            trim = Some(start);
            // the recording kept from here on is the cleaned one, which the words' times are in
            audio::write_wav(&talk.path, &cleaned)?;
            talk.cleaned = true;
            talk.samples = cleaned.samples.len() as u64;
            talk.rate = cleaned.rate;
            talk.save()?;
            cleaned
        };
        let duration = pcm.seconds();
        let samples = audio::resample(&pcm, 16000);
        drop(pcm);
        talk.written = None;
        talk.heard = None;
        let mut said: Vec<String> = vec![];
        let mut times: Vec<text::WordTime> = vec![];
        let mut written = vec![];
        // the stretches heard while it was recorded, moved into the cleaned recording (whose start was trimmed)
        let rate = talk.rate as f64;
        let mut rest = 0;
        if let Some(trim) = trim.filter(|_| !live.broken) {
            for stretch in live.heard {
                let start = (stretch.from as f64 - trim as f64) / rate * 16000.0;
                let (from, to) = (
                    start.max(0.0).round() as usize,
                    (((stretch.to as f64 - trim as f64) / rate * 16000.0).round().max(0.0) as usize).min(samples.len()),
                );
                if to <= from {
                    continue;
                }
                // its words, placed from its start: from the cleaned recording's, if the trim cut into it
                let shift = (start - from as f64) / 16000.0;
                let placed: Vec<text::WordTime> = stretch
                    .placed
                    .into_iter()
                    .map(|word| text::WordTime {
                        t: word.t.map(|[start, end]| [round3((start + shift).max(0.0)), round3((end + shift).max(0.0))]),
                        ..word
                    })
                    .collect();
                let offset = from as f64 / 16000.0;
                times.extend(
                    placed
                        .iter()
                        .cloned()
                        .map(|word| text::WordTime { t: word.t.map(|[start, end]| [round3(start + offset), round3(end + offset)]), ..word }),
                );
                said.push(stretch.heard.clone());
                written.push(Written { stretch: from..to, heard: stretch.heard, placed });
                rest = to;
            }
            if rest > 0 {
                progress(rest as f64 / 16000.0, samples.len() as f64 / 16000.0);
            }
        }
        for stretch in audio::stretches(&samples[rest..], 16000, STRETCH).into_iter().map(|stretch| stretch.start + rest..stretch.end + rest) {
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
                        .iter()
                        .cloned()
                        .map(|word| text::WordTime { t: word.t.map(|[from, to]| [round3(from + offset), round3(to + offset)]), ..word }),
                );
                written.push(Written { stretch: stretch.clone(), heard: heard.clone(), placed });
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
        let file_name = talk.path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
        let folder = self.dir.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
        let heard = Heard {
            audio: format!("{folder}/{file_name}"),
            score: (100.0 * good as f64 / words.len() as f64).round() as i64,
            wpm: (words.len() as f64 / duration * 60.0).round() as i64,
            pauses: text::pauses(&words),
            duration: (duration * 100.0).round() / 100.0,
            heard,
            words,
        };
        talk.written = Some(written);
        talk.heard = Some(heard.clone());
        talk.save()?;
        Ok(heard)
    }
}

impl Talk {
    /// The talk recorded at `path`, left from the last time Parrot ran, with what was known of it; none if nothing of
    /// it can be read.
    fn left(path: &std::path::Path) -> Option<Talk> {
        let reader = hound::WavReader::open(path).ok()?;
        let spec = reader.spec();
        let samples = reader.len() as u64;
        if spec.channels != 1 || spec.bits_per_sample != 16 || (samples as f64) < audio::SHORTEST_TAKE * spec.sample_rate as f64 {
            return None;
        }
        let known: Known = fs::read(path.with_extension("json")).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        Some(Talk {
            path: path.to_path_buf(),
            writer: None,
            rate: spec.sample_rate,
            samples,
            cleaned: known.cleaned,
            written: known.written,
            heard: known.heard,
            generation: 0,
            live: Live::default(),
        })
    }

    /// What is known of the talk, written beside its recording.
    fn save(&self) -> Result<(), String> {
        let known = Known { cleaned: self.cleaned, written: self.written.clone(), heard: self.heard.clone() };
        let json = serde_json::to_vec(&known).map_err(|error| error.to_string())?;
        fs::write(self.path.with_extension("json"), json).map_err(|error| error.to_string())
    }
}

impl Talks {
    /// Keep the talk written down: `said` (what was heard, as the user corrected it) becomes a text practised whole,
    /// titled `title`, and the recording its first take, judged against it as a reading is: a word the user corrected
    /// is misheard, as what speech recognition wrote. The talk is over once kept.
    pub fn keep(&self, listener: &impl Listen, store: &Store, said: &str, title: Option<String>) -> Result<Kept, String> {
        let mut current = self.current();
        let talk = current.as_mut().ok_or("there is no talk to keep")?;
        let written = talk.written.as_ref().ok_or("write the talk down first")?;
        let pcm = audio::read_wav_file(&talk.path)?;
        let duration = pcm.seconds();
        let samples = audio::resample(&pcm, 16000);
        drop(pcm);
        let said = store::norm(said);
        let names = store.names();
        // each stretch judged against the words the user meant in it, as it was written down: placing the whole talk
        // at once would take hundreds of MB
        let mut words: Vec<WordResult> = vec![];
        for (part, meant) in written.iter().zip(share_out(written, &said)) {
            if meant.is_empty() {
                continue;
            }
            let reheard = Reheard { listener, written: part };
            let stretch = &part.stretch;
            let audio = &samples[stretch.clone()];
            let scored = score_take(&reheard, audio, audio.len() as f64 / 16000.0, &meant.join(" "), &names)?;
            let offset = stretch.start as f64 / 16000.0;
            words.extend(
                scored.words.into_iter().map(|word| WordResult { t: word.t.map(|[from, to]| [round3(from + offset), round3(to + offset)]), ..word }),
            );
        }
        let text = store.add(&said, title, Some("whole".into()))?;
        store.set_spoken(&text.id)?;
        let dir = store.part_dir(&text.id, &said)?;
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        let now = chrono::Local::now();
        let id = Store::new_try(&dir, &now.format("%Y%m%d-%H%M%S").to_string())?;
        let file = dir.join(format!("{id}.wav"));
        fs::rename(&talk.path, &file).map_err(|error| error.to_string())?;
        let _ = fs::remove_file(talk.path.with_extension("json"));
        let good = words.iter().filter(|word| word.status == WordStatus::Good).count();
        let attempt = Attempt {
            id,
            when: now.format("%Y-%m-%dT%H:%M:%S").to_string(),
            text: said,
            heard: written.iter().map(|part| part.heard.as_str()).collect::<Vec<_>>().join(" "),
            score: (100.0 * good as f64 / words.len().max(1) as f64).round() as i64,
            wpm: (words.len() as f64 / duration * 60.0).round() as i64,
            pauses: text::pauses(&words),
            duration: (duration * 100.0).round() / 100.0,
            audio: file.strip_prefix(&store.data).unwrap_or(&file).to_string_lossy().replace('\\', "/"),
            words,
            cut: None,
        };
        store.save_attempt(&dir, &attempt)?;
        // each sentence's first try, cut from the talk: practised in sentences, the text has them already
        let sentences = text::sentences(&attempt.text);
        if sentences.len() > 1 {
            // read again, one recording in memory at a time
            drop(samples);
            let pcm = audio::read_wav(&fs::read(&file).map_err(|error| error.to_string())?)?;
            let said: Vec<&str> = attempt.text.split_whitespace().collect();
            for (sentence, span) in sentences.iter().zip(cuts(&attempt.words, &sentences, duration)) {
                cut_take(store, &text.id, &said[sentence.clone()].join(" "), &attempt, sentence.clone(), &pcm, span, &now)?;
            }
        }
        *current = None;
        // read again: its scores now count the take
        Ok(Kept { text: store.text(&text.id)?, attempt })
    }
}

/// The words the user meant, shared out among the stretches the talk was heard in (see `share`).
fn share_out<'a>(written: &[Written], meant: &'a str) -> Vec<Vec<&'a str>> {
    // the stretch of each word heard
    let mut owner = vec![];
    for (stretch_index, part) in written.iter().enumerate() {
        owner.extend(part.heard.split_whitespace().map(|_| stretch_index));
    }
    let heard: Vec<&str> = written.iter().flat_map(|part| part.heard.split_whitespace()).collect();
    share(&owner, &heard, meant, written.len())
}

/// The words `meant` shared out among `parts` stretches, by the words `heard` before (`owner` gives the stretch of
/// each): each word goes with the word heard that it stands for (the same, or a correction of it), and a word added
/// goes with the word heard before it.
pub(crate) fn share<'a>(owner: &[usize], heard: &[&str], meant: &'a str, parts: usize) -> Vec<Vec<&'a str>> {
    let key = |word: &str| store::bare(word).to_lowercase();
    let heard: Vec<String> = heard.iter().map(|word| key(word)).collect();
    let meant: Vec<&str> = meant.split_whitespace().collect();
    let meant_keys: Vec<String> = meant.iter().map(|word| key(word)).collect();
    let mut shared = vec![vec![]; parts];
    if owner.is_empty() {
        return shared;
    }
    for op in similar::capture_diff_slices(similar::Algorithm::Myers, &heard, &meant_keys) {
        let (old, new) = (op.old_range(), op.new_range());
        for (place, meant_index) in new.clone().enumerate() {
            // a correction goes with the word heard at the same place in it; an addition with the word before it
            let heard_index = if old.is_empty() { old.start.saturating_sub(1) } else { old.start + place * old.len() / new.len() };
            shared[owner[heard_index.min(owner.len() - 1)]].push(meant[meant_index]);
        }
    }
    shared
}

/// Where to cut a talk's recording (seconds) for each of its sentences (word ranges of its words): half way between
/// one sentence's last word heard and the next one's first, but no more than CUT_PAD from either. A sentence with no
/// word heard gets nothing ([x, x]).
fn cuts(words: &[WordResult], sentences: &[Range<usize>], duration: f64) -> Vec<[f64; 2]> {
    let spans: Vec<Option<[f64; 2]>> = sentences
        .iter()
        .map(|sentence| {
            let times: Vec<[f64; 2]> = words[sentence.clone()].iter().filter_map(|word| word.t).collect();
            Some([times.first()?[0], times.last()?[1]])
        })
        .collect();
    (0..spans.len())
        .map(|index| {
            let Some([start, end]) = spans[index] else { return [0.0, 0.0] };
            // half way to the words of the sentence before and after, if there are any
            let before = spans[..index].iter().rev().find_map(|span| *span).map_or(f64::MIN, |[_, end]| (end + start) / 2.0);
            let after = spans[index + 1..].iter().find_map(|span| *span).map_or(f64::MAX, |[next, _]| (end + next) / 2.0);
            [round3((start - CUT_PAD).max(before).max(0.0)), round3((end + CUT_PAD).min(after).min(duration))]
        })
        .collect()
}

/// The most of the quiet around a sentence cut from a talk (seconds).
const CUT_PAD: f64 = 0.35;

/// A sentence's take cut from the talk's take `whole`: its words (`range` of the whole take's), placed in the
/// recording from `from` to `to` (seconds), as the whole take scored them.
#[allow(clippy::too_many_arguments)]
fn cut_take(
    store: &Store,
    id: &str,
    sentence: &str,
    whole: &Attempt,
    range: Range<usize>,
    pcm: &audio::Pcm,
    [from, to]: [f64; 2],
    now: &chrono::DateTime<chrono::Local>,
) -> Result<(), String> {
    if to - from < audio::SHORTEST_TAKE {
        return Ok(());
    }
    let rate = pcm.rate as f64;
    let piece = audio::Pcm { samples: pcm.samples[(from * rate) as usize..((to * rate) as usize).min(pcm.samples.len())].to_vec(), rate: pcm.rate };
    let duration = piece.seconds();
    let words: Vec<WordResult> = whole.words[range]
        .iter()
        .cloned()
        .map(|word| WordResult { t: word.t.map(|[start, end]| [round3((start - from).max(0.0)), round3((end - from).min(duration))]), ..word })
        .collect();
    let dir = store.part_dir(id, sentence)?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let take = Store::new_try(&dir, &now.format("%Y%m%d-%H%M%S").to_string())?;
    let file = dir.join(format!("{take}.wav"));
    audio::write_wav(&file, &piece)?;
    let good = words.iter().filter(|word| word.status == WordStatus::Good).count();
    // what was heard of it: each word, or what was heard instead of a word misheard
    let heard: Vec<&str> = words
        .iter()
        .filter_map(|word| if word.status == WordStatus::Wrong { word.heard.as_deref() } else { Some(word.w.as_str()) })
        .filter(|word| !word.is_empty())
        .collect();
    let attempt = Attempt {
        id: take,
        when: whole.when.clone(),
        text: sentence.to_string(),
        heard: heard.join(" "),
        score: (100.0 * good as f64 / words.len().max(1) as f64).round() as i64,
        wpm: (words.len() as f64 / duration * 60.0).round() as i64,
        pauses: text::pauses(&words),
        duration: (duration * 100.0).round() / 100.0,
        audio: file.strip_prefix(&store.data).unwrap_or(&file).to_string_lossy().replace('\\', "/"),
        words,
        cut: Some(whole.id.clone()),
    };
    store.save_attempt(&dir, &attempt)
}

/// What Whisper wrote, without the sounds that aren't words and with single spaces.
pub(crate) fn tidy(heard: &str) -> String {
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
        assert!(dir.parent().unwrap().join(&heard.audio).exists(), "the recording is where it says: {}", heard.audio);
        assert!(!dir.join("texts").exists(), "a talk written down is kept nowhere but talks/");
        talks.discard().unwrap();
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0, "discarding removes the recording");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_talk_is_heard_while_it_is_recorded_and_only_the_rest_once_it_stops() {
        let (talks, dir) = talks("live");
        talks.start(16000).unwrap();
        let listener = Stretches { heard: "well the beautiful things", lengths: RefCell::new(vec![]) };
        let mut news = vec![];
        // 60 s in blocks of two seconds, each heard as it comes in (away from the interface's thread in the app)
        for block in speech(16000, 60.0).chunks(64000) {
            news.extend(talks.feed(block).unwrap());
            if talks.ready() {
                talks.listen(&listener);
            }
        }
        let live = listener.lengths.borrow().len();
        assert!(live >= 3, "{live} stretches heard while recording");
        assert!(listener.lengths.borrow().iter().all(|secs| *secs <= LIVE_STRETCH), "{:?}", listener.lengths.borrow());
        // what was heard comes back with the next block: all of it, but for a stretch heard after the last block
        assert!(news.len() == live || news.len() == live - 1, "{} of {live}", news.len());
        assert!(news.iter().all(|piece| piece == "well the beautiful things"));
        let heard = talks.write_down(&listener, |_, _| {}).unwrap();
        let rest = listener.lengths.borrow().len() - live;
        assert!((1..=2).contains(&rest), "only what came after the last stretch heard: {rest}");
        assert_eq!(heard.words.len(), 4 * (live + rest));
        // the words in order, placed in the cleaned recording
        let starts: Vec<f64> = heard.words.iter().map(|word| word.t.unwrap()[0]).collect();
        assert!(starts.windows(2).all(|pair| pair[0] < pair[1]), "{starts:?}");
        assert!(starts.last().unwrap() < &heard.duration);
        talks.discard().unwrap();
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_stretch_heard_of_a_talk_discarded_meanwhile_is_dropped() {
        let (talks, dir) = talks("live-dropped");
        talks.start(16000).unwrap();
        talks.feed(&speech(16000, 20.0)).unwrap();
        let job = talks.take_stretch().unwrap();
        assert!(talks.take_stretch().is_none(), "one at a time");
        talks.start(16000).unwrap();
        talks.stretch_heard(&job, Ok(("from the talk before".into(), vec![])));
        assert_eq!(talks.feed(&[0, 0]).unwrap(), Vec::<String>::new());
        talks.discard().unwrap();
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_stretch_not_heard_while_recording_is_heard_with_the_rest() {
        let (talks, dir) = talks("live-failed");
        talks.start(16000).unwrap();
        talks.feed(&speech(16000, 40.0)).unwrap();
        let job = talks.take_stretch().unwrap();
        talks.stretch_heard(&job, Err("the speech engine is busy".into()));
        assert!(!talks.ready(), "nothing more is heard while recording");
        talks.feed(&speech(16000, 20.0)).unwrap();
        assert_eq!(talks.current().as_ref().unwrap().live.pending.len(), 0, "nor kept in memory to be heard");
        let listener = Stretches { heard: "hello there", lengths: RefCell::new(vec![]) };
        let heard = talks.write_down(&listener, |_, _| {}).unwrap();
        let heard_in = listener.lengths.borrow();
        assert!(heard_in.iter().sum::<f64>() > 55.0, "all of it, once it stopped: {heard_in:?}");
        assert_eq!(heard.words.len(), 2 * heard_in.len());
        talks.discard().unwrap();
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
    fn a_talk_is_at_most_thirty_minutes() {
        let (talks, dir) = talks("cap");
        talks.start(8000).unwrap();
        let minute = vec![0u8; 8000 * 2 * 60];
        for _ in 0..30 {
            talks.feed(&minute).unwrap();
        }
        talks.feed(&vec![0u8; 8000 * 2 * 4]).unwrap(); // the slack: blocks still on their way at 30:00
        assert!(talks.feed(&vec![0u8; 8000 * 2 * 2]).unwrap_err().contains("at most 30 minutes"));
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
    fn a_talk_kept_is_a_text_with_its_first_take() {
        let (talks, dir) = talks("keep");
        let store = Store { data: dir.parent().unwrap().join(format!("parrot-talks-keep-data-{}", std::process::id())) };
        fs::create_dir_all(store.data.join("texts")).unwrap();
        talks.start(16000).unwrap();
        talks.feed(&speech(16000, 40.0)).unwrap();
        let listener = Stretches { heard: "Muzafar was here, and so were the things.", lengths: RefCell::new(vec![]) };
        assert!(talks.keep(&listener, &store, "anything", None).unwrap_err().contains("write the talk down first"));
        let heard = talks.write_down(&listener, |_, _| {}).unwrap();
        let stretches = listener.lengths.borrow().len();
        assert_eq!(stretches, 2);
        store.set_name("Muzaffar", true).unwrap();
        // what was meant: the name spelt right, "things" was "thinks" in the second stretch, and a word added
        let meant = heard.heard.replacen("Muzafar", "Muzaffar", 1).replacen("things.", "thinks.", 2).replacen("thinks.", "things.", 1) + " Really.";
        let kept = talks.keep(&listener, &store, &meant, Some("Who was here".into())).unwrap();

        let words = &kept.attempt.words;
        assert_eq!(words.len(), meant.split_whitespace().count(), "every word meant is judged");
        assert_eq!(words.iter().map(|word| word.w.as_str()).collect::<Vec<_>>().join(" "), meant);
        // the name is never misheard; "thinks" was heard as "things"; the word added was not heard
        assert_eq!(words[0].status, WordStatus::Good);
        let thinks = words.iter().position(|word| word.w == "thinks.").unwrap();
        assert!(thinks >= 8, "in the second stretch");
        assert_eq!((words[thinks].status, words[thinks].heard.as_deref()), (WordStatus::Wrong, Some("things")));
        assert_eq!((words.last().unwrap().status, words.last().unwrap().heard.as_deref()), (WordStatus::Wrong, Some("")));
        // the second stretch's words are placed in the second stretch
        assert!(words[8].t.unwrap()[0] > listener.lengths.borrow()[0] - 0.5);

        assert_eq!((kept.text.title.as_str(), kept.text.mode.as_str(), kept.text.spoken), ("Who was here", "whole", true));
        assert_eq!(kept.text.scores[&format!("p-{}", store::sha(&meant))].last, kept.attempt.score);
        let saved = store.attempts(&kept.text.id, &meant).unwrap();
        assert_eq!(saved.len(), 1);
        assert!(store.data.join(&kept.attempt.audio).exists(), "the recording moved in with the try");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0, "and out of talks/");
        assert!(talks.keep(&listener, &store, &meant, None).is_err(), "a talk is kept once");

        // each sentence has its first try, cut from the talk
        let sentences: Vec<String> =
            text::sentences(&meant).into_iter().map(|range| meant.split_whitespace().collect::<Vec<_>>()[range].join(" ")).collect();
        assert_eq!(sentences.len(), 3);
        for sentence in &sentences[..2] {
            let tries = store.attempts(&kept.text.id, sentence).unwrap();
            assert_eq!(tries.len(), 1, "{sentence}");
            let cut = store.attempt(&kept.text.id, sentence, &tries[0].id).unwrap();
            assert_eq!((cut.cut.as_deref(), cut.text.as_str()), (Some(kept.attempt.id.as_str()), sentence.as_str()));
            assert_eq!(cut.words.len(), sentence.split_whitespace().count());
            assert!(cut.words.iter().filter_map(|word| word.t).all(|[start, end]| start >= 0.0 && end <= cut.duration), "placed in the cut");
            assert!(cut.duration > 2.0 && cut.duration < kept.attempt.duration / 2.0 + 1.0, "{}", cut.duration);
            assert!(store.data.join(&cut.audio).exists());
        }
        let second = store.attempt(&kept.text.id, &sentences[1], &store.attempts(&kept.text.id, &sentences[1]).unwrap()[0].id).unwrap();
        assert!(second.heard.ends_with("were the things"), "what was heard instead of thinks: {}", second.heard);
        // the word added, which speech recognition missed: its sentence is cut where the aligner placed it, misheard
        let really = store.attempts(&kept.text.id, "Really.").unwrap();
        assert_eq!((really.len(), really[0].score), (1, 0));
        assert_eq!(kept.text.scores.len(), 4, "the whole text and its three sentences");
        assert_eq!(store.activity().tries, 1, "the cuts are no tries of their own");
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(&store.data);
    }

    #[test]
    fn sentences_are_cut_between_their_words() {
        let word = |t: Option<[f64; 2]>| WordResult {
            w: "w".into(),
            t,
            score: None,
            reference: None,
            status: WordStatus::Good,
            heard: None,
            extra: String::new(),
            letters: None,
        };
        let words = vec![word(Some([0.5, 1.0])), word(Some([1.2, 2.0])), word(Some([2.2, 3.0])), word(None), word(Some([5.0, 5.5]))];
        // three sentences: words 0-1, word 2-3 (the last not heard), word 4
        let cut = cuts(&words, &[0..2, 2..4, 4..5], 6.0);
        // at most CUT_PAD into the quiet, and never past half way to the next sentence's words
        assert_eq!(cut, vec![[0.15, 2.1], [2.1, 3.35], [4.65, 5.85]]);
        assert_eq!(cuts(&words, std::slice::from_ref(&(3..4)), 6.0), vec![[0.0, 0.0]], "no word of it heard");
    }

    #[test]
    fn words_meant_go_with_the_stretch_they_were_heard_in() {
        let part = |heard: &str| Written { stretch: 0..1, heard: heard.into(), placed: vec![] };
        let written = vec![part("one two three"), part(""), part("four five")];
        assert_eq!(share_out(&written, "one two three four five"), vec![vec!["one", "two", "three"], vec![], vec!["four", "five"]]);
        // a correction stays put, an addition goes with the word before it, a word dropped takes nothing
        assert_eq!(share_out(&written, "So one, too three, and four"), vec![vec!["So", "one,", "too", "three,", "and"], vec![], vec!["four"]]);
        assert_eq!(share_out(&written, ""), vec![Vec::<&str>::new(); 3]);
    }

    /// Parrot quits (or crashes) without the talk being finished: nothing is cleaned up as it goes.
    fn quit(talks: Talks) {
        std::mem::forget(talks);
    }

    #[test]
    fn a_talk_left_while_recorded_is_taken_up_again() {
        let (talks, dir) = talks("crash");
        talks.start(16000).unwrap();
        assert!(talks.left().is_none(), "a talk being recorded isn't left");
        for block in speech(16000, 30.0).chunks(64000) {
            talks.feed(block).unwrap();
        }
        quit(talks);

        let talks = Talks::open(dir.clone());
        let left = talks.left().unwrap();
        assert_eq!((left.duration, left.heard.is_none()), (30.0, true), "all of it, as of the last block");
        assert!(chrono::NaiveDateTime::parse_from_str(&left.started, "%Y-%m-%dT%H:%M:%S").is_ok(), "{}", left.started);
        let listener = Stretches { heard: "hello there", lengths: RefCell::new(vec![]) };
        let heard = talks.write_down(&listener, |_, _| {}).unwrap();
        assert!(heard.duration > 25.0, "{}", heard.duration);
        talks.discard().unwrap();
        assert!(talks.left().is_none());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_talk_written_down_but_not_kept_comes_back_to_be_checked() {
        let (talks, dir) = talks("unsaved");
        let store = Store { data: dir.parent().unwrap().join(format!("parrot-talks-unsaved-data-{}", std::process::id())) };
        fs::create_dir_all(store.data.join("texts")).unwrap();
        talks.start(16000).unwrap();
        talks.feed(&speech(16000, 40.0)).unwrap();
        let listener = Stretches { heard: "hello there", lengths: RefCell::new(vec![]) };
        let heard = talks.write_down(&listener, |_, _| {}).unwrap();
        quit(talks);

        let talks = Talks::open(dir.clone());
        let left = talks.left().unwrap();
        let again = left.heard.unwrap();
        assert_eq!((again.heard.as_str(), again.score, again.audio.as_str()), (heard.heard.as_str(), heard.score, heard.audio.as_str()));
        assert!((left.duration - heard.duration).abs() < 0.01, "the cleaned recording's length");
        // kept as it is, without hearing it again
        let deaf = Stretches { heard: "nothing like it", lengths: RefCell::new(vec![]) };
        let kept = talks.keep(&deaf, &store, &heard.heard, None).unwrap();
        assert_eq!(kept.attempt.heard, heard.heard);
        assert!(deaf.lengths.borrow().is_empty());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0, "nothing of it left in talks/");
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(&store.data);
    }

    #[test]
    fn only_the_latest_talk_left_is_kept() {
        let dir = std::env::temp_dir().join(format!("parrot-talks-left-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let wav = |name: &str, secs: f64| {
            let spec = hound::WavSpec { channels: 1, sample_rate: 8000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
            let mut writer = hound::WavWriter::create(dir.join(name), spec).unwrap();
            for _ in 0..(secs * 8000.0) as usize {
                writer.write_sample(100i16).unwrap();
            }
            writer.finalize().unwrap();
        };
        wav("20261019-090000.wav", 5.0);
        fs::write(dir.join("20261019-090000.json"), b"{}").unwrap();
        wav("20261020-101010.wav", 3.0);
        fs::write(dir.join("20261020-101010.json"), b"not what was known").unwrap();
        fs::write(dir.join("stray.txt"), b"?").unwrap();
        let talks = Talks::open(dir.clone());
        let left = talks.left().unwrap();
        assert_eq!((left.started.as_str(), left.duration, left.heard.is_none()), ("2026-10-20T10:10:10", 3.0, true));
        let mut kept: Vec<String> = fs::read_dir(&dir).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into()).collect();
        kept.sort();
        assert_eq!(kept, ["20261020-101010.json", "20261020-101010.wav"]);
        drop(talks);

        // a latest talk with nothing in it: everything goes
        fs::write(dir.join("20261021-101010.wav"), b"half a talk").unwrap();
        let talks = Talks::open(dir.clone());
        assert!(talks.left().is_none());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        let _ = fs::remove_dir_all(dir);
    }
}
