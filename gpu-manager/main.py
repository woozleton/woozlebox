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
from collections import deque

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
TTS_LLM_URL = os.environ.get("TTS_LLM_URL", "http://tts-llm:5007")
TTS_MODEL_DIR = os.environ.get("TTS_MODEL_DIR", "/tts_models")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://ollama:11434")
UTILITY_MODEL = os.environ.get("UTILITY_MODEL", "qwen3:0.6b")
DEFAULT_LLM = os.environ.get("LLM_MODEL", "qwen3:30b-a3b")

# VRAM budgeting config - used for the chat+tts coexistence fit check.
VRAM_RESERVED_MB = int(os.environ.get("VRAM_RESERVED_MB", "2500"))
IDLE_UNLOAD_MIN = int(os.environ.get("IDLE_UNLOAD_MIN", "15"))
# Headroom kept free on top of (chat LLM + Orpheus) so the GPU is not driven
# to the edge. 1500MB was too tight: a 27B (~16.7GB) + Orpheus (~2.2GB) passed
# the fit check yet pushed a 24GB card to ~98% with the desktop compositor.
# At 3500MB on a 24GB card the coexistence cutoff is ~16GB of chat-LLM weights:
# anything larger (e.g. a 27B) evicts Orpheus and disables voice instead. A ~9B
# voice-mode model (~10-13GB) still keeps TTS comfortably.
TTS_FIT_HEADROOM_MB = int(os.environ.get("TTS_FIT_HEADROOM_MB", "3500"))

_GPU_FALLBACK = {"used_mb": 0, "free_mb": 0, "total_mb": 24576, "gpu_name": "Unknown"}

# Cached GPU total, populated on first call. Avoids spawning nvidia-smi
# on every fit-check.
_gpu_total_mb_cache: int = 0


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
    # tts uses the llama-server supervisor control plane on :5007
    # (NOT the llama-server completions endpoint on :5006). The supervisor
    # exposes the standard /health, /models/load, /models/unload shape so
    # tts is treated uniformly by _unload_service / fast-path / idle-unload.
    "tts": TTS_LLM_URL,
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
    # Prime nvidia-smi cache for the budget helper.
    await _gpu_budget_mb()
    # Start the idle-unload loop if enabled (IDLE_UNLOAD_MIN > 0).
    if IDLE_UNLOAD_MIN > 0:
        asyncio.create_task(_idle_unload_loop())
        logger.info(f"idle-unload loop started (IDLE_UNLOAD_MIN={IDLE_UNLOAD_MIN})")


async def _idle_unload_loop():
    """Background task: every 60 s, evict services that have been idle too long.

    A service is considered "active" when /acquire is called against it
    (we stamp _last_activity at acquire time). If now - last > IDLE_UNLOAD_MIN
    minutes AND the downstream /health says the model is loaded, we unload it.
    """
    idle_seconds = IDLE_UNLOAD_MIN * 60
    while True:
        try:
            await asyncio.sleep(60)
            now = time.time()
            # Check every tracked service (not just keys in _last_activity;
            # a long-loaded service that never got a refresh should still evict).
            chat_recent = (now - _last_activity.get("chat", 0)) < idle_seconds
            for svc in list(SERVICES.keys()):
                # TTS is allowed to live alongside an active chat session
                # (the chat profile pins it via keep_if_fits). If chat has
                # been active within the idle window, skip tts eviction so
                # the user isn't paying a cold-load tax mid-conversation.
                if svc == "tts" and chat_recent and not _tts_blocked_by:
                    continue
                last = _last_activity.get(svc, 0)
                if last == 0:
                    # Never activated via acquire in this process lifetime.
                    # Stamp now so we don't immediately evict things that were
                    # loaded externally (e.g. the supervisor starting in idle).
                    _last_activity[svc] = now
                    continue
                if now - last < idle_seconds:
                    continue
                health = await _get_service_health(SERVICES[svc])
                if not health.get("model_loaded"):
                    continue
                idle_min = round((now - last) / 60, 1)
                logger.info(f"[VRAM] idle-unload: {svc} idle for {idle_min}min, unloading")
                await _broadcast_verbose(
                    "gpu-manager", "idle-unload", svc,
                    detail=f"idle {idle_min}min, unloading",
                )
                try:
                    async with _lock:
                        await _unload_service(svc)
                    await _broadcast_status()
                except Exception as e:
                    logger.warning(f"[VRAM] idle-unload of {svc} failed: {e}")
                # Reset the stamp so we don't spam unload attempts.
                _last_activity[svc] = now
        except asyncio.CancelledError:
            return
        except Exception as e:
            logger.warning(f"[VRAM] idle-unload loop error: {e}")


