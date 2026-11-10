"""Private, same-origin schedule server. Requires an HTTPS reverse proxy in production."""

import getpass
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import sqlite3
import time
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("SCHEDULE_DB", str(ROOT / "server" / "schedule.db")))
PASSWORD_HASH = os.environ.get("SCHEDULE_PASSWORD_HASH", "")
PASSWORD_FILE = DB_PATH.parent / "password.hash"
PASSWORD_LOCK = Lock()
COOKIE_SECURE = os.environ.get("SCHEDULE_HTTPS", "0") == "1"
SESSIONS = {}
SESSIONS_LOCK = Lock()
DB_LOCK = Lock()
LOGIN_LOCK = Lock()
LOGIN_ATTEMPTS = {}


def login_wait(key, now=None):
    """Reserve an attempt before hashing, including concurrent requests."""
    now = time.monotonic() if now is None else now
    with LOGIN_LOCK:
        for old_key, (_, expiry) in list(LOGIN_ATTEMPTS.items()):
            if expiry <= now:
                del LOGIN_ATTEMPTS[old_key]
        count, expiry = LOGIN_ATTEMPTS.get(key, (0, now + 300))
        if count >= 5:
            return max(1, int(expiry - now + 0.999))
        if len(LOGIN_ATTEMPTS) >= 1000 and key not in LOGIN_ATTEMPTS:
            return 300
        LOGIN_ATTEMPTS[key] = (count + 1, expiry)
        return 0


def login_succeeded(key):
    with LOGIN_LOCK:
        LOGIN_ATTEMPTS.pop(key, None)
MAX_BODY = 2 * 1024 * 1024
FILES = {
    "/state.js": "state.js", "/storage.js": "storage.js",
    "/users.html": "users.html",
    "/glass.css": "glass.css",
    "/": "index.html", "/index.html": "index.html",
    "/training.html": "training.html", "/university.html": "university.html",
    "/manifest.webmanifest": "manifest.webmanifest",
    "/icon.svg": "icon.svg", "/icon-192.png": "icon-192.png",
    "/icon-512.png": "icon-512.png", "/server-mode.js": "server/server-mode.js",
}


def make_hash(password):
    salt = secrets.token_hex(16)
    rounds = 240_000
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), rounds)
    return f"pbkdf2_sha256${rounds}${salt}${digest.hex()}"


def verify_password(password):
    try:
        stored = PASSWORD_FILE.read_text().strip() if PASSWORD_FILE.exists() else PASSWORD_HASH
        algorithm, rounds, salt, expected = stored.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(rounds))
        return hmac.compare_digest(digest, bytes.fromhex(expected))
    except (ValueError, TypeError):
        return False


def connect():
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=10000")
    return db


@contextmanager
def db_session():
    db = connect()
    try:
        with db:
            yield db
    finally:
        db.close()


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with db_session() as db:
        db.execute("CREATE TABLE IF NOT EXISTS schedule_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL)")
        db.execute("INSERT OR IGNORE INTO schedule_state VALUES (1, 0, ?, ?)", (json.dumps({"logs": {}, "extraCourses": [], "historyHours": "0", "trainingRate": "0"}), datetime.now(timezone.utc).isoformat()))


def get_state():
    with db_session() as db:
        revision, content = db.execute("SELECT revision, content FROM schedule_state WHERE id=1").fetchone()
    return revision, json.loads(content)


def validate_state(state):
    if not isinstance(state, dict) or set(state) != {"logs", "extraCourses", "historyHours", "trainingRate"}:
        raise ValueError("Invalid state fields")
    if not isinstance(state["logs"], dict) or not isinstance(state["extraCourses"], list):
        raise ValueError("Invalid records")
    if len(state["logs"]) > 10000 or len(state["extraCourses"]) > 3000:
        raise ValueError("Too many records")
    for key, item in state["logs"].items():
        if not isinstance(key, str) or len(key) > 120 or not isinstance(item, dict) or item.get("status") not in ("pending", "done", "leave", "cancel"):
            raise ValueError("Invalid log")
    for item in state["extraCourses"]:
        if not isinstance(item, dict) or not isinstance(item.get("code"), str) or not isinstance(item.get("date"), str):
            raise ValueError("Invalid extra course")
    for key in ("historyHours", "trainingRate"):
        try:
            number = float(state[key])
        except (ValueError, TypeError):
            raise ValueError("Invalid number") from None
        if not 0 <= number <= 1_000_000:
            raise ValueError("Number out of range")


