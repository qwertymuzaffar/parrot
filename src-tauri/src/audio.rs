//! A take as the interface records it (a WAV file), cleaned the way a voice recording should be: desk rumble
//! filtered out, the silence before and after trimmed, the level evened out. Plus resampling to the 16 kHz the
//! speech models listen at.

use std::io::{BufReader, Cursor, Read};
use std::path::Path;

pub struct Pcm {
    pub samples: Vec<f32>,
    pub rate: u32,
}

impl Pcm {
    pub fn seconds(&self) -> f64 {
        self.samples.len() as f64 / self.rate as f64
    }
}

/// The longest recording read (seconds), at any rate: far more than a take, or a talk (30 minutes).
const LONGEST_READ: f64 = 45.0 * 60.0;
/// The largest recording file read: a 30-minute talk is 165 MB at the interface's 48 kHz 16-bit mono, but 660 MB
/// from a microphone that would only record at 192 kHz.
const LARGEST_FILE: usize = 1 << 30;

/// Read a WAV file (any sample format, any channel count) as mono floats.
pub fn read_wav(bytes: &[u8]) -> Result<Pcm, String> {
    too_big(bytes.len() as u64)?;
    read(hound::WavReader::new(Cursor::new(bytes)).map_err(|error| format!("not a WAV recording: {error}"))?, bytes.len() as u64)
}

/// Read the WAV file at `path` as mono floats, a little at a time: a long talk is never in memory twice.
pub fn read_wav_file(path: &Path) -> Result<Pcm, String> {
    let (reader, size) = open_wav(path)?;
    read(reader, size)
}

fn open_wav(path: &Path) -> Result<(hound::WavReader<BufReader<std::fs::File>>, u64), String> {
    let size = std::fs::metadata(path).map_err(|error| error.to_string())?.len();
    too_big(size)?;
    Ok((hound::WavReader::open(path).map_err(|error| format!("not a WAV recording: {error}"))?, size))
}

/// hound reads (and fails on) every sample the header claims: a header claiming millions more than the body holds
/// would keep the engine busy for seconds or minutes on nothing.
fn whole<R: Read>(reader: &hound::WavReader<R>, size: u64) -> Result<(), String> {
    let claimed_bytes = reader.len() as u64 * reader.spec().bits_per_sample.div_ceil(8) as u64;
    if claimed_bytes > size {
        return Err(format!("the recording is damaged: it says it holds {claimed_bytes} bytes of sound in {size}"));
    }
    Ok(())
}

fn too_big(size: u64) -> Result<(), String> {
    if size > LARGEST_FILE as u64 { Err(format!("the recording is too long ({} MB)", size >> 20)) } else { Ok(()) }
}

/// The samples of a WAV recording of `size` bytes as mono floats.
fn read<R: Read>(mut reader: hound::WavReader<R>, size: u64) -> Result<Pcm, String> {
    let spec = reader.spec();
    if spec.bits_per_sample > 32 {
        return Err(format!("not a WAV recording Parrot reads: {} bits a sample", spec.bits_per_sample));
    }
    // by its length, not its size: the same talk is twice the bytes from a microphone at 96 kHz
    let secs = reader.duration() as f64 / spec.sample_rate.max(1) as f64;
    if secs > LONGEST_READ {
        return Err(format!("the recording is too long ({} minutes)", (secs / 60.0).round()));
    }
    whole(&reader, size)?;
    let ch = spec.channels.max(1) as usize;
    // as long as the header says from the start (checked against the size above): a long talk grown a little at a
    // time would be copied, and held twice, each time it outgrew its room
    let mut interleaved: Vec<f32> = Vec::with_capacity(reader.len() as usize);
    match spec.sample_format {
        hound::SampleFormat::Float => interleaved.extend(reader.samples::<f32>().filter_map(Result::ok)),
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
            interleaved.extend(reader.samples::<i32>().filter_map(Result::ok).map(|sample| sample as f32 / scale));
        }
    }
    // mono (every take Parrot records) as it is: no second copy
    let samples = if ch == 1 { interleaved } else { interleaved.chunks(ch).map(|frame| frame.iter().sum::<f32>() / ch as f32).collect() };
    Ok(Pcm { samples, rate: spec.sample_rate })
}

