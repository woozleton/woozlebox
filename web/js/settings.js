// ── Settings (localStorage) ──
const SETTINGS_KEY = "diab_settings";
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    if (s.temperature !== undefined) tempSlider.value    = s.temperature;
    if (s.threshold   !== undefined) threshSlider.value  = s.threshold;
    if (s.top_k       !== undefined) topkSlider.value    = s.top_k;
    if (s.history     !== undefined) historySlider.value  = s.history;
    if (s.compact     !== undefined) compactSlider.value  = s.compact;
    // voice restored in loadVoices() after options are populated
    if (s.default_prompt !== undefined) document.getElementById("default-prompt-input").value = s.default_prompt;
    if (s.auto_memory !== undefined) document.getElementById("auto-memory-toggle").checked = s.auto_memory;
    if (s.debug !== undefined) { document.getElementById("debug-toggle").checked = s.debug; debugMode = s.debug; document.body.classList.toggle("debug-on", s.debug); }
  } catch {}
  updateSettingLabels();
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    temperature:     parseFloat(tempSlider.value),
    threshold:       parseFloat(threshSlider.value),
    top_k:           parseInt(topkSlider.value),
    history:         parseInt(historySlider.value),
    compact:         parseInt(compactSlider.value),
    voice:           voiceSelect.value,
    default_prompt:  document.getElementById("default-prompt-input").value.trim(),
    auto_memory:     document.getElementById("auto-memory-toggle").checked,
    debug:           document.getElementById("debug-toggle").checked,
  }));
}
function updateSettingLabels() {
  document.getElementById("temp-val").textContent    = parseFloat(tempSlider.value).toFixed(2);
  document.getElementById("thresh-val").textContent  = parseFloat(threshSlider.value).toFixed(2);
  document.getElementById("topk-val").textContent    = topkSlider.value;
  document.getElementById("history-val").textContent  = historySlider.value;
  const cv = parseInt(compactSlider.value);
  document.getElementById("compact-val").textContent  = cv === 0 ? "Off" : cv + "%";
}
[tempSlider, threshSlider, topkSlider, historySlider, compactSlider].forEach(s => {
  s.addEventListener("input", () => { updateSettingLabels(); saveSettings(); scheduleSettingsSync(); });
});
voiceSelect.addEventListener("change", () => { saveSettings(); scheduleSettingsSync(); });
document.getElementById("default-prompt-input").addEventListener("input", () => { saveSettings(); scheduleSettingsSync(); });
document.getElementById("auto-memory-toggle").addEventListener("change", () => { saveSettings(); scheduleSettingsSync(); });
document.getElementById("chat-advanced-toggle").addEventListener("click", function() {
  this.classList.toggle("open");
  document.getElementById("chat-advanced-panel").classList.toggle("open");
});

// ── Profile (localStorage) ──
const PROFILE_KEY = "diab_profile";
const AVATAR_KEY  = "diab_avatar";

