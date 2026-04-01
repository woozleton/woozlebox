"""
video-api - Text-to-video and image-to-video service using LTX-2.

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
import httpx
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

HF_CACHE = os.environ.get("HF_HOME", "/root/.cache/huggingface")
OLLAMA_URL = os.environ.get("OLLAMA_BASE_URL", "http://ollama:11434")
UTILITY_MODEL = os.environ.get("UTILITY_MODEL", "qwen3:0.6b")
LTX_MODEL_ID = os.environ.get("LTX_MODEL_ID", "Lightricks/LTX-2")


def _is_utility_model(name: str) -> bool:
    return name.split(":")[0].lower() == UTILITY_MODEL.split(":")[0].lower()


# -- Global state --
_t2v_pipe = None
_i2v_pipe = None
_upsampler = None
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
    """Load LTX-2 pipelines with sequential CPU offloading for 24GB VRAM."""
    global _t2v_pipe, _i2v_pipe, _upsampler, _model_loaded

    logger.info("Loading LTX-2 model...")
    t0 = time.time()

    from diffusers.pipelines.ltx2 import LTX2Pipeline, LTX2LatentUpsamplePipeline

    # Load text-to-video pipeline
    _t2v_pipe = LTX2Pipeline.from_pretrained(
        LTX_MODEL_ID,
        torch_dtype=torch.bfloat16,
    )
    _t2v_pipe.enable_sequential_cpu_offload(device="cuda:0")
    _t2v_pipe.vae.enable_tiling()
    logger.info("T2V pipeline loaded with sequential CPU offload + VAE tiling")

    # Load upsampler for two-stage generation
    try:
        _upsampler = LTX2LatentUpsamplePipeline.from_pretrained(
            LTX_MODEL_ID,
            vae=_t2v_pipe.vae,
            torch_dtype=torch.bfloat16,
        )
        _upsampler.enable_sequential_cpu_offload(device="cuda:0")
        logger.info("Upsampler pipeline loaded")
    except Exception as e:
        logger.warning(f"Upsampler not available ({e}), using single-stage only")
        _upsampler = None

    # Create I2V pipeline sharing components
    try:
        from diffusers.pipelines.ltx2 import LTX2ImageToVideoPipeline
        _i2v_pipe = LTX2ImageToVideoPipeline(**_t2v_pipe.components)
        _i2v_pipe.enable_sequential_cpu_offload(device="cuda:0")
        _i2v_pipe.vae.enable_tiling()
        logger.info("I2V pipeline shares T2V components")
    except Exception as e:
        logger.warning(f"I2V pipeline not available ({e}), image-to-video disabled")
        _i2v_pipe = None

    _model_loaded = True
    gc.collect()

    vram = torch.cuda.memory_allocated() // 1024 // 1024
    logger.info(f"LTX-2 ready in {time.time()-t0:.1f}s - VRAM: {vram}MB")


@app.on_event("startup")
async def startup():
    logger.info("Video API started - model will load on first request or /models/load")


def _snap_frames(n: int) -> int:
    """Snap frame count to nearest 8N+1 value (required by LTX-2)."""
    return max(9, round((n - 1) / 8) * 8 + 1)


class VideoGenerateRequest(BaseModel):
    prompt: str
    image: Optional[str] = None
    negative_prompt: Optional[str] = None
    num_frames: Optional[int] = 121
    height: Optional[int] = 512
    width: Optional[int] = 768
    fps: Optional[int] = 24
    num_inference_steps: Optional[int] = 40
    guidance_scale: Optional[float] = 4.0
    seed: Optional[int] = None


@app.get("/health")
def health():
    vram_mb = torch.cuda.memory_allocated() // 1024 // 1024 if _model_loaded else 0
    return {
        "ok": True,
        "model_loaded": _model_loaded,
        "current_model": "ltx-2" if _model_loaded else None,
        "i2v_available": _i2v_pipe is not None,
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
        return {"ok": True, "already_loaded": True, "model": "ltx-2", "vram_mb": vram}
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _load_model)
    vram = torch.cuda.memory_allocated() // 1024 // 1024
    return {"ok": True, "already_loaded": False, "model": "ltx-2", "vram_mb": vram}


@app.post("/models/unload")
async def unload_model():
    global _t2v_pipe, _i2v_pipe, _upsampler, _model_loaded
    if not _model_loaded:
        return {"ok": True, "was_loaded": False}

    logger.info("Unloading LTX-2 to free VRAM")
    _t2v_pipe = None
    _i2v_pipe = None
    _upsampler = None
    _model_loaded = False
    gc.collect()
    torch.cuda.empty_cache()
    vram = torch.cuda.memory_allocated() // 1024 // 1024
    logger.info(f"Unloaded LTX-2 - VRAM after: {vram}MB")
    return {"ok": True, "was_loaded": True, "freed_model": "ltx-2", "vram_mb": vram}


async def _evict_ollama():
    """Evict all Ollama models from VRAM before inference."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            ps = await client.get(f"{OLLAMA_URL}/api/ps")
            loaded_models = [m.get("name", "") for m in ps.json().get("models", []) if m.get("name")]
            evicted = []
            for model_name in loaded_models:
                if _is_utility_model(model_name):
                    continue
                logger.info(f"Evicting {model_name} from VRAM")
                await client.post(f"{OLLAMA_URL}/api/generate", json={"model": model_name, "keep_alive": 0})
                evicted.append(model_name)
        if evicted:
            for _ in range(30):
                await asyncio.sleep(1)
                async with httpx.AsyncClient(timeout=5) as client:
                    ps = await client.get(f"{OLLAMA_URL}/api/ps")
                    remaining = [m.get("name", "") for m in ps.json().get("models", []) if m.get("name") and not _is_utility_model(m.get("name", ""))]
                    if not remaining:
                        break
            await asyncio.sleep(1)
            logger.info("Ollama VRAM cleared")
    except Exception as e:
        logger.warning(f"Could not evict Ollama models: {e}")


