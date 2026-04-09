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
  } else {
    setView("chat");
  }
  loadModels();
  loadVoices();
  await loadConversations();
  document.documentElement.classList.remove("studio-preload", "music-preload", "video-preload");
}


// ── DOM refs ──
const chatWindow      = document.getElementById("chat-window");
const input           = document.getElementById("message-input");

const sendBtn         = document.getElementById("send-btn");
const webBtn          = document.getElementById("web-btn");
const micBtn          = document.getElementById("mic-btn");
const voiceModeBtn    = document.getElementById("voice-mode-btn");
const attachBtn       = document.getElementById("attach-btn");
const imageFileInput  = document.getElementById("image-file-input");
const imagePreviewBar = document.getElementById("image-preview-bar");
let pendingImages = []; // Array of {dataUrl, file}
let currentModelSupportsVision = false;
const visionIndicator = document.getElementById("vision-indicator");
const modelSelect     = document.getElementById("model-select");
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
const tempSlider      = document.getElementById("temp-slider");
const threshSlider    = document.getElementById("thresh-slider");
const historySlider   = document.getElementById("history-slider");
const compactSlider   = document.getElementById("compact-slider");
const topkSlider      = document.getElementById("topk-slider");
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
const voiceSelect     = document.getElementById("voice-select");

// ── State ──
let isLoading      = false;
let debugMode      = false;
let webSearch      = false;
let activeConvId   = null;
let ctxTargetId    = null;
let selectedModel  = null;
let messageHistory = [];
let historyIndex   = -1;


// ── Centralized view switching ──
const _modelReady = { chat: false, studio: false, music: false, video: false };
let _prepareAbort = null;

function setView(view) {
  localStorage.setItem("wooz_view", view);
  const $ = id => document.getElementById(id);

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
  $("chat-folders-section").style.display = view === "chat" ? "" : "none";
  $("chat-folders-divider").style.display = view === "chat" ? "" : "none";
  $("conv-header").style.display = view === "chat" ? "" : "none";
  $("conv-list").style.display = view === "chat" ? "" : "none";
  const csw = $("conv-search-wrap");
  if (csw) csw.style.display = view === "chat" ? "" : "none";

  // Image Studio sections
  $("image-folders-section").style.display = view === "studio" ? "" : "none";
  $("image-folders-divider").style.display = view === "studio" ? "" : "none";
  $("studio-sessions-header").style.display = view === "studio" ? "" : "none";
  $("studio-sessions-list").style.display = view === "studio" ? "" : "none";

  // Music Studio sections
  $("music-folders-section").style.display = view === "music" ? "" : "none";
  $("music-folders-divider").style.display = view === "music" ? "" : "none";
  $("music-sessions-header").style.display = view === "music" ? "" : "none";
  $("music-sessions-list").style.display = view === "music" ? "" : "none";

  // Video Studio sections
  $("video-folders-section").style.display = view === "video" ? "" : "none";
  $("video-folders-divider").style.display = view === "video" ? "" : "none";
  $("video-sessions-header").style.display = view === "video" ? "" : "none";
  $("video-sessions-list").style.display = view === "video" ? "" : "none";

  // Note Taker sections
  $("notetaker-folders-section").style.display = view === "notetaker" ? "" : "none";
  $("notetaker-folders-divider").style.display = view === "notetaker" ? "" : "none";
  $("notetaker-sessions-header").style.display = view === "notetaker" ? "" : "none";
  $("notetaker-sessions-list").style.display = view === "notetaker" ? "" : "none";

  // Mobile sidebar
  if (isMobile() && typeof closeMobileSidebar === "function") closeMobileSidebar();

  // Focus prompt
  if (view === "studio") studioPrompt.focus();
  else if (view === "music") musicPrompt.focus();
  else if (view === "video") { const vp = document.getElementById("video-prompt"); if (vp) vp.focus(); }
  else input.focus();
}

const _defaultPlaceholders = {
  chat: "Ask something\u2026",
  studio: "Describe the image you want to create...",
  music: "Describe a song idea, or use the pen to have AI write it for you...",
  video: "Describe the video you want to create...",
};