/// The loudest sample of each of `slices` equal slices of the WAV file at `path`, scaled so the loudest slice is 1:
/// a waveform, read a little at a time, so even a long talk costs no memory.
pub fn peaks_file(path: &Path, slices: usize) -> Result<Vec<f32>, String> {
    let (mut reader, size) = open_wav(path)?;
    whole(&reader, size)?;
    let spec = reader.spec();
    let ch = spec.channels.max(1) as usize;
    let frames = reader.duration() as usize;
    let slices = slices.clamp(1, 2000);
    let size = (frames / slices).max(1);
    let mut out = vec![0f32; slices];
    let scale = match spec.sample_format {
        hound::SampleFormat::Float => 1.0,
        hound::SampleFormat::Int => (1i64 << (spec.bits_per_sample.clamp(1, 32) - 1)) as f32,
    };
    let mut add = |index: usize, sample: f32| {
        let slice = (index / ch / size).min(slices - 1);
        out[slice] = out[slice].max(sample.abs() / scale);
    };
    match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().enumerate().for_each(|(index, sample)| add(index, sample.unwrap_or(0.0))),
        hound::SampleFormat::Int => reader.samples::<i32>().enumerate().for_each(|(index, sample)| add(index, sample.unwrap_or(0) as f32)),
    }
    let top = out.iter().cloned().fold(0f32, f32::max);
    Ok(out.into_iter().map(|peak| if top > 0.0 { peak / top } else { 0.0 }).collect())
}

/// The stretch of the WAV file at `path` from `from` to `to` (seconds), as 16-bit mono at the file's rate: a word
/// cut from a long talk without reading the rest of it.
pub fn clip_file(path: &Path, from: f64, to: f64) -> Result<(u32, Vec<i16>), String> {
    let (mut reader, _) = open_wav(path)?;
    let spec = reader.spec();
    let ch = spec.channels.max(1) as usize;
    let frames = reader.duration();
    let first = ((from.max(0.0) * spec.sample_rate as f64) as u32).min(frames);
    let end = ((to.max(from) * spec.sample_rate as f64).ceil() as u32).min(frames);
    // a word is a second or two; never more than a minute
    let count = (end - first).min(spec.sample_rate * 60) as usize;
    reader.seek(first).map_err(|error| error.to_string())?;
    let scale = match spec.sample_format {
        hound::SampleFormat::Float => 1.0,
        hound::SampleFormat::Int => (1i64 << (spec.bits_per_sample.clamp(1, 32) - 1)) as f32,
    };
    let floats: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().take(count * ch).map(|sample| sample.unwrap_or(0.0)).collect(),
        hound::SampleFormat::Int => reader.samples::<i32>().take(count * ch).map(|sample| sample.unwrap_or(0) as f32 / scale).collect(),
    };
    let mono = floats.chunks(ch).map(|frame| ((frame.iter().sum::<f32>() / ch as f32).clamp(-1.0, 1.0) * 32767.0) as i16).collect();
    Ok((spec.sample_rate, mono))
}

/// Write `pcm` to `path` whole or not at all: to <path>.tmp first, then renamed over it. A recording written over
/// (a talk's, once it is cleaned) would otherwise be cut off by a quit midway, and a WAV whose lengths were never
/// filled in reads as empty.
pub fn write_wav(path: &std::path::Path, pcm: &Pcm) -> Result<(), String> {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".tmp");
    let temporary = std::path::PathBuf::from(temporary);
    let spec = hound::WavSpec { channels: 1, sample_rate: pcm.rate, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let written = (|| {
        let mut writer = hound::WavWriter::create(&temporary, spec)?;
        for sample in &pcm.samples {
            writer.write_sample((sample.clamp(-1.0, 1.0) * 32767.0) as i16)?;
        }
        writer.finalize()?;
        std::fs::File::open(&temporary)?.sync_all()?;
        std::fs::rename(&temporary, path)?;
        Ok::<_, hound::Error>(())
    })();
    written.map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        error.to_string()
    })
}

