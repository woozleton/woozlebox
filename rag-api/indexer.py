"""
indexer.py - file ingestion, chunking, embedding, and ChromaDB upsert.

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


def index_vault(vault_path: str, user_id: str, embed_model: str, ollama_base_url: str, progress_cb=None, username: str = None) -> dict:
    """
    Walk vault_path/{username}/, chunk all supported files, embed them, and upsert
    into the user's ChromaDB collection.

    Incremental strategy: skip files whose hash is already in the collection,
    remove chunks for files that no longer exist, add new/changed files.
    Returns: {files_processed, chunks_upserted, files_skipped, errors}

    progress_cb: optional callable(done: int, total: int, filename: str) called after each file.
    """
    vault_subdir = username or user_id
    user_vault = Path(vault_path) / vault_subdir
    user_vault.mkdir(parents=True, exist_ok=True)

    collection_name = collection_name_for_user(user_id)
    client = get_chroma_client()
    collection = get_or_create_collection(client, collection_name)

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=CHUNK_SIZE,
        chunk_overlap=CHUNK_OVERLAP,
        separators=["\n\n", "\n", ". ", " ", ""],
    )

    # Get all hashes + metadata already in the collection
    existing = collection.get(include=["metadatas"])
    indexed_hashes: set[str] = set()
    indexed_ids_by_hash: dict[str, list[str]] = {}
    indexed_filepath_by_hash: dict[str, str] = {}  # hash -> stored filepath
    for meta, doc_id in zip(existing["metadatas"], existing["ids"]):
        h = meta.get("file_hash", "")
        if h:
            indexed_hashes.add(h)
            indexed_ids_by_hash.setdefault(h, []).append(doc_id)
            if h not in indexed_filepath_by_hash:
                indexed_filepath_by_hash[h] = meta.get("filepath", "")

    all_files = [
        f for f in user_vault.rglob("*")
        if f.is_file() and f.suffix.lower() in SUPPORTED_EXTENSIONS
    ]

    logger.info(f"Found {len(all_files)} files for user {user_id}, {len(indexed_hashes)} hashes already indexed")

    # Build map of hash -> current filepath on disk
    current_hash_to_file: dict[str, Path] = {}
    for filepath in all_files:
        try:
            current_hash_to_file[file_hash(filepath)] = filepath
        except Exception:
            pass
    current_hashes = set(current_hash_to_file.keys())

    # Remove chunks for files that no longer exist anywhere on disk
    orphaned_hashes = indexed_hashes - current_hashes
    for h in orphaned_hashes:
        ids_to_delete = indexed_ids_by_hash.get(h, [])
        if ids_to_delete:
            collection.delete(ids=ids_to_delete)
            logger.info(f"Removed {len(ids_to_delete)} chunks for deleted file (hash {h[:8]})")

    files_processed = 0
    files_skipped = 0
    chunks_upserted = 0
    errors = []
    files_to_index = []

    # First pass: determine which files need indexing, and patch moved files' metadata
    for filepath in all_files:
        try:
            fhash = file_hash(filepath)
            current_rel = str(filepath.relative_to(user_vault))
            if fhash in indexed_hashes:
                stored_rel = indexed_filepath_by_hash.get(fhash, "")
                if stored_rel != current_rel:
                    # File was moved - update filepath/source metadata in-place
                    ids_to_update = indexed_ids_by_hash.get(fhash, [])
                    for chunk_id in ids_to_update:
                        chunk_index = int(chunk_id.split("_")[-1])
                        collection.update(
                            ids=[chunk_id],
                            metadatas=[{
                                "source": filepath.name,
                                "filepath": current_rel,
                                "chunk_index": chunk_index,
                                "file_hash": fhash,
                            }]
                        )
                    logger.info(f"Updated filepath metadata for moved file {filepath.name} ({stored_rel} -> {current_rel})")
                files_skipped += 1
            else:
                files_to_index.append((filepath, fhash))
        except Exception as e:
            errors.append(f"{filepath.name}: {str(e)}")

    total_new = len(files_to_index)
    logger.info(f"Skipping {files_skipped} unchanged files, indexing {total_new} new/changed files")

    for i, (filepath, fhash) in enumerate(files_to_index):
        try:
            text = extract_text(filepath)
            if not text or not text.strip():
                logger.warning(f"Empty or unreadable: {filepath.name}")
                if progress_cb:
                    progress_cb(i + 1, total_new, filepath.name)
                continue

            chunks = splitter.split_text(text)
            if not chunks:
                if progress_cb:
                    progress_cb(i + 1, total_new, filepath.name)
                continue

            ids = [f"{fhash}_{j}" for j in range(len(chunks))]
            metadatas = [
                {
                    "source": filepath.name,
                    "filepath": str(filepath.relative_to(user_vault)),
                    "chunk_index": j,
                    "file_hash": fhash,
                }
                for j in range(len(chunks))
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
            if progress_cb:
                progress_cb(i + 1, total_new, filepath.name)

        except Exception as e:
            logger.error(f"Error indexing {filepath}: {e}")
            errors.append(f"{filepath.name}: {str(e)}")
            if progress_cb:
                progress_cb(i + 1, total_new, filepath.name)

    logger.info(
        f"Indexing complete for {user_id}: {files_processed} new, {files_skipped} skipped, {chunks_upserted} chunks, {len(errors)} errors"
    )
    result = {
        "files_processed": files_processed,
        "files_skipped": files_skipped,
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
            "files_skipped": files_skipped,
            "chunks_upserted": chunks_upserted,
            "errors": errors,
        }))
    except Exception as e:
        logger.warning(f"Could not write index_meta for {user_id}: {e}")

    return result
