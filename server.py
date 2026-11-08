#!/usr/bin/env python3
"""Локальный сервер для листа персонажа Dark Heresy.

Раздаёт статические файлы проекта и предоставляет JSON API для хранения
персонажей в SQLite (`characters.sqlite3` рядом со скриптом).

Запуск:
    python3 server.py
    python3 server.py --port 8123
    PORT=8123 python3 server.py
"""

import argparse
import datetime as dt
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import traceback
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

# Каталог проекта — тот, где лежит server.py
PROJECT_DIR = os.path.dirname(os.path.abspath(__file__)) or "."
DB_PATH = os.path.join(PROJECT_DIR, "characters.sqlite3")
REFERENCE_SEED_PATH = os.path.join(PROJECT_DIR, "reference_seed.json")
# Increment this when changing the seed; only reference tables are reseeded.
REFERENCE_DATA_VERSION = 4
SESSION_COOKIE = "dh1_session"
SESSION_DAYS = 30
PASSWORD_MIN = 4
PASSWORD_MAX = 20
PBKDF2_ITERATIONS = 310_000

# Расширения, которые точно стоит отдавать из проекта
STATIC_EXTENSIONS = {
    ".html", ".js", ".css", ".json", ".xml", ".txt",
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
    ".woff", ".woff2", ".ttf", ".eot",
}