/// High-pass the take at 80 Hz (a second-order filter): desk rumble and handling noise out, the voice untouched.
pub fn high_pass(samples: &mut [f32], rate: u32) {
    let w0 = 2.0 * std::f32::consts::PI * 80.0 / rate as f32;
    let alpha = w0.sin() / (2.0 * std::f32::consts::FRAC_1_SQRT_2);
    let cos = w0.cos();
    let a0 = 1.0 + alpha;
    let (b0, b1, b2) = ((1.0 + cos) / 2.0 / a0, -(1.0 + cos) / a0, (1.0 + cos) / 2.0 / a0);
    let (a1, a2) = (-2.0 * cos / a0, (1.0 - alpha) / a0);
    let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
    for sample in samples.iter_mut() {
        let filtered = b0 * *sample + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = *sample;
        y2 = y1;
        y1 = filtered;
        *sample = filtered;
    }
}

fn db(rms: f32) -> f32 {
    20.0 * rms.max(1e-9).log10()
}

/// Whether a take is nothing but exact zeros: not a quiet room, which always has some noise, but no sound at all.
pub fn blank(pcm: &Pcm) -> bool {
    pcm.samples.iter().all(|&sample| sample == 0.0)
}

/// The shortest cleaned take that is kept: a short word said alone, with the lead-in kept before it and a take
/// stopped right after it, is about this long. Shorter is a breath or a click, not speech.
pub const SHORTEST_TAKE: f64 = 0.3;

/// Clean a take: high-pass, trim the silence before (keeping 0.15 s) and after (0.25 s) the voice, and level it
/// to about -20 dBFS of speech, never above 0.95. Returns None when nothing but silence was recorded.
pub fn clean(pcm: Pcm) -> Option<Pcm> {
    clean_at(pcm).map(|(cleaned, _)| cleaned)
}

/// Clean a take as `clean` does, and say where the cleaned take starts in it (samples trimmed from the start).
pub fn clean_at(mut pcm: Pcm) -> Option<(Pcm, usize)> {
    let rate = pcm.rate as usize;
    high_pass(&mut pcm.samples, pcm.rate);
    let frame = (rate / 100).max(1); // 10 ms
    let levels: Vec<f32> =
        pcm.samples.chunks(frame).map(|chunk| db((chunk.iter().map(|sample| sample * sample).sum::<f32>() / chunk.len() as f32).sqrt())).collect();
    // a frame as loud as it stays over 30 ms: a click (the microphone starting, a key) is shorter than any sound of
    // speech, and must not set the level the voice is measured against
    let sustained: Vec<f32> = (0..levels.len())
        .map(|frame_index| levels[frame_index.saturating_sub(1)..(frame_index + 2).min(levels.len())].iter().cloned().fold(f32::MAX, f32::min))
        .collect();
    let loudest = sustained.iter().cloned().fold(f32::MIN, f32::max);
    // voice: frames within 35 dB of the loudest, and above the noise floor of a quiet room
    let threshold = (loudest - 35.0).max(-55.0);
    let first = sustained.iter().position(|&level| level > threshold)?;
    let last = sustained.iter().rposition(|&level| level > threshold)?;
    if loudest < -50.0 {
        return None;
    }
    let start = (first * frame).saturating_sub(rate * 15 / 100);
    let end = ((last + 1) * frame + rate / 4).min(pcm.samples.len());
    // trimmed where it is: a long talk is never copied
    let mut trimmed = pcm.samples;
    trimmed.truncate(end);
    trimmed.drain(..start);
    let (mut energy, mut voiced) = (0f32, 0usize);
    for chunk in trimmed.chunks(frame) {
        let chunk_energy = chunk.iter().map(|sample| sample * sample).sum::<f32>();
        if db((chunk_energy / chunk.len() as f32).sqrt()) > threshold {
            energy += chunk_energy;
            voiced += chunk.len();
        }
    }
    let rms = (energy / voiced.max(1) as f32).sqrt();
    let peak = trimmed.iter().fold(0f32, |running_peak, sample| running_peak.max(sample.abs()));
    let gain = (0.1 / rms.max(1e-6)).min(0.95 / peak.max(1e-6)).min(30.0);
    for sample in &mut trimmed {
        *sample *= gain;
    }
    Some((Pcm { samples: trimmed, rate: pcm.rate }, start))
}

