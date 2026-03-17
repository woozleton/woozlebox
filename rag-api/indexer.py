"""
indexer.py — file ingestion, chunking, embedding, and ChromaDB upsert.

Chunking strategy:
  - RecursiveCharacterTextSplitter
  - chunk_size = 1024 chars (safe for nomic-embed-text's 2048-token window)
  - chunk_overlap = 128 chars — prevents context loss at chunk boundaries
  - Separators tried in order: paragraph breaks, line breaks, sentences, words

Supported file types: .md, .txt, .pdf
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

COLLECTION_NAME = "dave_vault"
CHUNK_SIZE = 512
CHUNK_OVERLAP = 64
SUPPORTED_EXTENSIONS = {".md", ".txt", ".pdf"}


def get_chroma_client() -> chromadb.HttpClient:
    host = os.environ.get("CHROMA_HOST", "chromadb")
    port = int(os.environ.get("CHROMA_PORT_INTERNAL", "8000"))
    return chromadb.HttpClient(host=host, port=port)


def get_or_create_collection(client: chromadb.HttpClient):
    return client.get_or_create_collection(
        name=COLLECTION_NAME,
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


def index_vault(vault_path: str, embed_model: str, ollama_base_url: str) -> dict:
    """
    Walk vault_path, chunk all supported files, embed them, and upsert into ChromaDB.

    Full re-index strategy: delete collection and rebuild every time.
    Simple and avoids stale-chunk bugs from renamed/deleted files.
    Returns: {files_processed, chunks_upserted, errors}
    """
    vault = Path(vault_path)
    if not vault.exists():
        logger.error(f"Vault path {vault_path} does not exist")
        return {"files_processed": 0, "chunks_upserted": 0, "errors": ["Vault path not found"]}

    client = get_chroma_client()

    try:
        client.delete_collection(COLLECTION_NAME)
        logger.info(f"Deleted existing collection '{COLLECTION_NAME}' for re-index")
    except Exception:
        pass  # Didn't exist yet, that's fine

    collection = get_or_create_collection(client)

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=CHUNK_SIZE,
        chunk_overlap=CHUNK_OVERLAP,
        separators=["\n\n", "\n", ". ", " ", ""],
    )

    files_processed = 0
    chunks_upserted = 0
    errors = []

    all_files = [
        f for f in vault.rglob("*")
        if f.is_file() and f.suffix.lower() in SUPPORTED_EXTENSIONS
    ]

    logger.info(f"Found {len(all_files)} files to index in {vault_path}")

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
                    "filepath": str(filepath.relative_to(vault)),
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
        f"Indexing complete: {files_processed} files, {chunks_upserted} chunks, {len(errors)} errors"
    )
    result = {
        "files_processed": files_processed,
        "chunks_upserted": chunks_upserted,
        "errors": errors,
    }

    # Write sidecar so /vault/files can report last-indexed time and stats
    db_dir = os.environ.get("DB_DIR", "/app/data")
    meta_path = Path(db_dir) / "index_meta.json"
    try:
        meta_path.parent.mkdir(parents=True, exist_ok=True)
        meta_path.write_text(json.dumps({
            "last_indexed": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "files_processed": files_processed,
            "chunks_upserted": chunks_upserted,
            "errors": errors,
        }))
    except Exception as e:
        logger.warning(f"Could not write index_meta.json: {e}")

    return result
