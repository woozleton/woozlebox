"""
main.py -FastAPI RAG service for Dave-in-a-Box.

Chat flow (streaming SSE):
  1. Embed question via nomic-embed-text
  2. Query ChromaDB (cosine distance, top_k chunks)
  3. Optionally query SearXNG for web results
  4. If best distance > threshold → stream "not found" done event
  5. Stream status events, then token-by-token LLM response
  6. Save conversation + messages to SQLite on completion
"""

import os
import re
import json
import time
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
UTILITY_MODEL     = os.environ.get("UTILITY_MODEL", "qwen3:0.6b")
SIMILARITY_THRESHOLD = float(os.environ.get("SIMILARITY_THRESHOLD", "0.45"))
TAVILY_API_KEY    = os.environ.get("TAVILY_API_KEY", "")
DB_DIR            = os.environ.get("DB_DIR", "/app/data")
KOKORO_URL        = os.environ.get("KOKORO_URL", "http://kokoro:8880")
DEFAULT_VOICE     = os.environ.get("TTS_VOICE", "af_heart")
IMAGE_GEN_URL     = os.environ.get("IMAGE_GEN_URL", "http://image-api:8100")
MUSIC_GEN_URL     = os.environ.get("MUSIC_GEN_URL", "http://music-api:8200")
_image_gen_active = False  # Guard flag -blocks Ollama calls while image gen is using the GPU
_music_gen_active = False  # Guard flag -blocks Ollama calls while music gen is using the GPU
DEFAULT_TOP_K     = 30
NOT_FOUND_MSG     = "I couldn't find that in your vault."
SUPPORTED_UPLOAD_EXTENSIONS = {".md", ".txt", ".pdf"}

KOKORO_VOICES = [
    # American English -Female
    "af_heart", "af_bella", "af_nicole", "af_aoede", "af_kore",
    "af_sarah", "af_alloy", "af_nova", "af_sky", "af_jessica", "af_river",
    # American English -Male
    "am_fenrir", "am_michael", "am_puck", "am_echo", "am_eric",
    "am_liam", "am_onyx", "am_santa", "am_adam",
    # British English -Female
    "bf_emma", "bf_isabella", "bf_alice", "bf_lily",
    # British English -Male
    "bm_fable", "bm_george", "bm_lewis", "bm_daniel",
    # Japanese -Female
    "jf_alpha", "jf_gongitsune", "jf_tebukuro", "jf_nezumi",
    # Japanese -Male
    "jm_kumo",
    # Mandarin Chinese -Female
    "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi",
    # Mandarin Chinese -Male
    "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
    # Spanish -Female
    "ef_dora",
    # Spanish -Male
    "em_alex", "em_santa",
    # French -Female
    "ff_siwis",
    # Hindi -Female
    "hf_alpha", "hf_beta",
    # Hindi -Male
    "hm_omega", "hm_psi",
    # Italian -Female
    "if_sara",
    # Italian -Male
    "im_nicola",
    # Brazilian Portuguese -Female
    "pf_dora",
    # Brazilian Portuguese -Male
    "pm_alex", "pm_santa",
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

def user_vault_path(username: str) -> Path:
    p = Path(VAULT_PATH) / username
    p.mkdir(parents=True, exist_ok=True)
    return p


def _migrate_vault_files(admin_username: str):
    """Move any files/dirs at the vault root (not in a user subdir) into /vault/{admin_username}/."""
    vault = Path(VAULT_PATH)
    if not vault.exists():
        return
    dest = vault / admin_username
    dest.mkdir(parents=True, exist_ok=True)
    for item in list(vault.iterdir()):
        if item.name == admin_username:
            continue
        if item.is_dir():
            continue  # skip existing user subdirs
        try:
            shutil.move(str(item), str(dest / item.name))
            logger.info(f"Vault migration: moved {item.name} → {admin_username}/")
        except Exception as e:
            logger.warning(f"Vault migration: could not move {item.name}: {e}")


# --- Index status tracking ---
# Maps user_id -> {"running": bool, "queued": bool}
_index_status: dict[str, dict] = {}
_index_status_lock = __import__("threading").Lock()

def _set_index_status(user_id: str, running: bool, queued: bool = False):
    with _index_status_lock:
        _index_status[user_id] = {"running": running, "queued": queued}

def _get_index_status(user_id: str) -> dict:
    with _index_status_lock:
        return _index_status.get(user_id, {"running": False, "queued": False})


# --- Vault file watcher ---
def _start_vault_watcher():
    """Watch the vault directory and trigger incremental re-index when files change."""
    import threading
    import time
    from watchdog.observers.polling import PollingObserver
    from watchdog.events import FileSystemEventHandler

    SUPPORTED = {".md", ".txt", ".pdf"}
    DEBOUNCE_SECONDS = 3  # wait for burst of changes to settle

    # Per-user debounce timers
    _timers: dict[str, threading.Timer] = {}
    _lock = threading.Lock()

    def _reindex_user(username: str):
        user = db.get_user_by_username(username)
        if not user:
            return
        user_id = user["id"]
        _set_index_status(user_id, running=True, queued=False)
        try:
            result = index_vault(VAULT_PATH, user_id, EMBED_MODEL, OLLAMA_BASE_URL, username=username)
            logger.info(f"Auto-index for {username}: {result['files_processed']} new, {result.get('files_skipped',0)} skipped")
        except Exception as e:
            logger.warning(f"Auto-index failed for {username}: {e}")
        finally:
            _set_index_status(user_id, running=False)

    def _schedule_reindex(username: str):
        with _lock:
            if username in _timers:
                _timers[username].cancel()
            t = threading.Timer(DEBOUNCE_SECONDS, _reindex_user, args=[username])
            t.daemon = True
            _timers[username] = t
            t.start()
        # Set status using user_id for the frontend poll
        user = db.get_user_by_username(username)
        if user:
            _set_index_status(user["id"], running=False, queued=True)

    class VaultHandler(FileSystemEventHandler):
        def _handle(self, path: str):
            from pathlib import Path as P
            p = P(path)
            if p.suffix.lower() not in SUPPORTED:
                return
            # Derive username from path: VAULT_PATH/{username}/...
            try:
                rel = p.relative_to(VAULT_PATH)
                username = rel.parts[0]
                _schedule_reindex(username)
            except Exception:
                pass

        def on_created(self, event):
            if not event.is_directory: self._handle(event.src_path)
        def on_deleted(self, event):
            if not event.is_directory: self._handle(event.src_path)
        def on_moved(self, event):
            if not event.is_directory:
                self._handle(event.src_path)
                self._handle(event.dest_path)
        def on_modified(self, event):
            if not event.is_directory: self._handle(event.src_path)

    observer = PollingObserver(timeout=5)
    observer.schedule(VaultHandler(), path=VAULT_PATH, recursive=True)
    observer.daemon = True
    observer.start()
    logger.info(f"Vault watcher started on {VAULT_PATH}")


# --- Lifespan ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()

    # Migrate vault files to admin subdir if needed
    users = db.list_users()
    admins = [u for u in users if u["role"] == "admin"]
    if admins:
        _migrate_vault_files(admins[0]["username"])

    # Index vault for each active user
    logger.info("Starting up -indexing vaults...")
    loop = asyncio.get_event_loop()
    for user in users:
        if user.get("is_active"):
            try:
                result = await loop.run_in_executor(
                    None, lambda: index_vault(VAULT_PATH, user["id"], EMBED_MODEL, OLLAMA_BASE_URL, username=user["username"])
                )
                logger.info(f"Indexed vault for user {user['username']}: {result}")
            except Exception as e:
                logger.warning(f"Vault index failed for {user['username']}: {e}")

    # Start vault file watcher
    _start_vault_watcher()

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
    auto_memory: bool = False  # whether the LLM should auto-save memory facts
    images: list[str] = []  # base64-encoded images for vision models

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
    files_skipped: int = 0
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

class VaultFolderRequest(BaseModel):
    folder: str  # relative folder path within vault

class VaultMoveRequest(BaseModel):
    path: str        # current relative file path
    dest_folder: str # destination folder (empty string = vault root)

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
async def web_search(query: str, num_results: int = 3) -> list[dict]:
    """Search the web using Tavily -returns full extracted content directly."""
    try:
        from tavily import TavilyClient
        client = TavilyClient(api_key=TAVILY_API_KEY)
        response = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: client.search(query, max_results=num_results, include_raw_content=False)
        )
        results = []
        for r in response.get("results", []):
            results.append({
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "content": r.get("content", ""),
                "snippet": r.get("content", ""),
            })
        return results
    except Exception as e:
        logger.warning(f"Web search failed: {e}")
        return []


