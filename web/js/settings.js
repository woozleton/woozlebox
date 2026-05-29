// ── Settings (localStorage) ──
// The legacy wooz_settings blob now only holds keys that live in the
// /settings modal itself (auto_memory, debug). Chat LLM knobs (temperature,
// threshold, history, compact, voice, speed, system prompt) have moved to
// the per-model wooz_chat_model_settings map owned by chat-settings.js.
const SETTINGS_KEY = "wooz_settings";
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    if (s.auto_memory !== undefined) document.getElementById("auto-memory-toggle").checked = s.auto_memory;
    if (s.debug !== undefined) { document.getElementById("debug-toggle").checked = s.debug; debugMode = s.debug; document.body.classList.toggle("debug-on", s.debug); }
    if (s.verbose !== undefined) {
      const vt = document.getElementById("debug-verbose-toggle");
      if (vt) vt.checked = !!s.verbose;
      verboseMode = !!s.verbose;
      document.body.classList.toggle("debug-verbose", verboseMode);
    }
    // Verbose only makes sense when Debug is on. Gate the checkbox's
    // disabled state so it greys out alongside.
    const vt = document.getElementById("debug-verbose-toggle");
    if (vt) vt.disabled = !debugMode;
  } catch {}
  // The VRAM SSE was opened during applyUserSession() BEFORE this
  // function ran, so the initial connection may have been made with
  // the wrong verbose preference. Ask gpu.js to reconcile now that
  // verboseMode has been restored from localStorage.
  if (typeof syncVramSSEVerbose === "function") syncVramSSEVerbose();
  // And repaint the log body so any buffer entries that arrived while
  // the log container was hidden (debug was default-off) become visible.
  if (typeof onVramDebugToggle === "function") onVramDebugToggle();
  // Chat panel UI is hydrated on its own via chat-settings.js once the
  // model list lands; we just refresh label text here in case the panel
  // was rendered before initChatSettings() ran.
  if (typeof updateChatSettingLabels === "function") updateChatSettingLabels();
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    auto_memory:     document.getElementById("auto-memory-toggle").checked,
    debug:           document.getElementById("debug-toggle").checked,
    verbose:         document.getElementById("debug-verbose-toggle")?.checked || false,
  }));
}
// Compatibility shim for slash-commands.js and other callers that still
// invoke updateSettingLabels(). Delegates to the chat-panel updater.
function updateSettingLabels() {
  if (typeof updateChatSettingLabels === "function") updateChatSettingLabels();
}
document.getElementById("auto-memory-toggle").addEventListener("change", () => { saveSettings(); scheduleSettingsSync(); });

// ── Profile (localStorage) ──
const PROFILE_KEY = "wooz_profile";
const AVATAR_KEY  = "wooz_avatar";

function applyAvatar(dataUrl) {
  const initials  = document.getElementById("profile-avatar-initials");
  const img       = document.getElementById("profile-avatar-img");
  const resetBtn  = document.getElementById("avatar-reset-btn");
  if (dataUrl) {
    initials.style.display = "none";
    img.src = dataUrl; img.style.display = "block";
    if (resetBtn) resetBtn.style.display = "flex";
  } else {
    img.style.display = "none";
    initials.style.display = "";
    if (resetBtn) resetBtn.style.display = "none";
    const name = document.getElementById("profile-name").value.trim();
    initials.textContent = name ? name.charAt(0).toUpperCase() : (currentUser?.username?.charAt(0).toUpperCase() || "?");
  }
  // Update all existing user chat bubbles live
  const p = JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}");
  const name = p.name || currentUser?.username || "";
  const fallbackInitials = name.trim().split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 2) || "?";
  const inner = dataUrl
    ? `<img src="${dataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`
    : fallbackInitials;
  document.querySelectorAll("#chat-window .user-avatar-bubble").forEach(el => { el.innerHTML = inner; });
}

function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}");
    if (p.name)     document.getElementById("profile-name").value     = p.name;
    if (p.location) document.getElementById("profile-location").value = p.location;
    if (p.prefs)    document.getElementById("profile-prefs").value    = p.prefs;
  } catch {}
  applyAvatar(localStorage.getItem(AVATAR_KEY));
  // Show account badge + username
  if (currentUser) {
    const badge = document.getElementById("profile-account-badge");
    badge.textContent = currentUser.role === "admin" ? "Administrator" : "User";
    badge.style.background = currentUser.role === "admin" ? "var(--accent-glow)" : "var(--surface3)";
    badge.style.color = currentUser.role === "admin" ? "var(--accent)" : "var(--text-dim)";
  }
}
function saveProfile() {
  localStorage.setItem(PROFILE_KEY, JSON.stringify({
    name:     document.getElementById("profile-name").value.trim(),
    location: document.getElementById("profile-location").value.trim(),
    prefs:    document.getElementById("profile-prefs").value.trim(),
  }));
  // Update avatar initials live
  applyAvatar(localStorage.getItem(AVATAR_KEY));
}
function getProfileContext() {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}");
    const parts = [];
    if (p.name)     parts.push(`Name: ${p.name}`);
    if (p.location) parts.push(`Location: ${p.location}`);
    if (p.prefs)    parts.push(`Preferences: ${p.prefs}`);
    return parts.join("\n") || null;
  } catch { return null; }
}
["profile-name","profile-location","profile-prefs"].forEach(id => {
  document.getElementById(id).addEventListener("input", () => { saveProfile(); scheduleSettingsSync(); });
});

// Avatar upload
const avatarCircle  = document.getElementById("profile-avatar-circle");
const avatarOverlay = document.getElementById("profile-avatar-overlay");
const avatarInput   = document.getElementById("avatar-file-input");
avatarCircle.addEventListener("mouseenter", () => { avatarOverlay.style.display = "flex"; });
avatarCircle.addEventListener("mouseleave", () => { avatarOverlay.style.display = "none"; });
avatarOverlay.addEventListener("mouseenter", () => { avatarOverlay.style.display = "flex"; });
avatarOverlay.addEventListener("mouseleave", () => { avatarOverlay.style.display = "none"; });
avatarCircle.addEventListener("click", () => avatarInput.click());
avatarOverlay.addEventListener("click", () => avatarInput.click());
avatarInput.addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const img = new Image();
    img.onload = () => {
      const MAX = 128;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      localStorage.setItem(AVATAR_KEY, dataUrl);
      applyAvatar(dataUrl);
      scheduleSettingsSync();
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
});

document.getElementById("avatar-reset-btn").addEventListener("click", e => {
  e.stopPropagation();
  localStorage.removeItem(AVATAR_KEY);
  avatarInput.value = "";
  applyAvatar(null);
  scheduleSettingsSync();
});


// ── Logo customization ──
const LOGO_KEY = "wooz_logo";
function applyLogo(dataUrl) {
  const letter     = document.getElementById("logo-letter");
  const img        = document.getElementById("logo-img");
  const title      = document.getElementById("sidebar-title");
  const prev       = document.getElementById("logo-preview");
  const prevLetter = document.getElementById("logo-letter-preview");
  const reset      = document.getElementById("logo-reset-btn");
  if (dataUrl) {
    letter.style.display = "none";
    img.src = dataUrl; img.style.display = "block";
    // Hide the text name when a logo image is present - wide logos act as the wordmark
    if (title) title.style.display = "none";
    if (prev) { prev.src = dataUrl; prev.style.display = "block"; }
    if (prevLetter) prevLetter.style.display = "none";
    if (reset) reset.style.display = "flex";
  } else {
    letter.style.display = "";
    img.style.display = "none";
    // Restore title visibility based on brand preference
    if (title) {
      const showSidebarName = (JSON.parse(localStorage.getItem("wooz_brand") || "{}").showSidebarName !== false);
      title.style.display = showSidebarName ? "" : "none";
    }
    if (prev) prev.style.display = "none";
    if (prevLetter) prevLetter.style.display = "";
    if (reset) reset.style.display = "none";
  }
}

