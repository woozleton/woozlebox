"""
video-api - Text-to-video service using Wan 2.1 T2V 1.3B.

POST /generate   {prompt, negative_prompt, num_frames, height, width, fps, num_inference_steps, guidance_scale, seed}
GET  /health
GET  /progress
POST /cancel
POST /models/load
POST /models/unload
"""

import os
import gc
import time
import base64
import logging
import asyncio
import tempfile
import threading
from typing import Optional

import httpx
import torch
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

HF_CACHE = os.environ.get("HF_HOME", "/root/.cache/huggingface")
MODEL_ID = os.environ.get("VIDEO_MODEL_ID", "Wan-AI/Wan2.1-T2V-1.3B-Diffusers")
GPU_MANAGER_URL = os.environ.get("GPU_MANAGER_URL", "http://gpu-manager:8400")
SERVICE_NAME = "video"


# ── Load-status tracker ─────────────────────────────────────────────
# Exposes the current model-load phase (idle/loading/downloading/ready/error)
# so gpu-manager and the web UI can show live download progress instead of a
# generic spinner. Watches the per-repo HF cache subdir for byte growth to
# detect a real download regardless of which loader path is active.
LOAD_STATUS = {
    "state": "idle", "model": "", "repo": "", "phase": "",
    "downloaded_bytes": 0, "started_at": 0.0, "updated_at": 0.0,
}
_ls_stop: Optional[threading.Event] = None


def _ls_repo_dir(repo: str) -> str:
    return os.path.join(HF_CACHE, "hub", "models--" + repo.replace("/", "--"))


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


def ls_begin(model: str, repo: str, phase: str = "Loading"):
    """Mark the start of a model load and spawn the cache-dir watcher."""
    global _ls_stop
    now = time.time()
    LOAD_STATUS.update({
        "state": "loading", "model": model, "repo": repo,
        "phase": phase, "downloaded_bytes": 0,
        "started_at": now, "updated_at": now,
    })
    _ls_post("load_begin", phase)

    repo_dir = _ls_repo_dir(repo)
    baseline = _ls_dir_size(repo_dir) if os.path.exists(repo_dir) else 0
    stop = threading.Event()
    _ls_stop = stop

    def _watch():
        last_emit = 0
        while not stop.is_set():
            time.sleep(1.0)
            try:
                delta = max(0, _ls_dir_size(repo_dir) - baseline)
            except Exception:
                delta = 0
            if delta > 0:
                if LOAD_STATUS["state"] != "downloading":
                    LOAD_STATUS["state"] = "downloading"
                    LOAD_STATUS["phase"] = f"Downloading {repo}"
                    _ls_post("download", f"downloading {repo}")
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


class GatedRepoError(Exception):
    """Raised when a HuggingFace model requires license acceptance."""
    def __init__(self, repo_url: str, message: str = ""):
        self.repo_url = repo_url
        super().__init__(message or f"Accept terms at {repo_url}")


def _check_gated_repo_error(exc):
    """If exc is a HuggingFace gated repo error, raise GatedRepoError with the repo URL."""
    name = type(exc).__name__
    msg = str(exc)
    if "GatedRepoError" in name or ("403" in msg and "huggingface.co" in msg):
        import re
        m = re.search(r"https://huggingface\.co/([^\s/]+/[^\s/]+)", msg)
        repo = m.group(1) if m else "unknown"
        raise GatedRepoError(
            f"https://huggingface.co/{repo}",
            f"HuggingFace repo '{repo}' is gated. Accept terms at https://huggingface.co/{repo}"
        ) from exc


def _load_model():
    """Load Wan 2.1 T2V 1.3B with FP8 quantization, entirely on GPU."""
    global _pipe, _model_loaded

    logger.info("Loading Wan 2.1 T2V 1.3B...")
    t0 = time.time()
    ls_begin(model="wan-2.1-t2v-1.3b", repo=MODEL_ID, phase="Loading Wan 2.1 T2V")

    from diffusers import WanPipeline, AutoencoderKLWan

    try:
        vae = AutoencoderKLWan.from_pretrained(
            MODEL_ID, subfolder="vae", torch_dtype=torch.float32, cache_dir=HF_CACHE
        )
        _pipe = WanPipeline.from_pretrained(
            MODEL_ID, vae=vae, torch_dtype=torch.bfloat16, cache_dir=HF_CACHE
        )
    except GatedRepoError as e:
        ls_error(str(e))
        raise
    except Exception as e:
        try:
            _check_gated_repo_error(e)
        except GatedRepoError as ge:
            ls_error(str(ge))
            raise
        ls_error(str(e))
        raise

    LOAD_STATUS["phase"] = "Moving to VRAM"
    LOAD_STATUS["updated_at"] = time.time()
    _pipe.to("cuda")
    # Belt-and-braces: WanPipeline.to() does not always migrate an externally
    # constructed VAE that was passed in as a kwarg, leaving it on CPU and
    # producing a "tensors on cuda:0 vs cpu" error during decode. Move each
    # major component explicitly so they all land on the GPU.
    for _name in ("vae", "transformer", "text_encoder"):
        _comp = getattr(_pipe, _name, None)
        if _comp is not None and hasattr(_comp, "to"):
            _comp.to("cuda")
    gc.collect()
    logger.info("Pipeline moved to CUDA")

    _model_loaded = True
    gc.collect()

    vram = torch.cuda.memory_allocated() // 1024 // 1024
    logger.info(f"Wan 2.1 ready in {time.time()-t0:.1f}s - VRAM: {vram}MB")
    ls_ready(vram)


@app.on_event("startup")
async def startup():
    logger.info("Video API started - model will load on first request or /models/load")


def _snap_frames(n: int) -> int:
    """Snap frame count to nearest 4N+1 value (required by Wan)."""
    return max(5, round((n - 1) / 4) * 4 + 1)


class VideoGenerateRequest(BaseModel):
    prompt: str
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
        "display_name": "Wan 2.1 T2V 1.3B",
        "vram_mb": vram_mb,
    }


@app.get("/models/status")
def models_status():
    """Live model-load state for the web UI spinner. Returns phase + bytes."""
    s = LOAD_STATUS.copy()
    if s.get("started_at"):
        s["elapsed_s"] = round(time.time() - s["started_at"], 1)
    return s


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
    try:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _load_model)
    except GatedRepoError as e:
        raise HTTPException(status_code=403, detail=str(e), headers={"X-Gated-Repo": e.repo_url})
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

            # inference_mode() skips autograd bookkeeping, cutting peak VRAM
            # noticeably during the diffusion loop and VAE decode.
            with torch.inference_mode():
                return _pipe(
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

        result = await loop.run_in_executor(None, _run_inference)

        # Extract frames - WanPipeline.frames is a (batch, num_frames, H, W, C) numpy
        # array, not a list. Don't use truthiness on it (raises "ambiguous truth
        # value" on multi-element arrays); check attribute and length explicitly.
        frames_attr = getattr(result, "frames", None)
        if frames_attr is None or len(frames_attr) == 0:
            raise HTTPException(status_code=500, detail="No video frames returned from model")
        frames = frames_attr[0]
        if len(frames) == 0:
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
        # Reclaim VRAM. If generation crashed mid-pipeline, orphaned tensors
        # can otherwise pin all 24 GB of the 4090 until the process restarts.
        # Also keeps peak VRAM low between back-to-back generations.
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()

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
