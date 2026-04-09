# Module Ideas for WoozleBox

Brainstormed additions that complement the existing Chat, Image Studio, Music Studio, Video Studio, Note Taker, and Vault modules. Each idea is designed to fit the current architecture: a single-file FastAPI service, vanilla JS frontend panel, and shared GPU via gpu-manager.

---

## Tier 1 - High Impact, Natural Fits

### 1. Code Studio

An AI-powered code editor and generator. The Chat module already handles code questions, but a dedicated studio would provide a proper editing experience.

**What it does:**
- Syntax-highlighted code editor panel (CodeMirror or Monaco, vendored)
- Generate scripts/functions from natural language prompts
- Explain, refactor, debug, or translate existing code
- Run Python/Bash snippets in a sandboxed container and display output
- "Iterate" button - describe what to change, LLM rewrites the code
- Export/download generated files
- Session history like the other studios

**Backend:** Mostly just Ollama calls routed through rag-api or a thin new `code-api`. The sandbox runner would be a lightweight Docker container with Python/Node. Could also let users pull in Vault documents as context (e.g., "write a parser for this spec I uploaded").

**Why it fits:** Code generation is one of the highest-value LLM use cases and currently lives awkwardly inside the chat module. A dedicated studio with a real editor, output panel, and iteration loop would be a big upgrade.

---

### 2. Podcast Studio (NotebookLM-style)

Generate multi-speaker audio discussions from documents or topics - the "NotebookLM podcast" feature but self-hosted.

**What it does:**
- User provides a topic, paste text, or selects Vault documents
- LLM generates a natural-sounding two-speaker dialogue script
- Kokoro TTS renders each speaker with a different voice
- Output: a single merged audio file with natural back-and-forth
- Controls for tone (casual, educational, debate), length, number of speakers
- Edit the generated script before rendering audio
- Optionally generate cover art via SDXL Turbo

**Backend:** New `podcast-api` service. LLM generates the script (structured JSON with speaker + line), then Kokoro renders each line, and ffmpeg concatenates with optional crossfade. No GPU needed beyond the LLM call - Kokoro runs on CPU.

**Why it fits:** Combines existing pieces (Vault for source material, Kokoro for TTS, LLM for script writing, SDXL for cover art) into a genuinely new capability. Self-hosted NotebookLM podcasts would be a standout feature.

---

### 3. Vision Module (Image Understanding)

Upload or paste images and ask questions about them. OCR, description, visual Q&A.

**What it does:**
- Drag-and-drop or paste images into a panel
- "Describe this image" - detailed natural language description
- "Extract text" - OCR with layout awareness
- Visual Q&A - "What brand is on the sign?", "How many people are in this photo?"
- Batch processing - describe/OCR a folder of images
- Feed results into Chat or Vault for further processing
- Screenshot analysis - paste a screenshot, get structured data back

**Backend:** Ollama already supports multimodal models (LLaVA, Llama 3.2 Vision, moondream). Just needs a new endpoint that sends base64 images with the prompt. Could live in rag-api as a new route or a small `vision-api`.

**Why it fits:** Multimodal understanding is a natural complement to multimodal generation. The Image Studio creates images - the Vision module understands them. Extremely practical for document digitization, accessibility, and analysis.

---

### 4. Document Writer

AI-assisted long-form writing with structure, not just chat responses.

**What it does:**
- Start from a topic or outline - LLM generates a structured document
- Section-by-section editing: expand, rewrite, change tone, add detail
- Sidebar outline view with drag-to-reorder sections
- Tone presets: academic, casual, technical, marketing, creative
- Pull in Vault documents as reference material
- Export as Markdown, plain text, or HTML
- Version history - compare drafts side by side
- Word count targets and progress tracking

**Backend:** Mostly LLM calls through rag-api with specialized prompts. No new service strictly needed - could be a `media-api` extension. The key is the frontend UX: a proper document editor, not a chat interface.

**Why it fits:** Chat is great for questions and short responses, but writing a report, blog post, or proposal needs a different UX. This fills the gap between "ask the AI something" and "produce a polished document."

---

## Tier 2 - Solid Additions

### 5. Workflow Builder (Pipeline Chaining)

Visually connect existing modules into automated pipelines.

**What it does:**
- Drag-and-drop node editor (e.g., Transcribe -> Summarize -> Generate Image -> Create Video)
- Preset workflows: "Meeting to Action Items", "Blog Post to Social Media Pack", "Audio to Illustrated Summary"
- Each node configures one module's settings
- Run the pipeline end-to-end, see results at each stage
- Save and reuse workflows
- Schedule recurring workflows (e.g., "every Monday, summarize my uploaded notes")

**Backend:** A thin orchestration layer that calls existing service endpoints in sequence, passing outputs as inputs. No ML models needed - purely coordination logic. Could be a new `workflow-api` or built into `media-api`.

**Why it fits:** The modules are powerful individually but disconnected. Letting users chain them together multiplies the value without any new ML infrastructure.

---

### 6. Sound Design Studio (SFX Generation)

Generate sound effects and ambient audio from text descriptions.

**What it does:**
- Text-to-SFX: "thunder rolling across a valley", "keyboard typing in a quiet office"
- Ambient scene builder: layer multiple sounds with volume/pan controls
- Sound library: save and organize generated effects
- Timeline mixer for arranging clips
- Export as WAV/MP3

