# CLAUDE.md

## Project: WoozleBox

Self-hosted AI toolbox - chat, image/music/video/code generation. Monorepo with Docker Compose, one directory per service, vanilla JS frontend.

## Repo Layout

```
woozlebox/
├── web/                # Vanilla JS/CSS/HTML frontend (served by nginx)
│   ├── index.html      # Entry point. Script tag order is load-order sensitive.
│   ├── icons.svg       # Master SVG sprite (+ inline copy in index.html)
│   ├── css/            # 6 numbered files, loaded in order
│   └── js/             # ~24 globals-sharing scripts (no modules except avatar.js)
├── rag-api/            # Primary chat/auth/RAG/memory/TTS-proxy backend
├── gpu-manager/        # Centralized VRAM orchestrator
├── image-api/          # Stable Diffusion / Playground / SDXL Turbo / inpaint / upscale
├── music-api/          # ACE-Step 1.5 text-to-music
├── video-api/          # Wan 2.1 text-to-video and image-to-video
├── notetaker-api/      # whisperX transcription + pyannote diarization
├── media-api/          # Media orchestration (cover art, naming, lyrics)
├── code-runner/        # Sandboxed code execution for Code Studio
├── tts-llm/            # llama.cpp CUDA server wrapping Orpheus GGUF (supervisor.py)
├── docs/               # User-facing HTML docs
├── docker-compose.yml  # Source of truth for services, ports, volumes
├── README.md           # User-facing install/feature documentation
└── todo.md             # User-maintained todo list. Read only if asked.
```

## Services

All ports below are host ports from `docker-compose.yml`. Override via the matching `*_PORT` env var.

| Service | Port | Role |
|---|---|---|
| `web` | 8080 | nginx serving the vanilla JS frontend |
| `rag-api` | 8000 | Chat/auth/RAG/memory/TTS-proxy. Owns `PROMPTS`, `PROMPT_REGISTRY`, `TTS_VOICES`, user accounts, ChromaDB retrieval, conversation compaction, prompt override storage + API. |
| `gpu-manager` | 8400 | VRAM orchestrator. All model-loading services acquire/release VRAM through it. Passes HF 403s to the frontend. |
| `image-api` | 8100 | Text-to-image, inpainting, Real-ESRGAN upscaling |
| `music-api` | 8200 | Text-to-music (ACE-Step 1.5) |
| `video-api` | 8300 | Text-to-video (Wan 2.1 T2V 1.3B). I2V is intentionally not supported - the Wan 2.1 I2V model is 14B and won't fit on a 24 GB 4090 without CPU offload. |
| `notetaker-api` | 8600 | whisperX + pyannote (gated) |
| `media-api` | 8500 | Cover art, naming, lyrics, media helpers. Has its own `PROMPTS` dict. Fetches prompt overrides from rag-api (60s poll + instant notification). |
| `code-runner` | 8700 | Sandboxed exec for Code Studio |
| `ollama` | 11434 | Local LLM runtime (runs inside Docker, not host) |
| `chromadb` | 8001 | Vector store for RAG |
| `tts-init` | - | One-shot Orpheus GGUF downloader |
| `tts-llm` | 5006 (internal) | llama.cpp server hosting Orpheus, wrapped by `supervisor.py` |
| `tts-api` | 5005 (internal) | FastAPI wrapper: LLM audio tokens -> WAV via SNAC codec |

## Style Rules

- **No em dashes anywhere** - code, comments, docs, commit messages. Use regular hyphens (-) instead.
- No emojis unless the user explicitly asks for them.
- **Prefer shared classes.** Reuse existing CSS classes and JS utilities whenever possible. Don't duplicate styles or logic across components - extract shared patterns instead.
- **Theme-friendly UI.** Never hardcode colors in CSS or JS for UI elements. Always use CSS custom properties (`var(--text)`, `var(--border)`, `var(--surface)`, etc.) or `color-mix()` with theme variables. This applies to backgrounds, text, borders, shadows, SVG strokes/fills, canvas drawing, and any other visual element.
- **Database-persisted settings.** User-facing settings must be stored in the database, not only in localStorage. The pattern: write to `localStorage` with a `wooz_` prefix, then call `scheduleSettingsSync()` (in `web/js/app.js`) to debounce-sync all `wooz_*` keys to the server via `PUT /users/me/settings`. Settings are restored from the server on login via `initApp()`.
- **Real VRAM numbers only.** Model VRAM must be reported from a real runtime source - `torch.cuda.memory_allocated()` for Python/PyTorch services, Ollama's own `/api/ps` `size_vram` field, `nvidia-smi` derivation, or a GGUF/weights file-size probe for static llama.cpp-style models. Never hardcode magic numbers. If a platform limitation (e.g. WSL2 Docker has no per-process nvidia-smi) blocks the obvious path, fall back to the next honest source (file size, global-subtraction), not a guess.
- **Consistent studio UI.** Studio settings panels (the dropdown triggered by `.settings-crumb`) must use shared studio classes: `.settings-prominent-grid`, `.ss-group`, `.ss-group-label`, `.sc-slider`, `.field-val`. Do not use the `/settings` page classes (`.setting-group`, `.setting-label`, `.setting-val`, `.setting-desc`) inside studio dropdowns.

