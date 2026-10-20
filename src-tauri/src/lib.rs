//! Parrot's engine, inside the app: the interface calls these commands. Texts and tries are files in the app's
//! data folder (store.rs); a take is cleaned (audio.rs), placed word by word and scored (align.rs), heard by
//! Whisper (asr.rs) and judged word by word (text.rs).

mod align;
mod asr;
mod audio;
mod models;
mod sounds;
mod store;
mod text;

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use store::{Activity, Attempt, AttemptSummary, PartScore, Store, TextItem};
use tauri::{AppHandle, Manager, State};
use text::WordStatus;

pub struct Engine {
    store: Store,
    models: PathBuf,
    aligner: Mutex<Option<align::Aligner>>,
    recognizer: Mutex<Option<asr::Recognizer>>,
}

type Shared = Arc<Engine>;

impl Engine {
    fn with_aligner<T>(&self, work: impl FnOnce(&mut align::Aligner) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.aligner.lock().unwrap();
        if guard.is_none() {
            *guard = Some(align::Aligner::load(&models::path(&self.models, &models::ALIGNER))?);
        }
        work(guard.as_mut().unwrap())
    }

    fn with_recognizer<T>(&self, work: impl FnOnce(&asr::Recognizer) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.recognizer.lock().unwrap();
        if guard.is_none() {
            *guard = Some(asr::Recognizer::load(&models::path(&self.models, &models::WHISPER))?);
        }
        work(guard.as_ref().unwrap())
    }

    /// Let go of both models before the app quits. whisper.cpp frees its Metal device as the process exits and aborts
    /// if the model's buffers are still alive then, so the recognizer must be gone first. A model busy with a take is
    /// left as it is rather than holding up the quit.
    fn unload(&self) {
        if let Ok(mut recognizer) = self.recognizer.try_lock() {
            recognizer.take();
        }
        if let Ok(mut aligner) = self.aligner.try_lock() {
            aligner.take();
        }
    }

    /// Load both models ahead of the first take, so it isn't slow.
    fn warm(&self) {
        if models::ALL.iter().all(|model| models::ready(&self.models, model)) {
            let _ = self.with_aligner(|_| Ok(()));
            let _ = self.with_recognizer(|_| Ok(()));
        }
    }

    /// Save a take (a WAV file), score it against `part` and keep the result next to it.
    fn check(&self, text_id: &str, part: &str, wav: &[u8]) -> Result<Attempt, String> {
        let dir = self.store.part_dir(text_id, part)?;
        self.keep_take(&dir, &store::norm(part), wav, score_take)
    }

    /// A take of one word of the text said alone, kept with that word's own tries: they never count toward the
    /// part's or the text's scores.
    fn check_word(&self, text_id: &str, word: &str, wav: &[u8]) -> Result<Attempt, String> {
        let dir = self.store.word_dir(text_id, word)?;
        self.keep_take(&dir, store::bare(word), wav, score_word)
    }

    /// Clean a take, score it against `txt` (as a part or as a word alone) and save both in `dir`: the recording, and
    /// what was heard and scored.
    fn keep_take(&self, dir: &Path, txt: &str, wav: &[u8], score: fn(&Self, &[f32], f64, &str) -> Result<Scored, String>) -> Result<Attempt, String> {
        let raw = audio::read_wav(wav)?;
        let take = audio::clean(raw)
            .filter(|cleaned| cleaned.seconds() >= audio::SHORTEST_TAKE)
            .ok_or("Nothing was heard in the recording. Is the microphone on?")?;
        let secs = take.seconds();
        let scored = score(self, &audio::resample(&take, 16000), secs, txt)?;
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        let now = chrono::Local::now();
        let id = now.format("%Y%m%d-%H%M%S").to_string();
        let file = dir.join(format!("{id}.wav"));
        audio::write_wav(&file, &take)?;
        let attempt = Attempt {
            id,
            when: now.format("%Y-%m-%dT%H:%M:%S").to_string(),
            text: txt.to_string(),
            heard: scored.heard,
            score: scored.score,
            wpm: scored.wpm,
            words: scored.words,
            duration: (secs * 100.0).round() / 100.0,
            audio: file.strip_prefix(&self.store.data).unwrap_or(&file).to_string_lossy().replace('\\', "/"),
        };
        self.store.save_attempt(dir, &attempt)?;
        Ok(attempt)
    }
}

