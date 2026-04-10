"""
code-runner - Sandboxed code execution for WoozleBox Code Studio.

Runs Python, JavaScript, and Bash snippets in isolated subprocesses
with timeout enforcement and output truncation.
"""

import os
import asyncio
import tempfile
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="code-runner")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

MAX_TIMEOUT = 60
DEFAULT_TIMEOUT = 30
MAX_OUTPUT = 100_000  # chars

RUNNERS = {
    "python": {"cmd": "python3", "ext": ".py"},
    "javascript": {"cmd": "node", "ext": ".js"},
    "bash": {"cmd": "bash", "ext": ".sh"},
}


class RunRequest(BaseModel):
    code: str
    language: str = "python"
    timeout: int = DEFAULT_TIMEOUT


@app.post("/run")
async def run_code(req: RunRequest):
    """Execute code in a subprocess with timeout."""
    lang = req.language.lower()
    if lang not in RUNNERS:
        return {
            "stdout": "",
            "stderr": f"Unsupported language: {lang}. Supported: {', '.join(RUNNERS.keys())}",
            "exit_code": 1,
            "timed_out": False,
        }

    runner = RUNNERS[lang]
    timeout = min(max(req.timeout, 1), MAX_TIMEOUT)

    # Write code to temp file
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=runner["ext"], delete=False, dir="/tmp"
    ) as f:
        f.write(req.code)
        tmpfile = f.name

    try:
        proc = await asyncio.create_subprocess_exec(
            runner["cmd"], tmpfile,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )

        timed_out = False
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=timeout
            )
        except asyncio.TimeoutError:
            timed_out = True
            proc.kill()
            stdout, stderr = await proc.communicate()

        stdout_str = stdout.decode("utf-8", errors="replace")[:MAX_OUTPUT]
        stderr_str = stderr.decode("utf-8", errors="replace")[:MAX_OUTPUT]

        return {
            "stdout": stdout_str,
            "stderr": stderr_str,
            "exit_code": proc.returncode or 0,
            "timed_out": timed_out,
        }
    except Exception as e:
        logger.error(f"Code execution error: {e}")
        return {
            "stdout": "",
            "stderr": str(e),
            "exit_code": 1,
            "timed_out": False,
        }
    finally:
        try:
            os.unlink(tmpfile)
        except OSError:
            pass


@app.get("/health")
async def health():
    return {"ok": True, "service": "code-runner"}
