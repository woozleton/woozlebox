"""
video-api - Text-to-video service using Wan 2.1 T2V 1.3B.

POST /generate   {prompt, image, negative_prompt, num_frames, height, width, fps, num_inference_steps, guidance_scale, seed}
GET  /health
GET  /progress
POST /cancel
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
import tempfile
from typing import Optional

import torch
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

HF_CACHE = os.environ.get("HF_HOME", "/root/.cache/huggingface")
MODEL_ID = os.environ.get("VIDEO_MODEL_ID", "Wan-AI/Wan2.1-T2V-1.3B-Diffusers")


# -- Global state --
_pipe = None
_model_loaded = False

_progress = {
    "running": False,
    "step": 0,
    "total_steps": 0,
    "elapsed_s": 0.0,
    "started_at": 0.0,
}
_cancel_requested = False

app = FastAPI(title="video-api")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _load_model():
    """Load Wan 2.1 T2V 1.3B with FP8 quantization, entirely on GPU."""
    global _pipe, _model_loaded

    logger.info("Loading Wan 2.1 T2V 1.3B...")
    t0 = time.time()

    from diffusers import WanPipeline, AutoencoderKLWan

    vae = AutoencoderKLWan.from_pretrained(MODEL_ID, subfolder="vae", torch_dtype=torch.float32)
    _pipe = WanPipeline.from_pretrained(MODEL_ID, vae=vae, torch_dtype=torch.bfloat16)
    _pipe.to("cuda")
    gc.collect()
    logger.info("Pipeline moved to CUDA")

    _model_loaded = True
    gc.collect()

    vram = torch.cuda.memory_allocated() // 1024 // 1024
    logger.info(f"Wan 2.1 ready in {time.time()-t0:.1f}s - VRAM: {vram}MB")


@app.on_event("startup")
async def startup():
    logger.info("Video API started - model will load on first request or /models/load")


def _snap_frames(n: int) -> int:
    """Snap frame count to nearest 4N+1 value (required by Wan)."""
    return max(5, round((n - 1) / 4) * 4 + 1)


class VideoGenerateRequest(BaseModel):
    prompt: str
    image: Optional[str] = None
    negative_prompt: Optional[str] = None
    num_frames: Optional[int] = 81
    height: Optional[int] = 704
    width: Optional[int] = 1280
    fps: Optional[int] = 24
    num_inference_steps: Optional[int] = 30
    guidance_scale: Optional[float] = 5.0
    seed: Optional[int] = None


@app.get("/health")
def health():
    vram_mb = torch.cuda.memory_allocated() // 1024 // 1024 if _model_loaded else 0
    return {
        "ok": True,
        "model_loaded": _model_loaded,
        "current_model": "wan-2.1-t2v-1.3b" if _model_loaded else None,
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
    global _model_loaded
    if _model_loaded:
        vram = torch.cuda.memory_allocated() // 1024 // 1024
        return {"ok": True, "already_loaded": True, "model": "wan-2.1-t2v-1.3b", "vram_mb": vram}
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _load_model)
    vram = torch.cuda.memory_allocated() // 1024 // 1024
    return {"ok": True, "already_loaded": False, "model": "wan-2.1-t2v-1.3b", "vram_mb": vram}


@app.post("/models/unload")
async def unload_model():
    global _pipe, _model_loaded
    if not _model_loaded:
        return {"ok": True, "was_loaded": False}

    logger.info("Unloading Wan 2.1 to free VRAM")
    _pipe = None
    _model_loaded = False
    gc.collect()
    torch.cuda.empty_cache()
    vram = torch.cuda.memory_allocated() // 1024 // 1024
    logger.info(f"Unloaded Wan 2.1 - VRAM after: {vram}MB")
    return {"ok": True, "was_loaded": True, "freed_model": "wan-2.1-t2v-1.3b", "vram_mb": vram}


WAN_NEGATIVE_PROMPT = (
    "Bright tones, overexposed, static, blurred details, subtitles, style, works, paintings, images, "
    "static, overall gray, worst quality, low quality, JPEG compression residue, ugly, incomplete, "
    "extra fingers, poorly drawn hands, poorly drawn faces, deformed, disfigured, misshapen limbs, "
    "fused fingers, still picture, messy background, three legs, many people in the background, walking backwards"
)


@app.post("/generate")
async def generate(req: VideoGenerateRequest):
    global _model_loaded, _cancel_requested

    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required")

    # Reload model if it was unloaded
    if not _model_loaded:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _load_model)

    # Clamp and snap parameters
    num_frames = _snap_frames(max(5, min(257, req.num_frames or 81)))
    height = max(256, min(1080, req.height or 704))
    width = max(256, min(1920, req.width or 1280))
    height = (height // 16) * 16
    width = (width // 16) * 16
    fps = max(8, min(30, req.fps or 24))
    steps = max(1, min(50, req.num_inference_steps or 30))
    guidance = max(1.0, min(15.0, req.guidance_scale or 5.0))
    seed = req.seed if req.seed is not None and req.seed >= 0 else -1

    if seed == -1:
        import random
        seed = random.randint(0, 2147483647)

    _cancel_requested = False
    _progress.update({
        "running": True,
        "step": 0,
        "total_steps": steps,
        "elapsed_s": 0.0,
        "started_at": time.time(),
    })

    t0 = time.time()

    try:
        loop = asyncio.get_event_loop()

        def _run_inference():
            generator = torch.Generator(device="cpu").manual_seed(seed)

            def _step_callback(pipe, step_index, timestep, callback_kwargs):
                _progress["step"] = step_index + 1
                if _cancel_requested:
                    raise RuntimeError("Generation cancelled by user")
                return callback_kwargs

            neg_prompt = req.negative_prompt or WAN_NEGATIVE_PROMPT

            kwargs = dict(
                prompt=req.prompt,
                negative_prompt=neg_prompt,
                num_frames=num_frames,
                height=height,
                width=width,
                num_inference_steps=steps,
                guidance_scale=guidance,
                generator=generator,
                callback_on_step_end=_step_callback,
            )

            # I2V: pass image parameter
            if req.image and req.image.strip():
                img_bytes = base64.b64decode(req.image)
                img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
                img = img.resize((width, height), Image.LANCZOS)
                kwargs["image"] = img

            return _pipe(**kwargs)

        result = await loop.run_in_executor(None, _run_inference)

        # Extract frames - WanPipeline returns .frames[0] as list of PIL Images
        frames = result.frames[0] if hasattr(result, "frames") and result.frames else None
        if not frames:
            raise HTTPException(status_code=500, detail="No video frames returned from model")

        # Encode to MP4 via temp file
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
            tmp_path = tmp.name

        try:
            from diffusers.utils import export_to_video
            export_to_video(frames, tmp_path, fps=fps)

            with open(tmp_path, "rb") as f:
                mp4_bytes = f.read()
        finally:
            os.unlink(tmp_path)

        video_b64 = base64.b64encode(mp4_bytes).decode()
        actual_duration = round(len(frames) / fps, 2)

    except HTTPException:
        raise
    except Exception as e:
        if _cancel_requested:
            logger.info("Video generation cancelled by user")
            raise HTTPException(status_code=499, detail="Generation cancelled")
        logger.error(f"Video generation failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")
    finally:
        _progress["running"] = False
        _cancel_requested = False

    elapsed = round(time.time() - t0, 2)
    logger.info(f"Generated video in {elapsed}s - {req.prompt[:60]}")

    return {
        "video": video_b64,
        "prompt": req.prompt,
        "elapsed_s": elapsed,
        "width": width,
        "height": height,
        "num_frames": len(frames),
        "fps": fps,
        "duration": actual_duration,
        "has_audio": False,
        "seed": seed,
        "model": "Wan 2.1",
    }
