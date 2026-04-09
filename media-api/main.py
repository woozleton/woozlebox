"""
media-api - Media orchestration proxy for WoozleBox.

Handles all image, music, and video generation workflows.
Proxies to gen services (image-api, music-api, video-api),
coordinates GPU via gpu-manager, and uses Ollama for
utility LLM tasks (inspire, naming, songwriting, cover art).

Auth is validated by forwarding Bearer tokens to rag-api.
"""

import os
import re
import json
import time
import logging
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- Config ---
OLLAMA_BASE_URL   = os.environ.get("OLLAMA_BASE_URL", "http://ollama:11434")
UTILITY_MODEL     = os.environ.get("UTILITY_MODEL", "qwen3:0.6b")
LLM_MODEL         = os.environ.get("LLM_MODEL", "qwen3:30b-a3b")
CHAT_API_URL      = os.environ.get("CHAT_API_URL", "http://rag-api:8000")
IMAGE_GEN_URL     = os.environ.get("IMAGE_GEN_URL", "http://image-api:8100")
MUSIC_GEN_URL     = os.environ.get("MUSIC_GEN_URL", "http://music-api:8200")
VIDEO_GEN_URL     = os.environ.get("VIDEO_GEN_URL", "http://video-api:8300")
NOTETAKER_API_URL = os.environ.get("NOTETAKER_API_URL", "http://notetaker-api:8600")
GPU_MANAGER_URL   = os.environ.get("GPU_MANAGER_URL", "http://gpu-manager:8400")

