//! Fixing the words of a text that already has tries. Tries are filed by the words of their part, so a part whose
//! words change takes its tries along: each is scored again, from its recording, against the words the part has now.
//! Parts whose words didn't change keep their tries as they are.

use crate::store::{self, Attempt, Store, TextItem};
use crate::text::{self, WordResult, WordStatus};
use crate::{Listen, audio, score_take, talk};
use similar::DiffOp;
use std::fs;
use std::path::PathBuf;

/// Change the words of the text `id` to `new_text`. `progress` gets the tries scored again so far, of how many.
/// Nothing changes until every try is scored: a failure leaves the text and its tries as they were. A try whose
/// recording can't be read (gone, damaged, or the first engine's .mp3) can't be scored again: it stays where it was.
pub fn edit_text(listener: &impl Listen, store: &Store, id: &str, new_text: &str, progress: impl Fn(usize, usize)) -> Result<TextItem, String> {
    let dir = store.text_dir(id)?;
    let old = store::norm(&fs::read_to_string(dir.join("text.txt")).map_err(|error| error.to_string())?);
    let new = store::norm(new_text);
    if new.is_empty() {
        return Err("the text is empty".into());
    }
    if new == old {
        return store.text(id);
    }
    let old_words: Vec<&str> = old.split_whitespace().collect();
    let new_words: Vec<&str> = new.split_whitespace().collect();
    let ops = similar::capture_diff_slices(similar::Algorithm::Myers, &old_words, &new_words);

    // the way the text is practised now: a part that is one in more than one way (a sentence that is the whole text)
    // is taken as one of these
    let mode = store.text(id)?.mode;
    let modes: Vec<&str> = std::iter::once(mode.as_str()).chain(text::MODES).collect();

    // the parts tried that are no longer parts of the text: their tries, and the part they became
    let mut changed: Vec<(PathBuf, Vec<Attempt>, String)> = vec![];
    for entry in fs::read_dir(&dir).map_err(|error| error.to_string())?.flatten() {
        let path = entry.path();
        if !entry.file_name().to_string_lossy().starts_with("p-") || !path.is_dir() {
            continue;
        }
        let tries = Store::read_attempts(&path);
        let Some(first) = tries.first() else { continue };
        let part = store::norm(&first.text);
        let part_words: Vec<&str> = part.split_whitespace().collect();
        let Some(start) = find(&old_words, &part_words) else { continue };
        let range = start..start + part_words.len();
        // practised whole, in sentences or in short parts: the part becomes one of the same in the new text
        let kind = modes.iter().copied().find(|mode| text::parts(&old_words, mode).contains(&range)).unwrap_or(&mode);
        let new_parts = text::parts(&new_words, kind);
        if new_parts.iter().any(|part| new_words[part.clone()] == part_words[..]) {
            continue;
        }
        let now = map_range(&ops, range);
        // the part of the new text its words went to, most of them: a full stop taken out joins two sentences into
        // one, which takes the tries of both; one put in splits a sentence, whose tries go with its larger half.
        // A part whose words are all gone keeps its tries where they were.
        let overlap = |part: &std::ops::Range<usize>| part.end.min(now.end).saturating_sub(part.start.max(now.start));
        let Some(became) = new_parts.iter().filter(|part| overlap(part) > 0).min_by_key(|part| std::cmp::Reverse(overlap(part))) else { continue };
        changed.push((path, tries, new_words[became.clone()].join(" ")));
    }

    let total = changed.iter().map(|(_, tries, _)| tries.len()).sum();
    progress(0, total);
    let names = store.names();
    let mut scored = vec![];
    let mut done = 0;
    for (old_dir, tries, part) in &changed {
        for attempt in tries {
            match rejudge(listener, store, attempt, part, &names)? {
                Some(rejudged) => scored.push((old_dir, attempt, part, rejudged)),
                None => log::warn!("kept try {} of {} where it was: its recording can't be read", attempt.id, old_dir.display()),
            }
            done += 1;
            progress(done, total);
        }
    }

    // all scored: each try is filed under its part's words now (its recording linked there), then the text changes,
    // and only then do the tries as they were go. A failure on the way takes back what was filed, leaving the text
    // as it was; a crash leaves at worst a try twice, once where the text doesn't look.
    let _filing = store::filing();
    let mut filed: Vec<PathBuf> = vec![];
    let mut moved: Vec<PathBuf> = vec![];
    let filing = (|| {
        for (old_dir, old_attempt, part, mut attempt) in scored {
            let new_dir = dir.join(format!("p-{}", store::sha(part)));
            fs::create_dir_all(&new_dir).map_err(|error| error.to_string())?;
            let stamp = old_attempt.id.get(..15).unwrap_or(&old_attempt.id);
            attempt.id = Store::new_try(&new_dir, stamp)?;
            let file = new_dir.join(format!("{}.wav", attempt.id));
            filed.extend([file.clone(), new_dir.join(format!("{}.json", attempt.id))]);
            let recording = store.recording(&old_attempt.audio)?;
            link(&recording, &file)?;
            attempt.audio = file.strip_prefix(&store.data).unwrap_or(&file).to_string_lossy().replace('\\', "/");
            store.save_attempt(&new_dir, &attempt)?;
            moved.extend([old_dir.join(format!("{}.json", old_attempt.id)), recording]);
        }
        store::write_whole(&dir.join("text.txt"), new.as_bytes())
    })();
    if let Err(error) = filing {
        take_back(&filed);
        return Err(error);
    }
    // the parts' folders go once their last try has moved out
    take_back(&moved);
    store.text(id)
}

