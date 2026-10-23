//! Where texts and tries are kept: plain files in the app's data folder, the same layout Parrot's first engine (a
//! Python prototype, since removed) used, so a library made with it opens unchanged.
//!
//! ```text
//! texts/<id>/text.txt          the text (id: the first 10 hex digits of the SHA-1 of its words)
//! texts/<id>/meta.json         title, practise mode, when created and last opened
//! texts/<id>/p-<sha1>/         one folder per part that has been recorded, named after its words
//!     <time>.wav + <time>.json a try: the cleaned recording, and what was heard and scored
//! texts/<id>/w-<sha1>/         one folder per word practised alone, named after it in lower case without the
//!                              punctuation around it; the same kind of tries, kept apart from the parts' scores
//! trash/<id>-<time>/          deleted texts, moved here rather than erased, and erased for good TRASH_DAYS later
//! ```

use crate::text::WordResult;
use chrono::{Local, NaiveDateTime};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub fn norm(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn sha(text: &str) -> String {
    let digest = Sha1::digest(norm(text).as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>()[..10].to_string()
}

/// A word without the punctuation around it ("“there,” -> there"), as it is said alone.
pub fn bare(word: &str) -> &str {
    word.trim_matches(|character: char| ".,;:!?\"“”()".contains(character))
}

/// How long a deleted text stays in the trash before Parrot erases it for good (the confirmation says so).
pub const TRASH_DAYS: i64 = 30;

fn now() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PartScore {
    pub last: i64,
    pub best: i64,
    pub tries: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Attempt {
    pub id: String,
    pub when: String,
    pub text: String,
    pub heard: String,
    pub words: Vec<WordResult>,
    pub duration: f64,
    pub wpm: i64,
    pub score: i64,
    /// the recording, relative to the data folder (first-engine tries say /files/texts/...)
    pub audio: String,
    /// the long pauses: the word each comes after, and how long it is (seconds); tries before 0.4 have none
    #[serde(default)]
    pub pauses: Vec<(usize, f64)>,
    /// a sentence's take cut from a talk: the id of the talk's take (whole text) it was cut from
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cut: Option<String>,
}

/// A text as the library shows it.
#[derive(Serialize, Debug)]
pub struct TextItem {
    pub id: String,
    pub title: String,
    pub text: String,
    pub words: usize,
    pub created: String,
    pub opened: Option<String>,
    pub mode: String,
    /// parts recorded at least once, and their average latest score
    pub practised: usize,
    pub average: Option<i64>,
    pub scores: BTreeMap<String, PartScore>,
    /// the text began as a talk: what was said, written down
    pub spoken: bool,
}

/// A try in the list of a part's tries.
#[derive(Serialize, Debug)]
pub struct AttemptSummary {
    pub id: String,
    pub when: String,
    pub score: i64,
    pub wpm: i64,
    pub duration: f64,
}

#[derive(Serialize, Debug)]
pub struct DayTries {
    pub date: String,
    pub tries: usize,
}

#[derive(Serialize, Debug)]
pub struct Activity {
    pub days: Vec<DayTries>,
    pub tries: i64,
    pub average: Option<i64>,
}

/// Write a file whole or not at all: to <file>.tmp first, then renamed over it, so a crash or power cut midway leaves
/// the old file (a half-written meta.json would lose the title and mode, a half-written try would vanish).
pub(crate) fn write_whole(path: &Path, contents: &[u8]) -> Result<(), String> {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".tmp");
    let temporary = PathBuf::from(temporary);
    let written = fs::File::create(&temporary).and_then(|mut file| {
        file.write_all(contents)?;
        file.sync_all()
    });
    written.and_then(|()| fs::rename(&temporary, path)).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error.to_string()
    })
}

fn rounded_mean(total: i64, count: usize) -> Option<i64> {
    (count > 0).then(|| (total as f64 / count as f64).round() as i64)
}

pub struct Store {
    pub data: PathBuf,
}

impl Store {
    fn texts(&self) -> PathBuf {
        self.data.join("texts")
    }

    pub(crate) fn text_dir(&self, id: &str) -> Result<PathBuf, String> {
        if id.len() != 10 || !id.chars().all(|character| character.is_ascii_hexdigit()) {
            return Err("bad text id".into());
        }
        let dir = self.texts().join(id);
        if dir.join("text.txt").exists() { Ok(dir) } else { Err(format!("not found: {id}")) }
    }

    /// The folder of one part of a text, checked to really be in the text.
    pub fn part_dir(&self, id: &str, part: &str) -> Result<PathBuf, String> {
        let dir = self.text_dir(id)?;
        let full = fs::read_to_string(dir.join("text.txt")).map_err(|error| error.to_string())?;
        if part.trim().is_empty() || !norm(&full).contains(&norm(part)) {
            return Err("that part is not in the text; reload".into());
        }
        Ok(dir.join(format!("p-{}", sha(part))))
    }

    /// A recording in the data folder, by its path as a try or a talk gives it (texts/.../<try>.wav, talks/<stamp>.wav;
    /// the first engine's tries say /files/texts/...): never anything outside the folder, nor anything but a WAV.
    pub fn recording(&self, path: &str) -> Result<PathBuf, String> {
        let relative = path.trim_start_matches('/').trim_start_matches("files/");
        let safe = Path::new(relative).components().all(|part| matches!(part, std::path::Component::Normal(_)));
        let file = self.data.join(relative);
        if !safe || !relative.ends_with(".wav") || !file.is_file() {
            return Err(format!("no recording at {path}"));
        }
        Ok(file)
    }

