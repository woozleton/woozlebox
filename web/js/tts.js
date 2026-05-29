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
ttsBtn.addEventListener("click", () => { applyTTS(!ttsEnabled); if (!ttsEnabled) stopAllTts(); });

// TTS settings toggle - wired after settings panel is injected
document.getElementById("tts-toggle").checked = ttsEnabled;
document.getElementById("tts-toggle").addEventListener("change", (e) => {
  applyTTS(e.target.checked);
  if (!e.target.checked) stopAllTts();
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
  return voiceSelect.value || "tara";
}

function splitSentences(text) {
  const re = /[^.!?\n]+[.!?\n]+\s*/g;
  const chunks = [];
  let lastIdx = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    chunks.push(m[0]);
    lastIdx = re.lastIndex;
  }
  // Capture any trailing text that had no terminal punctuation - the old
  // regex-only approach silently dropped it, causing words to be skipped
  // at the end of a response.
  const tail = text.slice(lastIdx);
  if (tail.trim()) chunks.push(tail);
  if (chunks.length === 0) chunks.push(text);
  return chunks.map(s => s.trim()).filter(Boolean);
}

// Stream raw int16 mono PCM from /tts and play it back as it arrives.
// Schedules AudioBufferSourceNodes back-to-back using a running start-time
// cursor so chunks play seamlessly without gaps. First audio lands within
// ~300 ms because playback starts on the first received chunk, not after
// the whole sentence synthesizes.
const TTS_SAMPLE_RATE = 24000;

async function fetchTTS(text, voice, signal, extra = {}) {
  const params = new URLSearchParams({ text, voice });
  if (extra && extra.temperature != null) params.set("temperature", String(extra.temperature));
  if (extra && extra.top_p != null) params.set("top_p", String(extra.top_p));
  const res = await apiFetch(`/tts?${params}`, { signal });
  if (res.status === 409) {
    // gpu-manager refused because the active chat LLM leaves no VRAM
    // headroom for Orpheus. Surface the backend detail verbatim.
    let detail = "TTS unavailable: insufficient VRAM";
    try { const j = await res.json(); if (j && j.detail) detail = j.detail; } catch {}
    if (typeof showToast === "function") showToast(detail, "error");
    const err = new Error(detail);
    err.ttsBlocked = true;
    throw err;
  }
  if (!res.ok) throw new Error(`TTS ${res.status}`);
  if (!res.body) throw new Error("TTS: no response body");
  return res;
}

// _PrefetchedBody eagerly drains a Response body into an in-memory buffer
// starting the moment it's constructed. This matters for sentence prefetch:
// browser fetch is pull-based, so if nobody calls reader.read() the TCP
// socket backpressures and the server stops generating bytes. By pumping
// immediately, tts-api keeps producing audio while the previous sentence is
// still playing, so when we adopt the prefetch the chunks are already in
// hand - no HTTP-body wait at the sentence boundary.
class _PrefetchedBody {
  constructor(res, signal) {
    this.reader = res.body.getReader();
    this.signal = signal;
    this.buffered = [];
    this.done = false;
    this.error = null;
    this._waiters = [];
    this._pump();
  }
  async _pump() {
    try {
      while (!this.signal.aborted) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length) this.buffered.push(value);
        this._wake();
      }
    } catch (e) {
      if (e.name !== "AbortError") this.error = e;
    } finally {
      this.done = true;
      this._wake();
    }
  }
  _wake() {
    const ws = this._waiters;
    this._waiters = [];
    for (const r of ws) r();
  }
  async *chunks() {
    let i = 0;
    while (true) {
      while (i < this.buffered.length) yield this.buffered[i++];
      if (this.error) throw this.error;
      if (this.done) return;
      await new Promise((r) => this._waiters.push(r));
    }
  }
  async waitComplete() {
    while (!this.done) {
      await new Promise((r) => this._waiters.push(r));
    }
    if (this.error) throw this.error;
  }
  async waitForBytes(n) {
    let have = 0;
    let i = 0;
    while (have < n) {
      while (i < this.buffered.length) { have += this.buffered[i++].length; }
      if (have >= n) return;
      if (this.error) throw this.error;
      if (this.done) return;
      await new Promise((r) => this._waiters.push(r));
    }
  }
  cancel() { try { this.reader.cancel(); } catch {} }
}

