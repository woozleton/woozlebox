"""
image-api - Multi-model text-to-image service for WoozleBox.

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
import threading
from typing import Optional

import httpx
import torch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

HF_TOKEN = os.environ.get("HF_TOKEN", "")
HF_CACHE = os.environ.get("HF_HOME", "/root/.cache/huggingface")
GPU_MANAGER_URL = os.environ.get("GPU_MANAGER_URL", "http://gpu-manager:8400")
SERVICE_NAME = "image"


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
                # Emit an activity-log event every 128 MB of growth
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
_cancel_requested = False

app = FastAPI(title="image-api")
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


def _load_pipeline(model_key: str):
    """Load a model pipeline onto GPU. Returns the pipeline."""
    cfg = MODELS[model_key]
    logger.info(f"Loading {cfg['name']} ({cfg['hf_id']})...")
    t0 = time.time()
    ls_begin(model=model_key, repo=cfg["hf_id"], phase=f"Loading {cfg['name']}")

    try:
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
            try:
                from diffusers import PipelineQuantizationConfig, TorchAoConfig
                from torchao.quantization import Float8WeightOnlyConfig
                quant_config = PipelineQuantizationConfig(
                    quant_mapping={"transformer": TorchAoConfig(Float8WeightOnlyConfig())}
                )
                pipe = StableDiffusion3Pipeline.from_pretrained(
                    cfg["hf_id"],
                    quantization_config=quant_config,
                    torch_dtype=torch.bfloat16,
                    token=HF_TOKEN or None,
                    cache_dir=HF_CACHE,
                )
                logger.info("SD 3.5 loaded with FP8 weight-only quantization via torchao")
            except GatedRepoError:
                raise
            except Exception as e:
                logger.warning(f"FP8 quantization failed ({e}), loading in fp16")
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
                variant="fp16",
                token=HF_TOKEN or None,
                cache_dir=HF_CACHE,
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
    pipe.to("cuda")
    vram = torch.cuda.memory_allocated() // 1024 // 1024
    logger.info(f"{cfg['name']} ready in {time.time()-t0:.1f}s -VRAM: {vram}MB")
    ls_ready(vram)
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


@app.get("/models/status")
def models_status():
    """Live model-load state for the web UI spinner. Returns phase + bytes."""
    s = LOAD_STATUS.copy()
    if s.get("started_at"):
        s["elapsed_s"] = round(time.time() - s["started_at"], 1)
    return s


@app.get("/progress")
def progress():
    """Returns live generation progress for frontend polling."""
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
    try:
        loop = asyncio.get_event_loop()
        _pipeline = await loop.run_in_executor(None, _load_pipeline, req.model)
        _current_model = req.model
    except GatedRepoError as e:
        raise HTTPException(status_code=403, detail=str(e), headers={"X-Gated-Repo": e.repo_url})

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

    # Reset progress state before starting
    global _cancel_requested
    _cancel_requested = False
    _progress.update({"running": True, "step": 0, "total_steps": steps, "elapsed_s": 0.0, "started_at": time.time()})

    def _step_callback(pipe, step_index, timestep, callback_kwargs):
        _progress["step"] = step_index + 1
        if _cancel_requested:
            raise RuntimeError("Generation cancelled by user")
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
        if _cancel_requested:
            logger.info("Image generation cancelled by user")
            raise HTTPException(status_code=499, detail="Generation cancelled")
        logger.error(f"Generation failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")
    finally:
        _progress["running"] = False
        _cancel_requested = False

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

    # SD 1.5 inpaint was trained at 512 native. To avoid aspect-ratio
    # distortion (which wrecks quality on non-square sources), scale the
    # longer side to 512 and preserve aspect, rounding both dimensions to
    # multiples of 8 as required by the VAE.
    target_long = 512
    scale = target_long / float(max(orig_w, orig_h))
    rw = max(64, (int(round(orig_w * scale)) // 8) * 8)
    rh = max(64, (int(round(orig_h * scale)) // 8) * 8)

    src_resized = src_img.resize((rw, rh), Image.LANCZOS)
    mask_resized = mask_img.resize((rw, rh), Image.LANCZOS)

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

    _cancel_requested = False
    _progress.update({"running": True, "step": 0, "total_steps": steps, "elapsed_s": 0.0, "started_at": time.time()})

    def _step_callback(pipe, step_index, timestep, callback_kwargs):
        _progress["step"] = step_index + 1
        if _cancel_requested:
            raise RuntimeError("Inpaint cancelled by user")
        return callback_kwargs

    t0 = time.time()
    try:
        loop = asyncio.get_event_loop()

        def _run_inpaint():
            logger.info(f"Starting inpaint ({steps} steps, guidance={guidance}, strength={strength}, {rw}x{rh})")
            kwargs = dict(
                prompt=req.prompt,
                image=src_resized,
                mask_image=mask_resized,
                width=rw,
                height=rh,
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
        if _cancel_requested:
            logger.info("Inpaint cancelled by user")
            raise HTTPException(status_code=499, detail="Inpaint cancelled")
        logger.error(f"Inpaint failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Inpaint failed: {e}")
    finally:
        _progress["running"] = False

    # Upscale the inpaint result back to the original dimensions, then
    # composite: only the masked region comes from the inpaint output, the
    # rest of the pixels are the original (no VAE round-trip blur).
    inpainted_full = result.images[0].resize((orig_w, orig_h), Image.LANCZOS)
    mask_full = mask_img.resize((orig_w, orig_h), Image.LANCZOS)
    out_img = Image.composite(inpainted_full, src_img, mask_full)
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
