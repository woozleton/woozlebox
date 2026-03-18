"""
main.py — FastAPI RAG service for Dave-in-a-Box.

Chat flow (streaming SSE):
  1. Embed question via nomic-embed-text
  2. Query ChromaDB (cosine distance, top_k chunks)
  3. Optionally query SearXNG for web results
  4. If best distance > threshold → stream "not found" done event
  5. Stream status events, then token-by-token LLM response
  6. Save conversation + messages to SQLite on completion
"""

import os
import json
import logging
import asyncio
import shutil
import secrets
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Optional, AsyncGenerator

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response
from passlib.context import CryptContext
from pydantic import BaseModel
import ollama as ollama_client

from indexer import get_chroma_client, embed_texts, index_vault, collection_name_for_user
import db

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- Config ---
VAULT_PATH        = os.environ.get("VAULT_PATH", "/vault")
OLLAMA_BASE_URL   = os.environ.get("OLLAMA_BASE_URL", "http://host.docker.internal:11434")
EMBED_MODEL       = os.environ.get("EMBED_MODEL", "nomic-embed-text")
LLM_MODEL         = os.environ.get("LLM_MODEL", "qwen3:30b-a3b")
SIMILARITY_THRESHOLD = float(os.environ.get("SIMILARITY_THRESHOLD", "0.6"))
SEARXNG_URL       = os.environ.get("SEARXNG_URL", "http://searxng:8080")
DB_DIR            = os.environ.get("DB_DIR", "/app/data")
KOKORO_URL        = os.environ.get("KOKORO_URL", "http://kokoro:8880")
DEFAULT_VOICE     = os.environ.get("TTS_VOICE", "af_heart")
DEFAULT_TOP_K     = 30
NOT_FOUND_MSG     = "I couldn't find that in your vault."
SUPPORTED_UPLOAD_EXTENSIONS = {".md", ".txt", ".pdf"}

KOKORO_VOICES = [
    "af_heart", "af_bella", "af_nicole", "af_sarah", "af_sky",
    "am_adam", "am_michael",
    "bf_emma", "bf_isabella",
    "bm_george", "bm_lewis",
]

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")


# --- Auth helpers ---

def get_current_user(request: Request) -> dict:
    token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Unauthorized")
    session = db.get_session(token)
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    user = db.get_user_by_id(session["user_id"])
    if not user or not user["is_active"]:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return user


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Forbidden")
    return user


# --- Vault helpers ---

def user_vault_path(user_id: str) -> Path:
    p = Path(VAULT_PATH) / user_id
    p.mkdir(parents=True, exist_ok=True)
    return p


def _migrate_vault_files(admin_id: str):
    """Move any files/dirs at the vault root (not in a UUID subdir) into /vault/{admin_id}/."""
    vault = Path(VAULT_PATH)
    if not vault.exists():
        return
    dest = vault / admin_id
    dest.mkdir(parents=True, exist_ok=True)
    import re
    uuid_re = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    for item in list(vault.iterdir()):
        if item.name == admin_id:
            continue
        if item.is_dir() and uuid_re.match(item.name):
            continue  # already a user subdir
        try:
            shutil.move(str(item), str(dest / item.name))
            logger.info(f"Vault migration: moved {item.name} → {admin_id}/")
        except Exception as e:
            logger.warning(f"Vault migration: could not move {item.name}: {e}")


# --- Lifespan ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()

    # Migrate vault files to admin subdir if needed
    users = db.list_users()
    admins = [u for u in users if u["role"] == "admin"]
    if admins:
        _migrate_vault_files(admins[0]["id"])

    # Index vault for each active user
    logger.info("Starting up — indexing vaults...")
    loop = asyncio.get_event_loop()
    for user in users:
        if user.get("is_active"):
            try:
                result = await loop.run_in_executor(
                    None, index_vault, VAULT_PATH, user["id"], EMBED_MODEL, OLLAMA_BASE_URL
                )
                logger.info(f"Indexed vault for user {user['username']}: {result}")
            except Exception as e:
                logger.warning(f"Vault index failed for {user['username']}: {e}")

    yield


