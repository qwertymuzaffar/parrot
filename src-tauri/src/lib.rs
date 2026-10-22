//! Parrot's engine, inside the app: the interface calls these commands. Texts and tries are files in the app's
//! data folder (store.rs); a take is cleaned (audio.rs), placed word by word and scored (align.rs), heard by
//! Whisper (asr.rs) and judged word by word (text.rs).

mod align;
mod asr;
mod audio;
mod models;
mod sounds;
mod store;
mod talk;
mod text;
mod updates;

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, TryLockError};
use store::{Activity, Attempt, AttemptSummary, PartScore, Store, TextItem};
use tauri::{AppHandle, Emitter, Manager, State};
use text::WordStatus;

pub struct Engine {
    store: Store,
    models: PathBuf,
    aligner: Mutex<Option<align::Aligner>>,
    recognizer: Mutex<Option<asr::Recognizer>>,
}

type Shared = Arc<Engine>;

/// What to say of a take with nothing in it that could be a voice.
const NOTHING_HEARD: &str = "Nothing was heard in the recording. Is the microphone on?";

/// What to say of a take of nothing but exact zeros. A microphone always picks up some noise, even in a quiet room:
/// exact zeros are the system keeping it from Parrot, and on macOS the webview then records silence instead of failing.
const MICROPHONE_WITHHELD: &str = if cfg!(target_os = "macos") {
    "Parrot got only silence from the microphone: macOS may not be letting it listen. Allow Parrot in System Settings → Privacy & Security → Microphone, then quit and reopen it."
} else if cfg!(windows) {
    "Parrot got only silence from the microphone: Windows may not be letting it listen. Allow it in Settings → Privacy & security → Microphone, then quit and reopen Parrot."
} else {
    "Parrot got only silence from the microphone. Check that it isn't muted and that Parrot may use it, then quit and reopen Parrot."
};

impl Engine {
    fn with_aligner<T>(&self, work: impl FnOnce(&mut align::Aligner) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.aligner.lock().unwrap_or_else(PoisonError::into_inner);
        if guard.is_none() {
            // ONNX Runtime not starting is not the model file's fault: no download would mend it
            align::environment()?;
            *guard = Some(self.load(&models::ALIGNER, align::Aligner::load)?);
        }
        work(guard.as_mut().unwrap())
    }

    fn with_recognizer<T>(&self, work: impl FnOnce(&asr::Recognizer) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.recognizer.lock().unwrap_or_else(PoisonError::into_inner);
        if guard.is_none() {
            *guard = Some(self.load(&models::WHISPER, asr::Recognizer::load)?);
        }
        work(guard.as_ref().unwrap())
    }

    /// Load a model. A file that is there but will not load (damaged, or not the model) is set aside, so the next start
    /// shows Setup and downloads it again instead of every take failing.
    fn load<M>(&self, model: &models::Model, load: impl FnOnce(&Path) -> Result<M, String>) -> Result<M, String> {
        if !models::ready(&self.models, model) {
            return Err(format!("{} is missing or damaged; restart Parrot to download it again", model.file));
        }
        load(&models::path(&self.models, model)).map_err(|error| models::set_aside(&self.models, model, error))
    }

    /// Let go of both models before the app quits. whisper.cpp frees its Metal device as the process exits and aborts
    /// if the model's buffers are still alive then, so the recognizer must be gone first. A model busy with a take is
    /// left as it is rather than holding up the quit.
    fn unload(&self) {
        if let Some(mut recognizer) = lock_unless_busy(&self.recognizer) {
            recognizer.take();
        }
        if let Some(mut aligner) = lock_unless_busy(&self.aligner) {
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
    fn keep_take(&self, dir: &Path, txt: &str, wav: &[u8], score: Scorer<Self>) -> Result<Attempt, String> {
        let raw = audio::read_wav(wav)?;
        if audio::blank(&raw) {
            return Err(MICROPHONE_WITHHELD.into());
        }
        let take = audio::clean(raw).filter(|cleaned| cleaned.seconds() >= audio::SHORTEST_TAKE).ok_or(NOTHING_HEARD)?;
        let secs = take.seconds();
        let scored = score(self, &audio::resample(&take, 16000), secs, txt, &self.store.names())?;
        // not create_dir_all: a text deleted while the take was scored must not come back as a folder of its tries
        match std::fs::create_dir(dir) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err("the text was deleted".into()),
            Err(error) if error.kind() != std::io::ErrorKind::AlreadyExists => return Err(error.to_string()),
            _ => {}
        }
        let now = chrono::Local::now();
        let id = Store::new_try(dir, &now.format("%Y%m%d-%H%M%S").to_string())?;
        let file = dir.join(format!("{id}.wav"));
        audio::write_wav(&file, &take).inspect_err(|_| {
            let _ = std::fs::remove_file(&file);
        })?;
        let pauses = text::pauses(&scored.words);
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
            pauses,
            cut: None,
        };
        self.store.save_attempt(dir, &attempt)?;
        Ok(attempt)
    }
}