# ── LLM Prompt Templates ──
# All system prompts in one place for easy editing.
PROMPTS = {
    "image_inspire": (
        "You are a creative director who generates vivid, detailed text-to-image prompts. "
        "Generate exactly ONE unique, imaginative prompt for an AI image generator. "
        "Be specific about subject, setting, lighting, mood, and composition. "
        "Vary widely between styles: landscapes, portraits, fantasy, sci-fi, nature, "
        "architecture, abstract, etc. "
        "Output ONLY the prompt text, nothing else -no quotes, no explanation, no numbering."
    ),
    "music_inspire": (
        "You are a music producer who generates creative text-to-music prompts for an AI "
        "music generator. Generate exactly ONE unique, vivid music prompt describing genre, "
        "mood, instruments, tempo feel, and vibe. "
        "Vary widely between styles: pop, rock, jazz, electronic, classical, hip-hop, folk, "
        "ambient, metal, world, funk, cinematic, etc. "
        "Output ONLY the prompt text, nothing else -no quotes, no explanation, no numbering. "
        "Keep it to 1-2 sentences."
    ),
    "song_title": (
        "You are a creative music producer. Given a song's style description and optional "
        "lyrics, generate exactly ONE short, catchy song title (1-5 words). "
        "Be creative and evocative. Output ONLY the title -no quotes, no explanation, "
        "no punctuation except what's part of the title."
    ),
    "cover_art": (
        "You are an album cover art director. Given a song description, generate a short "
        "visual prompt for an album cover image. Describe the mood, colors, composition, "
        "and artistic style. Think abstract, artistic, and evocative. Do NOT include text "
        "or words in the image. "
        "Output ONLY the image prompt, 1-2 sentences, no quotes or explanation."
    ),
    "songwriting": (
        "You are a professional songwriter and music producer. Given a brief description, generate:\n"
        "1. A concise music STYLE prompt (genre, mood, instruments, tempo feel) "
        "-this describes the sound, NOT the lyrics\n"
        "2. Full structured LYRICS with section tags like [verse], [chorus], [bridge], [outro]\n\n"
        "Rules:\n"
        "- The style prompt should be 1-2 sentences describing genre, mood, instruments, and vibe\n"
        "- Lyrics should have at least 2 verses and a chorus\n"
        "- Use [verse], [chorus], [bridge], [pre-chorus], [outro] tags on their own lines\n"
        "- Write natural, singable lyrics that match the described mood\n"
        "- Keep lyrics concise -each section should be 2-4 lines\n"
        "- Do NOT include any explanation, just the output\n\n"
        "Respond in EXACTLY this format:\n"
        "STYLE: <style prompt here>\n\n"
        "LYRICS:\n"
        "<full lyrics here>"
    ),
    "video_inspire": (
        "You are a creative video director who generates vivid text-to-video prompts for an "
        "AI video generator. Generate exactly ONE unique, cinematic video prompt describing "
        "the scene, action, camera movement, lighting, and mood. "
        "Vary widely between styles: nature documentary, cinematic narrative, abstract art, "
        "sci-fi, urban life, underwater, aerial, timelapse, etc. "
        "Output ONLY the prompt text, nothing else -no quotes, no explanation, no numbering. "
        "Keep it to 1-2 sentences."
    ),
    "video_session_title": (
        "Generate a short, descriptive title (3-6 words) for a video generation session "
        "based on the prompt. Capture the main scene and mood. "
        "Output ONLY the title text, no quotes, no explanation."
    ),
    "video_thumbnail": (
        "You are a video thumbnail designer. Given a video description, generate a short "
        "visual prompt for a cinematic still frame that captures the essence of the video. "
        "Describe the key moment, composition, lighting, and cinematic feel. "
        "Do NOT include text or words in the image. "
        "Output ONLY the image prompt, 1-2 sentences, no quotes or explanation."
    ),
    # -- Note Taker summary prompts (one per note type) --
    "notetaker_summary_professional": (
        "You are a professional meeting note-taker. Given a meeting transcript with speaker labels, "
        "generate a structured summary with these sections:\n\n"
        "SUMMARY: A concise 2-3 paragraph overview of the meeting.\n\n"
        "KEY DECISIONS: Bullet list of decisions made.\n\n"
        "ACTION ITEMS: Bullet list with owner and deadline if mentioned.\n\n"
        "FOLLOW-UPS: Items that need further discussion or resolution.\n\n"
        "Be concise and factual. Use the speaker labels from the transcript. "
        "Output in plain text with the section headers above."
    ),
    "notetaker_summary_personal": (
        "You are a helpful personal assistant. Given a transcript of a personal appointment or consultation "
        "(e.g., doctor visit, legal consult, financial planning), generate a structured summary:\n\n"
        "KEY TAKEAWAYS: The most important points discussed.\n\n"
        "RECOMMENDATIONS: Any advice, prescriptions, or suggestions given.\n\n"
        "FOLLOW-UPS: Next steps, future appointments, or things to research.\n\n"
        "Be clear and practical. Use the speaker labels from the transcript."
    ),
    "notetaker_summary_casual": (
        "You are a friendly note-taker. Given a transcript of a casual discussion or brainstorming session, "
        "generate a light structured summary:\n\n"
        "HIGHLIGHTS: Key ideas and interesting points raised.\n\n"
        "IDEAS: Creative suggestions or brainstorms worth remembering.\n\n"
        "NEXT STEPS: Any loose plans or things people agreed to explore.\n\n"
        "Keep the tone relaxed and concise."
    ),
    "notetaker_summary_training": (
        "You are an educational note-taker. Given a transcript of a training session, lecture, or workshop, "
        "generate a structured summary:\n\n"
        "KEY CONCEPTS: Main topics and concepts covered.\n\n"
        "LEARNING POINTS: Important details, techniques, or facts to remember.\n\n"
        "Q&A RECAP: Questions asked and answers given (if any).\n\n"
        "RESOURCES: Any tools, links, or references mentioned.\n\n"
        "Be thorough but concise. Focus on what a learner would need to retain."
    ),
    "notetaker_summary_interview": (
        "You are a professional interview note-taker. Given a transcript of an interview "
        "(job interview, user research, etc.), generate a structured summary:\n\n"
        "OVERVIEW: Brief context of the interview.\n\n"
        "KEY QUESTIONS & RESPONSES: The most important questions and summarized answers.\n\n"
        "STRENGTHS: Notable positive points or insights.\n\n"
        "CONCERNS: Any flags, gaps, or areas needing follow-up.\n\n"
        "ASSESSMENT: Brief overall impression.\n\n"
        "Be objective and factual. Use the speaker labels from the transcript."
    ),
    "notetaker_summary_client": (
        "You are a professional client meeting note-taker. Given a transcript of a client call, "
        "sales meeting, or vendor discussion, generate a structured summary:\n\n"
        "SUMMARY: Brief overview of the meeting purpose and outcome.\n\n"
        "CLIENT REQUIREMENTS: What the client needs or requested.\n\n"
        "COMMITMENTS: Promises made by either side, with owners.\n\n"
        "NEXT STEPS: Agreed follow-up actions and timeline.\n\n"
        "Be professional and precise. Use the speaker labels from the transcript."
    ),
    "notetaker_summary_custom": (
        "You are a professional note-taker. Given a meeting transcript with speaker labels, "
        "generate a structured, useful summary. {custom_instructions}\n\n"
        "Be concise and factual. Use the speaker labels from the transcript."
    ),
    "notetaker_title": (
        "Generate a short, descriptive title (3-7 words) for a meeting based on the transcript. "
        "Capture the main topic discussed. Output ONLY the title - no quotes, no explanation."
    ),
}