def _get_utility_model(user: dict = None) -> str:
    """Return the user's preferred utility model, or the server default."""
    if user:
        try:
            settings = json.loads(user.get("settings") or "{}")
            um = settings.get("diab_utility_model", "")
            if um:
                return um
        except Exception:
            pass
    return UTILITY_MODEL


async def _utility_llm(system: str, prompt: str, temperature: float = 0.8, num_predict: int = 80, user: dict = None) -> str:
    """Quick LLM call using the small utility model. Does NOT evict other models."""
    model = _get_utility_model(user)
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{OLLAMA_BASE_URL}/api/generate",
            json={
                "model": model,
                "system": system,
                "prompt": prompt,
                "stream": False,
                "think": False,
                "options": {"temperature": temperature, "num_predict": num_predict},
            },
        )
        resp.raise_for_status()
        text = resp.json().get("response", "").strip()
        # Strip thinking tags if present (qwen3 models)
        if "<think>" in text:
            import re
            text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
        return text


async def _evict_image_model():
    """Unload the image-api model from VRAM before LLM inference."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{IMAGE_GEN_URL}/health")
            data = resp.json()
            if data.get("model_loaded"):
                logger.info("Evicting image model from VRAM before LLM call")
                await client.post(f"{IMAGE_GEN_URL}/models/unload")
    except Exception as e:
        logger.debug(f"Image model eviction skipped: {e}")


async def _evict_music_model():
    """Unload the music-api model from VRAM before LLM inference."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{MUSIC_GEN_URL}/health")
            data = resp.json()
            if data.get("model_loaded"):
                logger.info("Evicting music model from VRAM before LLM call")
                await client.post(f"{MUSIC_GEN_URL}/models/unload")
    except Exception as e:
        logger.debug(f"Music model eviction skipped: {e}")