const LOGIN_LOGO_KEY = "wooz_login_logo";
function applyLoginLogo(dataUrl) {
  const prev       = document.getElementById("login-logo-preview");
  const prevLetter = document.getElementById("login-logo-letter-preview");
  const reset      = document.getElementById("login-logo-reset-btn");
  const authLetters = ["auth-logo-letter-setup", "auth-logo-letter-login"].map(id => document.getElementById(id));
  const authImgs    = ["auth-logo-img-setup",    "auth-logo-img-login"   ].map(id => document.getElementById(id));
  const authNames   = ["auth-app-name-setup",    "auth-app-name-login"   ].map(id => document.getElementById(id));
  if (dataUrl) {
    if (prev) { prev.src = dataUrl; prev.style.display = "block"; }
    if (prevLetter) prevLetter.style.display = "none";
    if (reset) reset.style.display = "flex";
    authLetters.forEach(el => { if (el) el.style.display = "none"; });
    authImgs.forEach(el => { if (el) { el.src = dataUrl; el.style.display = ""; } });
    // Hide app name on login screen when a logo image is present
    authNames.forEach(el => { if (el) el.style.display = "none"; });
  } else {
    if (prev) prev.style.display = "none";
    if (prevLetter) prevLetter.style.display = "";
    if (reset) reset.style.display = "none";
    authLetters.forEach(el => { if (el) el.style.display = ""; });
    authImgs.forEach(el => { if (el) { el.src = ""; el.style.display = "none"; } });
    // Restore name visibility based on brand preference
    const showLoginName = (JSON.parse(localStorage.getItem("wooz_brand") || "{}").showLoginName !== false);
    authNames.forEach(el => { if (el) el.style.display = showLoginName ? "" : "none"; });
  }
}
// Logo hover + click
const logoWrap = document.getElementById("logo-upload-wrap");
const logoOverlay = document.getElementById("logo-upload-overlay");
const logoInput = document.getElementById("logo-file-input");
logoWrap.addEventListener("mouseenter", () => logoOverlay.style.display = "flex");
logoWrap.addEventListener("mouseleave", () => logoOverlay.style.display = "none");
logoWrap.addEventListener("click", () => logoInput.click());
logoInput.addEventListener("change", e => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => { localStorage.setItem(LOGO_KEY, ev.target.result); applyLogo(ev.target.result); scheduleSettingsSync(); };
  reader.readAsDataURL(file);
});
document.getElementById("logo-reset-btn").addEventListener("click", e => {
  e.stopPropagation();
  localStorage.removeItem(LOGO_KEY);
  applyLogo(null);
  logoInput.value = "";
  scheduleSettingsSync();
});

// Login logo hover + click
const loginLogoWrap    = document.getElementById("login-logo-upload-wrap");
const loginLogoOverlay = document.getElementById("login-logo-upload-overlay");
const loginLogoInput   = document.getElementById("login-logo-file-input");
loginLogoWrap.addEventListener("mouseenter", () => loginLogoOverlay.style.display = "flex");
loginLogoWrap.addEventListener("mouseleave", () => loginLogoOverlay.style.display = "none");
loginLogoWrap.addEventListener("click", () => loginLogoInput.click());
loginLogoInput.addEventListener("change", e => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => { localStorage.setItem(LOGIN_LOGO_KEY, ev.target.result); applyLoginLogo(ev.target.result); scheduleSettingsSync(); };
  reader.readAsDataURL(file);
});
document.getElementById("login-logo-reset-btn").addEventListener("click", e => {
  e.stopPropagation();
  localStorage.removeItem(LOGIN_LOGO_KEY);
  applyLoginLogo(null);
  loginLogoInput.value = "";
  scheduleSettingsSync();
});

// ── Favicon customization ──
const FAVICON_KEY = "wooz_favicon";
function makeFaviconFromLetter(ch) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#7c6af7";
  ctx.fillStyle = accent;
  ctx.beginPath(); ctx.roundRect(0, 0, 64, 64, 14); ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 36px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(ch, 32, 34);
  return canvas.toDataURL("image/png");
}
function applyFavicon(dataUrl) {
  let link = document.querySelector("link[rel~='icon']");
  if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.appendChild(link); }
  const prev   = document.getElementById("favicon-preview");
  const letter = document.getElementById("favicon-letter");
  const reset  = document.getElementById("favicon-reset-btn");
  if (dataUrl) {
    link.href = dataUrl;
    if (prev)   { prev.src = dataUrl; prev.style.display = "block"; }
    if (letter) letter.style.display = "none";
    if (reset)  reset.style.display = "flex";
  } else {
    const ch = (JSON.parse(localStorage.getItem(BRAND_KEY) || "{}").name || "W").trim().charAt(0).toUpperCase();
    link.href = makeFaviconFromLetter(ch);
    if (prev)   prev.style.display = "none";
    if (letter) letter.style.display = "";
    if (reset)  reset.style.display = "none";
  }
}
// Favicon hover + click
const faviconWrap = document.getElementById("favicon-upload-wrap");
const faviconOverlay = document.getElementById("favicon-upload-overlay");
const faviconInput = document.getElementById("favicon-file-input");
faviconWrap.addEventListener("mouseenter", () => faviconOverlay.style.display = "flex");
faviconWrap.addEventListener("mouseleave", () => faviconOverlay.style.display = "none");
faviconWrap.addEventListener("click", () => faviconInput.click());
faviconInput.addEventListener("change", e => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => { localStorage.setItem(FAVICON_KEY, ev.target.result); applyFavicon(ev.target.result); scheduleSettingsSync(); };
  reader.readAsDataURL(file);
});
document.getElementById("favicon-reset-btn").addEventListener("click", e => {
  e.stopPropagation();
  localStorage.removeItem(FAVICON_KEY);
  applyFavicon(null);
  faviconInput.value = "";
  scheduleSettingsSync();
});
// ── AI Avatar ──
const AI_AVATAR_KEY = "wooz_ai_avatar";
function applyAIAvatar(dataUrl) {
  // Update settings widget
  const letter  = document.getElementById("ai-avatar-letter");
  const preview = document.getElementById("ai-avatar-preview");
  const reset   = document.getElementById("ai-avatar-reset-btn");
  if (dataUrl) {
    if (letter)  letter.style.display = "none";
    if (preview) { preview.src = dataUrl; preview.style.display = "block"; }
    if (reset)   reset.style.display = "flex";
  } else {
    if (letter)  letter.style.display = "";
    if (preview) { preview.src = ""; preview.style.display = "none"; }
    if (reset)   reset.style.display = "none";
  }
  // Update all existing chat bubbles live
  const fallbackLetter = (JSON.parse(localStorage.getItem("wooz_brand") || "{}").name || "W").trim().charAt(0).toUpperCase();
  const inner = dataUrl
    ? `<img src="${dataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`
    : fallbackLetter;
  document.querySelectorAll("#chat-window .ai-avatar-bubble").forEach(el => { el.innerHTML = inner; });
}
applyAIAvatar(localStorage.getItem(AI_AVATAR_KEY));
const aiAvatarWrap    = document.getElementById("ai-avatar-upload-wrap");
const aiAvatarOverlay = document.getElementById("ai-avatar-upload-overlay");
const aiAvatarInput   = document.getElementById("ai-avatar-file-input");
if (aiAvatarWrap) {
  aiAvatarWrap.addEventListener("mouseenter", () => aiAvatarOverlay.style.display = "flex");
  aiAvatarWrap.addEventListener("mouseleave", () => aiAvatarOverlay.style.display = "none");
  aiAvatarWrap.addEventListener("click", () => aiAvatarInput.click());
}
if (aiAvatarInput) {
  aiAvatarInput.addEventListener("change", e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { localStorage.setItem(AI_AVATAR_KEY, ev.target.result); applyAIAvatar(ev.target.result); scheduleSettingsSync(); };
    reader.readAsDataURL(file);
  });
}
document.getElementById("ai-avatar-reset-btn")?.addEventListener("click", e => {
  e.stopPropagation();
  localStorage.removeItem(AI_AVATAR_KEY);
  applyAIAvatar(null);
  if (aiAvatarInput) aiAvatarInput.value = "";
  scheduleSettingsSync();
});

