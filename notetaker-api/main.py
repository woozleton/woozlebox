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
from pathlib import Path
from typing import Optional

import torch
import numpy as np
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

HF_CACHE = os.environ.get("HF_HOME", "/root/.cache/huggingface")
HF_TOKEN = os.environ.get("HF_TOKEN", "")
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
AUDIO_DIR = DATA_DIR / "audio"
AUDIO_DIR.mkdir(parents=True, exist_ok=True)

SUPPORTED_FORMATS = {".wav", ".mp3", ".m4a", ".flac", ".mp4", ".mkv", ".webm", ".mov", ".ogg", ".wma"}
VIDEO_FORMATS = {".mp4", ".mkv", ".webm", ".mov"}

WHISPER_MODELS = ["tiny", "base", "small", "medium", "large-v3"]

# -- Global state --
_whisper_model = None
_current_model_name = None
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


def _load_whisper_model(model_name: str = "base"):
    """Load a whisperX model onto GPU."""
    global _whisper_model, _current_model_name
    import whisperx

    if _whisper_model is not None and _current_model_name == model_name:
        return

    # Unload existing model first
    if _whisper_model is not None:
        _unload_model()

    logger.info(f"Loading whisperX model: {model_name}")
    t0 = time.time()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"

    _whisper_model = whisperx.load_model(
        model_name,
        device=device,
        compute_type=compute_type,
        download_root=HF_CACHE,
    )
    _current_model_name = model_name

    vram = torch.cuda.memory_allocated() // 1024 // 1024 if device == "cuda" else 0
    logger.info(f"whisperX {model_name} ready in {time.time()-t0:.1f}s - VRAM: {vram}MB")


def _load_diarize_pipeline():
    """Load the pyannote diarization pipeline."""
    global _diarize_pipeline
    import whisperx

    if _diarize_pipeline is not None:
        return

    if not HF_TOKEN:
        raise RuntimeError("HF_TOKEN required for speaker diarization. Set it in your environment.")

    logger.info("Loading diarization pipeline...")
    t0 = time.time()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    _diarize_pipeline = whisperx.DiarizationPipeline(
        use_auth_token=HF_TOKEN,
        device=device,
    )

    logger.info(f"Diarization pipeline ready in {time.time()-t0:.1f}s")


def _unload_model():
    """Unload whisper model and diarization pipeline to free VRAM."""
    global _whisper_model, _current_model_name, _diarize_pipeline

    _whisper_model = None
    _current_model_name = None
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
            _load_diarize_pipeline()
            diarize_kwargs = {}
            if num_speakers and num_speakers > 0:
                diarize_kwargs["num_speakers"] = num_speakers

            diarize_segments = _diarize_pipeline(audio, **diarize_kwargs)
            result = whisperx.assign_word_speakers(diarize_segments, result)
        except Exception as e:
            logger.warning(f"Diarization failed (non-fatal, no speaker labels): {e}")

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
    vram = 0
    if torch.cuda.is_available():
        vram = torch.cuda.memory_allocated() // 1024 // 1024
    return {
        "ok": True,
        "model_loaded": _whisper_model is not None,
        "current_model": _current_model_name,
        "vram_mb": vram,
        "diarize_loaded": _diarize_pipeline is not None,
    }


# -- Models --

@app.get("/models")
async def list_models():
    return {
        "models": WHISPER_MODELS,
        "current": _current_model_name,
        "loaded": _whisper_model is not None,
    }


class LoadModelRequest(BaseModel):
    model: str = "base"


@app.post("/models/load")
async def load_model(req: LoadModelRequest):
    if req.model not in WHISPER_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown model: {req.model}. Choose from: {WHISPER_MODELS}")
    try:
        await asyncio.to_thread(_load_whisper_model, req.model)
        return {"ok": True, "model": req.model}
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
    model: str = Form("base"),
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
    model: str = Form("base"),
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
