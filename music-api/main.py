"""
music-api - Text-to-music service for Dave-in-a-Box using ACE-Step 1.5.

POST /generate   {prompt, lyrics, duration, infer_steps, guidance_scale, seed, instrumental, batch_size, vocal_language}
GET  /health
GET  /progress
POST /models/load
POST /models/unload
"""

import os
import io
import gc
import time
import base64
import logging
import asyncio
from typing import Optional

import torch
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

HF_CACHE = os.environ.get("HF_HOME", "/root/.cache/huggingface")
ACESTEP_ROOT = os.environ.get("ACESTEP_ROOT", "/opt/ace-step")

# ── Global state ──
_handler = None
_model_loaded = False

_progress = {
    "running": False,
    "step": 0,
    "total_steps": 0,
    "elapsed_s": 0.0,
    "started_at": 0.0,
}
_cancel_requested = False

app = FastAPI(title="music-api")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _progress_callback(ratio, desc=""):
    """Called by ACE-Step during inference to report progress (ratio 0.0-1.0)."""
    _progress["step"] = int(ratio * _progress["total_steps"])
    _progress["ratio"] = round(ratio, 3)


def _load_model():
    """Load ACE-Step model onto GPU."""
    global _handler, _model_loaded

    logger.info("Loading ACE-Step 1.5 model...")
    t0 = time.time()

    from acestep.handler import AceStepHandler

    handler = AceStepHandler()

    handler.initialize_service(
        project_root=ACESTEP_ROOT,
        config_path="acestep-v15-turbo",
        device="auto",
        use_flash_attention=False,
        compile_model=False,
    )

    _handler = handler
    _model_loaded = True

    vram = torch.cuda.memory_allocated() // 1024 // 1024
    logger.info(f"ACE-Step ready in {time.time()-t0:.1f}s -VRAM: {vram}MB")


@app.on_event("startup")
async def startup():
    logger.info("Music API started - model will load on first request or /models/load")


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


@app.get("/health")
def health():
    vram_mb = torch.cuda.memory_allocated() // 1024 // 1024 if _model_loaded else 0
    return {
        "ok": True,
        "model_loaded": _model_loaded,
        "current_model": "ace-step-1.5" if _model_loaded else None,
        "vram_mb": vram_mb,
    }


@app.get("/progress")
def progress():
    p = _progress.copy()
    if p["running"] and p["started_at"]:
        p["elapsed_s"] = round(time.time() - p["started_at"], 1)
    return p


@app.post("/cancel")
def cancel():
    global _cancel_requested
    if _progress["running"]:
        _cancel_requested = True
        return {"ok": True, "message": "Cancel requested"}
    return {"ok": True, "message": "Nothing running"}


@app.post("/models/load")
async def load_model():
    global _handler, _model_loaded
    if _model_loaded:
        vram = torch.cuda.memory_allocated() // 1024 // 1024
        return {"ok": True, "already_loaded": True, "model": "ace-step-1.5", "vram_mb": vram}
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _load_model)
    vram = torch.cuda.memory_allocated() // 1024 // 1024
    return {"ok": True, "already_loaded": False, "model": "ace-step-1.5", "vram_mb": vram}


@app.post("/models/unload")
async def unload_model():
    global _handler, _model_loaded
    if not _model_loaded:
        return {"ok": True, "was_loaded": False}

    logger.info("Unloading ACE-Step to free VRAM")
    if _handler is not None:
        try:
            _handler.llm_handler.unload()
        except Exception:
            pass
    _handler = None
    _model_loaded = False
    gc.collect()
    torch.cuda.empty_cache()
    vram = torch.cuda.memory_allocated() // 1024 // 1024
    logger.info(f"Unloaded ACE-Step -VRAM after: {vram}MB")
    return {"ok": True, "was_loaded": True, "freed_model": "ace-step-1.5", "vram_mb": vram}


