"""
gpu-manager - Centralized VRAM orchestration for WoozleBox.

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
NOTETAKER_API_URL = os.environ.get("NOTETAKER_API_URL", "http://notetaker-api:8600")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://ollama:11434")
UTILITY_MODEL = os.environ.get("UTILITY_MODEL", "qwen3:0.6b")
DEFAULT_LLM = os.environ.get("LLM_MODEL", "qwen3:30b-a3b")


_GPU_FALLBACK = {"used_mb": 0, "free_mb": 0, "total_mb": 24576, "gpu_name": "Unknown"}


async def _query_nvidia_smi() -> dict:
    """Query nvidia-smi for real GPU memory stats (non-blocking)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "nvidia-smi", "--query-gpu=memory.used,memory.free,memory.total,gpu_name",
            "--format=csv,noheader,nounits",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        if proc.returncode == 0:
            parts = [p.strip() for p in stdout.decode().strip().split(",")]
            return {
                "used_mb": int(parts[0]),
                "free_mb": int(parts[1]),
                "total_mb": int(parts[2]),
                "gpu_name": parts[3] if len(parts) > 3 else "Unknown",
            }
    except Exception as e:
        logger.warning(f"nvidia-smi query failed: {e}")
    return _GPU_FALLBACK

SERVICES = {
    "image": IMAGE_GEN_URL,
    "music": MUSIC_GEN_URL,
    "video": VIDEO_GEN_URL,
    "notetaker": NOTETAKER_API_URL,
}

app = FastAPI(title="gpu-manager")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_lock = asyncio.Lock()

# -- Shared HTTP client (created at startup, reuses TCP connections) --
_http: httpx.AsyncClient = None


@app.on_event("startup")
async def startup():
    global _http
    _http = httpx.AsyncClient(
        timeout=30.0,
        limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
    )
    logger.info("gpu-manager started")


@app.on_event("shutdown")
async def shutdown():
    global _http
    if _http:
        await _http.aclose()
        _http = None


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


async def _broadcast_vram_log(service: str, action: str, model: str, vram_mb: int = 0, detail: str = ""):
    """Broadcast a VRAM activity event to SSE clients."""
    await _broadcast("vram_log", {"service": service, "action": action, "model": model, "vram_mb": vram_mb, "detail": detail})


async def _broadcast_status():
    """Fetch current status and broadcast it."""
    loaded = await _get_loaded_models()
    gpu = await _query_nvidia_smi()
    await _broadcast("status", {"loaded": loaded, "gpu": gpu})


async def _get_loaded_models() -> list:
    """Get all currently loaded models across all services (parallel)."""
    async def _get_ollama():
        try:
            resp = await _http.get(f"{OLLAMA_BASE_URL}/api/ps", timeout=5.0)
            return [
                {"name": m.get("name", ""), "type": "llm",
                 "vram_mb": round(m.get("size_vram", m.get("size", 0)) / 1024 / 1024)}
                for m in resp.json().get("models", []) if m.get("name")
            ]
        except Exception:
            return []

    async def _get_svc(svc, url):
        health = await _get_service_health(url)
        if health.get("model_loaded") and health.get("current_model"):
            return {"name": health["current_model"], "type": svc, "vram_mb": health.get("vram_mb", 0)}
        return None

    results = await asyncio.gather(
        _get_ollama(),
        *[_get_svc(svc, url) for svc, url in SERVICES.items()],
    )

    loaded = results[0]  # Ollama models list
    for r in results[1:]:
        if r:
            loaded.append(r)
    return loaded


async def _log_vram_state(label: str):
    """Log a detailed VRAM snapshot: every loaded model with its type and VRAM usage."""
    loaded = await _get_loaded_models()
    total_vram = sum(m.get("vram_mb", 0) for m in loaded)
    if loaded:
        parts = [f"{m['name']}({m['type']})={m['vram_mb']}MB" for m in loaded]
        logger.info(f"[VRAM] {label}: {', '.join(parts)} | total={total_vram}MB")
    else:
        logger.info(f"[VRAM] {label}: (no models loaded)")
    return loaded


def _is_utility_model(name: str) -> bool:
    return name.split(":")[0].lower() == UTILITY_MODEL.split(":")[0].lower()


