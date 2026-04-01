"""
gpu-manager - Centralized VRAM orchestration for Dave-in-a-Box.

Owns all model loading/unloading decisions. Ensures only one model
occupies VRAM at a time. Serializes acquire requests via asyncio.Lock
to prevent race conditions.

POST /acquire  {service, model}  - evict others, load target
POST /release  {service}        - unload a service's model
GET  /status                    - what's loaded in VRAM
GET  /events                    - SSE stream of state changes
"""

import os
import json
import asyncio
import logging
import time

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

IMAGE_GEN_URL = os.environ.get("IMAGE_GEN_URL", "http://image-api:8100")
MUSIC_GEN_URL = os.environ.get("MUSIC_GEN_URL", "http://music-api:8200")
VIDEO_GEN_URL = os.environ.get("VIDEO_GEN_URL", "http://video-api:8300")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://ollama:11434")
UTILITY_MODEL = os.environ.get("UTILITY_MODEL", "qwen3:0.6b")

SERVICES = {
    "image": IMAGE_GEN_URL,
    "music": MUSIC_GEN_URL,
    "video": VIDEO_GEN_URL,
}

app = FastAPI(title="gpu-manager")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_lock = asyncio.Lock()

# -- SSE broadcast --
_sse_clients: list[asyncio.Queue] = []


async def _broadcast(event: str, data: dict):
    """Push an event to all connected SSE clients."""
    msg = f"event: {event}\ndata: {json.dumps(data)}\n\n"
    for q in _sse_clients[:]:
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            pass


async def _broadcast_status():
    """Fetch current status and broadcast it."""
    loaded = await _get_loaded_models()
    await _broadcast("status", {"loaded": loaded})


async def _get_loaded_models() -> list:
    """Get all currently loaded models across all services."""
    loaded = []
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{OLLAMA_BASE_URL}/api/ps")
            for m in resp.json().get("models", []):
                name = m.get("name", "")
                size = m.get("size_vram", m.get("size", 0))
                loaded.append({"name": name, "type": "llm", "vram_mb": round(size / 1024 / 1024)})
    except Exception:
        pass
    for svc, url in SERVICES.items():
        health = await _get_service_health(url)
        if health.get("model_loaded") and health.get("current_model"):
            loaded.append({
                "name": health["current_model"],
                "type": svc,
                "vram_mb": health.get("vram_mb", 0),
            })
    return loaded


def _is_utility_model(name: str) -> bool:
    return name.split(":")[0].lower() == UTILITY_MODEL.split(":")[0].lower()


async def _get_service_health(url: str) -> dict:
    """Get health status from a service. Returns empty dict on failure."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{url}/health")
            return resp.json()
    except Exception:
        return {}


async def _unload_service(service: str) -> bool:
    """Unload a service's model. Returns True if it was loaded."""
    url = SERVICES.get(service)
    if not url:
        return False
    try:
        health = await _get_service_health(url)
        if not health.get("model_loaded"):
            return False
        logger.info(f"Unloading {service} model")
        async with httpx.AsyncClient(timeout=30.0) as client:
            await client.post(f"{url}/models/unload")
        return True
    except Exception as e:
        logger.warning(f"Failed to unload {service}: {e}")
        return False


async def _load_service(service: str, model: str = None) -> dict:
    """Load a service's model. Returns health data after load."""
    url = SERVICES.get(service)
    if not url:
        raise HTTPException(status_code=400, detail=f"Unknown service: {service}")

    timeout = 300.0 if service == "video" else 180.0
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            body = {"model": model} if model else {}
            resp = await client.post(f"{url}/models/load", json=body)
            return resp.json()
    except Exception as e:
        logger.error(f"Failed to load {service}: {e}")
        raise HTTPException(status_code=503, detail=f"Failed to load {service} model: {e}")


async def _evict_ollama(keep_utility: bool = True):
    """Evict all Ollama LLMs from VRAM, optionally keeping the utility model."""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            ps = await client.get(f"{OLLAMA_BASE_URL}/api/ps")
            loaded = [m.get("name", "") for m in ps.json().get("models", []) if m.get("name")]
            evicted = []
            for model_name in loaded:
                if keep_utility and _is_utility_model(model_name):
                    continue
                logger.info(f"Evicting Ollama model: {model_name}")
                try:
                    await client.post(
                        f"{OLLAMA_BASE_URL}/api/generate",
                        json={"model": model_name, "prompt": "", "keep_alive": 0, "stream": False},
                    )
                    evicted.append(model_name)
                except Exception:
                    pass
            return evicted
    except Exception as e:
        logger.warning(f"Ollama eviction failed: {e}")
        return []