@app.on_event("shutdown")
async def shutdown():
    global _http
    if _http:
        await _http.aclose()
        _http = None


# -- SSE broadcast --
# Each connected client is tracked as (queue, verbose) so the fan-out
# can skip verbose entries for clients that don't want them. The ring
# buffer retains every entry (verbose or not) and is replayed on
# reconnect, filtered per-client at replay time.
_sse_clients: list[tuple[asyncio.Queue, bool]] = []
_vram_log_ring: deque = deque(maxlen=2000)
_vram_log_seq: int = 0


def _next_seq() -> int:
    global _vram_log_seq
    _vram_log_seq += 1
    return _vram_log_seq


async def _broadcast(event: str, data: dict):
    """Push an event to all connected SSE clients.

    For vram_log events, payloads with level=="verbose" are skipped
    for clients that did not subscribe with ?verbose=1.
    """
    msg = f"event: {event}\ndata: {json.dumps(data)}\n\n"
    is_verbose = event == "vram_log" and data.get("level") == "verbose"
    for q, verbose in _sse_clients[:]:
        if is_verbose and not verbose:
            continue
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            pass


async def _broadcast_vram_log(
    service: str,
    action: str,
    model: str,
    vram_mb: int = 0,
    detail: str = "",
    level: str = "normal",
):
    """Broadcast a VRAM activity event to SSE clients and ring buffer.

    `level` is "normal" (default) or "verbose". Verbose events only
    reach clients that connected to /events?verbose=1, but all events
    are stored in the ring buffer so reconnecting verbose clients see
    their history.
    """
    payload = {
        "service": service,
        "action": action,
        "model": model,
        "vram_mb": vram_mb,
        "detail": detail,
        "level": level,
        "ts": int(time.time() * 1000),
        "seq": _next_seq(),
    }
    _vram_log_ring.append(payload)
    await _broadcast("vram_log", payload)


async def _broadcast_verbose(service: str, action: str, model: str, detail: str = "", vram_mb: int = 0):
    """Shorthand for a verbose-level vram log entry."""
    await _broadcast_vram_log(service, action, model, vram_mb=vram_mb, detail=detail, level="verbose")


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
            vram = health.get("vram_mb", 0)
            # tts supervisor may report 0 MB when nvidia-smi query-compute-apps
            # is not usable inside WSL2 docker. Fall back to the GGUF file size
            # as an honest lower-bound for real allocation.
            if svc == "tts" and not vram:
                vram = _tts_gguf_mb()
            return {"name": health["current_model"], "type": svc, "vram_mb": vram}
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


def _tts_gguf_mb() -> int:
    """File-size fallback for Orpheus GGUF VRAM estimate."""
    try:
        ggufs = [f for f in os.listdir(TTS_MODEL_DIR) if f.endswith(".gguf")]
        if not ggufs:
            return 0
        path = os.path.join(TTS_MODEL_DIR, ggufs[0])
        return os.path.getsize(path) // 1024 // 1024
    except Exception:
        return 0