async def _get_service_health(url: str) -> dict:
    """Get health status from a service. Returns empty dict on failure."""
    try:
        resp = await _http.get(f"{url}/health", timeout=5.0)
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
            logger.info(f"[VRAM] {service}: already unloaded, skipping")
            return False
        model_name = health.get("current_model", "unknown")
        vram_before = health.get("vram_mb", 0)
        logger.info(f"[VRAM] Unloading {service} model={model_name} vram={vram_before}MB")
        resp = await _http.post(f"{url}/models/unload")
        result = resp.json()
        vram_after = result.get("vram_mb", 0)
        logger.info(f"[VRAM] Unloaded {service} model={model_name}: freed ~{vram_before - vram_after}MB, remaining={vram_after}MB")
        await _broadcast_vram_log("gpu-manager", "unload", model_name, vram_after, f"freed ~{vram_before - vram_after}MB from {service}")
        return True
    except Exception as e:
        logger.warning(f"[VRAM] Failed to unload {service}: {e}")
        return False


async def _load_service(service: str, model: str = None) -> dict:
    """Load a service's model. Returns health data after load."""
    url = SERVICES.get(service)
    if not url:
        raise HTTPException(status_code=400, detail=f"Unknown service: {service}")

    model_label = model or "(default)"
    logger.info(f"[VRAM] Loading {service} model={model_label}...")
    t0 = time.time()

    timeout = 300.0 if service == "video" else 180.0
    try:
        body = {"model": model} if model else {}
        resp = await _http.post(f"{url}/models/load", json=body, timeout=timeout)
        result = resp.json()
        elapsed = round(time.time() - t0, 1)
        loaded_model = result.get("model", model_label)
        vram = result.get("vram_mb", 0)
        already = result.get("already_loaded", False)
        if already:
            logger.info(f"[VRAM] {service} model={loaded_model} already loaded, vram={vram}MB")
        else:
            logger.info(f"[VRAM] Loaded {service} model={loaded_model} in {elapsed}s, vram={vram}MB")
            await _broadcast_vram_log("gpu-manager", "load", loaded_model, vram, f"{service} loaded in {elapsed}s")
        return result
    except Exception as e:
        logger.error(f"[VRAM] Failed to load {service} model={model_label}: {e}")
        raise HTTPException(status_code=503, detail=f"Failed to load {service} model: {e}")


async def _evict_ollama(keep_utility: bool = True):
    """Evict all Ollama LLMs from VRAM, optionally keeping the utility model."""
    try:
        ps = await _http.get(f"{OLLAMA_BASE_URL}/api/ps")
        models = [m for m in ps.json().get("models", []) if m.get("name")]
        if not models:
            logger.info("[VRAM] Ollama: no models loaded, nothing to evict")
            return []
        evicted = []
        kept = []
        for m in models:
            model_name = m.get("name", "")
            vram = round(m.get("size_vram", m.get("size", 0)) / 1024 / 1024)
            if keep_utility and _is_utility_model(model_name):
                kept.append(model_name)
                logger.info(f"[VRAM] Keeping utility model: {model_name} vram={vram}MB")
                continue
            logger.info(f"[VRAM] Evicting Ollama model: {model_name} (freeing ~{vram}MB)")
            try:
                await _http.post(
                    f"{OLLAMA_BASE_URL}/api/generate",
                    json={"model": model_name, "prompt": "", "keep_alive": 0, "stream": False},
                )
                evicted.append(model_name)
                await _broadcast_vram_log("gpu-manager", "evict", model_name, vram, f"freeing ~{vram}MB")
            except Exception as e:
                logger.warning(f"[VRAM] Failed to evict {model_name}: {e}")
        if evicted:
            logger.info(f"[VRAM] Ollama eviction requested: evicted={evicted} kept={kept}")
        return evicted
    except Exception as e:
        logger.warning(f"[VRAM] Ollama eviction failed: {e}")
        return []


async def _wait_vram_clear(exclude: str = None, timeout_s: int = 30):
    """Poll service health endpoints until all non-excluded services report model_loaded=False."""
    for _ in range(timeout_s):
        checks = {
            svc: _get_service_health(url)
            for svc, url in SERVICES.items() if svc != exclude
        }
        if checks:
            results = await asyncio.gather(*checks.values())
            healths = dict(zip(checks.keys(), results))
            if all(not h.get("model_loaded") for h in healths.values()):
                # Also check Ollama if we're not acquiring chat
                if exclude not in ("chat", "code"):
                    try:
                        ps = await _http.get(f"{OLLAMA_BASE_URL}/api/ps", timeout=5.0)
                        remaining = [
                            m.get("name", "") for m in ps.json().get("models", [])
                            if m.get("name") and not _is_utility_model(m.get("name", ""))
                        ]
                        if remaining:
                            await asyncio.sleep(1)
                            continue
                    except Exception:
                        pass
                logger.info("VRAM clear confirmed")
                return
        else:
            logger.info("VRAM clear confirmed")
            return
        await asyncio.sleep(1)
    logger.warning(f"VRAM clear timed out after {timeout_s}s")


