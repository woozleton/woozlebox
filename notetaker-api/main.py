"""
notetaker-api - Transcription and speaker diarization service for WoozleBox.

Uses whisperX for transcription, alignment, and speaker diarization.
Audio files are stored server-side for playback and re-transcription.

POST /transcribe              - Upload audio/video, transcribe + diarize
POST /retranscribe/{note_id}  - Re-transcribe existing audio with different settings
GET  /progress                - Poll pipeline progress
POST /cancel                  - Cancel in-progress transcription
GET  /models                  - List available Whisper model sizes
POST /models/load             - Pre-load a Whisper model
POST /models/unload           - Unload model to free VRAM
GET  /audio/{note_id}         - Stream stored audio file
DELETE /audio/{note_id}       - Delete stored audio file
GET  /health                  - Service health + loaded model info
"""

import os
import gc
import time
import uuid
import logging
import asyncio
import subprocess
import threading
from pathlib import Path
from typing import Optional

import httpx
import torch
import numpy as np
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

HF_CACHE = os.environ.get("HF_HOME", "/root/.cache/huggingface")
HF_TOKEN = os.environ.get("HF_TOKEN", "")
GPU_MANAGER_URL = os.environ.get("GPU_MANAGER_URL", "http://gpu-manager:8400")
SERVICE_NAME = "notetaker"
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
AUDIO_DIR = DATA_DIR / "audio"
AUDIO_DIR.mkdir(parents=True, exist_ok=True)


# ── Load-status tracker ─────────────────────────────────────────────
# Exposes the current model-load phase (idle/loading/downloading/ready/error)
# so gpu-manager and the web UI can show live download progress instead of a
# generic spinner. whisperX uses HF_CACHE/hub for its snapshots, pyannote uses
# the same layout. We watch the whole HF hub subdir since the two loaders may
# touch different repos during a single transcription setup.
LOAD_STATUS = {
    "state": "idle", "model": "", "repo": "", "phase": "",
    "downloaded_bytes": 0, "started_at": 0.0, "updated_at": 0.0,
}
_ls_stop: Optional[threading.Event] = None


def _ls_dir_size(path: str) -> int:
    total = 0
    try:
        for root, _, files in os.walk(path):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
    except OSError:
        pass
    return total


def _ls_post(action: str, detail: str = ""):
    """Fire-and-forget activity event to gpu-manager's /vram/log ring buffer."""
    try:
        httpx.post(
            f"{GPU_MANAGER_URL}/vram/log",
            json={"service": SERVICE_NAME, "action": action,
                  "model": LOAD_STATUS["model"], "vram_mb": 0, "detail": detail},
            timeout=2.0,
        )
    except Exception as e:
        logger.debug(f"load_status event post failed: {e}")


def ls_begin(model: str, repo: str, phase: str):
    """Mark the start of a model load and spawn a cache-dir watcher."""
    global _ls_stop
    now = time.time()
    LOAD_STATUS.update({
        "state": "loading", "model": model, "repo": repo,
        "phase": phase, "downloaded_bytes": 0,
        "started_at": now, "updated_at": now,
    })
    _ls_post("load_begin", phase)

    watch_dir = os.path.join(HF_CACHE, "hub")
    baseline = _ls_dir_size(watch_dir) if os.path.exists(watch_dir) else 0
    stop = threading.Event()
    _ls_stop = stop

    def _watch():
        last_emit = 0
        while not stop.is_set():
            time.sleep(1.0)
            try:
                delta = max(0, _ls_dir_size(watch_dir) - baseline)
            except Exception:
                delta = 0
            if delta > 0:
                if LOAD_STATUS["state"] != "downloading":
                    LOAD_STATUS["state"] = "downloading"
                    LOAD_STATUS["phase"] = f"Downloading {repo or model}"
                    _ls_post("download", f"downloading {repo or model}")
                LOAD_STATUS["downloaded_bytes"] = delta
                LOAD_STATUS["updated_at"] = time.time()
                if delta - last_emit >= 128 * 1024 * 1024:
                    mb = delta // (1024 * 1024)
                    _ls_post("download", f"{mb} MB downloaded")
                    last_emit = delta

    threading.Thread(target=_watch, daemon=True).start()


def ls_ready(vram_mb: int = 0):
    global _ls_stop
    if _ls_stop is not None:
        _ls_stop.set()
        _ls_stop = None
    LOAD_STATUS["state"] = "ready"
    LOAD_STATUS["phase"] = "Ready"
    LOAD_STATUS["updated_at"] = time.time()
    _ls_post("ready", f"VRAM {vram_mb} MB")


