#!/usr/bin/env python3
"""Parrot's speech engine, as a local HTTP server for the app (a prototype: the Rust engine replaces it).

    python engine/server.py [--port 8770]

Needs ffmpeg and whisper-cli (whisper.cpp) on PATH, and torch + torchaudio for the aligner. The whisper model
(small.en) and the pronunciation dictionary are downloaded into the models folder on first use.

Texts live in <data>/texts/<id>/ (text.txt, meta.json); every part of a text that has been recorded gets a folder
named after its words (p-<sha1>), holding each try as <time>.mp3 + <time>.json.
"""
import datetime
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths    # noqa: E402
import sounds   # noqa: E402
import speech   # noqa: E402

PORT = 8770
ID = re.compile(r"[0-9a-f]{10}")


def norm(phrase):
    return " ".join(phrase.split())


def sha(phrase):
    return hashlib.sha1(norm(phrase).encode()).hexdigest()[:10]


def read_text(path):
    with open(path) as file:
        return file.read()


def read_json(path):
    with open(path) as file:
        return json.load(file)


def write_json(path, data):
    with open(path, "w") as file:
        json.dump(data, file, indent=1)


def text_dir(tid):
    if not ID.fullmatch(tid or ""):
        raise ValueError("bad text id")
    folder = os.path.join(paths.TEXTS, tid)
    if not os.path.exists(os.path.join(folder, "text.txt")):
        raise FileNotFoundError(tid)
    return folder


def text_info(folder):
    meta = read_json(os.path.join(folder, "meta.json")) if os.path.exists(os.path.join(folder, "meta.json")) else {}
    body = read_text(os.path.join(folder, "text.txt"))
    created = meta.get("created") or datetime.datetime.fromtimestamp(
        os.path.getmtime(os.path.join(folder, "text.txt"))).isoformat(timespec="seconds")
    per_part = scores(os.path.basename(folder))
    last = [part_scores["last"] for part_scores in per_part.values()]
    return {"id": os.path.basename(folder), "title": meta.get("title") or " ".join(body.split()[:6]) + "…", "text": body,
            "words": len(body.split()), "created": created, "mode": meta.get("mode", "sentences"),
            "opened": meta.get("opened"), "practised": len(last), "scores": per_part,
            "average": round(sum(last) / len(last)) if last else None}


def texts():
    out = [text_info(os.path.dirname(text_path)) for text_path in glob.glob(os.path.join(paths.TEXTS, "*", "text.txt"))]
    return sorted(out, key=lambda info: info["opened"] or info["created"], reverse=True)


def save_meta(folder, **kw):
    path = os.path.join(folder, "meta.json")
    meta = read_json(path) if os.path.exists(path) else {}
    meta.update({key: value for key, value in kw.items() if value is not None})
    write_json(path, meta)


def part_dir(tid, part):
    """The folder of one part of a text, checked to really be in the text."""
    folder = text_dir(tid)
    if not part or norm(part) not in norm(read_text(os.path.join(folder, "text.txt"))):
        raise ValueError("that part is not in the text; reload")
    return os.path.join(folder, "p-" + sha(part))


def scores(tid):
    """{part key: {"last": score, "best": score, "tries": n}} for every recorded part of a text."""
    out = {}
    for part_folder in glob.glob(os.path.join(text_dir(tid), "p-*", "")):
        results = [read_json(result_path) for result_path in sorted(glob.glob(os.path.join(part_folder, "*.json")))]
        if results:
            out[os.path.basename(os.path.dirname(part_folder))] = {
                "last": results[-1]["score"], "best": max(result["score"] for result in results), "tries": len(results)}
    return out


def activity(days=7):
    """Tries per day for the last days (today last), and the average score of those tries."""
    today = datetime.date.today()
    counts = {today - datetime.timedelta(days=days_ago): 0 for days_ago in range(days)}
    total, tries = 0, 0
    for result_path in glob.glob(os.path.join(paths.TEXTS, "*", "p-*", "*.json")):
        stem = os.path.basename(result_path)[:8]
        try:
            day = datetime.date(int(stem[:4]), int(stem[4:6]), int(stem[6:8]))
        except ValueError:
            continue
        if day in counts:
            counts[day] += 1
            total += read_json(result_path)["score"]
            tries += 1
    return {"days": [{"date": day.isoformat(), "tries": counts[day]} for day in sorted(counts)],
            "tries": tries, "average": round(total / tries) if tries else None}


def attempts(folder):
    out = []
    for result_path in sorted(glob.glob(os.path.join(folder, "*.json")), reverse=True):
        result = read_json(result_path)
        out.append({key: result[key] for key in ("id", "when", "score", "wpm", "duration")})
    return out