// ── Accent color ──
const ACCENT_KEY = "wooz_accent";
function applyAccent(color) {
  document.documentElement.style.setProperty("--accent", color);
  document.documentElement.style.setProperty("--accent-dim", color + "99");
  const r = parseInt(color.slice(1,3),16), g = parseInt(color.slice(3,5),16), b = parseInt(color.slice(5,7),16);
  if (!isNaN(r)) document.documentElement.style.setProperty("--accent-glow", `rgba(${r},${g},${b},0.15)`);
  document.querySelectorAll(".color-swatch").forEach(s => {
    s.classList.toggle("active", s.dataset.color === color);
  });
  const customPicker = document.getElementById("accent-custom");
  if (customPicker) customPicker.value = color;
}
const ACCENT_KEY_INIT = localStorage.getItem(ACCENT_KEY);
if (ACCENT_KEY_INIT) applyAccent(ACCENT_KEY_INIT);
document.querySelectorAll(".color-swatch[data-color]").forEach(s => {
  s.addEventListener("click", () => {
    localStorage.setItem(ACCENT_KEY, s.dataset.color);
    applyAccent(s.dataset.color);
    scheduleSettingsSync();
  });
});
document.getElementById("accent-custom").addEventListener("input", e => {
  localStorage.setItem(ACCENT_KEY, e.target.value);
  applyAccent(e.target.value);
  scheduleSettingsSync();
});


// ── Settings panel ──
function openSettings() {
  closeVaultPanel();
  if (isMobile()) closeMobileSidebar();
  settingsPanel.classList.add("open");
  loadMemory();
  if (currentUser?.role === "admin") { loadAdminUsers(); loadAdminDefaults(); loadPromptTemplates(); }
}
function closeSettings() {
  settingsPanel.classList.remove("open");
}

settingsBtn.addEventListener("click", openSettings);
settingsClose.addEventListener("click", closeSettings);
document.getElementById("settings-nav-close")?.addEventListener("click", closeSettings);
overlay.addEventListener("click", () => { closeVaultPanel(); });

// Nav switching
document.querySelectorAll(".settings-nav-item[data-pane]").forEach(item => {
  item.addEventListener("click", () => {
    document.querySelectorAll(".settings-nav-item").forEach(i => i.classList.remove("active"));
    document.querySelectorAll(".settings-pane").forEach(p => p.classList.remove("active"));
    item.classList.add("active");
    document.getElementById("pane-" + item.dataset.pane).classList.add("active");
    if (item.dataset.pane === "developer") checkHealth();
  });
});
document.getElementById("dev-refresh-btn")?.addEventListener("click", checkHealth);

// Voice list + preview are owned by chat-settings.js (loadChatVoices()).
// The notetaker voice select is also populated from that same call so both
// scopes stay in sync with /tts/voices.

// ── Debug toggle ──
const debugToggle = document.getElementById("debug-toggle");
const verboseToggle = document.getElementById("debug-verbose-toggle");
debugToggle.addEventListener("change", () => {
  debugMode = debugToggle.checked;
  document.body.classList.toggle("debug-on", debugMode);
  // Verbose is a sub-setting of Debug. Disable and force-off when
  // Debug is off so the verbose stream can't run invisibly.
  if (verboseToggle) {
    verboseToggle.disabled = !debugMode;
    if (!debugMode && verboseToggle.checked) {
      verboseToggle.checked = false;
      verboseMode = false;
      document.body.classList.remove("debug-verbose");
      if (typeof reconnectVramSSE === "function") reconnectVramSSE();
    }
  }
  if (typeof onVramDebugToggle === "function") onVramDebugToggle();
  saveSettings(); scheduleSettingsSync();
});
if (verboseToggle) {
  verboseToggle.addEventListener("change", () => {
    verboseMode = verboseToggle.checked;
    document.body.classList.toggle("debug-verbose", verboseMode);
    // Flipping verbose requires a new SSE connection because the
    // server uses ?verbose= to decide what to fan out.
    if (typeof reconnectVramSSE === "function") reconnectVramSSE();
    saveSettings(); scheduleSettingsSync();
  });
}

// ── Show/hide VRAM status widget ──
const SHOW_VRAM_KEY = "wooz_show_vram";
function applyShowVram(show) {
  document.body.classList.toggle("vram-hidden", !show);
  const cb = document.getElementById("show-vram-toggle");
  if (cb) cb.checked = !!show;
}
const _savedShowVram = localStorage.getItem(SHOW_VRAM_KEY);
applyShowVram(_savedShowVram === null ? true : _savedShowVram === "true");
const showVramToggle = document.getElementById("show-vram-toggle");
if (showVramToggle) {
  showVramToggle.addEventListener("change", () => {
    localStorage.setItem(SHOW_VRAM_KEY, showVramToggle.checked ? "true" : "false");
    applyShowVram(showVramToggle.checked);
    scheduleSettingsSync();
  });
}

// ── Web search toggle ──
const webCaution = document.getElementById("web-caution");
webBtn.addEventListener("click", () => {
  webSearch = !webSearch;
  webBtn.classList.toggle("active", webSearch);
  webBtn.title = webSearch ? "Web search ON, click to disable" : "Toggle web search";
  webCaution?.classList.toggle("visible", webSearch);
});


// ── RAG / File Vault toggle ──
let ragSearch = false;
const ragToggleBtn = document.getElementById("rag-toggle-btn");
ragToggleBtn.addEventListener("click", () => {
  ragSearch = !ragSearch;
  ragToggleBtn.classList.toggle("active", ragSearch);
  ragToggleBtn.title = ragSearch ? "File Vault active" : "File Vault off";
  // Regenerate suggestions if on welcome screen
  if (!activeConvId) loadSuggestions();
});

// ── Health check ──
async function updateContextBar(convId) {
  if (!convId) return;
  const wrap  = document.getElementById("ctx-bar-wrap");
  const arc   = document.getElementById("ctx-pie-arc");
  const label = document.getElementById("ctx-label");
  try {
    const model = selectedModel || "";
    const params = new URLSearchParams({ conversation_id: convId });
    if (model) params.set("model", model);
    // Report usage against the chosen context window, not the model's max.
    const cfg = (typeof loadChatModelSettings === "function") ? loadChatModelSettings(model) : null;
    if (cfg && cfg.num_ctx) params.set("num_ctx", cfg.num_ctx);
    const res = await apiFetch(`/context-info?${params}`);
    const data = await res.json();
    const pct = Math.min(data.percent, 100);
    const circumference = 2 * Math.PI * 6; // r=6 → ~37.7
    const filled = (pct / 100) * circumference;
    const color = pct > 80 ? "var(--danger)" : pct > 60 ? "#f59e0b" : "var(--accent)";
    wrap.style.display = "flex";
    arc.setAttribute("stroke-dasharray", `${filled.toFixed(1)} ${circumference.toFixed(1)}`);
    arc.setAttribute("stroke", color);
    label.textContent = `${pct}% context`;
    label.style.color = pct > 80 ? "var(--danger)" : pct > 60 ? "#f59e0b" : "var(--text-faint)";
  } catch { /* silently ignore */ }
}

function showDevSkeleton() {
  const SKEL = `<div class="skel-row" style="width:80%;"></div><div class="skel-row" style="width:65%;"></div><div class="skel-row" style="width:72%;"></div>`;
  const list = document.getElementById("service-status-list");
  const apiList = document.getElementById("api-status-list");
  if (list) list.innerHTML = SKEL;
  if (apiList) apiList.innerHTML = `<div class="skel-row" style="width:60%;"></div>`;
}