def ls_error(msg: str):
    global _ls_stop
    if _ls_stop is not None:
        _ls_stop.set()
        _ls_stop = None
    LOAD_STATUS["state"] = "error"
    LOAD_STATUS["phase"] = (msg or "error")[:120]
    LOAD_STATUS["updated_at"] = time.time()
    _ls_post("error", (msg or "error")[:120])

SUPPORTED_FORMATS = {".wav", ".mp3", ".m4a", ".flac", ".mp4", ".mkv", ".webm", ".mov", ".ogg", ".wma"}
VIDEO_FORMATS = {".mp4", ".mkv", ".webm", ".mov"}


class GatedRepoError(Exception):
    """Raised when a HuggingFace model requires license acceptance."""
    def __init__(self, repo_url: str, message: str = ""):
        self.repo_url = repo_url
        super().__init__(message or f"Accept terms at {repo_url}")


def _check_gated_repo_error(exc):
    """If exc is a HuggingFace gated repo error, raise GatedRepoError with the repo URL."""
    import re
    name = type(exc).__name__
    msg = str(exc)
    if "GatedRepoError" in name or ("403" in msg and "huggingface.co" in msg):
        m = re.search(r"https://huggingface\.co/([^\s/]+/[^\s/]+)", msg)
        repo = m.group(1) if m else "unknown"
        raise GatedRepoError(
            f"https://huggingface.co/{repo}",
            f"HuggingFace repo '{repo}' is gated. Accept terms at https://huggingface.co/{repo}"
        ) from exc

WHISPER_MODELS = ["tiny", "base", "small", "medium", "large-v3"]
WHISPER_DISPLAY_NAMES = {
    "tiny": "Whisper Tiny", "base": "Whisper Base", "small": "Whisper Small",
    "medium": "Whisper Medium", "large-v3": "Whisper Large v3",
}

def _gpu_vram_used_mb() -> int:
    """Get actual GPU VRAM usage in MB via CUDA runtime (works for CTranslate2)."""
    if not torch.cuda.is_available():
        return 0
    free, total = torch.cuda.mem_get_info()
    return (total - free) // 1024 // 1024

# -- Global state --
_whisper_model = None
_current_model_name = None
_whisper_vram_mb = 0
_diarize_pipeline = None

_progress = {
    "running": False,
    "phase": "",
    "step": 0,
    "total_steps": 4,
    "elapsed_s": 0.0,
    "started_at": 0.0,
    "message": "",
}
_cancel_requested = False

app = FastAPI(title="notetaker-api")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _update_progress(phase: str, step: int, message: str):
    """Update global progress state."""
    _progress["phase"] = phase
    _progress["step"] = step
    _progress["message"] = message
    _progress["elapsed_s"] = round(time.time() - _progress["started_at"], 1)


def _generate_note_id() -> str:
    """Generate a unique note ID."""
    ts = int(time.time())
    short = uuid.uuid4().hex[:8]
    return f"note_{ts}_{short}"


def _load_whisper_model(model_name: str = "medium"):
    """Load a whisperX model onto GPU."""
    global _whisper_model, _current_model_name, _whisper_vram_mb
    import whisperx

    if _whisper_model is not None and _current_model_name == model_name:
        return

    # Unload existing model first
    if _whisper_model is not None:
        _unload_model()

    logger.info(f"Loading whisperX model: {model_name}")
    t0 = time.time()
    ls_begin(
        model=f"whisper-{model_name}",
        repo=f"Systran/faster-whisper-{model_name}",
        phase=f"Loading Whisper {model_name}",
    )

    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"

    vram_before = _gpu_vram_used_mb()
    try:
        _whisper_model = whisperx.load_model(
            model_name,
            device=device,
            compute_type=compute_type,
            download_root=HF_CACHE,
        )
    except Exception as e:
        try:
            _check_gated_repo_error(e)
        except GatedRepoError as ge:
            ls_error(str(ge))
            raise
        ls_error(str(e))
        raise
    _current_model_name = model_name
    _whisper_vram_mb = max(0, _gpu_vram_used_mb() - vram_before)

    logger.info(f"whisperX {model_name} ready in {time.time()-t0:.1f}s - VRAM: {_whisper_vram_mb}MB")
    ls_ready(_whisper_vram_mb)


