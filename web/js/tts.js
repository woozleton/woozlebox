// ── TTS toggle ──
const TTS_KEY = "wooz_tts";
let ttsEnabled = localStorage.getItem(TTS_KEY) === "true"; // default OFF
const SVG_VOL_ON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
const SVG_VOL_OFF = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;
function applyTTS(enabled) {
  ttsEnabled = enabled;
  localStorage.setItem(TTS_KEY, enabled);
  ttsBtn.innerHTML = enabled ? SVG_VOL_ON : SVG_VOL_OFF;
  ttsBtn.classList.toggle("active", enabled);
  ttsBtn.title = enabled ? "TTS on, click to mute" : "TTS muted, click to enable";
  const toggle = document.getElementById("tts-toggle");
  if (toggle) toggle.checked = enabled;
}
applyTTS(ttsEnabled);
ttsBtn.addEventListener("click", () => { applyTTS(!ttsEnabled); if (!ttsEnabled) stopSpeaking(); });

// TTS settings toggle - wired after settings panel is injected
document.getElementById("tts-toggle").checked = ttsEnabled;
document.getElementById("tts-toggle").addEventListener("change", (e) => {
  applyTTS(e.target.checked);
  if (!e.target.checked) stopSpeaking();
});


// ── TTS Audio Engine ──
let audioCtx = null;
let currentSource = null;
let ttsAbortController = null;
let activeTtsBtn = null;

function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = window._ttsAudioCtx || new AudioContext();
    window._ttsAudioCtx = audioCtx;
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function getVoice() {
  return voiceSelect.value || "af_heart";
}

function splitSentences(text) {
  const chunks = text.match(/[^.!?\n]+[.!?\n]+\s*/g) || [text];
  return chunks.map(s => s.trim()).filter(Boolean);
}

async function fetchTTSChunk(text, voice, signal) {
  const params = new URLSearchParams({ text, voice });
  const res = await apiFetch(`/tts?${params}`, { signal });
  if (!res.ok) throw new Error(`TTS ${res.status}`);
  return res.arrayBuffer();
}

function playSingleBuffer(decoded, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve();
    const ctx = getAudioCtx();
    const source = ctx.createBufferSource();
    source.buffer = decoded;
    source.connect(ctx.destination);
    if (window._avatarAnalyser) source.connect(window._avatarAnalyser);
    currentSource = source;
    source.onended = resolve;
    source.start();
    signal.addEventListener("abort", () => { try { source.stop(); } catch {} resolve(); });
  });
}

async function speakText(fullText, voice, playBtn) {
  stopSpeaking();
  ttsAbortController = new AbortController();
  const signal = ttsAbortController.signal;

  if (playBtn) { playBtn.innerHTML = icon("pause", 13); playBtn.classList.add("playing"); activeTtsBtn = playBtn; }

  try {
    const sentences = splitSentences(fullText);
    for (const sentence of sentences) {
      if (signal.aborted) break;
      const buf = await fetchTTSChunk(sentence, voice, signal);
      if (signal.aborted) break;
      const decoded = await getAudioCtx().decodeAudioData(buf);
      await playSingleBuffer(decoded, signal);
    }
  } catch (e) {
    if (e.name !== "AbortError") console.warn("TTS error:", e);
  } finally {
    if (playBtn && !signal.aborted) { playBtn.innerHTML = icon("play", 13); playBtn.classList.remove("playing"); }
    if (activeTtsBtn === playBtn) activeTtsBtn = null;
    currentSource = null;
  }
}

function stopSpeaking() {
  ttsAbortController?.abort();
  try { currentSource?.stop(); } catch {}
  currentSource = null;
  if (activeTtsBtn) { activeTtsBtn.innerHTML = icon("play", 13); activeTtsBtn.classList.remove("playing"); activeTtsBtn = null; }
}


// ── Streaming TTS Speaker ──
// Plays TTS sentence-by-sentence as tokens arrive from the SSE stream,
// pre-fetching the next sentence's audio while the current one plays.
class StreamingTTSSpeaker {
  constructor(voice) {
    this.voice = voice;
    this.buffer = "";
    this.queue = [];       // [{fetchPromise, text}]
    this.playing = false;
    this.flushed = false;
    this.abortController = new AbortController();
    this.currentSource = null;
    this.onComplete = null;
  }

  pushToken(token) {
    if (this.abortController.signal.aborted) return;
    this.buffer += token;
    let sentence;
    while ((sentence = this._checkBoundary()) !== null) {
      this._enqueueSentence(sentence);
    }
  }

  flush() {
    this.flushed = true;
    const remaining = this.buffer.trim();
    this.buffer = "";
    if (remaining) {
      this._enqueueSentence(remaining);
    } else if (!this.playing && this.queue.length === 0) {
      this._fireComplete();
    }
  }

  stop() {
    this.abortController.abort();
    try { this.currentSource?.stop(); } catch {}
    this.currentSource = null;
    this.queue = [];
    this.playing = false;
    this.buffer = "";
  }