# --- Streaming chat generator ---
async def chat_stream(request: ChatRequest, user_id: str) -> AsyncGenerator[str, None]:
    model = request.model or LLM_MODEL
    threshold = request.threshold if request.threshold is not None else SIMILARITY_THRESHOLD
    top_k = max(1, request.top_k)
    collection_name = collection_name_for_user(user_id)

    # Step 1: Embed the query
    t_start = time.monotonic()
    documents, metadatas, distances = [], [], []
    relevant = []
    sources = []
    debug = {"best_distance": 2.0, "threshold": threshold, "chunks_retrieved": 0, "chunks_used": 0}
    # Timing keys: embed_ms=embed query, vault_ms=vault search, web_ms=web search, ttft_ms=time-to-first-token, total_ms=total wall-clock
    timings = {}

    yield sse({"type": "status", "step": "embed", "text": "Understanding your question…"})
    try:
        loop = asyncio.get_event_loop()
        query_embedding = await loop.run_in_executor(
            None, lambda: embed_texts([request.message], EMBED_MODEL, OLLAMA_BASE_URL)[0]
        )
    except Exception as e:
        yield sse({"type": "error", "text": f"Embedding failed: {e}"})
        return
    timings["embed_ms"] = round((time.monotonic() - t_start) * 1000)
    yield sse({"type": "status", "step": "embed", "text": "Question understood", "done": True})

    # Step 2: Smart vault search -semantic probe, full search only if relevant
    vault_collection = None
    try:
        chroma_client = get_chroma_client()
        vault_collection = chroma_client.get_collection(collection_name)
        vault_count = vault_collection.count()
    except Exception:
        vault_count = 0

    if vault_count > 0:
        # Quick probe: single nearest neighbor to check if anything is semantically close
        probe = vault_collection.query(query_embeddings=[query_embedding], n_results=1, include=["distances"])
        probe_dist = probe["distances"][0][0] if probe["distances"] and probe["distances"][0] else 2.0
        logger.info(f"Vault probe: '{request.message[:60]}' → best_dist={probe_dist:.3f}, threshold={threshold}")

        if probe_dist <= threshold:
            # Relevant content exists -do the full search
            t_vault = time.monotonic()
            yield sse({"type": "status", "step": "vault", "text": "Reading through your vault…"})
            try:
                results = vault_collection.query(
                    query_embeddings=[query_embedding],
                    n_results=top_k,
                    include=["documents", "metadatas", "distances"],
                )
                documents = results["documents"][0]
                metadatas = results["metadatas"][0]
                distances = results["distances"][0]
            except Exception as e:
                yield sse({"type": "error", "text": f"Vault search failed: {e}"})
                return

            timings["vault_ms"] = round((time.monotonic() - t_vault) * 1000)
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
        else:
            logger.info(f"Vault skipped -probe distance {probe_dist:.3f} > threshold {threshold}")

    # Step 3: Web search (optional) -skip if vault already has relevant results
    web_sources = []
    web_search_query = ""
    if request.web_search:
        # If the message is short/vague and we have conversation history, use LLM to build a proper search query
        raw_msg = request.message.strip()
        if len(raw_msg.split()) <= 5 and request.conversation_id:
            try:
                conv = db.get_conversation(request.conversation_id, user_id)
                if conv and conv["messages"]:
                    recent = conv["messages"][-6:]
                    history_text = "\n".join(f"{m['role'].upper()}: {m['content']}" for m in recent)
                    loc_ctx = ""
                    if request.user_context:
                        loc_match = re.search(r'Location:\s*(.+)', request.user_context)
                        if loc_match:
                            loc_ctx = f"\nUser location: {loc_match.group(1).strip()}"
                    rewrite_resp = httpx.post(
                        f"{OLLAMA_BASE_URL}/api/chat",
                        json={
                            "model": model,
                            "messages": [
                                {"role": "system", "content": "Given the conversation history and the user's latest message, generate a concise web search query that captures what the user actually wants to find. Output ONLY the search query, nothing else." + loc_ctx},
                                {"role": "user", "content": f"Conversation:\n{history_text}\n\nLatest message: {raw_msg}"},
                            ],
                            "options": {"temperature": 0.1, "num_predict": 40},
                            "think": False,
                            "stream": False,
                        },
                        timeout=15,
                    )
                    rewritten = rewrite_resp.json().get("message", {}).get("content", "").strip().strip('"\'')
                    if rewritten and len(rewritten) > len(raw_msg):
                        raw_msg = rewritten
                        logger.info(f"Rewrote vague search query: '{request.message}' -> '{raw_msg}'")
            except Exception as e:
                logger.warning(f"Search query rewrite failed: {e}")

        # Clean the query -extract site: hint and strip meta-instructions
        search_query = raw_msg.rstrip("?!")
        # Detect site hints like "search reddit - X", "search X on reddit", "find X on twitter"
        # Sites that work well with site: operator (scrapeable)
        SITE_OPERATOR_MAP = {
            "wikipedia": "site:wikipedia.org",
            "github": "site:github.com",
            "stackoverflow": "site:stackoverflow.com",
            "hn": "site:news.ycombinator.com",
            "hacker news": "site:news.ycombinator.com",
        }
        # Sites that block scrapers -append as keyword instead so Google finds their content via cache/previews
        SITE_KEYWORD_MAP = {
            "reddit": "reddit",
            "twitter": "twitter",
            "youtube": "youtube",
        }
        site_operator = ""
        site_keyword = ""
        for keyword, operator in SITE_OPERATOR_MAP.items():
            if re.search(rf'\b{re.escape(keyword)}\b', search_query, re.IGNORECASE):
                site_operator = operator
                break
        if not site_operator:
            for keyword, kw in SITE_KEYWORD_MAP.items():
                if re.search(rf'\b{re.escape(keyword)}\b', search_query, re.IGNORECASE):
                    site_keyword = kw
                    break
        # Strip meta-instructions (including site names)
        search_query = re.sub(r"^(search|look up|find|google|ask)\s+(reddit|twitter|youtube|wikipedia|github|stackoverflow|hacker news|hn|the web|online|google|bing)[\s\-:]+", "", search_query, flags=re.IGNORECASE).strip()
        search_query = re.sub(r"\s+on\s+(reddit|twitter|youtube|wikipedia|github|stackoverflow|hacker news)$", "", search_query, flags=re.IGNORECASE).strip()
        if site_operator and site_operator not in search_query:
            search_query = f"{search_query} {site_operator}"
        elif site_keyword and site_keyword.lower() not in search_query.lower():
            search_query = f"{search_query} {site_keyword}"
        # Append user location to search query if it seems location-relevant
        # and doesn't already mention a specific place
        if request.user_context:
            location_match = re.search(r'Location:\s*(.+)', request.user_context)
            if location_match:
                user_location = location_match.group(1).strip()
                location_keywords = ["weather", "near me", "nearby", "local", "restaurant", "store", "shop",
                                     "directions", "traffic", "events", "here", "around me", "close to me"]
                if any(kw in search_query.lower() for kw in location_keywords):
                    # Only add if the query doesn't already contain the location
                    if user_location.lower() not in search_query.lower():
                        search_query = f"{search_query} {user_location}"
        web_search_query = search_query
        yield sse({"type": "status", "step": "web", "text": f"Searching: {search_query}"})
        t_web = time.monotonic()
        web_sources = await web_search(search_query)
        timings["web_ms"] = round((time.monotonic() - t_web) * 1000)
        if web_sources:
            domains = ", ".join(r["url"].split("/")[2].lstrip("www.") for r in web_sources)
            suffix = f"→ {domains}"
        else:
            suffix = "no results found"
        yield sse({"type": "status", "step": "web", "text": f"Web search complete -{suffix}", "done": True})

    # Step 4: (fallthrough -always proceed to LLM)

    # Step 5: Build context
    context_parts = []
    if relevant:
        vault_context = "\n\n---\n\n".join(doc for doc, _ in relevant)
        context_parts.append(f"[VAULT CONTEXT]\n{vault_context}")
    if web_sources:
        web_context = "\n\n".join(
            f"Title: {r['title']}\nURL: {r['url']}\nContent: {r.get('content') or r.get('snippet', '')}"
            for r in web_sources
        )
        context_parts.append(f"[WEB SEARCH RESULTS]\n{web_context}")

    context_text = "\n\n" + "\n\n".join(context_parts)
    source_instruction = "Use the vault context as your primary source." if relevant and web_sources else ""

    # Build system prompt - topic override, memory, user profile
    now = datetime.now().astimezone()
    date_str = now.strftime("%A, %B %-d, %Y at %-I:%M %p %Z")
    base_instructions = request.default_prompt or "You are a personal AI assistant. When relevant context from the user's vault is provided, prioritize it in your answer. Otherwise, answer using your general knowledge."
    base_instructions += f"\n\nCurrent date and time: {date_str}"
    base_instructions += f"\n\nYou are running locally as {request.model} via Ollama on the user's own machine. You are NOT cloud-based and you are NOT a different model. Do not claim to be any other model or service."

    # Use topic system prompt if provided (overrides default)
    if request.topic_id:
        topic = db.get_topic(request.topic_id, user_id)
        if topic and topic.get("system_prompt") is not None and topic["system_prompt"] != "":
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

    web_hint = ""
    if not request.web_search:
        web_hint = "\n\nIMPORTANT: Web search is currently OFF. If the user's question requires real-time, current, or location-specific information (weather, news, prices, events, etc.) that you don't have, tell them to click the globe icon (next to the chat input) to enable web search so you can look it up. Do NOT fabricate URLs, links, or suggest visiting specific websites. Do NOT make up current data. Simply tell them to enable web search."

    web_instruction = ""
    if web_sources:
        has_real_content = any(len(r.get("content", "")) > 100 for r in web_sources)
        if has_real_content:
            web_instruction = "\n\nYou have been given real web page content in the [WEB SEARCH RESULTS] above. Answer the user's question using that content directly. Do NOT tell the user to visit a website. Do NOT say you lack real-time access. Summarize and report the actual information from the content."
        else:
            web_instruction = "\n\nWeb search was performed but the pages could not be fully retrieved (JavaScript-rendered or blocked). Summarize what you can from the snippets and titles. Do not tell the user to visit a website -tell them the pages weren't fully accessible and share what little was retrieved."

    # Memory tool instructions
    memory_instruction = ""
    if request.auto_memory:
        memory_instruction = """

MEMORY TOOL: You can save important facts about the user for future conversations.
When the user shares personal details, preferences, or information worth remembering, include this tag in your response:
[SAVE_MEMORY: the fact to remember]
Examples: [SAVE_MEMORY: User's dog is named Max] or [SAVE_MEMORY: User prefers Python over JavaScript]
Only save durable, useful facts. Do not save trivial or temporary information.
Do not mention the SAVE_MEMORY tag to the user. Just naturally confirm you'll remember it.
To remove an outdated fact, use: [DELETE_MEMORY: the outdated fact]"""
    else:
        memory_instruction = """

MEMORY TOOL: You can save facts about the user when they explicitly ask you to remember something.
When the user says "remember that...", "save this...", "don't forget...", or similar, include this tag in your response:
[SAVE_MEMORY: the fact to remember]
Only use this when the user explicitly asks you to remember something.
Do not mention the SAVE_MEMORY tag to the user. Just naturally confirm you'll remember it.
To remove an outdated fact when asked, use: [DELETE_MEMORY: the outdated fact]"""

    system_prompt = f"""{base_instructions}{memory_section}{user_section}{' ' + source_instruction if source_instruction else ''}{context_block}{web_instruction}{web_hint}{memory_instruction}

Answer concisely."""

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
                    logger.info(f"Context at {pct:.1f}% -auto-compacting conversation {request.conversation_id}")
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
    user_msg = {"role": "user", "content": request.message}
    if request.images:
        user_msg["images"] = request.images
    messages.append(user_msg)

    logger.info(f"Sending {len(relevant)} vault chunks + {len(web_sources)} web results to LLM ({len(context_text)} chars), {len(messages)} messages in history, {len(request.images)} images")

    # Step 6: Check if model is loaded, show loading indicator if not
    try:
        async with httpx.AsyncClient(timeout=5) as hc:
            ps_resp = await hc.get(f"{OLLAMA_BASE_URL}/api/ps")
            loaded_models = [m.get("name", "") for m in ps_resp.json().get("models", [])]
            model_loaded = any(model in m or m in model for m in loaded_models)
            if not model_loaded:
                yield sse({"type": "status", "step": "loading_model", "text": "Loading language model…"})
    except Exception:
        pass

    # Stream LLM response
    ctx_kb = round(len(context_text) / 1024, 1)
    llm_status = f"Thinking through {ctx_kb} KB of context…" if ctx_kb > 0 else "Thinking…"
    yield sse({"type": "status", "step": "llm", "text": llm_status})

    full_answer = ""
    t_llm_start = time.monotonic()
    ttft_ms = None
    try:
        async with httpx.AsyncClient(timeout=None) as hc:
            async with hc.stream(
                "POST",
                f"{OLLAMA_BASE_URL}/api/chat",
                json={
                    "model": model,
                    "messages": messages,
                    "options": {"temperature": request.temperature},
                    "stream": True,
                },
            ) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    raise Exception(f"Ollama returned {resp.status_code}: {body.decode()}")
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    chunk = json.loads(line)
                    token = chunk.get("message", {}).get("content", "")
                    if token:
                        if ttft_ms is None:
                            ttft_ms = round((time.monotonic() - t_llm_start) * 1000)
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

    # Step 7: Extract and process memory tool calls
    saved_memories = []
    deleted_memories = []
    clean_answer = full_answer

    # Extract [SAVE_MEMORY: ...] tags
    save_pattern = re.compile(r'\[SAVE_MEMORY:\s*(.+?)\]', re.IGNORECASE)
    for match in save_pattern.finditer(full_answer):
        fact = match.group(1).strip()
        if fact:
            try:
                mid = db.add_memory_fact(fact, user_id)
                saved_memories.append({"id": mid, "fact": fact})
                logger.info(f"Memory saved for {user_id}: {fact}")
            except Exception as e:
                logger.warning(f"Failed to save memory: {e}")
    clean_answer = save_pattern.sub("", clean_answer)

    # Extract [DELETE_MEMORY: ...] tags
    delete_pattern = re.compile(r'\[DELETE_MEMORY:\s*(.+?)\]', re.IGNORECASE)
    for match in delete_pattern.finditer(full_answer):
        fact_text = match.group(1).strip()
        if fact_text:
            # Find matching fact by text similarity
            existing = db.list_memory(user_id)
            for m in existing:
                if fact_text.lower() in m["fact"].lower() or m["fact"].lower() in fact_text.lower():
                    db.delete_memory_fact(m["id"], user_id)
                    deleted_memories.append({"id": m["id"], "fact": m["fact"]})
                    logger.info(f"Memory deleted for {user_id}: {m['fact']}")
                    break
    clean_answer = delete_pattern.sub("", clean_answer)

    # Clean up any leftover whitespace from tag removal
    clean_answer = re.sub(r'\n{3,}', '\n\n', clean_answer).strip()

    # Notify frontend of memory changes
    if saved_memories:
        yield sse({"type": "memory_saved", "facts": saved_memories})
    if deleted_memories:
        yield sse({"type": "memory_deleted", "facts": deleted_memories})

    # Step 8: Save to DB
    conv_id = request.conversation_id
    if not conv_id:
        conv_id = db.create_conversation(user_id=user_id, topic_id=request.topic_id)
    db.auto_title(conv_id, user_id, request.message)
    db.add_message(conv_id, "user", request.message)
    db.add_message(conv_id, "assistant", clean_answer, sources=sources, web_sources=web_sources, model_used=model)

    timings["ttft_ms"] = ttft_ms
    timings["total_ms"] = round((time.monotonic() - t_start) * 1000)
    yield sse({
        "type": "done",
        "answer": clean_answer,
        "from_vault": bool(relevant),
        "sources": sources,
        "web_sources": web_sources,
        "web_search_query": web_search_query,
        "model_used": model,
        "conversation_id": conv_id,
        "debug": {**debug, "timings": timings},
    })