async function checkHealth() {
  const list = document.getElementById("service-status-list");
  const apiList = document.getElementById("api-status-list");
  const refreshBtn = document.getElementById("dev-refresh-btn");
  const ROW = `display:grid;grid-template-columns:16px 1fr auto auto auto;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);`;
  showDevSkeleton();
  if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.textContent = "…"; }
  if (list) {
    try {
      const res = await apiFetch(`/containers`);
      if (!res.ok) throw new Error();
      const containers = await res.json();
      list.innerHTML = containers.map((c, i, arr) => {
        const running = c.status === "running";
        const dot = `<span class="dot ${running ? 'green' : 'orange'}"></span>`;
        const cpu = c.cpu !== null && c.cpu !== undefined ? `<span style="font-size:0.68rem;color:var(--text-faint);min-width:54px;text-align:right;">${c.cpu}% CPU</span>` : `<span></span>`;
        const uptime = c.uptime ? `<span style="font-size:0.68rem;color:var(--text-faint);min-width:52px;text-align:right;">${c.uptime}</span>` : `<span></span>`;
        const restartBtn = `<button onclick="restartContainer('${esc(c.name)}')" title="Restart" style="background:none;border:1px solid var(--border);border-radius:4px;color:var(--text-dim);cursor:pointer;font-size:0.65rem;padding:1px 6px;line-height:1.6;">↺</button>`;
        const row = ROW + (i === arr.length - 1 ? "border-bottom:none;" : "");
        return `<div style="${row}">${dot}<span>${esc(c.name)}</span>${cpu}${uptime}${restartBtn}</div>`;
      }).join("");
    } catch (e) {
      list.innerHTML = `<div style="color:var(--danger)">Unavailable</div>`;
    }
  }
  if (apiList) {
    try {
      const res = await apiFetch(`/apis`);
      if (!res.ok) throw new Error();
      const apis = await res.json();
      apiList.innerHTML = apis.map(a => {
        const ok = a.online;
        const dot = `<span class="dot ${ok ? 'green' : 'orange'}"></span>`;
        const status = `<span style="font-size:0.7rem;color:${ok ? 'var(--success)' : 'var(--danger)'};text-align:right;">${ok ? 'Online' : a.configured ? 'Unreachable' : 'Not configured'}</span>`;
        return `<div style="display:grid;grid-template-columns:16px 1fr auto;align-items:center;gap:8px;">${dot}<span>${esc(a.name)}</span>${status}</div>`;
      }).join("");
    } catch (e) {
      apiList.innerHTML = `<div style="color:var(--danger)">Unavailable</div>`;
    }
  }
  if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = "↺ Refresh"; }
}

async function restartContainer(name) {
  if (!confirm(`Restart container "${name}"?`)) return;
  try {
    await apiFetch(`/containers/${encodeURIComponent(name)}/restart`, { method: "POST" });
    setTimeout(checkHealth, 3000);
  } catch (e) {
    alert("Restart failed: " + e.message);
  }
}


// ── Text size ──
const TEXT_SIZE_KEY = "wooz_text_size";
const TEXT_SIZES = ["small", "medium", "large", "xlarge"];
const TEXT_SIZE_LABELS = ["Small", "Medium", "Large", "X-Large"];
function applyTextSize(size) {
  document.documentElement.classList.remove("text-small","text-medium","text-large","text-xlarge");
  document.documentElement.classList.add(`text-${size}`);
  localStorage.setItem(TEXT_SIZE_KEY, size);
  const idx = TEXT_SIZES.indexOf(size);
  const slider = document.getElementById("text-size-slider");
  if (slider) slider.value = idx >= 0 ? idx : 1;
  const lbl = document.getElementById("text-size-val");
  if (lbl) lbl.textContent = TEXT_SIZE_LABELS[idx >= 0 ? idx : 1];
}
const textSizeSlider = document.getElementById("text-size-slider");
if (textSizeSlider) {
  textSizeSlider.addEventListener("input", () => {
    applyTextSize(TEXT_SIZES[parseInt(textSizeSlider.value)]);
    scheduleSettingsSync();
  });
}
applyTextSize(localStorage.getItem(TEXT_SIZE_KEY) || "medium");

// ── Themes ──
const THEME_KEY = "wooz_theme";
const THEMES = {
  midnight: { "--bg": "#0d1117", "--surface": "#161b22", "--surface2": "#1c2230", "--surface3": "#21283a", "--border": "#30363d", "--text": "#e6edf3", "--text-dim": "#7d8590", "--accent": "#58a6ff", "--user-bubble": "#161d2e", "--ai-bubble": "#13181f" },
  slate:    { "--bg": "#0f1117", "--surface": "#1e2433", "--surface2": "#252c3d", "--surface3": "#2c3347", "--border": "#363d50", "--text": "#e2e5ed", "--text-dim": "#7a8394", "--accent": "#94a3b8", "--user-bubble": "#202840", "--ai-bubble": "#1a2030" },
  forest:   { "--bg": "#0d1a10", "--surface": "#122018", "--surface2": "#182b1e", "--surface3": "#1f3626", "--border": "#2a4a35", "--text": "#dff0e4", "--text-dim": "#7daa89", "--accent": "#4ade80", "--user-bubble": "#132b1a", "--ai-bubble": "#101e14" },
  dark:     { "--bg": "#12121e", "--surface": "#1a1a2e", "--surface2": "#1f1f33", "--surface3": "#26263a", "--border": "#2e2e45", "--text": "#e8e8f0", "--text-dim": "#888898", "--accent": "#7c6af7", "--user-bubble": "#1e1a40", "--ai-bubble": "#1a1a24" },
  ember:    { "--bg": "#160e08", "--surface": "#211508", "--surface2": "#2a1c0e", "--surface3": "#352414", "--border": "#4a3018", "--text": "#f5e8d0", "--text-dim": "#b08060", "--accent": "#f97316", "--user-bubble": "#2e1a08", "--ai-bubble": "#1c1008" },
  rose:     { "--bg": "#180a12", "--surface": "#221020", "--surface2": "#2c1428", "--surface3": "#371830", "--border": "#4d2040", "--text": "#f9e4ef", "--text-dim": "#c07898", "--accent": "#fb7185", "--user-bubble": "#30101e", "--ai-bubble": "#200c18" },
  parchment: { "--bg": "#f5f0e1", "--surface": "#faf6eb", "--surface2": "#efe9d8", "--surface3": "#e6dfc9", "--border": "#d5ccb0", "--text": "#3b3527", "--text-dim": "#7a7262", "--accent": "#a0782a", "--user-bubble": "#ece5cf", "--ai-bubble": "#f2edd9" },
  light:    { "--bg": "#f0f0f5", "--surface": "#ffffff", "--surface2": "#f4f4f8", "--surface3": "#e8e8ef", "--border": "#d4d4de", "--text": "#1a1a2e", "--text-dim": "#555568", "--accent": "#7c6af7", "--user-bubble": "#ebe8ff", "--ai-bubble": "#f4f4f8" },
  // Wild themes
  cyber:      { "--bg": "#0a0a0f", "--surface": "#0d0d18", "--surface2": "#111122", "--surface3": "#16162e", "--border": "#00fff230", "--text": "#00fff2", "--text-dim": "#0088aa", "--accent": "#ff00ff", "--user-bubble": "#1a002a", "--ai-bubble": "#0a0a18" },
  beach:      { "--bg": "#fef9f0", "--surface": "#fff8eb", "--surface2": "#ffefd0", "--surface3": "#ffe4b5", "--border": "#e0c998", "--text": "#3b2e1a", "--text-dim": "#8b7355", "--accent": "#ff6b35", "--user-bubble": "#fff0d6", "--ai-bubble": "#fef5e7" },
  underwater: { "--bg": "#020e1a", "--surface": "#041628", "--surface2": "#061e35", "--surface3": "#082640", "--border": "#0a4070", "--text": "#b8e8ff", "--text-dim": "#4a90b8", "--accent": "#00d4ff", "--user-bubble": "#0a2038", "--ai-bubble": "#041822" },
  neon:       { "--bg": "#0a000a", "--surface": "#120012", "--surface2": "#1a001a", "--surface3": "#220022", "--border": "#ff00ff30", "--text": "#ff88ff", "--text-dim": "#aa44aa", "--accent": "#ffff00", "--user-bubble": "#200030", "--ai-bubble": "#100018" },
  aurora:     { "--bg": "#040812", "--surface": "#081020", "--surface2": "#0c1830", "--surface3": "#102040", "--border": "#1a3855", "--text": "#d0f0e8", "--text-dim": "#5aaa90", "--accent": "#50ff80", "--user-bubble": "#0a2020", "--ai-bubble": "#061418" },
  sunset:     { "--bg": "#1a0a0a", "--surface": "#241010", "--surface2": "#2e1515", "--surface3": "#381a1a", "--border": "#5a2020", "--text": "#ffd8c8", "--text-dim": "#c08060", "--accent": "#ff4500", "--user-bubble": "#301818", "--ai-bubble": "#200e0e" },
  arctic:     { "--bg": "#f0f7ff", "--surface": "#ffffff", "--surface2": "#e8f2ff", "--surface3": "#d8eaff", "--border": "#b0d0f0", "--text": "#1a2a40", "--text-dim": "#5577aa", "--accent": "#0088ff", "--user-bubble": "#dce8ff", "--ai-bubble": "#eaf2ff" },
  matrix:     { "--bg": "#000800", "--surface": "#001000", "--surface2": "#001800", "--surface3": "#002000", "--border": "#00ff0025", "--text": "#00ff00", "--text-dim": "#008800", "--accent": "#00ff00", "--user-bubble": "#002200", "--ai-bubble": "#000e00" },
  lavender:   { "--bg": "#f4f0ff", "--surface": "#faf7ff", "--surface2": "#ede6ff", "--surface3": "#e0d6ff", "--border": "#c8b8ee", "--text": "#2d2245", "--text-dim": "#7a6aaa", "--accent": "#8b5cf6", "--user-bubble": "#e8deff", "--ai-bubble": "#f2ecff" },
  volcano:    { "--bg": "#120800", "--surface": "#1a0e04", "--surface2": "#221408", "--surface3": "#2e1a0a", "--border": "#5a3010", "--text": "#ffd0a0", "--text-dim": "#aa7040", "--accent": "#ff3c00", "--user-bubble": "#2a1508", "--ai-bubble": "#1a0c02" },
};
const WILD_THEMES = new Set(["cyber", "beach", "underwater", "neon", "aurora", "sunset", "arctic", "matrix", "lavender", "volcano"]);
function themeIsLight(name) {
  const hex = (THEMES[name] && THEMES[name]["--bg"]) || "";
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  // Rec.709 luma, 0-255. > ~160 ≈ light background.
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 160;
}
function applyTheme(name, skipAccent = false) {
  const t = THEMES[name];
  if (!t) return;
  Object.entries(t).forEach(([k, v]) => {
    if (k === "--accent") return; // always handled by applyAccent
    document.documentElement.style.setProperty(k, v);  // includes --user-bubble, --ai-bubble
  });
  if (!skipAccent) {
    applyAccent(t["--accent"]);
    localStorage.setItem(ACCENT_KEY, t["--accent"]);
  } else {
    const savedAccent = localStorage.getItem(ACCENT_KEY);
    if (savedAccent) applyAccent(savedAccent);
  }
  // Set wild theme data attribute for special CSS effects
  if (WILD_THEMES.has(name)) document.body.setAttribute("data-wild-theme", name);
  else document.body.removeAttribute("data-wild-theme");
  localStorage.setItem(THEME_KEY, name);
  document.querySelectorAll(".theme-preset").forEach(p => p.classList.toggle("active", p.dataset.theme === name));
  // When color mode is on "auto", re-resolve against the new theme's luminance.
  if (typeof applyColorMode === "function") {
    const saved = localStorage.getItem("wooz_color_mode");
    if (!saved || saved === "auto") applyColorMode("auto");
  }
}
document.querySelectorAll(".theme-preset[data-theme]").forEach(p => {
  p.addEventListener("click", () => {
    applyTheme(p.dataset.theme);
    scheduleSettingsSync();
  });
});
const savedTheme = localStorage.getItem(THEME_KEY);
if (savedTheme && THEMES[savedTheme]) applyTheme(savedTheme, true);