  _checkBoundary() {
    const match = this.buffer.match(/^([\s\S]+?[.!?\n]["'\u201D\u2019)}\]]?\s)/);
    if (match) {
      const sentence = match[1].trim();
      this.buffer = this.buffer.slice(match[0].length);
      return sentence || null;
    }
    return null;
  }

  _enqueueSentence(text) {
    const signal = this.abortController.signal;
    const fetchPromise = fetchTTSChunk(text, this.voice, signal);
    this.queue.push({ fetchPromise, text });
    if (!this.playing) this._playNext();
  }

  async _playNext() {
    if (this.abortController.signal.aborted) return;
    if (this.queue.length === 0) {
      this.playing = false;
      if (this.flushed) this._fireComplete();
      return;
    }
    this.playing = true;
    const item = this.queue.shift();
    try {
      const buf = await item.fetchPromise;
      if (this.abortController.signal.aborted) return;
      const decoded = await getAudioCtx().decodeAudioData(buf);
      if (this.abortController.signal.aborted) return;
      await this._playSingle(decoded);
    } catch (e) {
      if (e.name !== "AbortError") console.warn("Streaming TTS error:", e);
    }
    this._playNext();
  }

  _playSingle(decoded) {
    return new Promise((resolve) => {
      const signal = this.abortController.signal;
      if (signal.aborted) return resolve();
      const ctx = getAudioCtx();
      const source = ctx.createBufferSource();
      source.buffer = decoded;
      source.connect(ctx.destination);
      if (window._avatarAnalyser) source.connect(window._avatarAnalyser);
      this.currentSource = source;
      source.onended = () => { this.currentSource = null; resolve(); };
      source.start();
      signal.addEventListener("abort", () => { try { source.stop(); } catch {} resolve(); });
    });
  }

  _fireComplete() {
    if (this.onComplete) setTimeout(() => this.onComplete(), 0);
  }
}


// ── Speech-to-Text (Mic Button) ──
let sttRecognition = null;
let sttActive = false;
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  sttRecognition = new SpeechRecognition();
  sttRecognition.continuous = false;
  sttRecognition.interimResults = true;
  sttRecognition.lang = "en-US";
  let finalTranscript = "";
  sttRecognition.onstart = () => {
    sttActive = true;
    micBtn.classList.add("recording");
    micBtn.title = "Listening... click to stop";
    // Interrupt any playing TTS when user starts speaking
    stopSpeaking();
    if (window._activeStreamingTts) { window._activeStreamingTts.stop(); window._activeStreamingTts = null; }
    if (voiceModeActive && typeof stopStream === "function") stopStream();
  };
  sttRecognition.onend = () => {
    sttActive = false;
    micBtn.classList.remove("recording");
    micBtn.title = "Voice input";
    const transcript = input.value.replace(/\u200B[\s\S]*$/, "").trim();
    input.value = transcript;
    // In voice mode, auto-send if we got a transcript
    if (voiceModeActive && transcript) sendMessage();
  };
  sttRecognition.onerror = (e) => { if (e.error !== "aborted") showToast("Mic error: " + e.error); sttActive = false; micBtn.classList.remove("recording"); };
  sttRecognition.onresult = (e) => {
    let interim = "";
    finalTranscript = "";
    for (let i = 0; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalTranscript += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    // Show interim in input as preview
    const before = input.value.replace(/\u200B[\s\S]*$/, "");
    input.value = before + (finalTranscript || "") + (interim ? "\u200B" + interim : "");
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  };
  micBtn.addEventListener("click", () => {
    if (sttActive) { sttRecognition.stop(); return; }
    // Clean any leftover interim text marker
    input.value = input.value.replace(/\u200B[\s\S]*$/, "");
    sttRecognition.start();
  });
} else {
  micBtn.style.display = "none"; // Browser doesn't support speech recognition
  voiceModeBtn.style.display = "none";
}


// ── Voice Conversation Mode ──
// Hands-free loop: listen -> auto-send -> stream+speak -> listen again
let voiceModeActive = false;

function startVoiceMode() {
  if (!sttRecognition) { showToast("Voice mode requires speech recognition support"); return; }
  voiceModeActive = true;
  applyTTS(true);
  document.body.classList.add("voice-mode");
  voiceModeBtn.classList.add("active");
  voiceModeBtn.title = "Voice mode on - click to stop";
  startListening();
}

function stopVoiceMode() {
  voiceModeActive = false;
  document.body.classList.remove("voice-mode");
  voiceModeBtn.classList.remove("active");
  voiceModeBtn.title = "Voice conversation mode";
  if (sttActive) sttRecognition.stop();
  stopSpeaking();
  window._activeStreamingTts?.stop();
  window._activeStreamingTts = null;
}

function startListening() {
  if (!voiceModeActive || !sttRecognition) return;
  input.value = "";
  try { sttRecognition.start(); } catch (e) {
    // Already started - ignore
  }
}

voiceModeBtn.addEventListener("click", () => {
  if (voiceModeActive) stopVoiceMode();
  else startVoiceMode();
});

