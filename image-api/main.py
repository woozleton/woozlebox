"""
image-api — FLUX.1-schnell text-to-image service for Dave-in-a-Box.

POST /generate  {prompt, aspect, steps, seed}
  → {image (base64 PNG), prompt, elapsed_s, width, height}

GET /health
  → {ok, model_loaded}

Aspect ratios:
  square    → 1024×1024 (default)
  landscape → 1344×768  (16:9)
  portrait  → 768×1344

Notes:
  - guidance_scale MUST be 0.0 for FLUX-schnell (guidance-distilled model)
  - bfloat16 is used over float16 to avoid NaN issues on Ampere GPUs
  - enable_model_cpu_offload() keeps GPU VRAM near 0 at rest (~8GB peak during inference)
  - run_in_executor keeps FastAPI's event loop alive during the blocking diffusion call
  - Model loads at startup; first start downloads ~16GB of weights to the HF cache volume
"""

import os
import io
import time
import base64
import logging
import asyncio
from typing import Optional

import torch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

MODEL_ID = os.environ.get("FLUX_MODEL_ID", "black-forest-labs/FLUX.1-schnell")
HF_TOKEN = os.environ.get("HF_TOKEN", "")
HF_CACHE = os.environ.get("HF_HOME", "/root/.cache/huggingface")

# Supported aspect ratios → (width, height)
DIMENSIONS = {
    "square":    (1024, 1024),
    "landscape": (1344, 768),
    "portrait":  (768, 1344),
}

_pipeline = None

app = FastAPI(title="image-api")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def load_model():
    """Load FLUX pipeline at startup. Downloads weights on first run (~16GB, cached after)."""
    global _pipeline
    logger.info(f"Loading FLUX pipeline: {MODEL_ID}")
    t0 = time.time()

    from diffusers import FluxPipeline
    loop = asyncio.get_event_loop()

    def _load():
        pipe = FluxPipeline.from_pretrained(
            MODEL_ID,
            torch_dtype=torch.bfloat16,
            token=HF_TOKEN or None,
            cache_dir=HF_CACHE,
        )
        # GPU only during active inference; near-zero VRAM at rest
        pipe.enable_model_cpu_offload()
        return pipe

    _pipeline = await loop.run_in_executor(None, _load)
    logger.info(f"FLUX pipeline ready in {time.time() - t0:.1f}s")


class GenerateRequest(BaseModel):
    prompt: str
    aspect: str = "square"
    steps: int = 4        # FLUX-schnell sweet spot; degrades above 8
    seed: Optional[int] = None


@app.get("/health")
def health():
    return {"ok": True, "model_loaded": _pipeline is not None}


@app.post("/generate")
async def generate(req: GenerateRequest):
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required")
    if _pipeline is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet, please retry shortly")

    w, h = DIMENSIONS.get(req.aspect, DIMENSIONS["square"])
    steps = max(1, min(req.steps, 8))
    generator = torch.Generator("cpu").manual_seed(req.seed) if req.seed is not None else None

    t0 = time.time()
    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            lambda: _pipeline(
                prompt=req.prompt,
                width=w,
                height=h,
                num_inference_steps=steps,
                guidance_scale=0.0,  # MUST be 0.0 for schnell (guidance-distilled)
                generator=generator,
            ),
        )
    except Exception as e:
        logger.error(f"Generation failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")

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
    }