// ── Color mode (light / dark / auto) ──
// Orthogonal to the preset THEME picker above. Drives :root[data-theme]
// which controls the base palette. Preset themes (if selected) override
// via inline styles; unsetting one falls back to the mode palette.
const COLOR_MODE_KEY = "wooz_color_mode";
function applyColorMode(mode) {
  const stored = (mode === "light" || mode === "dark" || mode === "auto") ? mode : "auto";
  // Resolve "auto" to the opposite of the active theme's luminance:
  // light themes → dark mode, dark themes → light mode.
  let resolved = stored;
  if (stored === "auto") {
    const themeName = localStorage.getItem("wooz_theme");
    resolved = (themeName && themeIsLight(themeName)) ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", resolved);
  localStorage.setItem("wooz_color_mode", stored);
  document.querySelectorAll("#color-mode-seg button[data-mode]").forEach(b => {
    b.classList.toggle("active", b.dataset.mode === stored);
  });
  const val = document.getElementById("color-mode-val");
  if (val) val.textContent = stored.charAt(0).toUpperCase() + stored.slice(1);
}
document.querySelectorAll("#color-mode-seg button[data-mode]").forEach(b => {
  b.addEventListener("click", () => {
    applyColorMode(b.dataset.mode);
    scheduleSettingsSync();
  });
});
applyColorMode(localStorage.getItem(COLOR_MODE_KEY) || "auto");

// ── App name / branding ──
const BRAND_KEY = "wooz_brand";
function saveBrand(patch) {
  const saved = JSON.parse(localStorage.getItem(BRAND_KEY) || "{}");
  localStorage.setItem(BRAND_KEY, JSON.stringify({ ...saved, ...patch }));
  scheduleSettingsSync();
}
function applyBrand() {
  const saved = JSON.parse(localStorage.getItem(BRAND_KEY) || "{}");
  const name = saved.name || "";
  const showSidebarName = saved.showSidebarName !== false;
  const showLoginName   = saved.showLoginName   !== false;

  // Browser tab always uses name
  if (name) document.title = name;

  // Update logo letter to match first character of app name
  applyLogoLetter(name);

  // Sidebar title visibility
  const sidebarTitle = document.getElementById("sidebar-title");
  if (sidebarTitle) {
    if (name) sidebarTitle.textContent = name;
    sidebarTitle.style.display = showSidebarName ? "" : "none";
  }

  // Login/setup name visibility
  ["auth-app-name-setup", "auth-app-name-login"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (name) el.textContent = name;
    el.style.display = showLoginName ? "" : "none";
  });

  // Restore inputs
  const inp = document.getElementById("app-name-input");
  if (inp) inp.value = name;
  const snt = document.getElementById("sidebar-name-toggle");
  if (snt) snt.checked = showSidebarName;
  const lnt = document.getElementById("login-name-toggle");
  if (lnt) lnt.checked = showLoginName;

  // Restore platform theme picker active state
  document.querySelectorAll("#platform-theme-presets [data-platform-theme]").forEach(el => {
    el.classList.toggle("active", el.dataset.platformTheme === (saved.theme || "dark"));
  });
  // Restore platform accent picker active state
  document.querySelectorAll("#platform-color-swatches [data-platform-color]").forEach(el => {
    el.classList.toggle("active", el.dataset.platformColor === saved.accent);
  });
  const customPicker = document.getElementById("platform-accent-custom");
  if (customPicker && saved.accent) customPicker.value = saved.accent;
  // Apply platform accent to login/setup screens
  if (saved.accent) applyPlatformAccent(saved.accent);
}
function applyLogoLetter(name) {
  const letter = (name || "D").trim().charAt(0).toUpperCase();
  const els = [
    document.getElementById("logo-letter"),
    document.getElementById("logo-letter-preview"),
    document.getElementById("login-logo-letter-preview"),
    document.getElementById("ai-avatar-letter"),
    document.getElementById("favicon-letter"),
  ];
  els.forEach(el => { if (el) el.textContent = letter; });
  ["auth-logo-letter-setup", "auth-logo-letter-login"].forEach(id => {
    const el = document.getElementById(id);
    if (el) { const sp = el.querySelector("span"); if (sp) sp.textContent = letter; else el.textContent = letter; }
  });
  // Regenerate letter favicon if no custom one is set
  if (!localStorage.getItem(FAVICON_KEY)) applyFavicon(null);
}
document.getElementById("app-name-input")?.addEventListener("input", e => {
  const name = e.target.value.trim() || "WoozleBox";
  saveBrand({ name });
  const sidebarTitle = document.getElementById("sidebar-title");
  if (sidebarTitle) sidebarTitle.textContent = name;
  document.title = name;
  ["auth-app-name-setup", "auth-app-name-login"].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = name;
  });
  applyLogoLetter(name);
});
document.getElementById("sidebar-name-toggle")?.addEventListener("change", e => {
  saveBrand({ showSidebarName: e.target.checked });
  const sidebarTitle = document.getElementById("sidebar-title");
  if (sidebarTitle) sidebarTitle.style.display = e.target.checked ? "" : "none";
});
document.getElementById("login-name-toggle")?.addEventListener("change", e => {
  saveBrand({ showLoginName: e.target.checked });
  ["auth-app-name-setup", "auth-app-name-login"].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = e.target.checked ? "" : "none";
  });
});
function applyPlatformAccent(color) {
  if (!color) return;
  ["login-screen", "setup-screen"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.setProperty("--auth-accent", color);
  });
}
// Platform theme picker
document.querySelectorAll("#platform-theme-presets [data-platform-theme]").forEach(el => {
  el.addEventListener("click", () => {
    document.querySelectorAll("#platform-theme-presets [data-platform-theme]").forEach(e => e.classList.remove("active"));
    el.classList.add("active");
    saveBrand({ theme: el.dataset.platformTheme });
  });
});
// Platform accent picker
document.querySelectorAll("#platform-color-swatches [data-platform-color]").forEach(el => {
  el.addEventListener("click", () => {
    document.querySelectorAll("#platform-color-swatches [data-platform-color]").forEach(e => e.classList.remove("active"));
    el.classList.add("active");
    saveBrand({ accent: el.dataset.platformColor });
    applyPlatformAccent(el.dataset.platformColor);
  });
});
document.getElementById("platform-accent-custom")?.addEventListener("input", e => {
  document.querySelectorAll("#platform-color-swatches [data-platform-color]").forEach(el => el.classList.remove("active"));
  saveBrand({ accent: e.target.value });
  applyPlatformAccent(e.target.value);
});
applyBrand();


