//! Forced alignment: where each word of the text is in a recording, and how sure the model is that its sounds match
//! the word (0-1). Uses an English wav2vec2 model fine-tuned on Mozilla Common Voice
//! (jonatasgrosman/wav2vec2-large-xlsr-53-english, Apache 2.0), quantised to 8 bits and run with ONNX Runtime.
//! Common Voice has thousands of speakers with every kind of accent and microphone, so a non-native speaker who is
//! understood scores high; a model trained on audiobooks (wav2vec2-base-960h) marked nearly every word of a
//! non-native reading as off. The alignment itself is the classic CTC Viterbi search over the per-frame letter
//! probabilities.

use crate::text::WordTime;
use ort::session::Session;
use ort::value::Tensor;
use std::path::Path;
use std::sync::OnceLock;

static ENVIRONMENT: OnceLock<ort::environment::Environment> = OnceLock::new();

/// The ONNX Runtime environment, made once for the whole process: ONNX Runtime 1.23 (the Intel Mac build) allows
/// only one per process.
fn environment() -> Result<&'static ort::environment::Environment, String> {
    if let Some(env) = ENVIRONMENT.get() {
        return Ok(env);
    }
    let env = ort::init().with_name("parrot").build().map_err(|error| error.to_string())?;
    Ok(ENVIRONMENT.get_or_init(|| env))
}

/// the model's tokens: blank (0), word separator "|" (4), then ' - a b c ... z from 5
const TOKENS: usize = 33;
const LETTERS: &str = "'-abcdefghijklmnopqrstuvwxyz";
const BLANK: usize = 0;
const SEPARATOR: usize = 4;

fn token(character: char) -> Option<usize> {
    let character = if character == '\u{2019}' { '\'' } else { character.to_ascii_lowercase() };
    if character == '-' { None } else { LETTERS.find(character).map(|letter_index| letter_index + 5) }
}

/// The model's frame hop (samples at 16 kHz): its convolutional front end gives a frame per 320 samples.
const HOP: usize = 320;
/// A take is aligned in windows this long, with CONTEXT more on each side that is run but not kept: the model's
/// memory grows faster than the take (10 GB for 15 s, 17 GB for a minute; 4.5 GB in these windows), and it was
/// trained on clips of a few seconds. Scores shift a little from a whole-take run, both ways, and no window short
/// of the whole take avoids that. Both are multiples of HOP, so a window's frames line up with the take's.
const WINDOW: usize = 5 * 16000;
const CONTEXT: usize = 16000 / 2;

/// The windows a take of `samples` is run in: the slice given to the model, and of the frames it gives back, the
/// first to keep and how many (None: all that are left, for the last window).
fn windows(samples: usize) -> Vec<(std::ops::Range<usize>, usize, Option<usize>)> {
    let mut out = vec![];
    let mut start = 0;
    while start < samples {
        let end = (start + WINDOW).min(samples);
        let from = start.saturating_sub(CONTEXT);
        let to = (end + CONTEXT).min(samples);
        let lead = (start - from) / HOP;
        out.push((from..to, lead, (end < samples).then_some((end - start) / HOP)));
        start = end;
    }
    out
}

pub struct Aligner {
    session: Session,
}

impl Aligner {
    pub fn load(model: &Path) -> Result<Self, String> {
        let session = Session::builder(environment()?)
            .and_then(|mut builder| builder.commit_from_file(model))
            .map_err(|error| format!("could not load the aligner: {error}"))?;
        Ok(Self { session })
    }

