"""
tts-llm supervisor - owns the llama-server subprocess lifecycle.

llama.cpp's server has no runtime unload endpoint. Previously tts-llm
ran llama-server directly as the container's PID 1, pinning the Orpheus
GGUF (~1.8 GB) in VRAM for the container lifetime. This supervisor
wraps it in a FastAPI control plane so gpu-manager can spawn/terminate
the child process on demand, matching the shape of the other services
(/health, /models/load, /models/unload, /models/status).

Ports:
  5006 - llama-server completions endpoint (when running). tts-api
         continues to call this directly for streaming.
  5007 - supervisor control plane. Only gpu-manager calls this.
"""

import asyncio
import logging
import os
import shlex
import signal
import subprocess
import time
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException

logging.basicConfig(level=logging.INFO, format="%(asctime)s [tts-llm] %(message)s")
logger = logging.getLogger("tts-llm")

ORPHEUS_GGUF = os.environ.get("ORPHEUS_GGUF", "/models/Orpheus-3b-FT-Q4_K_M.gguf")
LLAMA_SERVER_ARGS = os.environ.get(
    "LLAMA_SERVER_ARGS",
    "--port 5006 --host 0.0.0.0 --n-gpu-layers 99 --ctx-size 10240 "
    "--n-predict 4096 --batch-size 2048 --ubatch-size 512 --flash-attn on "
    "--cache-type-k q8_0 --cache-type-v q8_0 --parallel 2 --cont-batching "
    "--cache-reuse 256",
)
LLAMA_SERVER_BIN = os.environ.get("LLAMA_SERVER_BIN", "/app/llama-server")
SUPERVISOR_PORT = int(os.environ.get("SUPERVISOR_PORT", "5007"))
CHILD_HEALTH_URL = "http://127.0.0.1:5006/health"
READY_TIMEOUT_S = int(os.environ.get("READY_TIMEOUT_S", "60"))

MODEL_NAME = os.path.splitext(os.path.basename(ORPHEUS_GGUF))[0].lower()

app = FastAPI(title="tts-llm supervisor")

_proc: Optional[subprocess.Popen] = None
_started_at: Optional[float] = None
_phase: str = "idle"  # idle | starting | ready | unloading | error
_last_error: str = ""
_lock = asyncio.Lock()
_http: httpx.AsyncClient = None


@app.on_event("startup")
async def startup():
    global _http
    _http = httpx.AsyncClient(timeout=5.0)
    logger.info(f"supervisor listening on :{SUPERVISOR_PORT}, model={ORPHEUS_GGUF}")
    if not os.path.exists(ORPHEUS_GGUF):
        logger.warning(f"GGUF not found at {ORPHEUS_GGUF} - tts-init may still be downloading")


@app.on_event("shutdown")
async def shutdown():
    global _http
    if _http:
        await _http.aclose()
    await _terminate_child()


def _child_alive() -> bool:
    return _proc is not None and _proc.poll() is None