/// Where to cut a long recording for speech recognition, which hears at most `limit` seconds well at a time: at the
/// quietest moment of the last 40% of each stretch, the loudness averaged over 300 ms so a pause between words wins
/// over the gap inside one. The ranges cover every sample, in order.
pub fn stretches(samples: &[f32], rate: u32, limit: f64) -> Vec<std::ops::Range<usize>> {
    let frame = (rate as usize / 100).max(1); // 10 ms
    let levels: Vec<f64> =
        samples.chunks(frame).map(|chunk| db((chunk.iter().map(|sample| sample * sample).sum::<f32>() / chunk.len() as f32).sqrt()) as f64).collect();
    // each frame's level averaged with the 15 frames either side
    let mut running = vec![0f64; levels.len() + 1];
    for (frame_index, level) in levels.iter().enumerate() {
        running[frame_index + 1] = running[frame_index] + level;
    }
    let smoothed = |frame_index: usize| {
        let (from, to) = (frame_index.saturating_sub(15), (frame_index + 16).min(levels.len()));
        (running[to] - running[from]) / (to - from) as f64
    };
    let limit_frames = ((limit * 100.0) as usize).max(10);
    let mut cuts = vec![0];
    let mut start = 0;
    while levels.len() - start > limit_frames {
        let quietest =
            (start + limit_frames * 6 / 10..start + limit_frames).min_by(|left, right| smoothed(*left).total_cmp(&smoothed(*right))).unwrap();
        cuts.push(quietest);
        start = quietest;
    }
    cuts.push(levels.len());
    cuts.windows(2).map(|pair| pair[0] * frame..(pair[1] * frame).min(samples.len())).collect()
}

