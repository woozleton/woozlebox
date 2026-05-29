"""
db.py - SQLite-backed storage for WoozleBox.

Database location: /app/data/conversations.db (persisted via Docker volume rag_data).

Schema:
  users(id, username, password_hash, role, settings, created_at, is_active)
  sessions(token, user_id, created_at, last_seen, expires_at)
  folders(id, name, user_id, created_at)
  folder_meta(folder_id, description, system_prompt)
  conversations(id, title, folder_id, user_id, created_at, updated_at)
  messages(id, conversation_id, role, content, sources, web_sources, model_used, created_at)
  memory(id, fact, user_id, created_at)
  studio_items(id, studio, user_id, folder_id, session_id, raw_prompt, title, meta, is_favorite, deleted_at, created_at)
  studio_folders(id, studio, user_id, name, description, created_at)
  prompt_overrides(key, service, content, updated_at, updated_by)

sources, web_sources, and meta are stored as JSON text.
"""

import sqlite3
import json
import uuid
import os
import secrets
from datetime import datetime, timezone, timedelta
from typing import Optional

DB_DIR = os.environ.get("DB_DIR", "/app/data")
DB_PATH = os.path.join(DB_DIR, "conversations.db")
MEDIA_DIR = os.path.join(DB_DIR, "media")