def _load_diarize_pipeline():
    """Load the pyannote diarization pipeline."""
    global _diarize_pipeline
    from pyannote.audio import Pipeline as PyannotePipeline

    if _diarize_pipeline is not None:
        return

    if not HF_TOKEN:
        raise RuntimeError("HF_TOKEN required for speaker diarization. Set it in your environment.")

    logger.info("Loading diarization pipeline...")
    t0 = time.time()
    ls_begin(
        model="pyannote-diarization-3.1",
        repo="pyannote/speaker-diarization-3.1",
        phase="Loading diarization pipeline",
    )

    device = "cuda" if torch.cuda.is_available() else "cpu"
    try:
        _diarize_pipeline = PyannotePipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            token=HF_TOKEN,
            cache_dir=HF_CACHE,
        )
    except Exception as e:
        try:
            _check_gated_repo_error(e)
        except GatedRepoError as ge:
            ls_error(str(ge))
            raise
        ls_error(str(e))
        raise
    _diarize_pipeline.to(torch.device(device))

    logger.info(f"Diarization pipeline ready in {time.time()-t0:.1f}s")
    ls_ready()


def _unload_model():
    """Unload whisper model and diarization pipeline to free VRAM."""
    global _whisper_model, _current_model_name, _whisper_vram_mb, _diarize_pipeline

    _whisper_model = None
    _current_model_name = None
    _whisper_vram_mb = 0
    _diarize_pipeline = None

    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    logger.info("Models unloaded, VRAM freed")


