"""
main.py — FastAPI RAG service for Dave's AI.

Chat flow:
  1. Embed the user's question via nomic-embed-text (Ollama)
  2. Query ChromaDB for the top-N most similar chunks (cosine distance)
  3. If best distance > SIMILARITY_THRESHOLD → return "not found" (LLM not called)
  4. If relevant chunks found → build grounded prompt, call selected LLM
  5. Return answer + deduplicated source filenames
"""

import os
import logging
import asyncio
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import ollama as ollama_client

from indexer import (
    get_chroma_client,
    embed_texts,
    index_vault,
    COLLECTION_NAME,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- Config ---
VAULT_PATH = os.environ.get("VAULT_PATH", "/vault")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://host.docker.internal:11434")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "nomic-embed-text")
LLM_MODEL = os.environ.get("LLM_MODEL", "qwen3:30b-a3b")
SIMILARITY_THRESHOLD = float(os.environ.get("SIMILARITY_THRESHOLD", "0.6"))
TOP_K = 30

NOT_FOUND_RESPONSE = "I couldn't find that in your vault."


# --- Startup: index vault ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting up — indexing vault...")
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None, index_vault, VAULT_PATH, EMBED_MODEL, OLLAMA_BASE_URL
    )
    logger.info(f"Indexing result: {result}")
    yield
    logger.info("Shutting down.")


app = FastAPI(title="Dave's AI RAG API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Pydantic models ---
class ChatRequest(BaseModel):
    message: str
    model: Optional[str] = None  # overrides LLM_MODEL if provided

class ChatResponse(BaseModel):
    answer: str
    sources: list[str]
    from_vault: bool
    model_used: str
    debug: dict = {}

class IndexResponse(BaseModel):
    files_processed: int
    chunks_upserted: int
    errors: list[str]

class ModelsResponse(BaseModel):
    models: list[str]
    default: str


# --- Endpoints ---

@app.get("/health")
def health():
    return {"status": "ok", "vault": VAULT_PATH, "llm_model": LLM_MODEL, "embed_model": EMBED_MODEL}


@app.get("/models", response_model=ModelsResponse)
def list_models():
    """Return all models currently available in Ollama."""
    try:
        client = ollama_client.Client(host=OLLAMA_BASE_URL)
        response = client.list()
        raw_models = response.get("models", []) if isinstance(response, dict) else getattr(response, "models", [])
        names = []
        for m in raw_models:
            # Client may return dicts or objects depending on version
            if isinstance(m, dict):
                name = m.get("model") or m.get("name", "")
            else:
                name = getattr(m, "model", None) or getattr(m, "name", "")
            if name:
                names.append(name)
        # Put the default first
        if LLM_MODEL in names:
            names = [LLM_MODEL] + [n for n in names if n != LLM_MODEL]
        logger.info(f"Available models: {names}")
        return ModelsResponse(models=names, default=LLM_MODEL)
    except Exception as e:
        logger.error(f"Failed to list Ollama models: {e}")
        raise HTTPException(status_code=503, detail=f"Ollama unavailable: {e}")


@app.post("/index", response_model=IndexResponse)
async def trigger_reindex():
    """Manually trigger a full re-index of the vault."""
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None, index_vault, VAULT_PATH, EMBED_MODEL, OLLAMA_BASE_URL
    )
    return IndexResponse(**result)


@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    if not request.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    model = request.model or LLM_MODEL

    # Step 1: Embed the query
    try:
        query_embedding = embed_texts([request.message], EMBED_MODEL, OLLAMA_BASE_URL)[0]
    except Exception as e:
        logger.error(f"Embedding failed: {e}")
        raise HTTPException(status_code=503, detail=f"Embedding service unavailable: {e}")

    # Step 2: Query ChromaDB
    try:
        chroma_client = get_chroma_client()
        collection = chroma_client.get_collection(COLLECTION_NAME)
        results = collection.query(
            query_embeddings=[query_embedding],
            n_results=TOP_K,
            include=["documents", "metadatas", "distances"],
        )
    except Exception as e:
        logger.error(f"ChromaDB query failed: {e}")
        raise HTTPException(status_code=503, detail=f"Vector DB unavailable: {e}")

    documents = results["documents"][0]
    metadatas = results["metadatas"][0]
    distances = results["distances"][0]

    logger.info(f"Top distances: {distances[:5]}")

    # Step 3: Threshold gate
    best_distance = distances[0] if distances else 2.0
    debug = {"best_distance": best_distance, "threshold": SIMILARITY_THRESHOLD, "chunks_retrieved": len(documents)}

    if best_distance > SIMILARITY_THRESHOLD:
        logger.info(f"No relevant docs (best distance={best_distance:.3f}, threshold={SIMILARITY_THRESHOLD})")
        return ChatResponse(answer=NOT_FOUND_RESPONSE, sources=[], from_vault=False, model_used=model, debug=debug)

    # Step 4: Build context from relevant chunks only
    relevant = [
        (doc, meta)
        for doc, meta, dist in zip(documents, metadatas, distances)
        if dist <= SIMILARITY_THRESHOLD
    ]

    context_text = "\n\n---\n\n".join(doc for doc, _ in relevant)
    sources = list(dict.fromkeys(meta["source"] for _, meta in relevant))
    logger.info(f"Sending {len(relevant)} chunks from {sources} to LLM ({len(context_text)} chars of context)")

    prompt = f"""You are Dave's personal AI assistant. Answer the question using ONLY the information in the provided context. Do not use any outside knowledge. If the context does not contain enough information to answer, say so.

Context from Dave's vault:
{context_text}

Question: {request.message}

Answer:"""

    # Step 5: Call LLM
    try:
        client = ollama_client.Client(host=OLLAMA_BASE_URL)
        response = client.chat(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            options={"temperature": 0.2},
        )
        answer = response["message"]["content"].strip()
    except Exception as e:
        logger.error(f"LLM call failed: {e}")
        raise HTTPException(status_code=503, detail=f"LLM service unavailable: {e}")

    return ChatResponse(answer=answer, sources=sources, from_vault=True, model_used=model, debug=debug)