# --- Endpoints ---

@app.get("/health")
async def health():
    services = {}
    async with httpx.AsyncClient(timeout=2) as client:
        for name, url in [
            ("ollama", f"{OLLAMA_BASE_URL}/api/tags"),
            ("chromadb", f"http://{os.environ.get('CHROMA_HOST','chromadb')}:{os.environ.get('CHROMA_PORT_INTERNAL','8000')}/api/v2/heartbeat"),
            ("kokoro", f"{os.environ.get('KOKORO_URL','http://kokoro:8880')}/health"),
            ("image-api", f"{IMAGE_GEN_URL}/health"),
        ]:
            try:
                r = await client.get(url)
                services[name] = r.status_code < 400
            except Exception:
                services[name] = False
    return {"status": "ok", "services": services}


def _get_docker_client():
    import docker
    return docker.from_env()


@app.get("/containers")
def list_containers(user: dict = Depends(get_current_user)):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    try:
        from datetime import timezone
        dc = _get_docker_client()
        result = []
        for c in dc.containers.list(all=True):
            started = c.attrs.get("State", {}).get("StartedAt", "")
            uptime = None
            cpu_pct = None
            if c.status == "running":
                if started:
                    started_dt = datetime.fromisoformat(started.replace("Z", "+00:00").split(".")[0] + "+00:00")
                    delta = datetime.now(timezone.utc) - started_dt
                    total = int(delta.total_seconds())
                    h, rem = divmod(total, 3600)
                    m, s = divmod(rem, 60)
                    uptime = f"{h}h {m}m" if h else f"{m}m {s}s"
                try:
                    stats = c.stats(stream=False)
                    cpu_delta = stats["cpu_stats"]["cpu_usage"]["total_usage"] - stats["precpu_stats"]["cpu_usage"]["total_usage"]
                    sys_delta = stats["cpu_stats"]["system_cpu_usage"] - stats["precpu_stats"]["system_cpu_usage"]
                    cpus = stats["cpu_stats"].get("online_cpus", 1)
                    cpu_pct = round((cpu_delta / sys_delta) * cpus * 100, 1) if sys_delta > 0 else 0.0
                except Exception:
                    pass
            result.append({
                "name": c.name,
                "status": c.status,
                "uptime": uptime,
                "cpu": cpu_pct,
            })
        result.sort(key=lambda x: x["name"])
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/apis")
async def list_apis(user: dict = Depends(get_current_user)):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    result = []
    # Tavily
    tavily_ok = False
    if TAVILY_API_KEY:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                r = await client.get("https://api.tavily.com", headers={"Authorization": f"Bearer {TAVILY_API_KEY}"})
                tavily_ok = r.status_code < 500
        except Exception:
            tavily_ok = False
    result.append({"name": "Tavily", "configured": bool(TAVILY_API_KEY), "online": tavily_ok})
    return result


@app.post("/containers/{name}/restart")
def restart_container(name: str, user: dict = Depends(get_current_user)):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    try:
        dc = _get_docker_client()
        c = dc.containers.get(name)
        c.restart()
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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


@app.get("/models/ps")
async def models_ps(user: dict = Depends(get_current_user)):
    """Return models currently loaded in VRAM (Ollama + image-api)."""
    loaded = []
    # Ollama models
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{OLLAMA_BASE_URL}/api/ps")
            for m in resp.json().get("models", []):
                name = m.get("name", "")
                size = m.get("size_vram", m.get("size", 0))
                loaded.append({"name": name, "type": "llm", "vram_mb": round(size / 1024 / 1024)})
    except Exception:
        pass
    # Image model
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{IMAGE_GEN_URL}/health")
            data = resp.json()
            if data.get("model_loaded") and data.get("current_model"):
                loaded.append({"name": data["current_model"], "type": "image", "vram_mb": data.get("vram_mb", 0)})
    except Exception:
        pass
    # Music model
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{MUSIC_GEN_URL}/health")
            data = resp.json()
            if data.get("model_loaded") and data.get("current_model"):
                loaded.append({"name": data["current_model"], "type": "music", "vram_mb": data.get("vram_mb", 0)})
    except Exception:
        pass
    return {"loaded": loaded}


@app.post("/models/warmup")
async def models_warmup(request: Request, user: dict = Depends(get_current_user)):
    """Preload an LLM into VRAM. Evicts image model and other LLMs first."""
    global _image_gen_active, _music_gen_active
    model = LLM_MODEL
    try:
        body = await request.json()
        if body.get("model"):
            model = body["model"]
    except Exception:
        pass
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            # Evict image and music models
            try:
                await client.post(f"{IMAGE_GEN_URL}/models/unload")
            except Exception:
                pass
            try:
                await client.post(f"{MUSIC_GEN_URL}/models/unload")
            except Exception:
                pass
            _image_gen_active = False
            _music_gen_active = False

            # Evict any currently loaded Ollama models that aren't the target or utility model
            try:
                ps = await client.get(f"{OLLAMA_BASE_URL}/api/ps")
                for m in ps.json().get("models", []):
                    mname = m.get("name", "")
                    if mname and mname != model and not _is_utility_model(mname):
                        try:
                            await client.post(
                                f"{OLLAMA_BASE_URL}/api/generate",
                                json={"model": mname, "prompt": "", "keep_alive": 0, "stream": False},
                            )
                        except Exception:
                            pass
            except Exception:
                pass

        # Send a minimal request to Ollama to preload the model
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f"{OLLAMA_BASE_URL}/api/chat",
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": "hi"}],
                    "options": {"num_predict": 1},
                    "keep_alive": "5m",
                    "stream": False,
                },
            )
            return {"ok": True, "model": model}
    except Exception as e:
        logger.warning(f"Warmup failed: {e}")
        return {"ok": False, "error": str(e)}


