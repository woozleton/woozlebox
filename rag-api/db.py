"""
db.py - SQLite-backed storage for Dave-in-a-Box.

Database location: /app/data/conversations.db (persisted via Docker volume rag_data).

Schema:
  users(id, username, password_hash, role, settings, created_at, is_active)
  sessions(token, user_id, created_at, last_seen, expires_at)
  topics(id, name, description, system_prompt, user_id, created_at)
  conversations(id, title, topic_id, user_id, created_at, updated_at)
  messages(id, conversation_id, role, content, sources, web_sources, model_used, created_at)
  memory(id, fact, user_id, created_at)

sources and web_sources are stored as JSON text.
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

SESSION_TTL_DAYS = 30


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

            CREATE TABLE IF NOT EXISTS topics (
                id            TEXT PRIMARY KEY,
                name          TEXT NOT NULL,
                description   TEXT,
                system_prompt TEXT,
                user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
                created_at    TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS conversations (
                id         TEXT PRIMARY KEY,
                title      TEXT NOT NULL DEFAULT 'New Chat',
                topic_id   TEXT REFERENCES topics(id) ON DELETE SET NULL,
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
            CREATE INDEX IF NOT EXISTS idx_topics_user        ON topics(user_id);
            CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
            CREATE INDEX IF NOT EXISTS idx_memory_user        ON memory(user_id);
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


# ── Topics ──

def create_topic(user_id: str, name: str, description: str = None, system_prompt: str = None) -> str:
    pid = str(uuid.uuid4())
    with _conn() as conn:
        conn.execute(
            "INSERT INTO topics(id, name, description, system_prompt, user_id, created_at) VALUES (?,?,?,?,?,?)",
            (pid, name, description, system_prompt, user_id, _now()),
        )
    return pid


def list_topics(user_id: str) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM topics WHERE user_id=? ORDER BY created_at ASC", (user_id,)
        ).fetchall()
    return [dict(r) for r in rows]


def get_topic(pid: str, user_id: str) -> Optional[dict]:
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM topics WHERE id=? AND user_id=?", (pid, user_id)
        ).fetchone()
    return dict(row) if row else None


def update_topic(pid: str, user_id: str, name: str = None, description: str = None, system_prompt: str = None):
    with _conn() as conn:
        if name is not None:
            conn.execute("UPDATE topics SET name=? WHERE id=? AND user_id=?", (name, pid, user_id))
        if description is not None:
            conn.execute("UPDATE topics SET description=? WHERE id=? AND user_id=?", (description, pid, user_id))
        conn.execute("UPDATE topics SET system_prompt=? WHERE id=? AND user_id=?", (system_prompt, pid, user_id))


def delete_topic(pid: str, user_id: str):
    with _conn() as conn:
        conn.execute("DELETE FROM topics WHERE id=? AND user_id=?", (pid, user_id))


# ── Conversations ──

def create_conversation(user_id: str, title: str = "New Chat", topic_id: str = None) -> str:
    cid = str(uuid.uuid4())
    now = _now()
    with _conn() as conn:
        conn.execute(
            "INSERT INTO conversations(id, title, topic_id, user_id, created_at, updated_at) VALUES (?,?,?,?,?,?)",
            (cid, title, topic_id, user_id, now, now),
        )
    return cid


def list_conversations(user_id: str) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute("""
            SELECT c.id, c.title, c.topic_id, c.user_id, c.created_at, c.updated_at,
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
    """Delete all conversations, topics, and memory for a user (keeps the account)."""
    with _conn() as conn:
        conn.execute("DELETE FROM conversations WHERE user_id=?", (user_id,))
        conn.execute("DELETE FROM topics WHERE user_id=?", (user_id,))
        conn.execute("DELETE FROM memory WHERE user_id=?", (user_id,))


def rename_conversation(cid: str, user_id: str, title: str):
    with _conn() as conn:
        conn.execute(
            "UPDATE conversations SET title=?, updated_at=? WHERE id=? AND user_id=?",
            (title[:80], _now(), cid, user_id),
        )


def move_conversation(cid: str, user_id: str, topic_id: Optional[str]):
    with _conn() as conn:
        conn.execute(
            "UPDATE conversations SET topic_id=?, updated_at=? WHERE id=? AND user_id=?",
            (topic_id, _now(), cid, user_id),
        )


def add_message(
    conversation_id: str,
    role: str,
    content: str,
    sources: list[str] = None,
    web_sources: list[dict] = None,
    model_used: str = None,
) -> str:
    mid = str(uuid.uuid4())
    now = _now()
    with _conn() as conn:
        conn.execute(
            """INSERT INTO messages(id, conversation_id, role, content, sources, web_sources, model_used, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (
                mid,
                conversation_id,
                role,
                content,
                json.dumps(sources or []),
                json.dumps(web_sources or []),
                model_used,
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