async def _chat_llm_vram_mb(model_name: str) -> int:
    """Estimate VRAM cost of an Ollama chat LLM.

    Prefers the live `/api/ps` size_vram when the model is currently
    loaded; otherwise falls back to the model's on-disk file size from
    `/api/tags` (an honest lower bound, since all weights must load into
    VRAM). The fit-check runs BEFORE the target model is loaded, so the
    /api/tags fallback is the common case - returning 0 here would make a
    large model wrongly appear to leave room for TTS. Returns 0 only if
    the model is genuinely unknown to Ollama.
    """
    if not model_name:
        return 0
    try:
        ps = await _http.get(f"{OLLAMA_BASE_URL}/api/ps", timeout=5.0)
        for m in ps.json().get("models", []):
            if m.get("name") == model_name:
                sv = m.get("size_vram") or m.get("size") or 0
                if sv:
                    return round(sv / 1024 / 1024)
    except Exception:
        pass
    # Not loaded: use the GGUF file size reported by /api/tags. This is the
    # reliable source - /api/show has no usable top-level size field.
    try:
        tags = await _http.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=5.0)
        for m in tags.json().get("models", []):
            if m.get("name") == model_name:
                size = m.get("size") or 0
                if size:
                    return round(size / 1024 / 1024)
    except Exception as e:
        logger.debug(f"chat LLM vram probe failed for {model_name}: {e}")
    return 0


async def _gpu_budget_mb() -> int:
    """Return effective VRAM budget (total - reserved).

    Uses a cached nvidia-smi read to avoid spawning a subprocess on every
    fit check. Cache is populated on first successful query.
    """
    global _gpu_total_mb_cache
    if _gpu_total_mb_cache:
        return max(0, _gpu_total_mb_cache - VRAM_RESERVED_MB)
    stats = await _query_nvidia_smi()
    total = stats.get("total_mb", 0)
    if total:
        _gpu_total_mb_cache = total
    return max(0, total - VRAM_RESERVED_MB)


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
        # Check for gated repo error (403 from downstream service)
        if resp.status_code == 403:
            detail = resp.json().get("detail", "HuggingFace repo access denied")
            gated_repo = resp.headers.get("x-gated-repo", "")
            logger.error(f"[VRAM] Gated repo error loading {service}: {detail}")
            raise HTTPException(
                status_code=403,
                detail=detail,
                headers={"X-Gated-Repo": gated_repo} if gated_repo else None,
            )
        # Any other non-2xx is a real load failure. Without this check we
        # silently return `ok:true` with empty fields when a downstream
        # service reports 500/503, masking spawn/OOM errors from the UI.
        if resp.status_code >= 400:
            try:
                detail = resp.json().get("detail", f"HTTP {resp.status_code}")
            except Exception:
                detail = f"HTTP {resp.status_code}"
            logger.error(f"[VRAM] {service} /models/load failed: {detail}")
            raise HTTPException(
                status_code=resp.status_code,
                detail=f"{service} load failed: {detail}",
            )
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
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[VRAM] Failed to load {service} model={model_label}: {e}")
        raise HTTPException(status_code=503, detail=f"Failed to load {service} model: {e}")


async def _evict_ollama(keep_utility: bool = True, keep_model: str = None):
    """Evict all Ollama LLMs from VRAM, optionally keeping the utility model or a specific model."""
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
            if keep_model and model_name == keep_model:
                kept.append(model_name)
                logger.info(f"[VRAM] Keeping target model: {model_name} vram={vram}MB")
                await _broadcast_vram_log("gpu-manager", "keep", model_name, vram, "already loaded")
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


@app.get("/load_status")
async def load_status(service: str):
    """Proxy a service's /models/status so the frontend can poll a single
    origin for live download/load progress during /acquire."""
    url = SERVICES.get(service)
    if not url:
        raise HTTPException(status_code=400, detail=f"unknown service: {service}")
    try:
        resp = await _http.get(f"{url}/models/status", timeout=3.0)
        if resp.status_code == 200:
            return resp.json()
        return {"state": "unknown", "phase": "", "downloaded_bytes": 0}
    except Exception as e:
        logger.debug(f"load_status proxy to {service} failed: {e}")
        return {"state": "unknown", "phase": "", "downloaded_bytes": 0}


