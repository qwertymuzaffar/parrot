//! The two speech models Parrot needs, downloaded into the app's data folder the first time it opens (on Windows,
//! the local one: see lib.rs).

use futures_util::StreamExt;
use reqwest::StatusCode;
use reqwest::header::{CONTENT_RANGE, RANGE};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct Model {
    pub key: &'static str,
    pub file: &'static str,
    pub url: &'static str,
    /// the size it should have, to tell a finished download from a broken one
    pub bytes: u64,
    /// its SHA-256 (lower-case hex), to tell the right file from a damaged or replaced one
    pub sha256: &'static str,
}

/// pinned to a commit of the model repository, so an upstream re-upload cannot change what Parrot gets
pub const WHISPER: Model = Model {
    key: "whisper",
    file: "ggml-small.en.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.en.bin",
    bytes: 487_614_201,
    sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
};

/// jonatasgrosman/wav2vec2-large-xlsr-53-english (Apache 2.0), exported to ONNX and quantised to 8 bits
pub const ALIGNER: Model = Model {
    key: "aligner",
    file: "wav2vec2-xlsr-53-english-int8.onnx",
    url: "https://github.com/qwertymuzaffar/parrot/releases/download/models-v1/wav2vec2-xlsr-53-english-int8.onnx",
    bytes: 317_292_394,
    sha256: "29a3de614cd24ea8b28c9f6d98ff674843db2273e666bcf1444da71d9aec3b7e",
};

pub const ALL: [&Model; 2] = [&WHISPER, &ALIGNER];

/// how long a download may receive nothing before it counts as stalled
const STALL: Duration = Duration::from_secs(30);

pub fn path(dir: &Path, model: &Model) -> PathBuf {
    dir.join(model.file)
}

/// A model is ready when its file is there at the full size (a link to a file of that size counts).
pub fn ready(dir: &Path, model: &Model) -> bool {
    std::fs::metadata(path(dir, model)).map(|md| md.len() == model.bytes).unwrap_or(false)
}

/// Rename a model file that would not load to <file>.bad, so it no longer counts as ready and Setup downloads it
/// again; returns the message to show instead of `error`, the load's own (kept if the file could not be moved).
pub fn set_aside(dir: &Path, model: &Model, error: String) -> String {
    let bad = dir.join(format!("{}.bad", model.file));
    let _ = std::fs::remove_file(&bad);
    match std::fs::rename(path(dir, model), &bad) {
        Ok(()) => {
            log::warn!("set {} aside: {error}", model.file);
            format!("{} is damaged; restart Parrot to download it again", model.file)
        }
        Err(_) => error,
    }
}

/// Move the models (whole or half downloaded) from `old` to `new`, where Parrot keeps them now. A file `new` already
/// has is left in `old` as it is: the one in `new` may be newer, and nothing is overwritten. Running it again moves
/// nothing more. Only the models' own files are touched, never anything else in either folder. Only Windows calls it,
/// but it is built everywhere so its tests run everywhere.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn migrate(old: &Path, new: &Path) -> std::io::Result<()> {
    let names = ALL.iter().flat_map(|model| [model.file.to_string(), format!("{}.part", model.file)]);
    for name in names {
        let (from, to) = (old.join(&name), new.join(&name));
        if !std::fs::symlink_metadata(&from).is_ok_and(|metadata| metadata.is_file()) || to.exists() {
            continue;
        }
        std::fs::create_dir_all(new)?;
        if std::fs::rename(&from, &to).is_err() {
            // another volume (a redirected profile): copy under a name the app ignores, then put it in place, so a
            // copy cut short never passes for a model
            let moving = new.join(format!("{name}.moving"));
            std::fs::copy(&from, &moving)?;
            std::fs::rename(&moving, &to)?;
            std::fs::remove_file(&from)?;
        }
    }
    // gone once it is empty; a folder with anything else left in it stays
    let _ = std::fs::remove_dir(old);
    Ok(())
}

#[derive(Serialize, Clone)]
struct Progress<'a> {
    model: &'a str,
    received: u64,
    total: u64,
}

