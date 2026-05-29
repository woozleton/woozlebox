// ── Per-Model Chat Settings ──
// Owns wooz_chat_model_settings: a JSON map keyed by model name with a
// __default__ fallback, plus hardcoded defaults. Every chat LLM remembers
// its own temperature, sampling, history, system prompt, and TTS voice so
// switching models doesn't stomp the previous model's preferences.
//
// Persistence: writes flow into localStorage under wooz_chat_model_settings
// and are debounce-synced to the server via scheduleSettingsSync(). On
// first load after deploy the legacy wooz_settings blob is migrated into
// __default__ so existing users keep their current values.

const CHAT_MODEL_SETTINGS_KEY = "wooz_chat_model_settings";

const CHAT_SETTINGS_DEFAULTS = {
  temperature: 0.2,
  top_k: 30,
  top_p: 0.9,
  threshold: 0.45,
  num_ctx: 8192,      // context window in tokens sent to Ollama
  compact: 75,
  system_prompt: "",
  thinking: false,
  tts_voice: "tara",
  tts_speed: 1.0,
  tts_temperature: 0.6,
  tts_top_p: 0.9,
};

function _readChatModelMap() {
  try { return JSON.parse(localStorage.getItem(CHAT_MODEL_SETTINGS_KEY) || "{}"); }
  catch { return {}; }
}
function _writeChatModelMap(map) {
  localStorage.setItem(CHAT_MODEL_SETTINGS_KEY, JSON.stringify(map));
}

// One-time migration: if wooz_chat_model_settings is empty, seed __default__
// from the legacy flat wooz_settings blob so returning users don't lose their
// tuned values on first load after the restructure.
function _bootstrapChatSettingsFromLegacy() {
  const map = _readChatModelMap();
  if (map.__default__) return;
  let legacy = {};
  try { legacy = JSON.parse(localStorage.getItem("wooz_settings") || "{}"); } catch {}
  const seeded = { ...CHAT_SETTINGS_DEFAULTS };
  if (legacy.temperature   !== undefined) seeded.temperature   = parseFloat(legacy.temperature);
  if (legacy.threshold     !== undefined) seeded.threshold     = parseFloat(legacy.threshold);
  if (legacy.top_k         !== undefined) seeded.top_k         = parseInt(legacy.top_k);
  // legacy.history was a message count, not a token budget - intentionally not
  // migrated; num_ctx falls back to its default instead.
  if (legacy.compact       !== undefined) seeded.compact       = parseInt(legacy.compact);
  if (legacy.default_prompt !== undefined) seeded.system_prompt = legacy.default_prompt;
  if (legacy.voice         !== undefined) seeded.tts_voice     = legacy.voice;
  if (legacy.tts_speed     !== undefined) seeded.tts_speed     = parseFloat(legacy.tts_speed);
  map.__default__ = seeded;
  _writeChatModelMap(map);
}

function loadChatModelSettings(modelName) {
  const map = _readChatModelMap();
  const def = map.__default__ || {};
  const m = (modelName && map[modelName]) || {};
  return { ...CHAT_SETTINGS_DEFAULTS, ...def, ...m };
}

function saveChatModelSettings(modelName, patch) {
  const map = _readChatModelMap();
  const key = modelName || "__default__";
  map[key] = { ...(map[key] || {}), ...patch };
  // Also mirror into __default__ so new models inherit the most recent tuning.
  if (key !== "__default__") {
    map.__default__ = { ...(map.__default__ || {}), ...patch };
  }
  _writeChatModelMap(map);
  if (typeof scheduleSettingsSync === "function") scheduleSettingsSync();
}

// ── DOM handles ──
const _cs = {
  model:       () => document.getElementById("chat-model-select"),
  temp:        () => document.getElementById("chat-temp-slider"),
  topk:        () => document.getElementById("chat-topk-slider"),
  topp:        () => document.getElementById("chat-topp-slider"),
  thresh:      () => document.getElementById("chat-thresh-slider"),
  ctx:         () => document.getElementById("chat-ctx-slider"),
  compact:     () => document.getElementById("chat-compact-slider"),
  thinking:    () => document.getElementById("chat-think-toggle"),
  voice:       () => document.getElementById("chat-voice-select"),
  ttsSpeed:    () => document.getElementById("chat-tts-speed-slider"),
  ttsTemp:     () => document.getElementById("chat-tts-temp-slider"),
  ttsTopP:     () => document.getElementById("chat-tts-topp-slider"),
};

