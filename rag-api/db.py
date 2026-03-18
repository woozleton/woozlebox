"""
db.py — SQLite-backed conversation storage for Dave-in-a-Box.

Database location: /app/data/conversations.db (persisted via Docker volume rag_data).

Schema:
  conversations(id, title, created_at, updated_at)
  messages(id, conversation_id, role, content, sources, web_sources, model_used, created_at)

sources and web_sources are stored as JSON text.
"""

import sqlite3
import json
import uuid
import os
from datetime import datetime, timezone
from typing import Optional

DB_DIR = os.environ.get("DB_DIR", "/app/data")
DB_PATH = os.path.join(DB_DIR, "conversations.db")


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
            CREATE TABLE IF NOT EXISTS conversations (
                id         TEXT PRIMARY KEY,
                title      TEXT NOT NULL DEFAULT 'New Chat',
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

            CREATE INDEX IF NOT EXISTS idx_messages_conversation
                ON messages(conversation_id, created_at);
        """)


def create_conversation(title: str = "New Chat") -> str:
    cid = str(uuid.uuid4())
    now = _now()
    with _conn() as conn:
        conn.execute(
            "INSERT INTO conversations(id, title, created_at, updated_at) VALUES (?,?,?,?)",
            (cid, title, now, now),
        )
    return cid


def list_conversations() -> list[dict]:
    with _conn() as conn:
        rows = conn.execute("""
            SELECT c.id, c.title, c.created_at, c.updated_at,
                   COUNT(m.id) AS message_count
            FROM conversations c
            LEFT JOIN messages m ON m.conversation_id = c.id
            GROUP BY c.id
            ORDER BY c.updated_at DESC
        """).fetchall()
    return [dict(r) for r in rows]


def get_conversation(cid: str) -> Optional[dict]:
    with _conn() as conn:
        conv = conn.execute(
            "SELECT * FROM conversations WHERE id = ?", (cid,)
        ).fetchone()
        if not conv:
            return None
        msgs = conn.execute(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
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


def compact_conversation(cid: str, summary: str) -> str:
    """Replace all messages in a conversation with a single summary message."""
    with _conn() as conn:
        conn.execute("DELETE FROM messages WHERE conversation_id = ?", (cid,))
    return add_message(cid, "system", f"[Conversation summary]\n{summary}")


def delete_conversation(cid: str):
    with _conn() as conn:
        conn.execute("DELETE FROM conversations WHERE id = ?", (cid,))


def rename_conversation(cid: str, title: str):
    with _conn() as conn:
        conn.execute(
            "UPDATE conversations SET title=?, updated_at=? WHERE id=?",
            (title[:80], _now(), cid),
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


def search_conversations(query: str) -> list[dict]:
    """Full-text search across conversation titles and message content."""
    q = f"%{query.strip()}%"
    with _conn() as conn:
        rows = conn.execute("""
            SELECT DISTINCT c.id, c.title, c.updated_at,
                   m.role, m.content AS snippet
            FROM conversations c
            JOIN messages m ON m.conversation_id = c.id
            WHERE c.title LIKE ? OR m.content LIKE ?
            ORDER BY c.updated_at DESC
            LIMIT 50
        """, (q, q)).fetchall()
    # Deduplicate by conv id, keep best snippet
    seen = {}
    results = []
    for r in rows:
        r = dict(r)
        cid = r["id"]
        if cid not in seen:
            seen[cid] = True
            # Truncate snippet around match
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


def auto_title(conversation_id: str, text: str):
    """Set conversation title from first user message if still default."""
    title = text.strip()[:60]
    if len(text.strip()) > 60:
        title += "…"
    with _conn() as conn:
        conn.execute(
            "UPDATE conversations SET title=?, updated_at=? WHERE id=? AND title='New Chat'",
            (title, _now(), conversation_id),
        )