def _extract_audio(input_path: Path, output_path: Path):
    """Extract audio from video or convert audio to 16kHz mono WAV using ffmpeg."""
    cmd = [
        "ffmpeg", "-y", "-i", str(input_path),
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
        str(output_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr[:500]}")


def _transcribe_audio(wav_path: Path, language: str, model_name: str,
                      diarize: bool, num_speakers: Optional[int]) -> dict:
    """Run the full whisperX pipeline: transcribe, align, diarize."""
    import whisperx
    global _cancel_requested

    device = "cuda" if torch.cuda.is_available() else "cpu"

    # Step 1: Load model
    _update_progress("loading", 1, "Loading transcription model...")
    _load_whisper_model(model_name)

    if _cancel_requested:
        return None

    # Step 2: Transcribe
    _update_progress("transcribing", 2, "Transcribing audio...")
    audio = whisperx.load_audio(str(wav_path))

    transcribe_kwargs = {"batch_size": 16}
    if language and language != "auto":
        transcribe_kwargs["language"] = language

    result = _whisper_model.transcribe(audio, **transcribe_kwargs)
    detected_language = result.get("language", language if language != "auto" else "en")

    if _cancel_requested:
        return None

    # Step 3: Align word timestamps
    _update_progress("aligning", 3, "Aligning word timestamps...")
    try:
        align_model, align_meta = whisperx.load_align_model(
            language_code=detected_language, device=device
        )
        result = whisperx.align(
            result["segments"], align_model, align_meta,
            audio, device, return_char_alignments=False,
        )
        # Free align model
        del align_model
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception as e:
        logger.warning(f"Alignment failed (non-fatal, using raw timestamps): {e}")

    if _cancel_requested:
        return None

    # Step 4: Diarize speakers
    speakers = []
    if diarize:
        _update_progress("diarizing", 4, "Identifying speakers...")
        try:
            import pandas as pd
            _load_diarize_pipeline()
            diarize_kwargs = {}
            if num_speakers and num_speakers > 0:
                diarize_kwargs["num_speakers"] = num_speakers

            # pyannote expects {"waveform": tensor, "sample_rate": int}
            audio_tensor = torch.from_numpy(audio).unsqueeze(0).float()
            audio_input = {"waveform": audio_tensor, "sample_rate": 16000}

            diarize_output = _diarize_pipeline(audio_input, **diarize_kwargs)

            # pyannote.audio 4.x returns DiarizeOutput wrapper;
            # use standard (non-exclusive) diarization which preserves
            # overlap information for whisperx's assign_word_speakers
            if hasattr(diarize_output, "speaker_diarization"):
                annotation = diarize_output.speaker_diarization
            else:
                annotation = diarize_output

            # Convert pyannote Annotation to DataFrame for whisperx
            rows = []
            for turn, _, speaker in annotation.itertracks(yield_label=True):
                rows.append({"start": turn.start, "end": turn.end, "speaker": speaker})
            diarize_df = pd.DataFrame(rows)

            if not diarize_df.empty:
                result = whisperx.assign_word_speakers(diarize_df, result)
            logger.info(f"Diarization found {len(rows)} speaker turns across {len(set(r['speaker'] for r in rows))} speakers")
        except GatedRepoError as e:
            logger.error(f"Diarization blocked - {e}")
            _update_progress("diarizing", 4, f"GATED_REPO:{e.repo_url}")
        except Exception as e:
            try:
                _check_gated_repo_error(e)
            except GatedRepoError as ge:
                logger.error(f"Diarization blocked - {ge}")
                _update_progress("diarizing", 4, f"GATED_REPO:{ge.repo_url}")
            else:
                logger.warning(f"Diarization failed (non-fatal, no speaker labels): {e}", exc_info=True)

    # Build output segments
    segments = []
    speaker_set = set()
    for seg in result.get("segments", []):
        speaker = seg.get("speaker", "Speaker")
        speaker_set.add(speaker)
        segments.append({
            "speaker": speaker,
            "start": round(seg.get("start", 0.0), 2),
            "end": round(seg.get("end", 0.0), 2),
            "text": seg.get("text", "").strip(),
        })

    speakers = sorted(speaker_set)

    # Build full text
    full_lines = []
    for seg in segments:
        full_lines.append(f"{seg['speaker']}: {seg['text']}")
    full_text = "\n".join(full_lines)

    # Get audio duration
    duration_s = round(len(audio) / 16000.0, 1)

    return {
        "segments": segments,
        "full_text": full_text,
        "speakers": speakers,
        "language": detected_language,
        "duration_s": duration_s,
    }


@app.on_event("startup")
async def startup():
    logger.info("Notetaker API started - model will load on first request or /models/load")


# -- Health --

@app.get("/health")
async def health():
    return {
        "ok": True,
        "model_loaded": _whisper_model is not None,
        "current_model": WHISPER_DISPLAY_NAMES.get(_current_model_name, _current_model_name),
        "vram_mb": _whisper_vram_mb,
        "diarize_loaded": _diarize_pipeline is not None,
    }


@app.get("/models/status")
def models_status():
    """Live model-load state for the web UI spinner. Returns phase + bytes."""
    s = LOAD_STATUS.copy()
    if s.get("started_at"):
        s["elapsed_s"] = round(time.time() - s["started_at"], 1)
    return s


# -- Models --

@app.get("/models")
async def list_models():
    return {
        "models": WHISPER_MODELS,
        "current": _current_model_name,
        "loaded": _whisper_model is not None,
    }


class LoadModelRequest(BaseModel):
    model: str = "medium"


@app.post("/models/load")
async def load_model(req: LoadModelRequest):
    if req.model not in WHISPER_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown model: {req.model}. Choose from: {WHISPER_MODELS}")
    try:
        await asyncio.to_thread(_load_whisper_model, req.model)
        return {"ok": True, "model": req.model, "vram_mb": _whisper_vram_mb}
    except GatedRepoError as e:
        raise HTTPException(status_code=403, detail=str(e), headers={"X-Gated-Repo": e.repo_url})
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load model: {e}")


@app.post("/models/unload")
async def unload_model():
    _unload_model()
    return {"ok": True}


# -- Progress --

@app.get("/progress")
async def progress():
    return _progress


@app.post("/cancel")
async def cancel():
    global _cancel_requested
    _cancel_requested = True
    return {"ok": True}


# -- Transcribe --

@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form("auto"),
    model: str = Form("medium"),
    diarize: bool = Form(True),
    num_speakers: Optional[int] = Form(None),
):
    global _cancel_requested

    # Validate format
    ext = Path(file.filename or "audio.wav").suffix.lower()
    if ext not in SUPPORTED_FORMATS:
        raise HTTPException(status_code=400, detail=f"Unsupported format: {ext}. Supported: {', '.join(sorted(SUPPORTED_FORMATS))}")

    if model not in WHISPER_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown model: {model}. Choose from: {WHISPER_MODELS}")

    if _progress["running"]:
        raise HTTPException(status_code=409, detail="A transcription is already in progress")

    note_id = _generate_note_id()

    # Reset state
    _cancel_requested = False
    _progress["running"] = True
    _progress["started_at"] = time.time()
    _progress["step"] = 0
    _progress["total_steps"] = 4
    _progress["phase"] = "uploading"
    _progress["message"] = "Receiving file..."
    _progress["elapsed_s"] = 0.0

    try:
        # Save uploaded file
        upload_path = AUDIO_DIR / f"{note_id}_original{ext}"
        with open(upload_path, "wb") as f:
            content = await file.read()
            f.write(content)

        # Convert to WAV
        wav_path = AUDIO_DIR / f"{note_id}.wav"
        if ext == ".wav":
            # Still convert to ensure 16kHz mono
            _update_progress("converting", 1, "Converting audio format...")
            await asyncio.to_thread(_extract_audio, upload_path, wav_path)
        elif ext in VIDEO_FORMATS:
            _update_progress("extracting", 1, "Extracting audio from video...")
            await asyncio.to_thread(_extract_audio, upload_path, wav_path)
        else:
            _update_progress("converting", 1, "Converting audio format...")
            await asyncio.to_thread(_extract_audio, upload_path, wav_path)

        # Clean up original if different from wav
        if upload_path != wav_path and upload_path.exists():
            upload_path.unlink()

        if _cancel_requested:
            _cleanup_note_files(note_id)
            return {"cancelled": True}

        # Run transcription pipeline
        result = await asyncio.to_thread(
            _transcribe_audio, wav_path, language, model, diarize, num_speakers
        )

        if result is None or _cancel_requested:
            _cleanup_note_files(note_id)
            return {"cancelled": True}

        elapsed = round(time.time() - _progress["started_at"], 1)

        return {
            "note_id": note_id,
            "audio_url": f"/audio/{note_id}",
            "segments": result["segments"],
            "full_text": result["full_text"],
            "speakers": result["speakers"],
            "language": result["language"],
            "duration_s": result["duration_s"],
            "elapsed_s": elapsed,
            "model": model,
        }

    except Exception as e:
        logger.error(f"Transcription failed: {e}")
        _cleanup_note_files(note_id)
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")

    finally:
        _progress["running"] = False
        _progress["phase"] = ""
        _progress["message"] = ""
        _cancel_requested = False


