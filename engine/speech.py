"""The two listeners: whisper writes down what it heard, the forced aligner places each word of the text in the
recording and scores how well the sounds match it. Plus the audio clean-up and the check of one recording.
"""
import datetime
import json
import os
import subprocess
import tempfile
import threading

import paths
import text

WHISPER_MODEL = os.environ.get("PARROT_WHISPER_MODEL", os.path.join(paths.MODELS, "ggml-small.en.bin"))
WHISPER_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin"

_lock = threading.Lock()
_mms = None


def ensure_whisper_model():
    if not os.path.exists(WHISPER_MODEL):
        os.makedirs(os.path.dirname(WHISPER_MODEL), exist_ok=True)
        subprocess.run(["curl", "-sSfL", "-o", WHISPER_MODEL + ".part", WHISPER_URL], check=True)
        os.rename(WHISPER_MODEL + ".part", WHISPER_MODEL)


def aligner():
    """The forced aligner, loaded on first use (torch takes a few seconds).
    Prototype only: the MMS weights are CC-BY-NC; the Rust engine will use an Apache-2.0 English wav2vec2."""
    global _mms
    if _mms is None:
        from torchaudio.pipelines import MMS_FA
        _mms = (MMS_FA.get_model(with_star=False), MMS_FA.get_tokenizer(), MMS_FA.get_aligner(),
                set(MMS_FA.get_labels()) - {"-", "*"})
    return _mms


def warm():
    with _lock:
        aligner()
    ensure_whisper_model()


def to_wav16(src, dst):
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", src, "-ar", "16000", "-ac", "1", dst], check=True)


def duration(path):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                                capture_output=True, text=True).stdout or 0)


def peaks(path, slice_count=92):
    """The loudest sample of each of slice_count equal slices of a recording, scaled so the loudest slice is 1."""
    import numpy as np
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", path, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
                         capture_output=True, check=True).stdout
    levels = np.abs(np.frombuffer(raw, dtype=np.int16).astype(np.float32))
    if not len(levels):
        return []
    slices = np.array_split(levels, slice_count)
    loudest = np.array([piece.max() if len(piece) else 0 for piece in slices])
    top = loudest.max() or 1
    return [round(float(level / top), 3) for level in loudest]


def align(wav16, txt):
    """[{"t": [start, end] or None, "score": 0-1 or None}] for every whitespace-separated word of txt."""
    import torch
    import torchaudio
    with _lock:
        model, tokenizer, span_aligner, labels = aligner()
        wave, sample_rate = torchaudio.load(wav16)
        script_words = txt.split()
        clean = ["".join(char for char in word.lower().replace("’", "'") if char in labels) for word in script_words]
        placeable = [index for index, cleaned in enumerate(clean) if cleaned]
        out = [{"t": None, "score": None} for _ in script_words]
        if not placeable:
            return out
        with torch.inference_mode():
            emission, _ = model(wave)
            try:
                spans = span_aligner(emission[0], tokenizer([clean[index] for index in placeable]))
            except RuntimeError:
                # the recording is too short for the text (stopped early): nothing can be placed, every word scores 0
                return [{"t": None, "score": 0.0} for _ in script_words]
    ratio = wave.size(1) / emission.size(1) / sample_rate
    for index, word_spans in zip(placeable, spans):
        frames = sum(span.end - span.start for span in word_spans) or 1
        out[index] = {"t": [round(word_spans[0].start * ratio, 3), round(word_spans[-1].end * ratio, 3)],
                      "score": round(sum(span.score * (span.end - span.start) for span in word_spans) / frames, 3)}
    return out


def transcribe(wav16, words=None, limit=25.0):
    """What whisper hears. whisper.cpp reads 30-second windows and on a long take it can drop everything up to the
    next window, so a take longer than limit is cut into chunks at the pauses between words (word times from the
    aligner) and each chunk is heard on its own."""
    def hear(path):
        result = subprocess.run(["whisper-cli", "-m", WHISPER_MODEL, "-f", path, "-nt", "-np"],
                                capture_output=True, text=True)
        return " ".join(result.stdout.split())
    ensure_whisper_model()
    times = [word["t"] for word in (words or []) if word["t"]]
    if not times or times[-1][1] <= limit:
        return hear(wav16)
    gaps = [(earlier[1], later[0]) for earlier, later in zip(times, times[1:])]
    cuts, start = [], 0.0
    while times[-1][1] - start > limit:
        # the widest pause in the last 40% of the window, so every chunk keeps some context
        window = [(gap_end - gap_start, (gap_start + gap_end) / 2) for gap_start, gap_end in gaps
                  if start + limit * 0.6 < (gap_start + gap_end) / 2 < start + limit]
        cut = max(window)[1] if window else start + limit
        cuts.append(cut)
        start = cut
    out, edges = [], [0.0] + cuts + [None]
    with tempfile.TemporaryDirectory() as tmp:
        for chunk, (chunk_start, chunk_end) in enumerate(zip(edges, edges[1:])):
            part = os.path.join(tmp, f"{chunk}.wav")
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", wav16, "-ss", f"{chunk_start:.3f}",
                            *(["-to", f"{chunk_end:.3f}"] if chunk_end else []), part], check=True)
            out.append(hear(part))
    return " ".join(out)


def check(folder, txt, body, ext, ref=None):
    """Save a recording (trimmed, rumble removed, levelled), score it against txt, keep the result next to it."""
    os.makedirs(folder, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    mp3 = os.path.join(folder, stamp + ".mp3")
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "in." + ext)
        open(src, "wb").write(body)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", src, "-af",
                        "silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.15,"
                        "areverse,silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.25,areverse,"
                        "highpass=f=80,loudnorm=I=-18:TP=-1.5", "-ar", "48000", "-ac", "1", "-b:a", "160k", mp3],
                       check=True)
        wav = os.path.join(tmp, "a.wav")
        # a silent take trims down to nothing: ffmpeg then writes an empty file it can't read back
        dur = 0.0
        if os.path.getsize(mp3) > 1000:
            to_wav16(mp3, wav)
            dur = duration(wav)
        if dur < 0.5:
            os.remove(mp3)
            return {"error": "Nothing was heard in the recording. Is the microphone on?"}
        mine = align(wav, txt)
        heard = transcribe(wav, mine)
        # stopped before the end: the aligner squeezes the whole text into the take and the words that were said
        # score low, so score only the words up to the last one whisper heard; the rest count as missed
        wrong, _ = text.heard_words(txt, heard)
        said = max((index for index, heard_as in enumerate(wrong) if heard_as is None), default=-1) + 1
        stopped_early = 0 < said < len(mine) and all(heard_as == "" for heard_as in wrong[said:])
        if stopped_early:
            mine[:said] = align(wav, " ".join(txt.split()[:said]))
            mine[said:] = [{"t": None, "score": 0.0} for _ in mine[said:]]
    words = text.judge(txt, heard, mine, ref)
    good = sum(word["status"] == "good" for word in words)
    # the pace of the words read: all of them, unless the take stopped early
    spoken = said if stopped_early else len(words)
    result = {"id": stamp, "when": datetime.datetime.now().isoformat(timespec="seconds"), "text": txt, "heard": heard,
              "words": words, "duration": round(dur, 2), "wpm": round(spoken / dur * 60) if dur else 0,
              "score": round(100 * good / max(1, len(words))),
              "audio": "/files/" + os.path.relpath(mp3, paths.DATA)}
    json.dump(result, open(os.path.join(folder, stamp + ".json"), "w"), indent=1)
    return result
