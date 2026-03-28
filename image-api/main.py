"""
image-api — Multi-model text-to-image service for Dave-in-a-Box.

POST /generate  {prompt, aspect, steps, seed, model}
  → {image (base64 PNG), prompt, elapsed_s, width, height, model}

GET /health
  → {ok, model_loaded, current_model}

GET /progress
  → {running, step, total_steps, elapsed_s}

GET /models
  → {models: [{id, name, description, default_steps, max_steps, guidance_scale}], current}

POST /models/load  {model}
  → {ok, model, vram_mb}

Supported models:
  playground-v2.5         — Aesthetic champion, beats SDXL/DALL-E 3/MJ 5.2 (~6.7GB)
  stable-diffusion-3.5    — Latest SD architecture, superior prompt adherence (~12GB)

Aspect ratios:
  square    → 1024×1024 (default)
  landscape → 1344×768  (16:9)
  portrait  → 768×1344
"""

import os
import io
import time
import base64
import logging
import asyncio
from typing import Optional

import torch
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

HF_TOKEN = os.environ.get("HF_TOKEN", "")
HF_CACHE = os.environ.get("HF_HOME", "/root/.cache/huggingface")

# Ollama connection — used to evict loaded models from VRAM before inference
OLLAMA_URL = os.environ.get("OLLAMA_BASE_URL", "http://ollama:11434")

MODELS = {
    "playground-v2.5": {
        "hf_id": "playgroundai/playground-v2.5-1024px-aesthetic",
        "name": "Playground v2.5",
        "description": "Best aesthetics — outperforms SDXL, DALL-E 3 and Midjourney 5.2",
        "default_steps": 25,
        "max_steps": 50,
        "guidance_scale": 3.0,
        "loader": "playground",
        "dimensions": {
            "square":    (1024, 1024),
            "landscape": (1344, 768),
            "portrait":  (768, 1344),
        },
    },
    "stable-diffusion-3.5": {
        "hf_id": "stabilityai/stable-diffusion-3.5-medium",
        "name": "Stable Diffusion 3.5",
        "description": "Latest SD architecture — superior text rendering and prompt adherence",
        "default_steps": 28,
        "max_steps": 50,
        "guidance_scale": 7.0,
        "loader": "sd3",
        "dimensions": {
            "square":    (1024, 1024),
            "landscape": (1344, 768),
            "portrait":  (768, 1344),
        },
    },
}

DEFAULT_MODEL = "playground-v2.5"

_pipeline = None
_current_model = None

# Live progress state — updated by the pipeline callback during inference
_progress = {"running": False, "step": 0, "total_steps": 0, "elapsed_s": 0.0, "started_at": 0.0}

app = FastAPI(title="image-api")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _load_pipeline(model_key: str):
    """Load a model pipeline onto GPU. Returns the pipeline."""
    cfg = MODELS[model_key]
    logger.info(f"Loading {cfg['name']} ({cfg['hf_id']})...")
    t0 = time.time()

    if cfg["loader"] == "playground":
        from diffusers import DiffusionPipeline, EDMDPMSolverMultistepScheduler
        pipe = DiffusionPipeline.from_pretrained(
            cfg["hf_id"],
            torch_dtype=torch.float16,
            variant="fp16",
            token=HF_TOKEN or None,
            cache_dir=HF_CACHE,
        )
        pipe.scheduler = EDMDPMSolverMultistepScheduler()
    elif cfg["loader"] == "sd3":
        from diffusers import StableDiffusion3Pipeline
        pipe = StableDiffusion3Pipeline.from_pretrained(
            cfg["hf_id"],
            torch_dtype=torch.float16,
            token=HF_TOKEN or None,
            cache_dir=HF_CACHE,
        )

    pipe.to("cuda")
    vram = torch.cuda.memory_allocated() // 1024 // 1024
    logger.info(f"{cfg['name']} ready in {time.time()-t0:.1f}s — VRAM: {vram}MB")
    return pipe


@app.on_event("startup")
async def startup():
    """Load default model at startup."""
    global _pipeline, _current_model
    loop = asyncio.get_event_loop()
    _pipeline = await loop.run_in_executor(None, _load_pipeline, DEFAULT_MODEL)
    _current_model = DEFAULT_MODEL


class GenerateRequest(BaseModel):
    prompt: str
    negative_prompt: Optional[str] = None
    aspect: str = "square"
    width: Optional[int] = None
    height: Optional[int] = None
    steps: Optional[int] = None
    seed: Optional[int] = None
    guidance_scale: Optional[float] = None
    model: Optional[str] = None


class LoadModelRequest(BaseModel):
    model: str


@app.get("/health")
def health():
    return {"ok": True, "model_loaded": _pipeline is not None, "current_model": _current_model}


@app.get("/progress")
def progress():
    """Returns live generation progress for frontend polling."""
    p = _progress.copy()
    if p["running"] and p["started_at"]:
        p["elapsed_s"] = round(time.time() - p["started_at"], 1)
    return p