app = FastAPI(title="media-api")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Auth: validate tokens via rag-api with TTL cache ──

_auth_cache: dict[str, tuple[dict, float]] = {}
AUTH_CACHE_TTL = 60  # seconds


async def get_current_user(request: Request) -> dict:
    """Validate Bearer token by forwarding to rag-api /auth/me. Cached 60s."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing auth token")
    token = auth[7:]

    # Check cache
    if token in _auth_cache:
        user, ts = _auth_cache[token]
        if time.time() - ts < AUTH_CACHE_TTL:
            return user

    # Validate against rag-api
    try:
        async with httpx.AsyncClient(timeout=5.0) as c:
            resp = await c.get(f"{CHAT_API_URL}/auth/me", headers={"Authorization": auth})
            resp.raise_for_status()
            user = resp.json()
            _auth_cache[token] = (user, time.time())
            return user
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail="Authentication failed")
    except Exception:
        raise HTTPException(status_code=503, detail="Auth service unavailable")


# ── Utility helpers ──

def _get_utility_model(user: dict = None) -> str:
    """Return the user's preferred utility model, or the server default."""
    if user:
        try:
            settings = json.loads(user.get("settings") or "{}")
            um = settings.get("wooz_utility_model", "")
            if um:
                return um
        except Exception:
            pass
    return UTILITY_MODEL


async def _report_vram(action: str, model: str, vram_mb: int = 0, detail: str = ""):
    """Fire-and-forget VRAM activity report to gpu-manager."""
    try:
        async with httpx.AsyncClient(timeout=2.0) as c:
            await c.post(f"{GPU_MANAGER_URL}/vram/log", json={
                "service": "media-api", "action": action, "model": model,
                "vram_mb": vram_mb, "detail": detail,
            })
    except Exception:
        pass


async def _acquire_gpu(service: str, model: str = None, pre_inference: bool = False):
    """Ask gpu-manager to prepare VRAM for a service. Idempotent."""
    try:
        body = {"service": service, "pre_inference": pre_inference}
        if model:
            body["model"] = model
        async with httpx.AsyncClient(timeout=120.0) as c:
            resp = await c.post(f"{GPU_MANAGER_URL}/acquire", json=body)
            resp.raise_for_status()
            return resp.json()
    except Exception as e:
        logger.warning(f"gpu-manager acquire failed for {service}: {e}")
        return None


async def _utility_llm(system: str, prompt: str, temperature: float = 0.8, num_predict: int = 80,
                        user: dict = None, force_default: bool = False, caller: str = "utility") -> str:
    """Quick LLM call using the small utility model."""
    model = UTILITY_MODEL if force_default else _get_utility_model(user)
    await _report_vram("call", model, detail=caller)
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{OLLAMA_BASE_URL}/api/generate",
            json={
                "model": model,
                "system": system,
                "prompt": prompt,
                "stream": False,
                "think": False,
                "options": {"temperature": temperature, "num_predict": num_predict},
            },
        )
        resp.raise_for_status()
        text = resp.json().get("response", "").strip()
        if "<think>" in text:
            text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
        return text


# ── Request models ──

class ImageGenerateRequest(BaseModel):
    prompt: str
    negative_prompt: Optional[str] = None
    aspect: str = "square"
    width: Optional[int] = None
    height: Optional[int] = None
    steps: Optional[int] = None
    seed: Optional[int] = None
    guidance_scale: Optional[float] = None
    model: Optional[str] = None

class ImageLoadModelRequest(BaseModel):
    model: str

class ImageUpscaleRequest(BaseModel):
    image: str
    scale: int = 2

class ImageInpaintRequest(BaseModel):
    image: str
    mask: str
    prompt: str
    negative_prompt: Optional[str] = None
    steps: Optional[int] = None
    seed: Optional[int] = None
    guidance_scale: Optional[float] = None
    strength: Optional[float] = None