async def _wait_vram_clear(exclude: str = None, timeout_s: int = 30):
    """Poll service health endpoints until all non-excluded services report model_loaded=False."""
    for _ in range(timeout_s):
        all_clear = True
        for svc, url in SERVICES.items():
            if svc == exclude:
                continue
            health = await _get_service_health(url)
            if health.get("model_loaded"):
                all_clear = False
                break
        if all_clear:
            # Also check Ollama if we're not acquiring chat
            if exclude != "chat":
                try:
                    async with httpx.AsyncClient(timeout=5.0) as client:
                        ps = await client.get(f"{OLLAMA_BASE_URL}/api/ps")
                        remaining = [
                            m.get("name", "") for m in ps.json().get("models", [])
                            if m.get("name") and not _is_utility_model(m.get("name", ""))
                        ]
                        if remaining:
                            all_clear = False
                except Exception:
                    pass
            if all_clear:
                logger.info("VRAM clear confirmed")
                return
        await asyncio.sleep(1)
    logger.warning(f"VRAM clear timed out after {timeout_s}s")


async def _warmup_llm(model: str = None):
    """Send a minimal request to Ollama to preload an LLM into VRAM."""
    use_model = model or os.environ.get("LLM_MODEL", "qwen3:30b-a3b")
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            await client.post(
                f"{OLLAMA_BASE_URL}/api/generate",
                json={"model": use_model, "prompt": "", "keep_alive": "5m", "stream": False},
            )
        logger.info(f"LLM {use_model} warmed up")
    except Exception as e:
        logger.warning(f"LLM warmup failed: {e}")


class AcquireRequest(BaseModel):
    service: str
    model: Optional[str] = None


class ReleaseRequest(BaseModel):
    service: str


@app.post("/acquire")
async def acquire(req: AcquireRequest):
    """Acquire VRAM for a service. Evicts everything else first, serialized via lock."""
    if req.service not in list(SERVICES.keys()) + ["chat"]:
        raise HTTPException(status_code=400, detail=f"Unknown service: {req.service}")

    async with _lock:
        t0 = time.time()
        logger.info(f"Acquiring VRAM for {req.service}")

        # 1. Check if target is already the only thing loaded
        if req.service in SERVICES:
            target_health = await _get_service_health(SERVICES[req.service])
            if target_health.get("model_loaded"):
                # Target loaded - but are others also loaded?
                others_loaded = False
                for svc, url in SERVICES.items():
                    if svc == req.service:
                        continue
                    h = await _get_service_health(url)
                    if h.get("model_loaded"):
                        others_loaded = True
                        break
                if not others_loaded:
                    # Target is loaded and nothing else is - we're good
                    elapsed = round(time.time() - t0, 2)
                    logger.info(f"VRAM already acquired for {req.service} ({elapsed}s)")
                    return {
                        "ok": True,
                        "service": req.service,
                        "model": target_health.get("current_model"),
                        "vram_mb": target_health.get("vram_mb", 0),
                        "skipped": True,
                        "elapsed_s": elapsed,
                    }

        # 2. Unload all other services
        await _broadcast("acquiring", {"service": req.service, "phase": "unloading"})
        for svc in SERVICES:
            if svc == req.service:
                continue
            await _unload_service(svc)

        # 3. Evict Ollama LLMs (keep utility model)
        await _evict_ollama(keep_utility=True)

        # 4. Wait for VRAM to clear
        await _broadcast_status()
        await _wait_vram_clear(exclude=req.service)

        # 5. Load the target
        await _broadcast("acquiring", {"service": req.service, "phase": "loading"})
        result = {}
        if req.service == "chat":
            await _warmup_llm(req.model)
            result = {"model": req.model or "default", "vram_mb": 0}
        else:
            target_health = await _get_service_health(SERVICES[req.service])
            if target_health.get("model_loaded"):
                result = {
                    "model": target_health.get("current_model"),
                    "vram_mb": target_health.get("vram_mb", 0),
                }
            else:
                result = await _load_service(req.service, req.model)

        elapsed = round(time.time() - t0, 2)
        logger.info(f"VRAM acquired for {req.service} in {elapsed}s")
        await _broadcast_status()

        return {
            "ok": True,
            "service": req.service,
            "model": result.get("model"),
            "vram_mb": result.get("vram_mb", 0),
            "elapsed_s": elapsed,
        }


@app.post("/release")
async def release(req: ReleaseRequest):
    """Release VRAM held by a service."""
    if req.service == "chat":
        await _evict_ollama(keep_utility=True)
        await _broadcast_status()
        return {"ok": True, "service": "chat"}

    if req.service not in SERVICES:
        raise HTTPException(status_code=400, detail=f"Unknown service: {req.service}")

    was_loaded = await _unload_service(req.service)
    await _broadcast_status()
    return {"ok": True, "service": req.service, "was_loaded": was_loaded}


@app.get("/status")
async def status():
    """Report all currently loaded models across all services."""
    loaded = await _get_loaded_models()
    return {"loaded": loaded}


@app.get("/events")
async def events():
    """SSE stream of VRAM state changes. Clients receive instant updates."""
    q: asyncio.Queue = asyncio.Queue(maxsize=50)
    _sse_clients.append(q)

    async def stream():
        try:
            # Send current state immediately on connect
            loaded = await _get_loaded_models()
            yield f"event: status\ndata: {json.dumps({'loaded': loaded})}\n\n"
            while True:
                msg = await q.get()
                yield msg
        except asyncio.CancelledError:
            pass
        finally:
            _sse_clients.remove(q)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