function updateChatSettingLabels() {
  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const t = _cs.temp();    if (t) setTxt("chat-temp-val",    parseFloat(t.value).toFixed(2));
  const k = _cs.topk();    if (k) setTxt("chat-topk-val",    k.value);
  const p = _cs.topp();    if (p) setTxt("chat-topp-val",    parseFloat(p.value).toFixed(2));
  const s = _cs.thresh();  if (s) setTxt("chat-thresh-val",  parseFloat(s.value).toFixed(2));
  const cx = _cs.ctx(); if (cx) {
    const tok = parseInt(cx.value);
    setTxt("chat-ctx-val", tok >= 1024 ? (tok / 1024) + "k" : tok);
  }
  const c = _cs.compact(); if (c) {
    const cv = parseInt(c.value);
    setTxt("chat-compact-val", cv === 0 ? "Off" : cv + "%");
  }
  const sp = _cs.ttsSpeed(); if (sp) {
    const v = parseFloat(sp.value);
    setTxt("chat-tts-speed-val", v.toFixed(2) + "x");
    window.ttsSpeed = v;
  }
  const tt = _cs.ttsTemp(); if (tt) setTxt("chat-tts-temp-val", parseFloat(tt.value).toFixed(2));
  const tp = _cs.ttsTopP(); if (tp) setTxt("chat-tts-topp-val", parseFloat(tp.value).toFixed(2));
  // Refresh summary crumb label with current model
  const summary = document.getElementById("chat-settings-summary");
  if (summary) {
    const m = _cs.model();
    summary.textContent = (m && m.value) || "Model";
  }
}

function applyChatSettingsToUI(resolved) {
  const set = (el, v) => { if (el && v !== undefined) el.value = v; };
  set(_cs.temp(),      resolved.temperature);
  set(_cs.topk(),      resolved.top_k);
  set(_cs.topp(),      resolved.top_p);
  set(_cs.thresh(),    resolved.threshold);
  set(_cs.ctx(),       resolved.num_ctx || CHAT_SETTINGS_DEFAULTS.num_ctx);
  set(_cs.compact(),   resolved.compact);
  const think = _cs.thinking();
  if (think) think.checked = !!resolved.thinking;
  const voice = _cs.voice();
  if (voice && resolved.tts_voice) {
    // Only set if the option exists (voice list may still be loading).
    if ([...voice.options].some(o => o.value === resolved.tts_voice)) {
      voice.value = resolved.tts_voice;
    }
  }
  set(_cs.ttsSpeed(), resolved.tts_speed);
  set(_cs.ttsTemp(),  resolved.tts_temperature);
  set(_cs.ttsTopP(),  resolved.tts_top_p);
  updateChatSettingLabels();
  _updateChatVoiceDesc();
}

// Auto-fit: cap the context slider's max to the largest window that fits this
// model in VRAM (measured by gpu-manager). The user can still pick any value up
// to that, never beyond. Clamps a too-large stored value down.
async function refreshCtxFit(modelName) {
  const slider = _cs.ctx();
  const note = document.getElementById("chat-ctx-note");
  if (!slider || !modelName) return;
  try {
    const res = await fetch(GPU_API + "/llm/ctx-fit?model=" + encodeURIComponent(modelName));
    const data = await res.json();
    const safeMax = data && data.safe_max;
    if (!safeMax) {  // unmeasurable - leave full range
      slider.max = 32768;
      slider.step = 2048;
      if (note) note.style.display = "none";
      return;
    }
    slider.max = safeMax;
    // Scale step so a large (e.g. 256k) range stays draggable; keep 2k steps
    // for small ranges. Step ~ max/64, snapped to a power of two, min 2048.
    let step = 2048;
    while (step * 64 < safeMax) step *= 2;
    slider.step = step;
    if (parseInt(slider.value) > safeMax) {
      slider.value = safeMax;
      persist("num_ctx", safeMax);
      updateChatSettingLabels();
    }
    if (note) {
      const k = safeMax >= 1024 ? (safeMax / 1024) + "k" : safeMax;
      note.textContent = "Max " + k + " - the largest context that fits this model in VRAM.";
      note.style.display = "";
    }
  } catch {
    slider.max = 32768;
    if (note) note.style.display = "none";
  }
}