def _encode_audio_mp3(audio_np: np.ndarray, sample_rate: int) -> bytes:
    """Encode numpy audio array to MP3 bytes using pydub."""
    from pydub import AudioSegment

    # Normalize to int16
    if audio_np.dtype in (np.float32, np.float64):
        peak = np.abs(audio_np).max()
        if peak > 0:
            audio_np = audio_np / peak
        audio_np = (audio_np * 32767).astype(np.int16)

    # Ensure correct shape
    if audio_np.ndim == 2 and audio_np.shape[0] <= 2:
        audio_np = audio_np.T
    if audio_np.ndim == 3:
        audio_np = audio_np.squeeze(0).T

    channels = audio_np.shape[1] if audio_np.ndim == 2 else 1
    seg = AudioSegment(
        data=audio_np.tobytes(),
        sample_width=2,
        frame_rate=sample_rate,
        channels=channels,
    )
    buf = io.BytesIO()
    seg.export(buf, format="mp3", bitrate="192k")
    return buf.getvalue()


@app.post("/generate")
async def generate(req: MusicGenerateRequest):
    global _handler, _model_loaded

    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required")

    # Reload model if it was unloaded
    if not _model_loaded:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _load_model)

    duration = max(10.0, min(600.0, req.duration or 30.0))
    infer_steps = max(1, min(50, req.infer_steps or 20))
    guidance = max(1.0, min(15.0, req.guidance_scale or 7.0))
    seed = req.seed if req.seed is not None and req.seed >= 0 else -1
    use_random = (seed == -1)

    lyrics_text = req.lyrics or ""
    if req.instrumental:
        lyrics_text = "[Instrumental]"

    global _cancel_requested
    _cancel_requested = False
    _progress.update({
        "running": True,
        "step": 0,
        "total_steps": infer_steps,
        "elapsed_s": 0.0,
        "started_at": time.time(),
    })

    t0 = time.time()

    try:
        loop = asyncio.get_event_loop()

        def _run_inference():
            logger.info(f"Starting ACE-Step inference (seed={seed}, {infer_steps} steps, {duration}s, guidance={guidance})")

            def _progress_cb(ratio, desc=""):
                _progress["step"] = int(ratio * _progress["total_steps"])
                _progress["ratio"] = round(ratio, 3)
                if _cancel_requested:
                    raise RuntimeError("Music generation cancelled by user")

            kwargs = dict(
                captions=req.prompt,
                lyrics=lyrics_text,
                inference_steps=infer_steps,
                guidance_scale=guidance,
                seed=seed,
                audio_duration=duration,
                use_random_seed=use_random,
                progress=_progress_cb,
            )
            if req.vocal_language:
                kwargs["vocal_language"] = req.vocal_language
            if req.bpm:
                kwargs["bpm"] = req.bpm

            return _handler.generate_music(**kwargs)

        result = await loop.run_in_executor(None, _run_inference)

        if not result.get("success", False):
            error_msg = result.get("error") or result.get("status_message") or "Unknown error"
            raise HTTPException(status_code=500, detail=f"Generation failed: {error_msg}")

        audios = result.get("audios", [])
        if not audios:
            raise HTTPException(status_code=500, detail="No audio returned from model")

        entry = audios[0]
        audio_data = entry["tensor"]
        sample_rate = entry.get("sample_rate", 48000)

        if hasattr(audio_data, "numpy"):
            audio_np = audio_data.cpu().numpy()
        elif isinstance(audio_data, np.ndarray):
            audio_np = audio_data
        else:
            audio_np = np.array(audio_data)

        if audio_np.ndim == 2 and audio_np.shape[0] <= 2:
            audio_np = audio_np.T
        if audio_np.ndim == 3:
            audio_np = audio_np.squeeze(0).T

        mp3_bytes = _encode_audio_mp3(audio_np, sample_rate)
        audio_b64 = base64.b64encode(mp3_bytes).decode()
        actual_duration = round(len(audio_np) / sample_rate, 2)

    except HTTPException:
        raise
    except Exception as e:
        if _cancel_requested:
            logger.info("Music generation cancelled by user")
            raise HTTPException(status_code=499, detail="Generation cancelled")
        logger.error(f"Music generation failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")
    finally:
        _progress["running"] = False
        _cancel_requested = False

    elapsed = round(time.time() - t0, 2)
    logger.info(f"Generated track in {elapsed}s -{req.prompt[:60]}")

    return {
        "audio": audio_b64,
        "prompt": req.prompt,
        "lyrics": lyrics_text if lyrics_text != "[Instrumental]" else None,
        "duration": actual_duration,
        "elapsed_s": elapsed,
        "sample_rate": sample_rate,
        "seed": seed,
        "model": "ACE-Step 1.5",
        "format": "mp3",
    }
