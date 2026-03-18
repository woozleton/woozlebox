"""
indexer.py — file ingestion, chunking, embedding, and ChromaDB upsert.

Chunking strategy:
  - RecursiveCharacterTextSplitter
  - chunk_size = 512 chars
  - chunk_overlap = 64 chars
  - Separators tried in order: paragraph breaks, line breaks, sentences, words

Supported file types: .md, .txt, .pdf

Each user gets their own ChromaDB collection: vault_{user_id_no_hyphens}
and their own vault subdirectory: {VAULT_PATH}/{user_id}/
"""

import os
import json
import hashlib
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import chromadb
import ollama
from pypdf import PdfReader
from langchain_text_splitters import RecursiveCharacterTextSplitter

logger = logging.getLogger(__name__)

CHUNK_SIZE = 512
CHUNK_OVERLAP = 64
SUPPORTED_EXTENSIONS = {".md", ".txt", ".pdf"}


def collection_name_for_user(user_id: str) -> str:
    """ChromaDB collection name for a given user. Must be 3-63 chars, alphanumeric+underscore."""
    return f"vault_{user_id.replace('-', '')}"


def get_chroma_client() -> chromadb.HttpClient:
    host = os.environ.get("CHROMA_HOST", "chromadb")
    port = int(os.environ.get("CHROMA_PORT_INTERNAL", "8000"))
    return chromadb.HttpClient(host=host, port=port)


def get_or_create_collection(client: chromadb.HttpClient, collection_name: str):
    return client.get_or_create_collection(
        name=collection_name,
        metadata={"hnsw:space": "cosine"},
    )


def extract_text(filepath: Path) -> Optional[str]:
    """Extract raw text from .md, .txt, or .pdf files."""
    suffix = filepath.suffix.lower()
    try:
        if suffix in {".md", ".txt"}:
            return filepath.read_text(encoding="utf-8", errors="replace")
        elif suffix == ".pdf":
            reader = PdfReader(str(filepath))
            pages = [page.extract_text() for page in reader.pages if page.extract_text()]
            return "\n\n".join(pages)
    except Exception as e:
        logger.warning(f"Could not extract text from {filepath}: {e}")
    return None


def embed_texts(texts: list[str], model: str, ollama_base_url: str) -> list[list[float]]:
    """Embed a list of text strings using Ollama."""
    client = ollama.Client(host=ollama_base_url)
    return [client.embeddings(model=model, prompt=text)["embedding"] for text in texts]


def file_hash(filepath: Path) -> str:
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        for block in iter(lambda: f.read(65536), b""):
            h.update(block)
    return h.hexdigest()


def index_vault(vault_path: str, user_id: str, embed_model: str, ollama_base_url: str) -> dict:
    """
    Walk vault_path/{user_id}/, chunk all supported files, embed them, and upsert
    into the user's ChromaDB collection.

    Full re-index strategy: delete collection and rebuild every time.
    Returns: {files_processed, chunks_upserted, errors}
    """
    user_vault = Path(vault_path) / user_id
    user_vault.mkdir(parents=True, exist_ok=True)

    collection_name = collection_name_for_user(user_id)
    client = get_chroma_client()

    try:
        client.delete_collection(collection_name)
        logger.info(f"Deleted existing collection '{collection_name}' for re-index")
    except Exception:
        pass

    collection = get_or_create_collection(client, collection_name)

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=CHUNK_SIZE,
        chunk_overlap=CHUNK_OVERLAP,
        separators=["\n\n", "\n", ". ", " ", ""],
    )

    files_processed = 0
    chunks_upserted = 0
    errors = []

    all_files = [
        f for f in user_vault.rglob("*")
        if f.is_file() and f.suffix.lower() in SUPPORTED_EXTENSIONS
    ]

    logger.info(f"Found {len(all_files)} files to index for user {user_id}")

    for filepath in all_files:
        try:
            text = extract_text(filepath)
            if not text or not text.strip():
                logger.warning(f"Empty or unreadable: {filepath.name}")
                continue

            chunks = splitter.split_text(text)
            if not chunks:
                continue

            fhash = file_hash(filepath)
            ids = [f"{fhash}_{i}" for i in range(len(chunks))]
            metadatas = [
                {
                    "source": filepath.name,
                    "filepath": str(filepath.relative_to(user_vault)),
                    "chunk_index": i,
                    "file_hash": fhash,
                }
                for i in range(len(chunks))
            ]

            embeddings = embed_texts(chunks, embed_model, ollama_base_url)

            collection.upsert(
                ids=ids,
                documents=chunks,
                embeddings=embeddings,
                metadatas=metadatas,
            )

            files_processed += 1
            chunks_upserted += len(chunks)
            logger.info(f"Indexed {filepath.name}: {len(chunks)} chunks")

        except Exception as e:
            logger.error(f"Error indexing {filepath}: {e}")
            errors.append(f"{filepath.name}: {str(e)}")

    logger.info(
        f"Indexing complete for {user_id}: {files_processed} files, {chunks_upserted} chunks, {len(errors)} errors"
    )
    result = {
        "files_processed": files_processed,
        "chunks_upserted": chunks_upserted,
        "errors": errors,
    }

    # Write per-user sidecar
    db_dir = os.environ.get("DB_DIR", "/app/data")
    meta_path = Path(db_dir) / f"index_meta_{user_id}.json"
    try:
        meta_path.parent.mkdir(parents=True, exist_ok=True)
        meta_path.write_text(json.dumps({
            "last_indexed": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "files_processed": files_processed,
            "chunks_upserted": chunks_upserted,
            "errors": errors,
        }))
    except Exception as e:
        logger.warning(f"Could not write index_meta for {user_id}: {e}")

    return result