    /// Per-frame log probabilities of the tokens, for 16 kHz mono audio: the take normalised as a whole, then run
    /// through the model in windows (see WINDOW), each keeping only the frames it has context on both sides of.
    fn emissions(&mut self, audio: &[f32]) -> Result<(Vec<[f32; TOKENS]>, f64), String> {
        let sample_count = audio.len().max(1);
        let mean = audio.iter().sum::<f32>() / sample_count as f32;
        let var = audio.iter().map(|sample| (sample - mean).powi(2)).sum::<f32>() / sample_count as f32;
        let norm: Vec<f32> = audio.iter().map(|sample| (sample - mean) / (var + 1e-7).sqrt()).collect();
        let mut rows: Vec<[f32; TOKENS]> = Vec::with_capacity(norm.len() / HOP + 1);
        for (slice, lead, keep) in windows(norm.len()) {
            let window = self.run(&norm[slice])?;
            let keep = keep.unwrap_or(window.len().saturating_sub(lead));
            rows.extend(window.into_iter().skip(lead).take(keep));
        }
        let frames = rows.len().max(1);
        Ok((rows, audio.len() as f64 / frames as f64 / 16000.0))
    }

    /// One run of the model over normalised audio: each frame's log probabilities of the tokens.
    fn run(&mut self, norm: &[f32]) -> Result<Vec<[f32; TOKENS]>, String> {
        let input = Tensor::from_array(([1usize, norm.len()], norm.to_vec())).map_err(|error| error.to_string())?;
        let out = self.session.run(ort::inputs!["audio" => input]).map_err(|error| format!("aligner failed: {error}"))?;
        let (shape, logits) = out["logits"].try_extract_tensor::<f32>().map_err(|error| error.to_string())?;
        let frames = shape[1] as usize;
        Ok((0..frames)
            .map(|frame| {
                let row = &logits[frame * TOKENS..(frame + 1) * TOKENS];
                let max = row.iter().cloned().fold(f32::MIN, f32::max);
                let lse = max + row.iter().map(|logit| (logit - max).exp()).sum::<f32>().ln();
                let mut log_probs = [0f32; TOKENS];
                for (token_index, logit) in row.iter().enumerate() {
                    log_probs[token_index] = logit - lse;
                }
                log_probs
            })
            .collect())
    }

    /// Where each whitespace-separated word of the text is (seconds) and how well it scored. Words with no letters
    /// (digits) get nothing; when the take is too short for the text, nothing can be placed and every word scores 0.
    pub fn align(&mut self, audio: &[f32], text: &str) -> Result<Vec<WordTime>, String> {
        let words: Vec<&str> = text.split_whitespace().collect();
        let mut out = vec![WordTime::default(); words.len()];
        // the target: each word's letters, words joined by the separator
        let mut targets: Vec<usize> = vec![];
        let mut owner: Vec<Option<usize>> = vec![]; // the word each target token spells, None for separators
        let mut place: Vec<usize> = vec![]; // which character of its word each target token is
        for (word_index, word) in words.iter().enumerate() {
            let letters: Vec<(usize, usize)> =
                word.chars().enumerate().filter_map(|(char_index, character)| token(character).map(|token_id| (char_index, token_id))).collect();
            if letters.is_empty() {
                continue;
            }
            if !targets.is_empty() {
                targets.push(SEPARATOR);
                owner.push(None);
                place.push(0);
            }
            for (char_index, letter_token) in letters {
                targets.push(letter_token);
                owner.push(Some(word_index));
                place.push(char_index);
            }
        }
        if targets.is_empty() {
            return Ok(out);
        }
        let (em, secs_per_frame) = self.emissions(audio)?;
        let Some(path) = viterbi(&em, &targets) else {
            return Ok(vec![WordTime { score: Some(0.0), ..Default::default() }; words.len()]);
        };
        // per word: first and last frame, and the frame-weighted mean probability of its letters
        let mut first = vec![usize::MAX; words.len()];
        let mut last = vec![0usize; words.len()];
        let mut sum = vec![0f64; words.len()];
        let mut count = vec![0usize; words.len()];
        // and per letter: the mean probability over the frames the path gave it
        let mut letter_sum = vec![0f64; targets.len()];
        let mut letter_count = vec![0usize; targets.len()];
        for (frame, state) in path.iter().enumerate() {
            if let Some(target) = state
                && let Some(word_index) = owner[*target]
            {
                let probability = (em[frame][targets[*target]] as f64).exp();
                first[word_index] = first[word_index].min(frame);
                last[word_index] = last[word_index].max(frame);
                sum[word_index] += probability;
                count[word_index] += 1;
                letter_sum[*target] += probability;
                letter_count[*target] += 1;
            }
        }
        let round3 = |value: f64| (value * 1000.0).round() / 1000.0;
        for word_index in 0..words.len() {
            if count[word_index] > 0 {
                let mut letters = vec![None; words[word_index].chars().count()];
                for target in (0..targets.len()).filter(|&target| owner[target] == Some(word_index) && letter_count[target] > 0) {
                    letters[place[target]] = Some(round3(letter_sum[target] / letter_count[target] as f64));
                }
                out[word_index] = WordTime {
                    t: Some([round3(first[word_index] as f64 * secs_per_frame), round3((last[word_index] + 1) as f64 * secs_per_frame)]),
                    score: Some(round3(sum[word_index] / count[word_index] as f64)),
                    letters: Some(letters),
                };
            }
        }
        Ok(out)
    }
}