def media(rel):
    """A recording under the data folder, or None."""
    path = os.path.realpath(os.path.join(paths.DATA, urllib.parse.unquote(rel)))
    ok = path.endswith(".mp3") and path.startswith(os.path.realpath(paths.TEXTS) + os.sep) and os.path.exists(path)
    return path if ok else None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if self.command == "POST":
            sys.stderr.write("%s %s\n" % (self.command, self.path.split("?")[0]))

    def send(self, code, body, ctype="application/json", extra=None):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # the app's webview (tauri://localhost, or the Angular dev server) is another origin
        self.send_header("Access-Control-Allow-Origin", "*")
        for header, value in (extra or {}).items():
            self.send_header(header, value)
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def file(self, path):
        """With Range, so the player can seek."""
        with open(path, "rb") as file:
            data = file.read()
        byte_range = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if byte_range:
            first = int(byte_range.group(1) or 0)
            last = int(byte_range.group(2)) if byte_range.group(2) else len(data) - 1
            return self.send(206, data[first:last + 1], "audio/mpeg",
                             {"Content-Range": f"bytes {first}-{last}/{len(data)}", "Accept-Ranges": "bytes"})
        self.send(200, data, "audio/mpeg", {"Accept-Ranges": "bytes"})

    def route(self, method):
        url = urllib.parse.urlparse(self.path)
        query = dict(urllib.parse.parse_qsl(url.query))
        path = url.path
        if method == "GET":
            if path == "/api/health":
                return {"ok": True, "data": paths.DATA, "whisper": os.path.exists(speech.WHISPER_MODEL)}
            if path == "/api/texts":
                return texts()
            if path == "/api/scores":
                return scores(query["text"])
            if path == "/api/attempts":
                return attempts(part_dir(query["text"], query["part"]))
            if path == "/api/attempt":
                return read_json(os.path.join(part_dir(query["text"], query["part"]),
                                              os.path.basename(query["id"]) + ".json"))
            if path == "/api/activity":
                return activity()
            if path == "/api/peaks":
                # the loudness of a recording in n slices, 0-1, for the waveform
                recording = media(query["f"].removeprefix("/files/"))
                if not recording:
                    return self.send(404, {"error": "not found"})
                return speech.peaks(recording, int(query.get("n", 92)))
            if path == "/api/pron":
                return sounds.sounds_like(query["w"]) or {}
            if path.startswith("/files/"):
                recording = media(path[7:])
                return self.file(recording) if recording else self.send(404, {"error": "not found"})
            if path == "/clip":
                # one word cut exactly (a playing file can't be stopped on time from the page), slowed with atempo
                recording = media(query["f"].removeprefix("/files/"))
                if not recording:
                    return self.send(404, {"error": "not found"})
                start, end = float(query["a"]), float(query["b"])
                rate = max(0.5, min(1.0, float(query.get("rate", 1))))
                fade = min(0.015, (end - start) / 4)
                wav = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}",
                                      "-i", recording,
                                      "-af", f"afade=t=in:d={fade:.3f},areverse,afade=t=in:d={fade:.3f},areverse,"
                                      f"atempo={rate},apad=pad_dur=0.05", "-ac", "1", "-f", "wav", "-"],
                                     capture_output=True).stdout
                return self.send(200, wav, "audio/wav")
        else:
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if path == "/api/texts":
                payload = json.loads(body)
                body_text = norm(payload["text"])
                if not body_text:
                    raise ValueError("the text is empty")
                folder = os.path.join(paths.TEXTS, sha(body_text))
                os.makedirs(folder, exist_ok=True)
                with open(os.path.join(folder, "text.txt"), "w") as file:
                    file.write(body_text)
                created = None if os.path.exists(os.path.join(folder, "meta.json")) else \
                    datetime.datetime.now().isoformat(timespec="seconds")
                save_meta(folder, title=(payload.get("title") or "").strip() or None, mode=payload.get("mode"),
                          created=created)
                return text_info(folder)
            if path == "/api/texts/update":
                payload = json.loads(body)
                folder = text_dir(payload["id"])
                save_meta(folder, title=(payload.get("title") or "").strip() or None, mode=payload.get("mode"),
                          opened=datetime.datetime.now().isoformat(timespec="seconds") if payload.get("opened") else None)
                return text_info(folder)
            if path == "/api/texts/delete":
                # moved to the trash folder, not deleted
                folder = text_dir(json.loads(body)["id"])
                os.makedirs(paths.TRASH, exist_ok=True)
                os.rename(folder, os.path.join(paths.TRASH, os.path.basename(folder) + "-" +
                                               datetime.datetime.now().strftime("%Y%m%d-%H%M%S")))
                return {"ok": True}
            if path == "/api/check":
                folder = part_dir(query["text"], query["part"])
                ext = "mp4" if "mp4" in self.headers.get("Content-Type", "") else "webm"
                return speech.check(folder, norm(query["part"]), body, ext)
        return self.send(404, {"error": "not found"})

    def handle_method(self, method):
        try:
            response = self.route(method)
            if response is not None:
                self.send(200, response)
        except (KeyError, FileNotFoundError) as error:
            self.send(404, {"error": f"not found: {error}"})
        except ValueError as error:
            self.send(400, {"error": str(error)})
        except subprocess.CalledProcessError as error:
            self.send(500, {"error": f"could not read the recording ({error})"})
        except Exception as error:      # a message in the app, not a dropped connection
            self.send(500, {"error": f"{type(error).__name__}: {error}"})

    def do_GET(self):
        self.handle_method("GET")

    def do_POST(self):
        self.handle_method("POST")


def main():
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else PORT
    os.makedirs(paths.TEXTS, exist_ok=True)
    threading.Thread(target=speech.warm, daemon=True).start()
    print(f"Parrot engine on http://127.0.0.1:{port} (data in {paths.DATA}); Ctrl-C to stop")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
