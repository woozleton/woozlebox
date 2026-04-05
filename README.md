# WoozleBox

A self-hosted AI toolbox that runs entirely on your own hardware. Chat with local LLMs, generate images, music, and video - all through a single web interface with no cloud dependencies.

## What's Inside

- **Chat** - Conversational AI powered by [Ollama](https://ollama.com) with RAG (retrieval-augmented generation) over your own documents
- **Image Studio** - Text-to-image generation with Stable Diffusion 3.5, Playground v2.5, SDXL Turbo, inpainting, and Real-ESRGAN upscaling
- **Music Studio** - Text-to-music generation with ACE-Step 1.5, automatic cover art, AI songwriting
- **Video Studio** - Text-to-video and image-to-video generation with Wan 2.1
- **File Vault** - Upload PDFs, markdown, and text files for semantic search during chat
- **Web Search** - Optional web search integration via Tavily for current information
- **Text-to-Speech** - 50+ voices via Kokoro TTS
- **Speech-to-Text** - Browser-native voice input
- **Memory** - Automatic and manual fact memory across conversations
- **Multi-user** - User accounts with admin panel, per-user settings and conversations

## Requirements

- **NVIDIA GPU** with 8+ GB VRAM (24 GB recommended for all features)
- **Docker** and **Docker Compose**
- **NVIDIA Container Toolkit** ([install guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html))

## Quick Start

```bash
git clone https://github.com/woozleton/dave-in-a-box.git
cd dave-in-a-box
docker compose up -d
```

Open [http://localhost:8080](http://localhost:8080) and create your first account.

On first run, Ollama will download the default chat model (~18 GB). Image, music, and video models download on first use from HuggingFace.

## Configuration

Create a `.env` file in the project root to override defaults:

```env
# ── Models ──
LLM_MODEL=qwen3:30b-a3b         # Chat LLM (any Ollama model)
UTILITY_MODEL=qwen3:0.6b         # Small model for inspire/naming tasks
EMBED_MODEL=nomic-embed-text     # Embedding model for RAG

# ── Optional API Keys ──
TAVILY_API_KEY=tvly-...          # Enables web search (https://tavily.com)
HF_TOKEN=hf_...                  # HuggingFace token (for gated models)

# ── Ports ──
WEB_PORT=8080                    # Web UI
RAG_API_PORT=8000                # Chat/auth API
IMAGE_GEN_PORT=8100              # Image generation
MUSIC_GEN_PORT=8200              # Music generation
VIDEO_GEN_PORT=8300              # Video generation
GPU_MANAGER_PORT=8400            # VRAM orchestration
MEDIA_API_PORT=8500              # Media orchestration

# ── Tuning ──
SIMILARITY_THRESHOLD=0.45        # RAG retrieval threshold (lower = more results)
TTS_VOICE=af_heart               # Default TTS voice
```

## Architecture

Nine Docker containers on a single machine, sharing one GPU:

```
┌─────────────────────────────────────────────────────┐
│  web (nginx :8080)  ─  Static SPA frontend          │
├─────────────────────────────────────────────────────┤
│  rag-api (:8000)    ─  Chat, auth, vault, TTS       │
│  media-api (:8500)  ─  Media orchestration proxy     │
│  gpu-manager (:8400)─  VRAM orchestration            │
├─────────────────────────────────────────────────────┤
│  image-api (:8100)  ─  SD 3.5, SDXL Turbo, etc.     │
│  music-api (:8200)  ─  ACE-Step 1.5                  │
│  video-api (:8300)  ─  Wan 2.1 T2V 1.3B             │
├─────────────────────────────────────────────────────┤
│  Ollama (:11434)    ─  LLM inference                 │
│  ChromaDB (:8001)   ─  Vector store for RAG          │
│  Kokoro             ─  Text-to-speech                │
│  SQLite             ─  Users, conversations, memory  │
└─────────────────────────────────────────────────────┘
```

**GPU sharing** - Only one model occupies VRAM at a time. `gpu-manager` handles all loading/eviction automatically. When you switch from chat to image studio, it evicts the chat LLM and loads the diffusion model. No manual management needed.

See `docs/` for detailed architecture diagrams and VRAM workflow documentation.

## File Structure

```
dave-in-a-box/
├── docker-compose.yml          # All services, ports, volumes, GPU access
├── web/                        # Static SPA frontend (vanilla JS, no framework)
│   ├── index.html              # Full app markup (1,668 lines)
│   ├── icons.svg               # SVG sprite sheet (34 icons)
│   ├── css/                    # 6 CSS modules (variables, base, studios, chat, ui, responsive)
│   └── js/                     # 17 JS modules (config, app, chat, studios, settings, etc.)
├── rag-api/                    # Chat, auth, vault, memory, TTS (FastAPI)
│   ├── main.py                 # API endpoints
│   ├── db.py                   # SQLite schema & queries
│   └── indexer.py              # Document chunking into ChromaDB
├── media-api/                  # Media orchestration proxy (FastAPI)
│   └── main.py                 # Image/music/video workflow coordination
├── gpu-manager/                # VRAM orchestration (FastAPI)
│   └── main.py                 # Model load/unload, Ollama eviction
├── image-api/                  # Image generation (FastAPI + PyTorch)
│   └── main.py                 # SD 3.5, Playground v2.5, SDXL Turbo, inpaint, upscale
├── music-api/                  # Music generation (FastAPI + PyTorch)
│   └── main.py                 # ACE-Step 1.5
├── video-api/                  # Video generation (FastAPI + PyTorch)
│   └── main.py                 # Wan 2.1 T2V 1.3B
└── docs/                       # HTML reference documentation
```

## VRAM Usage by Mode

| Mode | What's Loaded | Approx. VRAM |
|------|--------------|-------------|
| Chat | Selected LLM (e.g. qwen3:30b-a3b) | 3 – 17 GB |
| Image Studio | Diffusion model + utility LLM | 7 – 13 GB |
| Music Studio | ACE-Step + SDXL Turbo (cover art) | ~13 GB |
| Video Studio | Wan 2.1 T2V 1.3B | ~5 – 10 GB |

The `gpu-manager` automatically evicts models from VRAM when switching between modes.

## Features in Detail

### Chat
- Streaming responses with token-by-token display
- RAG over uploaded documents (PDF, markdown, plain text)
- Optional web search via Tavily
- Conversation history with folders
- Automatic memory extraction (facts remembered across conversations)
- Model selection from all available Ollama models
- Markdown rendering with syntax-highlighted code blocks and tables

### Image Studio
- Multiple models: Stable Diffusion 3.5, Playground v2.5, SDXL Turbo
- Configurable resolution, aspect ratio, steps, guidance, seed
- Batch generation (1-4 images per prompt)
- Inpainting editor with brush tools
- Real-ESRGAN upscaling (2x/4x)
- Favorites panel, folders, trash with 30-day auto-purge
- Style presets (built-in + custom)
- "Inspire" button for AI-generated prompts

### Music Studio
- Text-to-music via ACE-Step 1.5
- AI songwriting (generates lyrics + style from a concept)
- Automatic cover art generation via SDXL Turbo
- Waveform visualization and playback
- Session management, favorites, folders, trash
- Configurable duration, tempo, guidance, and seed

### Video Studio
- Text-to-video generation
- Image-to-video (upload a starting frame)
- Configurable resolution, frame count, and guidance
- Session management, favorites, trash

### Platform
- Multi-user with admin panel
- Customizable themes (7 "wild" themes with special effects)
- Accent color picker
- Custom branding (logo, name, favicon, AI avatar)
- Adjustable text size
- Dark mode only (by design)
- Mobile-responsive layout
- Keyboard shortcuts

## Development

The frontend uses no build tools - edit JS/CSS files directly and refresh. Backend services auto-reload in development via uvicorn.

```bash
# Rebuild a single service after code changes
docker compose build rag-api
docker compose up -d rag-api

# View logs
docker compose logs -f rag-api

# Rebuild everything
docker compose up -d --build
```

## License

Private repository. All rights reserved.