// ── Models ──
async function loadModels() {
  try {
    const res = await apiFetch(`/models`);
    const data = await res.json();
    modelSelect.innerHTML = "";
    data.models.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m; opt.textContent = m;
      if (m === data.default) opt.selected = true;
      modelSelect.appendChild(opt);
    });
    const saved = localStorage.getItem("wooz_model");
    const pick = saved && data.models.includes(saved) ? saved : data.default;
    modelSelect.value = pick;
    selectedModel = pick;
    localStorage.setItem("wooz_model", pick);
    if (typeof checkVisionSupport === "function") checkVisionSupport(pick);
    // Hydrate the chat settings panel with this model's per-model values
    // now that the dropdown has options. Voices are loaded separately.
    if (typeof applyChatSettingsToUI === "function") {
      applyChatSettingsToUI(loadChatModelSettings(pick));
    }
    if (typeof refreshModelCapabilities === "function") refreshModelCapabilities(pick);
    if (typeof loadChatVoices === "function") loadChatVoices();

    // Populate songwrite model dropdown from same list
    const swSel = document.getElementById("songwrite-model-select");
    swSel.innerHTML = "";
    data.models.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m; opt.textContent = m;
      swSel.appendChild(opt);
    });
    const savedSw = localStorage.getItem("wooz_songwrite_model");
    const swPick = savedSw && data.models.includes(savedSw) ? savedSw : data.default;
    swSel.value = swPick;
    localStorage.setItem("wooz_songwrite_model", swPick);

    // Populate utility model dropdown from same list
    const utilSel = document.getElementById("utility-model-select");
    utilSel.innerHTML = "";
    data.models.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m; opt.textContent = m;
      utilSel.appendChild(opt);
    });
    const savedUtil = localStorage.getItem("wooz_utility_model");
    const utilPick = savedUtil && data.models.includes(savedUtil) ? savedUtil : (data.models.find(m => m.includes("0.6b") || m.includes("0.5b")) || data.models[data.models.length - 1] || "");
    utilSel.value = utilPick;
    localStorage.setItem("wooz_utility_model", utilPick);

    // Populate code model dropdown from same list
    const codeSel = document.getElementById("code-model-select");
    if (codeSel) {
      codeSel.innerHTML = "";
      data.models.forEach(m => {
        const opt = document.createElement("option");
        opt.value = m; opt.textContent = m;
        codeSel.appendChild(opt);
      });
      const savedCode = localStorage.getItem("wooz_code_model");
      const codePick = savedCode && data.models.includes(savedCode)
        ? savedCode
        : (data.models.find(m => /code|coder/i.test(m)) || data.default);
      codeSel.value = codePick;
      localStorage.setItem("wooz_code_model", codePick);
      if (typeof updateCodeSettingsSummary === "function") updateCodeSettingsSummary();
    }

    // Populate notetaker summary model dropdown from the same list.
    const ntSumSel = document.getElementById("notetaker-summary-model-select");
    if (ntSumSel) {
      ntSumSel.innerHTML = "";
      data.models.forEach(m => {
        const opt = document.createElement("option");
        opt.value = m; opt.textContent = m;
        ntSumSel.appendChild(opt);
      });
      const savedNtSum = localStorage.getItem("wooz_notetaker_summary_model");
      const ntSumPick = savedNtSum && data.models.includes(savedNtSum) ? savedNtSum : data.default;
      ntSumSel.value = ntSumPick;
      localStorage.setItem("wooz_notetaker_summary_model", ntSumPick);
    }
  } catch { modelSelect.innerHTML = `<option value="">Unavailable</option>`; }
  loadSuggestions();
  const wa = document.getElementById("welcome-avatar");
  const wt = document.getElementById("welcome-title");
  if (wa) wa.innerHTML = getWelcomeAvatarHtml();
  if (wt) wt.textContent = getWelcomeTitle();
  initModelPull();
}

// ── Pull New Model (admin only) ──
let _modelPullInitialized = false;
let _modelPullAll = [];
let _modelPullFiltered = [];
let _modelPullActiveIdx = 0;
let _modelPullTagsCache = {};   // base -> array of tag strings (or null while fetching)
const MODEL_PULL_DROPDOWN_LIMIT = 50;

async function initModelPull() {
  if (currentUser?.role !== "admin") return;
  document.querySelectorAll(".admin-only-row").forEach(el => { el.style.display = ""; });
  if (_modelPullInitialized) return;
  _modelPullInitialized = true;

  const input = document.getElementById("model-pull-input");
  const btn = document.getElementById("model-pull-btn");
  const retry = document.getElementById("model-pull-retry");
  const dropdown = document.getElementById("model-pull-dropdown");
  if (!input || !btn || !dropdown) return;

  btn.addEventListener("click", () => startModelPull(input.value));
  input.addEventListener("input", () => updateModelDropdown(input.value));
  input.addEventListener("focus", () => updateModelDropdown(input.value));
  input.addEventListener("keydown", onModelInputKeydown);
  document.addEventListener("mousedown", e => {
    if (!dropdown.contains(e.target) && e.target !== input) {
      dropdown.style.display = "none";
    }
  });
  if (retry) retry.addEventListener("click", e => { e.preventDefault(); loadModelSuggestions(); });

  loadModelSuggestions();
  loadInstalledModels();
}

async function loadInstalledModels() {
  if (currentUser?.role !== "admin") return;
  const list = document.getElementById("installed-models-list");
  if (!list) return;
  try {
    const res = await apiFetch("/admin/models/installed");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.models || !data.models.length) {
      list.innerHTML = `<div class="installed-models-empty">No models installed yet.</div>`;
      return;
    }
    list.innerHTML = data.models.map(m => `
      <div class="installed-model-row" data-model="${esc(m.name)}">
        <span class="installed-model-name">${esc(m.name)}</span>
        <span class="installed-model-size">${formatBytes(m.size)}</span>
        <button class="installed-model-delete" type="button">Delete</button>
      </div>
    `).join("");
    list.querySelectorAll(".installed-model-row").forEach(row => {
      const btn = row.querySelector(".installed-model-delete");
      btn.addEventListener("click", () => deleteInstalledModel(row.dataset.model));
    });
  } catch (e) {
    list.innerHTML = `<div class="installed-models-empty">Could not load installed models: ${esc(e.message)}</div>`;
  }
}