# -- VRAM profiles per service --
# Each profile defines what should be in VRAM for that service.
#   keep_services: other services to keep loaded alongside
#   keep_utility_llm: whether the utility LLM stays in VRAM
#   evict_all_llms: evict ALL Ollama models including utility
#   tts_policy: "keep_if_fits" | "evict" | "on_demand" - how to treat tts
VRAM_PROFILES = {
    "chat": {
        # Chat: selected LLM + Orpheus tts (if both fit in VRAM budget).
        # If they don't fit, tts is evicted and _tts_blocked_by is set so
        # subsequent TTS requests return 409 with a clear error.
        "keep_services": [],
        "keep_utility_llm": False,
        "evict_all_llms": True,
        "tts_policy": "keep_if_fits",
    },
    "image": {
        # Image: utility LLM (for session naming) + image model. No tts.
        "keep_services": [],
        "keep_utility_llm": True,
        "evict_all_llms": False,
        "tts_policy": "evict",
    },
    "music": {
        # Music: utility LLM (for naming/lyrics) + SDXL (cover art) + ACE-Step. No tts.
        "keep_services": ["image"],
        "keep_utility_llm": True,
        "evict_all_llms": False,
        "tts_policy": "evict",
    },
    "video": {
        # Video: Wan only, nothing else (needs all VRAM).
        "keep_services": [],
        "keep_utility_llm": False,
        "evict_all_llms": True,
        "tts_policy": "evict",
    },
    "notetaker": {
        # Notetaker: Whisper only. tts is loaded on-demand when the user
        # plays a summary and released after playback.
        "keep_services": [],
        "keep_utility_llm": False,
        "evict_all_llms": True,
        "tts_policy": "on_demand",
    },
    "code": {
        # Code Studio: only the selected coding LLM, nothing else.
        "keep_services": [],
        "keep_utility_llm": False,
        "evict_all_llms": True,
        "tts_policy": "evict",
    },
    "songwriting": {
        # Songwriting: evict everything so the full LLM can load for lyrics generation.
        "keep_services": [],
        "keep_utility_llm": False,
        "evict_all_llms": True,
        "tts_policy": "evict",
    },
}

# -- Runtime state for TTS coexistence --
# When the active chat LLM is too large to coexist with Orpheus, this
# holds the offending chat-model name. /acquire?service=tts returns
# 409 in that state, and chat-settings.js surfaces a pill.
_tts_blocked_by: Optional[str] = None
# Per-service last-activity timestamps for the idle-unload timer.
_last_activity: dict = {}

# SDXL Turbo is the small/fast model used for cover art
COVER_ART_MODEL = "sdxl-turbo"