/// What scoring a take needs from the models: the engine uses the real ones, tests stand in for them.
trait Listen {
    /// Where each word of `text` is in the take (16 kHz), and how clearly it was said.
    fn align(&self, audio: &[f32], text: &str) -> Result<Vec<text::WordTime>, String>;
    /// What was said in the take, with the words' places as a hint.
    fn transcribe(&self, audio: &[f32], words: &[text::WordTime]) -> Result<String, String>;
}

impl Listen for Engine {
    fn align(&self, audio: &[f32], text: &str) -> Result<Vec<text::WordTime>, String> {
        self.with_aligner(|aligner| aligner.align(audio, text))
    }

    fn transcribe(&self, audio: &[f32], words: &[text::WordTime]) -> Result<String, String> {
        self.with_recognizer(|recognizer| recognizer.transcribe(audio, words, 25.0))
    }
}

/// A take judged against its text, before it is saved.
struct Scored {
    heard: String,
    words: Vec<text::WordResult>,
    score: i64,
    wpm: i64,
}

/// Judge a take (16 kHz, `secs` long) of `txt` word by word.
fn score_take(listener: &impl Listen, audio: &[f32], secs: f64, txt: &str) -> Result<Scored, String> {
    let mut mine = listener.align(audio, txt)?;
    let heard = listener.transcribe(audio, &mine)?;
    // stopped before the end: the aligner squeezes the whole text into the take and the words that were said
    // score low, so score only the words up to the last one heard; the rest count as missed
    let (wrong, _) = text::heard_words(txt, &heard);
    let said = wrong.iter().rposition(|verdict| verdict.is_none()).map(|last_heard| last_heard + 1).unwrap_or(0);
    let stopped_early = said > 0 && said < mine.len() && wrong[said..].iter().all(|verdict| verdict.as_deref() == Some(""));
    if stopped_early {
        let first: Vec<&str> = txt.split_whitespace().take(said).collect();
        let head = listener.align(audio, &first.join(" "))?;
        mine.splice(..said, head);
        for word_time in &mut mine[said..] {
            *word_time = text::WordTime { score: Some(0.0), ..Default::default() };
        }
    }
    let words = text::judge(txt, &heard, &mine, None);
    let good = words.iter().filter(|word| word.status == WordStatus::Good).count();
    // the pace of the words read: all of them, unless the take stopped early
    let spoken = if stopped_early { said } else { words.len() };
    Ok(Scored {
        score: (100.0 * good as f64 / words.len().max(1) as f64).round() as i64,
        wpm: if secs > 0.0 { (spoken as f64 / secs * 60.0).round() as i64 } else { 0 },
        heard,
        words,
    })
}

/// Judge a take of one word said alone. Both checks give its verdict, but its score is the sound match: heard without
/// the words around it, a single word is often misheard by speech recognition, and a score of 0 or 100 tells little.
fn score_word(listener: &impl Listen, audio: &[f32], secs: f64, word: &str) -> Result<Scored, String> {
    let mut scored = score_take(listener, audio, secs, word)?;
    scored.score = scored.words.first().and_then(|said| said.score).map(|sound| (sound * 100.0).round() as i64).unwrap_or(0);
    Ok(scored)
}

/// Run blocking engine work off the main thread.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|error| error.to_string())?
}

#[tauri::command]
fn info(engine: State<'_, Shared>) -> Value {
    json!({
        "data": engine.store.data,
        "models": models::ALL.iter().map(|model| (model.key, models::ready(&engine.models, model))).collect::<BTreeMap<_, _>>(),
        "sizes": models::ALL.iter().map(|model| (model.key, model.bytes)).collect::<BTreeMap<_, _>>(),
    })
}