SESSION_TTL_DAYS = 30
VALID_STUDIOS = {"image", "music", "video", "code", "notetaker"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    os.makedirs(DB_DIR, exist_ok=True)
    os.makedirs(MEDIA_DIR, exist_ok=True)
    with _conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id            TEXT PRIMARY KEY,
                username      TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role          TEXT NOT NULL DEFAULT 'user',
                settings      TEXT NOT NULL DEFAULT '{}',
                created_at    TEXT NOT NULL,
                is_active     INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token      TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                last_seen  TEXT NOT NULL,
                expires_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS folders (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS folder_meta (
                folder_id     TEXT PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
                description   TEXT,
                system_prompt TEXT
            );

            CREATE TABLE IF NOT EXISTS conversations (
                id         TEXT PRIMARY KEY,
                title      TEXT NOT NULL DEFAULT 'New Chat',
                folder_id  TEXT REFERENCES folders(id) ON DELETE SET NULL,
                user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id              TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                role            TEXT NOT NULL,
                content         TEXT NOT NULL,
                sources         TEXT NOT NULL DEFAULT '[]',
                web_sources     TEXT NOT NULL DEFAULT '[]',
                model_used      TEXT,
                created_at      TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS memory (
                id         TEXT PRIMARY KEY,
                fact       TEXT NOT NULL,
                user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_messages_conversation
                ON messages(conversation_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        """)
        conn.executescript("""
            CREATE INDEX IF NOT EXISTS idx_folders_user         ON folders(user_id);
            CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
            CREATE INDEX IF NOT EXISTS idx_memory_user        ON memory(user_id);
        """)
        # Migration: add images and files columns to messages
        for col in ("images", "files"):
            try:
                conn.execute(f"ALTER TABLE messages ADD COLUMN {col} TEXT NOT NULL DEFAULT '[]'")
            except Exception:
                pass  # Column already exists

        # Studio persistence tables
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS studio_items (
                id          TEXT PRIMARY KEY,
                studio      TEXT NOT NULL,
                user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                folder_id   TEXT,
                session_id  TEXT,
                raw_prompt  TEXT,
                title       TEXT,
                meta        TEXT NOT NULL DEFAULT '{}',
                is_favorite INTEGER NOT NULL DEFAULT 0,
                deleted_at  TEXT,
                created_at  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS studio_folders (
                id          TEXT PRIMARY KEY,
                studio      TEXT NOT NULL,
                user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name        TEXT NOT NULL,
                description TEXT,
                created_at  TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_studio_items_user_studio
                ON studio_items(user_id, studio);
            CREATE INDEX IF NOT EXISTS idx_studio_items_folder
                ON studio_items(user_id, studio, folder_id);
            CREATE INDEX IF NOT EXISTS idx_studio_items_session
                ON studio_items(user_id, studio, session_id);
            CREATE INDEX IF NOT EXISTS idx_studio_folders_user
                ON studio_folders(user_id, studio);
        """)

        # Prompt overrides table (admin-editable prompt templates)
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS prompt_overrides (
                key        TEXT PRIMARY KEY,
                service    TEXT NOT NULL,
                content    TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                updated_by TEXT NOT NULL
            );
        """)



# ── Users ──

def has_users() -> bool:
    with _conn() as conn:
        count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    return count > 0


def create_user(username: str, password_hash: str, role: str = "user") -> str:
    uid = str(uuid.uuid4())
    with _conn() as conn:
        conn.execute(
            "INSERT INTO users(id, username, password_hash, role, settings, created_at, is_active) VALUES (?,?,?,?,?,?,?)",
            (uid, username.strip(), password_hash, role, "{}", _now(), 1),
        )
    return uid


def get_user_by_username(username: str) -> Optional[dict]:
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE username = ?", (username.strip(),)
        ).fetchone()
    return dict(row) if row else None


def get_user_by_id(user_id: str) -> Optional[dict]:
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE id = ?", (user_id,)
        ).fetchone()
    return dict(row) if row else None


def list_users() -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, username, role, settings, created_at, is_active FROM users ORDER BY created_at ASC"
        ).fetchall()
    return [dict(r) for r in rows]


def update_user_password(user_id: str, new_hash: str):
    with _conn() as conn:
        conn.execute(
            "UPDATE users SET password_hash=? WHERE id=?", (new_hash, user_id)
        )


def update_user_role(user_id: str, role: str):
    with _conn() as conn:
        conn.execute("UPDATE users SET role=? WHERE id=?", (role, user_id))


def update_user_active(user_id: str, is_active: bool):
    with _conn() as conn:
        conn.execute(
            "UPDATE users SET is_active=? WHERE id=?", (1 if is_active else 0, user_id)
        )


def update_user_settings(user_id: str, settings_json: str):
    with _conn() as conn:
        conn.execute(
            "UPDATE users SET settings=? WHERE id=?", (settings_json, user_id)
        )


def get_user_settings(user_id: str) -> str:
    with _conn() as conn:
        row = conn.execute(
            "SELECT settings FROM users WHERE id=?", (user_id,)
        ).fetchone()
    return row[0] if row else "{}"


def delete_user(user_id: str):
    with _conn() as conn:
        conn.execute("DELETE FROM users WHERE id=?", (user_id,))


# ── Sessions ──

def create_session(user_id: str) -> str:
    token = secrets.token_hex(32)
    now = _now()
    expires = (datetime.now(timezone.utc) + timedelta(days=SESSION_TTL_DAYS)).isoformat()
    with _conn() as conn:
        conn.execute(
            "INSERT INTO sessions(token, user_id, created_at, last_seen, expires_at) VALUES (?,?,?,?,?)",
            (token, user_id, now, now, expires),
        )
    return token


def get_session(token: str) -> Optional[dict]:
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM sessions WHERE token=?", (token,)
        ).fetchone()
        if not row:
            return None
        row = dict(row)
        if row["expires_at"] < _now():
            conn.execute("DELETE FROM sessions WHERE token=?", (token,))
            return None
        conn.execute(
            "UPDATE sessions SET last_seen=? WHERE token=?", (_now(), token)
        )
    return row


def delete_session(token: str):
    with _conn() as conn:
        conn.execute("DELETE FROM sessions WHERE token=?", (token,))


def delete_all_sessions_for_user(user_id: str):
    with _conn() as conn:
        conn.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))


def purge_expired_sessions():
    with _conn() as conn:
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (_now(),))


# ── Folders ──

def create_folder(user_id: str, name: str, description: str = None, system_prompt: str = None) -> str:
    fid = str(uuid.uuid4())
    with _conn() as conn:
        conn.execute(
            "INSERT INTO folders(id, name, user_id, created_at) VALUES (?,?,?,?)",
            (fid, name, user_id, _now()),
        )
        if description is not None or system_prompt is not None:
            conn.execute(
                "INSERT INTO folder_meta(folder_id, description, system_prompt) VALUES (?,?,?)",
                (fid, description, system_prompt),
            )
    return fid


def list_folders(user_id: str) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute("""
            SELECT f.id, f.name, f.user_id, f.created_at,
                   fm.description, fm.system_prompt
            FROM folders f
            LEFT JOIN folder_meta fm ON fm.folder_id = f.id
            WHERE f.user_id=? ORDER BY f.created_at ASC
        """, (user_id,)).fetchall()
    return [dict(r) for r in rows]


def get_folder(fid: str, user_id: str) -> Optional[dict]:
    with _conn() as conn:
        row = conn.execute("""
            SELECT f.id, f.name, f.user_id, f.created_at,
                   fm.description, fm.system_prompt
            FROM folders f
            LEFT JOIN folder_meta fm ON fm.folder_id = f.id
            WHERE f.id=? AND f.user_id=?
        """, (fid, user_id)).fetchone()
    return dict(row) if row else None


def update_folder(fid: str, user_id: str, name: str = None, description: str = None, system_prompt: str = None):
    with _conn() as conn:
        if name is not None:
            conn.execute("UPDATE folders SET name=? WHERE id=? AND user_id=?", (name, fid, user_id))
        if description is not None or system_prompt is not None:
            conn.execute("""
                INSERT INTO folder_meta(folder_id, description, system_prompt) VALUES (?,?,?)
                ON CONFLICT(folder_id) DO UPDATE SET
                    description = COALESCE(excluded.description, folder_meta.description),
                    system_prompt = excluded.system_prompt
            """, (fid, description, system_prompt))


def delete_folder(fid: str, user_id: str):
    with _conn() as conn:
        conn.execute("DELETE FROM folders WHERE id=? AND user_id=?", (fid, user_id))


# ── Conversations ──

def create_conversation(user_id: str, title: str = "New Chat", folder_id: str = None) -> str:
    cid = str(uuid.uuid4())
    now = _now()
    with _conn() as conn:
        conn.execute(
            "INSERT INTO conversations(id, title, folder_id, user_id, created_at, updated_at) VALUES (?,?,?,?,?,?)",
            (cid, title, folder_id, user_id, now, now),
        )
    return cid


def list_conversations(user_id: str) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute("""
            SELECT c.id, c.title, c.folder_id, c.user_id, c.created_at, c.updated_at,
                   COUNT(m.id) AS message_count
            FROM conversations c
            LEFT JOIN messages m ON m.conversation_id = c.id
            WHERE c.user_id = ?
            GROUP BY c.id
            ORDER BY c.updated_at DESC
        """, (user_id,)).fetchall()
    return [dict(r) for r in rows]


def get_conversation(cid: str, user_id: str) -> Optional[dict]:
    with _conn() as conn:
        conv = conn.execute(
            "SELECT * FROM conversations WHERE id=? AND user_id=?", (cid, user_id)
        ).fetchone()
        if not conv:
            return None
        msgs = conn.execute(
            "SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at ASC",
            (cid,),
        ).fetchall()
    result = dict(conv)
    result["messages"] = []
    for m in msgs:
        msg = dict(m)
        msg["sources"] = json.loads(msg["sources"])
        msg["web_sources"] = json.loads(msg["web_sources"])
        msg["images"] = json.loads(msg.get("images", "[]"))
        msg["files"] = json.loads(msg.get("files", "[]"))
        result["messages"].append(msg)
    return result


def compact_conversation(cid: str, user_id: str, summary: str) -> str:
    """Replace all messages in a conversation with a single summary message."""
    with _conn() as conn:
        conn.execute("DELETE FROM messages WHERE conversation_id=?", (cid,))
    return add_message(cid, "system", f"[Conversation summary]\n{summary}")


def delete_conversation(cid: str, user_id: str):
    with _conn() as conn:
        conn.execute(
            "DELETE FROM conversations WHERE id=? AND user_id=?", (cid, user_id)
        )


def delete_all_user_data(user_id: str):
    """Delete all conversations, folders, and memory for a user (keeps the account)."""
    with _conn() as conn:
        conn.execute("DELETE FROM conversations WHERE user_id=?", (user_id,))
        conn.execute("DELETE FROM folders WHERE user_id=?", (user_id,))
        conn.execute("DELETE FROM memory WHERE user_id=?", (user_id,))


def rename_conversation(cid: str, user_id: str, title: str):
    with _conn() as conn:
        conn.execute(
            "UPDATE conversations SET title=?, updated_at=? WHERE id=? AND user_id=?",
            (title[:80], _now(), cid, user_id),
        )


def move_conversation(cid: str, user_id: str, folder_id: Optional[str]):
    with _conn() as conn:
        conn.execute(
            "UPDATE conversations SET folder_id=?, updated_at=? WHERE id=? AND user_id=?",
            (folder_id, _now(), cid, user_id),
        )


def add_message(
    conversation_id: str,
    role: str,
    content: str,
    sources: list[str] = None,
    web_sources: list[dict] = None,
    model_used: str = None,
    images: list[str] = None,
    files: list[dict] = None,
) -> str:
    mid = str(uuid.uuid4())
    now = _now()
    with _conn() as conn:
        conn.execute(
            """INSERT INTO messages(id, conversation_id, role, content, sources, web_sources, model_used, images, files, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                mid,
                conversation_id,
                role,
                content,
                json.dumps(sources or []),
                json.dumps(web_sources or []),
                model_used,
                json.dumps(images or []),
                json.dumps(files or []),
                now,
            ),
        )
        conn.execute(
            "UPDATE conversations SET updated_at=? WHERE id=?",
            (now, conversation_id),
        )
    return mid


def search_conversations(query: str, user_id: str) -> list[dict]:
    """Full-text search across conversation titles and message content."""
    q = f"%{query.strip()}%"
    with _conn() as conn:
        rows = conn.execute("""
            SELECT DISTINCT c.id, c.title, c.updated_at,
                   m.role, m.content AS snippet
            FROM conversations c
            JOIN messages m ON m.conversation_id = c.id
            WHERE c.user_id = ? AND (c.title LIKE ? OR m.content LIKE ?)
            ORDER BY c.updated_at DESC
            LIMIT 50
        """, (user_id, q, q)).fetchall()
    seen = {}
    results = []
    for r in rows:
        r = dict(r)
        cid = r["id"]
        if cid not in seen:
            seen[cid] = True
            content = r["snippet"] or ""
            idx = content.lower().find(query.lower())
            if idx >= 0:
                start = max(0, idx - 60)
                end = min(len(content), idx + 120)
                snippet = ("…" if start > 0 else "") + content[start:end].strip() + ("…" if end < len(content) else "")
            else:
                snippet = content[:120]
            results.append({"id": cid, "title": r["title"], "updated_at": r["updated_at"], "snippet": snippet})
    return results


def auto_title(conversation_id: str, user_id: str, text: str):
    """Set conversation title from first user message if still default."""
    title = text.strip()[:60]
    if len(text.strip()) > 60:
        title += "…"
    with _conn() as conn:
        conn.execute(
            "UPDATE conversations SET title=?, updated_at=? WHERE id=? AND user_id=? AND title='New Chat'",
            (title, _now(), conversation_id, user_id),
        )


# ── Memory ──

def list_memory(user_id: str) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM memory WHERE user_id=? ORDER BY created_at ASC", (user_id,)
        ).fetchall()
    return [dict(r) for r in rows]


def add_memory_fact(fact: str, user_id: str) -> str:
    mid = str(uuid.uuid4())
    with _conn() as conn:
        conn.execute(
            "INSERT INTO memory(id, fact, user_id, created_at) VALUES (?,?,?,?)",
            (mid, fact.strip(), user_id, _now()),
        )
    return mid


def delete_memory_fact(mid: str, user_id: str):
    with _conn() as conn:
        conn.execute(
            "DELETE FROM memory WHERE id=? AND user_id=?", (mid, user_id)
        )


# ── Studio Items ──

def create_studio_item(
    user_id: str, studio: str, item_id: str,
    folder_id: str = None, session_id: str = None,
    raw_prompt: str = None, title: str = None,
    meta_json: str = "{}", is_favorite: bool = False,
    deleted_at: str = None, created_at: str = None,
) -> str:
    now = created_at or _now()
    with _conn() as conn:
        conn.execute(
            """INSERT INTO studio_items
               (id, studio, user_id, folder_id, session_id,
                raw_prompt, title, meta, is_favorite, deleted_at, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
                   folder_id = excluded.folder_id,
                   session_id = excluded.session_id,
                   raw_prompt = excluded.raw_prompt,
                   title = excluded.title,
                   meta = excluded.meta""",
            (item_id, studio, user_id, folder_id, session_id,
             raw_prompt, title, meta_json, 1 if is_favorite else 0,
             deleted_at, now),
        )
    return item_id


def list_studio_items(
    user_id: str, studio: str,
    folder_id: str = None, session_id: str = None,
) -> list[dict]:
    sql = "SELECT * FROM studio_items WHERE user_id=? AND studio=? AND deleted_at IS NULL"
    params: list = [user_id, studio]
    if folder_id is not None:
        sql += " AND folder_id=?"
        params.append(folder_id)
    if session_id is not None:
        sql += " AND session_id=?"
        params.append(session_id)
    sql += " ORDER BY created_at DESC"
    with _conn() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


def get_studio_item(item_id: str, user_id: str) -> Optional[dict]:
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM studio_items WHERE id=? AND user_id=?",
            (item_id, user_id),
        ).fetchone()
    return dict(row) if row else None


def update_studio_item(item_id: str, user_id: str, **kwargs):
    allowed = {"folder_id", "session_id", "raw_prompt", "title", "meta", "is_favorite"}
    sets = []
    params = []
    for k, v in kwargs.items():
        if k in allowed and v is not None:
            col = k
            if k == "is_favorite":
                v = 1 if v else 0
            sets.append(f"{col}=?")
            params.append(v)
    if not sets:
        return
    params.extend([item_id, user_id])
    with _conn() as conn:
        conn.execute(
            f"UPDATE studio_items SET {', '.join(sets)} WHERE id=? AND user_id=?",
            params,
        )


def trash_studio_item(item_id: str, user_id: str):
    with _conn() as conn:
        conn.execute(
            "UPDATE studio_items SET deleted_at=? WHERE id=? AND user_id=?",
            (_now(), item_id, user_id),
        )


def restore_studio_item(item_id: str, user_id: str):
    with _conn() as conn:
        conn.execute(
            "UPDATE studio_items SET deleted_at=NULL WHERE id=? AND user_id=?",
            (item_id, user_id),
        )


def list_studio_trash(user_id: str, studio: str) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM studio_items WHERE user_id=? AND studio=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC",
            (user_id, studio),
        ).fetchall()
    return [dict(r) for r in rows]