@app.get("/models")
def list_models():
    """Returns available image models and current selection."""
    models = []
    for key, cfg in MODELS.items():
        models.append({
            "id": key,
            "name": cfg["name"],
            "description": cfg["description"],
            "default_steps": cfg["default_steps"],
            "max_steps": cfg["max_steps"],
            "guidance_scale": cfg["guidance_scale"],
        })
    return {"models": models, "current": _current_model}


@app.post("/models/load")
async def load_model(req: LoadModelRequest):
    """Switch to a different image model. Unloads current model and loads the new one."""
    global _pipeline, _current_model

    if req.model not in MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown model: {req.model}. Available: {list(MODELS.keys())}")

    if req.model == _current_model and _pipeline is not None:
        return {"ok": True, "model": req.model, "vram_mb": torch.cuda.memory_allocated() // 1024 // 1024}

    # Unload current pipeline
    logger.info(f"Unloading {_current_model}")
    _pipeline = None
    _current_model = None
    torch.cuda.empty_cache()

    # Load new model
    loop = asyncio.get_event_loop()
    _pipeline = await loop.run_in_executor(None, _load_pipeline, req.model)
    _current_model = req.model

    return {"ok": True, "model": req.model, "vram_mb": torch.cuda.memory_allocated() // 1024 // 1024}


@app.post("/generate")
async def generate(req: GenerateRequest):
    global _pipeline, _current_model

    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required")

    # If a specific model is requested and it's different from current, swap it
    requested_model = req.model or _current_model
    if requested_model and requested_model != _current_model and requested_model in MODELS:
        logger.info(f"Switching model from {_current_model} to {requested_model}")
        _pipeline = None
        torch.cuda.empty_cache()
        loop = asyncio.get_event_loop()
        _pipeline = await loop.run_in_executor(None, _load_pipeline, requested_model)
        _current_model = requested_model

    if _pipeline is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet, please retry shortly")

    cfg = MODELS[_current_model]
    dims = cfg["dimensions"]
    # Custom width/height override aspect ratio presets
    if req.width and req.height:
        w, h = req.width, req.height
    else:
        w, h = dims.get(req.aspect, dims["square"])
    steps = req.steps or cfg["default_steps"]
    steps = max(1, min(steps, cfg["max_steps"]))
    guidance = req.guidance_scale if req.guidance_scale is not None else cfg["guidance_scale"]
    generator = torch.Generator("cuda").manual_seed(req.seed) if req.seed is not None else None

    # Evict ALL Ollama models from VRAM to avoid contention
    _progress.update({"running": False, "step": 0, "total_steps": steps, "elapsed_s": 0.0, "started_at": time.time()})
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            ps = await client.get(f"{OLLAMA_URL}/api/ps")
            loaded_models = [m.get("name", "") for m in ps.json().get("models", []) if m.get("name")]
            for model_name in loaded_models:
                logger.info(f"Evicting {model_name} from VRAM")
                await client.post(f"{OLLAMA_URL}/api/generate", json={"model": model_name, "keep_alive": 0})
        if loaded_models:
            for _ in range(30):
                await asyncio.sleep(1)
                async with httpx.AsyncClient(timeout=5) as client:
                    ps = await client.get(f"{OLLAMA_URL}/api/ps")
                    if not ps.json().get("models", []):
                        break
            await asyncio.sleep(3)
            logger.info("Ollama VRAM cleared")
    except Exception as e:
        logger.warning(f"Could not evict Ollama models: {e}")

    # Reset progress state before starting
    _progress.update({"running": True, "step": 0, "total_steps": steps, "elapsed_s": 0.0, "started_at": time.time()})

    def _step_callback(pipe, step_index, timestep, callback_kwargs):
        """Called by diffusers after each denoising step — updates live progress."""
        _progress["step"] = step_index + 1
        return callback_kwargs

    t0 = time.time()
    try:
        loop = asyncio.get_event_loop()

        def _run_inference():
            logger.info(f"Starting {cfg['name']} inference ({steps} steps, {w}x{h})")
            kwargs = dict(
                prompt=req.prompt,
                width=w,
                height=h,
                num_inference_steps=steps,
                guidance_scale=guidance,
                generator=generator,
                callback_on_step_end=_step_callback,
            )
            if req.negative_prompt:
                kwargs["negative_prompt"] = req.negative_prompt
            result = _pipeline(**kwargs)
            return result

        result = await loop.run_in_executor(None, _run_inference)
    except Exception as e:
        logger.error(f"Generation failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")
    finally:
        _progress["running"] = False

    img: Image.Image = result.images[0]
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()

    elapsed = round(time.time() - t0, 2)
    logger.info(f"Generated {w}x{h} in {elapsed}s — {req.prompt[:60]}")

    return {
        "image": b64,
        "prompt": req.prompt,
        "elapsed_s": elapsed,
        "width": w,
        "height": h,
        "model": cfg["name"],
    }