/// The most likely way to spell the targets over the frames (CTC: blanks between and around the letters, a letter
/// may last several frames, a repeated letter needs a blank between). Per frame: Some(target index) when a letter
/// is being said, None for a blank. None overall when there are fewer frames than the text needs.
fn viterbi(em: &[[f32; TOKENS]], targets: &[usize]) -> Option<Vec<Option<usize>>> {
    let frames = em.len();
    let states = 2 * targets.len() + 1; // blank, t0, blank, t1, ... blank
    let label = |state: usize| if state % 2 == 0 { BLANK } else { targets[state / 2] };
    let needed = targets.len() + targets.windows(2).filter(|pair| pair[0] == pair[1]).count();
    if frames < needed {
        return None;
    }
    const NEG: f32 = f32::NEG_INFINITY;
    let mut score = vec![NEG; states];
    let mut back = vec![vec![0u8; states]; frames]; // 0: stay, 1: from s-1, 2: from s-2
    score[0] = em[0][BLANK];
    score[1] = em[0][label(1)];
    for frame in 1..frames {
        let prev = score.clone();
        for state in 0..states {
            let mut best = prev[state];
            let mut how = 0u8;
            if state >= 1 && prev[state - 1] > best {
                best = prev[state - 1];
                how = 1;
            }
            if state >= 2 && state % 2 == 1 && label(state) != label(state - 2) && prev[state - 2] > best {
                best = prev[state - 2];
                how = 2;
            }
            score[state] = if best == NEG { NEG } else { best + em[frame][label(state)] };
            back[frame][state] = how;
        }
    }
    let mut state = if score[states - 1] >= score[states - 2] { states - 1 } else { states - 2 };
    if score[state] == NEG {
        return None;
    }
    let mut path = vec![None; frames];
    for frame in (0..frames).rev() {
        path[frame] = if state % 2 == 1 { Some(state / 2) } else { None };
        if frame > 0 {
            state -= back[frame][state] as usize;
        }
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn build_dir() -> PathBuf {
        PathBuf::from(std::env::var("HOME").unwrap()).join(".cache/parrot-build")
    }

    /// Needs the model and a sample take in ~/.cache/parrot-build; skipped elsewhere (CI).
    #[test]
    fn aligns_a_real_take() {
        let dir = build_dir();
        let (model, wav) = (dir.join("wav2vec2-xlsr-53-english-int8.onnx"), dir.join("sample.wav"));
        if !model.exists() || !wav.exists() {
            eprintln!("skipped: no model or sample in {}", dir.display());
            return;
        }
        let mut aligner = Aligner::load(&model).unwrap();
        let pcm = crate::audio::read_wav(&std::fs::read(wav).unwrap()).unwrap();
        let text = "They happen when particles from the Sun hit the air high above the Earth.";
        let words = aligner.align(&pcm.samples, text).unwrap();
        for (word, result) in text.split_whitespace().zip(&words) {
            eprintln!("{word:12} {:?} {:?}", result.t, result.score);
        }
        assert!(words.iter().all(|word| word.t.is_some()));
        // a score for every character, none for the full stop
        let last = words.last().unwrap().letters.as_ref().unwrap();
        assert_eq!(last.len(), "Earth.".len());
        assert!(last[..5].iter().all(Option::is_some) && last[5].is_none());
        assert!(words.windows(2).all(|pair| pair[0].t.unwrap()[1] <= pair[1].t.unwrap()[0] + 1e-6), "words in order");
        let mean = words.iter().map(|word| word.score.unwrap()).sum::<f64>() / words.len() as f64;
        assert!(mean > 0.7, "a clean reading scores high: {mean}");
        // the wrong text scores clearly lower
        let bad = aligner.align(&pcm.samples, "Seven green bottles were standing quietly on the kitchen wall at night.").unwrap();
        let bad_mean = bad.iter().filter_map(|word| word.score).sum::<f64>() / bad.len() as f64;
        assert!(bad_mean < mean - 0.2, "{bad_mean} vs {mean}");
    }

    /// Prints word scores for the takes listed in $PARROT_CALIBRATE ("wav|text" per line), to tune the
    /// "sounded off" thresholds in text.rs. cargo test --lib calibrate -- --ignored --nocapture
    #[test]
    #[ignore]
    fn calibrate() {
        let list = std::fs::read_to_string(std::env::var("PARROT_CALIBRATE").unwrap()).unwrap();
        let mut aligner = Aligner::load(&build_dir().join("wav2vec2-xlsr-53-english-int8.onnx")).unwrap();
        for line in list.lines().filter(|line| !line.is_empty()) {
            let (wav, text) = line.split_once('|').unwrap();
            let pcm = crate::audio::read_wav(&std::fs::read(wav).unwrap()).unwrap();
            let words = aligner.align(&crate::audio::resample(&pcm, 16000), text).unwrap();
            // letters under 0.6, for setting the card's colours
            for (word, result) in text.split_whitespace().zip(&words) {
                let low: Vec<String> = word
                    .chars()
                    .zip(result.letters.iter().flatten())
                    .filter_map(|(character, letter_score)| letter_score.filter(|&score| score < 0.6).map(|score| format!("{character}{score:.2}")))
                    .collect();
                if !low.is_empty() {
                    println!("  low {word}: {}", low.join(" "));
                }
            }
            let row: Vec<String> =
                text.split_whitespace().zip(&words).map(|(word, result)| format!("{word}:{:.2}", result.score.unwrap_or(-1.0))).collect();
            println!("{} || {}", wav.rsplit('/').nth(1).unwrap_or(""), row.join(" "));
        }
    }

    #[test]
    fn windows_cover_the_take_on_frame_boundaries() {
        // a short take is one window, all of it kept
        assert_eq!(windows(2 * 16000), vec![(0..32000, 0, None)]);
        assert_eq!(windows(WINDOW), vec![(0..WINDOW, 0, None)]);
        // a long one: the first keeps its first 5 s, the middle ones the 5 s after their context, the last the rest
        let plan = windows(12 * 16000);
        assert_eq!(plan.len(), 3);
        assert_eq!(plan[0], (0..88000, 0, Some(250)));
        assert_eq!(plan[1], (72000..168000, 25, Some(250)));
        assert_eq!(plan[2], (152000..192000, 25, None));
        for (slice, lead, _) in &plan {
            assert_eq!((slice.start % HOP, (lead * HOP) % HOP), (0, 0));
        }
        assert!(plan.windows(2).all(|pair| pair[0].0.end > pair[1].0.start), "windows overlap");
    }

    #[test]
    fn too_short_for_the_text_places_nothing() {
        let em = vec![[0f32; TOKENS]; 3];
        assert!(viterbi(&em, &[5, 6, 7, 8]).is_none());
        assert!(viterbi(&em, &[5, 5]).is_some()); // two equal letters need a blank between: 3 frames
        assert!(viterbi(&vec![[0f32; TOKENS]; 2], &[5, 5]).is_none());
    }
}