class SessionNameRequest(BaseModel):
    prompt: str

class SongNameRequest(BaseModel):
    prompt: str
    lyrics: Optional[str] = None

class CoverArtRequest(BaseModel):
    prompt: str
    title: Optional[str] = None
    lyrics: Optional[str] = None

class SongWriteRequest(BaseModel):
    description: str
    language: Optional[str] = "en"
    model: Optional[str] = None

class MusicGenerateRequest(BaseModel):
    prompt: str
    lyrics: Optional[str] = None
    duration: Optional[float] = 30.0
    infer_steps: Optional[int] = 20
    guidance_scale: Optional[float] = 7.0
    seed: Optional[int] = None
    instrumental: Optional[bool] = False
    vocal_language: Optional[str] = None
    bpm: Optional[int] = None

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

class VideoNameRequest(BaseModel):
    prompt: str

class VideoCoverArtRequest(BaseModel):
    prompt: str
    title: Optional[str] = None


# ══════════════════════════════════════════════════════════════
#  IMAGE ENDPOINTS
# ══════════════════════════════════════════════════════════════

@app.get("/image/inspire")
async def image_inspire(user: dict = Depends(get_current_user)):
    try:
        text = await _utility_llm(PROMPTS["image_inspire"], "Give me a fresh, creative image generation prompt.", temperature=1.2, num_predict=150, user=user, force_default=True, caller="image inspire")
        return {"prompt": text.strip('"').strip("'")}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not generate idea: {e}")


