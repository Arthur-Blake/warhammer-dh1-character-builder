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
import json
import mimetypes
import os
import re
import sqlite3
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Каталог проекта — тот, где лежит server.py
PROJECT_DIR = os.path.dirname(os.path.abspath(__file__)) or "."
DB_PATH = os.path.join(PROJECT_DIR, "characters.sqlite3")

# Расширения, которые точно стоит отдавать из проекта
STATIC_EXTENSIONS = {
    ".html", ".js", ".css", ".json", ".xml", ".txt",
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
    ".woff", ".woff2", ".ttf", ".eot",
}


def init_db():
    """Создаёт таблицу персонажей, если её ещё нет."""
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS characters (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at TEXT,
                updated_at TEXT
            )
        """)
        conn.commit()


def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def read_body(handler):
    length = int(handler.headers.get("Content-Length", 0))
    return handler.rfile.read(length)


def send_json(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
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
    if path == "/":
        rel = "index.html"
    else:
        # обрезаем ведущий слэш и нормализуем, чтобы не выйти за пределы каталога
        rel = os.path.normpath(path.lstrip("/"))
        if rel.startswith("..") or os.path.isabs(rel):
            send_text(handler, 403, "Forbidden")
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

    def do_GET(self):
        try:
            if self.path.startswith("/api/"):
                self._api_get()
            else:
                serve_static(self, self.path)
        except Exception as e:
            print(f"[server] ошибка GET {self.path}: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            send_text(self, 500, "Internal server error")

    def do_POST(self):
        try:
            if self.path == "/api/characters":
                self._api_create()
            else:
                send_text(self, 404, "Not found")
        except Exception as e:
            print(f"[server] ошибка POST {self.path}: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            send_text(self, 500, "Internal server error")

    def do_PUT(self):
        try:
            m = re.match(r"^/api/characters/(\d+)$", self.path)
            if m:
                self._api_update(int(m.group(1)))
            else:
                send_text(self, 404, "Not found")
        except Exception as e:
            print(f"[server] ошибка PUT {self.path}: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            send_text(self, 500, "Internal server error")

    def do_DELETE(self):
        try:
            m = re.match(r"^/api/characters/(\d+)$", self.path)
            if m:
                self._api_delete(int(m.group(1)))
            else:
                send_text(self, 404, "Not found")
        except Exception as e:
            print(f"[server] ошибка DELETE {self.path}: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            send_text(self, 500, "Internal server error")

    def _api_list(self):
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT id, name, updated_at FROM characters ORDER BY updated_at DESC"
            ).fetchall()
        send_json(self, 200, [
            {"id": r["id"], "name": r["name"], "updated_at": r["updated_at"]}
            for r in rows
        ])

    def _api_get_one(self, char_id):
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT id, name, data FROM characters WHERE id = ?", (char_id,)
            ).fetchone()
        if not row:
            send_text(self, 404, "Character not found")
            return
        send_json(self, 200, {
            "id": row["id"],
            "name": row["name"],
            "data": json.loads(row["data"]),
        })

    def _api_get(self):
        m = re.match(r"^/api/characters/(\d+)$", self.path)
        if m:
            self._api_get_one(int(m.group(1)))
        elif self.path == "/api/characters":
            self._api_list()
        else:
            send_text(self, 404, "Not found")

    def _extract_name(self, data):
        """Берёт имя персонажа из снимка; при отсутствии — 'Безымянный'."""
        name = ""
        if isinstance(data, dict):
            name = str(data.get("name") or "").strip()
        return name or "Безымянный"

    def _api_create(self):
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
                "INSERT INTO characters (name, data, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (name, data_json, ts, ts),
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

    def _api_update(self, char_id):
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
                "UPDATE characters SET name = ?, data = ?, updated_at = ? WHERE id = ?",
                (name, data_json, ts, char_id),
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

    def _api_delete(self, char_id):
        with sqlite3.connect(DB_PATH) as conn:
            cur = conn.execute("DELETE FROM characters WHERE id = ?", (char_id,))
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