#[tauri::command]
fn texts(engine: State<'_, Shared>) -> Vec<TextItem> {
    engine.store.list()
}

#[tauri::command]
fn add_text(engine: State<'_, Shared>, text: String, title: Option<String>, mode: Option<String>) -> Result<TextItem, String> {
    engine.store.add(&text, title, mode)
}

#[tauri::command]
fn update_text(engine: State<'_, Shared>, id: String, title: Option<String>, mode: Option<String>, opened: Option<bool>) -> Result<TextItem, String> {
    engine.store.update(&id, title, mode, opened.unwrap_or(false))
}

#[tauri::command]
fn delete_text(engine: State<'_, Shared>, id: String) -> Result<(), String> {
    engine.store.delete(&id)
}

#[tauri::command]
fn scores(engine: State<'_, Shared>, text: String) -> Result<BTreeMap<String, PartScore>, String> {
    engine.store.scores(&text)
}

#[tauri::command]
fn attempts(engine: State<'_, Shared>, text: String, part: String) -> Result<Vec<AttemptSummary>, String> {
    engine.store.attempts(&text, &part)
}

#[tauri::command]
fn attempt(engine: State<'_, Shared>, text: String, part: String, id: String) -> Result<Attempt, String> {
    engine.store.attempt(&text, &part, &id)
}

#[tauri::command]
fn word_attempts(engine: State<'_, Shared>, text: String, word: String) -> Result<Vec<AttemptSummary>, String> {
    engine.store.word_attempts(&text, &word)
}

#[tauri::command]
fn word_attempt(engine: State<'_, Shared>, text: String, word: String, id: String) -> Result<Attempt, String> {
    engine.store.word_attempt(&text, &word, &id)
}

#[tauri::command]
fn activity(engine: State<'_, Shared>) -> Activity {
    engine.store.activity()
}

#[tauri::command]
fn pron(w: String) -> Value {
    sounds::sounds_like(&w).map(|sounds| json!(sounds)).unwrap_or(json!({}))
}

