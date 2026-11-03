//! The reading voice: Kokoro (hexgrad/Kokoro-82M, Apache 2.0), an 82-million-parameter text-to-speech model that
//! reads like a person, run on the processor with ONNX Runtime from its export by thewh1teagle/kokoro-onnx. It
//! takes the phonemes of the text (phonemes.rs) as token ids, one of its voices as a 256-number style vector, and a
//! speed, and gives 24 kHz audio. The voices file is NumPy's npz: a zip of one array per voice, 510 style vectors
//! each, one per possible length of the token sequence.

use crate::phonemes;
use ort::session::Session;
use ort::value::Tensor;
use std::collections::HashMap;
use std::path::Path;
use std::sync::LazyLock;

pub const RATE: u32 = 24000;
/// the model's context: so many tokens at most between the pad at each end
const MAX_TOKENS: usize = 510;
const STYLE: usize = 256;

/// the token of each phoneme symbol
static VOCAB: LazyLock<HashMap<char, i64>> = LazyLock::new(|| {
    serde_json::from_str::<HashMap<String, i64>>(include_str!("../assets/kokoro-vocab.json"))
        .expect("the vocabulary")
        .into_iter()
        .filter_map(|(symbol, id)| symbol.chars().next().map(|character| (character, id)))
        .collect()
});

/// What the window says when ONNX Runtime fails on a reading: its own words are only for the log.
fn failed(error: ort::Error) -> String {
    log::error!("the voice failed: {error}");
    "the voice failed; try again".into()
}

pub struct Reader {
    session: Session,
    /// each voice's 510 style vectors, laid end to end
    voices: HashMap<String, Vec<f32>>,
}

impl Reader {
    /// The model and its voices; an error names the file that would not load.
    pub fn load(model: &Path, voices: &Path) -> Result<Self, String> {
        let session = Session::builder(crate::align::environment()?)
            .and_then(|mut builder| builder.commit_from_file(model))
            .map_err(|error| format!("could not load the voice: {error}"))?;
        let bytes = std::fs::read(voices).map_err(|error| format!("could not read the voices: {error}"))?;
        let voices = npz(&bytes).map_err(|error| format!("could not read the voices: {error}"))?;
        Ok(Self { session, voices })
    }

    /// The voices' names, in order: "af_heart" is American, female, Heart. Settings lists them (#362).
    #[allow(dead_code)]
    pub fn voices(&self) -> Vec<&str> {
        let mut names: Vec<&str> = self.voices.keys().map(String::as_str).collect();
        names.sort_unstable();
        names
    }

    /// A reading of `text` in `voice` at `speed` (1 as the voice speaks, 0.7 slower), as 24 kHz mono samples.
    pub fn read(&mut self, text: &str, voice: &str, speed: f32) -> Result<Vec<f32>, String> {
        let style = self.voices.get(voice).ok_or_else(|| format!("Parrot has no voice named {voice}"))?;
        let mut audio = vec![];
        for chunk in chunks(&phonemes::phonemize(text), MAX_TOKENS - 1) {
            let ids: Vec<i64> = chunk.chars().filter_map(|character| VOCAB.get(&character).copied()).collect();
            if ids.iter().all(|id| *id == VOCAB[&' ']) {
                continue;
            }
            let count = ids.len().min(MAX_TOKENS - 1);
            let mut tokens = Vec::with_capacity(count + 2);
            tokens.push(0);
            tokens.extend_from_slice(&ids[..count]);
            tokens.push(0);
            let tokens = Tensor::from_array(([1usize, tokens.len()], tokens)).map_err(failed)?;
            let style = Tensor::from_array(([1usize, STYLE], style[count * STYLE..(count + 1) * STYLE].to_vec())).map_err(failed)?;
            let speed = Tensor::from_array(([1usize], vec![speed])).map_err(failed)?;
            let out = self.session.run(ort::inputs!["tokens" => tokens, "style" => style, "speed" => speed]).map_err(failed)?;
            let (_, samples) = out["audio"].try_extract_tensor::<f32>().map_err(failed)?;
            audio.extend_from_slice(samples);
        }
        Ok(audio)
    }
}