@app.get("/image/models")
async def image_models_proxy(user: dict = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{IMAGE_GEN_URL}/models")
            return resp.json()
    except Exception:
        return {"models": [], "current": None}


@app.post("/image/models/load")
async def image_load_model_proxy(req: ImageLoadModelRequest, user: dict = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(f"{IMAGE_GEN_URL}/models/load", json={"model": req.model})
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPStatusError as e:
        detail = e.response.json().get("detail", str(e)) if e.response.content else str(e)
        raise HTTPException(status_code=e.response.status_code, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load model: {e}")


@app.get("/image/progress")
async def image_progress_proxy(user: dict = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{IMAGE_GEN_URL}/progress")
            return resp.json()
    except Exception:
        return {"running": False, "step": 0, "total_steps": 0, "elapsed_s": 0.0}


@app.post("/image/generate")
async def image_generate_proxy(req: ImageGenerateRequest, user: dict = Depends(get_current_user)):
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required")
    await _acquire_gpu("image", model=req.model, pre_inference=True)
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            resp = await client.post(
                f"{IMAGE_GEN_URL}/generate",
                json={
                    "prompt": req.prompt, "negative_prompt": req.negative_prompt,
                    "aspect": req.aspect, "width": req.width, "height": req.height,
                    "steps": req.steps, "seed": req.seed,
                    "guidance_scale": req.guidance_scale, "model": req.model,
                },
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Image generation service is not available")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Image generation timed out")
    except httpx.HTTPStatusError as e:
        detail = e.response.json().get("detail", str(e)) if e.response.content else str(e)
        raise HTTPException(status_code=e.response.status_code, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Image generation failed: {e}")


@app.post("/image/upscale")
async def image_upscale_proxy(req: ImageUpscaleRequest, user: dict = Depends(get_current_user)):
    if not req.image:
        raise HTTPException(status_code=400, detail="image is required")
    await _acquire_gpu("image", pre_inference=True)
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            resp = await client.post(f"{IMAGE_GEN_URL}/upscale", json={"image": req.image, "scale": req.scale})
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Image service is not available")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Upscaling timed out")
    except httpx.HTTPStatusError as e:
        detail = e.response.json().get("detail", str(e)) if e.response.content else str(e)
        raise HTTPException(status_code=e.response.status_code, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upscaling failed: {e}")


@app.post("/image/inpaint")
async def image_inpaint_proxy(req: ImageInpaintRequest, user: dict = Depends(get_current_user)):
    if not req.image or not req.mask:
        raise HTTPException(status_code=400, detail="image and mask are required")
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required")
    await _acquire_gpu("image", pre_inference=True)
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            resp = await client.post(
                f"{IMAGE_GEN_URL}/inpaint",
                json={
                    "image": req.image, "mask": req.mask, "prompt": req.prompt,
                    "negative_prompt": req.negative_prompt, "steps": req.steps,
                    "seed": req.seed, "guidance_scale": req.guidance_scale,
                },
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Image service is not available")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Inpainting timed out")
    except httpx.HTTPStatusError as e:
        detail = e.response.json().get("detail", str(e)) if e.response.content else str(e)
        raise HTTPException(status_code=e.response.status_code, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Inpainting failed: {e}")


@app.post("/image/cancel")
async def image_cancel(user: dict = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(f"{IMAGE_GEN_URL}/cancel")
            return resp.json()
    except Exception:
        return {"ok": False}


@app.post("/image/name-session")
async def image_name_session(req: SessionNameRequest, user: dict = Depends(get_current_user)):
    if not req.prompt.strip():
        return {"name": ""}
    try:
        name = await _utility_llm(
            "Generate a short, descriptive title (3-6 words) for an image generation session based on the prompt. "
            "Capture the main subject and mood. "
            "Output ONLY the title text, no quotes, no explanation.",
            req.prompt[:200], temperature=0.5, num_predict=15, user=user, force_default=True, caller="image name-session",
        )
        return {"name": name.strip('"').strip("'").split("\n")[0].strip().title()[:60]}
    except Exception as e:
        logger.warning(f"Image session naming failed: {e}")
        return {"name": ""}


# ══════════════════════════════════════════════════════════════
#  MUSIC ENDPOINTS
# ══════════════════════════════════════════════════════════════

@app.get("/music/inspire")
async def music_inspire(user: dict = Depends(get_current_user)):
    try:
        text = await _utility_llm(PROMPTS["music_inspire"], "Give me a fresh, creative music generation prompt.", temperature=1.2, num_predict=100, user=user, force_default=True, caller="music inspire")
        return {"prompt": text.strip('"').strip("'")}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not generate idea: {e}")


@app.post("/music/name-song")
async def name_song(req: SongNameRequest, user: dict = Depends(get_current_user)):
    try:
        context = f"Style: {req.prompt}"
        if req.lyrics:
            context += f"\n\nLyrics:\n{req.lyrics[:500]}"
        title = await _utility_llm(
            PROMPTS["song_title"],
            context, temperature=1.0, num_predict=20, user=user, force_default=True, caller="music name-song",
        )
        return {"title": title.strip('"').strip("'").split("\n")[0].strip().title()}
    except Exception:
        return {"title": ""}


@app.post("/music/cover-art")
async def music_cover_art(req: CoverArtRequest, user: dict = Depends(get_current_user)):
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required")

    image_prompt = None
    try:
        context = f"Song style: {req.prompt}"
        if req.title:
            context = f"Song title: {req.title}\n{context}"
        if req.lyrics:
            context += f"\nLyrics excerpt: {req.lyrics[:300]}"
        raw = await _utility_llm(
            system=PROMPTS["cover_art"],
            prompt=context, temperature=0.9, num_predict=80, user=user,
            force_default=True, caller="music cover-art prompt",
        )
        image_prompt = raw.strip('"').strip("'").strip().split("\n")[0].strip() + ", no text, no words, no letters"
    except Exception as e:
        logger.warning(f"Cover art prompt generation failed: {e}")

    if not image_prompt:
        image_prompt = f"Abstract album cover art, {req.prompt[:100]}, artistic, vibrant colors, no text, no words, no letters"

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f"{IMAGE_GEN_URL}/generate",
                json={
                    "prompt": image_prompt,
                    "negative_prompt": "text, words, letters, typography, watermark, signature, logo, title, label, caption",
                    "model": "sdxl-turbo", "aspect": "square", "steps": 4, "guidance_scale": 0.0,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            return {"image": data.get("image"), "prompt": image_prompt, "width": data.get("width", 512), "height": data.get("height", 512)}
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Image generation service is not available")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Cover art generation failed: {e}")


@app.post("/music/write-song")
async def write_song(req: SongWriteRequest, user: dict = Depends(get_current_user)):
    if not req.description.strip():
        raise HTTPException(status_code=400, detail="description is required")

    system_prompt = PROMPTS["songwriting"]

    user_msg = req.description.strip()
    if req.language and req.language != "en":
        user_msg += f"\n\nWrite the lyrics in language code: {req.language}"

    # Unload image model to free VRAM for the songwriting LLM
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(f"{IMAGE_GEN_URL}/models/unload")
    except Exception:
        pass

    songwriting_model = req.model or LLM_MODEL
    await _report_vram("call", songwriting_model, detail="music songwriting")
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            resp = await client.post(
                f"{OLLAMA_BASE_URL}/api/chat",
                json={
                    "model": songwriting_model,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_msg},
                    ],
                    "stream": False,
                    "options": {"temperature": 0.9, "num_predict": 1024},
                },
            )
            resp.raise_for_status()
            content = resp.json().get("message", {}).get("content", "")
            if "<think>" in content:
                content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()

        style, lyrics = "", ""
        if "STYLE:" in content and "LYRICS:" in content:
            parts = content.split("LYRICS:", 1)
            style = parts[0].replace("STYLE:", "").strip()
            lyrics = parts[1].strip()
        elif "LYRICS:" in content:
            lyrics = content.split("LYRICS:", 1)[1].strip()
            style = req.description
        else:
            style = req.description
            lyrics = content.strip()

        return {"ok": True, "style": style, "lyrics": lyrics}
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="LLM service is not available")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Song writing failed: {e}")


@app.post("/music/cancel")
async def music_cancel(user: dict = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(f"{MUSIC_GEN_URL}/cancel")
            return resp.json()
    except Exception:
        return {"ok": False}


@app.get("/music/health")
async def music_health(user: dict = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{MUSIC_GEN_URL}/health")
            return resp.json()
    except Exception:
        return {"ok": False, "model_loaded": False}


@app.get("/music/progress")
async def music_progress(user: dict = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{MUSIC_GEN_URL}/progress")
            return resp.json()
    except Exception:
        return {"running": False, "step": 0, "total_steps": 0, "elapsed_s": 0.0}


@app.post("/music/generate")
async def music_generate_proxy(req: MusicGenerateRequest, user: dict = Depends(get_current_user)):
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required")
    await _acquire_gpu("music", pre_inference=True)
    try:
        async with httpx.AsyncClient(timeout=1800.0) as client:
            resp = await client.post(f"{MUSIC_GEN_URL}/generate", json=req.model_dump(exclude_none=True))
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Music generation service is not available")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Music generation timed out")
    except httpx.HTTPStatusError as e:
        detail = e.response.json().get("detail", str(e)) if e.response.content else str(e)
        raise HTTPException(status_code=e.response.status_code, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Music generation failed: {e}")


# ══════════════════════════════════════════════════════════════
#  VIDEO ENDPOINTS
# ══════════════════════════════════════════════════════════════

@app.post("/video/cancel")
async def video_cancel(user: dict = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(f"{VIDEO_GEN_URL}/cancel")
            return resp.json()
    except Exception:
        return {"ok": False}


@app.get("/video/health")
async def video_health(user: dict = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{VIDEO_GEN_URL}/health")
            return resp.json()
    except Exception:
        return {"ok": False, "model_loaded": False}


@app.get("/video/progress")
async def video_progress(user: dict = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{VIDEO_GEN_URL}/progress")
            return resp.json()
    except Exception:
        return {"running": False, "step": 0, "total_steps": 0, "elapsed_s": 0.0}


@app.post("/video/generate")
async def video_generate_proxy(req: VideoGenerateRequest, user: dict = Depends(get_current_user)):
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required")
    await _acquire_gpu("video", pre_inference=True)
    try:
        async with httpx.AsyncClient(timeout=1800.0) as client:
            resp = await client.post(f"{VIDEO_GEN_URL}/generate", json=req.model_dump(exclude_none=True))
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Video generation service is not available")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Video generation timed out")
    except httpx.HTTPStatusError as e:
        detail = e.response.json().get("detail", str(e)) if e.response.content else str(e)
        raise HTTPException(status_code=e.response.status_code, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Video generation failed: {e}")


@app.get("/video/inspire")
async def video_inspire(user: dict = Depends(get_current_user)):
    try:
        text = await _utility_llm(PROMPTS["video_inspire"], "Give me a fresh, creative video generation prompt.", temperature=1.2, num_predict=100, user=user, force_default=True, caller="video inspire")
        return {"prompt": text.strip('"').strip("'")}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not generate idea: {e}")


@app.post("/video/name-session")
async def video_name_session(req: VideoNameRequest, user: dict = Depends(get_current_user)):
    try:
        name = await _utility_llm(
            PROMPTS["video_session_title"],
            req.prompt[:200], temperature=0.5, num_predict=15, user=user, force_default=True, caller="video name-session",
        )
        return {"name": name.strip('"').strip("'").split("\n")[0].strip().title()[:60]}
    except Exception as e:
        logger.warning(f"Video session naming failed: {e}")
        return {"name": ""}


@app.post("/video/cover-art")
async def video_cover_art(req: VideoCoverArtRequest, user: dict = Depends(get_current_user)):
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required")

    image_prompt = None
    try:
        context = f"Video scene: {req.prompt}"
        if req.title:
            context = f"Video title: {req.title}\n{context}"
        raw = await _utility_llm(
            system=PROMPTS["video_thumbnail"],
            prompt=context, temperature=0.9, num_predict=80, user=user,
            force_default=True, caller="video thumbnail prompt",
        )
        image_prompt = raw.strip('"').strip("'").strip().split("\n")[0].strip()
    except Exception as e:
        logger.warning(f"Video cover art prompt generation failed: {e}")

    if not image_prompt:
        image_prompt = f"Cinematic still frame, {req.prompt[:100]}, dramatic lighting, film quality, no text"

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f"{IMAGE_GEN_URL}/generate",
                json={"prompt": image_prompt, "model": "sdxl-turbo", "aspect": "landscape", "steps": 4, "guidance_scale": 0.0},
            )
            resp.raise_for_status()
            data = resp.json()
            return {"image": data.get("image"), "prompt": image_prompt, "width": data.get("width", 672), "height": data.get("height", 384)}
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Image generation service is not available")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Cover art generation failed: {e}")


# ══════════════════════════════════════════════════════════════
#  NOTE TAKER ENDPOINTS
# ══════════════════════════════════════════════════════════════

class NotetakerSummarizeRequest(BaseModel):
    transcript: str
    note_type: str = "professional"
    custom_instructions: str = ""

class NotetakerNameRequest(BaseModel):
    transcript: str


@app.post("/notetaker/transcribe")
async def notetaker_transcribe(request: Request, user: dict = Depends(get_current_user)):
    """Proxy file upload to notetaker-api for transcription."""
    await _acquire_gpu("notetaker", pre_inference=True)
    try:
        body = await request.body()
        content_type = request.headers.get("content-type", "")
        async with httpx.AsyncClient(timeout=1800.0) as client:
            resp = await client.post(
                f"{NOTETAKER_API_URL}/transcribe",
                content=body,
                headers={"content-type": content_type},
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Notetaker service is not available")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Transcription timed out")
    except httpx.HTTPStatusError as e:
        detail = e.response.json().get("detail", str(e)) if e.response.content else str(e)
        raise HTTPException(status_code=e.response.status_code, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")


@app.post("/notetaker/retranscribe/{note_id}")
async def notetaker_retranscribe(note_id: str, request: Request, user: dict = Depends(get_current_user)):
    """Proxy re-transcription request to notetaker-api."""
    await _acquire_gpu("notetaker", pre_inference=True)
    try:
        body = await request.body()
        content_type = request.headers.get("content-type", "")
        async with httpx.AsyncClient(timeout=1800.0) as client:
            resp = await client.post(
                f"{NOTETAKER_API_URL}/retranscribe/{note_id}",
                content=body,
                headers={"content-type": content_type},
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Notetaker service is not available")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Re-transcription timed out")
    except httpx.HTTPStatusError as e:
        detail = e.response.json().get("detail", str(e)) if e.response.content else str(e)
        raise HTTPException(status_code=e.response.status_code, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Re-transcription failed: {e}")


@app.get("/notetaker/progress")
async def notetaker_progress(user: dict = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{NOTETAKER_API_URL}/progress")
            return resp.json()
    except Exception:
        return {"running": False, "phase": "", "step": 0, "total_steps": 0, "elapsed_s": 0.0, "message": ""}


@app.post("/notetaker/cancel")
async def notetaker_cancel(user: dict = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(f"{NOTETAKER_API_URL}/cancel")
            return resp.json()
    except Exception:
        return {"ok": False}


@app.get("/notetaker/models")
async def notetaker_models(user: dict = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{NOTETAKER_API_URL}/models")
            return resp.json()
    except Exception:
        return {"models": [], "current": None, "loaded": False}


@app.post("/notetaker/models/load")
async def notetaker_models_load(request: Request, user: dict = Depends(get_current_user)):
    await _acquire_gpu("notetaker")
    try:
        body = await request.json()
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(f"{NOTETAKER_API_URL}/models/load", json=body)
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPStatusError as e:
        detail = e.response.json().get("detail", str(e)) if e.response.content else str(e)
        raise HTTPException(status_code=e.response.status_code, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Model loading failed: {e}")


@app.post("/notetaker/models/unload")
async def notetaker_models_unload(user: dict = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(f"{NOTETAKER_API_URL}/models/unload")
            return resp.json()
    except Exception:
        return {"ok": False}


@app.get("/notetaker/audio/{note_id}")
async def notetaker_audio(note_id: str, user: dict = Depends(get_current_user)):
    """Proxy audio file streaming from notetaker-api."""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(f"{NOTETAKER_API_URL}/audio/{note_id}")
            resp.raise_for_status()
            from fastapi.responses import Response
            return Response(
                content=resp.content,
                media_type=resp.headers.get("content-type", "audio/wav"),
                headers={"Content-Disposition": resp.headers.get("content-disposition", "")},
            )
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail="Audio file not found")
    except Exception:
        raise HTTPException(status_code=503, detail="Notetaker service is not available")


@app.delete("/notetaker/audio/{note_id}")
async def notetaker_audio_delete(note_id: str, user: dict = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.delete(f"{NOTETAKER_API_URL}/audio/{note_id}")
            return resp.json()
    except Exception:
        return {"ok": False}


@app.get("/notetaker/health")
async def notetaker_health(user: dict = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{NOTETAKER_API_URL}/health")
            return resp.json()
    except Exception:
        return {"ok": False, "model_loaded": False}


@app.post("/notetaker/summarize")
async def notetaker_summarize(req: NotetakerSummarizeRequest, user: dict = Depends(get_current_user)):
    """Generate AI summary from transcript using the full LLM."""
    if not req.transcript.strip():
        raise HTTPException(status_code=400, detail="transcript is required")

    prompt_key = f"notetaker_summary_{req.note_type}"
    system = PROMPTS.get(prompt_key, PROMPTS["notetaker_summary_professional"])

    if req.note_type == "custom" and req.custom_instructions:
        system = system.replace("{custom_instructions}", req.custom_instructions)

    await _acquire_gpu("chat", model=LLM_MODEL)

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(f"{OLLAMA_BASE_URL}/api/generate", json={
                "model": LLM_MODEL,
                "system": system,
                "prompt": req.transcript,
                "stream": False,
                "think": False,
                "options": {"temperature": 0.3, "num_predict": 2000},
            })
            resp.raise_for_status()
            text = resp.json().get("response", "").strip()
            text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
            return {"summary": text}
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="LLM service is not available")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Summary generation failed: {e}")


@app.post("/notetaker/name")
async def notetaker_name(req: NotetakerNameRequest, user: dict = Depends(get_current_user)):
    """Auto-generate a meeting title from transcript."""
    if not req.transcript.strip():
        return {"name": ""}
    # Use first ~500 chars of transcript for naming
    snippet = req.transcript[:500]
    try:
        name = await _utility_llm(
            PROMPTS["notetaker_title"], snippet,
            temperature=0.5, num_predict=30, user=user,
            force_default=True, caller="notetaker title",
        )
        return {"name": name.strip('"').strip("'").split("\n")[0].strip().title()[:60]}
    except Exception as e:
        logger.warning(f"Notetaker naming failed: {e}")
        return {"name": ""}


# ══════════════════════════════════════════════════════════════
#  HEALTH
# ══════════════════════════════════════════════════════════════

@app.get("/health")
async def health():
    """Health check with dependency connectivity."""
    checks = {}
    for name, url in [("image-api", IMAGE_GEN_URL), ("music-api", MUSIC_GEN_URL), ("video-api", VIDEO_GEN_URL), ("notetaker-api", NOTETAKER_API_URL), ("gpu-manager", GPU_MANAGER_URL)]:
        try:
            async with httpx.AsyncClient(timeout=3.0) as c:
                resp = await c.get(f"{url}/health" if name != "gpu-manager" else f"{url}/status")
                checks[name] = resp.status_code == 200
        except Exception:
            checks[name] = False
    return {"ok": all(checks.values()), "services": checks}