@app.post("/acquire")
async def acquire(req: AcquireRequest):
    """Acquire VRAM for a service using per-service VRAM profiles."""
    global _tts_blocked_by
    if req.service not in list(SERVICES.keys()) + ["chat", "code", "songwriting"]:
        raise HTTPException(status_code=400, detail=f"Unknown service: {req.service}")

    # ── tts pseudo-service: on-demand supervisor load, no profile eviction ──
    if req.service == "tts":
        async with _lock:
            t0 = time.time()
            _last_activity["tts"] = time.time()
            if _tts_blocked_by:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"Chat model {_tts_blocked_by} leaves insufficient VRAM "
                        f"for TTS. Switch to a smaller chat model first."
                    ),
                )
            try:
                result = await _load_service("tts")
                elapsed = round(time.time() - t0, 2)
                await _broadcast_status()
                return {
                    "ok": True,
                    "service": "tts",
                    "model": result.get("model"),
                    "vram_mb": result.get("vram_mb", 0),
                    "elapsed_s": elapsed,
                }
            except HTTPException:
                raise
            except Exception as e:
                raise HTTPException(status_code=503, detail=f"tts load failed: {e}")

    profile = VRAM_PROFILES[req.service]

    async with _lock:
        t0 = time.time()
        model_label = req.model or req.service
        _last_activity[req.service] = time.time()

        # ── Resolve tts coexistence policy for this profile ──
        # chat: keep tts if (chat_llm + tts + headroom) fits the budget.
        # image/music/video/code/notetaker/songwriting: always evict tts.
        tts_policy = profile.get("tts_policy", "evict")
        keep_tts = False
        if tts_policy == "keep_if_fits" and req.service in ("chat", "code", "songwriting"):
            target_llm = req.model or DEFAULT_LLM
            llm_mb = await _chat_llm_vram_mb(target_llm)
            tts_mb = _tts_gguf_mb()
            budget = await _gpu_budget_mb()
            required = llm_mb + tts_mb + TTS_FIT_HEADROOM_MB
            fits = bool(budget) and required <= budget
            logger.info(
                f"[VRAM] chat-tts fit check: llm={llm_mb}MB tts={tts_mb}MB "
                f"headroom={TTS_FIT_HEADROOM_MB}MB total={required}MB budget={budget}MB fits={fits}"
            )
            await _broadcast_verbose(
                "gpu-manager", "fit-check", target_llm,
                detail=(
                    f"llm={llm_mb}MB tts={tts_mb}MB headroom={TTS_FIT_HEADROOM_MB}MB "
                    f"required={required}MB budget={budget}MB fits={fits}"
                ),
            )
            if fits:
                keep_tts = True
                if _tts_blocked_by:
                    logger.info(f"[VRAM] clearing tts block (was: {_tts_blocked_by})")
                    await _broadcast_verbose(
                        "gpu-manager", "tts-block", _tts_blocked_by,
                        detail="cleared",
                    )
                    _tts_blocked_by = None
            else:
                if _tts_blocked_by != target_llm:
                    logger.info(f"[VRAM] setting tts block: {target_llm}")
                    await _broadcast_verbose(
                        "gpu-manager", "tts-block", target_llm,
                        detail="set - chat LLM too large to coexist with tts",
                    )
                _tts_blocked_by = target_llm
        elif tts_policy != "on_demand":
            # Explicit evict - clear any stale block so re-entering chat recomputes.
            pass

        # Build effective keep_services including conditional tts.
        effective_keeps = list(profile["keep_services"])
        if keep_tts and "tts" not in effective_keeps:
            effective_keeps.append("tts")

        # ── Fast path: skip if pre_inference (need to evict Ollama regardless) ──
        if not req.pre_inference:
            try:
                if req.service in ("chat", "code", "songwriting"):
                    target_llm = req.model or DEFAULT_LLM
                    ps = await _http.get(f"{OLLAMA_BASE_URL}/api/ps", timeout=5.0)
                    loaded_llms = [m.get("name", "") for m in ps.json().get("models", []) if m.get("name")]
                    if target_llm in loaded_llms:
                        # Every non-kept service must be unloaded for fast-path to succeed.
                        non_keeps = [svc for svc in SERVICES if svc not in effective_keeps]
                        svc_healths = await asyncio.gather(*[_get_service_health(SERVICES[s]) for s in non_keeps])
                        if not any(h.get("model_loaded") for h in svc_healths):
                            # If tts should be kept, verify it's actually loaded.
                            tts_ok = True
                            if keep_tts:
                                tts_health = await _get_service_health(SERVICES["tts"])
                                tts_ok = bool(tts_health.get("model_loaded"))
                            if tts_ok:
                                elapsed = round(time.time() - t0, 3)
                                logger.info(f"[VRAM] ACQUIRE fast-path: {req.service} already in correct state ({elapsed}s)")
                                await _broadcast_verbose(
                                    "gpu-manager", "fast-path", target_llm,
                                    detail=f"{req.service} already in correct state ({elapsed}s)",
                                )
                                return {
                                    "ok": True, "service": req.service, "model": target_llm,
                                    "vram_mb": 0, "elapsed_s": elapsed, "fast_path": True,
                                    "tts_blocked_by": _tts_blocked_by,
                                }
                else:
                    target_health = await _get_service_health(SERVICES[req.service])
                    model_ok = target_health.get("model_loaded") and (not req.model or target_health.get("current_model") == req.model)
                    if model_ok:
                        stale = [svc for svc in SERVICES if svc != req.service and svc not in effective_keeps]
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
                            current = target_health.get("current_model") or req.service
                            logger.info(f"[VRAM] ACQUIRE fast-path: {req.service} already in correct state ({elapsed}s)")
                            await _broadcast_verbose(
                                "gpu-manager", "fast-path", current,
                                detail=f"{req.service} already in correct state ({elapsed}s)",
                            )
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
        logger.info(f"[VRAM] Profile: keep_services={effective_keeps} keep_utility={profile['keep_utility_llm']} evict_all_llms={profile['evict_all_llms']} tts_policy={tts_policy} keep_tts={keep_tts}")
        await _broadcast_verbose(
            "gpu-manager", "acquire-start", model_label,
            detail=(
                f"service={req.service} keeps={effective_keeps} "
                f"evict_all_llms={profile['evict_all_llms']} tts_policy={tts_policy} keep_tts={keep_tts}"
            ),
        )
        await _log_vram_state("before acquire")

        await _broadcast("acquiring", {"service": req.service, "model": model_label, "phase": "unloading"})

        # 1. Unload services not in the keep list and not the target (parallel)
        services_to_unload = [svc for svc in SERVICES if svc != req.service and svc not in effective_keeps]
        phase_start = time.time()
        if services_to_unload:
            logger.info(f"[VRAM] Phase 1: unloading services {services_to_unload}")
            await _broadcast_verbose(
                "gpu-manager", "phase", "phase-1",
                detail=f"unloading services {services_to_unload}",
            )
            await asyncio.gather(*[_unload_service(svc) for svc in services_to_unload])
        else:
            logger.info("[VRAM] Phase 1: no services to unload")
            await _broadcast_verbose(
                "gpu-manager", "phase", "phase-1",
                detail="no services to unload",
            )

        # 2. Evict Ollama LLMs per profile
        # For chat/code/songwriting, keep the target LLM if it's already loaded
        target_llm = (req.model or DEFAULT_LLM) if req.service in ("chat", "code", "songwriting") else None
        logger.info(f"[VRAM] Phase 2: evicting Ollama LLMs (evict_all={profile['evict_all_llms']}, keep_target={target_llm})")
        await _broadcast_verbose(
            "gpu-manager", "phase", "phase-2",
            detail=f"evicting Ollama LLMs (evict_all={profile['evict_all_llms']}, keep_target={target_llm or '-'})",
        )
        if profile["evict_all_llms"]:
            evicted = await _evict_ollama(keep_utility=False, keep_model=target_llm)
        else:
            evicted = await _evict_ollama(keep_utility=True, keep_model=target_llm)

        # 3. Wait for unloaded services AND evicted Ollama models to clear
        await _broadcast_status()
        services_to_wait = [svc for svc in SERVICES if svc != req.service and svc not in effective_keeps]
        keep_utility = profile["keep_utility_llm"]
        if services_to_wait or evicted:
            logger.info(f"[VRAM] Phase 3: waiting for VRAM to clear (services={services_to_wait} evicted_llms={evicted})")
            await _broadcast_verbose(
                "gpu-manager", "phase", "phase-3",
                detail=f"waiting for VRAM clear (services={services_to_wait} evicted_llms={evicted})",
            )
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
            await _broadcast_verbose(
                "gpu-manager", "phase", "phase-3-done",
                detail=f"VRAM clear after {wait_elapsed}s",
            )
        await _log_vram_state("after eviction/unload")

        # 4. Load the target service
        logger.info(f"[VRAM] Phase 4: loading target service={req.service} model={model_label}")
        await _broadcast_verbose(
            "gpu-manager", "phase", "phase-4",
            detail=f"loading target service={req.service} model={model_label}",
        )
        await _broadcast("acquiring", {"service": req.service, "model": model_label, "phase": "loading"})
        result = {}

        if req.service in ("chat", "code", "songwriting"):
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

        # 4b. For chat profiles with keep_tts, ensure tts is loaded.
        if keep_tts:
            tts_health = await _get_service_health(SERVICES["tts"])
            if not tts_health.get("model_loaded"):
                logger.info("[VRAM] Phase 4b: loading tts alongside chat LLM")
                await _broadcast_verbose(
                    "gpu-manager", "phase", "phase-4b",
                    detail="loading tts alongside chat LLM",
                )
                try:
                    await _load_service("tts")
                    _last_activity["tts"] = time.time()
                except Exception as e:
                    logger.warning(f"[VRAM] Failed to load tts: {e}")

        # 5. For music: ensure SDXL Turbo is loaded for cover art
        if req.service == "music":
            img_health = await _get_service_health(IMAGE_GEN_URL)
            if not img_health.get("model_loaded") or img_health.get("current_model") != COVER_ART_MODEL:
                logger.info(f"[VRAM] Phase 5: loading {COVER_ART_MODEL} for music cover art")
                await _broadcast_verbose(
                    "gpu-manager", "phase", "phase-5",
                    detail=f"loading {COVER_ART_MODEL} for music cover art",
                )
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
        await _broadcast_verbose(
            "gpu-manager", "acquire-done", result.get("model") or model_label,
            detail=f"service={req.service} elapsed={elapsed}s",
        )
        await _broadcast_status()

        return {
            "ok": True,
            "service": req.service,
            "model": result.get("model"),
            "vram_mb": result.get("vram_mb", 0),
            "elapsed_s": elapsed,
            "tts_blocked_by": _tts_blocked_by,
            "tts_kept": keep_tts,
        }


