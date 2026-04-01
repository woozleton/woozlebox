"""
image-api - Multi-model text-to-image service for Dave-in-a-Box.

POST /generate   {prompt, aspect, steps, seed, model}
POST /inpaint    {image, mask, prompt, negative_prompt, steps, seed, guidance_scale}
GET  /health
GET  /progress
GET  /models
POST /models/load  {model}
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

# Ollama connection -used to evict loaded models from VRAM before inference
OLLAMA_URL = os.environ.get("OLLAMA_BASE_URL", "http://ollama:11434")
UTILITY_MODEL = os.environ.get("UTILITY_MODEL", "qwen3:0.6b")


def _is_utility_model(name: str) -> bool:
    return name.split(":")[0].lower() == UTILITY_MODEL.split(":")[0].lower()

MODELS = {
    "playground-v2.5": {
        "hf_id": "playgroundai/playground-v2.5-1024px-aesthetic",
        "name": "Playground v2.5",
        "description": "Best aesthetics -outperforms SDXL, DALL-E 3 and Midjourney 5.2",
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
        "description": "Latest SD architecture -superior text rendering and prompt adherence",
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
    "sdxl-turbo": {
        "hf_id": "stabilityai/sdxl-turbo",
        "name": "SDXL Turbo",
        "description": "Fast 1-4 step generation - small VRAM footprint, good for quick previews and cover art",
        "default_steps": 4,
        "max_steps": 4,
        "guidance_scale": 0.0,
        "loader": "sdxl-turbo",
        "dimensions": {
            "square":    (512, 512),
            "landscape": (672, 384),
            "portrait":  (384, 672),
        },
    },
    "sd-inpaint": {
        "hf_id": "runwayml/stable-diffusion-inpainting",
        "name": "SD Inpainting",
        "description": "Inpainting specialist - edit regions of existing images",
        "default_steps": 35,
        "max_steps": 50,
        "guidance_scale": 12.0,
        "loader": "inpaint",
        "dimensions": {"square": (512, 512)},
        "internal": True,
    },
}

DEFAULT_MODEL = "playground-v2.5"

_pipeline = None
_current_model = None

# Live progress state -updated by the pipeline callback during inference
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
    elif cfg["loader"] == "sdxl-turbo":
        from diffusers import AutoPipelineForText2Image
        pipe = AutoPipelineForText2Image.from_pretrained(
            cfg["hf_id"],
            torch_dtype=torch.float16,
            variant="fp16",
            token=HF_TOKEN or None,
            cache_dir=HF_CACHE,
        )
    elif cfg["loader"] == "inpaint":
        from diffusers import StableDiffusionInpaintPipeline
        pipe = StableDiffusionInpaintPipeline.from_pretrained(
            cfg["hf_id"],
            torch_dtype=torch.float16,
            token=HF_TOKEN or None,
            cache_dir=HF_CACHE,
        )

    pipe.to("cuda")
    vram = torch.cuda.memory_allocated() // 1024 // 1024
    logger.info(f"{cfg['name']} ready in {time.time()-t0:.1f}s -VRAM: {vram}MB")
    return pipe


@app.on_event("startup")
async def startup():
    logger.info("Image API started - model will load on first request or /models/load")


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


class UpscaleRequest(BaseModel):
    image: str  # base64-encoded PNG
    scale: int = 2  # 2x or 4x


class InpaintRequest(BaseModel):
    image: str       # base64 PNG -source image
    mask: str        # base64 PNG -white=inpaint, black=keep
    prompt: str
    negative_prompt: Optional[str] = None
    steps: Optional[int] = None
    seed: Optional[int] = None
    guidance_scale: Optional[float] = None
    strength: Optional[float] = None


# ── Real-ESRGAN upscaler (lazy-loaded) ──
# basicsr.data imports torchvision.transforms.functional_tensor which was removed
# in torchvision 0.16+. We stub it before any basicsr/realesrgan import.
def _patch_basicsr():
    import sys, types
    if "torchvision.transforms.functional_tensor" not in sys.modules:
        import torchvision.transforms.functional as _tvf
        _stub = types.ModuleType("torchvision.transforms.functional_tensor")
        _stub.rgb_to_grayscale = _tvf.rgb_to_grayscale
        sys.modules["torchvision.transforms.functional_tensor"] = _stub

_upscaler_cache = {}

def _get_upscaler(scale: int = 2):
    """Lazy-load Real-ESRGAN upscaler model."""
    if scale in _upscaler_cache:
        return _upscaler_cache[scale]

    _patch_basicsr()
    from basicsr.archs.rrdbnet_arch import RRDBNet
    from realesrgan.utils import RealESRGANer

    model_name = "RealESRGAN_x4plus" if scale == 4 else "RealESRGAN_x2plus"
    model_url = (
        "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"
        if scale == 4 else
        "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth"
    )
    model_net = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=scale)

    model_path = os.path.join(HF_CACHE, f"{model_name}.pth")
    if not os.path.exists(model_path):
        import urllib.request
        logger.info(f"Downloading {model_name} weights...")
        os.makedirs(HF_CACHE, exist_ok=True)
        urllib.request.urlretrieve(model_url, model_path)
        logger.info(f"Downloaded {model_name} to {model_path}")

    upscaler = RealESRGANer(
        scale=scale,
        model_path=model_path,
        model=model_net,
        tile=512,
        tile_pad=10,
        pre_pad=0,
        half=True,
        gpu_id=0,
    )
    _upscaler_cache[scale] = upscaler
    return upscaler


@app.get("/health")
def health():
    vram_mb = torch.cuda.memory_allocated() // 1024 // 1024 if _pipeline else 0
    return {"ok": True, "model_loaded": _pipeline is not None, "current_model": _current_model, "vram_mb": vram_mb}


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
        if cfg.get("internal"):
            continue
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


@app.post("/models/unload")
async def unload_model():
    """Unload the current model from VRAM to free GPU memory."""
    global _pipeline, _current_model
    if _pipeline is None:
        return {"ok": True, "was_loaded": False}
    prev = _current_model
    logger.info(f"Unloading {_current_model} to free VRAM")
    _pipeline = None
    _current_model = None
    import gc
    gc.collect()
    torch.cuda.empty_cache()
    vram = torch.cuda.memory_allocated() // 1024 // 1024
    logger.info(f"Unloaded {prev} -VRAM after: {vram}MB")
    return {"ok": True, "was_loaded": True, "freed_model": prev, "vram_mb": vram}


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

    # Auto-load default model if nothing is loaded
    if _pipeline is None:
        logger.info(f"No model loaded, auto-loading {DEFAULT_MODEL}")
        loop = asyncio.get_event_loop()
        _pipeline = await loop.run_in_executor(None, _load_pipeline, DEFAULT_MODEL)
        _current_model = DEFAULT_MODEL

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

    # Reset progress state before starting
    _progress.update({"running": True, "step": 0, "total_steps": steps, "elapsed_s": 0.0, "started_at": time.time()})

    def _step_callback(pipe, step_index, timestep, callback_kwargs):
        """Called by diffusers after each denoising step -updates live progress."""
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
    logger.info(f"Generated {w}x{h} in {elapsed}s -{req.prompt[:60]}")

    return {
        "image": b64,
        "prompt": req.prompt,
        "elapsed_s": elapsed,
        "width": w,
        "height": h,
        "model": cfg["name"],
    }


@app.post("/upscale")
async def upscale(req: UpscaleRequest):
    """Upscale an image using Real-ESRGAN. Accepts base64 PNG, returns base64 PNG."""
    if not req.image:
        raise HTTPException(status_code=400, detail="image is required")
    scale = req.scale if req.scale in (2, 4) else 2

    # Decode input image
    try:
        img_bytes = base64.b64decode(req.image)
        img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image: {e}")

    import numpy as np
    img_np = np.array(img)

    # Evict Ollama models from VRAM first
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            ps = await client.get(f"{OLLAMA_URL}/api/ps")
            loaded_models = [m.get("name", "") for m in ps.json().get("models", []) if m.get("name")]
            evicted = []
            for model_name in loaded_models:
                if _is_utility_model(model_name):
                    continue
                logger.info(f"Evicting {model_name} from VRAM for upscale")
                await client.post(f"{OLLAMA_URL}/api/generate", json={"model": model_name, "keep_alive": 0})
                evicted.append(model_name)
            if evicted:
                for _ in range(15):
                    await asyncio.sleep(1)
                    async with httpx.AsyncClient(timeout=5) as c2:
                        ps2 = await c2.get(f"{OLLAMA_URL}/api/ps")
                        remaining = [m.get("name", "") for m in ps2.json().get("models", []) if m.get("name") and not _is_utility_model(m.get("name", ""))]
                        if not remaining:
                            break
                await asyncio.sleep(1)
    except Exception as e:
        logger.warning(f"Could not evict Ollama models for upscale: {e}")

    t0 = time.time()
    try:
        loop = asyncio.get_event_loop()

        def _run_upscale():
            upscaler = _get_upscaler(scale)
            output, _ = upscaler.enhance(img_np, outscale=scale)
            return output

        output_np = await loop.run_in_executor(None, _run_upscale)
    except Exception as e:
        logger.error(f"Upscale failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Upscale failed: {e}")

    # Encode result
    output_img = Image.fromarray(output_np)
    buf = io.BytesIO()
    output_img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()

    elapsed = round(time.time() - t0, 2)
    logger.info(f"Upscaled {img.width}x{img.height} -> {output_img.width}x{output_img.height} ({scale}x) in {elapsed}s")

    return {
        "image": b64,
        "width": output_img.width,
        "height": output_img.height,
        "scale": scale,
        "elapsed_s": elapsed,
    }


@app.post("/inpaint")
async def inpaint(req: InpaintRequest):
    """Inpaint a masked region of an image. Swaps to inpaint model, then restores previous."""
    global _pipeline, _current_model

    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required")
    if not req.image or not req.mask:
        raise HTTPException(status_code=400, detail="image and mask are required")

    # Decode source image and mask
    try:
        src_img = Image.open(io.BytesIO(base64.b64decode(req.image))).convert("RGB")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image: {e}")
    try:
        mask_img = Image.open(io.BytesIO(base64.b64decode(req.mask))).convert("L")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid mask: {e}")

    orig_w, orig_h = src_img.size
    inpaint_size = 512  # SD 1.5 inpaint native resolution

    # Resize to inpaint dimensions
    src_resized = src_img.resize((inpaint_size, inpaint_size), Image.LANCZOS)
    mask_resized = mask_img.resize((inpaint_size, inpaint_size), Image.LANCZOS)

    # Evict Ollama models
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            ps = await client.get(f"{OLLAMA_URL}/api/ps")
            loaded_models = [m.get("name", "") for m in ps.json().get("models", []) if m.get("name")]
            evicted = []
            for model_name in loaded_models:
                if _is_utility_model(model_name):
                    continue
                logger.info(f"Evicting {model_name} from VRAM for inpaint")
                await client.post(f"{OLLAMA_URL}/api/generate", json={"model": model_name, "keep_alive": 0})
                evicted.append(model_name)
            if evicted:
                for _ in range(30):
                    await asyncio.sleep(1)
                    async with httpx.AsyncClient(timeout=5) as c2:
                        ps2 = await c2.get(f"{OLLAMA_URL}/api/ps")
                        remaining = [m.get("name", "") for m in ps2.json().get("models", []) if m.get("name") and not _is_utility_model(m.get("name", ""))]
                        if not remaining:
                            break
                await asyncio.sleep(1)
    except Exception as e:
        logger.warning(f"Could not evict Ollama models for inpaint: {e}")

    # Swap to inpaint model if needed
    prev_model = _current_model
    if _current_model != "sd-inpaint":
        logger.info(f"Swapping from {_current_model} to sd-inpaint")
        _pipeline = None
        torch.cuda.empty_cache()
        loop = asyncio.get_event_loop()
        _pipeline = await loop.run_in_executor(None, _load_pipeline, "sd-inpaint")
        _current_model = "sd-inpaint"

    if _pipeline is None:
        raise HTTPException(status_code=503, detail="Inpaint model failed to load")

    cfg = MODELS["sd-inpaint"]
    steps = req.steps or cfg["default_steps"]
    steps = max(1, min(steps, cfg["max_steps"]))
    guidance = req.guidance_scale if req.guidance_scale is not None else cfg["guidance_scale"]
    strength = req.strength if req.strength is not None else 1.0
    strength = max(0.1, min(1.0, strength))
    seed = req.seed if req.seed is not None else int(torch.randint(0, 2**32, (1,)).item())
    generator = torch.Generator("cuda").manual_seed(seed)

    _progress.update({"running": True, "step": 0, "total_steps": steps, "elapsed_s": 0.0, "started_at": time.time()})

    def _step_callback(pipe, step_index, timestep, callback_kwargs):
        _progress["step"] = step_index + 1
        return callback_kwargs

    t0 = time.time()
    try:
        loop = asyncio.get_event_loop()

        def _run_inpaint():
            logger.info(f"Starting inpaint ({steps} steps, guidance={guidance}, strength={strength}, {inpaint_size}x{inpaint_size})")
            kwargs = dict(
                prompt=req.prompt,
                image=src_resized,
                mask_image=mask_resized,
                width=inpaint_size,
                height=inpaint_size,
                num_inference_steps=steps,
                guidance_scale=guidance,
                strength=strength,
                generator=generator,
                callback_on_step_end=_step_callback,
            )
            if req.negative_prompt:
                kwargs["negative_prompt"] = req.negative_prompt
            result = _pipeline(**kwargs)
            return result

        result = await loop.run_in_executor(None, _run_inpaint)
    except Exception as e:
        logger.error(f"Inpaint failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Inpaint failed: {e}")
    finally:
        _progress["running"] = False

    # Resize back to original dimensions
    out_img = result.images[0].resize((orig_w, orig_h), Image.LANCZOS)
    buf = io.BytesIO()
    out_img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()

    elapsed = round(time.time() - t0, 2)
    logger.info(f"Inpainted {orig_w}x{orig_h} in {elapsed}s -{req.prompt[:60]}")

    # Swap back to previous model in background (non-blocking)
    if prev_model and prev_model != "sd-inpaint" and prev_model in MODELS:
        async def _restore():
            global _pipeline, _current_model
            try:
                _pipeline = None
                torch.cuda.empty_cache()
                loop = asyncio.get_event_loop()
                _pipeline = await loop.run_in_executor(None, _load_pipeline, prev_model)
                _current_model = prev_model
                logger.info(f"Restored {prev_model} after inpaint")
            except Exception as e:
                logger.warning(f"Failed to restore {prev_model}: {e}")
        asyncio.create_task(_restore())

    return {
        "image": b64,
        "width": orig_w,
        "height": orig_h,
        "seed": seed,
        "elapsed_s": elapsed,
    }