/// The recording `from` at `to` too, as the same file where the disk allows it (no time or room spent on a long
/// talk), else as a copy. `to` may be the empty file that claimed its name.
fn link(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    let _ = fs::remove_file(to);
    fs::hard_link(from, to).or_else(|_| fs::copy(from, to).map(drop)).map_err(|error| error.to_string())
}

/// Remove `files`, then their folders left empty.
fn take_back(files: &[PathBuf]) {
    for file in files {
        let _ = fs::remove_file(file);
    }
    for file in files {
        let _ = file.parent().map(fs::remove_dir);
    }
}

/// Where the words `words` are in `text` (the first place), if they are.
fn find(text: &[&str], words: &[&str]) -> Option<usize> {
    if words.is_empty() || words.len() > text.len() {
        return None;
    }
    text.windows(words.len()).position(|window| window == words)
}

/// The words of the new text that the old text's words `old` became: from where its first word went to where its
/// last went, a word replaced counting as the word it was replaced by.
fn map_range(ops: &[DiffOp], old: std::ops::Range<usize>) -> std::ops::Range<usize> {
    let place = |index: usize, end: bool| {
        let op = ops.iter().find(|op| op.old_range().contains(&index))?;
        let (from, to) = (op.old_range(), op.new_range());
        Some(match op {
            DiffOp::Equal { .. } => to.start + index - from.start + end as usize,
            _ if end => to.end,
            _ => to.start,
        })
    };
    match (place(old.start, false), place(old.end - 1, true)) {
        (Some(start), Some(end)) if start < end => start..end,
        _ => 0..0,
    }
}