def _is_utility_model(model_name: str) -> bool:
    """Check if a model name matches the utility model (should never be evicted)."""
    util = UTILITY_MODEL.split(":")[0].lower()
    name = model_name.split(":")[0].lower()
    return name == util


async def _evict_ollama_models(keep_utility: bool = True) -> list[str]:
    """Evict Ollama LLMs from VRAM, optionally keeping the utility model."""
    evicted = []
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            ps = await client.get(f"{OLLAMA_BASE_URL}/api/ps")
            loaded = [m["name"] for m in ps.json().get("models", [])]
            for model_name in loaded:
                if keep_utility and _is_utility_model(model_name):
                    continue
                try:
                    await client.post(
                        f"{OLLAMA_BASE_URL}/api/generate",
                        json={"model": model_name, "prompt": "", "keep_alive": 0, "stream": False},
                    )
                    evicted.append(model_name)
                except Exception:
                    pass
    except Exception as e:
        logger.warning(f"Ollama evict failed: {e}")
    return evicted


@app.post("/models/prepare-studio")
async def prepare_studio(request: Request, user: dict = Depends(get_current_user)):
    """Preload the image model, evicting other models only if needed."""
    target_model = None
    try:
        body = await request.json()
        target_model = body.get("model")
    except Exception:
        pass

    # Check if image model is already loaded — skip everything if so
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            health = await client.get(f"{IMAGE_GEN_URL}/health")
            hdata = health.json()
            if hdata.get("model_loaded") and (not target_model or hdata.get("current_model") == target_model):
                return {"ok": True, "evicted": [], "image_model": hdata.get("current_model"), "skipped": True}
    except Exception:
        pass

    # Image model not loaded — evict to free VRAM
    evicted = await _evict_ollama_models()

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(f"{MUSIC_GEN_URL}/models/unload")
    except Exception:
        pass

    # Load the image model
    loaded_model = None
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            if not target_model:
                models_resp = await client.get(f"{IMAGE_GEN_URL}/models")
                mdata = models_resp.json()
                target_model = mdata.get("current") or (mdata.get("models", [{}])[0].get("id") if mdata.get("models") else None)
            if target_model:
                resp = await client.post(f"{IMAGE_GEN_URL}/models/load", json={"model": target_model})
                if resp.status_code == 200:
                    loaded_model = target_model
    except Exception as e:
        logger.warning(f"prepare-studio image load failed: {e}")

    return {"ok": True, "evicted": evicted, "image_model": loaded_model}


@app.post("/models/prepare-music-studio")
async def prepare_music_studio(request: Request, user: dict = Depends(get_current_user)):
    """Preload the music model, evicting other models only if needed."""
    # Check if music model is already loaded — skip everything if so
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            health = await client.get(f"{MUSIC_GEN_URL}/health")
            hdata = health.json()
            if hdata.get("model_loaded"):
                return {"ok": True, "evicted": [], "music_ready": True, "skipped": True}
    except Exception:
        pass

    # Music model not loaded — evict to free VRAM
    evicted = await _evict_ollama_models()

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(f"{IMAGE_GEN_URL}/models/unload")
    except Exception:
        pass

    # Load music model
    music_ready = False
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            resp = await client.post(f"{MUSIC_GEN_URL}/models/load")
            data = resp.json()
            music_ready = data.get("ok", False)
    except Exception as e:
        logger.warning(f"prepare-music-studio load failed: {e}")

    return {"ok": True, "evicted": evicted, "music_ready": music_ready}


@app.get("/models/info")
async def model_info(model: str = None, user: dict = Depends(get_current_user)):
    """Check model capabilities like vision support."""
    use_model = model or LLM_MODEL
    vision = False
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.post(f"{OLLAMA_BASE_URL}/api/show", json={"model": use_model})
            data = r.json()
            # Check model families or projector architecture for vision
            families = []
            info = data.get("model_info", {})
            for key, val in info.items():
                if "families" in key.lower() and isinstance(val, list):
                    families.extend(val)
            template = data.get("template", "")
            # Vision models typically have "clip" projector or vision family
            if any("clip" in str(v).lower() for v in info.values()):
                vision = True
            if any(f in families for f in ["clip", "mllama"]):
                vision = True
            # Check for projector-related keys (vision models have these)
            if any("projector" in key.lower() or "vision" in key.lower() for key in info.keys()):
                vision = True
    except Exception as e:
        logger.warning(f"Could not check model info for {use_model}: {e}")
    return {"model": use_model, "vision": vision}


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
    if _image_gen_active or _music_gen_active:
        raise HTTPException(status_code=503, detail="GPU is busy, please wait")
    if not request.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    await _evict_image_model()
    await _evict_music_model()
    return StreamingResponse(
        chat_stream(request, user["id"]),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class ExtractMemoryRequest(BaseModel):
    text: str  # The AI message text to extract a memory from

@app.post("/chat/extract-memory")
async def extract_memory(request: ExtractMemoryRequest, user: dict = Depends(get_current_user)):
    """Use the LLM to extract a memory-worthy fact from an AI response, then save it."""
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    model = LLM_MODEL
    try:
        resp = httpx.post(
            f"{OLLAMA_BASE_URL}/api/chat",
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": "Extract the single most important, memorable fact or takeaway from the following AI response. Output ONLY the fact as a short sentence. If there is nothing worth remembering, respond with exactly: NOTHING"},
                    {"role": "user", "content": request.text},
                ],
                "options": {"temperature": 0.1, "num_predict": 100},
                "think": False,
                "stream": False,
            },
            timeout=30,
        )
        fact = resp.json().get("message", {}).get("content", "").strip()
        if not fact or fact.upper() == "NOTHING":
            return {"saved": False, "reason": "Nothing worth remembering in this message."}

        mid = db.add_memory_fact(fact, user["id"])
        return {"saved": True, "id": mid, "fact": fact}
    except Exception as e:
        logger.error(f"Extract memory failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/index", response_model=IndexResponse)
async def trigger_reindex(user: dict = Depends(get_current_user)):
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, index_vault, VAULT_PATH, user["id"], EMBED_MODEL, OLLAMA_BASE_URL)
    return IndexResponse(**result)


@app.get("/index/status")
async def index_status(user: dict = Depends(get_current_user)):
    return _get_index_status(user["id"])


