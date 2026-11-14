"""Voicepad: local-only, dependency-free media and session server."""
from __future__ import annotations

import argparse
import json
import logging
import math
import mimetypes
import os
from pathlib import Path
import re
import threading
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
APP = "voicepad-local-v1"
ID = re.compile(r"^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9]+)?$")


class Store:
    def __init__(self, root):
        self.root = Path(root).resolve()
        for folder in ("sessions", "assets", "exports"):
            (self.root / folder).mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()

    def atomic_json(self, path, data):
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp, path)

    def session_path(self, sid):
        if not re.fullmatch(r"[a-f0-9]{32}", sid):
            raise ValueError("Invalid session ID")
        return self.root / "sessions" / (sid + ".json")

    def get(self, sid):
        return json.loads(self.session_path(sid).read_text(encoding="utf-8"))

    def listing(self):
        sessions = []
        for path in (self.root / "sessions").glob("*.json"):
            try:
                s = json.loads(path.read_text(encoding="utf-8"))
                sessions.append({k: s[k] for k in ("id", "name", "updated")})
            except (ValueError, KeyError):
                logging.exception("Cannot read session %s", path)
        return sorted(sessions, key=lambda s: s["updated"], reverse=True)

    def validate(self, payload):
        result = {"name": str(payload.get("name", "Untitled"))[:120],
                  "video": payload.get("video"), "cues": payload.get("cues", []),
                  "clips": payload.get("clips", [])}
        if not isinstance(result["cues"], list) or not isinstance(result["clips"], list):
            raise ValueError("Invalid session data")
        if len(result["cues"]) > 20000 or len(result["clips"]) > 40000:
            raise ValueError("Session is too large")
        def number(value):
            return isinstance(value, (int, float)) and math.isfinite(value) and value >= 0
        cue_ids = set()
        for cue in result["cues"]:
            if (not isinstance(cue.get("id"), str) or cue["id"] in cue_ids
                    or not number(cue.get("start")) or not number(cue.get("end"))
                    or cue["end"] <= cue["start"] or not isinstance(cue.get("text"), str)):
                raise ValueError("Invalid subtitle timing or duplicate subtitle ID")
            cue_ids.add(cue["id"])
        def asset_exists(asset):
            return (isinstance(asset, str) and ID.fullmatch(asset)
                    and (self.root / "assets" / asset).is_file())
        if result["video"] and not asset_exists(result["video"].get("id")):
            raise ValueError("Video asset is missing")
        clip_ids = set()
        for clip in result["clips"]:
            if (not isinstance(clip.get("id"), str) or clip["id"] in clip_ids
                    or not asset_exists(clip.get("asset"))
                    or not all(number(clip.get(k)) for k in ("start", "offset", "duration"))
                    or clip["duration"] <= 0
                    or (clip.get("cueId") is not None and clip["cueId"] not in cue_ids)):
                raise ValueError("Invalid recording clip")
            clip_ids.add(clip["id"])
        return result

    def create(self, payload):
        with self.lock:
            s = self.validate(payload)
            s.update(id=uuid.uuid4().hex, revision=1, updated=time.time())
            self.atomic_json(self.session_path(s["id"]), s)
            return s

    def save(self, sid, payload):
        with self.lock:
            old = self.get(sid)
            if payload.get("revision") != old["revision"]:
                raise RuntimeError("This session was changed in another window. Reload before editing.")
            s = self.validate(payload)
            s.update(id=sid, revision=old["revision"] + 1, updated=time.time())
            self.atomic_json(self.session_path(sid), s)
            return s