/// The phonemes in pieces of at most `limit` symbols, cut after a sentence's end where possible, else after a comma,
/// else at a space.
fn chunks(phonemes: &str, limit: usize) -> Vec<String> {
    fn cut(text: &str, limit: usize, marks: &[&str]) -> Vec<String> {
        if text.chars().count() <= limit {
            return vec![text.to_string()];
        }
        let Some((mark, rest)) = marks.split_first() else {
            // nothing left to cut at: so many symbols at a time
            let characters: Vec<char> = text.chars().collect();
            return characters.chunks(limit).map(|piece| piece.iter().collect()).collect();
        };
        // the pieces this mark cuts, each keeping it, then packed back together up to the limit
        let mut pieces: Vec<String> = vec![];
        let mut piece = String::new();
        for character in text.chars() {
            piece.push(character);
            if mark.contains(character) {
                pieces.push(std::mem::take(&mut piece));
            }
        }
        if !piece.is_empty() {
            pieces.push(piece);
        }
        let mut out: Vec<String> = vec![];
        for piece in pieces {
            for part in cut(piece.trim(), limit, rest) {
                match out.last_mut() {
                    Some(last) if last.chars().count() + 1 + part.chars().count() <= limit => {
                        last.push(' ');
                        last.push_str(&part);
                    }
                    _ => out.push(part),
                }
            }
        }
        out
    }
    cut(phonemes, limit, &[".!?;…", ",", " "]).into_iter().filter(|piece| !piece.trim().is_empty()).collect()
}

/// A WAV file of the samples: 24 kHz, 16-bit, mono.
pub fn wav(samples: &[f32]) -> Vec<u8> {
    let spec = hound::WavSpec { channels: 1, sample_rate: RATE, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut cursor = std::io::Cursor::new(Vec::with_capacity(44 + samples.len() * 2));
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec).expect("a WAV in memory");
        for sample in samples {
            writer.write_sample((sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).expect("a WAV in memory");
        }
        writer.finalize().expect("a WAV in memory");
    }
    cursor.into_inner()
}

/// The arrays of an npz file, by name: 510 × 1 × 256 of 32-bit floats each, stored uncompressed, as NumPy saves them.
fn npz(bytes: &[u8]) -> Result<HashMap<String, Vec<f32>>, String> {
    let u16_at = |at: usize| -> Result<usize, String> {
        bytes.get(at..at + 2).map(|pair| u16::from_le_bytes([pair[0], pair[1]]) as usize).ok_or_else(|| "cut short".to_string())
    };
    let u32_at = |at: usize| -> Result<usize, String> {
        bytes.get(at..at + 4).map(|quad| u32::from_le_bytes([quad[0], quad[1], quad[2], quad[3]]) as usize).ok_or_else(|| "cut short".to_string())
    };
    // the end of the central directory, in the last 64 KB, then the directory it points at
    let tail = bytes.len().saturating_sub(65_557);
    let end = (tail..bytes.len().saturating_sub(21)).rev().find(|&at| bytes[at..at + 4] == [0x50, 0x4b, 0x05, 0x06]).ok_or("not a zip file")?;
    let entries = u16_at(end + 10)?;
    let mut at = u32_at(end + 16)?;
    let mut out = HashMap::new();
    for _ in 0..entries {
        if bytes.get(at..at + 4) != Some(&[0x50, 0x4b, 0x01, 0x02]) {
            return Err("a damaged directory".into());
        }
        let method = u16_at(at + 10)?;
        let size = u32_at(at + 24)?;
        let name_len = u16_at(at + 28)?;
        let extra_len = u16_at(at + 30)?;
        let comment_len = u16_at(at + 32)?;
        let local = u32_at(at + 42)?;
        let name = std::str::from_utf8(bytes.get(at + 46..at + 46 + name_len).ok_or("cut short")?).map_err(|_| "a name that isn't text")?;
        if method != 0 {
            return Err(format!("{name} is compressed"));
        }
        let local_name_len = u16_at(local + 26)?;
        let local_extra_len = u16_at(local + 28)?;
        let data = local + 30 + local_name_len + local_extra_len;
        let array = npy(bytes.get(data..data + size).ok_or("cut short")?).map_err(|error| format!("{name}: {error}"))?;
        out.insert(name.trim_end_matches(".npy").to_string(), array);
        at += 46 + name_len + extra_len + comment_len;
    }
    Ok(out)
}