function readChatSettingsFromUI() {
  return {
    temperature:     parseFloat(_cs.temp()?.value ?? CHAT_SETTINGS_DEFAULTS.temperature),
    top_k:           parseInt(_cs.topk()?.value ?? CHAT_SETTINGS_DEFAULTS.top_k),
    top_p:           parseFloat(_cs.topp()?.value ?? CHAT_SETTINGS_DEFAULTS.top_p),
    threshold:       parseFloat(_cs.thresh()?.value ?? CHAT_SETTINGS_DEFAULTS.threshold),
    num_ctx:         parseInt(_cs.ctx()?.value ?? CHAT_SETTINGS_DEFAULTS.num_ctx),
    compact:         parseInt(_cs.compact()?.value ?? CHAT_SETTINGS_DEFAULTS.compact),
    thinking:        !!_cs.thinking()?.checked,
    tts_voice:       _cs.voice()?.value || CHAT_SETTINGS_DEFAULTS.tts_voice,
    tts_speed:       parseFloat(_cs.ttsSpeed()?.value ?? CHAT_SETTINGS_DEFAULTS.tts_speed),
    tts_temperature: parseFloat(_cs.ttsTemp()?.value ?? CHAT_SETTINGS_DEFAULTS.tts_temperature),
    tts_top_p:       parseFloat(_cs.ttsTopP()?.value ?? CHAT_SETTINGS_DEFAULTS.tts_top_p),
  };
}

function getChatTtsParams() {
  const s = loadChatModelSettings((typeof selectedModel !== "undefined" && selectedModel) || "");
  return {
    voice: s.tts_voice,
    speed: s.tts_speed,
    temperature: s.tts_temperature,
    top_p: s.tts_top_p,
  };
}

// Cached /models/info lookups so flipping between models doesn't re-hit the
// backend. Mirrors the pattern used in code-studio.js.
const _modelCapCache = new Map();
async function refreshModelCapabilities(modelName) {
  if (!modelName) return;
  const think = _cs.thinking();
  if (!think) return;
  try {
    let info = _modelCapCache.get(modelName);
    if (!info) {
      const res = await apiFetch(`/models/info?model=${encodeURIComponent(modelName)}`);
      if (res.ok) {
        info = await res.json();
        _modelCapCache.set(modelName, info);
      }
    }
    const supportsThinking = info?.thinking !== false;
    think.disabled = !supportsThinking;
    think.parentElement?.classList.toggle("disabled", !supportsThinking);
    if (!supportsThinking && think.checked) {
      think.checked = false;
    }
  } catch {
    // Network hiccup: leave toggle as-is rather than breaking the panel.
  }
}