@app.get("/index/stream")
async def stream_reindex(user: dict = Depends(get_current_user)):
    """SSE endpoint that streams per-file progress during indexing."""
    import queue as queue_mod
    q: queue_mod.Queue = queue_mod.Queue()

    def progress_cb(done: int, total: int, filename: str):
        q.put({"done": done, "total": total, "file": filename})

    def run():
        try:
            result = index_vault(VAULT_PATH, user["id"], EMBED_MODEL, OLLAMA_BASE_URL, progress_cb=progress_cb, username=user["username"])
            q.put({"complete": True,
                   "new": result["files_processed"],
                   "skipped": result.get("files_skipped", 0),
                   "chunks": result["chunks_upserted"],
                   "errors": result["errors"]})
        except Exception as e:
            q.put({"error": str(e)})

    import threading
    threading.Thread(target=run, daemon=True).start()

    async def event_stream():
        loop = asyncio.get_event_loop()
        while True:
            try:
                msg = await loop.run_in_executor(None, lambda: q.get(timeout=120))
                yield f"data: {json.dumps(msg)}\n\n"
                if msg.get("complete") or msg.get("error"):
                    break
            except Exception:
                break

    return StreamingResponse(event_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/suggestions")
async def get_suggestions(model: str = None, user: dict = Depends(get_current_user)):
    if _image_gen_active or _music_gen_active:
        return {"suggestions": []}
    use_model = model or LLM_MODEL
    user_id = user["id"]
    collection_name = f"vault_{user_id.replace('-', '')}"

    # Sample actual content from the vault's ChromaDB collection
    sample_text = ""
    try:
        chroma_client = get_chroma_client()
        collection = chroma_client.get_collection(collection_name)
        count = collection.count()
        if count == 0:
            return {"suggestions": []}
        import random
        sample_ids = random.sample(range(count), min(10, count))
        result = collection.get(
            include=["documents", "metadatas"],
            limit=min(10, count),
        )
        docs = result.get("documents", [])
        metas = result.get("metadatas", [])
        snippets = []
        for doc, meta in zip(docs, metas):
            source = meta.get("source", "unknown") if meta else "unknown"
            snippet = doc[:300] if doc else ""
            if snippet:
                snippets.append(f"[From: {source}]\n{snippet}")
        sample_text = "\n\n".join(snippets[:8])
    except Exception as e:
        logger.warning(f"suggestions: failed to sample vault: {e}")
        return {"suggestions": []}

    if not sample_text:
        return {"suggestions": []}

    prompt = (
        f"Here are excerpts from a user's personal document vault:\n\n{sample_text}\n\n"
        "Based on this content, write exactly 4 specific, interesting questions the user might want to ask about their documents. "
        "The questions should be practical and specific to the actual content -not generic questions about the files themselves. "
        "Rules: each question on its own line, ends with ?, under 70 chars, no numbering, no bullets, no explanations."
    )
    try:
        import re as _re
        ollama_resp = httpx.post(
            f"{OLLAMA_BASE_URL}/api/chat",
            json={
                "model": use_model,
                "messages": [
                    {"role": "system", "content": "/no_think\nYou output ONLY what is asked. No reasoning. No preamble."},
                    {"role": "user", "content": prompt},
                    {"role": "assistant", "content": "<think>\n\n</think>\n1."},
                ],
                "options": {"temperature": 0.8, "num_predict": 500},
                "think": False,
                "stream": False,
            },
            timeout=60,
        )
        ollama_resp.raise_for_status()
        data = ollama_resp.json()
        raw = data.get("message", {}).get("content", "")
        logger.info(f"suggestions raw response: {raw[:800]}")
        # Strip think blocks and any trailing thinking text before actual output
        cleaned = _re.sub(r"<think>[\s\S]*?</think>", "", raw, flags=_re.IGNORECASE).strip()
        # If the entire response looks like reasoning (no question marks), bail early
        if "?" not in cleaned:
            raise ValueError(f"no questions in response: {cleaned[:200]}")
        lines = [line.strip().lstrip("-•*0123456789.) ") for line in cleaned.splitlines() if line.strip()]
        suggestions = [s for s in lines if "?" in s and len(s) > 10 and len(s) < 120][:4]
        # Ensure they end with ?
        suggestions = [s if s.endswith("?") else s.split("?")[0] + "?" for s in suggestions]
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


@app.get("/auth/brand")
def auth_brand():
    """Public endpoint -returns admin's brand settings for the login screen."""
    for user in db.list_users():
        if user.get("role") == "admin":
            try:
                s = json.loads(user.get("settings") or "{}")
                b = json.loads(s.get("diab_brand") or "{}")
                return {
                    "name":            b.get("name", ""),
                    "logo":            s.get("diab_logo", ""),
                    "login_logo":      s.get("diab_login_logo", ""),
                    "theme":           b.get("theme", ""),
                    "accent":          b.get("accent", ""),
                    "show_login_name": b.get("showLoginName", True),
                }
            except Exception:
                break
    return {"name": "", "logo": "", "theme": "", "accent": ""}


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


@app.delete("/users/me/data")
def delete_own_data(user: dict = Depends(get_current_user)):
    """Delete all conversations, topics, and memory for the current user (keeps account)."""
    db.delete_all_user_data(user["id"])
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


# --- Image generation ---

class ImageGenerateRequest(BaseModel):
    prompt: str
    negative_prompt: Optional[str] = None
    aspect: str = "square"   # square | landscape | portrait
    width: Optional[int] = None
    height: Optional[int] = None
    steps: Optional[int] = None
    seed: Optional[int] = None
    guidance_scale: Optional[float] = None
    model: Optional[str] = None


class ImageLoadModelRequest(BaseModel):
    model: str


class ImageUpscaleRequest(BaseModel):
    image: str  # base64-encoded PNG
    scale: int = 2  # 2 or 4


class ImageInpaintRequest(BaseModel):
    image: str       # base64 PNG -source image
    mask: str        # base64 PNG -white=inpaint, black=keep
    prompt: str
    negative_prompt: Optional[str] = None
    steps: Optional[int] = None
    seed: Optional[int] = None
    guidance_scale: Optional[float] = None
    strength: Optional[float] = None


@app.get("/image/inspire")
async def image_inspire(user: dict = Depends(get_current_user)):
    """Ask the utility LLM to generate a creative image prompt idea."""
    system = (
        "You are a creative director who generates vivid, detailed text-to-image prompts. "
        "Generate exactly ONE unique, imaginative prompt for an AI image generator. "
        "Be specific about subject, setting, lighting, mood, and composition. "
        "Vary widely between styles: landscapes, portraits, fantasy, sci-fi, nature, architecture, abstract, etc. "
        "Output ONLY the prompt text, nothing else -no quotes, no explanation, no numbering."
    )
    try:
        text = await _utility_llm(system, "Give me a fresh, creative image generation prompt.", temperature=1.2, num_predict=150, user=user)
        return {"prompt": text.strip('"').strip("'")}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not generate idea: {e}")


@app.get("/image/models")
async def image_models_proxy(user: dict = Depends(get_current_user)):
    """Proxy to image-api /models -returns available image generation models."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{IMAGE_GEN_URL}/models")
            return resp.json()
    except Exception:
        return {"models": [], "current": None}


@app.post("/image/models/load")
async def image_load_model_proxy(req: ImageLoadModelRequest, user: dict = Depends(get_current_user)):
    """Proxy to image-api /models/load -switch image generation model."""
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(f"{IMAGE_GEN_URL}/models/load", json={"model": req.model})
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPStatusError as e:
        detail = e.response.json().get("detail", str(e)) if e.response.content else str(e)
        raise HTTPException(status_code=e.response.status_code, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load model: {e}")


@app.get("/image/progress")
async def image_progress_proxy(user: dict = Depends(get_current_user)):
    """Proxy to image-api /progress for live step polling during generation."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{IMAGE_GEN_URL}/progress")
            return resp.json()
    except Exception:
        return {"running": False, "step": 0, "total_steps": 0, "elapsed_s": 0.0}