fn percent_decode(encoded: &str) -> String {
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(&encoded[index + 1..index + 3], 16)
        {
            out.push(byte);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A take: the WAV file as the request body, the text id and the part (URI-encoded) in the headers.
#[tauri::command]
async fn check(engine: State<'_, Shared>, request: tauri::ipc::Request<'_>) -> Result<Attempt, String> {
    let (text_id, part, wav) = take_request(&request, "x-part")?;
    let engine = engine.inner().clone();
    blocking(move || engine.check(&text_id, &part, &wav)).await
}

/// A take of one word alone: the WAV file as the request body, the text id and the word (URI-encoded) in the headers.
#[tauri::command]
async fn check_word(engine: State<'_, Shared>, request: tauri::ipc::Request<'_>) -> Result<Attempt, String> {
    let (text_id, word, wav) = take_request(&request, "x-word")?;
    let engine = engine.inner().clone();
    blocking(move || engine.check_word(&text_id, &word, &wav)).await
}

/// What a take sent to check or check_word carries: the text id, what was read (in the header `read`) and the WAV.
fn take_request(request: &tauri::ipc::Request<'_>, read: &str) -> Result<(String, String, Vec<u8>), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the recording as raw bytes".into());
    };
    let header = |name: &str| request.headers().get(name).and_then(|value| value.to_str().ok()).map(percent_decode).unwrap_or_default();
    Ok((header("x-text"), header(read), bytes.clone()))
}

#[tauri::command]
async fn download_models(app: AppHandle, engine: State<'_, Shared>) -> Result<(), String> {
    let dir = engine.models.clone();
    models::download_missing(&app, &dir).await?;
    let engine = engine.inner().clone();
    std::thread::spawn(move || engine.warm());
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            }
            // macOS: ~/Library/Application Support/io.github.qwertymuzaffar.parrot (the first engine's folder too)
            let data = app.path().app_data_dir()?;
            std::fs::create_dir_all(data.join("texts"))?;
            let engine =
                Arc::new(Engine { models: data.join("models"), store: Store { data }, aligner: Mutex::new(None), recognizer: Mutex::new(None) });
            let warm = engine.clone();
            std::thread::spawn(move || warm.warm());
            app.manage(engine);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            info,
            texts,
            add_text,
            update_text,
            delete_text,
            scores,
            attempts,
            attempt,
            word_attempts,
            word_attempt,
            activity,
            pron,
            check,
            check_word,
            download_models
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<Shared>().unload();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Stands in for the models: every word placed one second apart and said clearly, and `heard` heard.
    struct FakeListener {
        heard: &'static str,
        aligned: RefCell<Vec<String>>,
    }

    impl FakeListener {
        fn hearing(heard: &'static str) -> Self {
            FakeListener { heard, aligned: RefCell::new(Vec::new()) }
        }
    }

    impl Listen for FakeListener {
        fn align(&self, _audio: &[f32], text: &str) -> Result<Vec<text::WordTime>, String> {
            self.aligned.borrow_mut().push(text.to_string());
            let word_time =
                |word_index: usize| text::WordTime { t: Some([word_index as f64, word_index as f64 + 1.0]), score: Some(0.9), letters: None };
            Ok((0..text.split_whitespace().count()).map(word_time).collect())
        }

        fn transcribe(&self, _audio: &[f32], _words: &[text::WordTime]) -> Result<String, String> {
            Ok(self.heard.to_string())
        }
    }

    fn statuses(scored: &Scored) -> Vec<WordStatus> {
        scored.words.iter().map(|word| word.status).collect()
    }

    #[test]
    fn a_whole_take_scores_every_word() {
        let listener = FakeListener::hearing("the cat sat down");
        let scored = score_take(&listener, &[], 2.0, "the cat sat down").unwrap();
        assert_eq!((scored.score, scored.wpm), (100, 120));
        assert_eq!(statuses(&scored), vec![WordStatus::Good; 4]);
        assert_eq!(*listener.aligned.borrow(), vec!["the cat sat down"]);
    }

    #[test]
    fn a_misheard_word_is_wrong_and_the_rest_still_count() {
        let listener = FakeListener::hearing("the beautiful sinks");
        let scored = score_take(&listener, &[], 1.5, "the beautiful things").unwrap();
        assert_eq!(statuses(&scored), vec![WordStatus::Good, WordStatus::Good, WordStatus::Wrong]);
        // a misheard last word was still read, so it counts toward the pace
        assert_eq!((scored.score, scored.wpm), (67, 120));
        assert_eq!(listener.aligned.borrow().len(), 1, "no second pass when the take reached the end");
    }

    #[test]
    fn a_take_stopped_early_scores_only_what_was_said() {
        let listener = FakeListener::hearing("the cat");
        let scored = score_take(&listener, &[], 1.0, "the cat sat down").unwrap();
        // placed again with only the words said, and the rest missed
        assert_eq!(*listener.aligned.borrow(), vec!["the cat sat down", "the cat"]);
        assert_eq!(statuses(&scored), vec![WordStatus::Good, WordStatus::Good, WordStatus::Wrong, WordStatus::Wrong]);
        assert_eq!(scored.words[2].score, Some(0.0));
        assert_eq!(scored.words[0].t, Some([0.0, 1.0]));
        // the pace counts the two words said, not the whole text
        assert_eq!((scored.score, scored.wpm), (50, 120));
    }

    #[test]
    fn nothing_heard_is_all_missed() {
        let listener = FakeListener::hearing("");
        let scored = score_take(&listener, &[], 1.0, "the cat").unwrap();
        assert_eq!(statuses(&scored), vec![WordStatus::Wrong; 2]);
        assert_eq!(scored.score, 0);
        assert_eq!(listener.aligned.borrow().len(), 1);
    }

    #[test]
    fn a_word_alone_is_judged_by_both_checks_and_scored_by_its_sound() {
        let listener = FakeListener::hearing("There.");
        let scored = score_word(&listener, &[], 0.6, store::bare("there?")).unwrap();
        assert_eq!(*listener.aligned.borrow(), vec!["there"]);
        assert_eq!((scored.score, statuses(&scored)), (90, vec![WordStatus::Good]));
        // misheard, it is still scored by how clearly it was said, and the verdict says what was heard
        let misheard = score_word(&FakeListener::hearing("Hair."), &[], 0.6, "there").unwrap();
        assert_eq!((misheard.score, statuses(&misheard), misheard.words[0].heard.as_deref()), (90, vec![WordStatus::Wrong], Some("hair")));
        assert_eq!(score_word(&FakeListener::hearing(""), &[], 0.6, "there").unwrap().words[0].status, WordStatus::Wrong);
    }

    /// A take through the whole engine, as the app runs it: needs the models on this machine.
    /// cargo test --lib whole_take -- --ignored --nocapture
    #[test]
    #[ignore]
    fn whole_take() {
        let home = PathBuf::from(std::env::var("HOME").unwrap());
        let models = home.join("Library/Application Support/io.github.qwertymuzaffar.parrot/models");
        let data = std::env::temp_dir().join(format!("parrot-e2e-{}", std::process::id()));
        std::fs::create_dir_all(data.join("texts")).unwrap();
        let engine = Engine { store: Store { data: data.clone() }, models, aligner: Mutex::new(None), recognizer: Mutex::new(None) };
        let text = "The northern lights are one of the most beautiful things you can see in the night sky.";
        let added = engine.store.add(text, Some("Lights".into()), Some("sentences".into())).unwrap();
        let id = added.id;
        let wav = std::fs::read(std::env::var("PARROT_TAKE").unwrap()).unwrap();
        let started = std::time::Instant::now();
        let attempt = engine.check(&id, text, &wav).unwrap();
        eprintln!("{:.1} s · score {} · {} wpm · heard: {}", started.elapsed().as_secs_f64(), attempt.score, attempt.wpm, attempt.heard);
        for word in attempt.words.iter().filter(|word| word.status != WordStatus::Good) {
            eprintln!("  {} {:?} heard={:?} score={:?}", word.w, word.status, word.heard, word.score);
        }
        if let Ok(out) = std::env::var("PARROT_E2E_OUT") {
            std::fs::write(out, serde_json::to_string(&attempt.words).unwrap()).unwrap();
        }
        let things = attempt.words.iter().find(|word| word.w == "things").unwrap();
        let letters = things.letters.as_ref().unwrap();
        eprintln!("  things letters: {letters:?}");
        let th = (letters[0].unwrap() + letters[1].unwrap()) / 2.0;
        let rest = letters[2..].iter().map(|letter| letter.unwrap()).sum::<f64>() / 4.0;
        assert!(th < rest, "the th of things said as sinks scores lowest: {th} vs {rest}");
        assert!(data.join(&attempt.audio).exists(), "the take is saved");
        assert_eq!(engine.store.attempts(&id, text).unwrap().len(), 1);
        assert_eq!(engine.store.scores(&id).unwrap().values().next().unwrap().last, attempt.score);
        assert!(attempt.words.iter().any(|word| word.w == "things" && word.status == WordStatus::Wrong && word.heard.as_deref() == Some("sinks")));
        let silent = {
            let silence_path = data.join("silence.wav");
            audio::write_wav(&silence_path, &audio::Pcm { samples: vec![0.0; 48000], rate: 48000 }).unwrap();
            std::fs::read(silence_path).unwrap()
        };
        assert!(engine.check(&id, text, &silent).unwrap_err().contains("Nothing was heard"));
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn headers_decode() {
        assert_eq!(super::percent_decode("I%E2%80%99m%20here%2C%20ok"), "I’m here, ok");
        assert_eq!(super::percent_decode("plain"), "plain");
    }
}