    /// The folder of one word's tries said alone, checked to really be a word of the text; every place the word is
    /// in the text ("The", "the,") shares it.
    pub fn word_dir(&self, id: &str, word: &str) -> Result<PathBuf, String> {
        let dir = self.text_dir(id)?;
        let full = fs::read_to_string(dir.join("text.txt")).map_err(|error| error.to_string())?;
        let word = bare(word.trim()).to_lowercase();
        if word.is_empty() || !full.split_whitespace().any(|each| bare(each).to_lowercase() == word) {
            return Err("that word is not in the text; reload".into());
        }
        Ok(dir.join(format!("w-{}", sha(&word))))
    }

    fn meta(dir: &Path) -> serde_json::Map<String, Value> {
        fs::read_to_string(dir.join("meta.json"))
            .ok()
            .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default()
    }

    fn save_meta(dir: &Path, change: &[(&str, Option<Value>)]) -> Result<(), String> {
        let mut meta = Self::meta(dir);
        for (key, value) in change {
            if let Some(value) = value {
                meta.insert(key.to_string(), value.clone());
            }
        }
        write_whole(&dir.join("meta.json"), serde_json::to_string_pretty(&meta).unwrap().as_bytes())
    }

    pub(crate) fn read_attempts(dir: &Path) -> Vec<Attempt> {
        let mut files: Vec<PathBuf> = fs::read_dir(dir)
            .map(|entries| {
                entries
                    .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                    .filter(|path| path.extension().is_some_and(|extension| extension == "json"))
                    .collect()
            })
            .unwrap_or_default();
        files.sort_by_key(|path| try_order(path));
        files.iter().filter_map(|path| fs::read_to_string(path).ok().and_then(|contents| serde_json::from_str(&contents).ok())).collect()
    }