/// A try scored again against the words `part` has now, from its recording: a stretch at a time, as a talk is, each
/// old word's stretch giving the new words that stand for it.
/// None when its recording can't be read.
fn rejudge(listener: &impl Listen, store: &Store, attempt: &Attempt, part: &str, names: &[String]) -> Result<Option<Attempt>, String> {
    let Ok(pcm) = store.recording(&attempt.audio).and_then(|file| audio::read_wav_file(&file)) else { return Ok(None) };
    let duration = pcm.seconds();
    let samples = audio::resample(&pcm, 16000);
    drop(pcm);
    let stretches = audio::stretches(&samples, 16000, talk::STRETCH);
    // each old word goes with the stretch it was placed in (one not placed, with the one before it)
    let mut owner = vec![];
    let mut last = 0;
    for word in &attempt.words {
        if let Some([start, end]) = word.t {
            let middle = ((start + end) / 2.0 * 16000.0) as usize;
            last = stretches.iter().position(|stretch| middle < stretch.end).unwrap_or(stretches.len().saturating_sub(1));
        }
        owner.push(last);
    }
    let old: Vec<&str> = attempt.words.iter().map(|word| word.w.as_str()).collect();
    let mut shared = talk::share(&owner, &old, part, stretches.len());
    if shared.iter().all(Vec::is_empty) && !stretches.is_empty() {
        // a try with no words kept (from before they were): the whole part goes with the first stretch
        shared[0] = part.split_whitespace().collect();
    }
    let mut words: Vec<WordResult> = vec![];
    let mut heard = vec![];
    for (index, (stretch, meant)) in stretches.iter().zip(shared).enumerate() {
        if meant.is_empty() {
            continue;
        }
        // a stretch whose words didn't change keeps them as they were judged: only what changed is heard again
        let before: Vec<&WordResult> = attempt.words.iter().zip(&owner).filter(|(_, owner)| **owner == index).map(|(word, _)| word).collect();
        if before.iter().map(|word| word.w.as_str()).eq(meant.iter().copied()) {
            heard.extend(
                before
                    .iter()
                    .filter_map(|word| if word.status == WordStatus::Wrong { word.heard.clone() } else { Some(word.w.clone()) })
                    .filter(|word| !word.is_empty()),
            );
            words.extend(before.into_iter().cloned());
            continue;
        }
        let audio = &samples[stretch.clone()];
        let scored = score_take(listener, audio, audio.len() as f64 / 16000.0, &meant.join(" "), names)?;
        let offset = stretch.start as f64 / 16000.0;
        words.extend(
            scored.words.into_iter().map(|word| WordResult { t: word.t.map(|[from, to]| [round3(from + offset), round3(to + offset)]), ..word }),
        );
        heard.push(scored.heard);
    }
    let good = words.iter().filter(|word| word.status == WordStatus::Good).count();
    Ok(Some(Attempt {
        text: part.to_string(),
        heard: heard.join(" "),
        score: (100.0 * good as f64 / words.len().max(1) as f64).round() as i64,
        wpm: if duration > 0.0 { (words.len() as f64 / duration * 60.0).round() as i64 } else { 0 },
        pauses: text::pauses(&words),
        words,
        ..attempt.clone()
    }))
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Places each word a third of a second after the one before, all clearly said; hears what it is told to.
    struct Listener {
        heard: &'static str,
        fail: bool,
        texts: RefCell<Vec<String>>,
    }

    impl Listen for Listener {
        fn align(&self, _audio: &[f32], text: &str) -> Result<Vec<text::WordTime>, String> {
            if self.fail {
                return Err("the speech engine is not running".into());
            }
            self.texts.borrow_mut().push(text.to_string());
            Ok((0..text.split_whitespace().count())
                .map(|index| text::WordTime { t: Some([index as f64 / 3.0, index as f64 / 3.0 + 0.3]), score: Some(0.9), letters: None })
                .collect())
        }

        fn transcribe(&self, _audio: &[f32], _words: &[text::WordTime]) -> Result<String, String> {
            Ok(self.heard.to_string())
        }
    }

    /// A store with the text `text` (in sentences) and a try of each of `parts`, two seconds of tone each.
    fn store_with(name: &str, text: &str, parts: &[&str]) -> (Store, String) {
        let store = Store { data: std::env::temp_dir().join(format!("parrot-edit-{name}-{}", std::process::id())) };
        let _ = fs::remove_dir_all(&store.data);
        fs::create_dir_all(store.data.join("texts")).unwrap();
        let id = store.add(text, Some("A text".into()), Some("sentences".into())).unwrap().id;
        for part in parts {
            let dir = store.part_dir(&id, part).unwrap();
            fs::create_dir_all(&dir).unwrap();
            let try_id = Store::new_try(&dir, "20261020-101010").unwrap();
            let file = dir.join(format!("{try_id}.wav"));
            let tone: Vec<f32> = (0..32000).map(|index| 0.3 * (index as f32 * 0.09).sin()).collect();
            audio::write_wav(&file, &audio::Pcm { samples: tone, rate: 16000 }).unwrap();
            let words: Vec<WordResult> = part
                .split_whitespace()
                .enumerate()
                .map(|(index, word)| WordResult {
                    w: word.into(),
                    t: Some([index as f64 * 0.4, index as f64 * 0.4 + 0.3]),
                    score: Some(0.5),
                    reference: None,
                    status: WordStatus::Unclear,
                    heard: None,
                    extra: String::new(),
                    letters: None,
                })
                .collect();
            let attempt = Attempt {
                id: try_id,
                when: "2026-10-20T10:10:10".into(),
                text: part.to_string(),
                heard: part.to_string(),
                words,
                duration: 2.0,
                wpm: 90,
                score: 0,
                audio: file.strip_prefix(&store.data).unwrap().to_string_lossy().into(),
                pauses: vec![],
                cut: None,
            };
            store.save_attempt(&dir, &attempt).unwrap();
        }
        (store, id)
    }

    #[test]
    fn a_part_whose_words_changed_takes_its_tries_scored_again() {
        let (store, id) = store_with("changed", "Hello there. How are you?", &["Hello there.", "How are you?"]);
        let listener = Listener { heard: "how old are you", fail: false, texts: RefCell::new(vec![]) };
        let reported = RefCell::new(vec![]);
        let item =
            edit_text(&listener, &store, &id, "Hello there.  How old are you?", |done, total| reported.borrow_mut().push((done, total))).unwrap();

        assert_eq!(item.text, "Hello there. How old are you?");
        assert_eq!(*listener.texts.borrow(), ["How old are you?"], "only the part that changed is scored again");
        assert_eq!(*reported.borrow(), [(0, 1), (1, 1)]);
        let tries = store.attempts(&id, "How old are you?").unwrap();
        assert_eq!(tries.len(), 1);
        let moved = store.attempt(&id, "How old are you?", &tries[0].id).unwrap();
        assert_eq!((moved.text.as_str(), moved.score, moved.when.as_str()), ("How old are you?", 100, "2026-10-20T10:10:10"));
        assert_eq!(moved.words.len(), 4);
        assert!(store.data.join(&moved.audio).exists(), "the recording moved with it");
        // the part that didn't change is as it was; the old part's folder is gone
        assert_eq!(store.attempt(&id, "Hello there.", &store.attempts(&id, "Hello there.").unwrap()[0].id).unwrap().score, 0);
        assert_eq!(item.scores.len(), 2);
        assert!(store.part_dir(&id, "How are you?").is_err(), "no longer a part of the text");
        let _ = fs::remove_dir_all(&store.data);
    }

    #[test]
    fn a_full_stop_taken_out_joins_two_sentences_and_their_tries() {
        let (store, id) = store_with("joined", "Hello there. How are you?", &["Hello there.", "How are you?"]);
        let listener = Listener { heard: "hello there how are you", fail: false, texts: RefCell::new(vec![]) };
        let item = edit_text(&listener, &store, &id, "Hello there, how are you?", |_, _| {}).unwrap();
        assert_eq!(*listener.texts.borrow(), ["Hello there, how are you?"; 2]);
        assert_eq!(store.attempts(&id, "Hello there, how are you?").unwrap().len(), 2, "the one sentence has the tries of both");
        assert_eq!(item.scores.values().map(|part| part.tries).collect::<Vec<_>>(), [2]);
        let _ = fs::remove_dir_all(&store.data);
    }

    #[test]
    fn a_full_stop_put_in_gives_a_sentence_tried_to_its_larger_half() {
        let (store, id) = store_with("split", "Well, how are you today?", &["Well, how are you today?"]);
        let listener = Listener { heard: "how are you today", fail: false, texts: RefCell::new(vec![]) };
        let item = edit_text(&listener, &store, &id, "Well. How are you today?", |_, _| {}).unwrap();
        assert_eq!(store.attempts(&id, "How are you today?").unwrap().len(), 1);
        assert!(store.attempts(&id, "Well.").unwrap().is_empty());
        assert_eq!(item.scores.len(), 1, "no try under words that are no part of the text");
        let _ = fs::remove_dir_all(&store.data);
    }

    #[test]
    fn tries_under_words_that_are_no_part_of_the_text_do_not_count() {
        let (store, id) = store_with("stranded", "Hello there. How are you?", &["How are you?"]);
        // left by an edit before 0.5: the words of a part as it never is in this text
        let text = store.text_dir(&id).unwrap();
        let stranded = text.join(format!("p-{}", store::sha("Hello there How")));
        fs::create_dir_all(&stranded).unwrap();
        let mut attempt = store.attempt(&id, "How are you?", &store.attempts(&id, "How are you?").unwrap()[0].id).unwrap();
        attempt.text = "Hello there How".into();
        store.save_attempt(&stranded, &attempt).unwrap();
        let item = store.text(&id).unwrap();
        assert_eq!((item.scores.len(), item.practised), (1, 1));
        let _ = fs::remove_dir_all(&store.data);
    }

    #[test]
    fn a_try_whose_recording_is_gone_stays_where_it_was_and_the_rest_move() {
        let (store, id) = store_with("unreadable", "Hello there. How are you?", &["Hello there.", "How are you?"]);
        // a second try of the part, its recording gone
        let dir = store.part_dir(&id, "How are you?").unwrap();
        let mut gone = store.attempt(&id, "How are you?", &store.attempts(&id, "How are you?").unwrap()[0].id).unwrap();
        gone.id = Store::new_try(&dir, "20261021-101010").unwrap();
        gone.audio = format!("texts/{id}/{}/{}.wav", dir.file_name().unwrap().to_string_lossy(), gone.id);
        fs::remove_file(dir.join(format!("{}.wav", gone.id))).unwrap();
        store.save_attempt(&dir, &gone).unwrap();
        let listener = Listener { heard: "how old are you", fail: false, texts: RefCell::new(vec![]) };
        let reported = RefCell::new(vec![]);
        edit_text(&listener, &store, &id, "Hello there. How old are you?", |done, total| reported.borrow_mut().push((done, total))).unwrap();
        assert_eq!(*reported.borrow(), [(0, 2), (1, 2), (2, 2)]);
        assert_eq!(store.attempts(&id, "How old are you?").unwrap().len(), 1, "the try that could be scored again moved");
        assert!(dir.join(format!("{}.json", gone.id)).exists(), "the other is where it was");
        let _ = fs::remove_dir_all(&store.data);
    }

    #[test]
    fn a_failure_while_the_tries_move_leaves_the_text_as_it_was() {
        let (store, id) = store_with("unmoved", "Hello there. How are you?", &["Hello there.", "How are you?"]);
        let listener = Listener { heard: "hi there how old are you", fail: false, texts: RefCell::new(vec![]) };
        // the second part's new folder can't be made: a file is in its way
        let text = store.text_dir(&id).unwrap();
        fs::write(text.join(format!("p-{}", store::sha("How old are you?"))), b"").unwrap();
        let files = |folder: &std::path::Path| {
            let mut found: Vec<String> = walk(folder).iter().map(|path| path.strip_prefix(folder).unwrap().to_string_lossy().into()).collect();
            found.sort();
            found
        };
        let before = files(&text);
        assert!(edit_text(&listener, &store, &id, "Hi there. How old are you?", |_, _| {}).is_err());
        assert_eq!(files(&text), before, "nothing moved, nothing left behind");
        assert_eq!(store.text(&id).unwrap().text, "Hello there. How are you?");
        assert_eq!(store.attempts(&id, "Hello there.").unwrap().len(), 1);
        let _ = fs::remove_dir_all(&store.data);
    }

    /// Every file under `folder`.
    fn walk(folder: &std::path::Path) -> Vec<PathBuf> {
        fs::read_dir(folder)
            .into_iter()
            .flatten()
            .flatten()
            .flat_map(|entry| if entry.path().is_dir() { walk(&entry.path()) } else { vec![entry.path()] })
            .collect()
    }

    #[test]
    fn only_the_stretches_of_a_long_take_whose_words_changed_are_heard_again() {
        let (store, id) = store_with("long", "One two three.", &[]);
        // a minute of speech-like sound, with a pause every seven seconds, and a word every second in it
        let dir = store.part_dir(&id, "One two three.").unwrap();
        fs::create_dir_all(&dir).unwrap();
        let sound: Vec<f32> = (0..16000 * 60).map(|index| if (index / 16000) % 7 < 6 { 0.3 * (index as f32 * 0.09).sin() } else { 0.0 }).collect();
        audio::write_wav(&dir.join("20261020-101010.wav"), &audio::Pcm { samples: sound, rate: 16000 }).unwrap();
        let said: Vec<String> = (0..60).map(|index| format!("w{index}")).collect();
        let words = said
            .iter()
            .enumerate()
            .map(|(index, word)| WordResult {
                w: word.clone(),
                t: Some([index as f64, index as f64 + 0.5]),
                score: Some(0.5),
                reference: None,
                status: WordStatus::Unclear,
                heard: None,
                extra: String::new(),
                letters: None,
            })
            .collect();
        let text = said.join(" ");
        let attempt = Attempt {
            id: "20261020-101010".into(),
            when: "2026-10-20T10:10:10".into(),
            text: text.clone(),
            heard: text.clone(),
            words,
            duration: 60.0,
            wpm: 60,
            score: 0,
            audio: format!("texts/{id}/{}/20261020-101010.wav", dir.file_name().unwrap().to_string_lossy()),
            pauses: vec![],
            cut: None,
        };
        // the take is of the whole text: make the text that
        store::write_whole(&store.text_dir(&id).unwrap().join("text.txt"), text.as_bytes()).unwrap();
        let part = store.part_dir(&id, &text).unwrap();
        fs::create_dir_all(&part).unwrap();
        fs::rename(dir.join("20261020-101010.wav"), part.join("20261020-101010.wav")).unwrap();
        let attempt = Attempt { audio: format!("texts/{id}/{}/20261020-101010.wav", part.file_name().unwrap().to_string_lossy()), ..attempt };
        store.save_attempt(&part, &attempt).unwrap();

        let listener = Listener { heard: "", fail: false, texts: RefCell::new(vec![]) };
        let fixed = text.replace("w50", "fifty");
        edit_text(&listener, &store, &id, &fixed, |_, _| {}).unwrap();
        let heard_again = listener.texts.borrow();
        assert_eq!(heard_again.len(), 1, "one stretch: {heard_again:?}");
        assert!(heard_again[0].contains("fifty") && !heard_again[0].contains("w10 "), "{}", heard_again[0]);
        let moved = store.attempt(&id, &fixed, &store.attempts(&id, &fixed).unwrap()[0].id).unwrap();
        assert_eq!(moved.words.len(), 60);
        // the words not heard again are as they were judged
        assert_eq!((moved.words[10].status, moved.words[10].t), (WordStatus::Unclear, Some([10.0, 10.5])));
        let _ = fs::remove_dir_all(&store.data);
    }

    #[test]
    fn nothing_changes_when_a_try_cannot_be_scored_again() {
        let (store, id) = store_with("failed", "Hello there. How are you?", &["How are you?"]);
        let listener = Listener { heard: "", fail: true, texts: RefCell::new(vec![]) };
        assert!(edit_text(&listener, &store, &id, "Hello there. How old are you?", |_, _| {}).is_err());
        assert_eq!(store.text(&id).unwrap().text, "Hello there. How are you?");
        assert_eq!(store.attempts(&id, "How are you?").unwrap().len(), 1);
        // the same words, or none: nothing to do, or refused
        assert_eq!(edit_text(&listener, &store, &id, " Hello there.\nHow are you? ", |_, _| {}).unwrap().text, "Hello there. How are you?");
        assert!(edit_text(&listener, &store, &id, "  ", |_, _| {}).is_err());
        let _ = fs::remove_dir_all(&store.data);
    }

    #[test]
    fn the_words_a_part_became_are_found_through_the_changes() {
        let words = |text: &'static str| text.split_whitespace().collect::<Vec<_>>();
        let (old, new) = (words("A b c. D e f. G h."), words("A b c. D x f y. G h."));
        let ops = similar::capture_diff_slices(similar::Algorithm::Myers, &old, &new);
        assert_eq!(map_range(&ops, 3..6), 3..7, "a word replaced and one added at the end");
        assert_eq!(map_range(&ops, 0..3), 0..3);
        assert_eq!(map_range(&ops, 6..8), 7..9);
        let gone = similar::capture_diff_slices(similar::Algorithm::Myers, &old, &words("A b c. G h."));
        assert!(map_range(&gone, 3..6).is_empty(), "a part deleted");
        assert_eq!(find(&old, &words("D e f.")), Some(3));
        assert_eq!(find(&old, &words("e f. X")), None);
    }
}