async function deleteInstalledModel(modelName) {
  const ok = await showConfirm({
    title: "Delete Model",
    message: `Delete ${modelName}? This frees disk space and cannot be undone.`,
    okLabel: "Delete",
  });
  if (!ok) return;
  try {
    const res = await apiFetch(`/admin/models/installed/${encodeURIComponent(modelName)}`, { method: "DELETE" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.detail || `Delete failed: HTTP ${res.status}`, "error");
      return;
    }
    showToast(`Deleted ${modelName}`, "success");
    await loadInstalledModels();
    if (typeof loadModels === "function") loadModels();
  } catch (e) {
    showToast(`Delete failed: ${e.message}`, "error");
  }
}

async function loadModelSuggestions() {
  const status = document.getElementById("model-pull-status");
  const retry = document.getElementById("model-pull-retry");
  if (!status) return;

  status.textContent = "Loading suggestions...";
  if (retry) retry.style.display = "none";

  try {
    const res = await apiFetch("/admin/models/available");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok && data.models?.length) {
      _modelPullAll = data.models;
      status.textContent = `${data.models.length} suggestions loaded.`;
    } else {
      _modelPullAll = [];
      status.textContent = data.error
        ? `Could not load suggestions: ${data.error}.`
        : "Could not load suggestions.";
      if (retry) retry.style.display = "";
    }
  } catch (e) {
    _modelPullAll = [];
    status.textContent = `Could not reach the registry (${e.message}).`;
    if (retry) retry.style.display = "";
  }
}

function updateModelDropdown(query) {
  const dropdown = document.getElementById("model-pull-dropdown");
  if (!dropdown) return;
  if (!_modelPullAll.length) { dropdown.style.display = "none"; return; }

  renderModelDropdown(query);

  // If the part before any colon matches a known base model, fetch its tags
  // in the background and re-render when they arrive (using current input).
  const base = (query.split(":")[0] || "").trim();
  if (base && _modelPullAll.includes(base) && _modelPullTagsCache[base] === undefined) {
    _modelPullTagsCache[base] = null; // mark in-flight so duplicate keystrokes coalesce
    fetchModelTags(base).then(() => {
      const dd = document.getElementById("model-pull-dropdown");
      if (!dd || dd.style.display === "none") return;
      const input = document.getElementById("model-pull-input");
      if (input) renderModelDropdown(input.value);
    });
  }
}

function renderModelDropdown(query) {
  const dropdown = document.getElementById("model-pull-dropdown");
  if (!dropdown) return;

  const q = (query || "").trim().toLowerCase();
  const base = (query.split(":")[0] || "").trim();

  // Build the candidate pool: base models + any cached tags for the typed base.
  let candidates = _modelPullAll;
  const tags = base && _modelPullTagsCache[base];
  if (tags && tags.length) {
    candidates = candidates.concat(tags.map(t => `${base}:${t}`));
  }

  let matches;
  if (!q) {
    matches = candidates.slice(0, MODEL_PULL_DROPDOWN_LIMIT);
  } else {
    const prefix = [], substr = [];
    for (const m of candidates) {
      const lower = m.toLowerCase();
      if (lower.startsWith(q)) prefix.push(m);
      else if (lower.includes(q)) substr.push(m);
      if (prefix.length + substr.length >= MODEL_PULL_DROPDOWN_LIMIT * 2) break;
    }
    matches = prefix.concat(substr).slice(0, MODEL_PULL_DROPDOWN_LIMIT);
  }

  _modelPullFiltered = matches;
  _modelPullActiveIdx = 0;

  if (!matches.length) {
    dropdown.innerHTML = `<div class="model-pull-dropdown-empty">No matching suggestions. Press Pull to fetch this name as-is.</div>`;
    dropdown.style.display = "block";
    return;
  }

  dropdown.innerHTML = matches.map((m, i) =>
    `<div class="model-pull-suggestion${i === 0 ? " active" : ""}" data-idx="${i}">${escapeModelName(m)}</div>`
  ).join("");
  dropdown.style.display = "block";

  dropdown.querySelectorAll(".model-pull-suggestion").forEach(row => {
    row.addEventListener("mousedown", e => {
      e.preventDefault();
      selectModelSuggestion(parseInt(row.dataset.idx));
    });
  });
}

async function fetchModelTags(baseName) {
  try {
    const res = await apiFetch(`/admin/models/tags?model=${encodeURIComponent(baseName)}`);
    if (!res.ok) { _modelPullTagsCache[baseName] = []; return; }
    const data = await res.json();
    _modelPullTagsCache[baseName] = Array.isArray(data.tags) ? data.tags : [];
  } catch {
    _modelPullTagsCache[baseName] = [];
  }
}

function selectModelSuggestion(idx) {
  const name = _modelPullFiltered[idx];
  if (!name) return;
  const input = document.getElementById("model-pull-input");
  const dropdown = document.getElementById("model-pull-dropdown");
  if (input) input.value = name;
  if (dropdown) dropdown.style.display = "none";
  if (input) input.focus();
}

function onModelInputKeydown(e) {
  const dropdown = document.getElementById("model-pull-dropdown");
  const visible = dropdown && dropdown.style.display !== "none" && _modelPullFiltered.length;

  if (e.key === "ArrowDown" && visible) {
    e.preventDefault();
    _modelPullActiveIdx = Math.min(_modelPullActiveIdx + 1, _modelPullFiltered.length - 1);
    setActiveModelSuggestion();
  } else if (e.key === "ArrowUp" && visible) {
    e.preventDefault();
    _modelPullActiveIdx = Math.max(_modelPullActiveIdx - 1, 0);
    setActiveModelSuggestion();
  } else if (e.key === "Tab" && visible) {
    e.preventDefault();
    selectModelSuggestion(_modelPullActiveIdx);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (visible && e.target.value && _modelPullFiltered[_modelPullActiveIdx] !== e.target.value) {
      selectModelSuggestion(_modelPullActiveIdx);
    } else {
      if (dropdown) dropdown.style.display = "none";
      startModelPull(e.target.value);
    }
  } else if (e.key === "Escape") {
    if (dropdown) dropdown.style.display = "none";
  }
}

function setActiveModelSuggestion() {
  const dropdown = document.getElementById("model-pull-dropdown");
  if (!dropdown) return;
  dropdown.querySelectorAll(".model-pull-suggestion").forEach((row, i) => {
    row.classList.toggle("active", i === _modelPullActiveIdx);
    if (i === _modelPullActiveIdx) row.scrollIntoView({ block: "nearest" });
  });
}