## Frontend

- Vanilla HTML/CSS/JS. No build step, no bundler, no framework. Plain `<script defer>` and `<link>` tags.
- All JS files share global scope. Load order matters - see `web/index.html` for the script tag sequence. `avatar.js` is the only ES module (`<script type="module">`).
- CSS is split into 6 numbered files in `web/css/`, loaded in order: variables, base, studios, chat, ui, responsive.
- SVG icons use a sprite sheet with `<symbol>` + `<use>`. **Never use inline SVGs** - add new icons as `<symbol>` entries in both `web/icons.svg` and the inline sprite in `web/index.html`, then reference via `<use href="#i-name"/>`.
- Studio data (items, favorites, trash, folders) is stored server-side in SQLite with media on disk. Use `createStudioAPI()` in `web/js/studio-api.js`. `createStudioDB()` in `web/js/db-helpers.js` is legacy IndexedDB - no longer used by studios.
- Bubble actions: chat bubbles have copy, TTS, and memory buttons on hover. Code studio bubbles have copy and TTS (no memory).
- Timestamps: `ts(epoch)` in `chat.js` delegates to `formatStudioTimestamp()`. All bubbles show date+time. Chat messages store `created_at` per-message; code studio snippets use `created_at` from `studio_items`.
- Incognito mode (`window.incognitoMode` in `chat.js`, mask-icon toggle): a clean-slate chat that sends `incognito:true` so rag-api skips all DB writes, memory read/save, and vault RAG. Multi-turn works via `incognito_history` (in-session messages sent each turn, never persisted). A `body.incognito-active` class draws an alert border + label around `#chat-content`.
- Chat context window: the `wooz_chat_ctx` setting (per-model, token-based) is sent as `num_ctx` and trims history by token budget. gpu-manager `/llm/ctx-fit` measures each model's per-token KV cost and returns the largest context that fits VRAM (bounded by the model's native max); the slider auto-caps to and defaults to that. Auto-memory `[SAVE_MEMORY]`/`[DELETE_MEMORY]` writes are gated on the `auto_memory` flag - off means the AI never writes memory.

### Core JS files (`web/js/`)

| File | Role |
|---|---|
| `app.js` | Bootstrap, view switching, model prepare/release, `scheduleSettingsSync()`, `initApp()` |
| `ui.js` | Sidebar, modals, toasts, draggable/resizable cards (`makeModalDraggable()` with optional `persistKey` for position/size), `showGatedRepoToast()` |
| `gpu.js` | VRAM SSE connection, status polling, sidebar VRAM meter + activity log, filter/search pop-out modal (`#activity-log-modal`), keep/evict/load actions |
| `chat.js` | Chat streaming, bubble rendering, `appendToken()` (buffers `<...>` emotion tags), `ts()` |
| `slash-commands.js` | 31 slash commands (15 universal + 16 chat-only). `registerCommand({...})` + `_attachSlashInput()` |
| `studio-api.js` | Server-backed CRUD for all studios. `createStudioAPI()` |
| `studio-helpers.js` | Shared: `formatStudioTimestamp()`, `trashAge()`, `updateBadge()`, `wireSettingsToggle()`, `purgeOldTrash()` |
| `tts.js` | `speakText()`, `stopSpeaking()`, `getVoice()`. Sentence-stream playback via AudioBufferSourceNode |
| `code-studio.js` | Pair-programmer editor (see Code Studio section). 2766 lines - check CLAUDE.md before re-reading |
| `settings.js` | `/settings` page UI, voice/theme pickers (source of truth for user TTS voice) |
| `memory.js` | Memory fact list (manual add/delete) + account actions (password, clear data, delete account) |
| `avatar.js` | 3D talking head (TalkingHead + Three.js), amplitude-driven lip-sync, ES module |
| `image-studio.js` / `music-studio.js` / `video-studio.js` | Studio UIs, one per modality |
| `notetaker.js` | Recording, transcription, diarization, summary generation |
| `admin-prompts.js` | Admin prompt template editor - accordion UI with collapsible categories, preview/edit toggle, auto-save, per-prompt reset |