    pub fn scores(&self, id: &str) -> Result<BTreeMap<String, PartScore>, String> {
        let dir = self.text_dir(id)?;
        let mut out = BTreeMap::new();
        for entry in fs::read_dir(&dir).map_err(|error| error.to_string())?.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with("p-") || !entry.path().is_dir() {
                continue;
            }
            let tries = Self::read_attempts(&entry.path());
            if let Some(last) = tries.last() {
                let best = tries.iter().map(|attempt| attempt.score).max().unwrap_or(0);
                out.insert(name, PartScore { last: last.score, best, tries: tries.len() });
            }
        }
        Ok(out)
    }

    fn text_info(&self, dir: &Path) -> TextItem {
        let id = dir.file_name().unwrap().to_string_lossy().to_string();
        let body = fs::read_to_string(dir.join("text.txt")).unwrap_or_default();
        let meta = Self::meta(dir);
        let scores = self.scores(&id).unwrap_or_default();
        let last: Vec<i64> = scores.values().map(|part| part.last).collect();
        let created = meta.get("created").and_then(Value::as_str).map(String::from).unwrap_or_else(|| {
            fs::metadata(dir.join("text.txt"))
                .and_then(|metadata| metadata.modified())
                .map(|modified| chrono::DateTime::<Local>::from(modified).format("%Y-%m-%dT%H:%M:%S").to_string())
                .unwrap_or_else(|_| now())
        });
        let title = meta
            .get("title")
            .and_then(Value::as_str)
            .filter(|title| !title.is_empty())
            .map(String::from)
            .unwrap_or_else(|| format!("{}…", body.split_whitespace().take(6).collect::<Vec<_>>().join(" ")));
        TextItem {
            id,
            title,
            words: body.split_whitespace().count(),
            text: body,
            created,
            opened: meta.get("opened").and_then(Value::as_str).map(String::from),
            mode: meta.get("mode").and_then(Value::as_str).unwrap_or("sentences").to_string(),
            spoken: meta.get("spoken").and_then(Value::as_bool).unwrap_or(false),
            practised: last.len(),
            average: rounded_mean(last.iter().sum(), last.len()),
            scores,
        }
    }

    pub fn list(&self) -> Vec<TextItem> {
        let mut out: Vec<TextItem> = fs::read_dir(self.texts())
            .map(|entries| {
                entries.flatten().map(|entry| entry.path()).filter(|path| path.join("text.txt").exists()).map(|path| self.text_info(&path)).collect()
            })
            .unwrap_or_default();
        out.sort_by(|left, right| right.opened.as_ref().unwrap_or(&right.created).cmp(left.opened.as_ref().unwrap_or(&left.created)));
        out
    }

    pub fn add(&self, text: &str, title: Option<String>, mode: Option<String>) -> Result<TextItem, String> {
        let body = norm(text);
        if body.is_empty() {
            return Err("the text is empty".into());
        }
        let dir = self.texts().join(sha(&body));
        // a text added again is the one already here, as it is now: its words may have been fixed since, and its
        // title and the way it is practised chosen
        if dir.join("text.txt").is_file() {
            return Ok(self.text_info(&dir));
        }
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        write_whole(&dir.join("text.txt"), body.as_bytes())?;
        let created = if dir.join("meta.json").exists() { None } else { Some(json!(now())) };
        let title = title.map(|title| title.trim().to_string()).filter(|title| !title.is_empty()).map(Value::from);
        Self::save_meta(&dir, &[("title", title), ("mode", mode.map(Value::from)), ("created", created)])?;
        Ok(self.text_info(&dir))
    }

    pub fn update(&self, id: &str, title: Option<String>, mode: Option<String>, opened: bool) -> Result<TextItem, String> {
        let dir = self.text_dir(id)?;
        let title = title.map(|title| title.trim().to_string()).filter(|title| !title.is_empty()).map(Value::from);
        let opened = if opened { Some(json!(now())) } else { None };
        Self::save_meta(&dir, &[("title", title), ("mode", mode.map(Value::from)), ("opened", opened)])?;
        Ok(self.text_info(&dir))
    }

    /// The words never counted as misheard, in every text (text::name_key), sorted.
    pub fn names(&self) -> Vec<String> {
        fs::read_to_string(self.data.join("names.json")).ok().and_then(|contents| serde_json::from_str(&contents).ok()).unwrap_or_default()
    }

    /// Mark a word as a name or not; the names after.
    pub fn set_name(&self, word: &str, name: bool) -> Result<Vec<String>, String> {
        let key = crate::text::name_key(word);
        if key.is_empty() || key.chars().count() > 40 || key.chars().any(char::is_whitespace) {
            return Err(format!("“{word}” can't be a name"));
        }
        let mut names = self.names();
        names.retain(|kept| *kept != key);
        if name {
            names.push(key);
            names.sort();
        }
        write_whole(&self.data.join("names.json"), serde_json::to_string_pretty(&names).unwrap().as_bytes())?;
        Ok(names)
    }

    /// One text as the library shows it.
    pub fn text(&self, id: &str) -> Result<TextItem, String> {
        Ok(self.text_info(&self.text_dir(id)?))
    }

    /// Mark a text as one that began as a talk.
    pub fn set_spoken(&self, id: &str) -> Result<(), String> {
        Self::save_meta(&self.text_dir(id)?, &[("spoken", Some(json!(true)))])
    }

    /// Moved to the trash folder, not deleted.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let dir = self.text_dir(id)?;
        let trash = self.trash();
        fs::create_dir_all(&trash).map_err(|error| error.to_string())?;
        fs::rename(&dir, trash.join(format!("{id}-{}", Local::now().format("%Y%m%d-%H%M%S")))).map_err(|error| error.to_string())
    }

    fn trash(&self) -> PathBuf {
        self.data.join("trash")
    }

    /// Erase for good what was put in the trash more than TRASH_DAYS before `now`: when it was deleted is in its
    /// name (<id>-<time>), else it is when it last changed; something with neither is kept.
    pub fn expire_trash(&self, now: NaiveDateTime) {
        let oldest = now - chrono::Duration::days(TRASH_DAYS);
        self.clear_trash(|entry| deleted_at(entry).is_some_and(|when| when < oldest));
    }

    /// Erase everything in the trash; what is left (nothing, unless something could not be removed), in bytes.
    pub fn empty_trash(&self) -> u64 {
        self.clear_trash(|_| true);
        self.trash_size()
    }

    /// How much the trash holds, in bytes.
    pub fn trash_size(&self) -> u64 {
        if self.trash_folder().is_some() { size_of(&self.trash()) } else { 0 }
    }

    /// The trash folder, if it is a real folder: one that is a link would lead out of the data folder.
    fn trash_folder(&self) -> Option<PathBuf> {
        let trash = self.trash();
        fs::symlink_metadata(&trash).is_ok_and(|metadata| metadata.is_dir()).then_some(trash)
    }

    /// Remove the entries of the trash `erase` picks, and nothing outside it: a link in it is removed as a link, never
    /// followed (remove_dir_all doesn't follow links either).
    fn clear_trash(&self, erase: impl Fn(&fs::DirEntry) -> bool) {
        let Some(trash) = self.trash_folder() else { return };
        for entry in fs::read_dir(&trash).into_iter().flatten().flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            if !erase(&entry) {
                continue;
            }
            let path = entry.path();
            let removed = if kind.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
            if let Err(error) = removed {
                log::warn!("could not erase {} from the trash: {error}", path.display());
            }
        }
    }

    pub fn attempts(&self, id: &str, part: &str) -> Result<Vec<AttemptSummary>, String> {
        Ok(Self::summaries(&self.part_dir(id, part)?))
    }

    pub fn attempt(&self, id: &str, part: &str, attempt: &str) -> Result<Attempt, String> {
        Self::read_attempt(&self.part_dir(id, part)?, attempt)
    }

    /// The tries of one word said alone, newest first.
    pub fn word_attempts(&self, id: &str, word: &str) -> Result<Vec<AttemptSummary>, String> {
        Ok(Self::summaries(&self.word_dir(id, word)?))
    }

    pub fn word_attempt(&self, id: &str, word: &str, attempt: &str) -> Result<Attempt, String> {
        Self::read_attempt(&self.word_dir(id, word)?, attempt)
    }

    /// The tries in a folder, newest first.
    fn summaries(dir: &Path) -> Vec<AttemptSummary> {
        let mut tries = Self::read_attempts(dir);
        tries.reverse();
        tries
            .into_iter()
            .map(|attempt| AttemptSummary { id: attempt.id, when: attempt.when, score: attempt.score, wpm: attempt.wpm, duration: attempt.duration })
            .collect()
    }

    /// Delete one try of a part: its recording and its result. The part's scores are counted from the tries left.
    pub fn delete_attempt(&self, id: &str, part: &str, attempt: &str) -> Result<(), String> {
        Self::remove_attempt(&self.part_dir(id, part)?, attempt)
    }

    /// Delete one try of a word said alone.
    pub fn delete_word_attempt(&self, id: &str, word: &str, attempt: &str) -> Result<(), String> {
        Self::remove_attempt(&self.word_dir(id, word)?, attempt)
    }

    fn remove_attempt(dir: &Path, attempt: &str) -> Result<(), String> {
        // a try's id is its time stamp: anything else could name a file elsewhere
        if attempt.is_empty() || !attempt.chars().all(|character| character.is_ascii_digit() || character == '-') {
            return Err("bad try id".into());
        }
        let result = dir.join(format!("{attempt}.json"));
        if !result.is_file() {
            return Err(format!("not found: {attempt}"));
        }
        // the result first: without it the try is gone from every list, even if its recording stayed behind
        fs::remove_file(&result).map_err(|error| error.to_string())?;
        match fs::remove_file(dir.join(format!("{attempt}.wav"))) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
            _ => Ok(()),
        }
    }

    fn read_attempt(dir: &Path, attempt: &str) -> Result<Attempt, String> {
        let name: String = attempt.chars().filter(|character| character.is_ascii_digit() || *character == '-').collect();
        let path = dir.join(format!("{name}.json"));
        serde_json::from_str(&fs::read_to_string(&path).map_err(|_| format!("not found: {name}"))?).map_err(|error| error.to_string())
    }

    /// Claim the id of a new try in `dir` by creating its empty <id>.wav: the time stamp, or the stamp with -2, -3...
    /// when a try already has it (a second Parrot, the folder synced from another machine, the clock turned back).
    pub fn new_try(dir: &Path, stamp: &str) -> Result<String, String> {
        for count in 1.. {
            let id = if count == 1 { stamp.to_string() } else { format!("{stamp}-{count}") };
            if dir.join(format!("{id}.json")).exists() {
                continue;
            }
            match fs::OpenOptions::new().write(true).create_new(true).open(dir.join(format!("{id}.wav"))) {
                Ok(_) => return Ok(id),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
        unreachable!("the counter runs out before the folder does")
    }

    pub fn save_attempt(&self, dir: &Path, attempt: &Attempt) -> Result<(), String> {
        write_whole(&dir.join(format!("{}.json", attempt.id)), serde_json::to_string_pretty(attempt).unwrap().as_bytes())
    }

    /// Tries per day for the last 7 days (today last), and their average score.
    pub fn activity(&self) -> Activity {
        let today = Local::now().date_naive();
        let mut days: BTreeMap<chrono::NaiveDate, usize> = (0..7).map(|days_ago| (today - chrono::Duration::days(days_ago), 0)).collect();
        let (mut total, mut scored) = (0i64, 0usize);
        if let Ok(texts) = fs::read_dir(self.texts()) {
            // a folder without its text is no text of the library (list() leaves it out too)
            for text in texts.flatten().filter(|text| text.path().join("text.txt").exists()) {
                let parts = fs::read_dir(text.path()).into_iter().flatten().flatten();
                for part in parts.filter(|part| part.file_name().to_string_lossy().starts_with("p-")) {
                    for file in fs::read_dir(part.path()).into_iter().flatten().flatten() {
                        let name = file.file_name().to_string_lossy().to_string();
                        // a try's name starts with its day (20261020-...); any other file in the folder is skipped
                        let stamp = name.get(..8).filter(|stamp| name.ends_with(".json") && stamp.bytes().all(|byte| byte.is_ascii_digit()));
                        let Some(Ok(day)) = stamp.map(|stamp| chrono::NaiveDate::parse_from_str(stamp, "%Y%m%d")) else { continue };
                        if let Some(tries) = days.get_mut(&day) {
                            let attempt = fs::read_to_string(file.path()).ok().and_then(|contents| serde_json::from_str::<Attempt>(&contents).ok());
                            // a sentence cut from a talk is no try of its own: the talk's take counts
                            if attempt.as_ref().is_some_and(|attempt| attempt.cut.is_some()) {
                                continue;
                            }
                            *tries += 1;
                            if let Some(attempt) = attempt {
                                total += attempt.score;
                                scored += 1;
                            }
                        }
                    }
                }
            }
        }
        Activity {
            days: days.into_iter().map(|(date, tries)| DayTries { date: date.format("%Y-%m-%d").to_string(), tries }).collect(),
            tries: scored as i64,
            average: rounded_mean(total, scored),
        }
    }
}

/// Where a try's file goes among the others, oldest first: by its time stamp, then by the -2, -3... a try made in
/// the same second got (plain name order would put "...-2" before the first and "...-10" before "...-2").
fn try_order(path: &Path) -> (String, u32) {
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    match stem.rsplit_once('-') {
        // the stamp itself has one dash (20261020-153000)
        Some((stamp, count)) if stamp.contains('-') => (stamp.to_string(), count.parse().unwrap_or(u32::MAX)),
        _ => (stem.to_string(), 1),
    }
}

/// When an entry of the trash was deleted: the time in its name (<id>-<YYYYMMDD-HHMMSS>), else when it last changed.
fn deleted_at(entry: &fs::DirEntry) -> Option<NaiveDateTime> {
    let name = entry.file_name();
    let name = name.to_string_lossy();
    let stamp = name.len().checked_sub(15).and_then(|start| name.get(start..));
    stamp.and_then(|stamp| NaiveDateTime::parse_from_str(stamp, "%Y%m%d-%H%M%S").ok()).or_else(|| {
        // the entry's own time, a link's included: DirEntry::metadata doesn't follow links
        let modified = entry.metadata().and_then(|metadata| metadata.modified()).ok()?;
        Some(chrono::DateTime::<Local>::from(modified).naive_local())
    })
}

/// The bytes in a file, or in a folder and everything in it; links count as themselves, not what they lead to.
fn size_of(path: &Path) -> u64 {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => fs::read_dir(path).into_iter().flatten().flatten().map(|entry| size_of(&entry.path())).sum(),
        Ok(metadata) => metadata.len(),
        Err(_) => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recording_is_found_only_in_the_data_folder() {
        let dir = std::env::temp_dir().join(format!("parrot-recording-{}", std::process::id()));
        fs::create_dir_all(dir.join("texts/abc/p-1")).unwrap();
        fs::write(dir.join("texts/abc/p-1/20261020-101010.wav"), b"RIFF").unwrap();
        fs::write(dir.join("texts/abc/p-1/20261020-101010.json"), b"{}").unwrap();
        let store = Store { data: dir.clone() };
        let found = dir.join("texts/abc/p-1/20261020-101010.wav");
        assert_eq!(store.recording("texts/abc/p-1/20261020-101010.wav").unwrap(), found);
        assert_eq!(store.recording("/files/texts/abc/p-1/20261020-101010.wav").unwrap(), found, "the first engine's paths");
        for bad in ["texts/abc/p-1/20261020-101010.json", "texts/abc/../abc/p-1/20261020-101010.wav", "../secret.wav", "texts/abc/p-1/none.wav", ""] {
            assert!(store.recording(bad).is_err(), "{bad}");
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn ids_match_the_python_engine() {
        // the same text ids the Python engine gave (sha1 of the normalised words), so its library opens unchanged
        assert_eq!(sha("Hello   there."), "95e3ac5665");
        assert_eq!(sha("I'm a front-end engineer with a bit over ten years"), "091ec5749e");
        assert_eq!(sha("I'm a front-end engineer").len(), 10);
    }

    #[test]
    fn texts_round_trip() {
        let dir = std::env::temp_dir().join(format!("parrot-store-{}", std::process::id()));
        let store = Store { data: dir.clone() };
        let added = store.add("Hello there. How are you?", Some("Greeting".into()), Some("sentences".into())).unwrap();
        let id = added.id;
        assert_eq!(store.list().len(), 1);
        assert!(store.part_dir(&id, "How are you?").is_ok());
        assert!(store.part_dir(&id, "Something else").is_err());
        assert_eq!(store.update(&id, Some("Hi".into()), None, true).unwrap().title, "Hi");
        store.delete(&id).unwrap();
        assert!(store.list().is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_text_added_again_is_the_one_already_there_as_it_is_now() {
        let dir = std::env::temp_dir().join(format!("parrot-store-again-{}", std::process::id()));
        let store = Store { data: dir.clone() };
        let id = store.add("Hello there. How are you?", Some("Greeting".into()), Some("sentences".into())).unwrap().id;
        // its words fixed, as editing does: the folder keeps the id of the words it was added with
        write_whole(&store.text_dir(&id).unwrap().join("text.txt"), b"Hello there. How were you?").unwrap();
        store.update(&id, None, Some("whole".into()), false).unwrap();
        let again = store.add("Hello  there. How are you?", Some("Another title".into()), Some("sentences".into())).unwrap();
        assert_eq!(
            (again.id.as_str(), again.text.as_str(), again.title.as_str(), again.mode.as_str()),
            (id.as_str(), "Hello there. How were you?", "Greeting", "whole")
        );
        assert_eq!(store.list().len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn names_are_kept_for_every_text() {
        let dir = std::env::temp_dir().join(format!("parrot-names-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let store = Store { data: dir.clone() };
        assert!(store.names().is_empty());
        assert_eq!(store.set_name("Tashkent,", true).unwrap(), vec!["tashkent"]);
        assert_eq!(store.set_name("“Muzaffar’s”", true).unwrap(), vec!["muzaffar", "tashkent"]);
        assert_eq!(store.set_name("muzaffar", true).unwrap(), vec!["muzaffar", "tashkent"], "marked once");
        assert_eq!(store.set_name("Tashkent", false).unwrap(), vec!["muzaffar"]);
        assert_eq!(store.names(), vec!["muzaffar"], "saved");
        assert!(store.set_name("...", true).is_err());
        assert!(store.set_name("New York", true).is_err(), "one word at a time");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_word_has_one_folder_wherever_it_is_in_the_text() {
        let dir = std::env::temp_dir().join(format!("parrot-word-dir-{}", std::process::id()));
        let store = Store { data: dir.clone() };
        let id = store.add("“There” it is. Is it there?", None, None).unwrap().id;
        let there = store.word_dir(&id, "there?").unwrap();
        assert!(there.file_name().unwrap().to_string_lossy().starts_with("w-"));
        assert_eq!(store.word_dir(&id, "“There”").unwrap(), there);
        assert_eq!(store.word_dir(&id, "THERE").unwrap(), there);
        assert_ne!(store.word_dir(&id, "it").unwrap(), there);
        for missing in ["here", "it is", "", "?", "the"] {
            assert!(store.word_dir(&id, missing).is_err(), "{missing:?} is not a word of the text");
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn word_tries_never_count_toward_the_text() {
        let dir = std::env::temp_dir().join(format!("parrot-word-tries-{}", std::process::id()));
        let store = Store { data: dir.clone() };
        let id = store.add("Hello there. How are you?", None, None).unwrap().id;
        // named like real tries, today, so the week's activity would count them if it looked
        let take = Local::now().format("%Y%m%d-%H%M%S").to_string();
        let attempt = |text: &str, score: i64| Attempt {
            id: take.clone(),
            when: now(),
            text: text.into(),
            heard: text.into(),
            words: vec![],
            duration: 1.0,
            wpm: 60,
            score,
            audio: String::new(),
            pauses: vec![],
            cut: None,
        };
        let word = store.word_dir(&id, "there.").unwrap();
        fs::create_dir_all(&word).unwrap();
        store.save_attempt(&word, &attempt("there", 40)).unwrap();
        assert_eq!(store.word_attempts(&id, "There").unwrap().iter().map(|summary| summary.score).collect::<Vec<_>>(), vec![40]);
        assert_eq!(store.word_attempt(&id, "there", &take).unwrap().text, "there");
        assert!(store.scores(&id).unwrap().is_empty());
        let text = store.list().remove(0);
        assert_eq!((text.practised, text.average), (0, None));
        let activity = store.activity();
        assert_eq!((activity.tries, activity.average), (0, None));
        assert!(activity.days.iter().all(|day| day.tries == 0));
        // a part's try beside it still counts, alone
        let part = store.part_dir(&id, "How are you?").unwrap();
        fs::create_dir_all(&part).unwrap();
        store.save_attempt(&part, &attempt("How are you?", 80)).unwrap();
        assert_eq!(store.scores(&id).unwrap().values().map(|score| (score.last, score.tries)).collect::<Vec<_>>(), vec![(80, 1)]);
        let text = store.list().remove(0);
        assert_eq!((text.practised, text.average), (1, Some(80)));
        let activity = store.activity();
        assert_eq!((activity.tries, activity.average, activity.days[6].tries), (1, Some(80), 1));
        assert_eq!(store.attempts(&id, "How are you?").unwrap().len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    /// A try saved in `dir` the way the engine saves one: its result and its recording.
    fn save_try(store: &Store, dir: &Path, id: &str, text: &str, score: i64) {
        fs::create_dir_all(dir).unwrap();
        let attempt = Attempt {
            id: id.into(),
            when: now(),
            text: text.into(),
            heard: text.into(),
            words: vec![],
            duration: 1.0,
            wpm: 60,
            score,
            audio: String::new(),
            pauses: vec![],
            cut: None,
        };
        store.save_attempt(dir, &attempt).unwrap();
        fs::write(dir.join(format!("{id}.wav")), "RIFF").unwrap();
    }

    #[test]
    fn a_try_is_deleted_with_its_recording_and_the_scores_follow() {
        let dir = std::env::temp_dir().join(format!("parrot-delete-try-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let store = Store { data: dir.clone() };
        let id = store.add("Hello there. How are you?", None, None).unwrap().id;
        let part = store.part_dir(&id, "How are you?").unwrap();
        save_try(&store, &part, "20261001-120000", "How are you?", 90);
        save_try(&store, &part, "20261002-120000", "How are you?", 40);
        let scores = |store: &Store| store.scores(&id).unwrap().values().map(|score| (score.last, score.best, score.tries)).collect::<Vec<_>>();
        assert_eq!(scores(&store), vec![(40, 90, 2)]);
        // an id that is not a time stamp names no try, wherever it would lead
        fs::write(dir.join("texts/keep.json"), "{}").unwrap();
        for bad in ["", "../../keep", "20261002-120000.json", "*", "20261002-12000a"] {
            assert_eq!(store.delete_attempt(&id, "How are you?", bad), Err("bad try id".into()), "{bad:?}");
        }
        assert!(dir.join("texts/keep.json").exists());
        assert!(store.delete_attempt(&id, "How are you?", "20260101-000000").unwrap_err().starts_with("not found"));
        assert!(store.delete_attempt(&id, "Not in it", "20261002-120000").is_err());
        store.delete_attempt(&id, "How are you?", "20261002-120000").unwrap();
        assert!(!part.join("20261002-120000.json").exists() && !part.join("20261002-120000.wav").exists());
        assert_eq!(scores(&store), vec![(90, 90, 1)]);
        assert_eq!(store.attempts(&id, "How are you?").unwrap().iter().map(|summary| summary.id.as_str()).collect::<Vec<_>>(), ["20261001-120000"]);
        // a try whose recording is already gone still goes
        fs::remove_file(part.join("20261001-120000.wav")).unwrap();
        store.delete_attempt(&id, "How are you?", "20261001-120000").unwrap();
        assert!(store.scores(&id).unwrap().is_empty());
        assert_eq!(store.list()[0].practised, 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_word_try_is_deleted_from_the_words_folder() {
        let dir = std::env::temp_dir().join(format!("parrot-delete-word-try-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let store = Store { data: dir.clone() };
        let id = store.add("Hello there.", None, None).unwrap().id;
        let word = store.word_dir(&id, "there.").unwrap();
        save_try(&store, &word, "20261001-120000", "there", 70);
        save_try(&store, &word, "20261002-120000", "there", 80);
        assert_eq!(store.delete_word_attempt(&id, "there", "../20261001-120000"), Err("bad try id".into()));
        store.delete_word_attempt(&id, "There", "20261002-120000").unwrap();
        assert_eq!(store.word_attempts(&id, "there").unwrap().iter().map(|summary| summary.score).collect::<Vec<_>>(), vec![70]);
        assert!(!word.join("20261002-120000.wav").exists());
        assert!(store.delete_word_attempt(&id, "elsewhere", "20261001-120000").is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_trash_is_emptied_of_what_was_deleted_long_enough_ago() {
        let root = std::env::temp_dir().join(format!("parrot-trash-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (data, outside) = (root.join("data"), root.join("outside"));
        let store = Store { data: data.clone() };
        let now = Local::now().naive_local();
        let stamp = |days_ago: i64| (now - chrono::Duration::days(days_ago)).format("%Y%m%d-%H%M%S").to_string();
        let trash = data.join("trash");
        // deleted 31 and 29 days ago, by the time in their names
        let old = trash.join(format!("95e3ac5665-{}", stamp(31)));
        let recent = trash.join(format!("091ec5749e-{}", stamp(29)));
        for dir in [&old, &recent] {
            fs::create_dir_all(dir.join("p-1")).unwrap();
            fs::write(dir.join("p-1/take.wav"), "RIFF").unwrap();
        }
        // no time in the name: by when it last changed
        let unnamed_new = trash.join("leftover");
        fs::create_dir_all(&unnamed_new).unwrap();
        let unnamed_old = trash.join("leftover.txt");
        fs::write(&unnamed_old, "old").unwrap();
        let forty_days = std::time::Duration::from_secs(40 * 86400);
        fs::File::options().write(true).open(&unnamed_old).unwrap().set_modified(std::time::SystemTime::now() - forty_days).unwrap();
        // a link to a folder outside, named as if long deleted: the link goes, never what it leads to
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("precious.txt"), "mine").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, trash.join(format!("abcdef0123-{}", stamp(60)))).unwrap();
        let text = store.add("Hello there.", None, None).unwrap().id;

        store.expire_trash(now);
        assert!(!old.exists() && !unnamed_old.exists());
        assert!(recent.join("p-1/take.wav").exists() && unnamed_new.exists());
        assert!(!trash.join(format!("abcdef0123-{}", stamp(60))).exists());
        assert!(outside.join("precious.txt").exists());
        assert!(store.text_dir(&text).is_ok(), "texts are not in the trash");
        assert_eq!(store.trash_size(), 4);
        // a second run finds nothing more to erase
        store.expire_trash(now);
        assert!(recent.exists());

        assert_eq!(store.empty_trash(), 0);
        assert_eq!(fs::read_dir(&trash).unwrap().count(), 0);
        assert!(outside.join("precious.txt").exists() && store.text_dir(&text).is_ok());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn a_trash_folder_that_is_a_link_is_left_alone() {
        let root = std::env::temp_dir().join(format!("parrot-trash-link-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (data, outside) = (root.join("data"), root.join("outside"));
        let entry = outside.join("95e3ac5665-20200101-120000");
        fs::create_dir_all(&entry).unwrap();
        fs::create_dir_all(&data).unwrap();
        std::os::unix::fs::symlink(&outside, data.join("trash")).unwrap();
        let store = Store { data };
        store.expire_trash(Local::now().naive_local());
        assert_eq!((store.empty_trash(), store.trash_size()), (0, 0));
        assert!(entry.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn no_trash_is_an_empty_one() {
        let store = Store { data: std::env::temp_dir().join(format!("parrot-no-trash-{}", std::process::id())) };
        store.expire_trash(Local::now().naive_local());
        assert_eq!((store.trash_size(), store.empty_trash()), (0, 0));
        assert!(!store.data.exists());
    }

    #[test]
    fn a_stray_file_name_does_not_break_the_activity() {
        let dir = std::env::temp_dir().join(format!("parrot-stray-name-{}", std::process::id()));
        let store = Store { data: dir.clone() };
        let id = store.add("Hello there.", None, None).unwrap().id;
        let part = store.part_dir(&id, "Hello there.").unwrap();
        fs::create_dir_all(&part).unwrap();
        // a character of two bytes across the 8th byte
        fs::write(part.join("aééééx.json"), "{}").unwrap();
        let activity = store.activity();
        assert_eq!((activity.tries, activity.days.iter().map(|day| day.tries).sum::<usize>()), (0, 0));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn files_are_replaced_whole() {
        let dir = std::env::temp_dir().join(format!("parrot-write-whole-{}", std::process::id()));
        let store = Store { data: dir.clone() };
        let id = store.add("Hello there.", Some("Greeting".into()), None).unwrap().id;
        let text = dir.join("texts").join(&id);
        store.update(&id, Some("Hi".into()), None, true).unwrap();
        assert_eq!(Store::meta(&text)["title"], "Hi");
        let names: Vec<String> = fs::read_dir(&text).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
        assert!(names.iter().all(|name| !name.ends_with(".tmp")), "{names:?}");
        // a .tmp a crash left behind is no try and no part of the text
        let part = store.part_dir(&id, "Hello there.").unwrap();
        fs::create_dir_all(&part).unwrap();
        fs::write(part.join("20261020-153000.json.tmp"), "{").unwrap();
        assert!(store.attempts(&id, "Hello there.").unwrap().is_empty());
        assert_eq!(store.activity().tries, 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn tries_in_the_same_second_keep_apart_and_in_order() {
        let dir = std::env::temp_dir().join(format!("parrot-same-second-{}", std::process::id()));
        let store = Store { data: dir.clone() };
        let id = store.add("Hello there.", None, None).unwrap().id;
        let part = store.part_dir(&id, "Hello there.").unwrap();
        fs::create_dir_all(&part).unwrap();
        let stamp = "20261020-153000";
        for score in 1..=11 {
            let take = Store::new_try(&part, stamp).unwrap();
            let attempt = Attempt {
                id: take,
                when: "2026-10-20T15:30:00".into(),
                text: "Hello there.".into(),
                heard: String::new(),
                words: vec![],
                duration: 1.0,
                wpm: 60,
                score,
                audio: String::new(),
                pauses: vec![],
                cut: None,
            };
            store.save_attempt(&part, &attempt).unwrap();
        }
        let tries = store.attempts(&id, "Hello there.").unwrap();
        // newest first, none lost
        assert_eq!(tries.iter().map(|summary| summary.score).collect::<Vec<_>>(), (1..=11).rev().collect::<Vec<_>>());
        assert_eq!((tries[0].id.as_str(), tries[9].id.as_str(), tries[10].id.as_str()), ("20261020-153000-11", "20261020-153000-2", stamp));
        assert_eq!(store.scores(&id).unwrap().values().next().unwrap().last, 11);
        assert_eq!(store.attempt(&id, "Hello there.", "20261020-153000-2").unwrap().score, 2);
        // a try whose recording is gone still holds on to its id
        fs::write(part.join("20261020-160000.json"), "{}").unwrap();
        assert_eq!(Store::new_try(&part, "20261020-160000").unwrap(), "20261020-160000-2");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_folder_left_without_its_text_has_no_activity() {
        let dir = std::env::temp_dir().join(format!("parrot-ghost-{}", std::process::id()));
        let store = Store { data: dir.clone() };
        let id = store.add("Hello there.", None, None).unwrap().id;
        let part = store.part_dir(&id, "Hello there.").unwrap();
        store.delete(&id).unwrap();
        // what a take scored during the delete used to leave: texts/<id>/p-<sha>/<try> without text.txt
        fs::create_dir_all(&part).unwrap();
        let today = Local::now().format("%Y%m%d-%H%M%S");
        fs::write(part.join(format!("{today}.json")), "{}").unwrap();
        assert!(store.list().is_empty());
        assert!(store.activity().days.iter().all(|day| day.tries == 0));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn sends_the_shapes_the_interface_reads() {
        // the keys of TextItem, AttemptSummary and Activity in src/app/core/models.ts
        let keys = |value: Value| value.as_object().unwrap().keys().cloned().collect::<Vec<_>>().join(" ");
        let dir = std::env::temp_dir().join(format!("parrot-shapes-{}", std::process::id()));
        let store = Store { data: dir.clone() };
        let added = serde_json::to_value(store.add("Hello there.", None, None).unwrap()).unwrap();
        assert_eq!(keys(added.clone()), "average created id mode opened practised scores spoken text title words");
        assert_eq!((&added["mode"], &added["opened"], &added["average"]), (&json!("sentences"), &Value::Null, &Value::Null));
        assert_eq!(added["title"], "Hello there.…");
        let summary = AttemptSummary { id: "20260101-120000".into(), when: "2026-01-01T12:00:00".into(), score: 80, wpm: 120, duration: 2.5 };
        assert_eq!(keys(serde_json::to_value(summary).unwrap()), "duration id score when wpm");
        let activity = serde_json::to_value(store.activity()).unwrap();
        assert_eq!(keys(activity.clone()), "average days tries");
        assert_eq!(keys(activity["days"][6].clone()), "date tries");
        assert_eq!((activity["days"].as_array().unwrap().len(), &activity["tries"], &activity["average"]), (7, &json!(0), &Value::Null));
        let _ = fs::remove_dir_all(dir);
    }
}
