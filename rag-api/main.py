"""
main.py -FastAPI RAG service for WoozleBox.

Chat flow (streaming SSE):
  1. Embed question via nomic-embed-text
  2. Query ChromaDB (cosine distance, top_k chunks)
  3. Optionally query SearXNG for web results
  4. If best distance > threshold → stream "not found" done event
  5. Stream status events, then token-by-token LLM response
  6. Save conversation + messages to SQLite on completion
"""

import os
import re
import io
import json
import time
import base64
import logging
import asyncio
import shutil
import secrets
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Optional, AsyncGenerator

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse, Response
from passlib.context import CryptContext
from pydantic import BaseModel
import ollama as ollama_client

from indexer import get_chroma_client, embed_texts, index_vault, collection_name_for_user
import db

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- Config ---
VAULT_PATH        = os.environ.get("VAULT_PATH", "/vault")
OLLAMA_BASE_URL   = os.environ.get("OLLAMA_BASE_URL", "http://host.docker.internal:11434")
EMBED_MODEL       = os.environ.get("EMBED_MODEL", "nomic-embed-text")
LLM_MODEL         = os.environ.get("LLM_MODEL", "qwen3:30b-a3b")
UTILITY_MODEL     = os.environ.get("UTILITY_MODEL", "qwen3:0.6b")
SIMILARITY_THRESHOLD = float(os.environ.get("SIMILARITY_THRESHOLD", "0.45"))
TAVILY_API_KEY    = os.environ.get("TAVILY_API_KEY", "")
DB_DIR            = os.environ.get("DB_DIR", "/app/data")
TTS_URL           = os.environ.get("TTS_URL", "http://tts-api:5005")
DEFAULT_VOICE     = "tara"
GPU_MANAGER_URL   = os.environ.get("GPU_MANAGER_URL", "http://gpu-manager:8400")
DEFAULT_TOP_K     = 30
NOT_FOUND_MSG     = "I couldn't find that in your vault."
SUPPORTED_UPLOAD_EXTENSIONS = {".md", ".txt", ".pdf"}

# ── LLM Prompt Templates ──
# All system prompts in one place for easy editing.
PROMPTS = {
    "default_assistant": (
        "You are a personal AI assistant. When relevant context from the "
        "user's vault is provided, prioritize it in your answer. Otherwise, "
        "answer using your general knowledge. "
        "Formatting: never use em dashes. When using a hyphen as a dash, "
        "always put a space on both sides (e.g. 'word - word', not 'word -word')."
    ),
    "local_model_disclaimer": (
        "You are running locally as {model} via Ollama on the user's own "
        "machine. You are NOT cloud-based and you are NOT a different model. "
        "Do not claim to be any other model or service."
    ),
    "web_search_off": (
        "IMPORTANT: Web search is currently OFF. If the user's question "
        "requires real-time, current, or location-specific information "
        "(weather, news, prices, events, etc.) that you don't have, tell "
        "them to click the globe icon (next to the chat input) to enable "
        "web search so you can look it up. Do NOT fabricate URLs, links, or "
        "suggest visiting specific websites. Do NOT make up current data. "
        "Simply tell them to enable web search."
    ),
    "web_search_content": (
        "You have been given real web page content in the [WEB SEARCH RESULTS] "
        "above. Answer the user's question using that content directly. Do NOT "
        "tell the user to visit a website. Do NOT say you lack real-time access. "
        "Summarize and report the actual information from the content."
    ),
    "web_search_fallback": (
        "Web search was performed but the pages could not be fully retrieved "
        "(JavaScript-rendered or blocked). Summarize what you can from the "
        "snippets and titles. Do not tell the user to visit a website - tell "
        "them the pages weren't fully accessible and share what little was retrieved."
    ),
    "memory_auto": (
        "MEMORY TOOL: You can save important facts about the user for future "
        "conversations.\nWhen the user shares personal details, preferences, or "
        "information worth remembering, include this tag in your response:\n"
        "[SAVE_MEMORY: the fact to remember]\n"
        "Examples: [SAVE_MEMORY: User's dog is named Max] or "
        "[SAVE_MEMORY: User prefers Python over JavaScript]\n"
        "Only save durable, useful facts. Do not save trivial or temporary information.\n"
        "Do not mention the SAVE_MEMORY tag to the user. Just naturally confirm "
        "you'll remember it.\n"
        "To remove an outdated fact, use: [DELETE_MEMORY: the outdated fact]"
    ),
    "memory_manual": (
        "MEMORY TOOL: You can save facts about the user when they explicitly "
        "ask you to remember something.\nWhen the user says \"remember that...\", "
        "\"save this...\", \"don't forget...\", or similar, include this tag in "
        "your response:\n[SAVE_MEMORY: the fact to remember]\n"
        "Only use this when the user explicitly asks you to remember something.\n"
        "Do not mention the SAVE_MEMORY tag to the user. Just naturally confirm "
        "you'll remember it.\n"
        "To remove an outdated fact when asked, use: [DELETE_MEMORY: the outdated fact]"
    ),
    "search_query_rewrite": (
        "Given the conversation history and the user's latest message, generate "
        "a concise web search query that captures what the user actually wants to "
        "find. Output ONLY the search query, nothing else."
    ),
    "conversation_summarizer": (
        "You are a concise summarizer. Output only the summary, nothing else."
    ),
    "memory_fact_extractor": (
        "Extract the single most important, memorable fact or takeaway from "
        "the following AI response. Output ONLY the fact as a short sentence. "
        "If there is nothing worth remembering, respond with exactly: NOTHING"
    ),
    "title_generator": (
        "Generate a short, descriptive title (3-7 words) for this conversation. "
        "The title should capture the main topic or question. "
        "Output ONLY the title text, no quotes, no explanation."
    ),
    "suggestions_vault": (
        "Based on this content, write exactly 4 specific, interesting things the user might want to ask or do with their documents. "
        "They can be questions or requests - just use correct punctuation. "
        "Questions end with '?', requests/statements end with '.'. "
        "They should be practical and specific to the actual content - not generic questions about the files themselves. "
        "Rules: each starter on its own line, correct ending punctuation (? or .), under 70 chars, no numbering, no bullets, no explanations."
    ),
    "suggestions_general": (
        "Write exactly 4 diverse, interesting conversation starters a user might send to an AI assistant. "
        "They can be questions or requests - just use correct punctuation. "
        "Questions end with '?', requests/statements end with '.'. "
        "Cover different topics. Be original.\n\n"
        "Rules: each starter on its own line, correct ending punctuation (? or .), under 70 chars, no numbering, no bullets, no explanations."
    ),
    "greeting": (
        "Write 2 lines for an AI assistant's welcome screen.\n"
        "Line 1: A short creative greeting, MAX 38 characters. Use the user's name if provided.\n"
        "Line 2: A short witty tagline, MAX 58 characters. Humor, wordplay, pop culture references welcome.\n"
        "Hard rules: stay under the character limits (count carefully), use ONLY plain ASCII hyphens '-' (NEVER em dashes '\u2014' or en dashes '\u2013'), no quotes, no emojis, no mention of files or web search. Output ONLY the 2 lines."
    ),
    "orpheus_emotions": (
        "EXPRESSIVE SPEECH: Your responses will be spoken aloud by a TTS "
        "engine (Orpheus) that has weak sensitivity to punctuation - it does "
        "not reliably convey surprise from '!' or questions from '?'. You "
        "must compensate by shaping the wording itself.\n\n"
        "EMOTION TAGS: Insert these inline where natural. Available tags: "
        "<laugh>, <chuckle>, <sigh>, <gasp>, <yawn>, <groan>, <cough>, "
        "<sniffle>, <giggle>. Examples: 'That is hilarious <laugh> I can "
        "not believe it' or 'Well <sigh> here we go'. One or two per "
        "response is usually enough. Skip them entirely for purely "
        "informational or technical content.\n\n"
        "PROSODY COMPENSATION - because punctuation alone is weak, use "
        "these writing techniques to get the right delivery:\n"
        "- For questions: add a tag phrase like 'right?', 'you know?', "
        "'don't you think?' at the end. A bare '?' often reads as a "
        "statement.\n"
        "- For surprise or excitement: start with '<gasp>', 'Oh!', 'Wow,', "
        "or 'No way -'. Do not rely on '!' alone.\n"
        "- For resignation or tiredness: start with '<sigh>', 'Well...', "
        "or 'Look,'.\n"
        "- For amusement: weave in '<chuckle>' or '<laugh>' mid-sentence "
        "rather than hoping the text sounds funny on its own.\n"
        "- For emphasis: keep the emphasized sentence short. Long "
        "sentences flatten out in delivery.\n"
        "- For hesitation: use '...' and hedge words like 'hmm,', 'uh,', "
        "'I mean,'.\n"
        "Rephrase rather than relying on punctuation marks to carry tone."
    ),
}

# ── Prompt Registry (all 37 prompts across both services) ──
# Maps namespaced keys to metadata. Default text comes from PROMPTS (rag) or
# MEDIA_PROMPT_DEFAULTS (media). Overrides are stored in the prompt_overrides table.