async def _wait_child_ready(timeout_s: int) -> bool:
    """Poll the llama-server /health until it reports 200."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if not _child_alive():
            return False
        try:
            resp = await _http.get(CHILD_HEALTH_URL, timeout=2.0)
            # llama.cpp returns 200 once the model is loaded; 503 while loading.
            if resp.status_code == 200:
                return True
        except Exception:
            pass
        await asyncio.sleep(0.5)
    return False


async def _terminate_child():
    """SIGTERM the child, wait up to 5s, SIGKILL if still alive."""
    global _proc, _started_at, _phase
    if not _child_alive():
        _proc = None
        _started_at = None
        return
    pid = _proc.pid
    logger.info(f"terminating llama-server pid={pid}")
    try:
        _proc.terminate()
    except Exception as e:
        logger.warning(f"terminate failed: {e}")
    # Wait up to 5 s for graceful exit.
    for _ in range(50):
        if _proc.poll() is not None:
            break
        await asyncio.sleep(0.1)
    if _proc.poll() is None:
        logger.warning(f"llama-server pid={pid} did not exit, sending SIGKILL")
        try:
            _proc.kill()
        except Exception:
            pass
        try:
            _proc.wait(timeout=3)
        except Exception:
            pass
    logger.info(f"llama-server pid={pid} exited rc={_proc.returncode}")
    _proc = None
    _started_at = None


async def _spawn_child():
    """Spawn llama-server with the configured args and wait for readiness."""
    global _proc, _started_at, _phase, _last_error

    if not os.path.exists(ORPHEUS_GGUF):
        _phase = "error"
        _last_error = f"GGUF not found: {ORPHEUS_GGUF}"
        raise HTTPException(status_code=503, detail=_last_error)
    # Don't existence-check LLAMA_SERVER_BIN: the upstream image exposes
    # llama-server via PATH, so it's resolved by execvp at spawn time.
    args = [LLAMA_SERVER_BIN, "-m", ORPHEUS_GGUF] + shlex.split(LLAMA_SERVER_ARGS)
    logger.info(f"spawning: {' '.join(args)}")
    _phase = "starting"
    _last_error = ""
    _started_at = time.time()
    try:
        # cwd=/app so llama-server finds its sibling .so files via the
        # default library search path. The upstream image runs with
        # WorkingDir=/app; our supervisor lives in /supervisor and would
        # otherwise fail to load libmtmd.so.0 / libllama.so at startup.
        bin_dir = os.path.dirname(LLAMA_SERVER_BIN) or None
        # Inherit supervisor's stdout/stderr so llama-server output lands
        # in `docker logs tts-llm` and spawn failures aren't silenced.
        _proc = subprocess.Popen(
            args,
            cwd=bin_dir,
            preexec_fn=os.setsid if hasattr(os, "setsid") else None,
        )
    except Exception as e:
        _phase = "error"
        _last_error = f"spawn failed: {e}"
        logger.error(_last_error)
        raise HTTPException(status_code=500, detail=_last_error)

    ready = await _wait_child_ready(READY_TIMEOUT_S)
    if not ready:
        _phase = "error"
        _last_error = f"llama-server did not become ready within {READY_TIMEOUT_S}s"
        logger.error(_last_error)
        await _terminate_child()
        raise HTTPException(status_code=503, detail=_last_error)

    elapsed = round(time.time() - _started_at, 1)
    _phase = "ready"
    logger.info(f"llama-server ready in {elapsed}s (pid={_proc.pid})")


def _child_vram_mb() -> int:
    """Best-effort VRAM probe for the llama-server child via nvidia-smi.

    Matches rows from `nvidia-smi --query-compute-apps` where pid equals
    the child's pid, and sums used_memory. Returns 0 if nvidia-smi isn't
    usable or the child isn't running.
    """
    if not _child_alive():
        return 0
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-compute-apps=pid,used_memory",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if out.returncode != 0:
            return 0
        target = _proc.pid
        total = 0
        for line in out.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 2:
                continue
            try:
                pid = int(parts[0])
                mb = int(parts[1])
            except ValueError:
                continue
            if pid == target:
                total += mb
        return total
    except Exception:
        return 0


def _gguf_size_mb() -> int:
    try:
        return os.path.getsize(ORPHEUS_GGUF) // 1024 // 1024
    except Exception:
        return 0


@app.get("/health")
async def health():
    """Mirrors downstream service shape so gpu-manager treats tts like others."""
    loaded = _child_alive() and _phase == "ready"
    # While starting, still reach upstream to verify real readiness (guards
    # the case where the subprocess is alive but the model failed to mmap).
    if loaded:
        vram = _child_vram_mb() or _gguf_size_mb()
    else:
        vram = 0
    return {
        "ok": True,
        "model_loaded": loaded,
        "current_model": MODEL_NAME if loaded else None,
        "vram_mb": vram,
        "phase": _phase,
    }


@app.get("/models/status")
async def models_status():
    """Live load state for the frontend shimmer."""
    s = {"phase": _phase, "state": "unknown", "downloaded_bytes": 0}
    if _phase == "starting":
        s["state"] = "loading"
        if _started_at:
            s["elapsed_s"] = round(time.time() - _started_at, 1)
    elif _phase == "ready":
        s["state"] = "ready"
    elif _phase == "error":
        s["state"] = "error"
        s["error"] = _last_error
    else:
        s["state"] = "idle"
    return s


@app.get("/models")
async def list_models():
    return {
        "models": [{"id": MODEL_NAME, "name": "Orpheus 3B TTS"}],
        "current": MODEL_NAME if _child_alive() and _phase == "ready" else None,
    }


@app.post("/models/load")
async def load_model(body: dict = None):
    """Spawn llama-server if it isn't already running. Idempotent."""
    global _phase
    async with _lock:
        if _child_alive() and _phase == "ready":
            return {
                "ok": True,
                "model": MODEL_NAME,
                "vram_mb": _child_vram_mb() or _gguf_size_mb(),
                "already_loaded": True,
            }
        # If a stale process is lingering in a bad state, clean it up first.
        if _proc is not None and not _child_alive():
            logger.info(f"reaping stale child rc={_proc.returncode}")
            await _terminate_child()
        await _spawn_child()
        return {
            "ok": True,
            "model": MODEL_NAME,
            "vram_mb": _child_vram_mb() or _gguf_size_mb(),
            "already_loaded": False,
        }


@app.post("/models/unload")
async def unload_model():
    """Terminate llama-server. Idempotent."""
    global _phase
    async with _lock:
        if not _child_alive():
            _phase = "idle"
            return {"ok": True, "was_loaded": False, "vram_mb": 0}
        _phase = "unloading"
        await _terminate_child()
        _phase = "idle"
        return {"ok": True, "was_loaded": True, "freed_model": MODEL_NAME, "vram_mb": 0}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=SUPERVISOR_PORT, log_level="info")