/// Resample by linear interpolation, low-passed first when going down so nothing above the new Nyquist folds back.
pub fn resample(pcm: &Pcm, to: u32) -> Vec<f32> {
    if pcm.rate == to || pcm.samples.is_empty() {
        return pcm.samples.clone();
    }
    let samples = &pcm.samples;
    let ratio = pcm.rate as f64 / to as f64;
    // down: a moving average as wide as the step, a simple anti-alias filter fine for speech models, worked out as
    // the output needs it (a long talk is never copied whole)
    let window = if ratio > 1.0 { ratio.ceil() as usize } else { 1 };
    let (mut acc, mut at, mut before, mut now) = (0f32, usize::MAX, 0f32, 0f32);
    let mut filtered_to = |index: usize, before: &mut f32, now: &mut f32| {
        while at.wrapping_add(1) <= index {
            at = at.wrapping_add(1);
            acc += samples[at];
            if at >= window {
                acc -= samples[at - window];
            }
            *before = *now;
            *now = acc / window.min(at + 1) as f32;
        }
    };
    let last = samples.len() - 1;
    let output_len = (samples.len() as f64 / ratio).floor() as usize;
    let mut out = Vec::with_capacity(output_len);
    for output_index in 0..output_len {
        let position = output_index as f64 * ratio;
        let left_index = (position.floor() as usize).min(last);
        let fraction = (position - position.floor()) as f32;
        let right_index = (left_index + 1).min(last);
        let (left, right) = if window == 1 {
            // up: nothing to filter
            (samples[left_index], samples[right_index])
        } else {
            filtered_to(right_index, &mut before, &mut now);
            // the filtered sample at left_index is the one before right_index's, unless they are the same (the end)
            if right_index == left_index { (now, now) } else { (before, now) }
        };
        out.push(left + (right - left) * fraction);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, secs: f32, amp: f32) -> Vec<f32> {
        (0..(rate as f32 * secs) as usize)
            .map(|sample_index| amp * (2.0 * std::f32::consts::PI * 220.0 * sample_index as f32 / rate as f32).sin())
            .collect()
    }

    /// A WAV file of `samples` (16-bit, `channels` interleaved) at `rate`, in the temp folder.
    fn wav_file(name: &str, rate: u32, channels: u16, samples: &[f32]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("parrot-audio-{name}-{}.wav", std::process::id()));
        let spec = hound::WavSpec { channels, sample_rate: rate, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut writer = hound::WavWriter::create(&path, spec).unwrap();
        for sample in samples {
            writer.write_sample((sample * 32767.0) as i16).unwrap();
        }
        writer.finalize().unwrap();
        path
    }

    #[test]
    fn a_long_recording_is_drawn_and_cut_from_its_file() {
        // two seconds of quiet, then two of a tone at half the loudest
        let mut samples = vec![0.0; 16000];
        samples.extend(tone(8000, 2.0, 0.5));
        let path = wav_file("peaks", 8000, 1, &samples);
        let peaks = peaks_file(&path, 4).unwrap();
        assert_eq!(peaks.len(), 4);
        assert!(peaks[0] == 0.0 && peaks[1] == 0.0 && (peaks[2] - 1.0).abs() < 0.01 && peaks[3] > 0.95, "{peaks:?}");

        let (rate, clip) = clip_file(&path, 2.5, 2.75).unwrap();
        assert_eq!((rate, clip.len()), (8000, 2000));
        assert_eq!(clip.iter().map(|sample| sample.unsigned_abs()).max().unwrap() / 1000, 16, "half the loudest");
        assert!(clip_file(&path, 1.0, 1.5).unwrap().1.iter().all(|sample| *sample == 0));
        // past the end: what there is
        assert_eq!(clip_file(&path, 3.9, 9.0).unwrap().1.len(), 800);
        assert_eq!(read_wav_file(&path).unwrap().samples.len(), 32000);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_stereo_recording_is_cut_as_mono() {
        // left loud, right silent: the mix is half
        let frames: Vec<f32> = (0..8000).flat_map(|_| [0.8, 0.0]).collect();
        let path = wav_file("stereo", 8000, 2, &frames);
        let (rate, clip) = clip_file(&path, 0.0, 0.5).unwrap();
        assert_eq!((rate, clip.len(), clip[0] / 100), (8000, 4000, 131));
        assert_eq!(peaks_file(&path, 2).unwrap(), vec![1.0, 1.0]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn silence_is_trimmed_and_level_evened() {
        let rate = 48000;
        let mut samples = vec![0.0001f32; rate as usize]; // 1 s of near-silence
        samples.extend(tone(rate, 1.0, 0.02)); // a quiet voice
        samples.extend(vec![0.0001f32; rate as usize]);
        let out = clean(Pcm { samples, rate }).unwrap();
        assert!((out.seconds() - 1.4).abs() < 0.1, "{}", out.seconds());
        let peak = out.samples.iter().fold(0f32, |running_peak, sample| running_peak.max(sample.abs()));
        assert!(peak > 0.1 && peak <= 0.95, "{peak}");
    }

    #[test]
    fn a_click_as_the_microphone_starts_does_not_hide_the_voice() {
        // the first take after the microphone opens can begin with a loud click: it must not set the level that
        // decides what is voice, or a normal voice falls under it and the take is thrown away as silence
        let rate = 48000;
        let mut samples = vec![0.0001f32; rate as usize / 20];
        // a 5 ms click at nearly full scale (broadband: the high-pass filter doesn't take it out)
        samples.extend((0..rate as usize / 200).map(|sample_index| if sample_index % 2 == 0 { 0.9f32 } else { -0.9 }));
        samples.extend(vec![0.0001f32; rate as usize / 4]);
        samples.extend(tone(rate, 1.0, 0.01)); // a quiet voice, 40 dB under the click
        samples.extend(vec![0.0001f32; rate as usize / 2]);
        let out = clean(Pcm { samples, rate }).expect("the voice is kept");
        assert!(out.seconds() > 1.0, "{}", out.seconds());
    }

    #[test]
    fn a_short_word_stopped_right_after_is_long_enough() {
        // "out" said alone (0.2 s), the take stopped 50 ms after it: under the half second once asked for
        let rate = 48000;
        let mut samples = vec![0.0001f32; rate as usize / 2];
        samples.extend(tone(rate, 0.2, 0.05));
        samples.extend(vec![0.0001f32; rate as usize / 20]);
        let out = clean(Pcm { samples, rate }).unwrap();
        assert!(out.seconds() >= SHORTEST_TAKE && out.seconds() < 0.5, "{}", out.seconds());
    }

    #[test]
    fn silence_only_is_nothing() {
        assert!(clean(Pcm { samples: vec![0.0; 48000], rate: 48000 }).is_none());
    }

    /// The resampler as it was, copying the whole filtered recording first: the reference.
    fn resample_whole(pcm: &Pcm, to: u32) -> Vec<f32> {
        if pcm.rate == to {
            return pcm.samples.clone();
        }
        let ratio = pcm.rate as f64 / to as f64;
        let src: Vec<f32> = if ratio > 1.0 {
            // a moving average as wide as the step: a simple anti-alias filter, fine for speech models
            let window = ratio.ceil() as usize;
            let mut acc = 0f32;
            let mut out = Vec::with_capacity(pcm.samples.len());
            for (sample_index, sample) in pcm.samples.iter().enumerate() {
                acc += sample;
                if sample_index >= window {
                    acc -= pcm.samples[sample_index - window];
                }
                out.push(acc / window.min(sample_index + 1) as f32);
            }
            out
        } else {
            pcm.samples.clone()
        };
        let output_len = (src.len() as f64 / ratio).floor() as usize;
        (0..output_len)
            .map(|output_index| {
                let position = output_index as f64 * ratio;
                let left_index = position.floor() as usize;
                let fraction = (position - left_index as f64) as f32;
                let left = src[left_index.min(src.len() - 1)];
                let right = src[(left_index + 1).min(src.len() - 1)];
                left + (right - left) * fraction
            })
            .collect()
    }

    #[test]
    fn resampling_as_it_goes_gives_what_resampling_whole_did() {
        let signal: Vec<f32> = (0..20_000).map(|index| ((index * 7919) % 2000) as f32 / 1000.0 - 1.0).collect();
        for rate in [48_000, 44_100, 22_050, 16_000, 8_000] {
            let pcm = Pcm { samples: signal.clone(), rate };
            let (now, then) = (resample(&pcm, 16000), resample_whole(&pcm, 16000));
            assert_eq!(now.len(), then.len(), "{rate}");
            assert!(now.iter().zip(&then).all(|(a, b)| (a - b).abs() < 1e-5), "{rate}");
        }
    }

    #[test]
    fn resampling_keeps_the_length() {
        let pcm = Pcm { samples: tone(48000, 2.0, 0.5), rate: 48000 };
        assert_eq!(resample(&pcm, 16000).len(), 32000);
    }

    /// A 16-bit mono WAV header whose data chunk says it holds `claimed` bytes, followed by `body` bytes of silence.
    fn wav_claiming(claimed: u32, body: usize) -> Vec<u8> {
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + claimed).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
        wav.extend_from_slice(&1u16.to_le_bytes()); // mono
        wav.extend_from_slice(&16000u32.to_le_bytes());
        wav.extend_from_slice(&32000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&claimed.to_le_bytes());
        wav.resize(wav.len() + body, 0);
        wav
    }

    #[test]
    fn a_header_claiming_more_than_the_body_is_turned_away() {
        assert_eq!(read_wav(&wav_claiming(2000, 2000)).unwrap().samples.len(), 1000);
        // 20 million samples claimed, a thousand there: refused before reading any
        let started = std::time::Instant::now();
        let error = read_wav(&wav_claiming(40_000_000, 2000)).err().unwrap();
        assert!(error.contains("damaged"), "{error}");
        assert!(started.elapsed().as_secs_f64() < 0.1, "{:?}", started.elapsed());
        assert!(read_wav(&vec![0; LARGEST_FILE + 1]).err().unwrap().contains("too long"));
    }

    #[test]
    fn the_waveform_of_a_header_claiming_more_than_the_body_is_turned_away() {
        let dir = std::env::temp_dir().join(format!("parrot-peaks-damaged-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("damaged.wav");
        std::fs::write(&path, wav_claiming(40_000_000, 2000)).unwrap();
        let started = std::time::Instant::now();
        let error = peaks_file(&path, 92).unwrap_err();
        assert!(error.contains("damaged"), "{error}");
        assert!(started.elapsed().as_secs_f64() < 0.1, "{:?}", started.elapsed());
        std::fs::write(&path, wav_claiming(2000, 2000)).unwrap();
        assert_eq!(peaks_file(&path, 92).unwrap().len(), 92);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_recording_is_too_long_by_its_length_at_any_rate() {
        // 46 minutes at 16 kHz
        let error = read_wav(&wav_claiming(2 * 16000 * 46 * 60, 2000)).err().unwrap();
        assert_eq!(error, "the recording is too long (46 minutes)");
        // the longest talk fits, whatever rate the microphone records at
        let longest = (crate::talk::LONGEST + 5.0) * 192_000.0 * 2.0;
        assert!(longest + 44.0 < LARGEST_FILE as f64 && crate::talk::LONGEST < LONGEST_READ, "{longest}");
    }

    #[test]
    fn wav_round_trip() {
        let dir = std::env::temp_dir().join("parrot-wav-test.wav");
        write_wav(&dir, &Pcm { samples: tone(16000, 0.5, 0.5), rate: 16000 }).unwrap();
        let back = read_wav(&std::fs::read(&dir).unwrap()).unwrap();
        assert_eq!((back.rate, back.samples.len()), (16000, 8000));
    }

    #[test]
    fn a_recording_written_over_stays_as_it_was_until_the_new_one_is_whole() {
        let dir = std::env::temp_dir().join(format!("parrot-wav-over-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("talk.wav");
        write_wav(&path, &Pcm { samples: tone(16000, 2.0, 0.5), rate: 16000 }).unwrap();
        // the new recording can't be written in full (its temporary file is in the way): the old one is untouched
        std::fs::create_dir(dir.join("talk.wav.tmp")).unwrap();
        assert!(write_wav(&path, &Pcm { samples: tone(16000, 1.0, 0.5), rate: 16000 }).is_err());
        assert_eq!(read_wav_file(&path).unwrap().samples.len(), 32000);
        std::fs::remove_dir(dir.join("talk.wav.tmp")).unwrap();
        write_wav(&path, &Pcm { samples: tone(16000, 1.0, 0.5), rate: 16000 }).unwrap();
        assert_eq!(read_wav_file(&path).unwrap().samples.len(), 16000);
        let names: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|entry| entry.file_name()).collect();
        assert_eq!(names, ["talk.wav"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_long_recording_is_cut_in_its_pauses() {
        let rate = 16000;
        // 70 s of speech-like bursts: 6.5 s of tone, then 0.5 s of quiet, ten times
        let mut samples = vec![];
        let mut quiet = vec![];
        for _ in 0..10 {
            samples.extend(tone(rate, 6.5, 0.3));
            quiet.push(samples.len()..samples.len() + rate as usize / 2);
            samples.extend(vec![0.0005f32; rate as usize / 2]);
        }
        let cuts = stretches(&samples, rate, 25.0);
        assert!(cuts.len() >= 3, "{cuts:?}");
        assert_eq!((cuts[0].start, cuts.last().unwrap().end), (0, samples.len()), "every sample is in a stretch");
        for pair in cuts.windows(2) {
            assert_eq!(pair[0].end, pair[1].start, "the stretches follow on");
            assert!(quiet.iter().any(|gap| gap.contains(&pair[0].end)), "cut at {} s, not in a pause", pair[0].end as f64 / rate as f64);
        }
        assert!(cuts.iter().all(|stretch| stretch.len() <= 25 * rate as usize), "{cuts:?}");
        // a short recording is one stretch
        assert_eq!(stretches(&samples[..rate as usize * 10], rate, 25.0), vec![0..rate as usize * 10]);
    }
}
