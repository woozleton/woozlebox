function applyUserSession(user) {
  currentUser = user;
  // Show logout button with username
  const logoutBtn = document.getElementById("logout-btn");
  logoutBtn.style.display = "";
  logoutBtn.title = `Log out ${user.username}`;
  // Show admin section if admin
  if (user.role === "admin") {
    document.getElementById("admin-nav-divider").style.display = "";
    document.getElementById("admin-nav-label").style.display = "";
    document.getElementById("admin-nav-item").style.display = "";
    document.getElementById("interface-nav-item").style.display = "";
    document.getElementById("defaults-nav-item").style.display = "";
    document.getElementById("developer-nav-item").style.display = "";
    document.getElementById("prompts-nav-item").style.display = "";
    if (typeof startVramPolling === "function") startVramPolling();
  }
  // Restore settings from DB blob if present
  if (user.settings && user.settings !== "{}") {
    try {
      const s = JSON.parse(user.settings);
      const skip = new Set(["wooz_token", "wooz_vault_pinned", "wooz_view"]);
      Object.entries(s).forEach(([k, v]) => { if (!skip.has(k)) localStorage.setItem(k, typeof v === "object" ? JSON.stringify(v) : v); });
      // Re-apply brand so DOM reflects any server-side values (e.g. showLoginName toggle)
      applyBrand();
      applyLogo(localStorage.getItem(LOGO_KEY));
      applyLoginLogo(localStorage.getItem(LOGIN_LOGO_KEY));
    } catch {}
  }
}

let _settingsSyncTimer = null;
function scheduleSettingsSync() {
  clearTimeout(_settingsSyncTimer);
  _settingsSyncTimer = setTimeout(async () => {
    if (!currentUser) return;
    const snap = {};
    const _syncSkip = new Set(["wooz_token", "wooz_view"]);
    Object.keys(localStorage).filter(k => k.startsWith("wooz_") && !_syncSkip.has(k)).forEach(k => {
      snap[k] = localStorage.getItem(k);
    });
    try {
      await apiFetch("/users/me/settings", {
        method: "PUT",
        body: JSON.stringify({ settings: JSON.stringify(snap) }),
      });
    } catch {}
  }, 1500);
}

