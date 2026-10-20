//! Where texts and tries are kept: plain files in the app's data folder, the same layout the first (Python) engine
//! used, so a library made with it opens unchanged.
//!
//! ```text
//! texts/<id>/text.txt          the text (id: the first 10 hex digits of the SHA-1 of its words)
//! texts/<id>/meta.json         title, practise mode, when created and last opened
//! texts/<id>/p-<sha1>/         one folder per part that has been recorded, named after its words
//!     <time>.wav + <time>.json a try: the cleaned recording, and what was heard and scored
//! texts/<id>/w-<sha1>/         one folder per word practised alone, named after it in lower case without the
//!                              punctuation around it; the same kind of tries, kept apart from the parts' scores
//! trash/                       deleted texts, moved here rather than erased
//! ```

use crate::text::WordResult;
use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use std::collections::BTreeMap;
use std::fs;
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

    fn text_dir(&self, id: &str) -> Result<PathBuf, String> {
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
        fs::write(dir.join("meta.json"), serde_json::to_string_pretty(&meta).unwrap()).map_err(|error| error.to_string())
    }

    fn read_attempts(dir: &Path) -> Vec<Attempt> {
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
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        fs::write(dir.join("text.txt"), &body).map_err(|error| error.to_string())?;
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

    /// Moved to the trash folder, not deleted.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let dir = self.text_dir(id)?;
        let trash = self.data.join("trash");
        fs::create_dir_all(&trash).map_err(|error| error.to_string())?;
        fs::rename(&dir, trash.join(format!("{id}-{}", Local::now().format("%Y%m%d-%H%M%S")))).map_err(|error| error.to_string())
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
        fs::write(dir.join(format!("{}.json", attempt.id)), serde_json::to_string_pretty(attempt).unwrap()).map_err(|error| error.to_string())
    }

    /// Tries per day for the last 7 days (today last), and their average score.
    pub fn activity(&self) -> Activity {
        let today = Local::now().date_naive();
        let mut days: BTreeMap<chrono::NaiveDate, usize> = (0..7).map(|days_ago| (today - chrono::Duration::days(days_ago), 0)).collect();
        let (mut total, mut scored) = (0i64, 0usize);
        if let Ok(texts) = fs::read_dir(self.texts()) {
            for text in texts.flatten() {
                let parts = fs::read_dir(text.path()).into_iter().flatten().flatten();
                for part in parts.filter(|part| part.file_name().to_string_lossy().starts_with("p-")) {
                    for file in fs::read_dir(part.path()).into_iter().flatten().flatten() {
                        let name = file.file_name().to_string_lossy().to_string();
                        // a try's name starts with its day (20261020-...); any other file in the folder is skipped
                        let stamp = name.get(..8).filter(|stamp| name.ends_with(".json") && stamp.bytes().all(|byte| byte.is_ascii_digit()));
                        let Some(Ok(day)) = stamp.map(|stamp| chrono::NaiveDate::parse_from_str(stamp, "%Y%m%d")) else { continue };
                        if let Some(tries) = days.get_mut(&day) {
                            *tries += 1;
                            let attempt = fs::read_to_string(file.path()).ok().and_then(|contents| serde_json::from_str::<Attempt>(&contents).ok());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_match_the_python_engine() {
        // the same text ids the Python engine gives (sha1 of the normalised words), so its library opens unchanged
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
    fn sends_the_shapes_the_interface_reads() {
        // the keys of TextItem, AttemptSummary and Activity in src/app/core/models.ts
        let keys = |value: Value| value.as_object().unwrap().keys().cloned().collect::<Vec<_>>().join(" ");
        let dir = std::env::temp_dir().join(format!("parrot-shapes-{}", std::process::id()));
        let store = Store { data: dir.clone() };
        let added = serde_json::to_value(store.add("Hello there.", None, None).unwrap()).unwrap();
        assert_eq!(keys(added.clone()), "average created id mode opened practised scores text title words");
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