// Voice select population. Mirrors settings.js loadVoices() but targets the
// chat panel's select and preserves the per-model persisted voice.
const _CHAT_VOICE_NAMES = {
  tara: "Tara", leah: "Leah", jess: "Jess", leo: "Leo",
  dan: "Dan", mia: "Mia", zac: "Zac", zoe: "Zoe",
  pierre: "Pierre", amelie: "Amelie", marie: "Marie",
  jana: "Jana", thomas: "Thomas", max: "Max",
  javi: "Javi", sergio: "Sergio", maria: "Maria",
  pietro: "Pietro", giulia: "Giulia", carlo: "Carlo",
};
const _CHAT_LANG_LABELS = {
  english: "English", french: "French", german: "German",
  spanish: "Spanish", italian: "Italian", korean: "Korean",
  mandarin: "Mandarin", hindi: "Hindi",
};
// Hand-authored voice descriptions. Orpheus does not expose per-voice
// metadata, so these are a first pass based on listening impressions -
// tweak freely.
const ORPHEUS_VOICE_DESCRIPTIONS = {
  // English
  tara: "Warm, conversational female. The default, most natural.",
  leah: "Bright, youthful female. Upbeat and clear.",
  jess: "Soft, friendly female. Calm and approachable.",
  leo:  "Calm, measured male. Articulate and even-toned.",
  dan:  "Deep, grounded male. Confident and direct.",
  mia:  "Light, airy female. Gentle and expressive.",
  zac:  "Energetic male. Casual and lively.",
  zoe:  "Smooth, polished female. Poised and professional.",
  // French
  pierre: "Measured French male. Neutral Parisian accent.",
  amelie: "Warm French female. Expressive and friendly.",
  marie:  "Refined French female. Soft and elegant.",
  // German
  jana:   "Clear German female. Balanced and natural.",
  thomas: "Steady German male. Calm and articulate.",
  max:    "Confident German male. Direct and even.",
  // Spanish
  javi:   "Neutral Spanish male. Clear Castilian tone.",
  sergio: "Warm Spanish male. Friendly and grounded.",
  maria:  "Bright Spanish female. Expressive and clear.",
  // Italian
  pietro: "Measured Italian male. Calm and articulate.",
  giulia: "Warm Italian female. Bright and friendly.",
  carlo:  "Confident Italian male. Even and direct.",
  // Korean / Mandarin / Hindi voices use native scripts as IDs; keep
  // generic descriptions until listening confirms otherwise.
  "유나":   "Korean female. Natural conversational tone.",
  "준서":   "Korean male. Calm and measured.",
  "长乐":   "Mandarin female. Clear and warm.",
  "白芷":   "Mandarin female. Soft and expressive.",
  "ऋतिका": "Hindi female. Warm and articulate.",
};
function _describeVoice(v) {
  return ORPHEUS_VOICE_DESCRIPTIONS[v] || "";
}
function _updateChatVoiceDesc() {
  const el = document.getElementById("chat-voice-desc");
  const sel = document.getElementById("chat-voice-select");
  if (el && sel) el.textContent = _describeVoice(sel.value);
}
let _chatVoicesLoaded = false;
async function loadChatVoices() {
  if (_chatVoicesLoaded) return;
  const sel = _cs.voice();
  if (!sel) return;
  try {
    const res = await apiFetch(`/tts/voices`);
    const data = await res.json();
    const resolved = loadChatModelSettings((typeof selectedModel !== "undefined" && selectedModel) || "");
    const saved = resolved.tts_voice || data.default;
    const label = (v) => _CHAT_VOICE_NAMES[v] || v;
    let html = "";
    if (data.languages && typeof data.languages === "object") {
      for (const [lang, voices] of Object.entries(data.languages)) {
        if (!voices || !voices.length) continue;
        html += `<optgroup label="${_CHAT_LANG_LABELS[lang] || lang}">`;
        html += voices.map(v =>
          `<option value="${v}"${v === saved ? " selected" : ""}>${label(v)}</option>`
        ).join("");
        html += `</optgroup>`;
      }
    } else {
      html = (data.voices || []).map(v =>
        `<option value="${v}"${v === saved ? " selected" : ""}>${label(v)}</option>`
      ).join("");
    }
    sel.innerHTML = html;
    _updateChatVoiceDesc();
    // Also populate the notetaker voice select from the same list.
    const ntSel = document.getElementById("nt-voice-select");
    if (ntSel) {
      const ntSaved = localStorage.getItem("wooz_nt_tts_voice") || data.default;
      let ntHtml = "";
      if (data.languages && typeof data.languages === "object") {
        for (const [lang, voices] of Object.entries(data.languages)) {
          if (!voices || !voices.length) continue;
          ntHtml += `<optgroup label="${_CHAT_LANG_LABELS[lang] || lang}">`;
          ntHtml += voices.map(v =>
            `<option value="${v}"${v === ntSaved ? " selected" : ""}>${label(v)}</option>`
          ).join("");
          ntHtml += `</optgroup>`;
        }
      } else {
        ntHtml = (data.voices || []).map(v =>
          `<option value="${v}"${v === ntSaved ? " selected" : ""}>${label(v)}</option>`
        ).join("");
      }
      ntSel.innerHTML = ntHtml;
      const ntDesc = document.getElementById("nt-voice-desc");
      if (ntDesc) ntDesc.textContent = _describeVoice(ntSel.value);
    }
    _chatVoicesLoaded = true;
  } catch {
    // TTS unavailable - leave placeholder.
  }
}