/// A voice's array from its npy bytes: little-endian 32-bit floats of the shape (510, 1, 256).
fn npy(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if bytes.get(..6) != Some(b"\x93NUMPY") {
        return Err("not an array".into());
    }
    let (header_len, start) = match bytes.get(6) {
        Some(1) => (u16::from_le_bytes([bytes[8], bytes[9]]) as usize, 10),
        Some(2 | 3) => (u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize, 12),
        _ => return Err("an array of an unknown version".into()),
    };
    let header = std::str::from_utf8(bytes.get(start..start + header_len).ok_or("cut short")?).map_err(|_| "a header that isn't text")?;
    let expected = MAX_TOKENS * STYLE;
    if !header.contains("'<f4'") || !header.contains(&format!("({MAX_TOKENS}, 1, {STYLE})")) || header.contains("'fortran_order': True") {
        return Err(format!("not a {MAX_TOKENS} by {STYLE} table of floats: {header}"));
    }
    let data = &bytes[start + header_len..];
    if data.len() != expected * 4 {
        return Err(format!("{} bytes of data, not {}", data.len(), expected * 4));
    }
    Ok(data.as_chunks::<4>().0.iter().map(|quad| f32::from_le_bytes(*quad)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Instant;

    fn build_dir() -> PathBuf {
        PathBuf::from(std::env::var("HOME").unwrap()).join(".cache/parrot-build")
    }

    fn files(model: &str) -> Option<(PathBuf, PathBuf)> {
        let (model, voices) = (build_dir().join(model), build_dir().join("voices-v1.0.bin"));
        if model.exists() && voices.exists() {
            Some((model, voices))
        } else {
            eprintln!("skipped: no model or voices in {}", build_dir().display());
            None
        }
    }

    #[test]
    fn every_symbol_of_the_lexicons_has_a_token() {
        for symbol in "AIOWYbdfhijklmnpstuvwzæðŋɑɔəɛɜɡɪɹɾʃʊʌʒʤʧˈˌθᵊᵻ ;:,.!?—…\"“”()ɐ".chars() {
            assert!(VOCAB.contains_key(&symbol), "{symbol}");
        }
        assert_eq!(VOCAB.len(), 114);
    }

    #[test]
    fn long_phonemes_are_cut_at_sentence_ends_first() {
        assert_eq!(chunks("ɐ b. c d! e", 100), vec!["ɐ b. c d! e"]);
        assert_eq!(chunks("ɐ b. c d! e", 6), vec!["ɐ b.", "c d! e"]);
        assert_eq!(chunks("ɐ b. c d! e", 5), vec!["ɐ b.", "c d!", "e"]);
        // a sentence longer than the limit is cut at its commas, then at spaces
        assert_eq!(chunks("ɐ b, c d, e f g.", 7), vec!["ɐ b,", "c d,", "e f g."]);
        assert_eq!(chunks("abc def ghi.", 7), vec!["abc def", "ghi."]);
        assert_eq!(chunks("abcdefghij", 4), vec!["abcd", "efgh", "ij"]);
        assert!(chunks("  ", 10).is_empty());
    }

    #[test]
    fn a_wav_in_memory_reads_back() {
        let samples: Vec<f32> = (0..2400).map(|index| (index as f32 / 20.0).sin() * 0.5).collect();
        let pcm = crate::audio::read_wav(&wav(&samples)).unwrap();
        assert_eq!(pcm.rate, RATE);
        assert_eq!(pcm.samples.len(), 2400);
        assert!((pcm.samples[30] - samples[30]).abs() < 0.001);
    }

    /// Needs the voices file in ~/.cache/parrot-build; skipped elsewhere (CI).
    #[test]
    fn the_voices_file_holds_54_voices() {
        let Some((_, voices)) = files("kokoro-v1.0.int8.onnx") else { return };
        let voices = npz(&std::fs::read(voices).unwrap()).unwrap();
        assert_eq!(voices.len(), 54);
        assert_eq!(voices["af_heart"].len(), MAX_TOKENS * STYLE);
        assert!(voices["af_heart"].iter().any(|value| *value != 0.0));
        assert!(npz(b"not a zip").is_err());
    }

    /// Needs the model and the voices in ~/.cache/parrot-build; skipped elsewhere (CI). Keeps the reading as
    /// kokoro-northern.wav there, to be heard.
    #[test]
    fn reads_the_northern_lights() {
        let Some((model, voices)) = files("kokoro-v1.0.int8.onnx") else { return };
        let started = Instant::now();
        let mut reader = Reader::load(&model, &voices).unwrap();
        eprintln!("loaded in {:.2} s", started.elapsed().as_secs_f32());
        assert!(reader.voices().contains(&"af_heart") && reader.voices().contains(&"bm_george"));
        let started = Instant::now();
        let audio = reader.read("The northern lights are one of the most beautiful things you can see in the night sky.", "af_heart", 1.0).unwrap();
        let seconds = audio.len() as f32 / RATE as f32;
        eprintln!("{seconds:.1} s of audio in {:.2} s", started.elapsed().as_secs_f32());
        assert!((3.0..6.0).contains(&seconds), "{seconds}");
        assert!(audio.iter().any(|sample| sample.abs() > 0.1), "not silence");
        std::fs::write(build_dir().join("kokoro-northern.wav"), wav(&audio)).unwrap();
        assert!(reader.read("Hello.", "nobody", 1.0).is_err());
    }

    /// Writes readings of the demo texts in a few voices, with the full model and the 8-bit one, into the folder
    /// $PARROT_SAMPLES, to be chosen between by ear. cargo test --lib samples -- --ignored --nocapture
    #[test]
    #[ignore]
    fn samples() {
        let out = PathBuf::from(std::env::var("PARROT_SAMPLES").unwrap());
        std::fs::create_dir_all(&out).unwrap();
        let texts = [
            ("northern", "The northern lights are one of the most beautiful things you can see in the night sky."),
            (
                "toast",
                "Good evening, everybody. For those who don't know me, I'm Tom, the best man. I've known Sam since we were seven, and tonight I finally met the person who makes him laugh more than I do. To Sam and Priya!",
            ),
        ];
        for (label, model) in [("full", "kokoro-v1.0.onnx"), ("int8", "kokoro-v1.0.int8.onnx")] {
            let Some((model, voices)) = files(model) else { continue };
            let mut reader = Reader::load(&model, &voices).unwrap();
            for voice in ["af_heart", "am_michael", "bf_emma"] {
                for (name, text) in texts {
                    for speed in [1.0f32, 0.7] {
                        let started = Instant::now();
                        let audio = reader.read(text, voice, speed).unwrap();
                        let file = format!("{name}-{voice}-{speed}-{label}.wav");
                        eprintln!("{file}: {:.1} s in {:.2} s", audio.len() as f32 / RATE as f32, started.elapsed().as_secs_f32());
                        std::fs::write(out.join(file), wav(&audio)).unwrap();
                    }
                }
            }
        }
    }
}