function escapeModelName(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

async function startModelPull(modelName) {
  modelName = (modelName || "").trim();
  if (!modelName) { showToast("Enter a model name", "error"); return; }
  try {
    const res = await apiFetch("/admin/models/pull", {
      method: "POST",
      body: JSON.stringify({ model: modelName }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.detail || `Failed to start pull: HTTP ${res.status}`, "error");
      return;
    }
    const data = await res.json();
    document.getElementById("model-pull-input").value = "";
    addPullSessionCard(data.session_id, data.model);
    streamPullSession(data.session_id);
  } catch (e) {
    showToast(`Pull failed: ${e.message}`, "error");
  }
}

const _pullRateState = {}; // session_id -> { lastTime, lastCompleted, smoothedRate }

function addPullSessionCard(sessionId, modelName) {
  const container = document.getElementById("model-pull-sessions");
  if (!container) return;
  const card = document.createElement("div");
  card.className = "model-pull-session";
  card.id = `model-pull-session-${sessionId}`;
  card.innerHTML = `
    <div class="model-pull-session-header">
      <div class="model-pull-session-title"></div>
      <button class="model-pull-session-cancel" type="button">Cancel</button>
    </div>
    <div class="model-pull-session-bar"><div></div></div>
    <div class="model-pull-session-status">Connecting...</div>
  `;
  card.querySelector(".model-pull-session-title").textContent = `Pulling ${modelName}`;
  card.querySelector(".model-pull-session-cancel").addEventListener("click", () => cancelPullSession(sessionId));
  container.appendChild(card);
  _pullRateState[sessionId] = { lastTime: 0, lastCompleted: 0, smoothedRate: 0 };
}

async function cancelPullSession(sessionId) {
  try {
    await apiFetch(`/admin/models/pull/${sessionId}/cancel`, { method: "POST" });
    updatePullSessionStatus(sessionId, "Cancelled by user", "cancelled");
  } catch (e) {
    showToast(`Cancel failed: ${e.message}`, "error");
  }
}

async function streamPullSession(sessionId) {
  try {
    const res = await apiFetch(`/admin/models/pull-progress/${sessionId}`);
    if (!res.ok) {
      updatePullSessionStatus(sessionId, `HTTP ${res.status}`, "error");
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let evt;
        try { evt = JSON.parse(line.slice(6)); } catch { continue; }
        if (evt.type === "event") {
          const e = evt.event || {};
          let status = e.status || "";
          if (typeof e.total === "number" && typeof e.completed === "number" && e.total > 0) {
            const pct = Math.min(100, (e.completed / e.total) * 100);
            updatePullSessionProgress(sessionId, pct);
            const rateInfo = computePullRate(sessionId, e.completed, e.total);
            status += ` (${formatBytes(e.completed)} / ${formatBytes(e.total)}`;
            if (rateInfo.rate > 0) status += `, ${formatBytes(rateInfo.rate)}/s`;
            if (rateInfo.eta) status += `, ${rateInfo.eta} left`;
            status += `)`;
          }
          updatePullSessionStatus(sessionId, status);
        } else if (evt.type === "done") {
          delete _pullRateState[sessionId];
          if (evt.status === "success") {
            updatePullSessionProgress(sessionId, 100);
            updatePullSessionStatus(sessionId, "Complete - model is now available", "done");
            if (typeof loadModels === "function") loadModels();
            loadInstalledModels();
          } else if (evt.status === "cancelled") {
            updatePullSessionStatus(sessionId, "Cancelled by user", "cancelled");
          } else {
            updatePullSessionStatus(sessionId, evt.error || "Failed", "error");
          }
        } else if (evt.type === "error") {
          updatePullSessionStatus(sessionId, evt.message || "Error", "error");
        }
      }
    }
  } catch (e) {
    updatePullSessionStatus(sessionId, `Connection lost: ${e.message}`, "error");
  }
}

function computePullRate(sessionId, completed, total) {
  const state = _pullRateState[sessionId];
  if (!state) return { rate: 0, eta: null };
  const now = performance.now() / 1000;
  let rate = 0;
  if (state.lastTime > 0) {
    const dt = now - state.lastTime;
    const dBytes = completed - state.lastCompleted;
    if (dt > 0.05 && dBytes >= 0) {
      const instant = dBytes / dt;
      // EMA to smooth out spiky chunk arrivals
      state.smoothedRate = state.smoothedRate > 0
        ? state.smoothedRate * 0.7 + instant * 0.3
        : instant;
      rate = state.smoothedRate;
    } else {
      rate = state.smoothedRate;
    }
  }
  state.lastTime = now;
  state.lastCompleted = completed;
  let eta = null;
  if (rate > 0 && total > completed) {
    eta = formatDuration((total - completed) / rate);
  }
  return { rate, eta };
}

function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mr = m % 60;
  return mr ? `${h}h ${mr}m` : `${h}h`;
}

function updatePullSessionStatus(sessionId, status, kind) {
  const card = document.getElementById(`model-pull-session-${sessionId}`);
  if (!card) return;
  card.querySelector(".model-pull-session-status").textContent = status;
  card.classList.remove("error", "done", "cancelled");
  if (kind) card.classList.add(kind);
}

function updatePullSessionProgress(sessionId, pct) {
  const card = document.getElementById(`model-pull-session-${sessionId}`);
  if (!card) return;
  card.querySelector(".model-pull-session-bar > div").style.width = `${pct}%`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function _getChatTtsPill() {
  let pill = document.getElementById("chat-tts-blocked-pill");
  if (pill) return pill;
  const panel = document.getElementById("chat-settings-panel");
  if (!panel) return null;
  pill = document.createElement("div");
  pill.id = "chat-tts-blocked-pill";
  pill.className = "settings-note";
  pill.style.cssText = "display:none;margin:6px 0 0;padding:6px 10px;border-radius:8px;background:color-mix(in srgb, var(--danger) 18%, transparent);color:var(--text);font-size:12px;line-height:1.35;border:1px solid color-mix(in srgb, var(--danger) 40%, transparent);";
  panel.insertBefore(pill, panel.firstChild);
  return pill;
}
function _setChatTtsBlocked(modelName) {
  const pill = _getChatTtsPill();
  if (pill) {
    if (modelName) {
      pill.textContent = `TTS disabled: ${modelName} leaves insufficient VRAM for voice. Pick a smaller chat model to enable voice.`;
      pill.style.display = "";
    } else {
      pill.style.display = "none";
    }
  }
  // A large chat model evicts Orpheus, so the voice ability must be disabled.
  // When the block clears (smaller model), voice becomes available again.
  if (typeof setVoiceAvailable === "function") setVoiceAvailable(!modelName, modelName);
}

modelSelect.addEventListener("change", async () => {
  selectedModel = modelSelect.value || null;
  if (selectedModel) { localStorage.setItem("wooz_model", selectedModel); scheduleSettingsSync(); }
  if (activeConvId) updateContextBar(activeConvId);
  if (!selectedModel) return;
  const modelName = modelSelect.options[modelSelect.selectedIndex]?.textContent || selectedModel;
  _modelReady.chat = false;
  if (typeof _setModelLoading === "function") _setModelLoading("chat", true, modelName);
  if (typeof _startLoadStatusPoller === "function") _startLoadStatusPoller("chat", "chat");
  try {
    const resp = await fetch(GPU_API + "/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "chat", model: selectedModel }),
    });
    _modelReady.chat = true;
    try {
      const data = await resp.json();
      _setChatTtsBlocked(data && data.tts_blocked_by ? data.tts_blocked_by : null);
    } catch {}
  } catch {}
  if (typeof _setModelLoading === "function") _setModelLoading("chat", false);
});
document.getElementById("songwrite-model-select").addEventListener("change", () => {
  const v = document.getElementById("songwrite-model-select").value;
  if (v) { localStorage.setItem("wooz_songwrite_model", v); scheduleSettingsSync(); }
});
document.getElementById("utility-model-select").addEventListener("change", () => {
  const v = document.getElementById("utility-model-select").value;
  if (v) { localStorage.setItem("wooz_utility_model", v); scheduleSettingsSync(); }
});
document.getElementById("notetaker-summary-model-select")?.addEventListener("change", () => {
  const v = document.getElementById("notetaker-summary-model-select").value;
  if (v) { localStorage.setItem("wooz_notetaker_summary_model", v); scheduleSettingsSync(); }
});
const _codeModelSel = document.getElementById("code-model-select");
if (_codeModelSel) _codeModelSel.addEventListener("change", async () => {
  const v = _codeModelSel.value;
  if (v) { localStorage.setItem("wooz_code_model", v); scheduleSettingsSync(); }
  if (typeof updateCodeSettingsSummary === "function") updateCodeSettingsSummary();
  if (!v) return;
  const modelName = _codeModelSel.options[_codeModelSel.selectedIndex]?.textContent || v;
  _modelReady.code = false;
  if (typeof _setModelLoading === "function") _setModelLoading("code", true, modelName);
  if (typeof _startLoadStatusPoller === "function") _startLoadStatusPoller("code", "code");
  try {
    await fetch(GPU_API + "/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "code", model: v }),
    });
    _modelReady.code = true;
  } catch {}
  if (typeof _setModelLoading === "function") _setModelLoading("code", false);
});
// loadModels() is called from loadApp()