## Backend

- Each Python service is a single-file FastAPI app, except `rag-api` (has `main.py`, `db.py`, `indexer.py`) and `tts-llm` (uses `supervisor.py` to wrap a llama.cpp server, not FastAPI).
- LLM system prompts live in `PROMPTS` dicts at the top of `rag-api/main.py` and `media-api/main.py`. All 37 prompts are runtime-editable via the admin prompt editor. Overrides are stored in the `prompt_overrides` SQLite table (rag-api). `get_prompt(key)` checks overrides first, falls back to hardcoded defaults. rag-api notifies media-api instantly on changes via `POST /prompts/refresh`; media-api also polls every 60s as a fallback.
- Slash commands (`web/js/slash-commands.js`): 31 total, 15 universal + 16 chat-only. Typing `/` shows an autocomplete popup; a shared popup tracks the active textarea via `_activeInput`. Enter is intercepted with `stopImmediatePropagation()` so studio keydown handlers don't fire. New commands: `registerCommand({ name, description, usage, category, handler, universal })`.

## Code Studio

`web/js/code-studio.js` is a pair-programming editor with SEARCH/REPLACE block parsing for incremental edits, version pill history, diff view toggle, a context tracking system with auto-compact, and multi-turn conversation history via Ollama `/api/chat`. Sessions group snippets chronologically; folders organize sessions. Settings (model, context window, auto-compact threshold, plan mode, thinking, permissions) sync to DB via `scheduleSettingsSync()`.

Three advanced settings:

- **Plan Mode** (`wooz_code_plan_mode`): appends planning instructions to the system prompt so the LLM produces a structured plan with `## Questions` sections. `_buildPlanForm()` parses the questions and renders interactive tabbed forms (radio for single-select, checkboxes for multi-select, plus a custom answer option). Form submission calls `codeGenerate({ silent: true, planAnswers: true })` to send answers without a user bubble. Plan mode auto-disables after code is generated.
- **Thinking** (`wooz_code_thinking`): passes `"think": true` to Ollama for reasoning-capable models (qwen3, gemma4, deepseek-r1, etc.) and displays reasoning in a collapsible `<details>` block. The toggle is disabled when the model doesn't support thinking (detected via `/models/info`).
- **Permissions** (`wooz_code_permissions`): gates auto-apply and execution. `restrictive` skips live SEARCH/REPLACE and shows Accept/Reject buttons, hides Run. `normal` is the default auto-apply. `permissive` adds a 3-second auto-execute countdown after generation.

## HuggingFace Gated Repos

Some HuggingFace models are gated and require accepting license terms before they can be downloaded. Each backend service (`image-api`, `video-api`, `music-api`, `notetaker-api`) has a `GatedRepoError` class and `_check_gated_repo_error(exc)` helper that detects 403/gated errors during `from_pretrained` calls and raises a structured error. The service's `/models/load` endpoint returns HTTP 403 with `detail` containing the repo URL; `gpu-manager` passes it through; the frontend's `_prepareModel()` in `app.js` detects the 403 and calls `showGatedRepoToast(repoUrl)` (in `ui.js`) to show a persistent error toast with a clickable link to accept terms.

When adding new HF model integrations, wrap `from_pretrained` calls with the same pattern: catch exceptions, call `_check_gated_repo_error(e)`, and let `GatedRepoError` propagate to the endpoint handler.

## TTS Stack

Text-to-speech is provided by Orpheus, a 3B GGUF model running in three Docker services:

- `tts-init`: one-shot model downloader.
- `tts-llm`: llama.cpp CUDA server hosting the Orpheus GGUF on port 5006 (wrapped by `supervisor.py`).
- `tts-api`: Python FastAPI wrapper on port 5005 that turns LLM audio tokens into WAV via the SNAC neural codec.

Model file lives in the `tts_models` named volume. `rag-api` reaches the stack via `TTS_URL=http://tts-api:5005` (hardcoded in compose).

Voices: 25 voices across 8 languages (english, french, german, korean, hindi, mandarin, spanish, italian) grouped in `TTS_VOICES_BY_LANG` in `rag-api/main.py`, flattened into `TTS_VOICES` for the "is this a valid voice?" check. English is the 8-voice group (`tara`, `leah`, `jess`, `leo`, `dan`, `mia`, `zac`, `zoe`). `DEFAULT_VOICE = "tara"` is the new-user/fallback only - the per-user GUI selection in `web/js/settings.js` is the source of truth and is passed on every TTS request.