function _setModelLoading(view, loading, modelName) {
  const prompt = view === "studio" ? studioPrompt : view === "music" ? musicPrompt : view === "video" ? document.getElementById("video-prompt") : view === "chat" ? input : null;
  const btn = view === "studio" ? studioGenerateBtn : view === "music" ? musicGenerateBtn : view === "video" ? document.getElementById("video-generate-btn") : view === "chat" ? sendBtn : null;
  const box = prompt?.closest("#studio-prompt-box, #music-prompt-box, #video-prompt-box, #input-box");
  if (prompt) {
    if (loading) {
      prompt.dataset.prevPlaceholder = prompt.placeholder;
      prompt.placeholder = "";
      prompt.classList.add("prompt-locked");
      if (box && !box.querySelector(".prompt-load-dots")) {
        const dots = document.createElement("span");
        dots.className = "prompt-load-dots";
        dots.innerHTML = `<span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="dot"></span>`;
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

async function prepareModelsForView(view) {
  // Cancel any in-flight preparation
  if (_prepareAbort) { _prepareAbort.abort(); _prepareAbort = null; }

  // Chat - show loading dots while acquiring, then clear
  if (view === "chat") {
    _modelReady.chat = false;
    _setModelLoading("chat", true, "chat model");
    const _chatModel = selectedModel || localStorage.getItem("wooz_model") || null;
    try {
      await fetch(GPU_API + "/acquire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "chat", model: _chatModel }),
      });
    } catch {}
    _modelReady.chat = true;
    _setModelLoading("chat", false);
    return;
  }

  // Don't evict models if a generation is actively running
  if (studioGenerating || _musicGenerating || _videoGenerating || isLoading) return;

  // Check if target model already loaded
  try {
    const psRes = await fetch(GPU_API + "/status");
    const psData = await psRes.json();
    const loaded = psData.loaded || [];
    if (view === "studio" && loaded.some(m => m.type === "image")) {
      _modelReady.studio = true;
      _setModelLoading("studio", false);
      // Evict other models in background if loaded
      if (loaded.some(m => m.type === "music") || loaded.some(m => m.type === "video")) {
        const _savedImgModel = localStorage.getItem("wooz_image_model") || null;
        fetch(GPU_API + "/acquire", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ service: "image", model: _savedImgModel }),
        }).catch(() => {});
      }
      return;
    }
    if (view === "music" && loaded.some(m => m.type === "music")) {
      _modelReady.music = true;
      _setModelLoading("music", false);
      if (loaded.some(m => m.type === "image") || loaded.some(m => m.type === "video")) {
        fetch(GPU_API + "/acquire", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ service: "music" }),
        }).catch(() => {});
      }
      return;
    }
    if (view === "video" && loaded.some(m => m.type === "video")) {
      _modelReady.video = true;
      _setModelLoading("video", false);
      if (loaded.some(m => m.type === "image") || loaded.some(m => m.type === "music")) {
        fetch(GPU_API + "/acquire", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ service: "video" }),
        }).catch(() => {});
      }
      return;
    }
  } catch {}

  // Model not loaded - show loading in prompt placeholder
  _modelReady[view] = false;
  const modelName = view === "studio"
    ? (studioModelSelect.options[studioModelSelect.selectedIndex]?.textContent || "image model")
    : view === "video" ? "Wan 2.2" : "ACE-Step";
  _setModelLoading(view, true, modelName);

  const abort = new AbortController();
  _prepareAbort = abort;

  const svcName = view === "studio" ? "image" : view;
  setVramAcquiring(svcName, modelName);

  try {
    if (view === "studio") {
      const _savedImgModel = localStorage.getItem("wooz_image_model") || null;
      await fetch(GPU_API + "/acquire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "image", model: _savedImgModel }),
        signal: abort.signal,
      });
      if (!abort.signal.aborted) {
        _modelReady.studio = true;
        _setModelLoading("studio", false);
      }
    } else if (view === "music") {
      await fetch(GPU_API + "/acquire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "music" }),
        signal: abort.signal,
      });
      if (!abort.signal.aborted) {
        _modelReady.music = true;
        _setModelLoading("music", false);
      }
    } else if (view === "video") {
      await fetch(GPU_API + "/acquire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "video" }),
        signal: abort.signal,
      });
      if (!abort.signal.aborted) {
        _modelReady.video = true;
        _setModelLoading("video", false);
      }
    }
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
  return studioGenerating || _musicGenerating || _videoGenerating;
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
  if (localStorage.getItem("wooz_notetaker_fav_open") === "1") {
    const nfp = document.getElementById("notetaker-fav-panel");
    const nft = document.getElementById("notetaker-fav-toggle");
    if (nfp) nfp.classList.add("open");
    if (nft) nft.classList.add("active");
    if (typeof refreshNotetakerFavoritesPanel === "function") refreshNotetakerFavoritesPanel();
  }
}

async function hideNotetaker() {
  if (!await _confirmViewSwitch()) return;
  setView("chat");
}

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