async function streamAndPlayFromResponse(res, signal, onSourceChange, extra = {}, opts = {}) {
  const body = new _PrefetchedBody(res, signal);
  await streamAndPlayFromChunks(body.chunks(), signal, onSourceChange, extra, opts);
}

async function streamAndPlayFromChunks(asyncIterable, signal, onSourceChange, extra = {}, opts = {}) {
  const ctx = getAudioCtx();
  if (ctx.state === "suspended") { try { await ctx.resume(); } catch {} }

  // Per-call playback rate override; falls back to window.ttsSpeed.
  if (extra && extra.speed != null) window.__ttsCallSpeed = parseFloat(extra.speed);
  else window.__ttsCallSpeed = null;
  const activeSources = new Set();
  // Fresh requests get a 400 ms head start. The cold path has significant
  // variance in inter-chunk arrival - SNAC decoder + network + PCM demux -
  // and a smaller buffer causes audible dropouts ("crackle") on the first
  // sentence when a chunk lands later than the scheduler expected. When a
  // startHint is passed (StreamingTTSSpeaker bridging sentence N -> N+1),
  // we've already been generating upstream so jitter is lower; schedule
  // tight on the previous tail with just a 20 ms safety margin.
  let nextStartTime = opts.startHint
    ? Math.max(ctx.currentTime + 0.02, opts.startHint)
    : ctx.currentTime + 0.4;
  const rate = Math.max(0.5, Math.min(2.0, window.__ttsCallSpeed || window.ttsSpeed || 1.0));
  let leftover = null; // carry odd byte across chunks (int16 alignment)
  let lastSourceEnded = null;

  const scheduleChunk = (bytes) => {
    if (!bytes || bytes.length < 2) return;
    // Align to int16 boundary; stash any trailing odd byte for next chunk.
    let usableLen = bytes.length - (bytes.length % 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, usableLen);
    const sampleCount = usableLen / 2;
    const buf = ctx.createBuffer(1, sampleCount, TTS_SAMPLE_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      ch[i] = view.getInt16(i * 2, true) / 32768;
    }
    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.playbackRate.value = rate;
    source.connect(ctx.destination);
    if (window._avatarAnalyser) source.connect(window._avatarAnalyser);
    // Schedule strictly contiguous with the previous buffer. If we've fallen
    // behind real time, snap forward to currentTime (accepting a single
    // dropout) rather than padding each chunk with a safety margin, which
    // would introduce a gap on every boundary and cause continuous crackle.
    if (nextStartTime < ctx.currentTime) nextStartTime = ctx.currentTime;
    source.start(nextStartTime);
    // Effective playback duration is shortened when rate > 1.
    nextStartTime += buf.duration / rate;
    activeSources.add(source);
    currentSource = source;
    if (onSourceChange) onSourceChange(source);
    lastSourceEnded = new Promise((r) => { source.onended = () => { activeSources.delete(source); r(); }; });
  };

  const onAbort = () => {
    for (const s of activeSources) { try { s.stop(); } catch {} }
    activeSources.clear();
  };
  signal.addEventListener("abort", onAbort);

  try {
    for await (const value of asyncIterable) {
      if (signal.aborted) break;
      if (!value || value.length === 0) continue;
      let bytes = value;
      if (leftover) {
        const merged = new Uint8Array(leftover.length + bytes.length);
        merged.set(leftover, 0);
        merged.set(bytes, leftover.length);
        bytes = merged;
        leftover = null;
      }
      if (bytes.length % 2 === 1) {
        leftover = bytes.slice(bytes.length - 1);
        bytes = bytes.slice(0, bytes.length - 1);
      }
      scheduleChunk(bytes);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }

  // Report the schedule tail so the caller can bridge the next sentence
  // contiguously instead of restarting with a fresh head start.
  if (opts.onEndTime) opts.onEndTime(nextStartTime);

  // Wait for the last scheduled source to finish playing before resolving,
  // unless the caller explicitly opted out (StreamingTTSSpeaker passes
  // awaitPlayback:false so the next sentence's reader loop can begin while
  // the current sentence's audio is still playing - the startHint cursor
  // keeps them sequenced on the audio timeline).
  const awaitPlayback = opts.awaitPlayback !== false;
  if (awaitPlayback && lastSourceEnded && !signal.aborted) {
    await lastSourceEnded;
  }
  if (awaitPlayback && onSourceChange) onSourceChange(null);
}

async function streamAndPlayTTS(text, voice, signal, onSourceChange, extra = {}) {
  const res = await fetchTTS(text, voice, signal, extra);
  await streamAndPlayFromResponse(res, signal, onSourceChange, extra);
}

async function speakText(fullText, voice, playBtn, extra = {}) {
  stopSpeaking();
  ttsAbortController = new AbortController();
  const signal = ttsAbortController.signal;

  if (playBtn) { playBtn.innerHTML = icon("pause", 13); playBtn.classList.add("playing"); activeTtsBtn = playBtn; }

  try {
    // Send the full message as a single request. Splitting client-side
    // introduces a fetch + warm-up gap between sentences which manifests
    // as "chunky" playback. The tts-api stream emits SNAC chunks
    // continuously so one request gives seamless audio across sentences.
    await streamAndPlayTTS(fullText, voice, signal, null, extra);
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
let activeStreamingTts = null;

function setStreamingTts(instance) { activeStreamingTts = instance; }

function stopStreamingTts() {
  activeStreamingTts?.stop();
  activeStreamingTts = null;
}

function stopAllTts() {
  stopSpeaking();
  stopStreamingTts();
}

class StreamingTTSSpeaker {
  constructor(voice, extra = {}) {
    this.voice = voice;
    this.extra = extra || {};
    this.buffer = "";
    this.queue = [];
    this.playing = false;
    this.flushed = false;
    this.abortController = new AbortController();
    this.currentSource = null;
    this.onComplete = null;
    // One in-flight prefetched fetch for the head-of-queue next sentence.
    // Matches the llama-server `--parallel 2` cap (1 playing + 1 prefetching).
    this._inflight = null;
    // Running schedule cursor bridging sentence N -> N+1 so consecutive
    // sentences play contiguously instead of each opening a fresh 400 ms gap.
    this._nextStartHint = null;
    // Deferred-completion timer. Since _playNext returns as soon as the
    // reader loop ends (not when audio ends), we schedule _fireComplete
    // based on the audio timeline's _nextStartHint instead of awaiting a
    // source's onended.
    this._completeTimer = null;
    // Cold-path first sentence is fully buffered before playback. The SNAC
    // decoder + llama.cpp prompt eval deliver chunks with high jitter on the
    // initial request, which causes the sample scheduler to snap-forward and
    // produce audible skips/crackle. Waiting for the entire first response
    // adds ~300-500 ms of latency but guarantees a clean first utterance.
    // Subsequent sentences use the normal streaming path - by then llama.cpp
    // is warm and the prefetched body has been draining during prior playback.
    this._isFirstSentence = true;
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
      this._scheduleComplete();
    }
  }

  stop() {
    this.abortController.abort();
    try { this.currentSource?.stop(); } catch {}
    this.currentSource = null;
    this.queue = [];
    this.playing = false;
    this.buffer = "";
    this._inflight = null;
    this._nextStartHint = null;
    if (this._completeTimer) { clearTimeout(this._completeTimer); this._completeTimer = null; }
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
    this.queue.push({ text });
    if (!this.playing) this._playNext();
    else this._maybePrefetch();
  }

  _maybePrefetch() {
    if (this._inflight) return;
    if (this.queue.length === 0) return;
    if (this.abortController.signal.aborted) return;
    const next = this.queue[0];
    const signal = this.abortController.signal;
    // Chain fetch -> _PrefetchedBody so body pumping begins the instant the
    // response headers land, not when _playNext eventually adopts. This is
    // the whole point of prefetch: bytes stream in while the previous
    // sentence is still audibly playing, so by the time we adopt they're
    // already in the in-memory buffer and the next sentence starts without
    // an HTTP round-trip gap.
    const bodyPromise = fetchTTS(next.text, this.voice, signal, this.extra)
      .then((res) => new _PrefetchedBody(res, signal));
    bodyPromise.catch(() => {});
    this._inflight = { item: next, bodyPromise };
  }

  async _playNext() {
    if (this.abortController.signal.aborted) return;
    if (this.queue.length === 0) {
      this.playing = false;
      if (this.flushed) this._scheduleComplete();
      return;
    }
    this.playing = true;
    const item = this.queue.shift();

    // Adopt the prefetched body if it was for this exact item; otherwise
    // kick off a fresh fetch + eager pump. Reference equality is safe because
    // _enqueueSentence creates a new wrapper object per push and prefetch
    // always targets queue[0].
    let bodyPromise;
    if (this._inflight && this._inflight.item === item) {
      bodyPromise = this._inflight.bodyPromise;
      this._inflight = null;
    } else {
      const signal = this.abortController.signal;
      bodyPromise = fetchTTS(item.text, this.voice, signal, this.extra)
        .then((res) => new _PrefetchedBody(res, signal));
    }

    // Kick off prefetch of the NEXT sentence in parallel with current playback.
    this._maybePrefetch();

    try {
      const body = await bodyPromise;
      if (this._isFirstSentence) {
        this._isFirstSentence = false;
        // Partial pre-buffer: wait until ~500 ms of audio has landed before
        // scheduling the first chunk, but keep streaming the remainder. 24 kHz
        // mono s16 = 48000 bytes/s, so 500 ms = 24000 bytes. This absorbs
        // SNAC + prompt-eval jitter on the cold path without the full-buffer
        // latency hit.
        await body.waitForBytes(24000);
      }
      // awaitPlayback:false - return as soon as the reader loop has finished
      // scheduling chunks on the audio timeline. The next sentence's reader
      // loop can then begin immediately while the current sentence is still
      // audibly playing; startHint/onEndTime keep them sequenced end-to-end.
      await streamAndPlayFromChunks(
        body.chunks(),
        this.abortController.signal,
        (s) => { this.currentSource = s; },
        this.extra,
        {
          startHint: this._nextStartHint,
          onEndTime: (t) => { this._nextStartHint = t; },
          awaitPlayback: false,
        },
      );
    } catch (e) {
      if (e.name !== "AbortError") console.warn("Streaming TTS error:", e);
    }
    this._playNext();
  }

  _scheduleComplete() {
    // All sentences have been scheduled; audio may still be playing until
    // _nextStartHint. Defer completion to roughly that moment so chat.js's
    // onComplete (which unhighlights the bubble, etc.) lines up with audible
    // end-of-speech rather than firing mid-playback.
    if (this._completeTimer) clearTimeout(this._completeTimer);
    const ctx = getAudioCtx();
    const remainingMs = Math.max(0, ((this._nextStartHint || 0) - ctx.currentTime) * 1000);
    this._completeTimer = setTimeout(() => {
      this._completeTimer = null;
      if (this.abortController.signal.aborted) return;
      this._fireComplete();
    }, remainingMs);
  }

  _fireComplete() {
    if (this.onComplete) setTimeout(() => this.onComplete(), 0);
  }
}


// ── Speech-to-Text ──
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
    voiceModeBtn.classList.add("recording");
    stopAllTts();
    if (voiceModeActive) stopStream();
  };
  sttRecognition.onend = () => {
    sttActive = false;
    voiceModeBtn.classList.remove("recording");
    const transcript = input.value.replace(/\u200B[\s\S]*$/, "").trim();
    input.value = transcript;
    if (voiceModeActive && transcript) sendMessage();
  };
  sttRecognition.onerror = (e) => { if (e.error !== "aborted") showToast("Mic error: " + e.error); sttActive = false; voiceModeBtn.classList.remove("recording"); };
  sttRecognition.onresult = (e) => {
    let interim = "";
    finalTranscript = "";
    for (let i = 0; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalTranscript += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    const before = input.value.replace(/\u200B[\s\S]*$/, "");
    input.value = before + (finalTranscript || "") + (interim ? "\u200B" + interim : "");
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  };
} else {
  voiceModeBtn.style.display = "none";
}


// ── Voice Conversation Mode ──
// Hands-free loop: listen -> auto-send -> stream+speak -> listen again
let voiceModeActive = false;

function startVoiceMode() {
  if (!sttRecognition) { showToast("Voice mode requires speech recognition support"); return; }
  voiceModeActive = true;
  // Enable TTS transiently for voice mode (don't persist to localStorage)
  ttsEnabled = true;
  ttsBtn.innerHTML = SVG_VOL_ON;
  ttsBtn.classList.add("active");
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
  stopAllTts();
  // Always disable TTS when leaving voice mode
  applyTTS(false);
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