def delete_studio_item(item_id: str, user_id: str):
    with _conn() as conn:
        conn.execute(
            "DELETE FROM studio_items WHERE id=? AND user_id=?",
            (item_id, user_id),
        )


def empty_studio_trash(user_id: str, studio: str) -> list[str]:
    """Delete all trashed items for a studio. Returns list of deleted item IDs (for media cleanup)."""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id FROM studio_items WHERE user_id=? AND studio=? AND deleted_at IS NOT NULL",
            (user_id, studio),
        ).fetchall()
        ids = [r["id"] for r in rows]
        if ids:
            conn.execute(
                "DELETE FROM studio_items WHERE user_id=? AND studio=? AND deleted_at IS NOT NULL",
                (user_id, studio),
            )
    return ids


def list_studio_favorites(user_id: str, studio: str) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM studio_items WHERE user_id=? AND studio=? AND is_favorite=1 AND deleted_at IS NULL ORDER BY created_at DESC",
            (user_id, studio),
        ).fetchall()
    return [dict(r) for r in rows]


def set_studio_favorite(item_id: str, user_id: str, is_favorite: bool):
    with _conn() as conn:
        conn.execute(
            "UPDATE studio_items SET is_favorite=? WHERE id=? AND user_id=?",
            (1 if is_favorite else 0, item_id, user_id),
        )


