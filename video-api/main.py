"""
video-api - Text-to-video and image-to-video service using LTX Video 2.3.

POST /generate   {prompt, image, negative_prompt, num_frames, height, width, fps, num_inference_steps, guidance_scale, seed}
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
LTX_MODEL_ID = os.environ.get("LTX_MODEL_ID", "Lightricks/LTX-Video")


def _is_utility_model(name: str) -> bool:
    return name.split(":")[0].lower() == UTILITY_MODEL.split(":")[0].lower()


# -- Global state --
_t2v_pipe = None
_i2v_pipe = None
_model_loaded = False

_progress = {
    "running": False,
    "step": 0,
    "total_steps": 0,
    "elapsed_s": 0.0,
    "started_at": 0.0,
}

app = FastAPI(title="video-api")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _load_model():
    """Load LTX Video pipelines onto GPU with int8 quantization."""
    global _t2v_pipe, _i2v_pipe, _model_loaded

    logger.info("Loading LTX Video 2.3 model...")
    t0 = time.time()

    from diffusers import LTXPipeline, LTXImageToVideoPipeline

    try:
        from diffusers import BitsAndBytesConfig
        quant_config = BitsAndBytesConfig(load_in_8bit=True)
        logger.info("Using int8 quantization via BitsAndBytesConfig")
        _t2v_pipe = LTXPipeline.from_pretrained(
            LTX_MODEL_ID,
            quantization_config=quant_config,
            torch_dtype=torch.float16,
        )
    except (ImportError, TypeError, ValueError) as e:
        logger.warning(f"int8 quantization not available ({e}), loading in fp16")
        _t2v_pipe = LTXPipeline.from_pretrained(
            LTX_MODEL_ID,
            torch_dtype=torch.float16,
        )
        _t2v_pipe.to("cuda")

    try:
        _i2v_pipe = LTXImageToVideoPipeline(**_t2v_pipe.components)
        logger.info("I2V pipeline shares T2V components")
    except Exception as e:
        logger.warning(f"Component sharing failed ({e}), loading I2V separately")
        try:
            _i2v_pipe = LTXImageToVideoPipeline.from_pretrained(
                LTX_MODEL_ID,
                torch_dtype=torch.float16,
            )
            _i2v_pipe.to("cuda")
        except Exception as e2:
            logger.warning(f"I2V pipeline not available ({e2}), image-to-video disabled")
            _i2v_pipe = None

    _model_loaded = True

    vram = torch.cuda.memory_allocated() // 1024 // 1024
    logger.info(f"LTX Video ready in {time.time()-t0:.1f}s - VRAM: {vram}MB")


@app.on_event("startup")
async def startup():
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _load_model)


class VideoGenerateRequest(BaseModel):
    prompt: str
    image: Optional[str] = None
    negative_prompt: Optional[str] = None
    num_frames: Optional[int] = 97
    height: Optional[int] = 480
    width: Optional[int] = 704
    fps: Optional[int] = 24
    num_inference_steps: Optional[int] = 30
    guidance_scale: Optional[float] = 7.5
    seed: Optional[int] = None


@app.get("/health")
def health():
    vram_mb = torch.cuda.memory_allocated() // 1024 // 1024 if _model_loaded else 0
    return {
        "ok": True,
        "model_loaded": _model_loaded,
        "current_model": "ltx-video-2.3" if _model_loaded else None,
        "i2v_available": _i2v_pipe is not None,
        "vram_mb": vram_mb,
    }


@app.get("/progress")
def progress():
    p = _progress.copy()
    if p["running"] and p["started_at"]:
        p["elapsed_s"] = round(time.time() - p["started_at"], 1)
    return p


@app.post("/models/load")
async def load_model():
    global _model_loaded
    if _model_loaded:
        vram = torch.cuda.memory_allocated() // 1024 // 1024
        return {"ok": True, "already_loaded": True, "model": "ltx-video-2.3", "vram_mb": vram}
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _load_model)
    vram = torch.cuda.memory_allocated() // 1024 // 1024
    return {"ok": True, "already_loaded": False, "model": "ltx-video-2.3", "vram_mb": vram}


@app.post("/models/unload")
async def unload_model():
    global _t2v_pipe, _i2v_pipe, _model_loaded
    if not _model_loaded:
        return {"ok": True, "was_loaded": False}

    logger.info("Unloading LTX Video to free VRAM")
    _t2v_pipe = None
    _i2v_pipe = None
    _model_loaded = False
    gc.collect()
    torch.cuda.empty_cache()
    vram = torch.cuda.memory_allocated() // 1024 // 1024
    logger.info(f"Unloaded LTX Video - VRAM after: {vram}MB")
    return {"ok": True, "was_loaded": True, "freed_model": "ltx-video-2.3", "vram_mb": vram}


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


def _encode_video_mp4(frames, fps: int) -> bytes:
    """Encode list of PIL Images or numpy frames to MP4 bytes."""
    import imageio

    buf = io.BytesIO()
    writer = imageio.get_writer(buf, format="mp4", fps=fps, codec="libx264",
                                output_params=["-pix_fmt", "yuv420p", "-crf", "23"])
    for frame in frames:
        if hasattr(frame, "convert"):
            frame = np.array(frame)
        if frame.dtype != np.uint8:
            if frame.max() <= 1.0:
                frame = (frame * 255).astype(np.uint8)
            else:
                frame = frame.astype(np.uint8)
        writer.append_data(frame)
    writer.close()
    return buf.getvalue()


@app.post("/generate")
async def generate(req: VideoGenerateRequest):
    global _model_loaded

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

    # Clamp parameters
    num_frames = max(9, min(257, req.num_frames or 97))
    # Ensure num_frames is compatible (many video models need specific frame counts)
    height = max(256, min(1080, req.height or 480))
    width = max(256, min(1920, req.width or 704))
    # Ensure divisible by 32
    height = (height // 32) * 32
    width = (width // 32) * 32
    fps = max(8, min(30, req.fps or 24))
    steps = max(1, min(50, req.num_inference_steps or 30))
    guidance = max(1.0, min(15.0, req.guidance_scale or 7.5))
    seed = req.seed if req.seed is not None and req.seed >= 0 else -1
    use_random = (seed == -1)

    if use_random:
        import random
        seed = random.randint(0, 2147483647)

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
            generator = torch.Generator(device="cuda").manual_seed(seed)

            def _step_callback(pipe, step_index, timestep, callback_kwargs):
                _progress["step"] = step_index + 1
                return callback_kwargs

            kwargs = dict(
                prompt=req.prompt,
                negative_prompt=req.negative_prompt or "",
                num_frames=num_frames,
                height=height,
                width=width,
                num_inference_steps=steps,
                guidance_scale=guidance,
                generator=generator,
                callback_on_step_end=_step_callback,
            )

            if is_i2v:
                img_bytes = base64.b64decode(req.image)
                img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
                img = img.resize((width, height), Image.LANCZOS)
                kwargs["image"] = img
                return _i2v_pipe(**kwargs)
            else:
                return _t2v_pipe(**kwargs)

        result = await loop.run_in_executor(None, _run_inference)

        # Extract frames from result
        # diffusers returns result.frames as a list of lists of PIL Images
        frames = result.frames[0] if hasattr(result, "frames") else []
        if not frames:
            raise HTTPException(status_code=500, detail="No frames returned from model")

        # Check for audio in result
        has_audio = hasattr(result, "audio") and result.audio is not None

        # Encode video
        mp4_bytes = _encode_video_mp4(frames, fps)
        video_b64 = base64.b64encode(mp4_bytes).decode()

        actual_duration = round(len(frames) / fps, 2)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Video generation failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")
    finally:
        _progress["running"] = False

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
        "has_audio": has_audio,
        "seed": seed,
        "model": "LTX Video 2.3",
    }