# -- Re-transcribe --

@app.post("/retranscribe/{note_id}")
async def retranscribe(
    note_id: str,
    language: str = Form("auto"),
    model: str = Form("medium"),
    diarize: bool = Form(True),
    num_speakers: Optional[int] = Form(None),
):
    global _cancel_requested

    wav_path = AUDIO_DIR / f"{note_id}.wav"
    if not wav_path.exists():
        raise HTTPException(status_code=404, detail=f"Audio not found for note: {note_id}")

    if model not in WHISPER_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown model: {model}. Choose from: {WHISPER_MODELS}")

    if _progress["running"]:
        raise HTTPException(status_code=409, detail="A transcription is already in progress")

    _cancel_requested = False
    _progress["running"] = True
    _progress["started_at"] = time.time()
    _progress["step"] = 0
    _progress["total_steps"] = 4
    _progress["phase"] = "loading"
    _progress["message"] = "Loading model..."
    _progress["elapsed_s"] = 0.0

    try:
        result = await asyncio.to_thread(
            _transcribe_audio, wav_path, language, model, diarize, num_speakers
        )

        if result is None or _cancel_requested:
            return {"cancelled": True}

        elapsed = round(time.time() - _progress["started_at"], 1)

        return {
            "note_id": note_id,
            "audio_url": f"/audio/{note_id}",
            "segments": result["segments"],
            "full_text": result["full_text"],
            "speakers": result["speakers"],
            "language": result["language"],
            "duration_s": result["duration_s"],
            "elapsed_s": elapsed,
            "model": model,
        }

    except Exception as e:
        logger.error(f"Re-transcription failed: {e}")
        raise HTTPException(status_code=500, detail=f"Re-transcription failed: {e}")

    finally:
        _progress["running"] = False
        _progress["phase"] = ""
        _progress["message"] = ""
        _cancel_requested = False


# -- Audio serving --

@app.get("/audio/{note_id}")
async def get_audio(note_id: str):
    wav_path = AUDIO_DIR / f"{note_id}.wav"
    if not wav_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")
    return FileResponse(wav_path, media_type="audio/wav", filename=f"{note_id}.wav")


@app.delete("/audio/{note_id}")
async def delete_audio(note_id: str):
    wav_path = AUDIO_DIR / f"{note_id}.wav"
    if wav_path.exists():
        wav_path.unlink()
    # Also clean up any leftover original files
    for p in AUDIO_DIR.glob(f"{note_id}_original*"):
        p.unlink()
    return {"ok": True}


