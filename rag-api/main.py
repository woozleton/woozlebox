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
from contextlib import asynccontextmanager
from typing import Optional, AsyncGenerator

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import ollama as ollama_client

from indexer import get_chroma_client, embed_texts, index_vault, COLLECTION_NAME
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
DEFAULT_TOP_K     = 30
NOT_FOUND_MSG     = "I couldn't find that in your vault."


# --- Lifespan ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    logger.info("Starting up — indexing vault...")
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, index_vault, VAULT_PATH, EMBED_MODEL, OLLAMA_BASE_URL)
    logger.info(f"Indexing result: {result}")
    yield


app = FastAPI(title="Dave-in-a-Box RAG API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# --- Pydantic models ---
class ChatRequest(BaseModel):
    message: str
    model: Optional[str] = None
    conversation_id: Optional[str] = None
    temperature: float = 0.2
    threshold: Optional[float] = None
    top_k: int = DEFAULT_TOP_K
    web_search: bool = False

class ConversationPatch(BaseModel):
    title: str

class IndexResponse(BaseModel):
    files_processed: int
    chunks_upserted: int
    errors: list[str]

class ModelsResponse(BaseModel):
    models: list[str]
    default: str


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
async def chat_stream(request: ChatRequest) -> AsyncGenerator[str, None]:
    model = request.model or LLM_MODEL
    threshold = request.threshold if request.threshold is not None else SIMILARITY_THRESHOLD
    top_k = max(1, request.top_k)

    # Step 1: Embed
    yield sse({"type": "status", "step": "embed", "text": "Embedding query..."})
    try:
        loop = asyncio.get_event_loop()
        query_embedding = await loop.run_in_executor(
            None, lambda: embed_texts([request.message], EMBED_MODEL, OLLAMA_BASE_URL)[0]
        )
    except Exception as e:
        yield sse({"type": "error", "text": f"Embedding failed: {e}"})
        return

    # Step 2: Vault search
    yield sse({"type": "status", "step": "vault", "text": "Searching vault..."})
    try:
        chroma_client = get_chroma_client()
        collection = chroma_client.get_collection(COLLECTION_NAME)
        results = collection.query(
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

    best_distance = distances[0] if distances else 2.0
    relevant = [
        (doc, meta)
        for doc, meta, dist in zip(documents, metadatas, distances)
        if dist <= threshold
    ]
    sources = list(dict.fromkeys(meta["source"] for _, meta in relevant))
    debug = {"best_distance": best_distance, "threshold": threshold, "chunks_retrieved": len(documents), "chunks_used": len(relevant)}

    if relevant:
        yield sse({"type": "status", "step": "vault", "text": f"Found {len(relevant)} relevant chunks", "done": True})
    else:
        yield sse({"type": "status", "step": "vault", "text": "No vault match found", "done": True})

    # Step 3: Web search (optional)
    web_sources = []
    if request.web_search:
        yield sse({"type": "status", "step": "web", "text": "Searching web..."})
        web_sources = await web_search(request.message)
        yield sse({"type": "status", "step": "web", "text": f"Found {len(web_sources)} web results", "done": True})

    # Step 4: Vault miss with no web results
    if not relevant and not web_sources:
        conv_id = request.conversation_id
        if not conv_id:
            conv_id = db.create_conversation()
            db.auto_title(conv_id, request.message)
        db.add_message(conv_id, "user", request.message)
        db.add_message(conv_id, "assistant", NOT_FOUND_MSG, model_used=model)
        yield sse({
            "type": "done",
            "from_vault": False,
            "answer": NOT_FOUND_MSG,
            "sources": [],
            "web_sources": [],
            "model_used": model,
            "conversation_id": conv_id,
            "debug": debug,
        })
        return

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

    prompt = f"""You are Dave's personal AI assistant. Answer the question using ONLY the information in the provided context. Do not use any outside knowledge. If the context does not contain enough information, say so. {source_instruction}

Context:
{context_text}

Question: {request.message}

Answer:"""

    logger.info(f"Sending {len(relevant)} vault chunks + {len(web_sources)} web results to LLM ({len(context_text)} chars)")

    # Step 6: Stream LLM response
    yield sse({"type": "status", "step": "llm", "text": "Generating answer..."})

    full_answer = ""
    try:
        client = ollama_client.Client(host=OLLAMA_BASE_URL)
        stream = client.chat(
            model=model,
            messages=[{"role": "user", "content": prompt}],
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
        yield sse({"type": "error", "text": f"LLM unavailable: {e}"})
        return

    # Step 7: Save to DB
    conv_id = request.conversation_id
    if not conv_id:
        conv_id = db.create_conversation()
    db.auto_title(conv_id, request.message)
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
def health():
    return {"status": "ok", "vault": VAULT_PATH, "llm_model": LLM_MODEL, "embed_model": EMBED_MODEL}


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


@app.post("/chat")
async def chat(request: ChatRequest):
    if not request.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    return StreamingResponse(
        chat_stream(request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/index", response_model=IndexResponse)
async def trigger_reindex():
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, index_vault, VAULT_PATH, EMBED_MODEL, OLLAMA_BASE_URL)
    return IndexResponse(**result)


@app.get("/search")
async def search_proxy(q: str):
    results = await web_search(q)
    return {"results": results}


# --- Conversation endpoints ---

@app.get("/conversations")
def list_convs():
    return db.list_conversations()


@app.post("/conversations")
def create_conv():
    cid = db.create_conversation()
    return {"id": cid}


@app.get("/conversations/{cid}")
def get_conv(cid: str):
    conv = db.get_conversation(cid)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


@app.delete("/conversations/{cid}")
def delete_conv(cid: str):
    db.delete_conversation(cid)
    return {"ok": True}


@app.patch("/conversations/{cid}")
def rename_conv(cid: str, body: ConversationPatch):
    db.rename_conversation(cid, body.title)
    return {"ok": True}