async function initApp() {
  // Apply branding immediately so login/setup screens look correct.
  // First try server brand (works for any browser), fall back to localStorage.
  // Apply localStorage brand first (instant), then patch with server values
  applyLogo(localStorage.getItem(LOGO_KEY));
  applyLoginLogo(localStorage.getItem(LOGIN_LOGO_KEY));
  applyFavicon(localStorage.getItem(FAVICON_KEY));
  applyBrand();
  const _t = localStorage.getItem(THEME_KEY);
  if (_t && THEMES[_t]) applyTheme(_t, true);
  else { const _a = localStorage.getItem(ACCENT_KEY); if (_a) applyAccent(_a); }
  // Fetch server brand in background - patches login screen if admin customised it
  fetch(`${API}/auth/brand`).then(r => r.json()).then(br => {
    if (br.login_logo) applyLoginLogo(br.login_logo);
    if (br.logo)       applyLogo(br.logo);
    if (br.theme && THEMES[br.theme]) applyTheme(br.theme, true);
    if (br.accent) applyPlatformAccent(br.accent);
    else if (br.accent) applyAccent(br.accent);
    const showLoginName = br.show_login_name !== false;
    ["auth-app-name-setup", "auth-app-name-login"].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      if (br.name) el.textContent = br.name;
      el.style.display = showLoginName ? "" : "none";
    });
    if (br.name) document.title = br.name;
  }).catch(() => {});

  let status;
  try {
    const res = await apiFetch(`/auth/status`);
    status = await res.json();
  } catch (e) {
    showToast("Cannot reach API server");
    return;
  }

  if (!status.has_users) {
    showSetupScreen();
    return;
  }

  const token = getToken();
  if (!token) {
    showLoginScreen();
    return;
  }

  let me;
  try {
    const res = await apiFetch(`/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) { clearSession(); showLoginScreen(); return; }
    me = await res.json();
  } catch { clearSession(); showLoginScreen(); return; }

  applyUserSession(me);
  hideAuthScreens();
  loadApp();
}

async function loadApp() {
  loadSettings();
  loadProfile();
  applyLogo(localStorage.getItem(LOGO_KEY));
  applyLoginLogo(localStorage.getItem(LOGIN_LOGO_KEY));
  applyFavicon(localStorage.getItem(FAVICON_KEY));
  const savedTheme = localStorage.getItem(THEME_KEY);
  if (savedTheme && THEMES[savedTheme]) applyTheme(savedTheme, true);
  else { const savedAccent = localStorage.getItem(ACCENT_KEY); if (savedAccent) applyAccent(savedAccent); }
  applyTextSize(localStorage.getItem(TEXT_SIZE_KEY) || "medium");
  if (typeof restoreStudioSettings === "function") restoreStudioSettings();
  // Restore active view BEFORE loading conversations to prevent chat flash
  const _savedView = localStorage.getItem("wooz_view");
  if (_savedView === "studio") {
    showStudio();
  } else if (_savedView === "music") {
    showMusicStudio();
  } else if (_savedView === "video") {
    showVideoStudio();
  } else if (_savedView === "notetaker") {
    showNotetaker();
  } else if (_savedView === "code") {
    showCodeStudio();
  } else {
    setView("chat");
  }
  loadModels();
  await loadConversations();
  document.documentElement.classList.remove("studio-preload", "music-preload", "video-preload");
}


// ── DOM refs ──
const chatWindow      = document.getElementById("chat-window");
const input           = document.getElementById("message-input");

const sendBtn         = document.getElementById("send-btn");
const webBtn          = document.getElementById("web-btn");
const voiceModeBtn    = document.getElementById("voice-mode-btn");
const attachBtn       = document.getElementById("attach-btn");
const fileInput       = document.getElementById("file-input");
let pendingFiles = [];
const imagePreviewBar = document.getElementById("image-preview-bar");
let pendingImages = []; // Array of {dataUrl, file}
let currentModelSupportsVision = false;
const modelSelect     = document.getElementById("chat-model-select");
const settingsBtn     = document.getElementById("settings-btn");
const settingsPanel   = document.getElementById("settings-panel");
const settingsClose   = document.getElementById("settings-close");
const overlay         = document.getElementById("overlay");
const convList        = document.getElementById("conv-list");
const newChatBtn      = document.getElementById("new-chat-btn");
const ctxMenu         = document.getElementById("ctx-menu");
const ctxRename       = document.getElementById("ctx-rename");
const ctxDelete       = document.getElementById("ctx-delete");
const toast           = document.getElementById("toast");
const tempSlider      = document.getElementById("chat-temp-slider");
const threshSlider    = document.getElementById("chat-thresh-slider");
const historySlider   = document.getElementById("chat-history-slider");
const compactSlider   = document.getElementById("chat-compact-slider");
const topkSlider      = document.getElementById("chat-topk-slider");
const sidebarToggle   = document.getElementById("sidebar-toggle");
const sidebarOpenBtn  = document.getElementById("sidebar-open-btn");
const vaultPanel      = document.getElementById("vault-panel");
const vaultClose      = document.getElementById("vault-close");
const vaultToggleBtn  = document.getElementById("vault-toggle-btn");
const vaultMeta       = document.getElementById("vault-meta");
const vaultFileList   = document.getElementById("vault-file-list");
const vaultFileInput  = document.getElementById("vault-file-input");
const vaultDropZone   = document.getElementById("vault-drop-zone");
const vaultBanner     = document.getElementById("vault-banner");
const ttsBtn          = document.getElementById("tts-btn");
const voiceSelect     = document.getElementById("chat-voice-select");

// ── State ──
let isLoading      = false;
let debugMode      = false;
let verboseMode    = false;
let webSearch      = false;
let activeConvId   = null;
let ctxTargetId    = null;
let selectedModel  = null;
let messageHistory = [];
let historyIndex   = -1;



// ── Centralized view switching ──
const _modelReady = { chat: false, studio: false, music: false, video: false, notetaker: false, code: false };
let _prepareAbort = null;

// Generator views whose backend service should be released when the user
// leaves them for a different kind of view. Chat/code are Ollama-backed
// and handled by gpu-manager's own eviction, so they stay out of this list.
const _GENERATOR_VIEWS = { studio: "image", music: "music", video: "video", notetaker: "notetaker" };
let _lastView = null;

function setView(view) {
  // If leaving a generator view for anything else, debounce-release its
  // model from VRAM so walk-aways don't keep ~20 GB pinned. If the user
  // bounces back to the same view within the debounce window, skip the
  // release to avoid churn reloads.
  try {
    const prevView = _lastView;
    if (prevView && prevView !== view && _GENERATOR_VIEWS[prevView]) {
      const prevSvc = _GENERATOR_VIEWS[prevView];
      setTimeout(() => {
        if (_lastView === prevView) return; // user came back
        fetch(GPU_API + "/release", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ service: prevSvc }),
        }).catch(() => {});
      }, 600);
    }
  } catch {}
  _lastView = view;

  localStorage.setItem("wooz_view", view);
  const $ = id => document.getElementById(id);

  // Stop any music playback when switching views
  if (typeof stopAllMusicPlayback === "function") stopAllMusicPlayback();
  // Stop any TTS playback (one-shot speakText or streaming chat speaker)
  // so audio doesn't bleed across studio/module switches.
  if (typeof stopAllTts === "function") stopAllTts();

  // Content areas
  chatArea.style.display = view === "chat" ? "" : "none";
  imageStudio.classList.toggle("active", view === "studio");
  musicStudio.classList.toggle("active", view === "music");
  const _vs = document.getElementById("video-studio");
  if (_vs) _vs.classList.toggle("active", view === "video");
  const _nt = document.getElementById("notetaker-view");
  if (_nt) _nt.classList.toggle("active", view === "notetaker");

  // Sidebar nav buttons
  $("new-chat-btn").classList.toggle("active", view === "chat");
  $("studio-sidebar-btn").classList.toggle("active", view === "studio");
  $("music-sidebar-btn").classList.toggle("active", view === "music");
  $("video-sidebar-btn").classList.toggle("active", view === "video");
  $("notetaker-sidebar-btn").classList.toggle("active", view === "notetaker");

  // Chat sections
  $("chat-folders-top-divider").style.display = view === "chat" ? "" : "none";
  $("chat-folders-section").style.display = view === "chat" ? "" : "none";
  $("chat-folders-divider").style.display = view === "chat" ? "" : "none";
  $("conv-header").style.display = view === "chat" ? "" : "none";
  $("conv-list").style.display = view === "chat" ? "" : "none";
  const csw = $("conv-search-wrap");
  if (csw) csw.style.display = view === "chat" ? "" : "none";

  // Image Studio sections
  $("image-folders-top-divider").style.display = view === "studio" ? "" : "none";
  $("image-folders-section").style.display = view === "studio" ? "" : "none";
  $("image-folders-divider").style.display = view === "studio" ? "" : "none";
  $("studio-sessions-header").style.display = view === "studio" ? "" : "none";
  $("studio-sessions-list").style.display = view === "studio" ? "" : "none";

  // Music Studio sections
  $("music-folders-top-divider").style.display = view === "music" ? "" : "none";
  $("music-folders-section").style.display = view === "music" ? "" : "none";
  $("music-folders-divider").style.display = view === "music" ? "" : "none";
  $("music-sessions-header").style.display = view === "music" ? "" : "none";
  $("music-sessions-list").style.display = view === "music" ? "" : "none";

  // Video Studio sections
  $("video-folders-top-divider").style.display = view === "video" ? "" : "none";
  $("video-folders-section").style.display = view === "video" ? "" : "none";
  $("video-folders-divider").style.display = view === "video" ? "" : "none";
  $("video-sessions-header").style.display = view === "video" ? "" : "none";
  $("video-sessions-list").style.display = view === "video" ? "" : "none";

  // Note Taker sections
  $("notetaker-folders-top-divider").style.display = view === "notetaker" ? "" : "none";
  $("notetaker-folders-section").style.display = view === "notetaker" ? "" : "none";
  $("notetaker-folders-divider").style.display = view === "notetaker" ? "" : "none";
  $("notetaker-sessions-header").style.display = view === "notetaker" ? "" : "none";
  $("notetaker-sessions-list").style.display = view === "notetaker" ? "" : "none";

  // Code Studio sections
  const _cds = document.getElementById("code-studio");
  if (_cds) _cds.classList.toggle("active", view === "code");
  $("code-sidebar-btn").classList.toggle("active", view === "code");
  $("code-folders-top-divider").style.display = view === "code" ? "" : "none";
  $("code-folders-section").style.display = view === "code" ? "" : "none";
  $("code-folders-divider").style.display = view === "code" ? "" : "none";
  $("code-sessions-header").style.display = view === "code" ? "" : "none";
  $("code-sessions-list").style.display = view === "code" ? "" : "none";

  // Mobile sidebar
  if (isMobile() && typeof closeMobileSidebar === "function") closeMobileSidebar();

  // Clear all prompt inputs on any studio/module switch so stale drafts
  // don't carry between views.
  const _clearIds = [
    "studio-prompt", "studio-negative",
    "music-prompt", "music-lyrics",
    "video-prompt",
    "code-prompt",
  ];
  for (const id of _clearIds) {
    const el = document.getElementById(id);
    if (el && "value" in el) el.value = "";
  }
  if (typeof input !== "undefined" && input) input.value = "";

  // Focus prompt
  if (view === "studio") studioPrompt.focus();
  else if (view === "music") musicPrompt.focus();
  else if (view === "video") { const vp = document.getElementById("video-prompt"); if (vp) vp.focus(); }
  else if (view === "code") { const cp = document.getElementById("code-prompt"); if (cp) cp.focus(); }
  else input.focus();
}

const _defaultPlaceholders = {
  chat: "Ask something\u2026",
  studio: "Describe the image you want to create...",
  music: "Describe a song idea...",
  video: "Describe the video you want to create...",
  code: "Describe the code you want to generate...",
};

function _escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function _fmtBytes(n) {
  n = Number(n) || 0;
  if (n <= 0) return "";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(0) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function _fmtLoadText(s) {
  if (!s) return "";
  let t = String(s).trim();
  if (!t) return "";
  // Strip trailing dots/ellipsis of any kind.
  t = t.replace(/[.\u2026]+$/, "");
  // Prepend "Loading " if the text doesn't already contain "loading"
  // (case-insensitive). This lets backend phases like "Downloading" or
  // "Loading weights" pass through unchanged while raw model names get
  // a human-friendly prefix.
  if (!/^(loading|moving|downloading|preparing|unloading|initializing)\b/i.test(t)) t = "Loading " + t;
  // Capitalize the first character.
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t + "\u2026";
}

// Cache of display names for fixed-model services, fetched on demand from
// each service's /health endpoint so the frontend doesn't hardcode them.
const _viewDisplayName = {};
async function _getViewDisplayName(view) {
  if (_viewDisplayName[view]) return _viewDisplayName[view];
  try {
    if (view === "notetaker") {
      const r = await mediaFetch("/notetaker/models");
      const d = await r.json();
      const cur = d.current || (Array.isArray(d.models) && d.models[0]) || "";
      _viewDisplayName[view] = cur ? ("Whisper " + cur) : "Whisper";
    } else if (view === "video") {
      const r = await mediaFetch("/video/health");
      const d = await r.json();
      _viewDisplayName[view] = d.display_name || d.current_model || "";
    } else if (view === "music") {
      const r = await mediaFetch("/music/health");
      const d = await r.json();
      _viewDisplayName[view] = d.display_name || d.current_model || "";
    }
  } catch {}
  return _viewDisplayName[view] || null;
}

function _updateModelLoadingText(view, primary, bytes) {
  const selectors = {
    studio: "#studio-prompt-box",
    music: "#music-prompt-box",
    video: "#video-prompt-box",
    notetaker: ".nt-prompt-box",
    chat: "#input-box",
    code: "#code-prompt-box",
  };
  const box = document.querySelector(selectors[view] || "");
  if (!box) return;
  const dots = box.querySelector(".prompt-load-dots");
  if (!dots) return;
  const p = dots.querySelector(".prompt-load-primary");
  const b = dots.querySelector(".prompt-load-bytes");
  if (p && primary) p.textContent = _fmtLoadText(primary);
  if (b) b.textContent = bytes ? _fmtBytes(bytes) : "";
}

let _loadStatusPoller = null;
function _stopLoadStatusPoller() {
  if (_loadStatusPoller) { clearInterval(_loadStatusPoller); _loadStatusPoller = null; }
}
function _startLoadStatusPoller(view, svcName) {
  _stopLoadStatusPoller();
  _loadStatusPoller = setInterval(async () => {
    try {
      const r = await fetch(GPU_API + "/load_status?service=" + encodeURIComponent(svcName));
      if (!r.ok) return;
      const d = await r.json();
      const state = d.state || "";
      const phase = d.phase || "";
      const bytes = d.downloaded_bytes || 0;
      if (state === "downloading") {
        _updateModelLoadingText(view, phase || "Downloading", bytes);
      } else if (state === "loading" && phase) {
        _updateModelLoadingText(view, phase, 0);
      } else if (state === "ready" || state === "error" || state === "idle") {
        // will be cleared when _setModelLoading(false) fires
      }
    } catch {}
  }, 700);
}

function _setModelLoading(view, loading, modelName) {
  if (!loading) _stopLoadStatusPoller();
  const prompt = view === "studio" ? studioPrompt : view === "music" ? musicPrompt : view === "video" ? document.getElementById("video-prompt") : view === "code" ? document.getElementById("code-prompt") : view === "chat" ? input : null;
  const btn = view === "studio" ? studioGenerateBtn : view === "music" ? musicGenerateBtn : view === "video" ? document.getElementById("video-generate-btn") : view === "code" ? document.getElementById("code-generate-btn") : view === "chat" ? sendBtn : null;
  const box = prompt?.closest("#studio-prompt-box, #music-prompt-box, #video-prompt-box, #code-prompt-box, #input-box");
  // Notetaker has no prompt textarea - handle its buttons directly
  if (view === "notetaker") {
    const ntBox = document.querySelector(".nt-prompt-box");
    if (ntBox) {
      // Disable record, transcribe, and source tab buttons
      ntBox.querySelectorAll(".generate-btn, .prompt-action-btn, .nt-source-tab").forEach(b => b.disabled = !!loading);
      const recordSection = ntBox.querySelector(".nt-record-section");
      if (loading) {
        if (recordSection) recordSection.style.opacity = "0.3";
        if (!ntBox.querySelector(".prompt-load-dots")) {
          const dots = document.createElement("span");
          dots.className = "prompt-load-dots";
          dots.style.cssText = "position:absolute;left:14px;top:50%;transform:translateY(-50%);";
          dots.innerHTML = `<span class="step-spinner"></span><span class="prompt-load-text"><span class="prompt-load-primary">${_escapeHtml(_fmtLoadText(modelName || "Loading model"))}</span><span class="prompt-load-bytes"></span></span>`;
          const content = ntBox.querySelector(".nt-prompt-content");
          if (content) { content.style.position = "relative"; content.appendChild(dots); }
        }
      } else {
        if (recordSection) recordSection.style.opacity = "";
        const content = ntBox.querySelector(".nt-prompt-content");
        if (content) content.style.position = "";
        const d = ntBox.querySelector(".prompt-load-dots"); if (d) d.remove();
      }
    }
    return;
  }
  if (prompt) {
    if (loading) {
      prompt.dataset.prevPlaceholder = prompt.placeholder;
      prompt.placeholder = "";
      prompt.classList.add("prompt-locked");
      if (box && !box.querySelector(".prompt-load-dots")) {
        const dots = document.createElement("span");
        dots.className = "prompt-load-dots";
        dots.innerHTML = `<span class="step-spinner"></span><span class="prompt-load-text"><span class="prompt-load-primary">${_escapeHtml(_fmtLoadText(modelName || "Loading model"))}</span><span class="prompt-load-bytes"></span></span>`;
        box.prepend(dots);
      }
    } else {
      prompt.placeholder = prompt.dataset.prevPlaceholder || _defaultPlaceholders[view] || "";
      delete prompt.dataset.prevPlaceholder;
      prompt.classList.remove("prompt-locked");
      if (box) { const d = box.querySelector(".prompt-load-dots"); if (d) d.remove(); }
    }
  }
  if (box) {
    box.querySelectorAll("button").forEach(b => b.disabled = !!loading);
  }
}

let _prepareDebounce = null;
function prepareModelsForView(view) {
  // Debounce rapid view switches - wait 600ms before starting model prep
  if (_prepareDebounce) clearTimeout(_prepareDebounce);
  if (_prepareAbort) { _prepareAbort.abort(); _prepareAbort = null; }
  _prepareDebounce = setTimeout(() => { _prepareModelsForViewNow(view); }, 600);
}
async function _prepareModelsForViewNow(view) {
  // Cancel any in-flight preparation
  if (_prepareAbort) { _prepareAbort.abort(); _prepareAbort = null; }

  // Chat - show loading dots while acquiring, then clear
  if (view === "chat") {
    _modelReady.chat = false;
    const _chatModel = selectedModel || localStorage.getItem("wooz_model") || null;
    const _chatLabel = modelSelect?.options?.[modelSelect.selectedIndex]?.textContent || _chatModel || "chat model";
    _setModelLoading("chat", true, _chatLabel);
    try {
      const resp = await fetch(GPU_API + "/acquire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "chat", model: _chatModel }),
      });
      // Reflect TTS coexistence: a large chat model evicts Orpheus and
      // disables voice; a smaller one re-enables it.
      try {
        const data = await resp.json();
        if (typeof _setChatTtsBlocked === "function") {
          _setChatTtsBlocked(data && data.tts_blocked_by ? data.tts_blocked_by : null);
        }
      } catch {}
    } catch {}
    _modelReady.chat = true;
    _setModelLoading("chat", false);
    return;
  }

  // Don't evict models if a generation is actively running
  if (studioGenerating || _musicGenerating || _videoGenerating || _ntTranscribing || (typeof _codeGenerating !== "undefined" && _codeGenerating) || isLoading) return;

  // Check if target model already loaded
  try {
    const psRes = await fetch(GPU_API + "/status");
    const psData = await psRes.json();
    const loaded = psData.loaded || [];
    if (view === "studio" && loaded.some(m => m.type === "image")) {
      _modelReady.studio = true;
      _setModelLoading("studio", false);
      // Evict other models in background if loaded
      if (loaded.some(m => m.type === "music") || loaded.some(m => m.type === "video") || loaded.some(m => m.type === "notetaker") || loaded.some(m => m.type === "code")) {
        const _savedImgModel = localStorage.getItem("wooz_image_model") || null;
        fetch(GPU_API + "/acquire", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ service: "image", model: _savedImgModel }),
          signal: AbortSignal.timeout(30000),
        }).catch(() => {});
      }
      return;
    }
    if (view === "music" && loaded.some(m => m.type === "music")) {
      _modelReady.music = true;
      _setModelLoading("music", false);
      if (loaded.some(m => m.type === "image") || loaded.some(m => m.type === "video") || loaded.some(m => m.type === "notetaker") || loaded.some(m => m.type === "code")) {
        fetch(GPU_API + "/acquire", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ service: "music" }),
          signal: AbortSignal.timeout(30000),
        }).catch(() => {});
      }
      return;
    }
    if (view === "video" && loaded.some(m => m.type === "video")) {
      _modelReady.video = true;
      _setModelLoading("video", false);
      if (loaded.some(m => m.type === "image") || loaded.some(m => m.type === "music") || loaded.some(m => m.type === "notetaker") || loaded.some(m => m.type === "code")) {
        fetch(GPU_API + "/acquire", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ service: "video" }),
          signal: AbortSignal.timeout(30000),
        }).catch(() => {});
      }
      return;
    }
    if (view === "notetaker" && loaded.some(m => m.type === "notetaker")) {
      _modelReady.notetaker = true;
      _setModelLoading("notetaker", false);
      if (loaded.some(m => m.type === "image") || loaded.some(m => m.type === "music") || loaded.some(m => m.type === "video") || loaded.some(m => m.type === "code")) {
        fetch(GPU_API + "/acquire", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ service: "notetaker" }),
          signal: AbortSignal.timeout(30000),
        }).catch(() => {});
      }
      return;
    }
    if (view === "code") {
      // Code Studio uses Ollama LLM - handle like chat
      _modelReady.code = false;
      const _codeModel = localStorage.getItem("wooz_code_model") || selectedModel || null;
      const _codeSel = document.getElementById("code-model-select");
      const _codeLabel = _codeSel?.options?.[_codeSel.selectedIndex]?.textContent || _codeModel || "code model";
      _setModelLoading("code", true, _codeLabel);
      try {
        await fetch(GPU_API + "/acquire", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ service: "code", model: _codeModel }),
        });
      } catch {}
      _modelReady.code = true;
      _setModelLoading("code", false);
      return;
    }
  } catch {}

  // Model not loaded - show loading in prompt placeholder
  _modelReady[view] = false;
  const _codeSel2 = document.getElementById("code-model-select");
  let modelName = view === "studio"
    ? (studioModelSelect.options[studioModelSelect.selectedIndex]?.textContent || "image model")
    : view === "code" ? (_codeSel2?.options?.[_codeSel2.selectedIndex]?.textContent || localStorage.getItem("wooz_code_model") || "code model")
    : _viewDisplayName[view] || "";
  _setModelLoading(view, true, modelName);
  // For fixed-model services (notetaker/video/music), resolve the real
  // display name from the backend and update the label in place.
  if (["notetaker", "video", "music"].includes(view)) {
    _getViewDisplayName(view).then(name => {
      if (name) _updateModelLoadingText(view, name, 0);
    });
  }

  const abort = new AbortController();
  _prepareAbort = abort;

  const svcName = view === "studio" ? "image" : view;
  setVramAcquiring(svcName, modelName);
  if (["studio", "music", "video", "notetaker"].includes(view)) {
    _startLoadStatusPoller(view, svcName);
  }

  async function _gpuAcquire(service, model) {
    const resp = await fetch(GPU_API + "/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service, ...(model ? { model } : {}) }),
      signal: abort.signal,
    });
    if (resp.status === 403) {
      const data = await resp.json().catch(() => ({}));
      const detail = data.detail || "";
      // Extract repo URL from detail message
      const m = detail.match(/https:\/\/huggingface\.co\/[^\s]+/);
      if (m) showGatedRepoToast(m[0]);
      else showToast("HuggingFace model requires license acceptance", "error");
      return false;
    }
    return true;
  }

  try {
    let ok = true;
    if (view === "studio") {
      const _savedImgModel = localStorage.getItem("wooz_image_model") || null;
      ok = await _gpuAcquire("image", _savedImgModel);
      if (ok && !abort.signal.aborted) {
        _modelReady.studio = true;
        _setModelLoading("studio", false);
      }
    } else if (view === "music") {
      ok = await _gpuAcquire("music");
      if (ok && !abort.signal.aborted) {
        _modelReady.music = true;
        _setModelLoading("music", false);
      }
    } else if (view === "video") {
      ok = await _gpuAcquire("video");
      if (ok && !abort.signal.aborted) {
        _modelReady.video = true;
        _setModelLoading("video", false);
      }
    } else if (view === "notetaker") {
      ok = await _gpuAcquire("notetaker");
      if (ok && !abort.signal.aborted) {
        _modelReady.notetaker = true;
        _setModelLoading("notetaker", false);
      }
    } else if (view === "code") {
      const _codeModel = localStorage.getItem("wooz_code_model") || selectedModel || null;
      ok = await _gpuAcquire("code", _codeModel);
      if (ok && !abort.signal.aborted) {
        _modelReady.code = true;
        _setModelLoading("code", false);
      }
    }
    if (!ok) _setModelLoading(view, false);
  } catch (e) {
    if (e.name !== "AbortError") {
      console.warn("Model preparation failed:", e);
      _setModelLoading(view, false);
    }
  } finally {
    clearVramAcquiring();
  }
}

// View switching wrappers
function _isGenerating() {
  return studioGenerating || _musicGenerating || _videoGenerating || _ntTranscribing || (typeof _codeGenerating !== "undefined" && _codeGenerating);
}

async function _confirmViewSwitch() {
  if (!_isGenerating()) return true;
  return showConfirm({
    title: "Switch View",
    message: "A generation is in progress. Switching views will stop it. Continue?",
    okLabel: "Continue",
    okClass: "primary",
  });
}

async function showStudio() {
  if (!await _confirmViewSwitch()) return;
  setView("studio");
  loadStudioModels();
  loadImageFolders();
  _refreshTrashBadge();
  restoreStudioImages();
  initFavCount();
  prepareModelsForView("studio");
}

async function hideStudio() {
  if (!await _confirmViewSwitch()) return;
  setView("chat");
  prepareModelsForView("chat");
}

async function showMusicStudio() {
  if (!await _confirmViewSwitch()) return;
  setView("music");
  loadMusicFolders();
  renderMusicSessionsList();
  _ensureMusicSession();
  restoreMusicTracks();
  _refreshMusicTrashBadge();
  if (localStorage.getItem("wooz_music_fav_open") === "1") {
    musicFavPanel.classList.add("open");
    musicFavToggle.classList.add("active");
    refreshMusicFavoritesPanel();
  }
  prepareModelsForView("music");
}

async function hideMusicStudio() {
  if (!await _confirmViewSwitch()) return;
  setView("chat");
  prepareModelsForView("chat");
}

async function showVideoStudio() {
  if (!await _confirmViewSwitch()) return;
  setView("video");
  loadVideoFolders();
  renderVideoSessionsList();
  _ensureVideoSession();
  restoreVideoClips();
  _refreshVideoTrashBadge();
  if (localStorage.getItem("wooz_video_fav_open") === "1") {
    const vfp = document.getElementById("video-fav-panel");
    const vft = document.getElementById("video-fav-toggle");
    if (vfp) vfp.classList.add("open");
    if (vft) vft.classList.add("active");
    refreshVideoFavoritesPanel();
  }
  prepareModelsForView("video");
}

async function hideVideoStudio() {
  if (!await _confirmViewSwitch()) return;
  setView("chat");
  prepareModelsForView("chat");
}

async function showNotetaker() {
  if (!await _confirmViewSwitch()) return;
  setView("notetaker");
  if (typeof loadNotetakerFolders === "function") loadNotetakerFolders();
  if (typeof renderNotetakerSessionsList === "function") renderNotetakerSessionsList();
  if (typeof _ensureNotetakerSession === "function") _ensureNotetakerSession();
  if (typeof restoreNotes === "function") restoreNotes();
  if (typeof _refreshNotetakerTrashBadge === "function") _refreshNotetakerTrashBadge();
  prepareModelsForView("notetaker");
}

async function hideNotetaker() {
  if (!await _confirmViewSwitch()) return;
  setView("chat");
  prepareModelsForView("chat");
}

async function showCodeStudio() {
  if (!await _confirmViewSwitch()) return;
  setView("code");
  if (typeof loadCodeFolders === "function") loadCodeFolders();
  if (typeof renderCodeSessionsList === "function") renderCodeSessionsList();
  if (typeof _ensureCodeSession === "function") _ensureCodeSession();
  if (typeof restoreCodeThread === "function") restoreCodeThread();
  if (typeof _refreshCodeTrashBadge === "function") _refreshCodeTrashBadge();
  prepareModelsForView("code");
}

async function hideCodeStudio() {
  if (!await _confirmViewSwitch()) return;
  setView("chat");
  prepareModelsForView("chat");
}

function toggleCodeStudio() {
  const cs = document.getElementById("code-studio");
  if (cs && cs.classList.contains("active")) return;
  showCodeStudio();
}
document.getElementById("code-sidebar-btn").addEventListener("click", toggleCodeStudio);
document.getElementById("strip-code-btn").addEventListener("click", toggleCodeStudio);

function toggleStudio() {
  if (imageStudio.classList.contains("active")) return;
  showStudio();
}
document.getElementById("studio-sidebar-btn").addEventListener("click", toggleStudio);
document.getElementById("strip-studio-btn").addEventListener("click", toggleStudio);
document.getElementById("studio-new-session-btn").addEventListener("click", () => {
  activeStudioSessionId = "sess_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
  localStorage.setItem("wooz_studio_session", activeStudioSessionId);
  document.querySelectorAll(".studio-session-item").forEach(el => el.classList.remove("active"));
  // Clear canvas to show fresh state
  studioCanvas.querySelectorAll(".studio-result").forEach(el => el.remove());
  if (studioCanvasEmpty) studioCanvasEmpty.style.display = "";
  studioPrompt.focus();
});

// ══════════════════════════════════════════════════════════════
// MUSIC STUDIO
// ══════════════════════════════════════════════════════════════

const musicStudio = document.getElementById("music-studio");
const musicCanvas = document.getElementById("music-canvas");
const musicCanvasEmpty = document.getElementById("music-canvas-empty");
const musicPrompt = document.getElementById("music-prompt");
const musicGenerateBtn = document.getElementById("music-generate-btn");
const musicLyrics = document.getElementById("music-lyrics");
const musicFavPanel = document.getElementById("music-fav-panel");
const musicFavToggle = document.getElementById("music-fav-toggle");
const musicFavContent = document.getElementById("music-fav-content");
const musicFavBadge = document.getElementById("music-fav-badge");
const musicFavCountLabel = document.getElementById("music-fav-count-label");