def make_handler(store):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            logging.info(fmt, *args)

        def allowed(self):
            port = self.server.server_address[1]
            hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
            origin = self.headers.get("Origin")
            return (self.headers.get("Host") in hosts
                    and (not origin or origin in {"http://" + h for h in hosts})
                    and self.headers.get("Sec-Fetch-Site") != "cross-site")

        def reply(self, value, status=200):
            body = json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def body_json(self):
            size = int(self.headers.get("Content-Length", 0))
            if not 0 < size <= 8 * 1024 * 1024:
                raise ValueError("Invalid request size")
            return json.loads(self.rfile.read(size).decode("utf-8"))

        def do_GET(self):
            if not self.allowed():
                return self.reply({"error": "Only this local app can access its files."}, 403)
            path = unquote(urlsplit(self.path).path)
            try:
                if path == "/api/bootstrap":
                    return self.reply({"app": APP, "sessions": store.listing()})
                if path.startswith("/api/sessions/"):
                    return self.reply(store.get(path.rsplit("/", 1)[1]))
                if path.startswith(("/assets/", "/exports/")):
                    folder, name = path.strip("/").split("/", 1)
                    if not ID.fullmatch(name):
                        raise FileNotFoundError()
                    return self.serve_file(store.root / folder / name, download=folder == "exports")
                static = {"/": "index.html", "/index.html": "index.html",
                          "/app.js": "app.js", "/core.mjs": "core.mjs",
                          "/recorder-worklet.js": "recorder-worklet.js", "/style.css": "style.css"}
                if path not in static:
                    raise FileNotFoundError()
                self.serve_file(ROOT / "web" / static[path])
            except (ValueError, FileNotFoundError):
                self.reply({"error": "File not found"}, 404)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def serve_file(self, path, download=False):
            size = path.stat().st_size
            start, end, status = 0, size - 1, 200
            ranges = self.headers.get("Range")
            if ranges:
                match = re.fullmatch(r"bytes=(\d*)-(\d*)", ranges)
                if not match or not any(match.groups()):
                    return self.range_error(size)
                a, b = match.groups()
                if a:
                    start = int(a)
                    end = min(int(b), end) if b else end
                else:
                    start = max(0, size - int(b))
                if start >= size or end < start:
                    return self.range_error(size)
                status = 206
            length = max(0, end - start + 1)
            mime = {".js": "text/javascript", ".mjs": "text/javascript", ".wav": "audio/wav",
                    ".srt": "text/plain; charset=utf-8"}.get(path.suffix, mimetypes.guess_type(path.name)[0] or "application/octet-stream")
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            if download:
                self.send_header("Content-Disposition", f'attachment; filename="{path.name}"')
            self.end_headers()
            with path.open("rb") as stream:
                stream.seek(start)
                while length:
                    chunk = stream.read(min(length, 256 * 1024))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    length -= len(chunk)

        def range_error(self, size):
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_POST(self):
            self.mutate()

        def do_PUT(self):
            self.mutate()

        def mutate(self):
            if not self.allowed():
                self.close_connection = True
                return self.reply({"error": "Cross-site request rejected"}, 403)
            parsed = urlsplit(self.path)
            path = parsed.path
            try:
                if self.command == "PUT" and path.startswith("/api/sessions/"):
                    return self.reply(store.save(path.rsplit("/", 1)[1], self.body_json()))
                if path == "/api/sessions":
                    return self.reply(store.create(self.body_json()), 201)
                if path in ("/api/assets", "/api/exports"):
                    params = parse_qs(parsed.query)
                    name = params.get("name", ["recording.wav"])[0]
                    ext = Path(name).suffix.lower()
                    allowed = {".mp4", ".webm", ".mov", ".m4v", ".ogg", ".wav"} if path.endswith("assets") else {".wav", ".srt"}
                    if ext not in allowed:
                        raise ValueError("Unsupported file type")
                    size = int(self.headers.get("Content-Length", 0))
                    if not 0 < size <= 2 * 1024**3:
                        raise ValueError("File must be between 1 byte and 2 GB")
                    key = uuid.uuid4().hex + ext
                    folder = "assets" if path.endswith("assets") else "exports"
                    if folder == "exports":
                        stem = re.sub(r"[^a-zA-Z0-9_-]", "_", Path(name).stem)[:70].strip("_") or "voicepad"
                        key = f"{stem}-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4]}{ext}"
                    target = store.root / folder / key
                    temp = target.with_suffix(".upload")
                    try:
                        with temp.open("wb") as output:
                            remaining = size
                            while remaining:
                                chunk = self.rfile.read(min(remaining, 1024 * 1024))
                                if not chunk:
                                    raise ValueError("Upload interrupted")
                                output.write(chunk)
                                remaining -= len(chunk)
                        os.replace(temp, target)
                    finally:
                        temp.unlink(missing_ok=True)
                    return self.reply({"id": key, "name": name, "url": f"/{folder}/{key}"}, 201)
                if path == "/api/quit":
                    self.reply({"ok": True})
                    threading.Thread(target=self.server.shutdown, daemon=True).start()
                    return
                self.reply({"error": "Unknown endpoint"}, 404)
            except RuntimeError as exc:
                self.reply({"error": str(exc)}, 409)
            except (ValueError, KeyError, TypeError) as exc:
                self.close_connection = True
                self.reply({"error": str(exc)}, 400)
            except FileNotFoundError:
                self.reply({"error": "File not found"}, 404)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                logging.exception("Request failed")
                self.reply({"error": "Could not save to disk. Check free space and the log."}, 500)
    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8768)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args()
    store = Store(args.data_dir)
    logging.basicConfig(filename=store.root / "voicepad.log", level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    url = f"http://127.0.0.1:{args.port}"
    try:
        with urlopen(url + "/api/bootstrap", timeout=1) as response:
            if json.load(response).get("app") == APP:
                if args.open:
                    webbrowser.open(url)
                return
    except Exception:
        pass
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(store))
    server.daemon_threads = True
    if args.open:
        webbrowser.open(url)
    logging.info("Voicepad listening on %s", url)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