async def _warmup_llm(model: str = None):
    """Send a minimal request to Ollama to preload an LLM into VRAM."""
    use_model = model or DEFAULT_LLM
    logger.info(f"[VRAM] Warming up LLM: {use_model}")
    t0 = time.time()
    try:
        await _http.post(
            f"{OLLAMA_BASE_URL}/api/generate",
            json={"model": use_model, "prompt": "", "keep_alive": "5m", "stream": False},
            timeout=120.0,
        )
        # Query actual VRAM usage after warmup
        vram = 0
        ps = await _http.get(f"{OLLAMA_BASE_URL}/api/ps", timeout=5.0)
        for m in ps.json().get("models", []):
            name = m.get("name", "")
            vram = round(m.get("size_vram", m.get("size", 0)) / 1024 / 1024)
            logger.info(f"[VRAM] Ollama model after warmup: {name} vram={vram}MB")
        elapsed = round(time.time() - t0, 1)
        logger.info(f"[VRAM] LLM {use_model} warmed up in {elapsed}s")
        await _broadcast_vram_log("gpu-manager", "load", use_model, vram, f"LLM warmed up in {elapsed}s")
    except Exception as e:
        logger.warning(f"[VRAM] LLM warmup failed for {use_model}: {e}")


class AcquireRequest(BaseModel):
    service: str
    model: Optional[str] = None
    pre_inference: bool = False


class ReleaseRequest(BaseModel):
    service: str


class VramLogEntry(BaseModel):
    service: str
    action: str
    model: str
    vram_mb: int = 0
    detail: str = ""


@app.post("/vram/log")
async def vram_log(entry: VramLogEntry):
    """Receive VRAM activity reports from other services."""
    vram = f" vram={entry.vram_mb}MB" if entry.vram_mb else ""
    reason = f" for {entry.detail}" if entry.detail else ""
    logger.info(f"[VRAM] {entry.service} → {entry.action} {entry.model}{vram}{reason}")
    await _broadcast_vram_log(entry.service, entry.action, entry.model, entry.vram_mb, entry.detail)
    return {"ok": True}


# -- VRAM profiles per service --
# Each profile defines what should be in VRAM for that service.
#   keep_services: other services to keep loaded alongside
#   keep_utility_llm: whether the utility LLM stays in VRAM
#   evict_all_llms: evict ALL Ollama models including utility
VRAM_PROFILES = {
    "chat": {
        # Chat: only the selected LLM, nothing else
        "keep_services": [],
        "keep_utility_llm": False,
        "evict_all_llms": True,
    },
    "image": {
        # Image: utility LLM (for session naming) + image model
        "keep_services": [],
        "keep_utility_llm": True,
        "evict_all_llms": False,
    },
    "music": {
        # Music: utility LLM (for naming/lyrics) + SDXL (cover art) + ACE-Step
        "keep_services": ["image"],
        "keep_utility_llm": True,
        "evict_all_llms": False,
    },
    "video": {
        # Video: Wan only, nothing else (needs all VRAM)
        "keep_services": [],
        "keep_utility_llm": False,
        "evict_all_llms": True,
    },
    "notetaker": {
        # Notetaker: Whisper only, nothing else (needs full VRAM for transcription)
        "keep_services": [],
        "keep_utility_llm": False,
        "evict_all_llms": True,
    },
    "code": {
        # Code Studio: only the selected coding LLM, nothing else
        "keep_services": [],
        "keep_utility_llm": False,
        "evict_all_llms": True,
    },
}

# SDXL Turbo is the small/fast model used for cover art
COVER_ART_MODEL = "sdxl-turbo"