def list_studio_sessions(user_id: str, studio: str) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            """SELECT session_id, COUNT(*) as item_count,
                      MAX(created_at) as last_created
               FROM studio_items
               WHERE user_id=? AND studio=? AND deleted_at IS NULL AND session_id IS NOT NULL
               GROUP BY session_id ORDER BY last_created DESC""",
            (user_id, studio),
        ).fetchall()
    return [dict(r) for r in rows]


def delete_studio_session(user_id: str, studio: str, session_id: str) -> list[str]:
    """Delete all items in a session. Returns list of deleted item IDs (for media cleanup)."""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id FROM studio_items WHERE user_id=? AND studio=? AND session_id=?",
            (user_id, studio, session_id),
        ).fetchall()
        ids = [r["id"] for r in rows]
        if ids:
            conn.execute(
                "DELETE FROM studio_items WHERE user_id=? AND studio=? AND session_id=?",
                (user_id, studio, session_id),
            )
    return ids


# ── Studio Folders ──

def create_studio_folder(
    user_id: str, studio: str, folder_id: str = None,
    name: str = "", description: str = None, created_at: str = None,
) -> str:
    fid = folder_id or str(uuid.uuid4())
    now = created_at or _now()
    with _conn() as conn:
        conn.execute(
            "INSERT INTO studio_folders(id, studio, user_id, name, description, created_at) VALUES (?,?,?,?,?,?)",
            (fid, studio, user_id, name, description, now),
        )
    return fid


