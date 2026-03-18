"""
db.py — SQLite-backed storage for Dave-in-a-Box.

Database location: /app/data/conversations.db (persisted via Docker volume rag_data).

Schema:
  projects(id, name, system_prompt, created_at)
  conversations(id, title, project_id, created_at, updated_at)
  messages(id, conversation_id, role, content, sources, web_sources, model_used, created_at)
  memory(id, fact, created_at)

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
            CREATE TABLE IF NOT EXISTS projects (
                id            TEXT PRIMARY KEY,
                name          TEXT NOT NULL,
                system_prompt TEXT,
                created_at    TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS conversations (
                id         TEXT PRIMARY KEY,
                title      TEXT NOT NULL DEFAULT 'New Chat',
                project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
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
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_messages_conversation
                ON messages(conversation_id, created_at);
        """)
        # Migrate: add project_id column if it doesn't exist (for existing DBs)
        try:
            conn.execute("ALTER TABLE conversations ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL")
        except Exception:
            pass  # Column already exists


# ── Projects ──

def create_project(name: str, system_prompt: str = None) -> str:
    pid = str(uuid.uuid4())
    with _conn() as conn:
        conn.execute(
            "INSERT INTO projects(id, name, system_prompt, created_at) VALUES (?,?,?,?)",
            (pid, name, system_prompt, _now()),
        )
    return pid


def list_projects() -> list[dict]:
    with _conn() as conn:
        rows = conn.execute("SELECT * FROM projects ORDER BY created_at ASC").fetchall()
    return [dict(r) for r in rows]


def get_project(pid: str) -> Optional[dict]:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
    return dict(row) if row else None


def update_project(pid: str, name: str = None, system_prompt: str = None):
    with _conn() as conn:
        if name is not None:
            conn.execute("UPDATE projects SET name=? WHERE id=?", (name, pid))
        if system_prompt is not None:
            conn.execute("UPDATE projects SET system_prompt=? WHERE id=?", (system_prompt, pid))


def delete_project(pid: str):
    with _conn() as conn:
        conn.execute("DELETE FROM projects WHERE id = ?", (pid,))


# ── Conversations ──

def create_conversation(title: str = "New Chat", project_id: str = None) -> str:
    cid = str(uuid.uuid4())
    now = _now()
    with _conn() as conn:
        conn.execute(
            "INSERT INTO conversations(id, title, project_id, created_at, updated_at) VALUES (?,?,?,?,?)",
            (cid, title, project_id, now, now),
        )
    return cid


def list_conversations() -> list[dict]:
    with _conn() as conn:
        rows = conn.execute("""
            SELECT c.id, c.title, c.project_id, c.created_at, c.updated_at,
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


def move_conversation(cid: str, project_id: Optional[str]):
    with _conn() as conn:
        conn.execute(
            "UPDATE conversations SET project_id=?, updated_at=? WHERE id=?",
            (project_id, _now(), cid),
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


# ── Memory ──

def list_memory() -> list[dict]:
    with _conn() as conn:
        rows = conn.execute("SELECT * FROM memory ORDER BY created_at ASC").fetchall()
    return [dict(r) for r in rows]


def add_memory_fact(fact: str) -> str:
    mid = str(uuid.uuid4())
    with _conn() as conn:
        conn.execute(
            "INSERT INTO memory(id, fact, created_at) VALUES (?,?,?)",
            (mid, fact.strip(), _now()),
        )
    return mid


def delete_memory_fact(mid: str):
    with _conn() as conn:
        conn.execute("DELETE FROM memory WHERE id = ?", (mid,))