@app.post("/image/generate")
async def image_generate_proxy(req: ImageGenerateRequest, user: dict = Depends(get_current_user)):
    """Proxy to image-api (FLUX.1-schnell). Sets guard flag to block Ollama calls during generation."""
    global _image_gen_active
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required")

    _image_gen_active = True
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            resp = await client.post(
                f"{IMAGE_GEN_URL}/generate",
                json={
                    "prompt": req.prompt, "negative_prompt": req.negative_prompt,
                    "aspect": req.aspect, "width": req.width, "height": req.height,
                    "steps": req.steps, "seed": req.seed,
                    "guidance_scale": req.guidance_scale, "model": req.model,
                },
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Image generation service is not available")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Image generation timed out")
    except httpx.HTTPStatusError as e:
        detail = e.response.json().get("detail", str(e)) if e.response.content else str(e)
        raise HTTPException(status_code=e.response.status_code, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Image generation failed: {e}")
    finally:
        _image_gen_active = False


@app.post("/image/upscale")
async def image_upscale_proxy(req: ImageUpscaleRequest, user: dict = Depends(get_current_user)):
    """Proxy to image-api /upscale for Real-ESRGAN upscaling."""
    global _image_gen_active
    if not req.image:
        raise HTTPException(status_code=400, detail="image is required")

    _image_gen_active = True
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            resp = await client.post(
                f"{IMAGE_GEN_URL}/upscale",
                json={"image": req.image, "scale": req.scale},
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Image service is not available")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Upscaling timed out")
    except httpx.HTTPStatusError as e:
        detail = e.response.json().get("detail", str(e)) if e.response.content else str(e)
        raise HTTPException(status_code=e.response.status_code, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upscaling failed: {e}")
    finally:
        _image_gen_active = False


@app.post("/image/inpaint")
async def image_inpaint_proxy(req: ImageInpaintRequest, user: dict = Depends(get_current_user)):
    """Proxy to image-api /inpaint for masked image editing."""
    global _image_gen_active
    if not req.image or not req.mask:
        raise HTTPException(status_code=400, detail="image and mask are required")
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required")

    _image_gen_active = True
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            resp = await client.post(
                f"{IMAGE_GEN_URL}/inpaint",
                json={
                    "image": req.image,
                    "mask": req.mask,
                    "prompt": req.prompt,
                    "negative_prompt": req.negative_prompt,
                    "steps": req.steps,
                    "seed": req.seed,
                    "guidance_scale": req.guidance_scale,
                },
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Image service is not available")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Inpainting timed out")
    except httpx.HTTPStatusError as e:
        detail = e.response.json().get("detail", str(e)) if e.response.content else str(e)
        raise HTTPException(status_code=e.response.status_code, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Inpainting failed: {e}")
    finally:
        _image_gen_active = False


class SessionNameRequest(BaseModel):
    prompt: str


@app.post("/image/name-session")
async def image_name_session(req: SessionNameRequest, user: dict = Depends(get_current_user)):
    """Generate a concise session name from an image prompt using the utility LLM."""
    if not req.prompt.strip():
        return {"name": ""}
    try:
        name = await _utility_llm(
            "Generate a short, descriptive title (3-6 words) for an image generation session based on the prompt. "
            "Capture the main subject and mood. "
            "Output ONLY the title text, no quotes, no explanation.",
            req.prompt[:200], temperature=0.5, num_predict=15, user=user,
        )
        name = name.strip('"').strip("'").split("\n")[0].strip().title()[:60]
        return {"name": name}
    except Exception as e:
        logger.warning(f"Image session naming failed: {e}")
        return {"name": ""}


# --- Music generation proxy ---

@app.get("/music/inspire")
async def music_inspire(user: dict = Depends(get_current_user)):
    """Ask the utility LLM to generate a creative music prompt idea."""
    system = (
        "You are a music producer who generates creative text-to-music prompts for an AI music generator. "
        "Generate exactly ONE unique, vivid music prompt describing genre, mood, instruments, tempo feel, and vibe. "
        "Vary widely between styles: pop, rock, jazz, electronic, classical, hip-hop, folk, ambient, metal, world, funk, cinematic, etc. "
        "Output ONLY the prompt text, nothing else -no quotes, no explanation, no numbering. Keep it to 1-2 sentences."
    )
    try:
        text = await _utility_llm(system, "Give me a fresh, creative music generation prompt.", temperature=1.2, num_predict=100, user=user)
        return {"prompt": text.strip('"').strip("'")}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not generate idea: {e}")


class SongNameRequest(BaseModel):
    prompt: str
    lyrics: Optional[str] = None


@app.post("/music/name-song")
async def name_song(req: SongNameRequest, user: dict = Depends(get_current_user)):
    """Ask the utility LLM to generate a creative song title."""
    try:
        context = f"Style: {req.prompt}"
        if req.lyrics:
            context += f"\n\nLyrics:\n{req.lyrics[:500]}"
        title = await _utility_llm(
            "You are a creative music producer. Given a song's style description and optional lyrics, "
            "generate exactly ONE short, catchy song title (1-5 words). "
            "Be creative and evocative. Output ONLY the title -no quotes, no explanation, no punctuation except what's part of the title.",
            context, temperature=1.0, num_predict=20, user=user,
        )
        title = title.strip('"').strip("'").split("\n")[0].strip().title()
        return {"title": title}
    except Exception as e:
        return {"title": ""}


class CoverArtRequest(BaseModel):
    prompt: str
    title: Optional[str] = None
    lyrics: Optional[str] = None


@app.post("/music/cover-art")
async def music_cover_art(req: CoverArtRequest, user: dict = Depends(get_current_user)):
    """Generate album cover art for a song using SDXL Turbo via image-api.

    Flow: LLM generates an image prompt from the song context, then image-api
    renders a 512x512 cover image with SDXL Turbo (fast, low VRAM).
    """
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required")

    # Step 1: Generate an image prompt using the utility LLM
    image_prompt = None
    try:
        context = f"Song style: {req.prompt}"
        if req.title:
            context = f"Song title: {req.title}\n{context}"
        if req.lyrics:
            context += f"\nLyrics excerpt: {req.lyrics[:300]}"

        raw = await _utility_llm(
            system=(
                "You are an album cover art director. Given a song description, generate a short visual prompt "
                "for an album cover image. Describe the mood, colors, composition, and artistic style. "
                "Think abstract, artistic, and evocative. Do NOT include text or words in the image. "
                "Output ONLY the image prompt, 1-2 sentences, no quotes or explanation."
            ),
            prompt=context,
            temperature=0.9,
            num_predict=80,
            user=user,
        )
        image_prompt = raw.strip('"').strip("'").strip().split("\n")[0].strip()
    except Exception as e:
        logger.warning(f"Cover art prompt generation failed: {e}")

    if not image_prompt:
        # Fallback: derive a simple prompt from the song style
        image_prompt = f"Abstract album cover art, {req.prompt[:100]}, artistic, vibrant colors, no text"

    # Step 2: Generate the image via image-api with SDXL Turbo
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f"{IMAGE_GEN_URL}/generate",
                json={
                    "prompt": image_prompt,
                    "model": "sdxl-turbo",
                    "aspect": "square",
                    "steps": 4,
                    "guidance_scale": 0.0,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            return {
                "image": data.get("image"),
                "prompt": image_prompt,
                "width": data.get("width", 512),
                "height": data.get("height", 512),
            }
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Image generation service is not available")
    except Exception as e:
        logger.warning(f"Cover art image generation failed: {e}")
        raise HTTPException(status_code=500, detail=f"Cover art generation failed: {e}")


class SongWriteRequest(BaseModel):
    description: str
    language: Optional[str] = "en"
    model: Optional[str] = None


@app.post("/music/write-song")
async def write_song(req: SongWriteRequest, user: dict = Depends(get_current_user)):
    """Use the LLM to generate a music style prompt and full lyrics from a brief description."""
    if not req.description.strip():
        raise HTTPException(status_code=400, detail="description is required")

    system_prompt = """You are a professional songwriter and music producer. Given a brief description, generate:
1. A concise music STYLE prompt (genre, mood, instruments, tempo feel) -this describes the sound, NOT the lyrics
2. Full structured LYRICS with section tags like [verse], [chorus], [bridge], [outro]

Rules:
- The style prompt should be 1-2 sentences describing genre, mood, instruments, and vibe
- Lyrics should have at least 2 verses and a chorus
- Use [verse], [chorus], [bridge], [pre-chorus], [outro] tags on their own lines
- Write natural, singable lyrics that match the described mood
- Keep lyrics concise -each section should be 2-4 lines
- Do NOT include any explanation, just the output

Respond in EXACTLY this format:
STYLE: <style prompt here>

LYRICS:
<full lyrics here>"""

    user_msg = req.description.strip()
    if req.language and req.language != "en":
        user_msg += f"\n\nWrite the lyrics in language code: {req.language}"

    # Unload image model to free VRAM for the songwriting LLM (keep ace-step for music gen)
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(f"{IMAGE_GEN_URL}/models/unload")
    except Exception:
        pass

    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            resp = await client.post(
                f"{OLLAMA_BASE_URL}/api/chat",
                json={
                    "model": req.model or LLM_MODEL,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_msg},
                    ],
                    "stream": False,
                    "options": {"temperature": 0.9, "num_predict": 1024},
                },
            )
            resp.raise_for_status()
            content = resp.json().get("message", {}).get("content", "")
            if "<think>" in content:
                import re
                content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()

        # Parse STYLE: and LYRICS: sections
        style = ""
        lyrics = ""
        if "STYLE:" in content and "LYRICS:" in content:
            parts = content.split("LYRICS:", 1)
            style = parts[0].replace("STYLE:", "").strip()
            lyrics = parts[1].strip()
        elif "LYRICS:" in content:
            lyrics = content.split("LYRICS:", 1)[1].strip()
            style = req.description
        else:
            # Fallback: treat entire response as lyrics
            style = req.description
            lyrics = content.strip()

        return {"ok": True, "style": style, "lyrics": lyrics}
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="LLM service is not available")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Song writing failed: {e}")


class MusicGenerateRequest(BaseModel):
    prompt: str
    lyrics: Optional[str] = None
    duration: Optional[float] = 30.0
    infer_steps: Optional[int] = 20
    guidance_scale: Optional[float] = 7.0
    seed: Optional[int] = None
    instrumental: Optional[bool] = False
    vocal_language: Optional[str] = None
    bpm: Optional[int] = None


@app.get("/music/health")
async def music_health(user: dict = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{MUSIC_GEN_URL}/health")
            return resp.json()
    except Exception:
        return {"ok": False, "model_loaded": False}


@app.get("/music/progress")
async def music_progress(user: dict = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{MUSIC_GEN_URL}/progress")
            return resp.json()
    except Exception:
        return {"running": False, "step": 0, "total_steps": 0, "elapsed_s": 0.0}


@app.post("/music/generate")
async def music_generate_proxy(req: MusicGenerateRequest, user: dict = Depends(get_current_user)):
    """Proxy to music-api for text-to-music generation."""
    global _music_gen_active
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required")

    _music_gen_active = True
    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            resp = await client.post(
                f"{MUSIC_GEN_URL}/generate",
                json=req.model_dump(exclude_none=True),
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Music generation service is not available")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Music generation timed out")
    except httpx.HTTPStatusError as e:
        detail = e.response.json().get("detail", str(e)) if e.response.content else str(e)
        raise HTTPException(status_code=e.response.status_code, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Music generation failed: {e}")
    finally:
        _music_gen_active = False


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


@app.post("/conversations/{cid}/smart-title")
async def smart_title_conv(cid: str, user: dict = Depends(get_current_user)):
    """Generate a concise LLM-based title for a conversation from its first messages."""
    conv = db.get_conversation(cid, user["id"])
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # Gather first few messages for context
    msgs = conv.get("messages", [])
    context_parts = []
    for m in msgs[:4]:
        role = m.get("role", "user")
        content = m.get("content", "")[:300]
        context_parts.append(f"{role}: {content}")
    context = "\n".join(context_parts)
    if not context.strip():
        return {"title": conv.get("title", "New Chat")}

    try:
        settings = {}
        try:
            settings = json.loads(user.get("settings") or "{}")
        except Exception:
            pass
        model = settings.get("diab_model") or LLM_MODEL
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{OLLAMA_BASE_URL}/api/generate",
                json={
                    "model": model,
                    "system": "Generate a short, descriptive title (3-7 words) for this conversation. "
                              "The title should capture the main topic or question. "
                              "Output ONLY the title text, no quotes, no explanation.",
                    "prompt": context,
                    "stream": False,
                    "think": False,
                    "options": {"temperature": 0.5, "num_predict": 20},
                },
            )
            resp.raise_for_status()
            raw = resp.json().get("response", "").strip()
        title = raw.strip('"').strip("'").strip().split("\n")[0].strip()[:80]

        if title:
            db.rename_conversation(cid, user["id"], title)
            return {"title": title}
    except Exception as e:
        logger.warning(f"Smart title generation failed: {e}")

    return {"title": conv.get("title", "New Chat")}


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
    vault = user_vault_path(user["username"])
    if not vault.exists():
        raise HTTPException(status_code=503, detail="Vault path not found")

    supported = {".md", ".txt", ".pdf"}
    chunk_counts = _get_chunk_counts(user["id"])
    meta = _read_index_meta(user["id"])

    files = []
    folders = []
    for item in sorted(vault.rglob("*")):
        if item.is_file() and item.suffix.lower() in supported:
            rel = item.relative_to(vault)
            stat = item.stat()
            files.append({
                "name": item.name,
                "path": str(rel).replace("\\", "/"),
                "size_bytes": stat.st_size,
                "modified_at": datetime.utcfromtimestamp(stat.st_mtime).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "chunk_count": chunk_counts.get(item.name, 0),
            })
        elif item.is_dir():
            rel = item.relative_to(vault)
            folders.append(str(rel).replace("\\", "/"))

    return {
        "files": files,
        "folders": folders,
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

    vault = user_vault_path(user["username"])
    safe_sub = Path(subfolder.strip("/").strip()) if subfolder.strip() else Path("")
    for part in safe_sub.parts:
        if part in (".", ".."):
            raise HTTPException(status_code=400, detail="Invalid subfolder path")

    dest_dir = vault / safe_sub
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / file.filename

    with dest.open("wb") as out:
        shutil.copyfileobj(file.file, out)

    # Trigger immediate background index (no watcher debounce)
    import threading
    user_id, uname = user["id"], user["username"]
    _set_index_status(user_id, running=False, queued=True)
    def _bg():
        _set_index_status(user_id, running=True, queued=False)
        try:
            index_vault(VAULT_PATH, user_id, EMBED_MODEL, OLLAMA_BASE_URL, username=uname)
        except Exception as e:
            logger.warning(f"Post-upload index failed: {e}")
        finally:
            _set_index_status(user_id, running=False)
    threading.Thread(target=_bg, daemon=True).start()

    return {"ok": True, "path": str((safe_sub / file.filename)).replace("\\", "/")}


@app.delete("/vault/files")
def delete_vault_file(body: VaultDeleteRequest, user: dict = Depends(get_current_user)):
    vault = user_vault_path(user["username"])
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
    vault = user_vault_path(user["username"])
    target = (vault / body.path).resolve()
    try:
        target.relative_to(vault.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Path outside vault")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    new_name = Path(body.new_name).name
    dest = target.parent / new_name
    if dest.exists() and dest.resolve() != target.resolve():
        raise HTTPException(status_code=409, detail="File already exists")
    target.rename(dest)
    return {"ok": True, "path": str(dest.relative_to(vault.resolve()))}


@app.post("/vault/folder")
def create_vault_folder(body: VaultFolderRequest, user: dict = Depends(get_current_user)):
    vault = user_vault_path(user["username"])
    safe = Path(body.folder.strip("/").strip())
    for part in safe.parts:
        if part in (".", ".."):
            raise HTTPException(status_code=400, detail="Invalid folder path")
    target = (vault / safe).resolve()
    try:
        target.relative_to(vault.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Path outside vault")
    target.mkdir(parents=True, exist_ok=True)
    return {"ok": True}


@app.delete("/vault/folder")
def delete_vault_folder(body: VaultFolderRequest, user: dict = Depends(get_current_user)):
    vault = user_vault_path(user["username"])
    safe = Path(body.folder.strip("/").strip())
    target = (vault / safe).resolve()
    try:
        target.relative_to(vault.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Path outside vault")
    if not target.exists():
        raise HTTPException(status_code=404, detail="Folder not found")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="Not a folder")
    shutil.rmtree(target)
    return {"ok": True}


@app.post("/vault/move")
def move_vault_file(body: VaultMoveRequest, user: dict = Depends(get_current_user)):
    vault = user_vault_path(user["username"])
    src = (vault / body.path).resolve()
    try:
        src.relative_to(vault.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Path outside vault")
    if not src.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    dest_folder = Path(body.dest_folder.strip("/").strip()) if body.dest_folder.strip() else Path("")
    for part in dest_folder.parts:
        if part in (".", ".."):
            raise HTTPException(status_code=400, detail="Invalid destination")
    dest_dir = (vault / dest_folder).resolve()
    try:
        dest_dir.relative_to(vault.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Destination outside vault")
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / src.name
    if dest.exists():
        raise HTTPException(status_code=409, detail="A file with that name already exists in the destination")
    src.rename(dest)
    return {"ok": True, "path": str(dest.relative_to(vault.resolve())).replace("\\", "/")}


@app.post("/vault/folder/rename")
def rename_vault_folder(body: VaultRenameRequest, user: dict = Depends(get_current_user)):
    vault = user_vault_path(user["username"])
    target = (vault / body.path).resolve()
    try:
        target.relative_to(vault.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Path outside vault")
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="Folder not found")
    new_name = Path(body.new_name).name
    dest = target.parent / new_name
    if dest.exists() and dest.resolve() != target.resolve():
        raise HTTPException(status_code=409, detail="Folder already exists")
    target.rename(dest)
    return {"ok": True}


@app.get("/vault/file")
def vault_file(path: str, user: dict = Depends(get_current_user)):
    vault = user_vault_path(user["username"])
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