/// A model's lock, unless a take holds it now. A take that panicked leaves the lock poisoned, not the model gone,
/// so that counts as free: its model must still be let go of before quitting.
fn lock_unless_busy<T>(mutex: &Mutex<T>) -> Option<MutexGuard<'_, T>> {
    match mutex.try_lock() {
        Ok(guard) => Some(guard),
        Err(TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
        Err(TryLockError::WouldBlock) => None,
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

/// How a take is judged: as a part (score_take) or as a word alone (score_word).
type Scorer<L> = fn(&L, &[f32], f64, &str, &[String]) -> Result<Scored, String>;

/// A take judged against its text, before it is saved.
struct Scored {
    heard: String,
    words: Vec<text::WordResult>,
    score: i64,
    wpm: i64,
}

/// Judge a take (16 kHz, `secs` long) of `txt` word by word; `names` are never misheard.
fn score_take(listener: &impl Listen, audio: &[f32], secs: f64, txt: &str, names: &[String]) -> Result<Scored, String> {
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
    let mut words = text::judge(txt, &heard, &mine, None);
    text::spare_names(&mut words, names);
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
fn score_word(listener: &impl Listen, audio: &[f32], secs: f64, word: &str, names: &[String]) -> Result<Scored, String> {
    let mut scored = score_take(listener, audio, secs, word, names)?;
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
fn delete_attempt(engine: State<'_, Shared>, text: String, part: String, id: String) -> Result<(), String> {
    engine.store.delete_attempt(&text, &part, &id)
}

#[tauri::command]
fn delete_word_attempt(engine: State<'_, Shared>, text: String, word: String, id: String) -> Result<(), String> {
    engine.store.delete_word_attempt(&text, &word, &id)
}

/// How much the deleted texts in the trash take, in bytes.
#[tauri::command]
async fn trash_size(engine: State<'_, Shared>) -> Result<u64, String> {
    let engine = engine.inner().clone();
    blocking(move || Ok(engine.store.trash_size())).await
}

/// Erase the deleted texts now rather than TRASH_DAYS on; what is left in the trash, in bytes.
#[tauri::command]
async fn empty_trash(engine: State<'_, Shared>) -> Result<u64, String> {
    let engine = engine.inner().clone();
    blocking(move || Ok(engine.store.empty_trash())).await
}

/// Show the data folder in the file manager. Only ever this folder, so the interface needs no permission to open paths.
#[tauri::command]
fn open_data_folder(engine: State<'_, Shared>) -> Result<(), String> {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    let mut child =
        std::process::Command::new(opener).arg(&engine.store.data).spawn().map_err(|error| format!("could not open the data folder: {error}"))?;
    // waited for elsewhere, so it doesn't linger as a zombie; explorer's exit code means nothing
    std::thread::spawn(move || child.wait());
    Ok(())
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

/// The words never counted as misheard, in every text.
#[tauri::command]
fn names(engine: State<'_, Shared>) -> Vec<String> {
    engine.store.names()
}

/// Mark a word as a name, or not; the names after.
#[tauri::command]
fn set_name(engine: State<'_, Shared>, word: String, name: bool) -> Result<Vec<String>, String> {
    engine.store.set_name(&word, name)
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
        // on bytes, not the string: the two after a % may be part of a character ("%aé")
        let decoded = bytes
            .get(index + 1..index + 3)
            .filter(|hex| bytes[index] == b'%' && hex.iter().all(u8::is_ascii_hexdigit))
            .and_then(|hex| u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok());
        if let Some(byte) = decoded {
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

/// Start a talk recorded at `rate` (Hz). Its sound follows in blocks (talk_feed).
#[tauri::command]
fn talk_start(talks: State<'_, Arc<talk::Talks>>, rate: u32) -> Result<(), String> {
    talks.start(rate)
}

/// More of the talk under way: 16-bit little-endian samples as the request body.
#[tauri::command]
fn talk_feed(talks: State<'_, Arc<talk::Talks>>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the talk's sound as raw bytes".into());
    };
    talks.feed(bytes)
}

/// Stop the talk and write down what was said, reporting "talk-progress" events (seconds done, of the total).
#[tauri::command]
async fn talk_stop(app: AppHandle, engine: State<'_, Shared>, talks: State<'_, Arc<talk::Talks>>) -> Result<talk::Heard, String> {
    let (engine, talks) = (engine.inner().clone(), talks.inner().clone());
    blocking(move || talks.write_down(&*engine, |done, total| drop(app.emit("talk-progress", json!({ "done": done, "total": total }))))).await
}

/// Keep the talk written down as a text: `text` is what was said, as the user corrected it, practised whole, and the
/// recording is its first take.
#[tauri::command]
async fn talk_keep(engine: State<'_, Shared>, talks: State<'_, Arc<talk::Talks>>, text: String, title: Option<String>) -> Result<talk::Kept, String> {
    let (engine, talks) = (engine.inner().clone(), talks.inner().clone());
    blocking(move || talks.keep(&*engine, &engine.store, &text, title)).await
}

/// Stop writing down the talk; its recording is kept, to write down again or discard.
#[tauri::command]
fn talk_cancel(talks: State<'_, Arc<talk::Talks>>) {
    talks.cancel();
}

/// The talk left from the last time Parrot ran, if any: to write down (again) or discard.
#[tauri::command]
fn talk_left(talks: State<'_, Arc<talk::Talks>>) -> Option<talk::Left> {
    talks.left()
}

/// The waveform of a recording: the loudest moment of each of `slices` equal slices, the loudest being 1.
#[tauri::command]
async fn peaks(engine: State<'_, Shared>, audio: String, slices: usize) -> Result<Vec<f32>, String> {
    let engine = engine.inner().clone();
    blocking(move || audio::peaks_file(&engine.store.recording(&audio)?, slices)).await
}

/// A stretch of a recording (a word to play), from `from` to `to` seconds: its rate (4 bytes) and its samples
/// (16-bit), little-endian, as raw bytes.
#[tauri::command]
async fn clip(engine: State<'_, Shared>, audio: String, from: f64, to: f64) -> Result<tauri::ipc::Response, String> {
    let engine = engine.inner().clone();
    let (rate, samples) = blocking(move || audio::clip_file(&engine.store.recording(&audio)?, from, to)).await?;
    let mut bytes = rate.to_le_bytes().to_vec();
    bytes.extend(samples.iter().flat_map(|sample| sample.to_le_bytes()));
    Ok(tauri::ipc::Response::new(bytes))
}

/// Drop the talk and its recording.
#[tauri::command]
async fn talk_discard(talks: State<'_, Arc<talk::Talks>>) -> Result<(), String> {
    let talks = talks.inner().clone();
    // waits for a writing-down under way to see the cancel and stop
    blocking(move || talks.discard()).await
}

#[tauri::command]
async fn download_models(app: AppHandle, engine: State<'_, Shared>) -> Result<(), String> {
    let dir = engine.models.clone();
    models::download_missing(&app, &dir).await?;
    let engine = engine.inner().clone();
    std::thread::spawn(move || engine.warm());
    Ok(())
}

/// The latest release on GitHub: asked only when the user clicks "Check for updates" in Settings.
#[tauri::command]
async fn latest_release() -> Result<updates::Release, String> {
    updates::latest().await
}

/// Open one of Parrot's own pages (a release, the website) in the system browser.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    updates::open(&url)
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
            // Windows: app_data_dir is the roaming profile, which domain machines copy to a server at every sign-in, so
            // the 800 MB of models go to the local one (%LOCALAPPDATA%) and the ones an older Parrot put there move over
            #[cfg(target_os = "windows")]
            let models = {
                let local = app.path().app_local_data_dir()?.join("models");
                if let Err(error) = models::migrate(&data.join("models"), &local) {
                    log::warn!("could not move the models to {}: {error}", local.display());
                }
                local
            };
            #[cfg(not(target_os = "windows"))]
            let models = data.join("models");
            app.manage(Arc::new(talk::Talks::open(data.join("talks"))));
            let engine = Arc::new(Engine { models, store: Store { data }, aligner: Mutex::new(None), recognizer: Mutex::new(None) });
            let warm = engine.clone();
            std::thread::spawn(move || {
                // deleted texts are erased for good TRASH_DAYS on, as the confirmation says
                warm.store.expire_trash(chrono::Local::now().naive_local());
                warm.warm();
            });
            app.manage(engine);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            info,
            texts,
            add_text,
            update_text,
            delete_text,
            delete_attempt,
            delete_word_attempt,
            trash_size,
            empty_trash,
            open_data_folder,
            scores,
            attempts,
            attempt,
            word_attempts,
            word_attempt,
            activity,
            names,
            set_name,
            pron,
            check,
            check_word,
            talk_start,
            talk_feed,
            talk_stop,
            talk_cancel,
            talk_keep,
            talk_discard,
            talk_left,
            peaks,
            clip,
            download_models,
            latest_release,
            open_url
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
        let scored = score_take(&listener, &[], 2.0, "the cat sat down", &[]).unwrap();
        assert_eq!((scored.score, scored.wpm), (100, 120));
        assert_eq!(statuses(&scored), vec![WordStatus::Good; 4]);
        assert_eq!(*listener.aligned.borrow(), vec!["the cat sat down"]);
    }

    #[test]
    fn a_misheard_word_is_wrong_and_the_rest_still_count() {
        let listener = FakeListener::hearing("the beautiful sinks");
        let scored = score_take(&listener, &[], 1.5, "the beautiful things", &[]).unwrap();
        assert_eq!(statuses(&scored), vec![WordStatus::Good, WordStatus::Good, WordStatus::Wrong]);
        // a misheard last word was still read, so it counts toward the pace
        assert_eq!((scored.score, scored.wpm), (67, 120));
        assert_eq!(listener.aligned.borrow().len(), 1, "no second pass when the take reached the end");
    }

    #[test]
    fn a_misheard_name_does_not_count_against_the_take() {
        let listener = FakeListener::hearing("I'm Mozafar from Tashkent");
        let names = vec!["muzaffar".to_string()];
        let scored = score_take(&listener, &[], 2.0, "I'm Muzaffar from Tashkent", &names).unwrap();
        assert_eq!(statuses(&scored), vec![WordStatus::Good; 4]);
        assert_eq!((scored.score, scored.words[1].heard.as_deref()), (100, Some("mozafar")));
        assert_eq!(score_take(&listener, &[], 2.0, "I'm Muzaffar from Tashkent", &[]).unwrap().score, 75, "not a name, it is misheard");
    }

    #[test]
    fn a_take_stopped_early_scores_only_what_was_said() {
        let listener = FakeListener::hearing("the cat");
        let scored = score_take(&listener, &[], 1.0, "the cat sat down", &[]).unwrap();
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
        let scored = score_take(&listener, &[], 1.0, "the cat", &[]).unwrap();
        assert_eq!(statuses(&scored), vec![WordStatus::Wrong; 2]);
        assert_eq!(scored.score, 0);
        assert_eq!(listener.aligned.borrow().len(), 1);
    }

    #[test]
    fn a_word_alone_is_judged_by_both_checks_and_scored_by_its_sound() {
        let listener = FakeListener::hearing("There.");
        let scored = score_word(&listener, &[], 0.6, store::bare("there?"), &[]).unwrap();
        assert_eq!(*listener.aligned.borrow(), vec!["there"]);
        assert_eq!((scored.score, statuses(&scored)), (90, vec![WordStatus::Good]));
        // misheard, it is still scored by how clearly it was said, and the verdict says what was heard
        let misheard = score_word(&FakeListener::hearing("Hair."), &[], 0.6, "there", &[]).unwrap();
        assert_eq!((misheard.score, statuses(&misheard), misheard.words[0].heard.as_deref()), (90, vec![WordStatus::Wrong], Some("hair")));
        assert_eq!(score_word(&FakeListener::hearing(""), &[], 0.6, "there", &[]).unwrap().words[0].status, WordStatus::Wrong);
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
            // a quiet room: some noise, far under any voice (exact zeros are a withheld microphone)
            let room = (0..48000).map(|sample_index| 0.0003 * (sample_index as f32 * 0.37).sin()).collect();
            audio::write_wav(&silence_path, &audio::Pcm { samples: room, rate: 48000 }).unwrap();
            std::fs::read(silence_path).unwrap()
        };
        assert!(engine.check(&id, text, &silent).unwrap_err().contains("Nothing was heard"));
        let _ = std::fs::remove_dir_all(data);
    }

    /// A talk through the whole engine, fed in blocks as the interface sends it: needs the models on this machine
    /// and a recording of speech (any length up to ten minutes, 16-bit mono).
    /// PARROT_TALK=talk.wav cargo test --release --lib whole_talk -- --ignored --nocapture
    #[test]
    #[ignore]
    fn whole_talk() {
        let home = PathBuf::from(std::env::var("HOME").unwrap());
        let models = home.join("Library/Application Support/io.github.qwertymuzaffar.parrot/models");
        let data = std::env::temp_dir().join(format!("parrot-e2e-talk-{}", std::process::id()));
        let engine = Engine { store: Store { data: data.clone() }, models, aligner: Mutex::new(None), recognizer: Mutex::new(None) };
        engine.warm();
        let talks = talk::Talks::open(data.join("talks"));
        {
            // fed as the interface sends it, then let go: what the engine holds is what is measured
            let recording = audio::read_wav_file(std::path::Path::new(&std::env::var("PARROT_TALK").unwrap())).unwrap();
            talks.start(recording.rate).unwrap();
            for block in recording.samples.chunks(recording.rate as usize) {
                let bytes: Vec<u8> = block.iter().flat_map(|sample| ((sample * 32767.0) as i16).to_le_bytes()).collect();
                talks.feed(&bytes).unwrap();
            }
        }
        let started = std::time::Instant::now();
        let heard = talks.write_down(&engine, |done, total| eprintln!("  {done:.0} of {total:.0} s")).unwrap();
        let took = started.elapsed().as_secs_f64();
        eprintln!(
            "{took:.1} s for {:.0} s of talk ({:.0} s a minute) · score {} · {} wpm",
            heard.duration,
            took / heard.duration * 60.0,
            heard.score,
            heard.wpm
        );
        eprintln!("heard: {}", heard.heard);
        for word in heard.words.iter().filter(|word| word.status != WordStatus::Good) {
            eprintln!("  {} {:?} score={:?}", word.w, word.status, word.score);
        }
        eprintln!("pauses: {:?}", heard.pauses);
        assert!(
            heard.words.len() > 10 && heard.words.iter().filter(|word| word.t.is_some()).count() * 10 >= heard.words.len() * 9,
            "most words placed"
        );
        assert!(heard.words.windows(2).all(|pair| match (pair[0].t, pair[1].t) {
            (Some(first), Some(second)) => first[0] <= second[0],
            _ => true,
        }));
        // kept with one word corrected: that word is misheard, as what was written down
        std::fs::create_dir_all(data.join("texts")).unwrap();
        let written = heard.words.iter().position(|word| word.w.len() > 4).unwrap();
        let mut meant: Vec<String> = heard.heard.split_whitespace().map(String::from).collect();
        meant[written] = "Parakeet".into();
        let started = std::time::Instant::now();
        let kept = talks.keep(&engine, &engine.store, &meant.join(" "), None).unwrap();
        eprintln!("kept in {:.1} s · score {}", started.elapsed().as_secs_f64(), kept.attempt.score);
        assert_eq!(kept.attempt.words.len(), meant.len());
        assert_eq!(kept.attempt.words[written].status, WordStatus::Wrong);
        // a first try for each sentence, cut from the talk
        let said = kept.attempt.text.clone();
        let sentences = text::sentences(&said);
        let words: Vec<&str> = said.split_whitespace().collect();
        for sentence in &sentences {
            let part = words[sentence.clone()].join(" ");
            let tries = engine.store.attempts(&kept.text.id, &part).unwrap();
            let cut = engine.store.attempt(&kept.text.id, &part, &tries[0].id).unwrap();
            eprintln!("  {:5.1} s · {:3}% · {part}", cut.duration, cut.score);
        }
        // a sentence said twice is one part
        let distinct: std::collections::HashSet<String> = sentences.iter().map(|sentence| words[sentence.clone()].join(" ")).collect();
        assert_eq!(kept.text.scores.len(), distinct.len() + 1, "the whole text and each sentence");
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn a_model_that_will_not_load_is_set_aside_to_download_again() {
        let models = std::env::temp_dir().join(format!("parrot-damaged-{}", std::process::id()));
        std::fs::create_dir_all(&models).unwrap();
        // the full size, so it passes for ready, but all zeros: not a whisper model
        std::fs::File::create(models::path(&models, &models::WHISPER)).unwrap().set_len(models::WHISPER.bytes).unwrap();
        let engine =
            Engine { store: Store { data: models.clone() }, models: models.clone(), aligner: Mutex::new(None), recognizer: Mutex::new(None) };
        let error = engine.with_recognizer(|_| Ok(())).unwrap_err();
        assert!(error.contains("damaged; restart Parrot"), "{error}");
        assert!(!models::ready(&models, &models::WHISPER), "Setup offers the download again");
        assert!(models.join("ggml-small.en.bin.bad").exists());
        // later takes say the same, not "file not found"
        assert!(engine.with_recognizer(|_| Ok(())).unwrap_err().contains("restart Parrot"));
        let _ = std::fs::remove_dir_all(models);
    }

    #[test]
    fn a_take_of_a_deleted_text_is_not_kept() {
        let data = std::env::temp_dir().join(format!("parrot-deleted-take-{}", std::process::id()));
        let engine = Engine { store: Store { data: data.clone() }, models: data.clone(), aligner: Mutex::new(None), recognizer: Mutex::new(None) };
        let id = engine.store.add("Hello there.", None, None).unwrap().id;
        let part = engine.store.part_dir(&id, "Hello there.").unwrap();
        let tone: Vec<f32> =
            (0..16000).map(|sample_index| 0.5 * (2.0 * std::f32::consts::PI * 220.0 * sample_index as f32 / 16000.0).sin()).collect();
        let wav_path = data.join("take.wav");
        audio::write_wav(&wav_path, &audio::Pcm { samples: tone, rate: 16000 }).unwrap();
        let wav = std::fs::read(&wav_path).unwrap();
        // the text is deleted while the take is being scored
        let delete_while_scoring = |engine: &Engine, _audio: &[f32], _secs: f64, _txt: &str, _names: &[String]| {
            engine.store.delete(&engine.store.list()[0].id).unwrap();
            Ok(Scored { heard: String::new(), words: vec![], score: 0, wpm: 0 })
        };
        let error = engine.keep_take(&part, "Hello there.", &wav, delete_while_scoring).unwrap_err();
        assert_eq!(error, "the text was deleted");
        assert!(!data.join("texts").join(&id).exists(), "no folder of the text comes back");
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn a_saved_try_keeps_its_long_pauses() {
        let data = std::env::temp_dir().join(format!("parrot-pauses-{}", std::process::id()));
        let engine = Engine { store: Store { data: data.clone() }, models: data.clone(), aligner: Mutex::new(None), recognizer: Mutex::new(None) };
        let id = engine.store.add("Well, I think so.", None, None).unwrap().id;
        let part = engine.store.part_dir(&id, "Well, I think so.").unwrap();
        let tone: Vec<f32> =
            (0..48000).map(|sample_index| 0.5 * (2.0 * std::f32::consts::PI * 220.0 * sample_index as f32 / 16000.0).sin()).collect();
        let wav_path = data.join("take.wav");
        audio::write_wav(&wav_path, &audio::Pcm { samples: tone, rate: 16000 }).unwrap();
        let wav = std::fs::read(&wav_path).unwrap();
        // "Well," then 1.5 s before "I think so."
        let paused = |_: &Engine, _: &[f32], _: f64, txt: &str, _: &[String]| {
            let times = [[0.0, 0.3], [1.8, 1.9], [1.9, 2.2], [2.2, 2.5]].map(|t| text::WordTime { t: Some(t), score: Some(0.9), letters: None });
            Ok(Scored { heard: txt.into(), words: text::judge(txt, txt, &times, None), score: 100, wpm: 100 })
        };
        let attempt = engine.keep_take(&part, "Well, I think so.", &wav, paused).unwrap();
        assert_eq!(attempt.pauses, vec![(0, 1.5)]);
        assert_eq!(engine.store.attempt(&id, "Well, I think so.", &attempt.id).unwrap().pauses, vec![(0, 1.5)], "saved with the try");
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn a_take_of_exact_zeros_says_the_microphone_was_withheld() {
        let data = std::env::temp_dir().join(format!("parrot-withheld-{}", std::process::id()));
        let engine = Engine { store: Store { data: data.clone() }, models: data.clone(), aligner: Mutex::new(None), recognizer: Mutex::new(None) };
        let id = engine.store.add("Hello there.", None, None).unwrap().id;
        let part = engine.store.part_dir(&id, "Hello there.").unwrap();
        let take = |name: &str, samples: Vec<f32>| {
            let wav_path = data.join(name);
            audio::write_wav(&wav_path, &audio::Pcm { samples, rate: 48000 }).unwrap();
            std::fs::read(&wav_path).unwrap()
        };
        let unscored =
            |_: &Engine, _: &[f32], _: f64, _: &str, _: &[String]| -> Result<Scored, String> { panic!("a take of no sound is never scored") };
        let zeros = take("zeros.wav", vec![0.0; 48000]);
        assert_eq!(engine.keep_take(&part, "Hello there.", &zeros, unscored).unwrap_err(), MICROPHONE_WITHHELD);
        // a quiet room is a microphone that works, with no one speaking
        let room = take("room.wav", (0..48000).map(|sample_index| 0.0003 * (sample_index as f32 * 0.37).sin()).collect());
        assert!(engine.keep_take(&part, "Hello there.", &room, unscored).unwrap_err().contains("Nothing was heard"));
        assert!(engine.store.attempts(&id, "Hello there.").unwrap().is_empty(), "neither is kept");
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn headers_decode() {
        assert_eq!(super::percent_decode("I%E2%80%99m%20here%2C%20ok"), "I’m here, ok");
        assert_eq!(super::percent_decode("plain"), "plain");
        // a % before a character of more than one byte, or before something that is not two hex digits, stays as it is
        assert_eq!(super::percent_decode("%aé"), "%aé");
        assert_eq!(super::percent_decode("%é%+1%4"), "%é%+1%4");
    }

    #[test]
    fn a_panic_in_a_model_does_not_stop_the_next_take() {
        let models = std::env::temp_dir().join(format!("parrot-poisoned-{}", std::process::id()));
        let engine = Engine { store: Store { data: models.clone() }, models, aligner: Mutex::new(None), recognizer: Mutex::new(None) };
        // a panic while the model is in use poisons its lock
        std::thread::scope(|scope| {
            let _ = scope
                .spawn(|| {
                    let _guard = engine.recognizer.lock();
                    panic!("transcribe panicked");
                })
                .join();
        });
        assert!(engine.recognizer.is_poisoned());
        // the next take gets on with it (here: no model to load) instead of panicking
        assert!(engine.with_recognizer(|_| Ok(())).is_err());
        let poisoned = Mutex::new(Some(1));
        let _ = std::panic::catch_unwind(|| {
            let _guard = poisoned.lock();
            panic!("align panicked");
        });
        assert_eq!(lock_unless_busy(&poisoned).and_then(|mut slot| slot.take()), Some(1), "quitting still lets go of the model");
        let busy = Mutex::new(Some(2));
        let _held = busy.lock().unwrap();
        assert!(lock_unless_busy(&busy).is_none());
    }
}