function applyAvatar(dataUrl) {
  const initials  = document.getElementById("profile-avatar-initials");
  const img       = document.getElementById("profile-avatar-img");
  const resetBtn  = document.getElementById("avatar-reset-btn");
  if (dataUrl) {
    initials.style.display = "none";
    img.src = dataUrl; img.style.display = "";
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
const LOGO_KEY = "diab_logo";
function applyLogo(dataUrl) {
  const letter     = document.getElementById("logo-letter");
  const img        = document.getElementById("logo-img");
  const title      = document.getElementById("sidebar-title");
  const prev       = document.getElementById("logo-preview");
  const prevLetter = document.getElementById("logo-letter-preview");
  const reset      = document.getElementById("logo-reset-btn");
  if (dataUrl) {
    letter.style.display = "none";
    img.src = dataUrl; img.style.display = "";
    // Hide the text name when a logo image is present - wide logos act as the wordmark
    if (title) title.style.display = "none";
    if (prev) { prev.src = dataUrl; prev.style.display = ""; }
    if (prevLetter) prevLetter.style.display = "none";
    if (reset) reset.style.display = "flex";
  } else {
    letter.style.display = "";
    img.style.display = "none";
    // Restore title visibility based on brand preference
    if (title) {
      const showSidebarName = (JSON.parse(localStorage.getItem("diab_brand") || "{}").showSidebarName !== false);
      title.style.display = showSidebarName ? "" : "none";
    }
    if (prev) prev.style.display = "none";
    if (prevLetter) prevLetter.style.display = "";
    if (reset) reset.style.display = "none";
  }
}

const LOGIN_LOGO_KEY = "diab_login_logo";
function applyLoginLogo(dataUrl) {
  const prev       = document.getElementById("login-logo-preview");
  const prevLetter = document.getElementById("login-logo-letter-preview");
  const reset      = document.getElementById("login-logo-reset-btn");
  const authLetters = ["auth-logo-letter-setup", "auth-logo-letter-login"].map(id => document.getElementById(id));
  const authImgs    = ["auth-logo-img-setup",    "auth-logo-img-login"   ].map(id => document.getElementById(id));
  const authNames   = ["auth-app-name-setup",    "auth-app-name-login"   ].map(id => document.getElementById(id));
  if (dataUrl) {
    if (prev) { prev.src = dataUrl; prev.style.display = ""; }
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
    const showLoginName = (JSON.parse(localStorage.getItem("diab_brand") || "{}").showLoginName !== false);
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
const FAVICON_KEY = "diab_favicon";
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
    if (prev)   { prev.src = dataUrl; prev.style.display = ""; }
    if (letter) letter.style.display = "none";
    if (reset)  reset.style.display = "flex";
  } else {
    const ch = (JSON.parse(localStorage.getItem(BRAND_KEY) || "{}").name || "D").trim().charAt(0).toUpperCase();
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
const AI_AVATAR_KEY = "diab_ai_avatar";
function applyAIAvatar(dataUrl) {
  // Update settings widget
  const letter  = document.getElementById("ai-avatar-letter");
  const preview = document.getElementById("ai-avatar-preview");
  const reset   = document.getElementById("ai-avatar-reset-btn");
  if (dataUrl) {
    if (letter)  letter.style.display = "none";
    if (preview) { preview.src = dataUrl; preview.style.display = ""; }
    if (reset)   reset.style.display = "flex";
  } else {
    if (letter)  letter.style.display = "";
    if (preview) { preview.src = ""; preview.style.display = "none"; }
    if (reset)   reset.style.display = "none";
  }
  // Update all existing chat bubbles live
  const fallbackLetter = (JSON.parse(localStorage.getItem("diab_brand") || "{}").name || "D").trim().charAt(0).toUpperCase();
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
const ACCENT_KEY = "diab_accent";
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
let voicesLoaded = false;

function openSettings() {
  closeVaultPanel();
  if (isMobile()) closeMobileSidebar();
  settingsPanel.classList.add("open");
  if (!voicesLoaded) loadVoices();
  loadMemory();
  if (currentUser?.role === "admin") { loadAdminUsers(); loadAdminDefaults(); }
}
function closeSettings() {
  settingsPanel.classList.remove("open");
}

settingsBtn.addEventListener("click", openSettings);
settingsClose.addEventListener("click", closeSettings);
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

const VOICE_DESCRIPTIONS = {
  "af_heart":    "Warm, expressive American female. Friendly and natural.",
  "af_bella":    "Clear, confident American female. Professional tone.",
  "af_nicole":   "Soft, breathy American female. Calm and intimate.",
  "af_sarah":    "Bright, energetic American female. Upbeat delivery.",
  "af_sky":      "Airy, light American female. Gentle and soothing.",
  "am_adam":     "Neutral American male. Balanced and articulate.",
  "am_michael":  "Deep, measured American male. Authoritative.",
  "bf_emma":     "Refined British female. Polished and clear.",
  "bf_isabella": "Warm British female. Elegant and expressive.",
  "bm_george":   "Classic British male. Confident and distinguished.",
  "bm_lewis":    "Crisp British male. Modern and direct.",
};
function updateVoiceDesc() {
  const desc = document.getElementById("voice-desc");
  if (desc) desc.textContent = VOICE_DESCRIPTIONS[voiceSelect.value] || "";
}
const VOICE_NAMES = {
  // American English - Female
  af_heart:       "American Female -Heart",
  af_bella:       "American Female -Bella",
  af_nicole:      "American Female -Nicole",
  af_aoede:       "American Female -Aoede",
  af_kore:        "American Female -Kore",
  af_sarah:       "American Female -Sarah",
  af_alloy:       "American Female -Alloy",
  af_nova:        "American Female -Nova",
  af_sky:         "American Female -Sky",
  af_jessica:     "American Female -Jessica",
  af_river:       "American Female -River",
  // American English - Male
  am_fenrir:      "American Male -Fenrir",
  am_michael:     "American Male -Michael",
  am_puck:        "American Male -Puck",
  am_echo:        "American Male -Echo",
  am_eric:        "American Male -Eric",
  am_liam:        "American Male -Liam",
  am_onyx:        "American Male -Onyx",
  am_santa:       "American Male -Santa",
  am_adam:        "American Male -Adam",
  // British English - Female
  bf_emma:        "British Female -Emma",
  bf_isabella:    "British Female -Isabella",
  bf_alice:       "British Female -Alice",
  bf_lily:        "British Female -Lily",
  // British English - Male
  bm_fable:       "British Male -Fable",
  bm_george:      "British Male -George",
  bm_lewis:       "British Male -Lewis",
  bm_daniel:      "British Male -Daniel",
  // Japanese - Female
  jf_alpha:       "Japanese Female -Alpha",
  jf_gongitsune:  "Japanese Female -Gongitsune",
  jf_tebukuro:    "Japanese Female -Tebukuro",
  jf_nezumi:      "Japanese Female -Nezumi",
  // Japanese - Male
  jm_kumo:        "Japanese Male -Kumo",
  // Mandarin Chinese - Female
  zf_xiaobei:     "Chinese Female -Xiaobei",
  zf_xiaoni:      "Chinese Female -Xiaoni",
  zf_xiaoxiao:    "Chinese Female -Xiaoxiao",
  zf_xiaoyi:      "Chinese Female -Xiaoyi",
  // Mandarin Chinese - Male
  zm_yunjian:     "Chinese Male -Yunjian",
  zm_yunxi:       "Chinese Male -Yunxi",
  zm_yunxia:      "Chinese Male -Yunxia",
  zm_yunyang:     "Chinese Male -Yunyang",
  // Spanish - Female
  ef_dora:        "Spanish Female -Dora",
  // Spanish - Male
  em_alex:        "Spanish Male -Alex",
  em_santa:       "Spanish Male -Santa",
  // French - Female
  ff_siwis:       "French Female -Siwis",
  // Hindi - Female
  hf_alpha:       "Hindi Female -Alpha",
  hf_beta:        "Hindi Female -Beta",
  // Hindi - Male
  hm_omega:       "Hindi Male -Omega",
  hm_psi:         "Hindi Male -Psi",
  // Italian - Female
  if_sara:        "Italian Female -Sara",
  // Italian - Male
  im_nicola:      "Italian Male -Nicola",
  // Brazilian Portuguese - Female
  pf_dora:        "Portuguese Female -Dora",
  // Brazilian Portuguese - Male
  pm_alex:        "Portuguese Male -Alex",
  pm_santa:       "Portuguese Male -Santa",
};
async function loadVoices() {
  try {
    const res = await apiFetch(`/tts/voices`);
    const data = await res.json();
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}").voice || data.default;
    voiceSelect.innerHTML = data.voices.map(v =>
      `<option value="${v}"${v === saved ? " selected" : ""}>${VOICE_NAMES[v] || v}</option>`
    ).join("");
    voicesLoaded = true;
    updateVoiceDesc();
  } catch {
    // Kokoro unavailable - keep placeholder
  }
}
voiceSelect.addEventListener("change", updateVoiceDesc);

// Voice preview
const PLAY_ICON = `<polygon points="4,2 13,8 4,14"/>`;
const STOP_ICON = `<rect x="3" y="3" width="10" height="10" rx="1"/>`;
let _previewAudio = null;

function setPreviewBtn(state) {
  const icon = document.getElementById("voice-preview-icon");
  const btn = document.getElementById("voice-preview-btn");
  if (!icon || !btn) return;
  if (state === "play")  { icon.innerHTML = PLAY_ICON; btn.title = "Play preview";  btn.disabled = false; }
  if (state === "stop")  { icon.innerHTML = STOP_ICON; btn.title = "Stop preview";  btn.disabled = false; }
  if (state === "loading") { btn.disabled = true; }
}

document.getElementById("voice-preview-btn")?.addEventListener("click", async () => {
  if (_previewAudio) {
    _previewAudio.pause();
    _previewAudio = null;
    setPreviewBtn("play");
    return;
  }
  setPreviewBtn("loading");
  try {
    const previewText = document.getElementById("voice-preview-text")?.value.trim() || "Hello, this is a preview of the selected voice.";
    const params = new URLSearchParams({ text: previewText, voice: voiceSelect.value });
    const res = await apiFetch(`/tts?${params}`);
    if (!res.ok) throw new Error();
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    _previewAudio = audio;
    setPreviewBtn("stop");
    audio.onended = () => { URL.revokeObjectURL(url); _previewAudio = null; setPreviewBtn("play"); };
    audio.onerror = () => { _previewAudio = null; setPreviewBtn("play"); };
    audio.play();
  } catch { _previewAudio = null; setPreviewBtn("play"); }
});

// ── Debug toggle ──
const debugToggle = document.getElementById("debug-toggle");
debugToggle.addEventListener("change", () => {
  debugMode = debugToggle.checked;
  document.body.classList.toggle("debug-on", debugMode);
  saveSettings(); scheduleSettingsSync();
});

// ── Web search toggle ──
const webCaution = document.getElementById("web-caution");
webBtn.addEventListener("click", () => {
  webSearch = !webSearch;
  webBtn.classList.toggle("active", webSearch);
  webBtn.title = webSearch ? "Web search ON, click to disable" : "Toggle web search";
  webCaution?.classList.toggle("visible", webSearch);
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
const TEXT_SIZE_KEY = "diab_text_size";
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
const THEME_KEY = "diab_theme";
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
}
document.querySelectorAll(".theme-preset[data-theme]").forEach(p => {
  p.addEventListener("click", () => {
    applyTheme(p.dataset.theme);
    scheduleSettingsSync();
  });
});
const savedTheme = localStorage.getItem(THEME_KEY);
if (savedTheme && THEMES[savedTheme]) applyTheme(savedTheme, true);

// ── App name / branding ──
const BRAND_KEY = "diab_brand";
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
    const saved = localStorage.getItem("diab_model");
    const pick = saved && data.models.includes(saved) ? saved : data.default;
    modelSelect.value = pick;
    selectedModel = pick;
    localStorage.setItem("diab_model", pick);
    const _cml = document.getElementById("chat-model-label"); if (_cml) _cml.textContent = pick || "";
    if (typeof checkVisionSupport === "function") checkVisionSupport(pick);

    // Populate songwrite model dropdown from same list
    const swSel = document.getElementById("songwrite-model-select");
    swSel.innerHTML = "";
    data.models.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m; opt.textContent = m;
      swSel.appendChild(opt);
    });
    const savedSw = localStorage.getItem("diab_songwrite_model");
    const swPick = savedSw && data.models.includes(savedSw) ? savedSw : data.default;
    swSel.value = swPick;
    localStorage.setItem("diab_songwrite_model", swPick);

    // Populate utility model dropdown from same list
    const utilSel = document.getElementById("utility-model-select");
    utilSel.innerHTML = "";
    data.models.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m; opt.textContent = m;
      utilSel.appendChild(opt);
    });
    const savedUtil = localStorage.getItem("diab_utility_model");
    const utilPick = savedUtil && data.models.includes(savedUtil) ? savedUtil : (data.models.find(m => m.includes("0.6b") || m.includes("0.5b")) || data.models[data.models.length - 1] || "");
    utilSel.value = utilPick;
    localStorage.setItem("diab_utility_model", utilPick);
  } catch { modelSelect.innerHTML = `<option value="">Unavailable</option>`; }
  loadSuggestions();
  const wa = document.getElementById("welcome-avatar");
  const wt = document.getElementById("welcome-title");
  if (wa) wa.innerHTML = getWelcomeAvatarHtml();
  if (wt) wt.textContent = getWelcomeTitle();
}
modelSelect.addEventListener("change", async () => {
  selectedModel = modelSelect.value || null;
  if (selectedModel) { localStorage.setItem("diab_model", selectedModel); scheduleSettingsSync(); }
  const _cml2 = document.getElementById("chat-model-label"); if (_cml2) _cml2.textContent = selectedModel || "";
  if (activeConvId) updateContextBar(activeConvId);
  // Preload the new model into VRAM (non-blocking)
  if (selectedModel) {
    fetch(GPU_API + "/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "chat", model: selectedModel }),
    }).catch(() => {});
  }
});
document.getElementById("songwrite-model-select").addEventListener("change", () => {
  const v = document.getElementById("songwrite-model-select").value;
  if (v) { localStorage.setItem("diab_songwrite_model", v); scheduleSettingsSync(); }
});
document.getElementById("utility-model-select").addEventListener("change", () => {
  const v = document.getElementById("utility-model-select").value;
  if (v) { localStorage.setItem("diab_utility_model", v); scheduleSettingsSync(); }
});
// loadModels() is called from loadApp()