def list_studio_folders(user_id: str, studio: str) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM studio_folders WHERE user_id=? AND studio=? ORDER BY created_at ASC",
            (user_id, studio),
        ).fetchall()
    return [dict(r) for r in rows]


def update_studio_folder(folder_id: str, user_id: str, name: str = None, description: str = None):
    sets = []
    params = []
    if name is not None:
        sets.append("name=?")
        params.append(name)
    if description is not None:
        sets.append("description=?")
        params.append(description)
    if not sets:
        return
    params.extend([folder_id, user_id])
    with _conn() as conn:
        conn.execute(
            f"UPDATE studio_folders SET {', '.join(sets)} WHERE id=? AND user_id=?",
            params,
        )


def delete_studio_folder(folder_id: str, user_id: str):
    with _conn() as conn:
        conn.execute(
            "UPDATE studio_items SET folder_id=NULL WHERE folder_id=? AND user_id=?",
            (folder_id, user_id),
        )
        conn.execute(
            "DELETE FROM studio_folders WHERE id=? AND user_id=?",
            (folder_id, user_id),
        )


# ── Prompt Overrides ──

def list_prompt_overrides(service: str = None) -> list[dict]:
    with _conn() as conn:
        if service:
            rows = conn.execute(
                "SELECT * FROM prompt_overrides WHERE service=?", (service,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM prompt_overrides").fetchall()
    return [dict(r) for r in rows]


def get_prompt_override(key: str) -> Optional[dict]:
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM prompt_overrides WHERE key=?", (key,)
        ).fetchone()
    return dict(row) if row else None


def upsert_prompt_override(key: str, service: str, content: str, user_id: str):
    with _conn() as conn:
        conn.execute(
            """INSERT INTO prompt_overrides(key, service, content, updated_at, updated_by)
               VALUES (?,?,?,?,?)
               ON CONFLICT(key) DO UPDATE SET
                   content = excluded.content,
                   updated_at = excluded.updated_at,
                   updated_by = excluded.updated_by""",
            (key, service, content, _now(), user_id),
        )


def delete_prompt_override(key: str):
    with _conn() as conn:
        conn.execute("DELETE FROM prompt_overrides WHERE key=?", (key,))


def delete_all_prompt_overrides():
    with _conn() as conn:
        conn.execute("DELETE FROM prompt_overrides")
