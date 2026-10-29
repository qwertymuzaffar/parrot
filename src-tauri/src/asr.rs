//! What the speech recognizer hears: whisper.cpp (small.en), built into the app, on the graphics chip on macOS.

use crate::text::WordTime;
use std::path::Path;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// What the window says when whisper.cpp fails on a take: its own words are only for the log.
fn failed(error: whisper_rs::WhisperError) -> String {
    log::error!("speech recognition failed: {error}");
    "speech recognition failed; try again".into()
}

pub struct Recognizer {
    ctx: WhisperContext,
}

impl Recognizer {
    pub fn load(model: &Path) -> Result<Self, String> {
        let ctx = WhisperContext::new_with_params(model, WhisperContextParameters::default())
            .map_err(|error| format!("could not load the speech model: {error}"))?;
        Ok(Self { ctx })
    }

    fn hear(&self, audio: &[f32]) -> Result<String, String> {
        let mut state = self.ctx.create_state().map_err(failed)?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("en"));
        params.set_n_threads(std::thread::available_parallelism().map(|threads| threads.get().min(8)).unwrap_or(4) as i32);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_print_timestamps(false);
        params.set_no_context(true);
        params.set_suppress_blank(true);
        // whisper needs at least a second of audio: pad short takes with silence
        let mut padded = audio.to_vec();
        if padded.len() < 16000 * 11 / 10 {
            padded.resize(16000 * 11 / 10, 0.0);
        }
        state.full(params, &padded).map_err(failed)?;
        let text: Vec<String> = state
            .as_iter()
            .filter_map(|segment| segment.to_str_lossy().ok().map(|segment_text| segment_text.trim().to_string()))
            .filter(|segment_text| !segment_text.is_empty())
            .collect();
        Ok(text.join(" "))
    }

    /// What whisper hears in a 16 kHz take. whisper.cpp reads 30-second windows and on a long take it can drop
    /// everything up to the next window, so a take longer than `limit` seconds is cut into chunks at the pauses
    /// between words (word times from the aligner) and each chunk is heard on its own.
    pub fn transcribe(&self, audio: &[f32], words: &[WordTime], limit: f64) -> Result<String, String> {
        let times: Vec<[f64; 2]> = words.iter().filter_map(|word| word.t).collect();
        if times.is_empty() || times.last().unwrap()[1] <= limit {
            return self.hear(audio);
        }
        let end = times.last().unwrap()[1];
        let gaps: Vec<(f64, f64)> = times.windows(2).map(|pair| (pair[0][1], pair[1][0])).collect();
        let mut cuts = vec![];
        let mut start = 0.0;
        while end - start > limit {
            // the widest pause in the last 40% of the window, so every chunk keeps some context
            let cut = gaps
                .iter()
                .map(|(gap_start, gap_end)| (gap_end - gap_start, (gap_start + gap_end) / 2.0))
                .filter(|(_, mid)| *mid > start + limit * 0.6 && *mid < start + limit)
                .max_by(|left, right| left.0.total_cmp(&right.0))
                .map(|(_, mid)| mid)
                .unwrap_or(start + limit);
            cuts.push(cut);
            start = cut;
        }
        let mut edges = vec![0.0];
        edges.extend(cuts);
        let mut parts = vec![];
        for (edge_index, edge) in edges.iter().enumerate() {
            let from = (*edge * 16000.0) as usize;
            let to = edges.get(edge_index + 1).map(|next_edge| (*next_edge * 16000.0) as usize).unwrap_or(audio.len()).min(audio.len());
            parts.push(self.hear(&audio[from.min(to)..to])?);
        }
        Ok(parts.join(" "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs the model and a sample take on this machine; skipped elsewhere (CI).
    #[test]
    fn hears_a_real_take() {
        let home = std::path::PathBuf::from(std::env::var("HOME").unwrap());
        let model = home.join(".cache/creator-studio/whisper/ggml-small.en.bin");
        let wav = home.join(".cache/parrot-build/sample.wav");
        if !model.exists() || !wav.exists() {
            eprintln!("skipped");
            return;
        }
        let recognizer = Recognizer::load(&model).unwrap();
        let pcm = crate::audio::read_wav(&std::fs::read(wav).unwrap()).unwrap();
        let heard = recognizer.transcribe(&pcm.samples, &[], 25.0).unwrap();
        eprintln!("heard: {heard}");
        assert!(heard.to_lowercase().contains("particles from the sun"), "{heard}");
    }
}