/// Download every missing model, reporting "model-progress" events as it goes. A partial file is kept as
/// <file>.part and continued on the next try; the file is renamed into place only once its SHA-256 matches.
pub async fn download_missing(app: &AppHandle, dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let client =
        reqwest::Client::builder().user_agent("Parrot").connect_timeout(STALL).read_timeout(STALL).build().map_err(|error| error.to_string())?;
    for model in ALL {
        if ready(dir, model) {
            continue;
        }
        let part = dir.join(format!("{}.part", model.file));
        download(app, &client, model, &part).await?;
        std::fs::rename(&part, path(dir, model)).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Bring <file>.part to the full, verified model, asking only for the bytes it does not have yet.
async fn download(app: &AppHandle, client: &reqwest::Client, model: &Model, part: &Path) -> Result<(), String> {
    let mut have = std::fs::metadata(part).map(|md| md.len()).unwrap_or(0);
    if have > model.bytes {
        // longer than the model: not the start of it
        std::fs::remove_file(part).map_err(|error| error.to_string())?;
        have = 0;
    }
    let mut hasher = Sha256::new();
    if have < model.bytes {
        let mut request = client.get(model.url);
        if have > 0 {
            request = request.header(RANGE, format!("bytes={have}-"));
        }
        let res = request.send().await.map_err(|error| format!("could not download {}: {error}", model.file))?;
        let status = res.status();
        let content_range = res.headers().get(CONTENT_RANGE).and_then(|value| value.to_str().ok());
        let Some(start) = body_starts_at(have, status, content_range) else {
            if status == StatusCode::PARTIAL_CONTENT || status == StatusCode::RANGE_NOT_SATISFIABLE {
                // the server would not continue this .part: start over on the next try
                let _ = std::fs::remove_file(part);
            }
            return Err(format!("could not download {}: {status}; try again", model.file));
        };
        let mut out = if start == 0 {
            File::create(part).map_err(|error| error.to_string())?
        } else {
            hash_file(&mut hasher, part)?;
            OpenOptions::new().append(true).open(part).map_err(|error| error.to_string())?
        };
        let mut received = start;
        let mut last = received;
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("the download of {} stopped: {error}; try again", model.file))?;
            out.write_all(&chunk).map_err(|error| error.to_string())?;
            hasher.update(&chunk);
            received += chunk.len() as u64;
            if received > model.bytes {
                drop(out);
                let _ = std::fs::remove_file(part);
                return Err(format!("{} arrived larger than {} bytes; try again", model.file, model.bytes));
            }
            if received - last > 1_000_000 || received == model.bytes {
                last = received;
                let _ = app.emit("model-progress", Progress { model: model.key, received, total: model.bytes });
            }
        }
        out.flush().map_err(|error| error.to_string())?;
        drop(out);
        if received != model.bytes {
            return Err(format!("{} arrived incomplete ({received} of {} bytes); try again", model.file, model.bytes));
        }
    } else {
        // a full .part left by an earlier try that stopped before the rename
        hash_file(&mut hasher, part)?;
    }
    if hex(&hasher.finalize()) != model.sha256 {
        let _ = std::fs::remove_file(part);
        return Err(format!("{} arrived damaged (its SHA-256 is not the expected one); try again", model.file));
    }
    Ok(())
}

/// Where the body of a response to "Range: bytes=<have>-" goes in the file: after the bytes already there when the
/// server sent the rest (206 from exactly that byte), at the start when it sent the whole file instead (200);
/// None for anything else.
fn body_starts_at(have: u64, status: StatusCode, content_range: Option<&str>) -> Option<u64> {
    match status {
        StatusCode::OK => Some(0),
        StatusCode::PARTIAL_CONTENT if have > 0 => {
            // "bytes 1000-487614200/487614201"
            let first = content_range?.strip_prefix("bytes ")?.split('-').next()?.trim().parse::<u64>().ok()?;
            (first == have).then_some(have)
        }
        _ => None,
    }
}

