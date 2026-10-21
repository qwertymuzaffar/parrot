//! A take as the interface records it (a WAV file), cleaned the way a voice recording should be: desk rumble
//! filtered out, the silence before and after trimmed, the level evened out. Plus resampling to the 16 kHz the
//! speech models listen at.

use std::io::Cursor;

pub struct Pcm {
    pub samples: Vec<f32>,
    pub rate: u32,
}

impl Pcm {
    pub fn seconds(&self) -> f64 {
        self.samples.len() as f64 / self.rate as f64
    }
}

/// The largest take read: some 45 minutes of the interface's 48 kHz 16-bit mono, far more than any take.
const LARGEST_TAKE: usize = 256 << 20;

/// Read a WAV file (any sample format, any channel count) as mono floats.
pub fn read_wav(bytes: &[u8]) -> Result<Pcm, String> {
    if bytes.len() > LARGEST_TAKE {
        return Err(format!("the recording is too long ({} MB)", bytes.len() >> 20));
    }
    let mut reader = hound::WavReader::new(Cursor::new(bytes)).map_err(|error| format!("not a WAV recording: {error}"))?;
    let spec = reader.spec();
    if spec.bits_per_sample > 32 {
        return Err(format!("not a WAV recording Parrot reads: {} bits a sample", spec.bits_per_sample));
    }
    // hound reads (and fails on) every sample the header claims: a header claiming millions more than the body
    // holds would keep the engine busy for seconds or minutes on nothing
    let claimed_bytes = reader.len() as u64 * spec.bits_per_sample.div_ceil(8) as u64;
    if claimed_bytes > bytes.len() as u64 {
        return Err(format!("the recording is damaged: it says it holds {claimed_bytes} bytes of sound in {}", bytes.len()));
    }
    let ch = spec.channels.max(1) as usize;
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().filter_map(Result::ok).collect(),
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader.samples::<i32>().filter_map(Result::ok).map(|sample| sample as f32 / scale).collect()
        }
    };
    let samples = interleaved.chunks(ch).map(|frame| frame.iter().sum::<f32>() / ch as f32).collect();
    Ok(Pcm { samples, rate: spec.sample_rate })
}

pub fn write_wav(path: &std::path::Path, pcm: &Pcm) -> Result<(), String> {
    let spec = hound::WavSpec { channels: 1, sample_rate: pcm.rate, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut writer = hound::WavWriter::create(path, spec).map_err(|error| error.to_string())?;
    for sample in &pcm.samples {
        writer.write_sample((sample.clamp(-1.0, 1.0) * 32767.0) as i16).map_err(|error| error.to_string())?;
    }
    writer.finalize().map_err(|error| error.to_string())
}

/// High-pass the take at 80 Hz (a second-order filter): desk rumble and handling noise out, the voice untouched.
fn high_pass(samples: &mut [f32], rate: u32) {
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
pub fn clean(mut pcm: Pcm) -> Option<Pcm> {
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
    let mut trimmed = pcm.samples[start..end].to_vec();
    let voiced: Vec<f32> = trimmed
        .chunks(frame)
        .filter(|chunk| db((chunk.iter().map(|sample| sample * sample).sum::<f32>() / chunk.len() as f32).sqrt()) > threshold)
        .flatten()
        .copied()
        .collect();
    let rms = (voiced.iter().map(|sample| sample * sample).sum::<f32>() / voiced.len().max(1) as f32).sqrt();
    let peak = trimmed.iter().fold(0f32, |running_peak, sample| running_peak.max(sample.abs()));
    let gain = (0.1 / rms.max(1e-6)).min(0.95 / peak.max(1e-6)).min(30.0);
    for sample in &mut trimmed {
        *sample *= gain;
    }
    Some(Pcm { samples: trimmed, rate: pcm.rate })
}

/// Resample by linear interpolation, low-passed first when going down so nothing above the new Nyquist folds back.
pub fn resample(pcm: &Pcm, to: u32) -> Vec<f32> {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, secs: f32, amp: f32) -> Vec<f32> {
        (0..(rate as f32 * secs) as usize)
            .map(|sample_index| amp * (2.0 * std::f32::consts::PI * 220.0 * sample_index as f32 / rate as f32).sin())
            .collect()
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
        // 50 million samples claimed, a thousand there: refused before reading any
        let started = std::time::Instant::now();
        let error = read_wav(&wav_claiming(100_000_000, 2000)).err().unwrap();
        assert!(error.contains("damaged"), "{error}");
        assert!(started.elapsed().as_secs_f64() < 0.1, "{:?}", started.elapsed());
        assert!(read_wav(&vec![0; LARGEST_TAKE + 1]).err().unwrap().contains("too long"));
    }

    #[test]
    fn wav_round_trip() {
        let dir = std::env::temp_dir().join("parrot-wav-test.wav");
        write_wav(&dir, &Pcm { samples: tone(16000, 0.5, 0.5), rate: 16000 }).unwrap();
        let back = read_wav(&std::fs::read(&dir).unwrap()).unwrap();
        assert_eq!((back.rate, back.samples.len()), (16000, 8000));
    }
}