// ── Event wiring ──
function initChatSettings() {
  _bootstrapChatSettingsFromLegacy();

  // Initial UI hydration happens once the model list is populated in
  // loadModels() (which dispatches a 'change' synthetically after setting
  // the default). To be safe, apply defaults now so labels are correct.
  applyChatSettingsToUI(loadChatModelSettings(""));
  // If a model is already known at init, cap the context slider to its fit.
  if (typeof selectedModel !== "undefined" && selectedModel) refreshCtxFit(selectedModel);

  // Slider / toggle / textarea change handlers: persist per-model.
  const persist = (field, value) => {
    const model = (typeof selectedModel !== "undefined" && selectedModel) || "";
    saveChatModelSettings(model, { [field]: value });
  };

  _cs.temp()?.addEventListener("input", () => {
    updateChatSettingLabels();
    persist("temperature", parseFloat(_cs.temp().value));
  });
  _cs.topk()?.addEventListener("input", () => {
    updateChatSettingLabels();
    persist("top_k", parseInt(_cs.topk().value));
  });
  _cs.topp()?.addEventListener("input", () => {
    updateChatSettingLabels();
    persist("top_p", parseFloat(_cs.topp().value));
  });
  _cs.thresh()?.addEventListener("input", () => {
    updateChatSettingLabels();
    persist("threshold", parseFloat(_cs.thresh().value));
  });
  _cs.ctx()?.addEventListener("input", () => {
    updateChatSettingLabels();
    persist("num_ctx", parseInt(_cs.ctx().value));
    // Live-refresh the context usage readout against the new window.
    if (typeof updateContextBar === "function" && typeof activeConvId !== "undefined" && activeConvId) {
      updateContextBar(activeConvId);
    }
  });
  _cs.compact()?.addEventListener("input", () => {
    updateChatSettingLabels();
    persist("compact", parseInt(_cs.compact().value));
  });
  _cs.thinking()?.addEventListener("change", () => {
    persist("thinking", !!_cs.thinking().checked);
  });
  _cs.voice()?.addEventListener("change", () => {
    persist("tts_voice", _cs.voice().value);
    _updateChatVoiceDesc();
  });
  _cs.ttsSpeed()?.addEventListener("input", () => {
    updateChatSettingLabels();
    persist("tts_speed", parseFloat(_cs.ttsSpeed().value));
  });
  _cs.ttsTemp()?.addEventListener("input", () => {
    updateChatSettingLabels();
    persist("tts_temperature", parseFloat(_cs.ttsTemp().value));
  });
  _cs.ttsTopP()?.addEventListener("input", () => {
    updateChatSettingLabels();
    persist("tts_top_p", parseFloat(_cs.ttsTopP().value));
  });

  // Model select: on change, pull the new model's settings into the UI.
  _cs.model()?.addEventListener("change", () => {
    const m = _cs.model().value;
    applyChatSettingsToUI(loadChatModelSettings(m));
    refreshModelCapabilities(m);
    refreshCtxFit(m);
  });

  // Crumb toggle (mirrors code-studio.js pattern via shared helper).
  if (typeof wireSettingsToggle === "function") {
    wireSettingsToggle("chat-settings-trigger", "chat-settings-crumb", "chat-settings-panel");
  }

  // Collapsible Advanced + Voice sections (same pattern as code studio).
  const wireCollapse = (toggleId, bodyId) => {
    const t = document.getElementById(toggleId);
    const b = document.getElementById(bodyId);
    if (!t || !b) return;
    t.addEventListener("click", () => {
      t.classList.toggle("open");
      b.classList.toggle("open");
    });
  };
  wireCollapse("chat-advanced-toggle", "chat-advanced-body");
  wireCollapse("chat-voice-toggle", "chat-voice-body");
}

// Kick off wiring once the DOM is ready. chat-settings.js loads after
// settings.js and tts.js so apiFetch / streamAndPlayTTS are already defined.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initChatSettings);
} else {
  initChatSettings();
}