@app.post("/acquire")
async def acquire(req: AcquireRequest):
    """Acquire VRAM for a service using per-service VRAM profiles."""
    if req.service not in list(SERVICES.keys()) + ["chat", "code"]:
        raise HTTPException(status_code=400, detail=f"Unknown service: {req.service}")

    profile = VRAM_PROFILES[req.service]

    async with _lock:
        t0 = time.time()
        model_label = req.model or req.service

        # ── Fast path: skip if pre_inference (need to evict Ollama regardless) ──
        if not req.pre_inference:
            try:
                if req.service in ("chat", "code"):
                    target_llm = req.model or DEFAULT_LLM
                    ps = await _http.get(f"{OLLAMA_BASE_URL}/api/ps", timeout=5.0)
                    loaded_llms = [m.get("name", "") for m in ps.json().get("models", []) if m.get("name")]
                    if target_llm in loaded_llms:
                        svc_healths = await asyncio.gather(*[_get_service_health(url) for url in SERVICES.values()])
                        if not any(h.get("model_loaded") for h in svc_healths):
                            elapsed = round(time.time() - t0, 3)
                            logger.info(f"[VRAM] ACQUIRE fast-path: {req.service} already in correct state ({elapsed}s)")
                            return {"ok": True, "service": req.service, "model": target_llm, "vram_mb": 0, "elapsed_s": elapsed, "fast_path": True}
                else:
                    target_health = await _get_service_health(SERVICES[req.service])
                    model_ok = target_health.get("model_loaded") and (not req.model or target_health.get("current_model") == req.model)
                    if model_ok:
                        stale = [svc for svc in SERVICES if svc != req.service and svc not in profile["keep_services"]]
                        stale_healths = await asyncio.gather(*[_get_service_health(SERVICES[s]) for s in stale]) if stale else []
                        no_stale = not any(h.get("model_loaded") for h in stale_healths)
                        ollama_ok = True
                        ps = await _http.get(f"{OLLAMA_BASE_URL}/api/ps", timeout=5.0)
                        loaded_llms = [m.get("name", "") for m in ps.json().get("models", []) if m.get("name")]
                        if profile["evict_all_llms"] and loaded_llms:
                            ollama_ok = False
                        elif not profile["evict_all_llms"] and loaded_llms:
                            unwanted = [m for m in loaded_llms if not _is_utility_model(m)]
                            if unwanted:
                                ollama_ok = False
                        if no_stale and ollama_ok:
                            elapsed = round(time.time() - t0, 3)
                            logger.info(f"[VRAM] ACQUIRE fast-path: {req.service} already in correct state ({elapsed}s)")
                            return {
                                "ok": True, "service": req.service,
                                "model": target_health.get("current_model"),
                                "vram_mb": target_health.get("vram_mb", 0),
                                "elapsed_s": elapsed, "fast_path": True,
                            }
            except Exception as e:
                logger.debug(f"[VRAM] Fast-path check failed, using full path: {e}")

        # ── Full acquire path ──
        logger.info(f"[VRAM] ={'='*60}")
        logger.info(f"[VRAM] ACQUIRE START: service={req.service} model={model_label}")
        logger.info(f"[VRAM] Profile: keep_services={profile['keep_services']} keep_utility={profile['keep_utility_llm']} evict_all_llms={profile['evict_all_llms']}")
        await _log_vram_state("before acquire")

        await _broadcast("acquiring", {"service": req.service, "model": model_label, "phase": "unloading"})

        # 1. Unload services not in the keep list and not the target (parallel)
        services_to_unload = [svc for svc in SERVICES if svc != req.service and svc not in profile["keep_services"]]
        if services_to_unload:
            logger.info(f"[VRAM] Phase 1: unloading services {services_to_unload}")
            await asyncio.gather(*[_unload_service(svc) for svc in services_to_unload])
        else:
            logger.info("[VRAM] Phase 1: no services to unload")

        # 2. Evict Ollama LLMs per profile
        logger.info(f"[VRAM] Phase 2: evicting Ollama LLMs (evict_all={profile['evict_all_llms']})")
        if profile["evict_all_llms"]:
            evicted = await _evict_ollama(keep_utility=False)
        else:
            evicted = await _evict_ollama(keep_utility=True)

        # 3. Wait for unloaded services AND evicted Ollama models to clear
        await _broadcast_status()
        services_to_wait = [svc for svc in SERVICES if svc != req.service and svc not in profile["keep_services"]]
        keep_utility = profile["keep_utility_llm"]
        if services_to_wait or evicted:
            logger.info(f"[VRAM] Phase 3: waiting for VRAM to clear (services={services_to_wait} evicted_llms={evicted})")
        wait_start = time.time()
        for i in range(30):
            all_clear = True

            # Check services in parallel
            if services_to_wait:
                health_tasks = {svc: _get_service_health(SERVICES[svc]) for svc in services_to_wait}
                results = await asyncio.gather(*health_tasks.values())
                healths = dict(zip(health_tasks.keys(), results))
                if not all(not h.get("model_loaded") for h in healths.values()):
                    all_clear = False

            # Check Ollama for evicted models still lingering
            if all_clear and evicted:
                try:
                    ps = await _http.get(f"{OLLAMA_BASE_URL}/api/ps", timeout=5.0)
                    still_loaded = [
                        m.get("name", "") for m in ps.json().get("models", [])
                        if m.get("name") and m.get("name") in evicted
                    ]
                    if still_loaded:
                        if i == 0:
                            logger.info(f"[VRAM] Phase 3: Ollama models still unloading: {still_loaded}")
                        all_clear = False
                except Exception:
                    pass

            if all_clear:
                break
            await asyncio.sleep(1)
        wait_elapsed = round(time.time() - wait_start, 1)
        if services_to_wait or evicted:
            logger.info(f"[VRAM] Phase 3: VRAM clear after {wait_elapsed}s")
        await _log_vram_state("after eviction/unload")

        # 4. Load the target service
        logger.info(f"[VRAM] Phase 4: loading target service={req.service} model={model_label}")
        await _broadcast("acquiring", {"service": req.service, "model": model_label, "phase": "loading"})
        result = {}

        if req.service in ("chat", "code"):
            await _warmup_llm(req.model)
            result = {"model": req.model or "default", "vram_mb": 0}
        else:
            target_health = await _get_service_health(SERVICES[req.service])
            if target_health.get("model_loaded"):
                logger.info(f"[VRAM] {req.service} already loaded: model={target_health.get('current_model')} vram={target_health.get('vram_mb', 0)}MB")
                result = {
                    "model": target_health.get("current_model"),
                    "vram_mb": target_health.get("vram_mb", 0),
                }
            else:
                result = await _load_service(req.service, req.model)

        # 5. For music: ensure SDXL Turbo is loaded for cover art
        if req.service == "music":
            img_health = await _get_service_health(IMAGE_GEN_URL)
            if not img_health.get("model_loaded") or img_health.get("current_model") != COVER_ART_MODEL:
                logger.info(f"[VRAM] Phase 5: loading {COVER_ART_MODEL} for music cover art")
                try:
                    await _load_service("image", COVER_ART_MODEL)
                except Exception as e:
                    logger.warning(f"[VRAM] Failed to load cover art model: {e}")

        # Pre-inference: evict ALL Ollama models to maximize VRAM for generation
        if req.pre_inference:
            logger.info("[VRAM] Pre-inference: evicting all Ollama models")
            evicted_pre = await _evict_ollama(keep_utility=False)
            if evicted_pre:
                for _ in range(30):
                    try:
                        ps = await _http.get(f"{OLLAMA_BASE_URL}/api/ps", timeout=5.0)
                        remaining = [m.get("name", "") for m in ps.json().get("models", []) if m.get("name")]
                        if not remaining:
                            break
                    except Exception:
                        break
                    await asyncio.sleep(1)
                logger.info("[VRAM] Pre-inference: Ollama VRAM cleared")

        elapsed = round(time.time() - t0, 2)
        await _log_vram_state("after acquire complete")
        logger.info(f"[VRAM] ACQUIRE DONE: service={req.service} model={result.get('model')} elapsed={elapsed}s")
        logger.info(f"[VRAM] ={'='*60}")
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
    logger.info(f"[VRAM] RELEASE: service={req.service}")
    await _log_vram_state("before release")

    if req.service in ("chat", "code"):
        await _evict_ollama(keep_utility=False)
        await _log_vram_state(f"after release {req.service}")
        await _broadcast_status()
        return {"ok": True, "service": req.service}

    if req.service not in SERVICES:
        raise HTTPException(status_code=400, detail=f"Unknown service: {req.service}")

    was_loaded = await _unload_service(req.service)
    await _log_vram_state("after release")
    await _broadcast_status()
    return {"ok": True, "service": req.service, "was_loaded": was_loaded}


@app.get("/gpu")
async def gpu_stats():
    """Return real GPU memory stats from nvidia-smi."""
    return await _query_nvidia_smi()


@app.get("/status")
async def status():
    """Report all currently loaded models across all services."""
    loaded = await _get_loaded_models()
    gpu = await _query_nvidia_smi()
    return {"loaded": loaded, "gpu": gpu}


@app.get("/events")
async def events():
    """SSE stream of VRAM state changes. Clients receive instant updates."""
    q: asyncio.Queue = asyncio.Queue(maxsize=50)
    _sse_clients.append(q)

    async def stream():
        try:
            # Send current state immediately on connect
            loaded = await _get_loaded_models()
            gpu = await _query_nvidia_smi()
            yield f"event: status\ndata: {json.dumps({'loaded': loaded, 'gpu': gpu})}\n\n"
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