@app.post("/generate")
async def generate(req: VideoGenerateRequest):
    global _model_loaded, _cancel_requested

    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required")

    # Reload model if it was unloaded
    if not _model_loaded:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _load_model)

    # Evict Ollama models from VRAM
    await _evict_ollama()

    # Determine mode
    is_i2v = req.image is not None and req.image.strip()
    if is_i2v and _i2v_pipe is None:
        raise HTTPException(status_code=400, detail="Image-to-video is not available")

    # Clamp and snap parameters
    num_frames = _snap_frames(max(9, min(257, req.num_frames or 121)))
    height = max(256, min(1080, req.height or 512))
    width = max(256, min(1920, req.width or 768))
    height = (height // 32) * 32
    width = (width // 32) * 32
    fps = max(8, min(30, req.fps or 24))
    steps = max(1, min(50, req.num_inference_steps or 40))
    guidance = max(1.0, min(15.0, req.guidance_scale or 4.0))
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

            neg_prompt = req.negative_prompt or "shaky, glitchy, low quality, worst quality, deformed, distorted, motion smear"

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
                output_type="np",
            )

            if is_i2v:
                img_bytes = base64.b64decode(req.image)
                img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
                img = img.resize((width, height), Image.LANCZOS)
                kwargs["image"] = img
                result = _i2v_pipe(**kwargs)
            else:
                result = _t2v_pipe(**kwargs)

            return result

        result = await loop.run_in_executor(None, _run_inference)

        # Extract video frames
        videos = result.videos if hasattr(result, "videos") else None
        frames_np = result.frames[0] if hasattr(result, "frames") and result.frames else None

        if videos is not None:
            # videos is numpy array [batch, frames, height, width, channels]
            video_np = videos[0] if len(videos.shape) == 5 else videos
        elif frames_np is not None:
            video_np = np.array([np.array(f) for f in frames_np])
        else:
            raise HTTPException(status_code=500, detail="No video returned from model")

        # Check for audio
        has_audio = hasattr(result, "audios") and result.audios is not None

        # Encode to MP4
        # Write frames to temp file, then read back as bytes
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
            tmp_path = tmp.name

        try:
            # Try using diffusers' built-in export if audio is available
            if has_audio:
                try:
                    from diffusers.utils import export_to_video
                    export_to_video(video_np, tmp_path, fps=fps)
                    # TODO: mux audio when diffusers supports it
                except Exception:
                    pass

            # Fallback: write video with imageio
            if not os.path.exists(tmp_path) or os.path.getsize(tmp_path) == 0:
                import imageio
                writer = imageio.get_writer(tmp_path, format="mp4", fps=fps, codec="libx264",
                                            output_params=["-pix_fmt", "yuv420p", "-crf", "23"])
                for frame in video_np:
                    if frame.dtype != np.uint8:
                        if frame.max() <= 1.0:
                            frame = (frame * 255).astype(np.uint8)
                        else:
                            frame = frame.astype(np.uint8)
                    writer.append_data(frame)
                writer.close()

            with open(tmp_path, "rb") as f:
                mp4_bytes = f.read()
        finally:
            os.unlink(tmp_path)

        video_b64 = base64.b64encode(mp4_bytes).decode()
        actual_duration = round(len(video_np) / fps, 2)

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
        "num_frames": len(video_np),
        "fps": fps,
        "duration": actual_duration,
        "has_audio": has_audio,
        "seed": seed,
        "model": "LTX-2",
    }