MEDIA_PROMPT_DEFAULTS = {
    "image_inspire": (
        "You are a creative director who generates vivid, detailed text-to-image prompts. "
        "Generate exactly ONE unique, imaginative prompt for an AI image generator. "
        "Be specific about subject, setting, lighting, mood, and composition. "
        "Vary widely between styles: landscapes, portraits, fantasy, sci-fi, nature, "
        "architecture, abstract, etc. "
        "Output ONLY the prompt text, nothing else - no quotes, no explanation, no numbering."
    ),
    "music_inspire": (
        "You are a music producer who generates creative text-to-music prompts for an AI "
        "music generator. Generate exactly ONE unique, vivid music prompt describing genre, "
        "mood, instruments, tempo feel, and vibe. "
        "Vary widely between styles: pop, rock, jazz, electronic, classical, hip-hop, folk, "
        "ambient, metal, world, funk, cinematic, etc. "
        "Output ONLY the prompt text, nothing else - no quotes, no explanation, no numbering. "
        "Keep it to 1-2 sentences."
    ),
    "song_title": (
        "You are a creative music producer. Given a song's style description and optional "
        "lyrics, generate exactly ONE short, catchy song title (1-5 words). "
        "Be creative and evocative. Output ONLY the title - no quotes, no explanation, "
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
        "You are a professional songwriter. Given a brief description, generate ONLY "
        "structured LYRICS with section tags like [verse], [chorus], [bridge], [outro].\n\n"
        "Rules:\n"
        "- Do NOT generate any style, genre, or music description - only lyrics\n"
        "- Lyrics should have at least 2 verses and a chorus\n"
        "- Use [verse], [chorus], [bridge], [pre-chorus], [outro] tags on their own lines\n"
        "- Write natural, singable lyrics that match the described mood\n"
        "- Keep lyrics concise - each section should be 2-4 lines\n"
        "- Do NOT include any explanation, just the lyrics\n\n"
        "Output the lyrics directly, starting with the first section tag."
    ),
    "video_inspire": (
        "You are a creative video director who generates vivid text-to-video prompts for an "
        "AI video generator. Generate exactly ONE unique, cinematic video prompt describing "
        "the scene, action, camera movement, lighting, and mood. "
        "Vary widely between styles: nature documentary, cinematic narrative, abstract art, "
        "sci-fi, urban life, underwater, aerial, timelapse, etc. "
        "Output ONLY the prompt text, nothing else - no quotes, no explanation, no numbering. "
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
    "notetaker_summary_professional": (
        "You are a professional meeting note-taker. Given a meeting transcript with speaker labels, "
        "generate a structured summary in markdown with these sections:\n\n"
        "## Summary\nA concise 2-3 paragraph overview of the meeting.\n\n"
        "## Key Decisions\nBullet list of decisions made.\n\n"
        "## Action Items\nBullet list with owner and deadline if mentioned.\n\n"
        "## Follow-ups\nItems that need further discussion or resolution.\n\n"
        "Be concise and factual. Use the speaker labels from the transcript. "
        "Use markdown headings (##) and bullet lists (- ). "
        "Do NOT include any reasoning, thinking, or internal monologue - output ONLY the summary. /no_think"
    ),
    "notetaker_summary_personal": (
        "You are a helpful personal assistant. Given a transcript of a personal appointment or consultation "
        "(e.g., doctor visit, legal consult, financial planning), generate a structured summary in markdown:\n\n"
        "## Key Takeaways\nThe most important points discussed.\n\n"
        "## Recommendations\nAny advice, prescriptions, or suggestions given.\n\n"
        "## Follow-ups\nNext steps, future appointments, or things to research.\n\n"
        "Be clear and practical. Use the speaker labels from the transcript. "
        "Use markdown headings (##) and bullet lists (- ). "
        "Do NOT include any reasoning, thinking, or internal monologue - output ONLY the summary. /no_think"
    ),
    "notetaker_summary_casual": (
        "You are a friendly note-taker. Given a transcript of a casual discussion or brainstorming session, "
        "generate a light structured summary in markdown:\n\n"
        "## Highlights\nKey ideas and interesting points raised.\n\n"
        "## Ideas\nCreative suggestions or brainstorms worth remembering.\n\n"
        "## Next Steps\nAny loose plans or things people agreed to explore.\n\n"
        "Keep the tone relaxed and concise. Use markdown headings (##) and bullet lists (- ). "
        "Do NOT include any reasoning, thinking, or internal monologue - output ONLY the summary. /no_think"
    ),
    "notetaker_summary_training": (
        "You are an educational note-taker. Given a transcript of a training session, lecture, or workshop, "
        "generate a structured summary in markdown:\n\n"
        "## Key Concepts\nMain topics and concepts covered.\n\n"
        "## Learning Points\nImportant details, techniques, or facts to remember.\n\n"
        "## Q&A Recap\nQuestions asked and answers given (if any).\n\n"
        "## Resources\nAny tools, links, or references mentioned.\n\n"
        "Be thorough but concise. Focus on what a learner would need to retain. "
        "Use markdown headings (##) and bullet lists (- ). "
        "Do NOT include any reasoning, thinking, or internal monologue - output ONLY the summary. /no_think"
    ),
    "notetaker_summary_interview": (
        "You are a professional interview note-taker. Given a transcript of an interview "
        "(job interview, user research, etc.), generate a structured summary in markdown:\n\n"
        "## Overview\nBrief context of the interview.\n\n"
        "## Key Questions & Responses\nThe most important questions and summarized answers.\n\n"
        "## Strengths\nNotable positive points or insights.\n\n"
        "## Concerns\nAny flags, gaps, or areas needing follow-up.\n\n"
        "## Assessment\nBrief overall impression.\n\n"
        "Be objective and factual. Use the speaker labels from the transcript. "
        "Use markdown headings (##) and bullet lists (- ). "
        "Do NOT include any reasoning, thinking, or internal monologue - output ONLY the summary. /no_think"
    ),
    "notetaker_summary_client": (
        "You are a professional client meeting note-taker. Given a transcript of a client call, "
        "sales meeting, or vendor discussion, generate a structured summary in markdown:\n\n"
        "## Summary\nBrief overview of the meeting purpose and outcome.\n\n"
        "## Client Requirements\nWhat the client needs or requested.\n\n"
        "## Commitments\nPromises made by either side, with owners.\n\n"
        "## Next Steps\nAgreed follow-up actions and timeline.\n\n"
        "Be professional and precise. Use the speaker labels from the transcript. "
        "Use markdown headings (##) and bullet lists (- ). "
        "Do NOT include any reasoning, thinking, or internal monologue - output ONLY the summary. /no_think"
    ),
    "notetaker_summary_custom": (
        "You are a professional note-taker. Given a meeting transcript with speaker labels, "
        "generate a structured, useful summary in markdown. {custom_instructions}\n\n"
        "Be concise and factual. Use the speaker labels from the transcript. "
        "Use markdown headings (##) and bullet lists (- ). "
        "Do NOT include any reasoning, thinking, or internal monologue - output ONLY the summary. /no_think"
    ),
    "notetaker_classify": (
        "Classify this transcript into exactly one category. "
        "Reply with ONLY the single category word, nothing else - no punctuation, no explanation.\n\n"
        "Categories:\n"
        "professional - work meetings, standups, sprint planning, team syncs, project reviews\n"
        "personal - doctor visits, legal consults, financial planning, personal calls\n"
        "casual - informal chats, brainstorming, social discussions, catching up\n"
        "training - lectures, workshops, tutorials, educational sessions, onboarding\n"
        "interview - job interviews, user research interviews, Q&A sessions\n"
        "client - client calls, sales meetings, vendor discussions, account reviews\n\n"
        "/no_think"
    ),
    "notetaker_title": (
        "Generate a short, descriptive title (3-7 words) for a meeting based on the transcript. "
        "Capture the main topic discussed. Output ONLY the title - no quotes, no explanation, "
        "no prefix like 'Title:'. Just the title words. /no_think"
    ),
    "code_generate": (
        "You are an expert pair-programming partner. Generate fresh code based on the user's request.\n\n"
        "CRITICAL OUTPUT FORMAT: your response MUST contain the code inside a single triple-backtick "
        "fenced block with a language identifier on the same line as the opening fence. The opening "
        "fence MUST be followed by a newline before any code. Example:\n"
        "```python\\n<code goes here>\\n```\n\n"
        "Your response has three parts in this order:\n"
        "1. First, briefly explain your approach (1-2 sentences). Plain prose, no heading.\n"
        "2. Then the fenced code block (REQUIRED - never emit raw code without fences).\n"
        "3. Finally, one sentence confirming what was built or how to run it. No heading.\n\n"
        "Do NOT split the code across multiple fenced blocks - use exactly ONE fenced block "
        "containing the complete file. Write clean, idiomatic, production-quality code. "
        "If the request is unclear, ask a single clarifying question instead of guessing."
    ),
    "code_edit": (
        "You are an expert pair-programming partner. The user has existing code open in an editor. "
        "The existing code is provided between [EXISTING CODE] markers.\n\n"
        "If the user asks a question, describes an issue, or makes a comment that does NOT request "
        "a code change, respond conversationally - answer their question, explain the code, or discuss "
        "their concern. Do NOT output SEARCH/REPLACE blocks or fenced code for non-edit requests.\n\n"
        "When the user requests a code change, you MUST output the change in EXACTLY ONE of these "
        "two formats (never mix them in the same response):\n\n"
        "FORMAT A - SEARCH/REPLACE blocks (preferred for small, targeted edits):\n"
        "<<<<<<< SEARCH\\nexact lines from existing code\\n=======\\nreplacement lines\\n>>>>>>> REPLACE\n"
        "Every block MUST start with <<<<<<< SEARCH (7 angle brackets, space, SEARCH in caps) "
        "and end with >>>>>>> REPLACE (7 angle brackets, space, REPLACE in caps). "
        "The separator is ======= (7 equals signs) on its own line. The SEARCH section must match "
        "the existing code EXACTLY including whitespace. Use one block per changed region. "
        "For small edits, include 1-2 lines of context around the change.\n\n"
        "FORMAT B - Full file replacement in a fenced block (use this when changes are pervasive, "
        "OR when you cannot reliably produce SEARCH/REPLACE blocks):\n"
        "```language\\n<complete new code, full file>\\n```\n"
        "Use the SAME language identifier as the original file. The opening fence MUST be on its own "
        "line followed by a newline. Output the ENTIRE file, not a fragment.\n\n"
        "Response structure for either format:\n"
        "1. First, 1-2 sentences explaining what you will change. Plain prose, no heading. Be specific "
        "about which functions or sections you're touching.\n"
        "2. Then ONE of: a sequence of SEARCH/REPLACE blocks (Format A), OR a single fenced full-file "
        "block (Format B). Never both.\n"
        "3. Finally, one sentence confirming the result. No heading. Never end on a REPLACE block "
        "or a closing fence - always add the confirmation sentence after.\n\n"
        "Pick Format A or Format B once and stick with it. If you start emitting SEARCH/REPLACE, "
        "do not switch to a fence partway through, and vice versa. Write clean, idiomatic code."
    ),
    "code_inspire": (
        "You are a programming mentor. Suggest a practical, interesting coding task that "
        "someone could build to practice their skills. Vary widely between topics: algorithms, "
        "web development, data processing, CLI tools, automation, APIs, etc. "
        "Output ONLY the task description in 1-2 sentences - no quotes, no explanation."
    ),
    "code_session_title": (
        "Generate a short, descriptive title (3-6 words) for a coding session based on the "
        "prompt. Capture the main task or concept. "
        "Output ONLY the title text, no quotes, no explanation."
    ),
    "code_compact": (
        "You are a technical summarizer. Given a conversation history from a coding session, "
        "produce a concise summary that captures: what was built, key decisions made, current "
        "state of the code, and any issues discussed. Use bullet points. "
        "Keep it under 300 words. Output ONLY the summary, no preamble."
    ),
}

PROMPT_REGISTRY = {
    # -- Chat --
    "rag:default_assistant":    {"service": "rag",   "label": "Chat System Prompt",      "category": "Chat",         "description": "The base personality and behavior instructions for every chat conversation. Controls tone, formatting rules, and how the AI introduces itself. This is the foundation all other chat instructions build on."},
    "rag:local_model_disclaimer": {"service": "rag", "label": "Local Model Disclaimer",  "category": "Chat",         "description": "Appended to the system prompt when using locally-hosted Ollama models instead of cloud APIs. Typically warns the AI about its reduced capabilities so it can set appropriate expectations."},
    "rag:orpheus_emotions":     {"service": "rag",   "label": "TTS Emotion Tags",        "category": "Chat",         "description": "Instructions telling the AI when and how to insert emotion tags (laugh, sigh, gasp, etc.) into responses for text-to-speech playback via Orpheus. Controls the expressiveness of spoken responses."},
    "rag:greeting":             {"service": "rag",   "label": "Greeting Generator",      "category": "Chat",         "description": "Prompt used to generate the welcome message shown on the chat home screen. The AI produces a personalized greeting based on user profile, time of day, and conversation history."},
    "rag:title_generator":      {"service": "rag",   "label": "Conversation Title",      "category": "Chat",         "description": "Generates a short title for chat conversations, shown in the sidebar history. Receives the first few messages and produces a concise, descriptive title."},
    # -- Memory --
    "rag:memory_auto":          {"service": "rag",   "label": "Auto-Memory Extraction",  "category": "Memory",       "description": "Instructions for automatically deciding what facts to remember from conversations. Controls what the AI considers worth saving to long-term memory without being explicitly asked."},
    "rag:memory_manual":        {"service": "rag",   "label": "Manual Memory Save",      "category": "Memory",       "description": "Instructions for extracting a memory fact when the user explicitly asks the AI to remember something. More targeted than auto-memory."},
    "rag:memory_fact_extractor": {"service": "rag",  "label": "Memory Fact Extractor",   "category": "Memory",       "description": "Extracts structured facts from AI responses for storage. Runs after the response is generated to pull out key information."},
    # -- Web Search --
    "rag:web_search_off":       {"service": "rag",   "label": "Web Search Disabled",     "category": "Web Search",   "description": "Appended to the system prompt when web search is turned off. Instructs the AI on how to handle requests for current information without search access."},
    "rag:web_search_content":   {"service": "rag",   "label": "Web Search Results",      "category": "Web Search",   "description": "Injected when web search returns page content. Tells the AI how to use, cite, and present information from retrieved web pages."},
    "rag:web_search_fallback":  {"service": "rag",   "label": "Web Search Fallback",     "category": "Web Search",   "description": "Used when web pages could not be fully retrieved. Instructs the AI to work with partial results (titles/snippets) and be transparent about limitations."},
    # -- Utilities --
    "rag:search_query_rewrite": {"service": "rag",   "label": "Search Query Rewrite",    "category": "Utilities",    "description": "Transforms natural-language user messages into effective web search queries. Strips conversational filler and focuses on searchable keywords."},
    "rag:conversation_summarizer": {"service": "rag","label": "Conversation Summarizer", "category": "Utilities",    "description": "Produces concise summaries of conversation history for the context compaction system. Keeps the essential context while reducing token count."},
    "rag:suggestions_vault":    {"service": "rag",   "label": "Vault Suggestions",       "category": "Utilities",    "description": "Generates conversation starter suggestions based on the user's uploaded vault documents. Shows on the home screen to prompt relevant discussions."},
    "rag:suggestions_general":  {"service": "rag",   "label": "General Suggestions",     "category": "Utilities",    "description": "Generates generic conversation starter suggestions when there are no vault documents. Provides interesting, varied starting points for new conversations."},
    # -- Image Studio --
    "media:image_inspire":      {"service": "media", "label": "Image Inspire",           "category": "Image Studio", "description": "Creative director prompt that transforms user ideas into detailed text-to-image generation prompts. Adds visual detail, composition, lighting, and style guidance for Stable Diffusion."},
    "media:cover_art":          {"service": "media", "label": "Cover Art Generator",     "category": "Image Studio", "description": "Generates album/single cover art prompts based on song metadata. Creates visually striking artwork descriptions tailored for music cover art generation."},
    # -- Music Studio --
    "media:music_inspire":      {"service": "media", "label": "Music Inspire",           "category": "Music Studio", "description": "Music producer prompt that expands user ideas into detailed text-to-music generation prompts for ACE-Step. Adds genre, mood, instrumentation, and structural guidance."},
    "media:song_title":         {"service": "media", "label": "Song Title Generator",    "category": "Music Studio", "description": "Creates catchy, creative song titles from lyrics or descriptions. Used when auto-naming music studio sessions."},
    "media:songwriting":        {"service": "media", "label": "Songwriting",             "category": "Music Studio", "description": "Professional songwriter prompt for generating lyrics with proper song structure (verse, chorus, bridge) and section tags that ACE-Step understands."},
    # -- Video Studio --
    "media:video_inspire":      {"service": "media", "label": "Video Inspire",           "category": "Video Studio", "description": "Creative director prompt for transforming ideas into detailed text-to-video generation prompts for Wan 2.1. Focuses on motion, camera work, and temporal storytelling."},
    "media:video_session_title": {"service": "media","label": "Video Session Title",     "category": "Video Studio", "description": "Generates descriptive titles for video studio sessions based on the generation prompt and content."},
    "media:video_thumbnail":    {"service": "media", "label": "Video Thumbnail",         "category": "Video Studio", "description": "Creates cinematic still-frame descriptions used to generate thumbnail images for video sessions."},
    # -- Note Taker --
    "media:notetaker_classify": {"service": "media", "label": "Transcript Classifier",   "category": "Note Taker",   "description": "Classifies a transcript into one of six meeting types (professional, personal, casual, training, interview, client) to auto-select the right summary template."},
    "media:notetaker_title":    {"service": "media", "label": "Meeting Title",           "category": "Note Taker",   "description": "Generates a concise title for a transcribed meeting or recording."},
    "media:notetaker_summary_professional": {"service": "media", "label": "Summary: Professional", "category": "Note Taker", "description": "Template for summarizing professional meetings - action items, decisions, attendees, next steps."},
    "media:notetaker_summary_personal":     {"service": "media", "label": "Summary: Personal",     "category": "Note Taker", "description": "Template for summarizing personal appointments and consultations - key takeaways and follow-ups."},
    "media:notetaker_summary_casual":       {"service": "media", "label": "Summary: Casual",       "category": "Note Taker", "description": "Template for summarizing casual discussions and brainstorming sessions - ideas, themes, and highlights."},
    "media:notetaker_summary_training":     {"service": "media", "label": "Summary: Training",     "category": "Note Taker", "description": "Template for summarizing training sessions and lectures - key concepts, examples, and learning points."},
    "media:notetaker_summary_interview":    {"service": "media", "label": "Summary: Interview",    "category": "Note Taker", "description": "Template for summarizing interviews and user research - questions, responses, insights, and themes."},
    "media:notetaker_summary_client":       {"service": "media", "label": "Summary: Client",       "category": "Note Taker", "description": "Template for summarizing client calls and sales meetings - requirements, commitments, and follow-ups."},
    "media:notetaker_summary_custom":       {"service": "media", "label": "Summary: Custom",       "category": "Note Taker", "description": "Custom summary template with a {custom_instructions} placeholder the user fills in per-session."},
    # -- Code Studio --
    "media:code_generate":      {"service": "media", "label": "Code Generation",         "category": "Code Studio",  "description": "System prompt for fresh code generation in the pair-programming editor. Defines how the AI writes code, explains decisions, and structures responses."},
    "media:code_edit":          {"service": "media", "label": "Code Editing",            "category": "Code Studio",  "description": "System prompt for editing existing code using SEARCH/REPLACE blocks. Controls the incremental edit format the AI uses for modifying code in-place."},
    "media:code_inspire":       {"service": "media", "label": "Code Inspire",            "category": "Code Studio",  "description": "Generates coding task suggestions and project ideas. Used for the inspire button that suggests what to build next."},
    "media:code_session_title": {"service": "media", "label": "Code Session Title",      "category": "Code Studio",  "description": "Generates descriptive titles for code studio sessions based on the conversation content."},
    "media:code_compact":       {"service": "media", "label": "Code Context Compact",    "category": "Code Studio",  "description": "Summarizes code studio conversation history for the context compaction system. Preserves code context and decisions while reducing tokens."},
}

# In-memory cache for prompt overrides (cleared on write)
_prompt_override_cache: dict[str, str] = {}
_prompt_cache_ts: float = 0

def _refresh_prompt_cache():
    """Reload prompt overrides from DB into memory."""
    global _prompt_override_cache, _prompt_cache_ts
    overrides = db.list_prompt_overrides()
    _prompt_override_cache = {r["key"]: r["content"] for r in overrides}
    _prompt_cache_ts = time.time()

def _invalidate_prompt_cache():
    global _prompt_cache_ts
    _prompt_cache_ts = 0

def get_prompt(key: str) -> str:
    """Get a prompt by namespaced key (e.g. 'rag:default_assistant').
    Returns the admin override if one exists, otherwise the hardcoded default."""
    if time.time() - _prompt_cache_ts > 60:
        _refresh_prompt_cache()
    if key in _prompt_override_cache:
        return _prompt_override_cache[key]
    # Fall back to hardcoded default
    _, short_key = key.split(":", 1)
    if key.startswith("rag:"):
        return PROMPTS.get(short_key, "")
    return MEDIA_PROMPT_DEFAULTS.get(short_key, "")


async def _report_vram(action: str, model: str, vram_mb: int = 0, detail: str = ""):
    """Fire-and-forget VRAM activity report to gpu-manager."""
    try:
        async with httpx.AsyncClient(timeout=2.0) as c:
            await c.post(f"{GPU_MANAGER_URL}/vram/log", json={
                "service": "rag-api", "action": action, "model": model,
                "vram_mb": vram_mb, "detail": detail,
            })
    except Exception:
        pass


async def _gpu_busy_for_gen() -> bool:
    """Check if GPU is busy with media generation (image/music/video model loaded)."""
    try:
        async with httpx.AsyncClient(timeout=3.0) as c:
            resp = await c.get(f"{GPU_MANAGER_URL}/status")
            loaded = resp.json().get("loaded", [])
            return any(m.get("type") in ("image", "music", "video") for m in loaded)
    except Exception:
        return False

# Orpheus ships 25 voices across 8 languages. This mirrors VOICE_TO_LANGUAGE
# from orpheus/tts_engine/inference.py so we can expose grouped voices in the
# UI without an extra round-trip. Flat list is kept for the ad-hoc "is this a
# valid voice?" check below.
TTS_VOICES_BY_LANG = {
    "english":  ["tara", "leah", "jess", "leo", "dan", "mia", "zac", "zoe"],
    "french":   ["pierre", "amelie", "marie"],
    "german":   ["jana", "thomas", "max"],
    "korean":   ["유나", "준서"],
    "hindi":    ["ऋतिका"],
    "mandarin": ["长乐", "白芷"],
    "spanish":  ["javi", "sergio", "maria"],
    "italian":  ["pietro", "giulia", "carlo"],
}
TTS_VOICES = [v for voices in TTS_VOICES_BY_LANG.values() for v in voices]

# Per-voice sampling defaults. Narrative voices use tighter temperature/top_p
# for steadier prosody; expressive voices use wider sampling for more dynamic
# range. Non-English voices inherit tts-api's defaults (0.6 / 0.9) until
# someone A/B tests them. Client-supplied temperature or top_p always wins.
TTS_VOICE_DEFAULTS = {
    "tara": {"temperature": 0.5, "top_p": 0.85},
    "dan":  {"temperature": 0.5, "top_p": 0.85},
    "leo":  {"temperature": 0.5, "top_p": 0.85},
    "leah": {"temperature": 0.7, "top_p": 0.92},
    "jess": {"temperature": 0.7, "top_p": 0.92},
    "mia":  {"temperature": 0.7, "top_p": 0.92},
    "zoe":  {"temperature": 0.7, "top_p": 0.92},
}

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")


# --- Auth helpers ---

def get_current_user(request: Request) -> dict:
    token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    if not token:
        token = request.query_params.get("token", "").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Unauthorized")
    session = db.get_session(token)
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    user = db.get_user_by_id(session["user_id"])
    if not user or not user["is_active"]:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return user


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Forbidden")
    return user


# --- Vault helpers ---

def user_vault_path(username: str) -> Path:
    p = Path(VAULT_PATH) / username
    p.mkdir(parents=True, exist_ok=True)
    return p


def _migrate_vault_files(admin_username: str):
    """Move any files/dirs at the vault root (not in a user subdir) into /vault/{admin_username}/."""
    vault = Path(VAULT_PATH)
    if not vault.exists():
        return
    dest = vault / admin_username
    dest.mkdir(parents=True, exist_ok=True)
    for item in list(vault.iterdir()):
        if item.name == admin_username:
            continue
        if item.is_dir():
            continue  # skip existing user subdirs
        try:
            shutil.move(str(item), str(dest / item.name))
            logger.info(f"Vault migration: moved {item.name} → {admin_username}/")
        except Exception as e:
            logger.warning(f"Vault migration: could not move {item.name}: {e}")


# --- Index status tracking ---
# Maps user_id -> {"running": bool, "queued": bool}
_index_status: dict[str, dict] = {}
_index_status_lock = __import__("threading").Lock()

def _set_index_status(user_id: str, running: bool, queued: bool = False):
    with _index_status_lock:
        _index_status[user_id] = {"running": running, "queued": queued}

def _get_index_status(user_id: str) -> dict:
    with _index_status_lock:
        return _index_status.get(user_id, {"running": False, "queued": False})


# --- Vault file watcher ---
def _start_vault_watcher():
    """Watch the vault directory and trigger incremental re-index when files change."""
    import threading
    import time
    from watchdog.observers.polling import PollingObserver
    from watchdog.events import FileSystemEventHandler

    SUPPORTED = {".md", ".txt", ".pdf"}
    DEBOUNCE_SECONDS = 3  # wait for burst of changes to settle

    # Per-user debounce timers
    _timers: dict[str, threading.Timer] = {}
    _lock = threading.Lock()

    def _reindex_user(username: str):
        user = db.get_user_by_username(username)
        if not user:
            return
        user_id = user["id"]
        _set_index_status(user_id, running=True, queued=False)
        try:
            result = index_vault(VAULT_PATH, user_id, EMBED_MODEL, OLLAMA_BASE_URL, username=username)
            logger.info(f"Auto-index for {username}: {result['files_processed']} new, {result.get('files_skipped',0)} skipped")
        except Exception as e:
            logger.warning(f"Auto-index failed for {username}: {e}")
        finally:
            _set_index_status(user_id, running=False)

    def _schedule_reindex(username: str):
        with _lock:
            if username in _timers:
                _timers[username].cancel()
            t = threading.Timer(DEBOUNCE_SECONDS, _reindex_user, args=[username])
            t.daemon = True
            _timers[username] = t
            t.start()
        # Set status using user_id for the frontend poll
        user = db.get_user_by_username(username)
        if user:
            _set_index_status(user["id"], running=False, queued=True)

    class VaultHandler(FileSystemEventHandler):
        def _handle(self, path: str):
            from pathlib import Path as P
            p = P(path)
            if p.suffix.lower() not in SUPPORTED:
                return
            # Derive username from path: VAULT_PATH/{username}/...
            try:
                rel = p.relative_to(VAULT_PATH)
                username = rel.parts[0]
                _schedule_reindex(username)
            except Exception:
                pass

        def on_created(self, event):
            if not event.is_directory: self._handle(event.src_path)
        def on_deleted(self, event):
            if not event.is_directory: self._handle(event.src_path)
        def on_moved(self, event):
            if not event.is_directory:
                self._handle(event.src_path)
                self._handle(event.dest_path)
        def on_modified(self, event):
            if not event.is_directory: self._handle(event.src_path)

    observer = PollingObserver(timeout=5)
    observer.schedule(VaultHandler(), path=VAULT_PATH, recursive=True)
    observer.daemon = True
    observer.start()
    logger.info(f"Vault watcher started on {VAULT_PATH}")


# --- Lifespan ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()

    # Migrate vault files to admin subdir if needed
    users = db.list_users()
    admins = [u for u in users if u["role"] == "admin"]
    if admins:
        _migrate_vault_files(admins[0]["username"])

    # Index vault for each active user
    logger.info("Starting up -indexing vaults...")
    loop = asyncio.get_event_loop()
    for user in users:
        if user.get("is_active"):
            try:
                result = await loop.run_in_executor(
                    None, lambda: index_vault(VAULT_PATH, user["id"], EMBED_MODEL, OLLAMA_BASE_URL, username=user["username"])
                )
                logger.info(f"Indexed vault for user {user['username']}: {result}")
            except Exception as e:
                logger.warning(f"Vault index failed for {user['username']}: {e}")

    # Start vault file watcher
    _start_vault_watcher()

    yield


app = FastAPI(title="WoozleBox RAG API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# --- Model pull state ---
# In-memory only: pulls survive while rag-api stays up. Ollama itself runs in
# a separate container, so a rag-api restart loses the progress feed but the
# pull continues server-side.
model_pull_sessions: dict = {}
model_pull_tasks: dict = {}  # session_id -> asyncio.Task, so we can cancel
_library_cache: dict = {"models": [], "fetched_at": 0.0, "error": None}
_tags_cache: dict = {}  # base_model -> {"tags": list[str], "error": str|None, "fetched_at": float}
LIBRARY_CACHE_TTL = 3600  # seconds
TAGS_CACHE_TTL = 3600     # seconds


# --- Pydantic models ---
class FileAttachment(BaseModel):
    name: str       # original filename
    data: str       # base64-encoded content

class ChatRequest(BaseModel):
    message: str
    model: Optional[str] = None
    conversation_id: Optional[str] = None
    folder_id: Optional[str] = None
    temperature: float = 0.2
    threshold: Optional[float] = None
    top_k: int = DEFAULT_TOP_K
    web_search: bool = False
    history_limit: int = 10  # legacy message-count cap; superseded by num_ctx token budget
    num_ctx: int = 8192  # context window (tokens) sent to Ollama and used to trim history
    compact_threshold: int = 75  # % of context at which to auto-compact
    user_context: Optional[str] = None  # profile name/role/preferences
    default_prompt: Optional[str] = None  # global default system prompt from settings
    auto_memory: bool = False  # whether the LLM should auto-save memory facts
    images: list[str] = []  # base64-encoded images for vision models
    files: list[FileAttachment] = []  # per-message file attachments
    rag_search: bool = False  # whether to include vault/RAG context
    custom_system_prompt: Optional[str] = None  # override system prompt from /system slash command

class ConversationPatch(BaseModel):
    title: str

class ConversationMove(BaseModel):
    folder_id: str

class FolderCreate(BaseModel):
    name: str
    description: Optional[str] = None
    system_prompt: Optional[str] = None

class FolderPatch(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    system_prompt: Optional[str] = None

class MemoryFactCreate(BaseModel):
    fact: str

class IndexResponse(BaseModel):
    files_processed: int
    files_skipped: int = 0
    chunks_upserted: int
    errors: list[str]

class ModelsResponse(BaseModel):
    models: list[str]
    default: str

class AvailableModelsResponse(BaseModel):
    models: list[str]
    ok: bool
    error: Optional[str] = None

class PullModelRequest(BaseModel):
    model: str

class PullModelResponse(BaseModel):
    session_id: str
    model: str

class VaultDeleteRequest(BaseModel):
    path: str  # relative path within vault

class VaultRenameRequest(BaseModel):
    path: str
    new_name: str

class VaultFolderRequest(BaseModel):
    folder: str  # relative folder path within vault

class VaultMoveRequest(BaseModel):
    path: str        # current relative file path
    dest_folder: str # destination folder (empty string = vault root)

class LoginRequest(BaseModel):
    username: str
    password: str

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

class AdminCreateUserRequest(BaseModel):
    username: str
    password: str
    role: str = "user"

class AdminPatchUserRequest(BaseModel):
    role: Optional[str] = None
    is_active: Optional[bool] = None

class AdminSetPasswordRequest(BaseModel):
    new_password: str

class UserSettingsRequest(BaseModel):
    settings: str  # opaque JSON string

class StudioItemCreate(BaseModel):
    id: Optional[str] = None
    folder_id: Optional[str] = None
    session_id: Optional[str] = None
    raw_prompt: Optional[str] = None
    title: Optional[str] = None
    meta: str = "{}"

class StudioItemPatch(BaseModel):
    folder_id: Optional[str] = None
    session_id: Optional[str] = None
    raw_prompt: Optional[str] = None
    title: Optional[str] = None
    meta: Optional[str] = None
    is_favorite: Optional[bool] = None

class StudioFolderCreate(BaseModel):
    id: Optional[str] = None
    name: str
    description: Optional[str] = None

class StudioFolderPatch(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


# --- SSE helpers ---
def sse(event: dict) -> str:
    return f"data: {json.dumps(event)}\n\n"


# --- Web search ---
async def web_search(query: str, num_results: int = 3) -> list[dict]:
    """Search the web using Tavily -returns full extracted content directly."""
    try:
        from tavily import TavilyClient
        client = TavilyClient(api_key=TAVILY_API_KEY)
        response = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: client.search(query, max_results=num_results, include_raw_content=False)
        )
        results = []
        for r in response.get("results", []):
            results.append({
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "content": r.get("content", ""),
                "snippet": r.get("content", ""),
            })
        return results
    except Exception as e:
        logger.warning(f"Web search failed: {e}")
        return []


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


async def _utility_llm(system: str, prompt: str, temperature: float = 0.8, num_predict: int = 80, user: dict = None, force_default: bool = False, caller: str = "utility") -> str:
    """Quick LLM call using the small utility model. Does NOT evict other models.
    When force_default=True, always uses the server default utility model (small)
    to avoid loading a large user-configured model into VRAM during generation."""
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
        # Strip thinking tags if present (qwen3 models)
        if "<think>" in text:
            import re
            text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
        return text



def extract_file_text(name: str, data_b64: str) -> str:
    """Extract plain text from a base64-encoded file attachment."""
    raw = base64.b64decode(data_b64)
    ext = os.path.splitext(name)[1].lower()
    if ext in (".txt", ".md", ".csv", ".log", ".yaml", ".yml", ".toml", ".ini", ".cfg",
               ".py", ".js", ".ts", ".html", ".css", ".sh", ".bat", ".sql", ".r",
               ".c", ".cpp", ".h", ".java", ".go", ".rs", ".rb", ".xml", ".json"):
        text = raw.decode("utf-8", errors="replace")
        if ext == ".json":
            try:
                text = json.dumps(json.loads(text), indent=2, ensure_ascii=False)
            except Exception:
                pass
        return text
    elif ext == ".pdf":
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(raw))
        pages = [p.extract_text() for p in reader.pages if p.extract_text()]
        return "\n\n".join(pages)
    else:
        # Check for binary content
        if b"\x00" in raw[:1024]:
            return f"(Binary file, cannot extract text)"
        return raw.decode("utf-8", errors="replace")


# --- Streaming chat generator ---
async def chat_stream(request: ChatRequest, user_id: str) -> AsyncGenerator[str, None]:
    model = request.model or LLM_MODEL
    threshold = request.threshold if request.threshold is not None else SIMILARITY_THRESHOLD
    top_k = max(1, request.top_k)
    collection_name = collection_name_for_user(user_id)

    # Step 1: Embed the query
    t_start = time.monotonic()
    documents, metadatas, distances = [], [], []
    relevant = []
    sources = []
    debug = {"best_distance": 2.0, "threshold": threshold, "chunks_retrieved": 0, "chunks_used": 0}
    # Timing keys: embed_ms=embed query, vault_ms=vault search, web_ms=web search, ttft_ms=time-to-first-token, total_ms=total wall-clock
    timings = {}

    # Step 2: Smart vault search -semantic probe, full search only if relevant.
    # The embed call is expensive (~500-900 ms for nomic-embed-text) and was
    # previously run unconditionally, adding ~1 s to every turn even when RAG
    # was off. Defer it until we know the vault exists and rag_search is on;
    # the embedding has no other consumer on the non-RAG path.
    vault_collection = None
    try:
        chroma_client = get_chroma_client()
        vault_collection = chroma_client.get_collection(collection_name)
        vault_count = vault_collection.count()
    except Exception:
        vault_count = 0

    query_embedding = None
    if vault_count > 0 and request.rag_search:
        yield sse({"type": "status", "step": "embed", "text": "Understanding your question…"})
        await _report_vram("call", EMBED_MODEL, detail="chat embedding")
        try:
            loop = asyncio.get_event_loop()
            query_embedding = await loop.run_in_executor(
                None, lambda: embed_texts([request.message], EMBED_MODEL, OLLAMA_BASE_URL)[0]
            )
        except Exception as e:
            yield sse({"type": "error", "text": f"Embedding failed: {e}"})
            return
        timings["embed_ms"] = round((time.monotonic() - t_start) * 1000)
        yield sse({"type": "status", "step": "embed", "text": "Question understood", "done": True})

    if vault_count > 0 and request.rag_search:
        # Quick probe: single nearest neighbor to check if anything is semantically close
        probe = vault_collection.query(query_embeddings=[query_embedding], n_results=1, include=["distances"])
        probe_dist = probe["distances"][0][0] if probe["distances"] and probe["distances"][0] else 2.0
        logger.info(f"Vault probe: '{request.message[:60]}' → best_dist={probe_dist:.3f}, threshold={threshold}")

        if probe_dist <= threshold:
            # Relevant content exists -do the full search
            t_vault = time.monotonic()
            yield sse({"type": "status", "step": "vault", "text": "Reading through your vault…"})
            try:
                results = vault_collection.query(
                    query_embeddings=[query_embedding],
                    n_results=top_k,
                    include=["documents", "metadatas", "distances"],
                )
                documents = results["documents"][0]
                metadatas = results["metadatas"][0]
                distances = results["distances"][0]
            except Exception as e:
                yield sse({"type": "error", "text": f"Vault search failed: {e}"})
                return

            timings["vault_ms"] = round((time.monotonic() - t_vault) * 1000)
            best_distance = distances[0] if distances else 2.0
            relevant = [
                (doc, meta)
                for doc, meta, dist in zip(documents, metadatas, distances)
                if dist <= threshold
            ]
            sources = list(dict.fromkeys(meta["source"] for _, meta in relevant))
            debug = {"best_distance": best_distance, "threshold": threshold, "chunks_retrieved": len(documents), "chunks_used": len(relevant)}

            if relevant:
                src_names = ", ".join(os.path.basename(s) for s in sources[:3])
                yield sse({"type": "status", "step": "vault", "text": f"Found relevant content in {src_names}", "done": True})
            else:
                yield sse({"type": "status", "step": "vault", "text": "Nothing relevant found in vault", "done": True})
        else:
            logger.info(f"Vault skipped -probe distance {probe_dist:.3f} > threshold {threshold}")

    # Step 3: Web search (optional) -skip if vault already has relevant results
    web_sources = []
    web_search_query = ""
    if request.web_search:
        # If the message is short/vague and we have conversation history, use LLM to build a proper search query
        raw_msg = request.message.strip()
        if len(raw_msg.split()) <= 5 and request.conversation_id:
            try:
                conv = db.get_conversation(request.conversation_id, user_id)
                if conv and conv["messages"]:
                    recent = conv["messages"][-6:]
                    history_text = "\n".join(f"{m['role'].upper()}: {m['content']}" for m in recent)
                    loc_ctx = ""
                    if request.user_context:
                        loc_match = re.search(r'Location:\s*(.+)', request.user_context)
                        if loc_match:
                            loc_ctx = f"\nUser location: {loc_match.group(1).strip()}"
                    await _report_vram("call", model, detail="chat query rewrite")
                    rewrite_resp = httpx.post(
                        f"{OLLAMA_BASE_URL}/api/chat",
                        json={
                            "model": model,
                            "messages": [
                                {"role": "system", "content": get_prompt("rag:search_query_rewrite") + loc_ctx},
                                {"role": "user", "content": f"Conversation:\n{history_text}\n\nLatest message: {raw_msg}"},
                            ],
                            "options": {"temperature": 0.1, "num_predict": 40},
                            "think": False,
                            "stream": False,
                        },
                        timeout=15,
                    )
                    rewritten = rewrite_resp.json().get("message", {}).get("content", "").strip().strip('"\'')
                    if rewritten and len(rewritten) > len(raw_msg):
                        raw_msg = rewritten
                        logger.info(f"Rewrote vague search query: '{request.message}' -> '{raw_msg}'")
            except Exception as e:
                logger.warning(f"Search query rewrite failed: {e}")

        # Clean the query -extract site: hint and strip meta-instructions
        search_query = raw_msg.rstrip("?!")
        # Detect site hints like "search reddit - X", "search X on reddit", "find X on twitter"
        # Sites that work well with site: operator (scrapeable)
        SITE_OPERATOR_MAP = {
            "wikipedia": "site:wikipedia.org",
            "github": "site:github.com",
            "stackoverflow": "site:stackoverflow.com",
            "hn": "site:news.ycombinator.com",
            "hacker news": "site:news.ycombinator.com",
        }
        # Sites that block scrapers -append as keyword instead so Google finds their content via cache/previews
        SITE_KEYWORD_MAP = {
            "reddit": "reddit",
            "twitter": "twitter",
            "youtube": "youtube",
        }
        site_operator = ""
        site_keyword = ""
        for keyword, operator in SITE_OPERATOR_MAP.items():
            if re.search(rf'\b{re.escape(keyword)}\b', search_query, re.IGNORECASE):
                site_operator = operator
                break
        if not site_operator:
            for keyword, kw in SITE_KEYWORD_MAP.items():
                if re.search(rf'\b{re.escape(keyword)}\b', search_query, re.IGNORECASE):
                    site_keyword = kw
                    break
        # Strip meta-instructions (including site names)
        search_query = re.sub(r"^(search|look up|find|google|ask)\s+(reddit|twitter|youtube|wikipedia|github|stackoverflow|hacker news|hn|the web|online|google|bing)[\s\-:]+", "", search_query, flags=re.IGNORECASE).strip()
        search_query = re.sub(r"\s+on\s+(reddit|twitter|youtube|wikipedia|github|stackoverflow|hacker news)$", "", search_query, flags=re.IGNORECASE).strip()
        if site_operator and site_operator not in search_query:
            search_query = f"{search_query} {site_operator}"
        elif site_keyword and site_keyword.lower() not in search_query.lower():
            search_query = f"{search_query} {site_keyword}"
        # Append user location to search query if it seems location-relevant
        # and doesn't already mention a specific place
        if request.user_context:
            location_match = re.search(r'Location:\s*(.+)', request.user_context)
            if location_match:
                user_location = location_match.group(1).strip()
                location_keywords = ["weather", "near me", "nearby", "local", "restaurant", "store", "shop",
                                     "directions", "traffic", "events", "here", "around me", "close to me"]
                if any(kw in search_query.lower() for kw in location_keywords):
                    # Only add if the query doesn't already contain the location
                    if user_location.lower() not in search_query.lower():
                        search_query = f"{search_query} {user_location}"
        web_search_query = search_query
        yield sse({"type": "status", "step": "web", "text": f"Searching: {search_query}"})
        t_web = time.monotonic()
        web_sources = await web_search(search_query)
        timings["web_ms"] = round((time.monotonic() - t_web) * 1000)
        if web_sources:
            domains = ", ".join(r["url"].split("/")[2].lstrip("www.") for r in web_sources)
            suffix = f"→ {domains}"
        else:
            suffix = "no results found"
        yield sse({"type": "status", "step": "web", "text": f"Web search complete -{suffix}", "done": True})

    # Step 4: (fallthrough -always proceed to LLM)

    # Step 5: Build context
    context_parts = []
    if relevant:
        vault_context = "\n\n---\n\n".join(doc for doc, _ in relevant)
        context_parts.append(f"[VAULT CONTEXT]\n{vault_context}")
    if web_sources:
        web_context = "\n\n".join(
            f"Title: {r['title']}\nURL: {r['url']}\nContent: {r.get('content') or r.get('snippet', '')}"
            for r in web_sources
        )
        context_parts.append(f"[WEB SEARCH RESULTS]\n{web_context}")

    context_text = "\n\n" + "\n\n".join(context_parts)
    source_instruction = "Use the vault context as your primary source." if relevant and web_sources else ""

    # Build system prompt - topic override, memory, user profile
    now = datetime.now().astimezone()
    date_str = now.strftime("%A, %B %-d, %Y at %-I:%M %p %Z")
    base_instructions = request.default_prompt or get_prompt("rag:default_assistant")
    base_instructions += f"\n\nCurrent date and time: {date_str}"
    base_instructions += "\n\n" + get_prompt("rag:local_model_disclaimer").format(model=request.model)

    # Use folder system prompt if provided (overrides default)
    if request.folder_id:
        folder = db.get_folder(request.folder_id, user_id)
        if folder and folder.get("system_prompt") is not None and folder["system_prompt"] != "":
            base_instructions = folder["system_prompt"]

    # Custom system prompt override (from /system slash command)
    if request.custom_system_prompt:
        base_instructions = request.custom_system_prompt

    # Inject memory facts
    memory_facts = db.list_memory(user_id)
    memory_section = ""
    if memory_facts:
        facts_text = "\n".join(f"- {m['fact']}" for m in memory_facts)
        memory_section = f"\n\nWhat you know about the user:\n{facts_text}"

    # Inject user profile/preferences
    user_section = ""
    if request.user_context:
        user_section = f"\n\nUser profile:\n{request.user_context}"

    context_block = f"\n\nContext:\n{context_text}" if context_parts else ""

    web_hint = ""
    if not request.web_search:
        web_hint = "\n\n" + get_prompt("rag:web_search_off")

    web_instruction = ""
    if web_sources:
        has_real_content = any(len(r.get("content", "")) > 100 for r in web_sources)
        if has_real_content:
            web_instruction = "\n\n" + get_prompt("rag:web_search_content")
        else:
            web_instruction = "\n\n" + get_prompt("rag:web_search_fallback")

    # Memory tool instructions
    memory_instruction = ""
    if request.auto_memory:
        memory_instruction = "\n\n" + get_prompt("rag:memory_auto")
    else:
        memory_instruction = "\n\n" + get_prompt("rag:memory_manual")

    # Orpheus TTS emotion tag instructions
    emotion_instruction = "\n\n" + get_prompt("rag:orpheus_emotions")

    system_prompt = f"""{base_instructions}{memory_section}{user_section}{' ' + source_instruction if source_instruction else ''}{context_block}{web_instruction}{web_hint}{memory_instruction}{emotion_instruction}

Answer concisely."""

    # Auto-compact if context is getting full
    if request.conversation_id and request.compact_threshold > 0:
        try:
            ctx_limit = 4096
            async with httpx.AsyncClient(timeout=5) as hc:
                r = await hc.post(f"{OLLAMA_BASE_URL}/api/show", json={"model": model})
                info = r.json().get("model_info", {})
                for key in ("context_length", "llama.context_length", "qwen2.context_length"):
                    if key in info:
                        ctx_limit = int(info[key]); break
            # Compact against the context window actually in use (num_ctx), not the
            # model's max - otherwise a 262K-max model never hits the threshold.
            if request.num_ctx > 0:
                ctx_limit = min(ctx_limit, request.num_ctx)
            conv_check = db.get_conversation(request.conversation_id, user_id)
            if conv_check:
                total_chars = sum(len(m["content"]) for m in conv_check["messages"])
                pct = (total_chars // 4) / ctx_limit * 100
                if pct >= request.compact_threshold:
                    logger.info(f"Context at {pct:.1f}% -auto-compacting conversation {request.conversation_id}")
                    yield sse({"type": "status", "step": "compact", "text": "Compacting conversation history…"})
                    history_text = "\n\n".join(
                        f"{m['role'].upper()}: {m['content']}" for m in conv_check["messages"]
                    )
                    await _report_vram("call", model, detail="chat auto-compact")
                    compact_resp = httpx.post(
                        f"{OLLAMA_BASE_URL}/api/chat",
                        json={
                            "model": model,
                            "messages": [
                                {"role": "system", "content": get_prompt("rag:conversation_summarizer")},
                                {"role": "user", "content": f"Summarize this conversation history concisely, preserving all key facts, decisions, and context:\n\n{history_text}"},
                            ],
                            "options": {"temperature": 0.3, "num_predict": 600},
                            "think": False,
                            "stream": False,
                        },
                        timeout=60,
                    )
                    summary = compact_resp.json().get("message", {}).get("content", "").strip()
                    if summary:
                        db.compact_conversation(request.conversation_id, user_id, summary)
                        yield sse({"type": "status", "step": "compact", "text": "History compacted", "done": True})
        except Exception as e:
            logger.warning(f"Auto-compact failed: {e}")

    # Build message history for multi-turn context.
    # Trim by token budget (num_ctx) rather than a fixed message count: walk the
    # conversation newest-first, including messages until we'd exceed the budget
    # left after the system prompt, the new user message, and a reply reserve.
    # Token count is the same ~chars/4 estimate used elsewhere (approximate).
    messages = [{"role": "system", "content": system_prompt}]
    if request.conversation_id and request.num_ctx > 0:
        conv = db.get_conversation(request.conversation_id, user_id)
        if conv:
            reply_reserve = min(2048, request.num_ctx // 4)  # leave room to generate
            used = (len(system_prompt) + len(request.message)) // 4 + reply_reserve
            history = []
            for msg in reversed(conv["messages"]):
                cost = len(msg["content"]) // 4
                if used + cost > request.num_ctx:
                    break
                used += cost
                history.append({"role": msg["role"], "content": msg["content"]})
            messages.extend(reversed(history))
    user_content = request.message
    if request.files:
        file_blocks = []
        for f in request.files:
            try:
                text = extract_file_text(f.name, f.data)
                if len(text) > 50000:
                    text = text[:50000] + f"\n\n[... truncated, {len(text)} total chars ...]"
                file_blocks.append(f"[ATTACHED FILE: {f.name}]\n{text}\n[END FILE]")
            except Exception as e:
                logger.warning(f"Failed to extract text from {f.name}: {e}")
                file_blocks.append(f"[ATTACHED FILE: {f.name}]\n(Could not extract text: {e})\n[END FILE]")
        user_content = "\n\n".join(file_blocks) + "\n\n" + user_content
    user_msg = {"role": "user", "content": user_content}
    if request.images:
        user_msg["images"] = request.images
    messages.append(user_msg)

    logger.info(f"Sending {len(relevant)} vault chunks + {len(web_sources)} web results to LLM ({len(context_text)} chars), {len(messages)} messages in history, {len(request.images)} images")

    # Step 6: Check if model is loaded, show loading indicator if not
    try:
        async with httpx.AsyncClient(timeout=5) as hc:
            ps_resp = await hc.get(f"{OLLAMA_BASE_URL}/api/ps")
            loaded_models = [m.get("name", "") for m in ps_resp.json().get("models", [])]
            model_loaded = any(model in m or m in model for m in loaded_models)
            if not model_loaded:
                yield sse({"type": "status", "step": "loading_model", "text": "Loading language model…"})
    except Exception:
        pass

    # Stream LLM response
    await _report_vram("call", model, detail="chat streaming response")
    ctx_kb = round(len(context_text) / 1024, 1)
    llm_status = f"Thinking through {ctx_kb} KB of context…" if ctx_kb > 0 else "Thinking…"
    yield sse({"type": "status", "step": "llm", "text": llm_status})

    full_answer = ""
    t_llm_start = time.monotonic()
    ttft_ms = None
    try:
        async with httpx.AsyncClient(timeout=None) as hc:
            async with hc.stream(
                "POST",
                f"{OLLAMA_BASE_URL}/api/chat",
                json={
                    "model": model,
                    "messages": messages,
                    "options": {"temperature": request.temperature, "num_ctx": request.num_ctx},
                    "think": False,
                    "stream": True,
                },
            ) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    raise Exception(f"Ollama returned {resp.status_code}: {body.decode()}")
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    chunk = json.loads(line)
                    token = chunk.get("message", {}).get("content", "")
                    if token:
                        if ttft_ms is None:
                            ttft_ms = round((time.monotonic() - t_llm_start) * 1000)
                        full_answer += token
                        yield sse({"type": "token", "text": token})
    except Exception as e:
        logger.error(f"LLM streaming failed: {e}")
        err_str = str(e)
        if "system memory" in err_str or "out of memory" in err_str.lower():
            yield sse({"type": "error", "text": f"Model '{model}' requires more memory than is available. Please select a smaller model in Settings > AI > Default LLM."})
        else:
            yield sse({"type": "error", "text": f"LLM unavailable: {e}"})
        return

    # Step 7: Extract and process memory tool calls
    saved_memories = []
    deleted_memories = []
    clean_answer = full_answer

    # Extract [SAVE_MEMORY: ...] tags
    save_pattern = re.compile(r'\[SAVE_MEMORY:\s*(.+?)\]', re.IGNORECASE)
    for match in save_pattern.finditer(full_answer):
        fact = match.group(1).strip()
        if fact:
            try:
                mid = db.add_memory_fact(fact, user_id)
                saved_memories.append({"id": mid, "fact": fact})
                logger.info(f"Memory saved for {user_id}: {fact}")
            except Exception as e:
                logger.warning(f"Failed to save memory: {e}")
    clean_answer = save_pattern.sub("", clean_answer)

    # Extract [DELETE_MEMORY: ...] tags
    delete_pattern = re.compile(r'\[DELETE_MEMORY:\s*(.+?)\]', re.IGNORECASE)
    for match in delete_pattern.finditer(full_answer):
        fact_text = match.group(1).strip()
        if fact_text:
            # Find matching fact by text similarity
            existing = db.list_memory(user_id)
            for m in existing:
                if fact_text.lower() in m["fact"].lower() or m["fact"].lower() in fact_text.lower():
                    db.delete_memory_fact(m["id"], user_id)
                    deleted_memories.append({"id": m["id"], "fact": m["fact"]})
                    logger.info(f"Memory deleted for {user_id}: {m['fact']}")
                    break
    clean_answer = delete_pattern.sub("", clean_answer)

    # Note: Orpheus TTS emotion tags (<laugh>, <sigh>, etc.) are NOT stripped
    # here. They are persisted to the DB so debug mode can show them after a
    # refresh; the frontend strips them at render time when debug is off.

    # Clean up any leftover whitespace from memory tag removal
    clean_answer = re.sub(r'\n{3,}', '\n\n', clean_answer).strip()

    # Notify frontend of memory changes
    if saved_memories:
        yield sse({"type": "memory_saved", "facts": saved_memories})
    if deleted_memories:
        yield sse({"type": "memory_deleted", "facts": deleted_memories})

    # Step 8: Save to DB
    conv_id = request.conversation_id
    if not conv_id:
        conv_id = db.create_conversation(user_id=user_id, folder_id=request.folder_id)
    db.auto_title(conv_id, user_id, request.message)
    db.add_message(
        conv_id, "user", request.message,
        images=request.images,
        files=[f.dict() for f in request.files],
    )
    db.add_message(conv_id, "assistant", clean_answer, sources=sources, web_sources=web_sources, model_used=model)

    timings["ttft_ms"] = ttft_ms
    timings["total_ms"] = round((time.monotonic() - t_start) * 1000)
    yield sse({
        "type": "done",
        "answer": clean_answer,
        "from_vault": bool(relevant),
        "sources": sources,
        "web_sources": web_sources,
        "web_search_query": web_search_query,
        "model_used": model,
        "conversation_id": conv_id,
        "debug": {**debug, "timings": timings},
    })


# --- Endpoints ---

@app.get("/health")
async def health():
    services = {}
    async with httpx.AsyncClient(timeout=2) as client:
        for name, url in [
            ("ollama", f"{OLLAMA_BASE_URL}/api/tags"),
            ("chromadb", f"http://{os.environ.get('CHROMA_HOST','chromadb')}:{os.environ.get('CHROMA_PORT_INTERNAL','8000')}/api/v2/heartbeat"),
            ("tts", f"{TTS_URL}/docs"),
            ("media-api", f"{os.environ.get('MEDIA_API_URL','http://media-api:8500')}/health"),
        ]:
            try:
                r = await client.get(url)
                services[name] = r.status_code < 400
            except Exception:
                services[name] = False
    return {"status": "ok", "services": services}


def _get_docker_client():
    import docker
    return docker.from_env()


@app.get("/containers")
def list_containers(user: dict = Depends(get_current_user)):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    try:
        from datetime import timezone
        dc = _get_docker_client()
        result = []
        for c in dc.containers.list(all=True):
            started = c.attrs.get("State", {}).get("StartedAt", "")
            uptime = None
            cpu_pct = None
            if c.status == "running":
                if started:
                    started_dt = datetime.fromisoformat(started.replace("Z", "+00:00").split(".")[0] + "+00:00")
                    delta = datetime.now(timezone.utc) - started_dt
                    total = int(delta.total_seconds())
                    h, rem = divmod(total, 3600)
                    m, s = divmod(rem, 60)
                    uptime = f"{h}h {m}m" if h else f"{m}m {s}s"
                try:
                    stats = c.stats(stream=False)
                    cpu_delta = stats["cpu_stats"]["cpu_usage"]["total_usage"] - stats["precpu_stats"]["cpu_usage"]["total_usage"]
                    sys_delta = stats["cpu_stats"]["system_cpu_usage"] - stats["precpu_stats"]["system_cpu_usage"]
                    cpus = stats["cpu_stats"].get("online_cpus", 1)
                    cpu_pct = round((cpu_delta / sys_delta) * cpus * 100, 1) if sys_delta > 0 else 0.0
                except Exception:
                    pass
            result.append({
                "name": c.name,
                "status": c.status,
                "uptime": uptime,
                "cpu": cpu_pct,
            })
        result.sort(key=lambda x: x["name"])
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/apis")
async def list_apis(user: dict = Depends(get_current_user)):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    result = []
    # Tavily
    tavily_ok = False
    if TAVILY_API_KEY:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                r = await client.get("https://api.tavily.com", headers={"Authorization": f"Bearer {TAVILY_API_KEY}"})
                tavily_ok = r.status_code < 500
        except Exception:
            tavily_ok = False
    result.append({"name": "Tavily", "configured": bool(TAVILY_API_KEY), "online": tavily_ok})
    return result


@app.post("/containers/{name}/restart")
def restart_container(name: str, user: dict = Depends(get_current_user)):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    try:
        dc = _get_docker_client()
        c = dc.containers.get(name)
        c.restart()
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/models", response_model=ModelsResponse)
def list_models():
    try:
        client = ollama_client.Client(host=OLLAMA_BASE_URL)
        response = client.list()
        raw_models = response.get("models", []) if isinstance(response, dict) else getattr(response, "models", [])
        names = []
        for m in raw_models:
            name = m.get("model") or m.get("name", "") if isinstance(m, dict) else getattr(m, "model", None) or getattr(m, "name", "")
            if name:
                names.append(name)
        if LLM_MODEL in names:
            names = [LLM_MODEL] + [n for n in names if n != LLM_MODEL]
        return ModelsResponse(models=names, default=LLM_MODEL)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Ollama unavailable: {e}")


@app.get("/models/info")
async def model_info(model: str = None, user: dict = Depends(get_current_user)):
    """Check model capabilities like vision and thinking support."""
    use_model = model or LLM_MODEL
    vision = False
    thinking = False
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.post(f"{OLLAMA_BASE_URL}/api/show", json={"model": use_model})
            data = r.json()
            # Check model families or projector architecture for vision
            families = []
            info = data.get("model_info", {})
            for key, val in info.items():
                if "families" in key.lower() and isinstance(val, list):
                    families.extend(val)
            template = data.get("template", "")
            # Vision models typically have "clip" projector or vision family
            if any("clip" in str(v).lower() for v in info.values()):
                vision = True
            if any(f in families for f in ["clip", "mllama"]):
                vision = True
            # Check for projector-related keys (vision models have these)
            if any("projector" in key.lower() or "vision" in key.lower() for key in info.keys()):
                vision = True
            # Thinking support - check template for think directive or known model families
            model_lower = use_model.lower()
            if "{{- if .Think }}" in template or "{{ if .Think }}" in template:
                thinking = True
            elif any(name in model_lower for name in ["qwen3", "gemma4", "deepseek-r1", "phi4-reasoning", "command-r"]):
                thinking = True
    except Exception as e:
        logger.warning(f"Could not check model info for {use_model}: {e}")
    return {"model": use_model, "vision": vision, "thinking": thinking}


# ── Admin: model registry + pull ─────────────────────────────────────────────
async def _fetch_ollama_library() -> tuple[list[str], Optional[str]]:
    """Scrape ollama.com/library for model names. Returns (models, error)."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.get("https://ollama.com/library", follow_redirects=True)
            if r.status_code != 200:
                return [], f"ollama.com/library returned HTTP {r.status_code}"
            html = r.text
            names = re.findall(r'href="/library/([a-zA-Z0-9._-]+)"', html)
            models = sorted(set(names))
            if not models:
                return [], "No models parsed from registry page (layout may have changed)"
            return models, None
    except httpx.RequestError as e:
        return [], f"Network error reaching ollama.com: {type(e).__name__}"
    except Exception as e:
        logger.exception("Library scrape failed")
        return [], f"Unexpected error: {e}"


async def _fetch_model_tags(model: str) -> tuple[list[str], Optional[str]]:
    """Scrape ollama.com/library/<model>/tags for available tags."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.get(f"https://ollama.com/library/{model}/tags", follow_redirects=True)
            if r.status_code == 404:
                return [], "Model not found"
            if r.status_code != 200:
                return [], f"Tags page returned HTTP {r.status_code}"
            html = r.text
            pattern = rf'href="/library/{re.escape(model)}:([a-zA-Z0-9._-]+)"'
            tags = sorted(set(re.findall(pattern, html)))
            return tags, None
    except httpx.RequestError as e:
        return [], f"Network error: {type(e).__name__}"
    except Exception as e:
        logger.exception(f"Tags scrape failed for {model}")
        return [], str(e)


async def _stream_ollama_pull(model_name: str, session_id: str):
    """Stream a model pull from the Ollama HTTP API and update session state."""
    session = model_pull_sessions.get(session_id)
    if not session:
        return

    def _append_event(event: dict):
        session["events"].append(event)
        # Cap buffer but track how many were dropped so SSE can index correctly.
        if len(session["events"]) > 200:
            drop = len(session["events"]) - 200
            session["events"] = session["events"][drop:]
            session["events_dropped"] = session.get("events_dropped", 0) + drop

    try:
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream(
                "POST",
                f"{OLLAMA_BASE_URL}/api/pull",
                json={"model": model_name, "stream": True},
            ) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    session["status"] = "error"
                    session["error"] = f"Ollama returned HTTP {resp.status_code}: {body.decode('utf-8', errors='ignore')[:200]}"
                    return
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if "error" in event:
                        session["status"] = "error"
                        session["error"] = event["error"]
                        _append_event(event)
                        return
                    _append_event(event)
                    if event.get("status") == "success":
                        session["status"] = "success"
                        return
        # Stream ended without an explicit success or error event - treat as failure
        # so the SSE doesn't hang forever waiting for a terminal status.
        if session["status"] == "pulling":
            session["status"] = "error"
            session["error"] = "Ollama stream closed before reporting success"
    except asyncio.CancelledError:
        if session["status"] == "pulling":
            session["status"] = "cancelled"
            session["error"] = "Cancelled by user"
        raise
    except Exception as e:
        logger.exception(f"Pull failed for {model_name}")
        if session_id in model_pull_sessions:
            model_pull_sessions[session_id]["status"] = "error"
            model_pull_sessions[session_id]["error"] = str(e)
    finally:
        model_pull_tasks.pop(session_id, None)


@app.get("/admin/models/available", response_model=AvailableModelsResponse)
async def list_available_models(user: dict = Depends(require_admin)):
    """Return cached model names scraped from ollama.com/library."""
    now = time.time()
    if (now - _library_cache["fetched_at"]) > LIBRARY_CACHE_TTL or not _library_cache["models"]:
        models, error = await _fetch_ollama_library()
        _library_cache["models"] = models
        _library_cache["error"] = error
        _library_cache["fetched_at"] = now
    return AvailableModelsResponse(
        models=_library_cache["models"],
        ok=bool(_library_cache["models"]),
        error=_library_cache["error"],
    )


@app.get("/admin/models/installed")
async def list_installed_models(user: dict = Depends(require_admin)):
    """List installed Ollama models with size on disk."""
    try:
        client = ollama_client.Client(host=OLLAMA_BASE_URL)
        response = client.list()
        raw_models = response.get("models", []) if isinstance(response, dict) else getattr(response, "models", [])
        models = []
        for m in raw_models:
            if isinstance(m, dict):
                name = m.get("model") or m.get("name", "")
                size = int(m.get("size", 0) or 0)
                modified = m.get("modified_at", "")
            else:
                name = getattr(m, "model", None) or getattr(m, "name", "")
                size = int(getattr(m, "size", 0) or 0)
                modified = getattr(m, "modified_at", "")
            if name:
                models.append({"name": name, "size": size, "modified": str(modified)})
        models.sort(key=lambda x: x["size"], reverse=True)
        return {"models": models}
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Ollama unavailable: {e}")


@app.delete("/admin/models/installed/{model_name:path}")
async def delete_installed_model(model_name: str, user: dict = Depends(require_admin)):
    """Delete an installed Ollama model."""
    if not re.match(r'^[a-zA-Z0-9._/:-]+$', model_name) or len(model_name) > 200:
        raise HTTPException(status_code=400, detail="Invalid model name")
    try:
        client = ollama_client.Client(host=OLLAMA_BASE_URL)
        client.delete(model_name)
        return {"status": "deleted", "model": model_name}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Delete failed: {e}")


@app.get("/admin/models/tags")
async def list_model_tags(model: str, user: dict = Depends(require_admin)):
    """Return cached tags for a base model name, scraped from ollama.com."""
    if not re.match(r'^[a-zA-Z0-9._-]+$', model) or len(model) > 100:
        raise HTTPException(status_code=400, detail="Invalid model name")
    now = time.time()
    cached = _tags_cache.get(model)
    if not cached or (now - cached["fetched_at"]) > TAGS_CACHE_TTL:
        tags, error = await _fetch_model_tags(model)
        _tags_cache[model] = {"tags": tags, "error": error, "fetched_at": now}
        cached = _tags_cache[model]
    return {"model": model, "tags": cached["tags"], "error": cached["error"]}


@app.post("/admin/models/pull", response_model=PullModelResponse)
async def pull_model(req: PullModelRequest, user: dict = Depends(require_admin)):
    """Start an Ollama pull in the background. Returns a session ID for progress."""
    model_name = req.model.strip()
    if not model_name:
        raise HTTPException(status_code=400, detail="Model name is required")
    # Allow alphanumerics, dots, slashes, colons, dashes, underscores - covers
    # registry/namespace/tag forms like "library/llama3:8b".
    if not re.match(r'^[a-zA-Z0-9._/:-]+$', model_name) or len(model_name) > 200:
        raise HTTPException(status_code=400, detail="Invalid model name")
    session_id = secrets.token_hex(8)
    model_pull_sessions[session_id] = {
        "model": model_name,
        "status": "pulling",
        "events": [],
        "events_dropped": 0,
        "error": None,
        "started_at": time.time(),
        "user_id": user["id"],
    }
    task = asyncio.create_task(_stream_ollama_pull(model_name, session_id))
    model_pull_tasks[session_id] = task
    return PullModelResponse(session_id=session_id, model=model_name)


@app.post("/admin/models/pull/{session_id}/cancel")
async def cancel_pull(session_id: str, user: dict = Depends(require_admin)):
    """Cancel an in-flight pull. The download in Ollama may continue briefly
    until it notices our disconnect, but the session is marked cancelled."""
    session = model_pull_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Pull session not found")
    if session["status"] != "pulling":
        return {"status": session["status"], "model": session["model"]}
    task = model_pull_tasks.get(session_id)
    if task and not task.done():
        task.cancel()
    session["status"] = "cancelled"
    session["error"] = "Cancelled by user"
    return {"status": "cancelled", "model": session["model"]}


@app.get("/admin/models/pull-progress/{session_id}")
async def pull_progress(session_id: str, user: dict = Depends(require_admin)):
    """SSE feed for a pull session. Replays buffered events, then tails."""
    if session_id not in model_pull_sessions:
        raise HTTPException(status_code=404, detail="Pull session not found")

    async def gen() -> AsyncGenerator[str, None]:
        sent = 0  # absolute index of next event to forward
        while True:
            session = model_pull_sessions.get(session_id)
            if not session:
                yield f"data: {json.dumps({'type': 'error', 'message': 'Session lost'})}\n\n"
                return
            events = session["events"]
            dropped = session.get("events_dropped", 0)
            # Buffer covers absolute indices [dropped, dropped + len(events)).
            # Skip ahead past anything that's been evicted.
            local = max(0, sent - dropped)
            while local < len(events):
                yield f"data: {json.dumps({'type': 'event', 'event': events[local]})}\n\n"
                local += 1
                sent = dropped + local
            if session["status"] in ("success", "error", "cancelled"):
                yield f"data: {json.dumps({'type': 'done', 'status': session['status'], 'error': session.get('error')})}\n\n"
                return
            await asyncio.sleep(0.4)

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/context-info")
async def context_info(model: str = None, conversation_id: str = None, num_ctx: int = 0, user: dict = Depends(get_current_user)):
    use_model = model or LLM_MODEL
    ctx_limit = 4096
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.post(f"{OLLAMA_BASE_URL}/api/show", json={"model": use_model})
            info = r.json().get("model_info", {})
            for key in ("context_length", "llama.context_length", "qwen2.context_length"):
                if key in info:
                    ctx_limit = int(info[key])
                    break
    except Exception:
        pass
    # Report usage against the context window actually in use (num_ctx) when the
    # client supplies it, not the model's max - otherwise a 262K-max model always
    # reads ~0%.
    if num_ctx > 0:
        ctx_limit = min(ctx_limit, num_ctx)

    tokens_used = 0
    if conversation_id:
        conv = db.get_conversation(conversation_id, user["id"])
        if conv:
            for msg in conv["messages"]:
                tokens_used += len(msg["content"]) // 4

    return {
        "context_limit": ctx_limit,
        "tokens_used": tokens_used,
        "percent": round(tokens_used / ctx_limit * 100, 1) if ctx_limit else 0,
    }


@app.post("/chat")
async def chat(request: ChatRequest, user: dict = Depends(get_current_user)):
    if await _gpu_busy_for_gen():
        raise HTTPException(status_code=503, detail="GPU is busy with media generation, please wait")
    if not request.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    return StreamingResponse(
        chat_stream(request, user["id"]),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class ExtractMemoryRequest(BaseModel):
    text: str  # The AI message text to extract a memory from

@app.post("/chat/extract-memory")
async def extract_memory(request: ExtractMemoryRequest, user: dict = Depends(get_current_user)):
    """Use the LLM to extract a memory-worthy fact from an AI response, then save it."""
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    model = LLM_MODEL
    try:
        resp = httpx.post(
            f"{OLLAMA_BASE_URL}/api/chat",
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": get_prompt("rag:memory_fact_extractor")},
                    {"role": "user", "content": request.text},
                ],
                "options": {"temperature": 0.1, "num_predict": 100},
                "think": False,
                "stream": False,
            },
            timeout=30,
        )
        fact = resp.json().get("message", {}).get("content", "").strip()
        if not fact or fact.upper() == "NOTHING":
            return {"saved": False, "reason": "Nothing worth remembering in this message."}

        mid = db.add_memory_fact(fact, user["id"])
        return {"saved": True, "id": mid, "fact": fact}
    except Exception as e:
        logger.error(f"Extract memory failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/index", response_model=IndexResponse)
async def trigger_reindex(user: dict = Depends(get_current_user)):
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, index_vault, VAULT_PATH, user["id"], EMBED_MODEL, OLLAMA_BASE_URL)
    return IndexResponse(**result)


@app.get("/index/status")
async def index_status(user: dict = Depends(get_current_user)):
    return _get_index_status(user["id"])


@app.get("/index/stream")
async def stream_reindex(user: dict = Depends(get_current_user)):
    """SSE endpoint that streams per-file progress during indexing."""
    import queue as queue_mod
    q: queue_mod.Queue = queue_mod.Queue()

    def progress_cb(done: int, total: int, filename: str):
        q.put({"done": done, "total": total, "file": filename})

    def run():
        try:
            result = index_vault(VAULT_PATH, user["id"], EMBED_MODEL, OLLAMA_BASE_URL, progress_cb=progress_cb, username=user["username"])
            q.put({"complete": True,
                   "new": result["files_processed"],
                   "skipped": result.get("files_skipped", 0),
                   "chunks": result["chunks_upserted"],
                   "errors": result["errors"]})
        except Exception as e:
            q.put({"error": str(e)})

    import threading
    threading.Thread(target=run, daemon=True).start()

    async def event_stream():
        loop = asyncio.get_event_loop()
        while True:
            try:
                msg = await loop.run_in_executor(None, lambda: q.get(timeout=120))
                yield f"data: {json.dumps(msg)}\n\n"
                if msg.get("complete") or msg.get("error"):
                    break
            except Exception:
                break

    return StreamingResponse(event_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/suggestions")
async def get_suggestions(model: str = None, vault: str = None, name: str = None, hour: int = None, user: dict = Depends(get_current_user)):
    if await _gpu_busy_for_gen():
        return {"suggestions": []}
    use_model = model or LLM_MODEL
    user_id = user["id"]
    use_vault = vault == "1"
    user_name = name or ""

    # Build the prompt based on whether vault mode is active
    if use_vault:
        # Vault mode - generate suggestions based on actual vault content
        collection_name = f"vault_{user_id.replace('-', '')}"
        sample_text = ""
        try:
            chroma_client = get_chroma_client()
            collection = chroma_client.get_collection(collection_name)
            count = collection.count()
            if count == 0:
                return {"suggestions": []}
            result = collection.get(
                include=["documents", "metadatas"],
                limit=min(10, count),
            )
            docs = result.get("documents", [])
            metas = result.get("metadatas", [])
            snippets = []
            for doc, meta in zip(docs, metas):
                source = meta.get("source", "unknown") if meta else "unknown"
                snippet = doc[:300] if doc else ""
                if snippet:
                    snippets.append(f"[From: {source}]\n{snippet}")
            sample_text = "\n\n".join(snippets[:8])
        except Exception as e:
            logger.warning(f"suggestions: failed to sample vault: {e}")
            return {"suggestions": []}
        if not sample_text:
            return {"suggestions": []}
        prompt = f"Here are excerpts from a user's personal document vault:\n\n{sample_text}\n\n{get_prompt('rag:suggestions_vault')}"
    else:
        # General mode - generate diverse, interesting conversation starters
        memory_facts = db.list_memory(user_id)
        memory_ctx = ""
        if memory_facts:
            facts = [f["fact"] for f in memory_facts[:10]]
            memory_ctx = f"\n\nHere are some things I know about this user:\n" + "\n".join(f"- {f}" for f in facts)
        prompt = f"{get_prompt('rag:suggestions_general')}{memory_ctx}"

    try:
        import re as _re
        all_suggestions = []
        for attempt in range(3):
            if len(all_suggestions) >= 4:
                break
            need = 4 - len(all_suggestions)
            attempt_prompt = prompt.replace("exactly 4", f"exactly {need}") if need < 4 else prompt
            ollama_resp = httpx.post(
                f"{OLLAMA_BASE_URL}/api/chat",
                json={
                    "model": use_model,
                    "messages": [
                        {"role": "system", "content": "/no_think\nYou output ONLY what is asked. No reasoning. No preamble."},
                        {"role": "user", "content": attempt_prompt},
                        {"role": "assistant", "content": "<think>\n\n</think>\n1."},
                    ],
                    "options": {"temperature": 0.9, "num_predict": 500},
                    "think": False,
                    "stream": False,
                },
                timeout=60,
            )
            ollama_resp.raise_for_status()
            data = ollama_resp.json()
            raw = data.get("message", {}).get("content", "")
            logger.info(f"suggestions attempt {attempt + 1} raw: {raw[:400]}")
            cleaned = _re.sub(r"<think>[\s\S]*?</think>", "", raw, flags=_re.IGNORECASE).strip()
            if "?" not in cleaned and "." not in cleaned:
                continue
            lines = [line.strip().lstrip("-\u2022*0123456789.) ") for line in cleaned.splitlines() if line.strip()]
            parsed = [s for s in lines if len(s) > 10 and len(s) < 120 and (s.endswith("?") or s.endswith("."))]
            # Deduplicate against what we already have
            existing = set(s.lower() for s in all_suggestions)
            for s in parsed:
                if s.lower() not in existing and len(all_suggestions) < 4:
                    all_suggestions.append(s)
                    existing.add(s.lower())
        if not all_suggestions:
            raise ValueError("no suggestions parsed after retries")

        # Generate a dynamic greeting and tagline
        greeting = ""
        tagline = ""
        try:
            h = hour if hour is not None else datetime.now().hour
            time_of_day = "morning" if h < 12 else "afternoon" if h < 17 else "evening"
            logger.info(f"greeting: hour={h} (from_client={hour is not None}), time_of_day={time_of_day}, name={user_name}")
            name_part = f"The user's name is {user_name}. " if user_name else ""
            greet_prompt = (
                f"It is {time_of_day} right now. {name_part}"
                f"The greeting MUST be appropriate for {time_of_day}. Be original - do NOT copy any examples. "
                f"{get_prompt('rag:greeting')}"
            )
            greet_resp = httpx.post(
                f"{OLLAMA_BASE_URL}/api/chat",
                json={
                    "model": use_model,
                    "messages": [
                        {"role": "system", "content": f"/no_think\nYou output ONLY what is asked. It is currently {time_of_day}. Do NOT use greetings from other times of day."},
                        {"role": "user", "content": greet_prompt},
                    ],
                    "options": {"temperature": 1.0, "num_predict": 100},
                    "think": False,
                    "stream": False,
                },
                timeout=30,
            )
            greet_resp.raise_for_status()
            greet_raw = greet_resp.json().get("message", {}).get("content", "")
            greet_cleaned = _re.sub(r"<think>[\s\S]*?</think>", "", greet_raw, flags=_re.IGNORECASE).strip()
            # Normalize: strip surrounding quotes, replace em/en dashes with
            # plain hyphens (the LLM occasionally ignores the prompt rule),
            # then truncate at a word boundary so we never cut mid-word.
            def _norm_greet(s: str) -> str:
                s = s.strip().strip('"').strip("'").strip()
                return s.replace("\u2014", "-").replace("\u2013", "-")
            def _trim_words(s: str, n: int) -> str:
                if len(s) <= n:
                    return s
                cut = s[:n].rsplit(" ", 1)[0].rstrip(",;:-.")
                return cut
            greet_lines = [_norm_greet(l) for l in greet_cleaned.splitlines() if l.strip()]
            if greet_lines:
                greeting = _trim_words(greet_lines[0], 48)
            if len(greet_lines) > 1:
                tagline = _trim_words(greet_lines[1], 70)
        except Exception as e:
            logger.warning(f"greeting generation failed: {e}")

        result = {"suggestions": all_suggestions[:4]}
        if greeting:
            result["greeting"] = greeting
        if tagline:
            result["tagline"] = tagline
        return result
    except Exception as e:
        logger.warning(f"suggestions failed: {e}")
        return {"suggestions": []}


@app.get("/search")
async def search_proxy(q: str, user: dict = Depends(get_current_user)):
    results = await web_search(q)
    return {"results": results}


# --- Auth endpoints (public) ---

@app.get("/auth/status")
def auth_status():
    return {"has_users": db.has_users()}


@app.get("/auth/brand")
def auth_brand():
    """Public endpoint -returns admin's brand settings for the login screen."""
    for user in db.list_users():
        if user.get("role") == "admin":
            try:
                s = json.loads(user.get("settings") or "{}")
                b = json.loads(s.get("wooz_brand") or "{}")
                return {
                    "name":            b.get("name", ""),
                    "logo":            s.get("wooz_logo", ""),
                    "login_logo":      s.get("wooz_login_logo", ""),
                    "theme":           b.get("theme", ""),
                    "accent":          b.get("accent", ""),
                    "show_login_name": b.get("showLoginName", True),
                }
            except Exception:
                break
    return {"name": "", "logo": "", "theme": "", "accent": ""}


@app.post("/auth/login")
def auth_login(body: LoginRequest):
    user = db.get_user_by_username(body.username)
    if not user or not user["is_active"]:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not pwd_ctx.verify(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = db.create_session(user["id"])
    return {
        "token": token,
        "user": {
            "id": user["id"],
            "username": user["username"],
            "role": user["role"],
            "settings": user["settings"],
        },
    }


# --- Auth endpoints (require login) ---

@app.post("/auth/logout")
def auth_logout(request: Request, user: dict = Depends(get_current_user)):
    token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    if token:
        db.delete_session(token)
    return {"ok": True}


@app.get("/auth/me")
def auth_me(user: dict = Depends(get_current_user)):
    return {
        "id": user["id"],
        "username": user["username"],
        "role": user["role"],
        "settings": user["settings"],
    }


@app.put("/auth/me/password")
def change_own_password(body: ChangePasswordRequest, user: dict = Depends(get_current_user)):
    if not pwd_ctx.verify(body.current_password, user["password_hash"]):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    if len(body.new_password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    db.update_user_password(user["id"], pwd_ctx.hash(body.new_password))
    return {"ok": True}


@app.put("/users/me/settings")
def update_own_settings(body: UserSettingsRequest, user: dict = Depends(get_current_user)):
    db.update_user_settings(user["id"], body.settings)
    return {"ok": True}


@app.delete("/users/me")
def delete_own_account(user: dict = Depends(get_current_user)):
    db.delete_user(user["id"])
    return {"ok": True}


@app.delete("/users/me/data")
def delete_own_data(user: dict = Depends(get_current_user)):
    """Delete all conversations, folders, and memory for the current user (keeps account)."""
    db.delete_all_user_data(user["id"])
    return {"ok": True}


# --- Admin endpoints ---

@app.get("/admin/users")
def admin_list_users(admin: dict = Depends(require_admin)):
    return db.list_users()


@app.post("/admin/users")
def admin_create_user(body: AdminCreateUserRequest, request: Request):
    # If no users exist yet, always create as admin (bootstrap)
    if not db.has_users():
        role = "admin"
    else:
        # Require admin auth for subsequent users
        token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if not token:
            raise HTTPException(status_code=401, detail="Unauthorized")
        session = db.get_session(token)
        if not session:
            raise HTTPException(status_code=401, detail="Unauthorized")
        caller = db.get_user_by_id(session["user_id"])
        if not caller or caller["role"] != "admin":
            raise HTTPException(status_code=403, detail="Forbidden")
        role = body.role if body.role in ("admin", "user") else "user"

    if not body.username.strip():
        raise HTTPException(status_code=400, detail="Username cannot be empty")
    if len(body.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    uid = db.create_user(body.username.strip(), pwd_ctx.hash(body.password), role)
    return {"id": uid, "username": body.username.strip(), "role": role}


@app.patch("/admin/users/{uid}")
def admin_patch_user(uid: str, body: AdminPatchUserRequest, admin: dict = Depends(require_admin)):
    if uid == admin["id"] and body.is_active is False:
        raise HTTPException(status_code=400, detail="Cannot disable your own account")
    if body.role is not None:
        if body.role not in ("admin", "user"):
            raise HTTPException(status_code=400, detail="Role must be 'admin' or 'user'")
        db.update_user_role(uid, body.role)
    if body.is_active is not None:
        db.update_user_active(uid, body.is_active)
    return {"ok": True}


@app.put("/admin/users/{uid}/password")
def admin_set_password(uid: str, body: AdminSetPasswordRequest, admin: dict = Depends(require_admin)):
    if len(body.new_password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    db.update_user_password(uid, pwd_ctx.hash(body.new_password))
    return {"ok": True}


@app.delete("/admin/users/{uid}")
def admin_delete_user(uid: str, admin: dict = Depends(require_admin)):
    if uid == admin["id"]:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")
    db.delete_user(uid)
    return {"ok": True}


# --- Prompt template endpoints ---

class PromptUpdateRequest(BaseModel):
    content: str

@app.get("/prompts")
def list_prompts(service: str = None):
    """Return all 37 prompt templates with metadata, defaults, and overrides."""
    overrides = {r["key"]: r["content"] for r in db.list_prompt_overrides(service)}
    result = []
    for key, meta in PROMPT_REGISTRY.items():
        if service and meta["service"] != service:
            continue
        _, short_key = key.split(":", 1)
        if meta["service"] == "rag":
            default = PROMPTS.get(short_key, "")
        else:
            default = MEDIA_PROMPT_DEFAULTS.get(short_key, "")
        override = overrides.get(key)
        result.append({
            "key": key,
            "service": meta["service"],
            "label": meta["label"],
            "category": meta["category"],
            "description": meta["description"],
            "default": default,
            "content": override if override is not None else default,
            "modified": override is not None,
        })
    return result

MEDIA_API_URL = os.environ.get("MEDIA_API_URL", "http://media-api:8500")

def _fire_notify_media():
    """Fire-and-forget: tell media-api to refresh its prompt cache (thread-safe)."""
    import threading
    def _do():
        try:
            import httpx as _hx
            _hx.post(f"{MEDIA_API_URL}/prompts/refresh", timeout=3.0)
        except Exception:
            pass
    threading.Thread(target=_do, daemon=True).start()

@app.put("/admin/prompts/{key:path}")
def admin_update_prompt(key: str, body: PromptUpdateRequest, admin: dict = Depends(require_admin)):
    if key not in PROMPT_REGISTRY:
        raise HTTPException(status_code=404, detail="Unknown prompt key")
    meta = PROMPT_REGISTRY[key]
    db.upsert_prompt_override(key, meta["service"], body.content, admin["id"])
    _invalidate_prompt_cache()
    _fire_notify_media()
    return {"ok": True}

@app.delete("/admin/prompts")
def admin_reset_all_prompts(admin: dict = Depends(require_admin)):
    db.delete_all_prompt_overrides()
    _invalidate_prompt_cache()
    _fire_notify_media()
    return {"ok": True}

@app.delete("/admin/prompts/{key:path}")
def admin_reset_prompt(key: str, admin: dict = Depends(require_admin)):
    if key not in PROMPT_REGISTRY:
        raise HTTPException(status_code=404, detail="Unknown prompt key")
    db.delete_prompt_override(key)
    _invalidate_prompt_cache()
    _fire_notify_media()
    return {"ok": True}


# --- TTS endpoints ---

@app.get("/tts/voices")
def tts_voices():
    return {
        "voices": TTS_VOICES,
        "languages": TTS_VOICES_BY_LANG,
        "default": DEFAULT_VOICE,
    }


_TTS_EMOTION_TAGS = {
    "laugh", "chuckle", "sigh", "gasp", "yawn",
    "groan", "cough", "sniffle", "giggle",
}

# Emoji / pictograph ranges that Orpheus renders as "uh" artifacts. Ranges
# chosen to avoid CJK ideographs (U+4E00-U+9FFF) and hangul (U+AC00-U+D7AF)
# used by the mandarin/korean voices.
_TTS_EMOJI_RE = re.compile(
    "["
    "\U0001F300-\U0001F6FF"
    "\U0001F900-\U0001FAFF"
    "\U0001F1E0-\U0001F1FF"
    "\U00002600-\U000026FF"
    "\U00002700-\U000027BF"
    "]",
    flags=re.UNICODE,
)

def _sanitize_for_tts(text: str) -> str:
    """Strip markdown, code, and special characters Orpheus would otherwise
    read out literally ("asterisk", "hash", "backtick"). Preserves inline
    emotion tags like <laugh> so Orpheus still renders them."""
    if not text:
        return text
    # Emojis become "uh" noise; ellipses produce an awkward pause where a
    # comma-pause sounds more natural in conversational speech.
    text = _TTS_EMOJI_RE.sub(" ", text)
    text = re.sub(r"\.{3,}", ", ", text)
    # Fenced code blocks and inline code - skip entirely.
    text = re.sub(r"```[\s\S]*?```", " ", text)
    text = re.sub(r"`[^`]*`", " ", text)
    # Images: ![alt](url) -> alt
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)
    # Links: [label](url) -> label
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    # Bold / italic / strikethrough markers.
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"__([^_]+)__", r"\1", text)
    text = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"\1", text)
    text = re.sub(r"(?<!_)_([^_\n]+)_(?!_)", r"\1", text)
    text = re.sub(r"~~([^~]+)~~", r"\1", text)
    # Headings, blockquotes, list bullets at line starts.
    text = re.sub(r"^[ \t]*#{1,6}[ \t]*", "", text, flags=re.MULTILINE)
    text = re.sub(r"^[ \t]*>[ \t]?", "", text, flags=re.MULTILINE)
    text = re.sub(r"^[ \t]*[-*+][ \t]+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^[ \t]*\d+\.[ \t]+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^[ \t]*[-=_]{3,}[ \t]*$", "", text, flags=re.MULTILINE)
    # HTML tags except Orpheus emotion tags.
    def _keep_emotion(m):
        tag = m.group(1).lower()
        return m.group(0) if tag in _TTS_EMOTION_TAGS else " "
    text = re.sub(r"<(/?[a-zA-Z][a-zA-Z0-9_-]*)[^>]*>", _keep_emotion, text)
    # Stray markdown / symbol characters Orpheus reads literally.
    text = re.sub(r"[*_`~#|\\]", " ", text)
    text = re.sub(r"[\(\)\[\]\{\}]", " ", text)
    # Collapse whitespace. Orpheus was trained on single-paragraph prompts
    # and silently drops or reorders content when it encounters paragraph
    # breaks ("\n\n"). Flatten all newlines into spaces so it sees one
    # continuous block; sentence-terminal punctuation is preserved so
    # prosody boundaries remain intact. If a line didn't end in a
    # terminator, add a period so two run-on clauses don't get mashed.
    lines = [ln.strip() for ln in text.splitlines()]
    lines = [ln for ln in lines if ln]
    joined = []
    for ln in lines:
        if joined and not re.search(r"[.!?,:;]$", joined[-1]):
            joined[-1] = joined[-1] + "."
        joined.append(ln)
    text = " ".join(joined)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


@app.get("/tts")
async def tts_proxy(
    text: str,
    voice: str = DEFAULT_VOICE,
    temperature: Optional[float] = None,
    top_p: Optional[float] = None,
):
    """Stream raw int16 PCM from tts-api to the browser as it's decoded.

    Output is 24 kHz mono int16 little-endian PCM (no WAV header). The
    frontend player converts to float32 and schedules AudioBufferSourceNodes
    back-to-back. Forwarding is chunked so first audio arrives within
    ~300 ms of the request rather than after full-sentence synthesis.
    """
    if not text.strip():
        raise HTTPException(status_code=400, detail="text is required")
    if voice not in TTS_VOICES:
        voice = DEFAULT_VOICE

    # Scrub markdown / code / symbols that Orpheus would read out literally.
    text = _sanitize_for_tts(text)
    if not text:
        raise HTTPException(status_code=400, detail="text is empty after sanitization")

    # Apply per-voice sampling defaults when the client doesn't override.
    voice_defaults = TTS_VOICE_DEFAULTS.get(voice, {})
    if temperature is None:
        temperature = voice_defaults.get("temperature")
    if top_p is None:
        top_p = voice_defaults.get("top_p")

    payload = {"model": "orpheus", "input": text, "voice": voice}
    if temperature is not None:
        payload["temperature"] = temperature
    if top_p is not None:
        payload["top_p"] = top_p

    # Open the upstream stream eagerly so we can see the status code BEFORE
    # committing to a StreamingResponse. tts-api now returns 409 when the
    # active chat LLM leaves no VRAM headroom for Orpheus; we propagate
    # that unchanged so the UI can surface a clear error toast.
    client = httpx.AsyncClient(timeout=None)
    try:
        stream_cm = client.stream(
            "POST", f"{TTS_URL}/v1/audio/speech/stream", json=payload
        )
        resp = await stream_cm.__aenter__()
    except Exception as e:
        await client.aclose()
        logger.warning(f"TTS upstream connect failed: {e}")
        raise HTTPException(status_code=503, detail=f"tts upstream unreachable: {e}")

    if resp.status_code != 200:
        try:
            body = await resp.aread()
            detail = "TTS unavailable"
            try:
                detail = json.loads(body.decode("utf-8")).get("detail", detail)
            except Exception:
                pass
        finally:
            await stream_cm.__aexit__(None, None, None)
            await client.aclose()
        raise HTTPException(status_code=resp.status_code, detail=detail)

    async def forward():
        try:
            async for chunk in resp.aiter_bytes():
                if chunk:
                    yield chunk
        except Exception as e:
            logger.warning(f"TTS stream failed mid-flight: {e}")
        finally:
            try:
                await stream_cm.__aexit__(None, None, None)
            except Exception:
                pass
            await client.aclose()

    return StreamingResponse(
        forward(),
        media_type="application/octet-stream",
        headers={
            "X-Sample-Rate": "24000",
            "X-Channels": "1",
            "X-Sample-Format": "s16le",
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
        },
    )


# --- Folder endpoints ---

@app.get("/folders")
def list_folders(user: dict = Depends(get_current_user)):
    return db.list_folders(user["id"])

@app.post("/folders")
def create_folder(body: FolderCreate, user: dict = Depends(get_current_user)):
    pid = db.create_folder(user["id"], body.name, body.description, body.system_prompt)
    return db.get_folder(pid, user["id"]) or {"id": pid}

@app.patch("/folders/{pid}")
def update_folder(pid: str, body: FolderPatch, user: dict = Depends(get_current_user)):
    db.update_folder(pid, user["id"], body.name, body.description, body.system_prompt)
    return {"ok": True}

@app.delete("/folders/{pid}")
def delete_folder(pid: str, user: dict = Depends(get_current_user)):
    db.delete_folder(pid, user["id"])
    return {"ok": True}


# --- Memory endpoints ---

@app.get("/memory")
def list_memory(user: dict = Depends(get_current_user)):
    return db.list_memory(user["id"])

@app.post("/memory")
def add_memory(body: MemoryFactCreate, user: dict = Depends(get_current_user)):
    mid = db.add_memory_fact(body.fact, user["id"])
    return {"id": mid}

@app.delete("/memory/{mid}")
def delete_memory(mid: str, user: dict = Depends(get_current_user)):
    db.delete_memory_fact(mid, user["id"])
    return {"ok": True}


# --- Conversation endpoints ---

@app.get("/conversations/search")
def search_convs(q: str = "", user: dict = Depends(get_current_user)):
    if not q.strip():
        return []
    return db.search_conversations(q, user["id"])


@app.get("/conversations")
def list_convs(user: dict = Depends(get_current_user)):
    return db.list_conversations(user["id"])


@app.post("/conversations")
def create_conv(folder_id: Optional[str] = None, user: dict = Depends(get_current_user)):
    cid = db.create_conversation(user_id=user["id"], folder_id=folder_id)
    return {"id": cid}


@app.get("/conversations/{cid}")
def get_conv(cid: str, user: dict = Depends(get_current_user)):
    conv = db.get_conversation(cid, user["id"])
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


@app.delete("/conversations/{cid}")
def delete_conv(cid: str, user: dict = Depends(get_current_user)):
    db.delete_conversation(cid, user["id"])
    return {"ok": True}


@app.patch("/conversations/{cid}")
def rename_conv(cid: str, body: ConversationPatch, user: dict = Depends(get_current_user)):
    db.rename_conversation(cid, user["id"], body.title)
    return {"ok": True}


@app.patch("/conversations/{cid}/move")
def move_conv(cid: str, body: ConversationMove, user: dict = Depends(get_current_user)):
    db.move_conversation(cid, user["id"], body.folder_id)
    return {"ok": True}


@app.post("/conversations/{cid}/smart-title")
async def smart_title_conv(cid: str, user: dict = Depends(get_current_user)):
    """Generate a concise LLM-based title for a conversation from its first messages."""
    conv = db.get_conversation(cid, user["id"])
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # Gather first few messages for context
    msgs = conv.get("messages", [])
    context_parts = []
    for m in msgs[:4]:
        role = m.get("role", "user")
        content = m.get("content", "")[:300]
        context_parts.append(f"{role}: {content}")
    context = "\n".join(context_parts)
    if not context.strip():
        return {"title": conv.get("title", "New Chat")}

    try:
        settings = {}
        try:
            settings = json.loads(user.get("settings") or "{}")
        except Exception:
            pass
        model = settings.get("wooz_model") or LLM_MODEL
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{OLLAMA_BASE_URL}/api/generate",
                json={
                    "model": model,
                    "system": get_prompt("rag:title_generator"),
                    "prompt": context,
                    "stream": False,
                    "think": False,
                    "options": {"temperature": 0.5, "num_predict": 20},
                },
            )
            resp.raise_for_status()
            raw = resp.json().get("response", "").strip()
        title = raw.strip('"').strip("'").strip().split("\n")[0].strip()[:80]

        if title:
            db.rename_conversation(cid, user["id"], title)
            return {"title": title}
    except Exception as e:
        logger.warning(f"Smart title generation failed: {e}")

    return {"title": conv.get("title", "New Chat")}


@app.post("/conversations/{cid}/compact")
async def compact_conv(cid: str, user: dict = Depends(get_current_user)):
    """Summarize all messages and replace them with a compact summary."""
    conv = db.get_conversation(cid, user["id"])
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    msgs = conv.get("messages", [])
    if len(msgs) < 2:
        raise HTTPException(status_code=400, detail="Not enough messages to compact")

    history_text = "\n\n".join(f"{m['role'].upper()}: {m['content']}" for m in msgs)

    # Use the user's preferred model or fallback to default
    settings = {}
    try:
        settings = json.loads(user.get("settings") or "{}")
    except Exception:
        pass
    model = settings.get("wooz_model") or LLM_MODEL

    try:
        await _report_vram("call", model, detail="conversation compact")
        resp = httpx.post(
            f"{OLLAMA_BASE_URL}/api/chat",
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": get_prompt("rag:conversation_summarizer")},
                    {"role": "user", "content": f"Summarize this conversation:\n\n{history_text}"},
                ],
                "think": False,
                "stream": False,
            },
            timeout=60,
        )
        summary = resp.json().get("message", {}).get("content", "").strip()
        if not summary:
            raise HTTPException(status_code=500, detail="LLM returned empty summary")
        db.compact_conversation(cid, user["id"], summary)
        return {"summary": summary}
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"Conversation compact failed: {e}")
        raise HTTPException(status_code=500, detail=f"Compact failed: {e}")