@app.post("/release")
async def release(req: ReleaseRequest):
    """Release VRAM held by a service."""
    logger.info(f"[VRAM] RELEASE: service={req.service}")
    await _log_vram_state("before release")

    if req.service in ("chat", "code", "songwriting"):
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
    """Report all currently loaded models across all services.

    Each /status call reconciles downstream /health ground truth (via
    `_get_loaded_models`) so a crashed/restarted service is reflected
    in the next UI poll. Also surfaces the tts block flag and the
    effective VRAM budget.
    """
    loaded = await _get_loaded_models()
    gpu = await _query_nvidia_smi()
    budget = await _gpu_budget_mb()
    return {
        "loaded": loaded,
        "gpu": gpu,
        "tts_blocked_by": _tts_blocked_by,
        "budget_mb": budget,
        "reserved_mb": VRAM_RESERVED_MB,
    }


@app.get("/events")
async def events(verbose: int = 0):
    """SSE stream of VRAM state changes. Clients receive instant updates.

    Query params:
      verbose=1  - also receive level=="verbose" vram_log entries
    """
    want_verbose = bool(verbose)
    q: asyncio.Queue = asyncio.Queue(maxsize=200)
    entry = (q, want_verbose)
    _sse_clients.append(entry)

    async def stream():
        try:
            # Send current state immediately on connect
            loaded = await _get_loaded_models()
            gpu = await _query_nvidia_smi()
            yield f"event: status\ndata: {json.dumps({'loaded': loaded, 'gpu': gpu})}\n\n"
            # Replay ring buffer so refreshed clients recover history.
            # Verbose clients see everything; normal clients only see
            # normal-level entries.
            for item in list(_vram_log_ring):
                if item.get("level") == "verbose" and not want_verbose:
                    continue
                yield f"event: vram_log\ndata: {json.dumps(item)}\n\n"
            while True:
                msg = await q.get()
                yield msg
        except asyncio.CancelledError:
            pass
        finally:
            try:
                _sse_clients.remove(entry)
            except ValueError:
                pass

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