def update_state(revision, state):
    validate_state(state)
    with DB_LOCK:
        with db_session() as db:
            current = db.execute("SELECT revision FROM schedule_state WHERE id=1").fetchone()[0]
            if revision != current:
                return None
            new_revision = current + 1
            db.execute("UPDATE schedule_state SET revision=?, content=?, updated_at=? WHERE id=1", (new_revision, json.dumps(state, ensure_ascii=False), datetime.now(timezone.utc).isoformat()))
            return new_revision


LOGIN_HTML = """<!doctype html><html lang='zh-CN'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>课表登录</title><style>body{font-family:system-ui,sans-serif;background:#f6f7fa;color:#172039;margin:0;display:grid;place-items:center;min-height:100vh}main{background:white;padding:28px;border-radius:18px;width:min(350px,85vw);box-shadow:0 8px 32px #ccd2e355}input,button{box-sizing:border-box;width:100%;padding:13px;margin-top:12px;border:1px solid #ccd2e3;border-radius:10px;font:inherit}button{background:#59679f;color:white;cursor:pointer}</style><main><h1>我的课表</h1><p>登录后查看和保存课时记录。</p><form method='post' action='/api/login'><input name='password' type='password' placeholder='密码' autocomplete='current-password' required><button>登录</button></form></main></html>"""