**Backend:** New `sfx-api` using a model like Stable Audio Open or AudioLDM2. Similar architecture to music-api. GPU manager already handles model swapping.

**Why it fits:** Music Studio handles songs/music, but sound effects are a different category entirely. Useful for video creators, game devs, podcast producers. Rounds out the audio generation story.

---

### 7. Translation Hub

Real-time document and text translation with LLM-quality output.

**What it does:**
- Paste text or upload documents for translation
- Side-by-side source/target view
- Bulk translate Vault documents
- Glossary support: define domain-specific term translations
- Tone preservation options (formal, casual, technical)
- Translate Note Taker transcripts
- Subtitle generation for Video Studio outputs

**Backend:** Ollama LLM calls with translation-specific prompts. Could also integrate CTranslate2/NLLB for faster/lighter translation of large documents. Mostly a rag-api extension.

**Why it fits:** LLMs are excellent translators, and the infrastructure is already there. A dedicated UI makes it far more usable than asking the chat to translate. Especially powerful combined with Note Taker (transcribe a foreign-language meeting, translate, summarize).

---

### 8. Presentation Generator

Generate slide decks from prompts or documents.

**What it does:**
- Describe a presentation topic, LLM generates an outline + slide content
- Auto-generate relevant images per slide via Image Studio
- Multiple themes/templates
- Edit individual slides (text and image)
- Speaker notes generation
- Export as HTML slideshow (reveal.js, vendored) or PDF
- Import existing content from Vault for source material

**Backend:** LLM generates structured JSON (slides with titles, bullet points, image prompts). Image generation via existing image-api. A small `presentation-api` or media-api extension handles the assembly. Reveal.js handles rendering in-browser.

**Why it fits:** Presentations are one of the most common knowledge work outputs. Combining LLM writing with image generation produces something genuinely useful that commercial tools charge a lot for.

---

## Tier 3 - Ambitious / Experimental

### 9. 3D Asset Generator

Text or image to 3D model generation.

**What it does:**
- Text-to-3D: describe an object, get a 3D mesh
- Image-to-3D: upload a photo, generate a 3D model from it
- In-browser 3D viewer (Three.js already vendored)
- Export as GLB/OBJ for use in other tools
- Turntable video render via Video Studio integration
- Texture generation and editing

**Backend:** New `3d-api` using models like TripoSR, InstantMesh, or Trellis. These are relatively VRAM-hungry but fit the gpu-manager architecture.

**Why it fits:** Three.js is already in the project for the avatar. The 3D viewer infrastructure exists. This would push into a space few self-hosted tools cover.

---

### 10. Fine-tuning Lab

Create custom LoRA adapters for the image models or fine-tune small LLMs on your data.

**What it does:**
- Upload training images + captions for image model LoRAs
- Upload text data for LLM fine-tuning (QLoRA)
- Training progress dashboard with loss curves
- Test the fine-tuned model immediately in the relevant studio
- Manage and switch between custom LoRAs
- Export trained adapters

**Backend:** New `training-api` using PEFT/LoRA libraries. Training jobs are long-running, so this needs a job queue and progress tracking (similar pattern to existing generation progress endpoints).

**Why it fits:** Power users want models that know their style, their products, their domain. This turns WoozleBox from a generic tool into a personalized one. It's complex but architecturally possible with the existing GPU management.

---

### 11. Comic / Storyboard Creator

Generate visual narratives by combining sequential image generation with text.

**What it does:**
- Describe a story or scene sequence
- LLM breaks it into panels with image prompts and dialogue
- Image Studio generates each panel with consistent style
- Arrange panels in comic layouts (grid, manga-style, etc.)
- Add speech bubbles and captions
- Export as image or PDF
- Style locking - maintain character/art consistency across panels

**Backend:** Orchestration layer on top of existing LLM + image-api. The challenge is style consistency across panels (seed locking, prompt engineering, or IP-Adapter for character consistency).

**Why it fits:** Combines writing + image generation in a structured creative format. The pieces are all there - this is mainly a frontend/orchestration challenge.

---

## Summary Table

| Module | New Service? | GPU Needed? | Leverages Existing | Complexity |
|--------|-------------|-------------|-------------------|------------|
| Code Studio | Optional | LLM only | Ollama, Vault | Medium |
| Podcast Studio | Yes (thin) | LLM only | Kokoro, Vault, SDXL | Medium |
| Vision Module | No | LLM only | Ollama (multimodal) | Low |
| Document Writer | No | LLM only | Ollama, Vault | Medium |
| Workflow Builder | Yes (thin) | None (orchestration) | All modules | Medium-High |
| Sound Design Studio | Yes | New model | gpu-manager | Medium |
| Translation Hub | No | LLM only | Ollama, Vault, Note Taker | Low |
| Presentation Generator | Optional | LLM + Image | Ollama, image-api | Medium |
| 3D Asset Generator | Yes | New model | Three.js, gpu-manager | High |
| Fine-tuning Lab | Yes | Heavy GPU | image-api, Ollama | High |
| Comic Creator | No | LLM + Image | Ollama, image-api | Medium-High |

---

*Easiest wins: Vision Module and Translation Hub - both mostly need frontend UI and specialized prompts, with minimal backend work. Biggest "wow factor": Podcast Studio and Presentation Generator - they produce polished, shareable outputs by combining things that already exist.*