def _cleanup_note_files(note_id: str):
    """Remove all files associated with a note ID."""
    for p in AUDIO_DIR.glob(f"{note_id}*"):
        try:
            p.unlink()
        except Exception:
            pass


# -- Streaming transcription --

@app.websocket("/stream")
async def stream_transcription(ws: WebSocket):
    """WebSocket endpoint for real-time streaming transcription.

    Client sends binary audio chunks (webm/opus from MediaRecorder).
    Server sends JSON text frames with confirmed and unconfirmed segments.
    """
    await ws.accept()

    language = ws.query_params.get("language", "auto")
    if not language or language == "auto":
        language = "en"

    ffmpeg_proc = None
    pcm_task = None
    processor = None
    confirmed_segments = []

    try:
        logger.info("Stream: importing whisper_online...")
        from whisper_online import FasterWhisperASR, OnlineASRProcessor

        logger.info(f"Stream: creating ASR (lang={language})...")
        asr = FasterWhisperASR(language, "tiny", cache_dir=HF_CACHE)
        logger.info("Stream: creating OnlineASRProcessor...")
        processor = OnlineASRProcessor(asr)
        logger.info("Stream: processor ready")

        # ffmpeg to decode webm/opus -> raw PCM 16kHz mono
        ffmpeg_proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-i", "pipe:0",
            "-f", "s16le", "-ar", "16000", "-ac", "1", "pipe:1",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )

        async def read_pcm_and_process():
            """Read decoded PCM from ffmpeg stdout, feed to whisper processor."""
            nonlocal confirmed_segments
            CHUNK_BYTES = 16000 * 2  # 1 second of 16kHz 16-bit audio
            buf = b""

            while True:
                data = await ffmpeg_proc.stdout.read(CHUNK_BYTES)
                if not data:
                    break
                buf += data

                while len(buf) >= CHUNK_BYTES:
                    chunk = buf[:CHUNK_BYTES]
                    buf = buf[CHUNK_BYTES:]

                    audio_array = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0
                    processor.insert_audio_chunk(audio_array)

                    output = processor.process_iter()
                    if output[0] is not None:
                        confirmed_segments.append({
                            "start": round(output[0], 2),
                            "end": round(output[1], 2),
                            "text": output[2].strip(),
                            "speaker": "Speaker",
                        })

                    # Get unconfirmed buffer preview
                    try:
                        unconfirmed = processor.to_flush((None, None, ""))
                        unconfirmed_text = unconfirmed[2].strip() if unconfirmed and unconfirmed[2] else ""
                    except Exception:
                        unconfirmed_text = ""

                    try:
                        await ws.send_json({
                            "confirmed": confirmed_segments,
                            "unconfirmed": unconfirmed_text,
                        })
                    except Exception:
                        return

        pcm_task = asyncio.create_task(read_pcm_and_process())

        # Receive audio chunks from client and pipe to ffmpeg
        while True:
            data = await ws.receive_bytes()
            if ffmpeg_proc.stdin:
                ffmpeg_proc.stdin.write(data)
                await ffmpeg_proc.stdin.drain()

    except WebSocketDisconnect:
        logger.info("Stream client disconnected")
    except Exception as e:
        logger.error(f"Stream error: {e}", exc_info=True)
        try:
            await ws.send_json({"error": str(e)})
        except Exception:
            pass
    finally:
        # Close ffmpeg stdin to signal EOF
        if ffmpeg_proc and ffmpeg_proc.stdin:
            try:
                ffmpeg_proc.stdin.close()
            except Exception:
                pass

        # Wait for pcm_task to finish processing remaining data
        if pcm_task:
            try:
                await asyncio.wait_for(pcm_task, timeout=5.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pcm_task.cancel()

        # Flush remaining audio in processor
        if processor:
            try:
                final = processor.finish()
                if final and final[2] and final[2].strip():
                    confirmed_segments.append({
                        "start": round(final[0] or 0, 2),
                        "end": round(final[1] or 0, 2),
                        "text": final[2].strip(),
                        "speaker": "Speaker",
                    })
                    await ws.send_json({
                        "confirmed": confirmed_segments,
                        "unconfirmed": "",
                    })
            except Exception:
                pass

        # Clean up ffmpeg process
        if ffmpeg_proc:
            try:
                ffmpeg_proc.kill()
                await ffmpeg_proc.wait()
            except Exception:
                pass