def init_db():
    """Создаёт и обновляет таблицы приложения, если нужно."""
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS characters (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at TEXT,
                updated_at TEXT,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
            )
        """)
        columns = {row[1] for row in conn.execute("PRAGMA table_info(characters)")}
        if "user_id" not in columns:
            conn.execute("ALTER TABLE characters ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE")
        create_reference_tables(conn)
        seed_reference_tables(conn)
        conn.commit()


def create_reference_tables(conn):
    """Создаёт отдельную таблицу для каждого набора игровых справочников."""
    definitions = [
        "CREATE TABLE IF NOT EXISTS reference_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS worlds (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS chars (key TEXT PRIMARY KEY, position INTEGER NOT NULL, name TEXT NOT NULL, abbr TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS careers (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS skill_list (position INTEGER PRIMARY KEY, data TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS skill_groups (name TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS skill_texts (name TEXT PRIMARY KEY, position INTEGER NOT NULL, text TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS biographies (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS career_advancements (id TEXT PRIMARY KEY, career_id TEXT NOT NULL, rank_name TEXT NOT NULL, worlds TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS talents (name TEXT PRIMARY KEY, position INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS sanctions (dice_range TEXT PRIMARY KEY, position INTEGER NOT NULL, effect TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS carry_table (position INTEGER PRIMARY KEY, value REAL NOT NULL)",
        "CREATE TABLE IF NOT EXISTS talent_effects (name TEXT PRIMARY KEY, position INTEGER NOT NULL, effect TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS armory_catalog (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL)",
    ]
    for sql in definitions:
        conn.execute(sql)


def seed_reference_tables(conn):
    """Импортирует начальные справочники один раз на версию, одной транзакцией."""
    row = conn.execute(
        "SELECT value FROM reference_meta WHERE key = 'data_version'"
    ).fetchone()
    if row and int(row[0]) >= REFERENCE_DATA_VERSION:
        return

    with open(REFERENCE_SEED_PATH, "r", encoding="utf-8") as seed_file:
        seed = json.load(seed_file)

    for table in (
        "worlds", "chars", "careers", "skill_list", "skill_groups", "skill_texts",
        "biographies", "career_advancements", "talents", "sanctions", "carry_table", "talent_effects", "armory_catalog",
    ):
        conn.execute(f"DELETE FROM {table}")

    encode = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    conn.executemany(
        "INSERT INTO worlds (id, position, data) VALUES (?, ?, ?)",
        [(item["id"], i, encode(item)) for i, item in enumerate(seed["worlds"])],
    )
    conn.executemany(
        "INSERT INTO chars (key, position, name, abbr) VALUES (?, ?, ?, ?)",
        [(item["key"], i, item["name"], item["abbr"]) for i, item in enumerate(seed["chars"])],
    )
    conn.executemany(
        "INSERT INTO careers (id, position, data) VALUES (?, ?, ?)",
        [(item["id"], i, encode(item)) for i, item in enumerate(seed["careers"])],
    )
    conn.executemany(
        "INSERT INTO skill_list (position, data) VALUES (?, ?)",
        [(i, encode(item)) for i, item in enumerate(seed["skill_list"])],
    )
    conn.executemany(
        "INSERT INTO skill_groups (name, position, data) VALUES (?, ?, ?)",
        [(name, i, encode(items)) for i, (name, items) in enumerate(seed["skill_groups"].items())],
    )
    conn.executemany(
        "INSERT INTO skill_texts (name, position, text) VALUES (?, ?, ?)",
        [(name, i, text) for i, (name, text) in enumerate(seed["skill_texts"].items())],
    )
    conn.executemany(
        "INSERT INTO biographies (id, position, data) VALUES (?, ?, ?)",
        [(item["id"], i, encode(item)) for i, item in enumerate(seed["biographies"])],
    )
    conn.executemany(
        "INSERT INTO career_advancements (id, career_id, rank_name, worlds, position, data) VALUES (?, ?, ?, ?, ?, ?)",
        [(f"{item['career']}:{i}", item["career"], item["rank"], encode(item["worlds"]), i, encode(item)) for i, item in enumerate(seed["career_advancements"])],
    )
    conn.executemany(
        "INSERT INTO talents (name, position) VALUES (?, ?)",
        [(name, i) for i, name in enumerate(seed["talents"])],
    )
    conn.executemany(
        "INSERT INTO sanctions (dice_range, position, effect) VALUES (?, ?, ?)",
        [(dice_range, i, effect) for i, (dice_range, effect) in enumerate(seed["sanctions"].items())],
    )
    conn.executemany(
        "INSERT INTO carry_table (position, value) VALUES (?, ?)",
        [(i, value) for i, value in enumerate(seed["carry_table"])],
    )
    conn.executemany(
        "INSERT INTO talent_effects (name, position, effect) VALUES (?, ?, ?)",
        [(name, i, effect) for i, (name, effect) in enumerate(seed["talent_effects"].items())],
    )
    conn.executemany(
        "INSERT INTO armory_catalog (id, position, data) VALUES (?, ?, ?)",
        [(item["id"], i, encode(item)) for i, item in enumerate(seed["armory_catalog"])],
    )
    conn.execute(
        "INSERT INTO reference_meta (key, value) VALUES ('data_version', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (str(REFERENCE_DATA_VERSION),),
    )


def read_reference_tables(conn):
    """Собирает таблицы в структуру, ожидаемую приложением."""
    conn.row_factory = sqlite3.Row
    decode = lambda row: json.loads(row["data"])
    return {
        "version": REFERENCE_DATA_VERSION,
        "worlds": [decode(row) for row in conn.execute("SELECT data FROM worlds ORDER BY position")],
        "chars": [dict(row) for row in conn.execute("SELECT key, name, abbr FROM chars ORDER BY position")],
        "careers": [decode(row) for row in conn.execute("SELECT data FROM careers ORDER BY position")],
        "skill_list": [decode(row) for row in conn.execute("SELECT data FROM skill_list ORDER BY position")],
        "skill_groups": {row["name"]: json.loads(row["data"]) for row in conn.execute("SELECT name, data FROM skill_groups ORDER BY position")},
        "skill_texts": {row["name"]: row["text"] for row in conn.execute("SELECT name, text FROM skill_texts ORDER BY position")},
        "biographies": [decode(row) for row in conn.execute("SELECT data FROM biographies ORDER BY position")],
        "career_advancements": [decode(row) for row in conn.execute("SELECT data FROM career_advancements ORDER BY position")],
        "talents": [row["name"] for row in conn.execute("SELECT name FROM talents ORDER BY position")],
        "sanctions": {row["dice_range"]: row["effect"] for row in conn.execute("SELECT dice_range, effect FROM sanctions ORDER BY position")},
        "carry_table": [row["value"] for row in conn.execute("SELECT value FROM carry_table ORDER BY position")],
        "talent_effects": {row["name"]: row["effect"] for row in conn.execute("SELECT name, effect FROM talent_effects ORDER BY position")},
        "armory_catalog": [decode(row) for row in conn.execute("SELECT data FROM armory_catalog ORDER BY position")],
    }


def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password, encoded):
    try:
        algorithm, iterations, salt_hex, digest_hex = encoded.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        candidate = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations)
        ).hex()
        return hmac.compare_digest(candidate, digest_hex)
    except (ValueError, TypeError):
        return False


def token_digest(token):
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def read_body(handler):
    length = int(handler.headers.get("Content-Length", 0))
    return handler.rfile.read(length)


def send_json(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def send_text(handler, status, text, content_type="text/plain; charset=utf-8"):
    body = text.encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def serve_static(handler, path):
    """Отдаёт файл из PROJECT_DIR. Корень `/` → index.html."""
    path = urlsplit(path).path
    if path == "/":
        rel = "index.html"
    else:
        # обрезаем ведущий слэш и нормализуем, чтобы не выйти за пределы каталога
        rel = os.path.normpath(path.lstrip("/"))
        if rel.startswith("..") or os.path.isabs(rel):
            send_text(handler, 403, "Forbidden")
            return

    if rel != "index.html":
        filename = os.path.basename(rel).lower()
        extension = os.path.splitext(filename)[1]
        if filename in {"characters.sqlite3", "reference_seed.json"} or extension not in STATIC_EXTENSIONS:
            send_text(handler, 404, "Not found")
            return

    full = os.path.join(PROJECT_DIR, rel)
    if not os.path.isfile(full):
        send_text(handler, 404, "Not found")
        return

    ctype, _ = mimetypes.guess_type(full)
    if ctype is None:
        # Резервные типы для файлов листа
        ext = os.path.splitext(full)[1].lower()
        ctype = {
            ".js": "application/javascript",
            ".css": "text/css",
            ".html": "text/html",
            ".json": "application/json",
        }.get(ext, "application/octet-stream")

    try:
        with open(full, "rb") as f:
            data = f.read()
        handler.send_response(200)
        handler.send_header("Content-Type", ctype)
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)
    except Exception as e:
        print(f"[server] ошибка отдачи файла {full}: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        send_text(handler, 500, "Internal server error")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Логи в stderr в компактном виде
        print(f"[server] {self.address_string()} - {format % args}", file=sys.stderr)

    def _parse_json(self):
        raw = read_body(self)
        if not raw:
            raise ValueError("пустое тело запроса")
        return json.loads(raw.decode("utf-8"))

    def _session_token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            morsel = cookie.get(SESSION_COOKIE)
            return morsel.value if morsel else None
        except Exception:
            return None

    def _current_user(self):
        token = self._session_token()
        if not token or not re.fullmatch(r"[A-Za-z0-9_-]{40,64}", token):
            return None
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT users.id, users.username FROM sessions
                JOIN users ON users.id = sessions.user_id
                WHERE sessions.token_hash = ? AND sessions.expires_at > ?
            """, (token_digest(token), now_iso())).fetchone()
        return dict(row) if row else None

    def _require_user(self):
        user = self._current_user()
        if user is None:
            send_json(self, 401, {"error": "Требуется авторизация"})
        return user

    def _set_session_cookie(self, token, max_age):
        self.send_header(
            "Set-Cookie",
            f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}"
        )

    def _issue_session(self, user):
        token = secrets.token_urlsafe(32)
        expires = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=SESSION_DAYS)).isoformat()
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now_iso(),))
            conn.execute("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
                         (token_digest(token), user["id"], expires))
            conn.commit()
        payload = json.dumps({"user": user}, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self._set_session_cookie(token, SESSION_DAYS * 24 * 60 * 60)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _auth_payload(self):
        try:
            payload = self._parse_json()
        except (json.JSONDecodeError, ValueError, UnicodeDecodeError):
            send_json(self, 400, {"error": "Невалидный JSON"})
            return None
        if not isinstance(payload, dict):
            send_json(self, 400, {"error": "Ожидались данные формы"})
            return None
        return payload

    def _api_register(self):
        payload = self._auth_payload()
        if payload is None:
            return
        username = str(payload.get("username", "")).strip()
        password = payload.get("password", "")
        if not re.fullmatch(r"[A-Za-z0-9_]{3,32}", username):
            send_json(self, 400, {"error": "Логин: 3–32 латинских буквы, цифры или _"})
            return
        if not isinstance(password, str) or not PASSWORD_MIN <= len(password) <= PASSWORD_MAX:
            send_json(self, 400, {"error": "Пароль должен быть длиной от 4 до 20 символов"})
            return
        username = username.lower()
        try:
            with sqlite3.connect(DB_PATH) as conn:
                conn.execute("BEGIN IMMEDIATE")
                first_user = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
                cursor = conn.execute(
                    "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
                    (username, hash_password(password), now_iso())
                )
                user = {"id": cursor.lastrowid, "username": username}
                if first_user:
                    # Записи из прежней версии без владельца остаются у первого владельца БД.
                    conn.execute("UPDATE characters SET user_id = ? WHERE user_id IS NULL", (user["id"],))
                conn.commit()
        except sqlite3.IntegrityError:
            send_json(self, 409, {"error": "Такой логин уже занят"})
            return
        self._issue_session(user)

    def _api_login(self):
        payload = self._auth_payload()
        if payload is None:
            return
        username = str(payload.get("username", "")).strip().lower()
        password = payload.get("password", "")
        if not isinstance(password, str) or not PASSWORD_MIN <= len(password) <= PASSWORD_MAX:
            send_json(self, 400, {"error": "Пароль должен быть длиной от 4 до 20 символов"})
            return
        if not username:
            send_json(self, 400, {"error": "Введите логин и пароль"})
            return
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT id, username, password_hash FROM users WHERE username = ?", (username,)
            ).fetchone()
        if not row or not verify_password(password, row["password_hash"]):
            send_json(self, 401, {"error": "Неверный логин или пароль"})
            return
        self._issue_session({"id": row["id"], "username": row["username"]})

    def _api_logout(self):
        token = self._session_token()
        if token and re.fullmatch(r"[A-Za-z0-9_-]{40,64}", token):
            with sqlite3.connect(DB_PATH) as conn:
                conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_digest(token),))
                conn.commit()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self._set_session_cookie("", 0)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"{}")

    def do_GET(self):
        try:
            if self.path.startswith("/api/"):
                if self.path == "/api/auth/session":
                    user = self._require_user()
                    if user:
                        send_json(self, 200, {"user": user})
                elif self.path.startswith("/api/auth/"):
                    send_json(self, 404, {"error": "Не найдено"})
                else:
                    user = self._require_user()
                    if user:
                        self._api_get(user["id"])
            else:
                serve_static(self, self.path)
        except Exception as e:
            print(f"[server] ошибка GET {self.path}: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            send_text(self, 500, "Internal server error")

    def do_POST(self):
        try:
            if self.path == "/api/auth/register":
                self._api_register()
            elif self.path == "/api/auth/login":
                self._api_login()
            elif self.path == "/api/auth/logout":
                self._api_logout()
            elif self.path == "/api/characters":
                user = self._require_user()
                if user:
                    self._api_create(user["id"])
            else:
                send_json(self, 404, {"error": "Не найдено"})
        except Exception as e:
            print(f"[server] ошибка POST {self.path}: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            send_text(self, 500, "Internal server error")

    def do_PUT(self):
        try:
            user = self._require_user()
            if not user:
                return
            m = re.match(r"^/api/characters/(\d+)$", self.path)
            if m:
                self._api_update(int(m.group(1)), user["id"])
            else:
                send_text(self, 404, "Not found")
        except Exception as e:
            print(f"[server] ошибка PUT {self.path}: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            send_text(self, 500, "Internal server error")

    def do_DELETE(self):
        try:
            user = self._require_user()
            if not user:
                return
            m = re.match(r"^/api/characters/(\d+)$", self.path)
            if m:
                self._api_delete(int(m.group(1)), user["id"])
            else:
                send_text(self, 404, "Not found")
        except Exception as e:
            print(f"[server] ошибка DELETE {self.path}: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            send_text(self, 500, "Internal server error")

    def _api_list(self, user_id):
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT id, name, updated_at FROM characters WHERE user_id = ? ORDER BY updated_at DESC",
                (user_id,)
            ).fetchall()
        send_json(self, 200, [
            {"id": r["id"], "name": r["name"], "updated_at": r["updated_at"]}
            for r in rows
        ])

    def _api_get_one(self, char_id, user_id):
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT id, name, data FROM characters WHERE id = ? AND user_id = ?", (char_id, user_id)
            ).fetchone()
        if not row:
            send_text(self, 404, "Character not found")
            return
        send_json(self, 200, {
            "id": row["id"],
            "name": row["name"],
            "data": json.loads(row["data"]),
        })

    def _api_get(self, user_id):
        m = re.match(r"^/api/characters/(\d+)$", self.path)
        if m:
            self._api_get_one(int(m.group(1)), user_id)
        elif self.path == "/api/characters":
            self._api_list(user_id)
        elif self.path == "/api/reference-data":
            with sqlite3.connect(DB_PATH) as conn:
                payload = read_reference_tables(conn)
            send_json(self, 200, payload)
        else:
            send_text(self, 404, "Not found")

    def _extract_name(self, data):
        """Берёт имя персонажа из снимка; при отсутствии — 'Безымянный'."""
        name = ""
        if isinstance(data, dict):
            name = str(data.get("name") or "").strip()
        return name or "Безымянный"

    def _api_create(self, user_id):
        try:
            payload = self._parse_json()
        except (json.JSONDecodeError, ValueError) as e:
            send_json(self, 400, {"error": f"Невалидный JSON: {e}"})
            return

        name = self._extract_name(payload)
        ts = now_iso()
        data_json = json.dumps(payload, ensure_ascii=False)
        with sqlite3.connect(DB_PATH) as conn:
            cur = conn.execute(
                "INSERT INTO characters (name, data, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?)",
                (name, data_json, ts, ts, user_id),
            )
            char_id = cur.lastrowid
            conn.commit()
        send_json(self, 201, {
            "id": char_id,
            "name": name,
            "data": payload,
            "created_at": ts,
            "updated_at": ts,
        })

    def _api_update(self, char_id, user_id):
        try:
            payload = self._parse_json()
        except (json.JSONDecodeError, ValueError) as e:
            send_json(self, 400, {"error": f"Невалидный JSON: {e}"})
            return

        name = self._extract_name(payload)
        ts = now_iso()
        data_json = json.dumps(payload, ensure_ascii=False)
        with sqlite3.connect(DB_PATH) as conn:
            cur = conn.execute(
                "UPDATE characters SET name = ?, data = ?, updated_at = ? WHERE id = ? AND user_id = ?",
                (name, data_json, ts, char_id, user_id),
            )
            conn.commit()
            if cur.rowcount == 0:
                send_text(self, 404, "Character not found")
                return
        send_json(self, 200, {
            "id": char_id,
            "name": name,
            "updated_at": ts,
        })

    def _api_delete(self, char_id, user_id):
        with sqlite3.connect(DB_PATH) as conn:
            cur = conn.execute("DELETE FROM characters WHERE id = ? AND user_id = ?", (char_id, user_id))
            conn.commit()
            if cur.rowcount == 0:
                send_text(self, 404, "Character not found")
                return
        send_json(self, 200, {"deleted": True, "id": char_id})


def main():
    parser = argparse.ArgumentParser(description="Сервер листа Dark Heresy")
    parser.add_argument(
        "--port",
        type=int,
        default=os.environ.get("PORT", "8000"),
        help="Порт (по умолчанию 8000 или переменная PORT)",
    )
    args = parser.parse_args()

    init_db()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Сервер Dark Heresy запущен: {url}")
    print(f"База персонажей: {DB_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановка сервера...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