# --- Vault file management endpoints ---

def _read_index_meta(user_id: str) -> dict:
    meta_path = Path(DB_DIR) / f"index_meta_{user_id}.json"
    try:
        return json.loads(meta_path.read_text())
    except Exception:
        return {"last_indexed": None, "files_processed": 0, "chunks_upserted": 0, "errors": []}


def _get_chunk_counts(user_id: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    try:
        chroma_client = get_chroma_client()
        collection = chroma_client.get_collection(collection_name_for_user(user_id))
        result = collection.get(include=["metadatas"])
        for meta in result.get("metadatas", []):
            src = meta.get("source", "")
            if src:
                counts[src] = counts.get(src, 0) + 1
    except Exception as e:
        logger.warning(f"Could not read chunk counts: {e}")
    return counts


@app.get("/vault/files")
def list_vault_files(user: dict = Depends(get_current_user)):
    vault = user_vault_path(user["username"])
    if not vault.exists():
        raise HTTPException(status_code=503, detail="Vault path not found")

    supported = {".md", ".txt", ".pdf"}
    chunk_counts = _get_chunk_counts(user["id"])
    meta = _read_index_meta(user["id"])

    files = []
    folders = []
    for item in sorted(vault.rglob("*")):
        if item.is_file() and item.suffix.lower() in supported:
            rel = item.relative_to(vault)
            stat = item.stat()
            files.append({
                "name": item.name,
                "path": str(rel).replace("\\", "/"),
                "size_bytes": stat.st_size,
                "modified_at": datetime.utcfromtimestamp(stat.st_mtime).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "chunk_count": chunk_counts.get(item.name, 0),
            })
        elif item.is_dir():
            rel = item.relative_to(vault)
            folders.append(str(rel).replace("\\", "/"))

    return {
        "files": files,
        "folders": folders,
        "last_indexed": meta.get("last_indexed"),
        "files_processed": meta.get("files_processed", 0),
        "chunks_upserted": meta.get("chunks_upserted", 0),
    }


@app.post("/vault/upload")
async def upload_vault_file(
    file: UploadFile = File(...),
    subfolder: str = Form(""),
    user: dict = Depends(get_current_user),
):
    suffix = Path(file.filename).suffix.lower()
    if suffix not in SUPPORTED_UPLOAD_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {suffix}")

    vault = user_vault_path(user["username"])
    safe_sub = Path(subfolder.strip("/").strip()) if subfolder.strip() else Path("")
    for part in safe_sub.parts:
        if part in (".", ".."):
            raise HTTPException(status_code=400, detail="Invalid subfolder path")

    dest_dir = vault / safe_sub
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / file.filename

    with dest.open("wb") as out:
        shutil.copyfileobj(file.file, out)

    # Trigger immediate background index (no watcher debounce)
    import threading
    user_id, uname = user["id"], user["username"]
    _set_index_status(user_id, running=False, queued=True)
    def _bg():
        _set_index_status(user_id, running=True, queued=False)
        try:
            index_vault(VAULT_PATH, user_id, EMBED_MODEL, OLLAMA_BASE_URL, username=uname)
        except Exception as e:
            logger.warning(f"Post-upload index failed: {e}")
        finally:
            _set_index_status(user_id, running=False)
    threading.Thread(target=_bg, daemon=True).start()

    return {"ok": True, "path": str((safe_sub / file.filename)).replace("\\", "/")}


@app.delete("/vault/files")
def delete_vault_file(body: VaultDeleteRequest, user: dict = Depends(get_current_user)):
    vault = user_vault_path(user["username"])
    target = (vault / body.path).resolve()
    try:
        vault_resolved = vault.resolve()
        target.relative_to(vault_resolved)
    except ValueError:
        raise HTTPException(status_code=400, detail="Path outside vault")

    if not target.exists():
        raise HTTPException(status_code=404, detail="File not found")
    if not target.is_file():
        raise HTTPException(status_code=400, detail="Not a file")

    target.unlink()
    return {"ok": True}


@app.post("/vault/rename")
def rename_vault_file(body: VaultRenameRequest, user: dict = Depends(get_current_user)):
    vault = user_vault_path(user["username"])
    target = (vault / body.path).resolve()
    try:
        target.relative_to(vault.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Path outside vault")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    new_name = Path(body.new_name).name
    dest = target.parent / new_name
    if dest.exists() and dest.resolve() != target.resolve():
        raise HTTPException(status_code=409, detail="File already exists")
    target.rename(dest)
    return {"ok": True, "path": str(dest.relative_to(vault.resolve()))}


@app.post("/vault/folder")
def create_vault_folder(body: VaultFolderRequest, user: dict = Depends(get_current_user)):
    vault = user_vault_path(user["username"])
    safe = Path(body.folder.strip("/").strip())
    for part in safe.parts:
        if part in (".", ".."):
            raise HTTPException(status_code=400, detail="Invalid folder path")
    target = (vault / safe).resolve()
    try:
        target.relative_to(vault.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Path outside vault")
    target.mkdir(parents=True, exist_ok=True)
    return {"ok": True}


@app.delete("/vault/folder")
def delete_vault_folder(body: VaultFolderRequest, user: dict = Depends(get_current_user)):
    vault = user_vault_path(user["username"])
    safe = Path(body.folder.strip("/").strip())
    target = (vault / safe).resolve()
    try:
        target.relative_to(vault.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Path outside vault")
    if not target.exists():
        raise HTTPException(status_code=404, detail="Folder not found")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="Not a folder")
    shutil.rmtree(target)
    return {"ok": True}


@app.post("/vault/move")
def move_vault_file(body: VaultMoveRequest, user: dict = Depends(get_current_user)):
    vault = user_vault_path(user["username"])
    src = (vault / body.path).resolve()
    try:
        src.relative_to(vault.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Path outside vault")
    if not src.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    dest_folder = Path(body.dest_folder.strip("/").strip()) if body.dest_folder.strip() else Path("")
    for part in dest_folder.parts:
        if part in (".", ".."):
            raise HTTPException(status_code=400, detail="Invalid destination")
    dest_dir = (vault / dest_folder).resolve()
    try:
        dest_dir.relative_to(vault.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Destination outside vault")
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / src.name
    if dest.exists():
        raise HTTPException(status_code=409, detail="A file with that name already exists in the destination")
    src.rename(dest)
    return {"ok": True, "path": str(dest.relative_to(vault.resolve())).replace("\\", "/")}


@app.post("/vault/folder/rename")
def rename_vault_folder(body: VaultRenameRequest, user: dict = Depends(get_current_user)):
    vault = user_vault_path(user["username"])
    target = (vault / body.path).resolve()
    try:
        target.relative_to(vault.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Path outside vault")
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="Folder not found")
    new_name = Path(body.new_name).name
    dest = target.parent / new_name
    if dest.exists() and dest.resolve() != target.resolve():
        raise HTTPException(status_code=409, detail="Folder already exists")
    target.rename(dest)
    return {"ok": True}


@app.get("/vault/file")
def vault_file(path: str, user: dict = Depends(get_current_user)):
    vault = user_vault_path(user["username"])
    full_path = os.path.realpath(os.path.join(str(vault), path))
    vault_real = os.path.realpath(str(vault))
    if not full_path.startswith(vault_real + os.sep) and full_path != vault_real:
        raise HTTPException(status_code=403, detail="Access denied")
    if not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="File not found")
    ext = os.path.splitext(full_path)[1].lower()
    if ext == ".pdf":
        with open(full_path, "rb") as f:
            return Response(content=f.read(), media_type="application/pdf")
    with open(full_path, "r", encoding="utf-8", errors="replace") as f:
        return Response(content=f.read(), media_type="text/plain")


# ── Studio persistence endpoints ──

def _validate_studio(studio: str):
    if studio not in db.VALID_STUDIOS:
        raise HTTPException(status_code=400, detail=f"Invalid studio: {studio}")


def _media_dir(user_id: str, studio: str, item_id: str) -> Path:
    return Path(db.MEDIA_DIR) / user_id / studio / item_id


MEDIA_MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".mp3": "audio/mpeg", ".wav": "audio/wav",
    ".mp4": "video/mp4", ".webm": "video/webm",
}


# -- Items --

@app.get("/studio/{studio}/items")
def studio_list_items(
    studio: str,
    folder_id: Optional[str] = None,
    session_id: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    _validate_studio(studio)
    return db.list_studio_items(user["id"], studio, folder_id=folder_id, session_id=session_id)


@app.post("/studio/{studio}/items")
def studio_create_item(studio: str, body: StudioItemCreate, user: dict = Depends(get_current_user)):
    _validate_studio(studio)
    item_id = body.id or str(__import__("uuid").uuid4())
    db.create_studio_item(
        user_id=user["id"], studio=studio, item_id=item_id,
        folder_id=body.folder_id, session_id=body.session_id,
        raw_prompt=body.raw_prompt, title=body.title,
        meta_json=body.meta,
    )
    return {"ok": True, "id": item_id}


@app.get("/studio/{studio}/items/{item_id}")
def studio_get_item(studio: str, item_id: str, user: dict = Depends(get_current_user)):
    _validate_studio(studio)
    item = db.get_studio_item(item_id, user["id"])
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    return item


@app.patch("/studio/{studio}/items/{item_id}")
def studio_update_item(studio: str, item_id: str, body: StudioItemPatch, user: dict = Depends(get_current_user)):
    _validate_studio(studio)
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        return {"ok": True}
    db.update_studio_item(item_id, user["id"], **updates)
    return {"ok": True}


@app.delete("/studio/{studio}/items/{item_id}")
def studio_delete_item(studio: str, item_id: str, user: dict = Depends(get_current_user)):
    _validate_studio(studio)
    db.delete_studio_item(item_id, user["id"])
    media = _media_dir(user["id"], studio, item_id)
    if media.exists():
        shutil.rmtree(media, ignore_errors=True)
    return {"ok": True}


# -- Media upload/download --

@app.post("/studio/{studio}/items/{item_id}/media")
async def studio_upload_media(
    studio: str, item_id: str,
    user: dict = Depends(get_current_user),
    files: list[UploadFile] = File(...),
):
    _validate_studio(studio)
    item = db.get_studio_item(item_id, user["id"])
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    media = _media_dir(user["id"], studio, item_id)
    media.mkdir(parents=True, exist_ok=True)
    saved = []
    for f in files:
        safe_name = Path(f.filename).name
        if not safe_name:
            continue
        dest = media / safe_name
        content = await f.read()
        dest.write_bytes(content)
        saved.append(safe_name)
    return {"ok": True, "files": saved}


@app.get("/studio/{studio}/items/{item_id}/media/{filename}")
def studio_get_media(studio: str, item_id: str, filename: str, user: dict = Depends(get_current_user)):
    _validate_studio(studio)
    item = db.get_studio_item(item_id, user["id"])
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    safe_name = Path(filename).name
    fpath = _media_dir(user["id"], studio, item_id) / safe_name
    if not fpath.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    ext = fpath.suffix.lower()
    mime = MEDIA_MIME.get(ext, "application/octet-stream")
    return FileResponse(str(fpath), media_type=mime)


# -- Favorites --

@app.get("/studio/{studio}/favorites")
def studio_list_favorites(studio: str, user: dict = Depends(get_current_user)):
    _validate_studio(studio)
    return db.list_studio_favorites(user["id"], studio)


@app.post("/studio/{studio}/items/{item_id}/favorite")
def studio_set_favorite(studio: str, item_id: str, user: dict = Depends(get_current_user)):
    _validate_studio(studio)
    db.set_studio_favorite(item_id, user["id"], True)
    return {"ok": True}


@app.delete("/studio/{studio}/items/{item_id}/favorite")
def studio_unset_favorite(studio: str, item_id: str, user: dict = Depends(get_current_user)):
    _validate_studio(studio)
    db.set_studio_favorite(item_id, user["id"], False)
    return {"ok": True}


# -- Trash --

@app.get("/studio/{studio}/trash")
def studio_list_trash(studio: str, user: dict = Depends(get_current_user)):
    _validate_studio(studio)
    return db.list_studio_trash(user["id"], studio)


@app.post("/studio/{studio}/items/{item_id}/trash")
def studio_trash_item(studio: str, item_id: str, user: dict = Depends(get_current_user)):
    _validate_studio(studio)
    db.trash_studio_item(item_id, user["id"])
    return {"ok": True}


@app.post("/studio/{studio}/items/{item_id}/restore")
def studio_restore_item(studio: str, item_id: str, user: dict = Depends(get_current_user)):
    _validate_studio(studio)
    db.restore_studio_item(item_id, user["id"])
    return {"ok": True}


@app.delete("/studio/{studio}/trash")
def studio_empty_trash(studio: str, user: dict = Depends(get_current_user)):
    _validate_studio(studio)
    ids = db.empty_studio_trash(user["id"], studio)
    for item_id in ids:
        media = _media_dir(user["id"], studio, item_id)
        if media.exists():
            shutil.rmtree(media, ignore_errors=True)
    return {"ok": True, "deleted": len(ids)}


@app.delete("/studio/{studio}/trash/{item_id}")
def studio_delete_trash_item(studio: str, item_id: str, user: dict = Depends(get_current_user)):
    _validate_studio(studio)
    db.delete_studio_item(item_id, user["id"])
    media = _media_dir(user["id"], studio, item_id)
    if media.exists():
        shutil.rmtree(media, ignore_errors=True)
    return {"ok": True}


# -- Folders --

@app.get("/studio/{studio}/folders")
def studio_list_folders(studio: str, user: dict = Depends(get_current_user)):
    _validate_studio(studio)
    return db.list_studio_folders(user["id"], studio)


@app.post("/studio/{studio}/folders")
def studio_create_folder(studio: str, body: StudioFolderCreate, user: dict = Depends(get_current_user)):
    _validate_studio(studio)
    fid = db.create_studio_folder(
        user_id=user["id"], studio=studio, folder_id=body.id,
        name=body.name, description=body.description,
    )
    return {"ok": True, "id": fid}


@app.patch("/studio/{studio}/folders/{folder_id}")
def studio_update_folder(studio: str, folder_id: str, body: StudioFolderPatch, user: dict = Depends(get_current_user)):
    _validate_studio(studio)
    db.update_studio_folder(folder_id, user["id"], name=body.name, description=body.description)
    return {"ok": True}


@app.delete("/studio/{studio}/folders/{folder_id}")
def studio_delete_folder(studio: str, folder_id: str, user: dict = Depends(get_current_user)):
    _validate_studio(studio)
    db.delete_studio_folder(folder_id, user["id"])
    return {"ok": True}


# -- Sessions --

@app.get("/studio/{studio}/sessions")
def studio_list_sessions(studio: str, user: dict = Depends(get_current_user)):
    _validate_studio(studio)
    return db.list_studio_sessions(user["id"], studio)


@app.delete("/studio/{studio}/sessions/{session_id:path}")
def studio_delete_session(studio: str, session_id: str, user: dict = Depends(get_current_user)):
    _validate_studio(studio)
    ids = db.delete_studio_session(user["id"], studio, session_id)
    for item_id in ids:
        media = _media_dir(user["id"], studio, item_id)
        if media.exists():
            shutil.rmtree(media, ignore_errors=True)
    return {"ok": True, "deleted": len(ids)}