Emotion tags: Orpheus supports inline emotion tags (`<laugh>`, `<sigh>`, `<chuckle>`, `<gasp>`, `<yawn>`, `<groan>`, `<cough>`, `<sniffle>`, `<giggle>`). `PROMPTS["orpheus_emotions"]` instructs the LLM to emit them. Tags are **persisted raw in the DB** (so debug mode can show them after refresh) and stripped at the frontend render boundary: `appendAIBubble()` in `web/js/chat.js` strips them from finalized bubbles when debug mode is off, and `appendToken()` in the same file buffers `<` until `>` during streaming so tags never flash on screen.

This is a private / community deployment, not a shipping product. Orpheus is tuned to coexist with the chat LLM in 24 GB VRAM for voice-conversation mode. The `LLAMA_SERVER_ARGS` string in `docker-compose.yml` and the matching default in `tts-llm/supervisor.py` must stay in sync. Orpheus's target runtime footprint is ~2.4 GB (weights + q8_0 KV cache at 10K ctx across 2 slots); budget chat-LLM size accordingly. Voice-conversation mode is tuned for a ~9B chat model (e.g. `qwen3.5:9b`, ~13 GB), which leaves comfortable headroom on a 24 GB GPU. Before entering voice mode with a 30B+ MoE model (e.g. the default `qwen3:30b-a3b`), switch the chat model down - otherwise `gpu-manager`'s coexistence fit-check will return HTTP 409 when the frontend requests TTS. There is no auto-switch; model selection is the user's responsibility.

## Common Tasks

- **Add a slash command.** Call `registerCommand({ name, description, usage, category, handler, universal })` in `web/js/slash-commands.js`. Set `universal: true` if it works in every prompt, false for chat-only.
- **Add an SVG icon.** Add a `<symbol id="i-foo" viewBox="...">` entry to both `web/icons.svg` and the inline sprite at the top of `web/index.html`, then reference with `<use href="#i-foo"/>`. Never embed inline `<svg>` elements.
- **Add a persisted user setting.** Write to `localStorage` with a `wooz_` prefix, call `scheduleSettingsSync()` (defined in `web/js/app.js`). It debounce-syncs all `wooz_*` keys to the server via `PUT /users/me/settings` and they restore on next login.
- **Add an LLM system prompt.** Add the prompt text to the `PROMPTS` dict at the top of `rag-api/main.py` (chat/memory/compaction) or `media-api/main.py` (cover art, naming, lyrics). Then add a corresponding entry in `PROMPT_REGISTRY` (in `rag-api/main.py`) with `service`, `label`, `category`, and `description`. For media-api prompts, also add the default text to `MEDIA_PROMPT_DEFAULTS`. Replace `PROMPTS["key"]` usage with `get_prompt("service:key")`. The prompt will then appear in the admin prompt editor UI.
- **Add a gated HF model integration.** Wrap `from_pretrained` in try/except, call `_check_gated_repo_error(e)`, let `GatedRepoError` propagate. The service's `/models/load` handler returns 403 and the frontend `showGatedRepoToast()` takes over.
- **Add a studio setting slider/toggle.** Use `.settings-prominent-grid` + `.ss-group` + `.ss-group-label` + `.sc-slider` + `.field-val` inside the `.settings-crumb` dropdown. Do not reuse the `/settings` page classes. Wire values with `wireSettingsToggle()` from `studio-helpers.js`.

## Hardware

- **GPU**: NVIDIA RTX 4090, 24 GB VRAM (~2.5 GB consumed by Windows 11 desktop compositor and background processes)
- **Ollama**: runs inside Docker (the `ollama` service in compose), not on the host. Use `docker exec ollama ollama <command>` for model management.

## Validation

- No test suite, linter, or formatter is configured in this repo. There is nothing to run.
- Validate backend changes with `docker compose build <service>` followed by `docker compose up -d <service>`, then hit the affected endpoint or exercise the flow in the UI. Tail logs with `docker compose logs -f <service>` while testing.
- Frontend has no build step - JS/CSS edits in `web/` are live after a browser refresh at `http://localhost:8080`.

## Key Commands

```bash
docker compose up -d              # Start all services
docker compose build <service>    # Rebuild one service
docker compose logs -f <service>  # Tail logs
docker exec ollama ollama list    # Ollama model management (runs in Docker, not host)
```