app = FastAPI(title="Dave-in-a-Box RAG API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# --- Pydantic models ---
class ChatRequest(BaseModel):
    message: str
    model: Optional[str] = None
    conversation_id: Optional[str] = None
    topic_id: Optional[str] = None
    temperature: float = 0.2
    threshold: Optional[float] = None
    top_k: int = DEFAULT_TOP_K
    web_search: bool = False
    history_limit: int = 10
    compact_threshold: int = 75  # % of context at which to auto-compact
    user_context: Optional[str] = None  # profile name/role/preferences
    default_prompt: Optional[str] = None  # global default system prompt from settings

class ConversationPatch(BaseModel):
    title: str

class ConversationMove(BaseModel):
    topic_id: str

class TopicCreate(BaseModel):
    name: str
    description: Optional[str] = None
    system_prompt: Optional[str] = None

class TopicPatch(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    system_prompt: Optional[str] = None

class MemoryFactCreate(BaseModel):
    fact: str

class IndexResponse(BaseModel):
    files_processed: int
    chunks_upserted: int
    errors: list[str]

class ModelsResponse(BaseModel):
    models: list[str]
    default: str

class VaultDeleteRequest(BaseModel):
    path: str  # relative path within vault

class VaultRenameRequest(BaseModel):
    path: str
    new_name: str

class LoginRequest(BaseModel):
    username: str
    password: str

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

class AdminCreateUserRequest(BaseModel):
    username: str
    password: str
    role: str = "user"

class AdminPatchUserRequest(BaseModel):
    role: Optional[str] = None
    is_active: Optional[bool] = None

class AdminSetPasswordRequest(BaseModel):
    new_password: str

class UserSettingsRequest(BaseModel):
    settings: str  # opaque JSON string


# --- SSE helpers ---
def sse(event: dict) -> str:
    return f"data: {json.dumps(event)}\n\n"


# --- Web search ---
async def web_search(query: str, num_results: int = 5) -> list[dict]:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{SEARXNG_URL}/search",
                params={"q": query, "format": "json", "language": "en"},
            )
            resp.raise_for_status()
            data = resp.json()
            results = []
            for r in data.get("results", [])[:num_results]:
                results.append({
                    "title": r.get("title", ""),
                    "url": r.get("url", ""),
                    "snippet": r.get("content", ""),
                })
            return results
    except Exception as e:
        logger.warning(f"Web search failed: {e}")
        return []


# --- Streaming chat generator ---
async def chat_stream(request: ChatRequest, user_id: str) -> AsyncGenerator[str, None]:
    model = request.model or LLM_MODEL
    threshold = request.threshold if request.threshold is not None else SIMILARITY_THRESHOLD
    top_k = max(1, request.top_k)
    collection_name = collection_name_for_user(user_id)

    # Step 1: Embed
    yield sse({"type": "status", "step": "embed", "text": "Understanding your question…"})
    try:
        loop = asyncio.get_event_loop()
        query_embedding = await loop.run_in_executor(
            None, lambda: embed_texts([request.message], EMBED_MODEL, OLLAMA_BASE_URL)[0]
        )
    except Exception as e:
        yield sse({"type": "error", "text": f"Embedding failed: {e}"})
        return
    yield sse({"type": "status", "step": "embed", "text": "Question understood", "done": True})

    # Step 2: Vault search
    yield sse({"type": "status", "step": "vault", "text": "Reading through your vault…"})
    documents, metadatas, distances = [], [], []
    try:
        chroma_client = get_chroma_client()
        collection = chroma_client.get_collection(collection_name)
        results = collection.query(
            query_embeddings=[query_embedding],
            n_results=top_k,
            include=["documents", "metadatas", "distances"],
        )
        documents = results["documents"][0]
        metadatas = results["metadatas"][0]
        distances = results["distances"][0]
    except Exception as e:
        if "does not exist" not in str(e):
            yield sse({"type": "error", "text": f"Vault search failed: {e}"})
            return

    best_distance = distances[0] if distances else 2.0
    relevant = [
        (doc, meta)
        for doc, meta, dist in zip(documents, metadatas, distances)
        if dist <= threshold
    ]
    sources = list(dict.fromkeys(meta["source"] for _, meta in relevant))
    debug = {"best_distance": best_distance, "threshold": threshold, "chunks_retrieved": len(documents), "chunks_used": len(relevant)}

    if relevant:
        src_names = ", ".join(os.path.basename(s) for s in sources[:3])
        yield sse({"type": "status", "step": "vault", "text": f"Found relevant content in {src_names}", "done": True})
    else:
        yield sse({"type": "status", "step": "vault", "text": "Nothing relevant found in vault", "done": True})

    # Step 3: Web search (optional)
    web_sources = []
    if request.web_search:
        yield sse({"type": "status", "step": "web", "text": "Searching the web…"})
        web_sources = await web_search(request.message)
        suffix = f"found {len(web_sources)} results" if web_sources else "no results found"
        yield sse({"type": "status", "step": "web", "text": f"Web search complete — {suffix}", "done": True})

    # Step 4: (fallthrough — always proceed to LLM)

    # Step 5: Build context
    context_parts = []
    if relevant:
        vault_context = "\n\n---\n\n".join(doc for doc, _ in relevant)
        context_parts.append(f"[VAULT CONTEXT]\n{vault_context}")
    if web_sources:
        web_context = "\n\n".join(
            f"Title: {r['title']}\nURL: {r['url']}\nSummary: {r['snippet']}"
            for r in web_sources
        )
        context_parts.append(f"[WEB SEARCH RESULTS]\n{web_context}")

    context_text = "\n\n" + "\n\n".join(context_parts)
    source_instruction = "Use the vault context as your primary source." if relevant and web_sources else ""

    # Build system prompt — topic override, memory, user profile
    base_instructions = request.default_prompt or "You are a personal AI assistant. When relevant context from the user's vault is provided, prioritize it in your answer. Otherwise, answer using your general knowledge."

    # Use topic system prompt if provided (overrides default)
    if request.topic_id:
        topic = db.get_topic(request.topic_id, user_id)
        if topic and topic.get("system_prompt"):
            base_instructions = topic["system_prompt"]

    # Inject memory facts
    memory_facts = db.list_memory(user_id)
    memory_section = ""
    if memory_facts:
        facts_text = "\n".join(f"- {m['fact']}" for m in memory_facts)
        memory_section = f"\n\nWhat you know about the user:\n{facts_text}"

    # Inject user profile/preferences
    user_section = ""
    if request.user_context:
        user_section = f"\n\nUser profile:\n{request.user_context}"

    context_block = f"\n\nContext:\n{context_text}" if context_parts else ""
    system_prompt = f"""{base_instructions}{memory_section}{user_section}{' ' + source_instruction if source_instruction else ''}{context_block}

Answer concisely, then end with a single relevant follow-up question on its own line, prefixed with "**Follow-up:**"."""

    # Auto-compact if context is getting full
    if request.conversation_id and request.compact_threshold > 0:
        try:
            ctx_limit = 4096
            async with httpx.AsyncClient(timeout=5) as hc:
                r = await hc.post(f"{OLLAMA_BASE_URL}/api/show", json={"model": model})
                info = r.json().get("model_info", {})
                for key in ("context_length", "llama.context_length", "qwen2.context_length"):
                    if key in info:
                        ctx_limit = int(info[key]); break
            conv_check = db.get_conversation(request.conversation_id, user_id)
            if conv_check:
                total_chars = sum(len(m["content"]) for m in conv_check["messages"])
                pct = (total_chars // 4) / ctx_limit * 100
                if pct >= request.compact_threshold:
                    logger.info(f"Context at {pct:.1f}% — auto-compacting conversation {request.conversation_id}")
                    yield sse({"type": "status", "step": "compact", "text": "Compacting conversation history…"})
                    history_text = "\n\n".join(
                        f"{m['role'].upper()}: {m['content']}" for m in conv_check["messages"]
                    )
                    compact_resp = httpx.post(
                        f"{OLLAMA_BASE_URL}/api/chat",
                        json={
                            "model": model,
                            "messages": [
                                {"role": "system", "content": "You are a concise summarizer. Output only the summary, nothing else."},
                                {"role": "user", "content": f"Summarize this conversation history concisely, preserving all key facts, decisions, and context:\n\n{history_text}"},
                            ],
                            "options": {"temperature": 0.3, "num_predict": 600},
                            "think": False,
                            "stream": False,
                        },
                        timeout=60,
                    )
                    summary = compact_resp.json().get("message", {}).get("content", "").strip()
                    if summary:
                        db.compact_conversation(request.conversation_id, user_id, summary)
                        yield sse({"type": "status", "step": "compact", "text": "History compacted", "done": True})
        except Exception as e:
            logger.warning(f"Auto-compact failed: {e}")

    # Build message history for multi-turn context
    messages = [{"role": "system", "content": system_prompt}]
    if request.conversation_id and request.history_limit > 0:
        conv = db.get_conversation(request.conversation_id, user_id)
        if conv:
            for msg in conv["messages"][-request.history_limit:]:
                messages.append({"role": msg["role"] if msg["role"] != "assistant" else "assistant", "content": msg["content"]})
    messages.append({"role": "user", "content": request.message})

    logger.info(f"Sending {len(relevant)} vault chunks + {len(web_sources)} web results to LLM ({len(context_text)} chars), {len(messages)} messages in history")

    # Step 6: Stream LLM response
    ctx_kb = round(len(context_text) / 1024, 1)
    yield sse({"type": "status", "step": "llm", "text": f"Thinking through {ctx_kb} KB of context…"})

    full_answer = ""
    try:
        client = ollama_client.Client(host=OLLAMA_BASE_URL)
        stream = client.chat(
            model=model,
            messages=messages,
            options={"temperature": request.temperature},
            stream=True,
        )
        for chunk in stream:
            token = chunk["message"]["content"]
            if token:
                full_answer += token
                yield sse({"type": "token", "text": token})
    except Exception as e:
        logger.error(f"LLM streaming failed: {e}")
        err_str = str(e)
        if "system memory" in err_str or "out of memory" in err_str.lower():
            yield sse({"type": "error", "text": f"Model '{model}' requires more memory than is available. Please select a smaller model in Settings > AI > Default LLM."})
        else:
            yield sse({"type": "error", "text": f"LLM unavailable: {e}"})
        return

    # Step 7: Save to DB
    conv_id = request.conversation_id
    if not conv_id:
        conv_id = db.create_conversation(user_id=user_id, topic_id=request.topic_id)
    db.auto_title(conv_id, user_id, request.message)
    db.add_message(conv_id, "user", request.message)
    db.add_message(conv_id, "assistant", full_answer.strip(), sources=sources, web_sources=web_sources, model_used=model)

    yield sse({
        "type": "done",
        "from_vault": bool(relevant),
        "sources": sources,
        "web_sources": web_sources,
        "model_used": model,
        "conversation_id": conv_id,
        "debug": debug,
    })


# --- Endpoints ---

@app.get("/health")
async def health():
    services = {}
    async with httpx.AsyncClient(timeout=2) as client:
        for name, url in [
            ("ollama", f"{OLLAMA_BASE_URL}/api/tags"),
            ("chromadb", f"http://{os.environ.get('CHROMA_HOST','chromadb')}:{os.environ.get('CHROMA_PORT_INTERNAL','8000')}/api/v2/heartbeat"),
            ("searxng", f"{os.environ.get('SEARXNG_URL','http://searxng:8080')}/healthz"),
            ("kokoro", f"{os.environ.get('KOKORO_URL','http://kokoro:8880')}/health"),
        ]:
            try:
                r = await client.get(url)
                services[name] = r.status_code < 400
            except Exception:
                services[name] = False
    return {"status": "ok", "services": services}


@app.get("/models", response_model=ModelsResponse)
def list_models():
    try:
        client = ollama_client.Client(host=OLLAMA_BASE_URL)
        response = client.list()
        raw_models = response.get("models", []) if isinstance(response, dict) else getattr(response, "models", [])
        names = []
        for m in raw_models:
            name = m.get("model") or m.get("name", "") if isinstance(m, dict) else getattr(m, "model", None) or getattr(m, "name", "")
            if name:
                names.append(name)
        if LLM_MODEL in names:
            names = [LLM_MODEL] + [n for n in names if n != LLM_MODEL]
        return ModelsResponse(models=names, default=LLM_MODEL)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Ollama unavailable: {e}")


@app.get("/context-info")
async def context_info(model: str = None, conversation_id: str = None, user: dict = Depends(get_current_user)):
    use_model = model or LLM_MODEL
    ctx_limit = 4096
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.post(f"{OLLAMA_BASE_URL}/api/show", json={"model": use_model})
            info = r.json().get("model_info", {})
            for key in ("context_length", "llama.context_length", "qwen2.context_length"):
                if key in info:
                    ctx_limit = int(info[key])
                    break
    except Exception:
        pass

    tokens_used = 0
    if conversation_id:
        conv = db.get_conversation(conversation_id, user["id"])
        if conv:
            for msg in conv["messages"]:
                tokens_used += len(msg["content"]) // 4

    return {
        "context_limit": ctx_limit,
        "tokens_used": tokens_used,
        "percent": round(tokens_used / ctx_limit * 100, 1) if ctx_limit else 0,
    }


@app.post("/chat")
async def chat(request: ChatRequest, user: dict = Depends(get_current_user)):
    if not request.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    return StreamingResponse(
        chat_stream(request, user["id"]),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/index", response_model=IndexResponse)
async def trigger_reindex(user: dict = Depends(get_current_user)):
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, index_vault, VAULT_PATH, user["id"], EMBED_MODEL, OLLAMA_BASE_URL)
    return IndexResponse(**result)


@app.get("/suggestions")
async def get_suggestions(model: str = None, user: dict = Depends(get_current_user)):
    use_model = model or LLM_MODEL
    vault = user_vault_path(user["id"])
    filenames = []
    if vault.is_dir():
        for p in vault.rglob("*"):
            if p.is_file():
                filenames.append(str(p.relative_to(vault)))
    if not filenames:
        return {"suggestions": []}
    file_list = "\n".join(f"- {f}" for f in filenames[:40])
    prompt = (
        f"Files in vault:\n{file_list}\n\n"
        "Write exactly 4 questions a user might ask about these files. "
        "Rules: each question on its own line, ends with ?, under 60 chars, no numbering, no bullets, no explanations."
    )
    try:
        import re as _re
        ollama_resp = httpx.post(
            f"{OLLAMA_BASE_URL}/api/chat",
            json={
                "model": use_model,
                "messages": [
                    {"role": "system", "content": "You are a concise assistant. Output only the requested list, nothing else. No explanations, no preamble, no reasoning."},
                    {"role": "user", "content": prompt},
                ],
                "options": {"temperature": 0.7, "num_predict": 800},
                "think": False,
                "stream": False,
            },
            timeout=60,
        )
        ollama_resp.raise_for_status()
        data = ollama_resp.json()
        raw = data.get("message", {}).get("content", "")
        cleaned = _re.sub(r"<think>[\s\S]*?</think>", "", raw, flags=_re.IGNORECASE)
        lines = [line.strip().lstrip("-•* ") for line in cleaned.splitlines()]
        suggestions = [s for s in lines if s.endswith("?") and 10 < len(s) < 100][:4]
        if not suggestions:
            raise ValueError("no suggestions parsed")
        return {"suggestions": suggestions}
    except Exception as e:
        logger.warning(f"suggestions failed: {e}")
        return {"suggestions": []}


@app.get("/search")
async def search_proxy(q: str, user: dict = Depends(get_current_user)):
    results = await web_search(q)
    return {"results": results}


# --- Auth endpoints (public) ---

@app.get("/auth/status")
def auth_status():
    return {"has_users": db.has_users()}


@app.post("/auth/login")
def auth_login(body: LoginRequest):
    user = db.get_user_by_username(body.username)
    if not user or not user["is_active"]:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not pwd_ctx.verify(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = db.create_session(user["id"])
    return {
        "token": token,
        "user": {
            "id": user["id"],
            "username": user["username"],
            "role": user["role"],
            "settings": user["settings"],
        },
    }


# --- Auth endpoints (require login) ---

@app.post("/auth/logout")
def auth_logout(request: Request, user: dict = Depends(get_current_user)):
    token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    if token:
        db.delete_session(token)
    return {"ok": True}


@app.get("/auth/me")
def auth_me(user: dict = Depends(get_current_user)):
    return {
        "id": user["id"],
        "username": user["username"],
        "role": user["role"],
        "settings": user["settings"],
    }


@app.put("/auth/me/password")
def change_own_password(body: ChangePasswordRequest, user: dict = Depends(get_current_user)):
    if not pwd_ctx.verify(body.current_password, user["password_hash"]):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    if len(body.new_password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    db.update_user_password(user["id"], pwd_ctx.hash(body.new_password))
    return {"ok": True}


@app.put("/users/me/settings")
def update_own_settings(body: UserSettingsRequest, user: dict = Depends(get_current_user)):
    db.update_user_settings(user["id"], body.settings)
    return {"ok": True}


@app.delete("/users/me")
def delete_own_account(user: dict = Depends(get_current_user)):
    db.delete_user(user["id"])
    return {"ok": True}


# --- Admin endpoints ---

@app.get("/admin/users")
def admin_list_users(admin: dict = Depends(require_admin)):
    return db.list_users()


@app.post("/admin/users")
def admin_create_user(body: AdminCreateUserRequest, request: Request):
    # If no users exist yet, always create as admin (bootstrap)
    if not db.has_users():
        role = "admin"
    else:
        # Require admin auth for subsequent users
        token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if not token:
            raise HTTPException(status_code=401, detail="Unauthorized")
        session = db.get_session(token)
        if not session:
            raise HTTPException(status_code=401, detail="Unauthorized")
        caller = db.get_user_by_id(session["user_id"])
        if not caller or caller["role"] != "admin":
            raise HTTPException(status_code=403, detail="Forbidden")
        role = body.role if body.role in ("admin", "user") else "user"

    if not body.username.strip():
        raise HTTPException(status_code=400, detail="Username cannot be empty")
    if len(body.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    uid = db.create_user(body.username.strip(), pwd_ctx.hash(body.password), role)
    return {"id": uid, "username": body.username.strip(), "role": role}


@app.patch("/admin/users/{uid}")
def admin_patch_user(uid: str, body: AdminPatchUserRequest, admin: dict = Depends(require_admin)):
    if uid == admin["id"] and body.is_active is False:
        raise HTTPException(status_code=400, detail="Cannot disable your own account")
    if body.role is not None:
        if body.role not in ("admin", "user"):
            raise HTTPException(status_code=400, detail="Role must be 'admin' or 'user'")
        db.update_user_role(uid, body.role)
    if body.is_active is not None:
        db.update_user_active(uid, body.is_active)
    return {"ok": True}


@app.put("/admin/users/{uid}/password")
def admin_set_password(uid: str, body: AdminSetPasswordRequest, admin: dict = Depends(require_admin)):
    if len(body.new_password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    db.update_user_password(uid, pwd_ctx.hash(body.new_password))
    return {"ok": True}


@app.delete("/admin/users/{uid}")
def admin_delete_user(uid: str, admin: dict = Depends(require_admin)):
    if uid == admin["id"]:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")
    db.delete_user(uid)
    return {"ok": True}


# --- TTS endpoints ---

@app.get("/tts/voices")
def tts_voices():
    return {"voices": KOKORO_VOICES, "default": DEFAULT_VOICE}


@app.get("/tts")
async def tts_proxy(text: str, voice: str = DEFAULT_VOICE, format: str = "wav"):
    if not text.strip():
        raise HTTPException(status_code=400, detail="text is required")
    if voice not in KOKORO_VOICES:
        voice = DEFAULT_VOICE

    payload = {
        "model": "kokoro",
        "input": text,
        "voice": voice,
        "response_format": format,
    }
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(f"{KOKORO_URL}/v1/audio/speech", json=payload)
            resp.raise_for_status()
            audio_bytes = resp.content
    except Exception as e:
        logger.warning(f"TTS synthesis failed: {e}")
        raise HTTPException(status_code=503, detail=f"TTS unavailable: {e}")

    return StreamingResponse(
        iter([audio_bytes]),
        media_type="audio/wav" if format == "wav" else "audio/mpeg",
        headers={"Cache-Control": "no-cache"},
    )


# --- Topic endpoints ---

@app.get("/topics")
def list_topics(user: dict = Depends(get_current_user)):
    return db.list_topics(user["id"])

@app.post("/topics")
def create_topic(body: TopicCreate, user: dict = Depends(get_current_user)):
    pid = db.create_topic(user["id"], body.name, body.description, body.system_prompt)
    return {"id": pid}

@app.patch("/topics/{pid}")
def update_topic(pid: str, body: TopicPatch, user: dict = Depends(get_current_user)):
    db.update_topic(pid, user["id"], body.name, body.description, body.system_prompt)
    return {"ok": True}

@app.delete("/topics/{pid}")
def delete_topic(pid: str, user: dict = Depends(get_current_user)):
    db.delete_topic(pid, user["id"])
    return {"ok": True}


# --- Memory endpoints ---

@app.get("/memory")
def list_memory(user: dict = Depends(get_current_user)):
    return db.list_memory(user["id"])

@app.post("/memory")
def add_memory(body: MemoryFactCreate, user: dict = Depends(get_current_user)):
    mid = db.add_memory_fact(body.fact, user["id"])
    return {"id": mid}

@app.delete("/memory/{mid}")
def delete_memory(mid: str, user: dict = Depends(get_current_user)):
    db.delete_memory_fact(mid, user["id"])
    return {"ok": True}


# --- Conversation endpoints ---

@app.get("/conversations/search")
def search_convs(q: str = "", user: dict = Depends(get_current_user)):
    if not q.strip():
        return []
    return db.search_conversations(q, user["id"])


@app.get("/conversations")
def list_convs(user: dict = Depends(get_current_user)):
    return db.list_conversations(user["id"])


@app.post("/conversations")
def create_conv(topic_id: Optional[str] = None, user: dict = Depends(get_current_user)):
    cid = db.create_conversation(user_id=user["id"], topic_id=topic_id)
    return {"id": cid}


@app.get("/conversations/{cid}")
def get_conv(cid: str, user: dict = Depends(get_current_user)):
    conv = db.get_conversation(cid, user["id"])
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


@app.delete("/conversations/{cid}")
def delete_conv(cid: str, user: dict = Depends(get_current_user)):
    db.delete_conversation(cid, user["id"])
    return {"ok": True}


@app.patch("/conversations/{cid}")
def rename_conv(cid: str, body: ConversationPatch, user: dict = Depends(get_current_user)):
    db.rename_conversation(cid, user["id"], body.title)
    return {"ok": True}


@app.patch("/conversations/{cid}/move")
def move_conv(cid: str, body: ConversationMove, user: dict = Depends(get_current_user)):
    db.move_conversation(cid, user["id"], body.topic_id)
    return {"ok": True}


# --- Vault file management endpoints ---

def _read_index_meta(user_id: str) -> dict:
    meta_path = Path(DB_DIR) / f"index_meta_{user_id}.json"
    try:
        return json.loads(meta_path.read_text())
    except Exception:
        return {"last_indexed": None, "files_processed": 0, "chunks_upserted": 0, "errors": []}


def _get_chunk_counts(user_id: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    try:
        chroma_client = get_chroma_client()
        collection = chroma_client.get_collection(collection_name_for_user(user_id))
        result = collection.get(include=["metadatas"])
        for meta in result.get("metadatas", []):
            src = meta.get("source", "")
            if src:
                counts[src] = counts.get(src, 0) + 1
    except Exception as e:
        logger.warning(f"Could not read chunk counts: {e}")
    return counts


@app.get("/vault/files")
def list_vault_files(user: dict = Depends(get_current_user)):
    vault = user_vault_path(user["id"])
    if not vault.exists():
        raise HTTPException(status_code=503, detail="Vault path not found")

    supported = {".md", ".txt", ".pdf"}
    chunk_counts = _get_chunk_counts(user["id"])
    meta = _read_index_meta(user["id"])

    files = []
    for f in sorted(vault.rglob("*")):
        if f.is_file() and f.suffix.lower() in supported:
            rel = f.relative_to(vault)
            stat = f.stat()
            files.append({
                "name": f.name,
                "path": str(rel).replace("\\", "/"),
                "size_bytes": stat.st_size,
                "modified_at": datetime.utcfromtimestamp(stat.st_mtime).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "chunk_count": chunk_counts.get(f.name, 0),
            })

    return {
        "files": files,
        "last_indexed": meta.get("last_indexed"),
        "files_processed": meta.get("files_processed", 0),
        "chunks_upserted": meta.get("chunks_upserted", 0),
    }


@app.post("/vault/upload")
async def upload_vault_file(
    file: UploadFile = File(...),
    subfolder: str = Form(""),
    user: dict = Depends(get_current_user),
):
    suffix = Path(file.filename).suffix.lower()
    if suffix not in SUPPORTED_UPLOAD_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {suffix}")

    vault = user_vault_path(user["id"])
    safe_sub = Path(subfolder.strip("/").strip()) if subfolder.strip() else Path("")
    for part in safe_sub.parts:
        if part in (".", ".."):
            raise HTTPException(status_code=400, detail="Invalid subfolder path")

    dest_dir = vault / safe_sub
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / file.filename

    with dest.open("wb") as out:
        shutil.copyfileobj(file.file, out)

    return {"ok": True, "path": str((safe_sub / file.filename)).replace("\\", "/")}


@app.delete("/vault/files")
def delete_vault_file(body: VaultDeleteRequest, user: dict = Depends(get_current_user)):
    vault = user_vault_path(user["id"])
    target = (vault / body.path).resolve()
    try:
        vault_resolved = vault.resolve()
        target.relative_to(vault_resolved)
    except ValueError:
        raise HTTPException(status_code=400, detail="Path outside vault")

    if not target.exists():
        raise HTTPException(status_code=404, detail="File not found")
    if not target.is_file():
        raise HTTPException(status_code=400, detail="Not a file")

    target.unlink()
    return {"ok": True}


@app.post("/vault/rename")
def rename_vault_file(body: VaultRenameRequest, user: dict = Depends(get_current_user)):
    vault = user_vault_path(user["id"])
    target = (vault / body.path).resolve()
    try:
        target.relative_to(vault.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Path outside vault")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    new_name = Path(body.new_name).name
    dest = target.parent / new_name
    if dest.exists():
        raise HTTPException(status_code=409, detail="File already exists")
    target.rename(dest)
    return {"ok": True, "path": str(dest.relative_to(vault.resolve()))}


@app.get("/vault/file")
def vault_file(path: str, user: dict = Depends(get_current_user)):
    vault = user_vault_path(user["id"])
    full_path = os.path.realpath(os.path.join(str(vault), path))
    vault_real = os.path.realpath(str(vault))
    if not full_path.startswith(vault_real + os.sep) and full_path != vault_real:
        raise HTTPException(status_code=403, detail="Access denied")
    if not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="File not found")
    ext = os.path.splitext(full_path)[1].lower()
    if ext == ".pdf":
        with open(full_path, "rb") as f:
            return Response(content=f.read(), media_type="application/pdf")
    with open(full_path, "r", encoding="utf-8", errors="replace") as f:
        return Response(content=f.read(), media_type="text/plain")