fn hash_file(hasher: &mut Sha256, file: &Path) -> Result<(), String> {
    let mut reader = File::open(file).map_err(|error| error.to_string())?;
    std::io::copy(&mut reader, hasher).map_err(|error| error.to_string())?;
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn a_resumed_download_continues_only_from_the_byte_asked_for() {
        assert_eq!(body_starts_at(0, StatusCode::OK, None), Some(0));
        assert_eq!(body_starts_at(1000, StatusCode::PARTIAL_CONTENT, Some("bytes 1000-487614200/487614201")), Some(1000));
        // the server ignored the range and sent the whole file: start over
        assert_eq!(body_starts_at(1000, StatusCode::OK, None), Some(0));
        assert_eq!(body_starts_at(1000, StatusCode::PARTIAL_CONTENT, Some("bytes 0-487614200/487614201")), None);
        assert_eq!(body_starts_at(1000, StatusCode::PARTIAL_CONTENT, None), None);
        assert_eq!(body_starts_at(0, StatusCode::PARTIAL_CONTENT, Some("bytes 0-99/100")), None);
        assert_eq!(body_starts_at(1000, StatusCode::RANGE_NOT_SATISFIABLE, Some("bytes */1000")), None);
        assert_eq!(body_starts_at(0, StatusCode::NOT_FOUND, None), None);
    }

    #[test]
    fn a_part_and_its_rest_hash_like_the_whole_file() {
        let part = std::env::temp_dir().join(format!("parrot-models-test-{}.part", std::process::id()));
        std::fs::write(&part, b"ab").unwrap();
        let mut hasher = Sha256::new();
        hash_file(&mut hasher, &part).unwrap();
        hasher.update(b"c");
        std::fs::remove_file(&part).unwrap();
        // the SHA-256 of "abc" (FIPS 180-2)
        assert_eq!(hex(&hasher.finalize()), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn every_model_is_pinned_and_has_a_full_hash() {
        for model in ALL {
            assert_eq!(model.sha256.len(), 64, "{}", model.file);
            assert!(model.sha256.chars().all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase()), "{}", model.file);
            assert!(!model.url.contains("/resolve/main/"), "{} follows a moving branch", model.file);
        }
    }

    fn folders(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("parrot-migrate-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        (root.join("roaming/models"), root.join("local/models"), root)
    }

    #[test]
    fn models_move_to_the_new_folder() {
        let (old, new, root) = folders("move");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join(WHISPER.file), "whisper").unwrap();
        fs::write(old.join(format!("{}.part", ALIGNER.file)), "half").unwrap();
        migrate(&old, &new).unwrap();
        assert_eq!(fs::read_to_string(new.join(WHISPER.file)).unwrap(), "whisper");
        assert_eq!(fs::read_to_string(new.join(format!("{}.part", ALIGNER.file))).unwrap(), "half");
        assert!(!old.exists(), "the emptied old folder is gone");
        // again: nothing to move, nothing changes
        migrate(&old, &new).unwrap();
        assert_eq!(fs::read_dir(&new).unwrap().count(), 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_model_already_in_the_new_folder_is_not_overwritten() {
        let (old, new, root) = folders("keep");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(old.join(WHISPER.file), "old").unwrap();
        fs::write(new.join(WHISPER.file), "new").unwrap();
        fs::write(old.join(ALIGNER.file), "aligner").unwrap();
        fs::write(old.join("notes.txt"), "mine").unwrap();
        migrate(&old, &new).unwrap();
        assert_eq!(fs::read_to_string(new.join(WHISPER.file)).unwrap(), "new");
        assert_eq!(fs::read_to_string(old.join(WHISPER.file)).unwrap(), "old", "the old copy is left alone");
        assert_eq!(fs::read_to_string(new.join(ALIGNER.file)).unwrap(), "aligner");
        assert!(!old.join(ALIGNER.file).exists());
        assert!(old.join("notes.txt").exists() && !new.join("notes.txt").exists(), "only the models' files move");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn no_old_folder_is_nothing_to_do() {
        let (old, new, root) = folders("none");
        migrate(&old, &new).unwrap();
        assert!(!new.exists(), "no empty folder made for nothing");
        let _ = fs::remove_dir_all(root);
    }
}