class Handler(BaseHTTPRequestHandler):
    def respond(self, status, body, content_type="application/json; charset=utf-8", headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def json_response(self, status, obj, headers=None):
        self.respond(status, json.dumps(obj, ensure_ascii=False).encode(), headers=headers)

    def session(self):
        jar = cookies.SimpleCookie()
        try:
            jar.load(self.headers.get("Cookie", ""))
            token = jar["schedule_session"].value
        except (KeyError, cookies.CookieError):
            return None
        with SESSIONS_LOCK:
            data = SESSIONS.get(token)
            if data and data["expires"] > time.time():
                return data
            SESSIONS.pop(token, None)
        return None

    def read_body(self):
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if size < 0 or size > MAX_BODY:
            return None
        return self.rfile.read(size)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/login":
            return self.respond(200, LOGIN_HTML.encode(), "text/html; charset=utf-8")
        session = self.session()
        if not session:
            if path.startswith("/api/"):
                return self.json_response(401, {"error": "login_required"})
            return self.respond(302, b"", headers={"Location": "/login"})
        if path == "/api/state":
            revision, state = get_state()
            return self.json_response(200, {"revision": revision, "state": state, "csrf": session["csrf"]})
        if path not in FILES:
            return self.respond(404, b"Not found", "text/plain; charset=utf-8")
        name = FILES[path]
        body = (ROOT / name).read_bytes()
        if path in ("/", "/index.html"):
            body = body.replace(b"</section>", '<a href="/users.html"><strong>用户管理</strong><span>修改登录密码</span></a></section>'.encode(), 1)
        if path == "/university.html":
            body = body.replace(b"<script>", b"<script>window.SERVER_MODE=true;</script>\n<script>", 1)
        if path == "/training.html":
            body = body.replace(b"<script>", b"<script>window.SERVER_MODE=true;</script>\n<script>", 1)
            body = body.replace(b"</body>", b"<script src='/server-mode.js'></script>\n</body>", 1)
        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        return self.respond(200, body, mime + ("; charset=utf-8" if mime.startswith("text/") or mime in ("application/javascript", "application/manifest+json") else ""))

    def do_POST(self):
        path = urlsplit(self.path).path
        body = self.read_body()
        if body is None:
            return self.json_response(413, {"error": "body_too_large"})
        if path == "/api/login":
            # The service is loopback-only behind Tailscale. Do not trust
            # caller-supplied forwarding headers to bypass throttling.
            key = self.client_address[0]
            wait = login_wait(key)
            if wait:
                return self.respond(429, f"登录尝试过多，请在{wait}秒后重试。".encode(), "text/plain; charset=utf-8", {"Retry-After": str(wait)})
            from urllib.parse import parse_qs
            password = parse_qs(body.decode(errors="replace")).get("password", [""])[0]
            if not verify_password(password):
                time.sleep(0.3)
                return self.respond(403, "密码错误".encode(), "text/plain; charset=utf-8")
            login_succeeded(key)
            token = secrets.token_urlsafe(32)
            with SESSIONS_LOCK:
                SESSIONS[token] = {"token": token, "csrf": secrets.token_urlsafe(24), "expires": time.time() + 14 * 86400}
            secure = "; Secure" if COOKIE_SECURE else ""
            return self.respond(303, b"", headers={"Location": "/", "Set-Cookie": f"schedule_session={token}; HttpOnly; SameSite=Strict; Path=/{secure}"})
        session = self.session()
        if not session:
            return self.json_response(401, {"error": "login_required"})
        if self.headers.get("X-CSRF-Token") != session["csrf"]:
            return self.json_response(403, {"error": "csrf_failed"})
        if path == "/api/password":
            wait = login_wait(self.client_address[0])
            if wait:
                return self.json_response(429, {"error": f"尝试过多，请{wait}秒后重试"}, {"Retry-After": str(wait)})
            try:
                data = json.loads(body)
                old, new = data["oldPassword"], data["newPassword"]
                if not isinstance(old, str) or not isinstance(new, str) or not 6 <= len(new) <= 128:
                    return self.json_response(400, {"error": "新密码需要6至128个字符"})
                with PASSWORD_LOCK:
                    if not verify_password(old):
                        return self.json_response(403, {"error": "原密码不正确"})
                    temp = PASSWORD_FILE.with_suffix(".tmp")
                    with open(temp, "w", encoding="utf-8") as file:
                        os.chmod(temp, 0o600)
                        file.write(make_hash(new))
                        file.flush()
                        os.fsync(file.fileno())
                    temp.replace(PASSWORD_FILE)
                    with SESSIONS_LOCK:
                        SESSIONS.clear()
                login_succeeded(self.client_address[0])
                return self.json_response(200, {"ok": True})
            except (ValueError, KeyError, TypeError):
                return self.json_response(400, {"error": "请求格式不正确"})
        if path == "/api/logout":
            with SESSIONS_LOCK:
                SESSIONS.pop(session["token"], None)
            secure = "; Secure" if COOKIE_SECURE else ""
            return self.respond(303, b"", headers={"Location": "/login", "Set-Cookie": f"schedule_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0{secure}"})
        if path == "/api/state":
            try:
                payload = json.loads(body)
                revision = payload["revision"]
                if not isinstance(revision, int) or isinstance(revision, bool):
                    raise ValueError("Invalid revision")
                new_revision = update_state(revision, payload["state"])
            except (ValueError, KeyError, TypeError):
                return self.json_response(400, {"error": "invalid_state"})
            if new_revision is None:
                return self.json_response(409, {"error": "revision_conflict"})
            return self.json_response(200, {"revision": new_revision})
        return self.json_response(404, {"error": "not_found"})


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "hash":
        print(make_hash(getpass.getpass("New schedule password: ")))
    elif len(sys.argv) > 1 and sys.argv[1] == "backup":
        init_db()
        destination = Path(sys.argv[2]) if len(sys.argv) > 2 else DB_PATH.parent / "backups" / f"schedule-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            raise SystemExit("Backup destination already exists")
        with closing(connect()) as source, closing(sqlite3.connect(destination)) as target:
            source.backup(target)
        print(destination)
    else:
        if not PASSWORD_HASH:
            raise SystemExit("Set SCHEDULE_PASSWORD_HASH before starting")
        init_db()
        host = os.environ.get("SCHEDULE_HOST", "127.0.0.1")
        port = int(os.environ.get("SCHEDULE_PORT", "8090"))
        print(f"Schedule server listening on {host}:{port}")
        ThreadingHTTPServer((host, port), Handler).serve_forever()
