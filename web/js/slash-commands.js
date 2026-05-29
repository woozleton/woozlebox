// ══════════════════════════════════════════════════════════════
// SLASH COMMANDS - Type / in any prompt for quick actions. (30 commands)
// 14 universal (all prompts) + 16 chat-only.
// ══════════════════════════════════════════════════════════════

/* global apiFetch, esc, chatWindow, scrollBottom, input, autoResizeInput,
   setView, prepareModelsForView, webSearch, webBtn, ragSearch, ragToggleBtn,
   debugMode, saveSettings, scheduleSettingsSync, updateSettingLabels,
   THEMES, applyTheme, modelSelect, selectedModel, tempSlider, compactSlider,
   activeConvId, loadConversations, loadConversation, newChatBtn,
   chatFolders, activeChatFolderId, loadSuggestions, showConfirm, showToast,
   speakText, getVoice, studioPrompt, studioGenerate, musicPrompt,
   musicGenerate, videoGenerate, codePrompt, codeGenerateBtn, codeLanguageSelect,
   codeGenerate, openSearchModal, searchInput, runSearch, loadMemory,
   showStudio, showMusicStudio, showVideoStudio, showCodeStudio, showNotetaker,
   getToken, API,
   activeStudioSessionId, activeMusicSessionId, activeVideoSessionId, activeCodeSessionId,
   openSettings, clearSession,
   renderStudioSessionsList, renderMusicSessionsList, renderVideoSessionsList, renderCodeSessionsList */

// ── Registry ──

const SLASH_COMMANDS = {};

function registerCommand({ name, description, usage, category, handler, universal }) {
  SLASH_COMMANDS[name] = { name, description, usage: usage || `/${name}`, category, handler, universal: !!universal };
}

function parseSlashCommand(raw) {
  const match = raw.match(/^\/(\S+)\s*([\s\S]*)/);
  if (!match) return null;
  return { command: match[1].toLowerCase(), args: match[2].trim() };
}

async function executeSlashCommand(raw) {
  const parsed = parseSlashCommand(raw);
  if (!parsed) return false;
  const cmd = SLASH_COMMANDS[parsed.command];
  if (!cmd) {
    _cmdResult(`Unknown command: <code>/${esc(parsed.command)}</code>. Type <code>/help</code> for a list.`, "error");
    return true;
  }
  // Block chat-only commands when used from a studio prompt
  if (!cmd.universal && _activeInput !== input) {
    _cmdResult(`<code>/${esc(parsed.command)}</code> is only available in chat.`, "error");
    return true;
  }
  try {
    await cmd.handler(parsed.args);
  } catch (e) {
    _cmdResult(`Error running <code>/${esc(parsed.command)}</code>: ${esc(e.message)}`, "error");
  }
  return true;
}


// ── Result display ──

function _cmdResult(html, type) {
  type = type || "info";
  const plain = html.replace(/<[^>]+>/g, "");
  if (plain.length < 80 && !html.includes("<br>")) {
    showToast(plain, type);
  } else {
    _showCmdOverlay(html, type);
  }
}

function _showCmdOverlay(html, type) {
  let overlay = document.getElementById("slash-cmd-overlay");
  if (overlay) overlay.remove();
  overlay = document.createElement("div");
  overlay.id = "slash-cmd-overlay";
  overlay.innerHTML = `<div class="slash-cmd-panel slash-cmd-${type || "info"}"><span class="slash-cmd-close">&times;</span>${html}</div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.querySelector(".slash-cmd-close").addEventListener("click", () => overlay.remove());
  overlay.querySelector(".slash-cmd-panel").addEventListener("click", (e) => e.stopPropagation());
}

function _bindThemePills() {
  const overlay = document.getElementById("slash-cmd-overlay");
  if (!overlay) return;
  overlay.querySelectorAll(".theme-pill").forEach(pill => {
    pill.addEventListener("click", () => {
      const name = pill.dataset.theme;
      applyTheme(name);
      scheduleSettingsSync();
      overlay.querySelectorAll(".theme-pill").forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
    });
  });
}


// ── Shared autocomplete popup ──

const _slashPopup = document.createElement("div");
_slashPopup.id = "slash-autocomplete";
_slashPopup.style.display = "none";

let _slashIdx = 0;
let _slashMatches = [];
let _activeInput = input; // tracks whichever prompt textarea is focused

function _updateSlashPopup() {
  const val = _activeInput.value;
  const match = val.match(/^\/(\S*)$/);
  if (!match) { _slashPopup.style.display = "none"; return; }
  const prefix = match[1].toLowerCase();
  const isChat = (_activeInput === input);
  _slashMatches = Object.values(SLASH_COMMANDS)
    .filter(c => c.name.startsWith(prefix) && (isChat || c.universal))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!_slashMatches.length) { _slashPopup.style.display = "none"; return; }
  _slashIdx = Math.min(_slashIdx, _slashMatches.length - 1);
  _slashPopup.innerHTML = _slashMatches.map((c, i) =>
    `<div class="slash-row${i === _slashIdx ? " active" : ""}" data-idx="${i}">` +
      `<span class="slash-row-name">/${esc(c.name)}</span>` +
      `<span class="slash-row-desc">${esc(c.description)}</span>` +
    `</div>`
  ).join("");
  _slashPopup.style.display = "block";
  const activeRow = _slashPopup.querySelector(".slash-row.active");
  if (activeRow) activeRow.scrollIntoView({ block: "nearest" });
  _slashPopup.querySelectorAll(".slash-row").forEach(row => {
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      _selectSlashCmd(parseInt(row.dataset.idx));
    });
  });
}

function _selectSlashCmd(idx) {
  const cmd = _slashMatches[idx];
  if (!cmd) return;
  _activeInput.value = `/${cmd.name} `;
  _slashPopup.style.display = "none";
  _slashIdx = 0;
  _activeInput.focus();
}

// Shared keydown handler for all registered prompt inputs.
// stopImmediatePropagation blocks each studio's own keydown handler
// (which would otherwise call generate) since slash-commands.js loads first.
function _slashKeydown(e) {
  // Popup visible - navigate/select/dismiss
  if (_slashPopup.style.display !== "none") {
    if (e.key === "ArrowDown") {
      e.preventDefault(); e.stopImmediatePropagation();
      _slashIdx = Math.min(_slashIdx + 1, _slashMatches.length - 1);
      _updateSlashPopup();
    } else if (e.key === "ArrowUp") {
      e.preventDefault(); e.stopImmediatePropagation();
      _slashIdx = Math.max(_slashIdx - 1, 0);
      _updateSlashPopup();
    } else if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault(); e.stopImmediatePropagation();
      _selectSlashCmd(_slashIdx);
    } else if (e.key === "Escape") {
      e.stopImmediatePropagation();
      _slashPopup.style.display = "none";
      _slashIdx = 0;
    }
    return;
  }
  // Popup hidden but input is a slash command - intercept Enter to execute
  if (e.key === "Enter" && !e.shiftKey && _activeInput.value.trim().startsWith("/")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const text = _activeInput.value.trim();
    _activeInput.value = "";
    if (_activeInput === input && typeof autoResizeInput === "function") autoResizeInput();
    executeSlashCommand(text);
  }
}

// Attach slash command support to a prompt textarea
function _attachSlashInput(textarea) {
  textarea.addEventListener("focus", () => {
    _activeInput = textarea;
    const box = textarea.closest(".prompt-box");
    if (box && _slashPopup.parentNode !== box) box.appendChild(_slashPopup);
  });
  textarea.addEventListener("input", _updateSlashPopup);
  textarea.addEventListener("keydown", _slashKeydown);
}

// Register all prompt inputs
_attachSlashInput(input); // chat
if (typeof studioPrompt !== "undefined" && studioPrompt) _attachSlashInput(studioPrompt);
if (typeof musicPrompt !== "undefined" && musicPrompt) _attachSlashInput(musicPrompt);
const _vp = document.getElementById("video-prompt");
if (_vp) _attachSlashInput(_vp);
if (typeof codePrompt !== "undefined" && codePrompt) _attachSlashInput(codePrompt);


// ══════════════════════════════════════════════════════════════
// COMMAND HANDLERS
// ══════════════════════════════════════════════════════════════

// ── Navigation & Toggles ──

registerCommand({
  name: "new", category: "Navigation", universal: true,
  description: "Start a new conversation or session",
  usage: "/new [folder name]",
  handler: async (args) => {
    const view = localStorage.getItem("wooz_view") || "chat";
    if (view === "chat") {
      if (args) {
        const folder = chatFolders.find(f => f.name.toLowerCase() === args.toLowerCase());
        if (folder) {
          activeChatFolderId = folder.id;
          localStorage.setItem("wooz_chat_folder", folder.id);
        } else {
          _cmdResult(`No folder named <strong>${esc(args)}</strong>. Starting in current folder.`, "info");
        }
      }
      newChatBtn.click();
      return;
    }
    const btnMap = {
      studio: "studio-new-session-btn",
      music:  "music-new-session-btn",
      video:  "video-new-session-btn",
      code:   "code-new-session-btn",
      notetaker: "notetaker-new-session-btn",
    };
    const btn = btnMap[view] && document.getElementById(btnMap[view]);
    if (btn) {
      btn.click();
      _cmdResult("New session started.", "success");
    } else {
      _cmdResult("Cannot create a new session in this view.", "error");
    }
  },
});

registerCommand({
  name: "switch", category: "Navigation", universal: true,
  description: "Switch to a studio view",
  usage: "/switch <chat|image|music|video|code|notes>",
  handler: async (args) => {
    if (!args) { _cmdResult("Usage: <code>/switch &lt;chat|image|music|video|code|notes&gt;</code>", "error"); return; }
    const key = args.toLowerCase();
    const handlers = {
      chat: () => { setView("chat"); prepareModelsForView("chat"); },
      image: showStudio, studio: showStudio, img: showStudio,
      music: showMusicStudio,
      video: showVideoStudio,
      code: showCodeStudio,
      notes: showNotetaker, notetaker: showNotetaker, note: showNotetaker,
    };
    const fn = handlers[key];
    if (!fn) {
      _cmdResult(`Unknown view. Options: <code>chat</code>, <code>image</code>, <code>music</code>, <code>video</code>, <code>code</code>, <code>notes</code>`, "error");
      return;
    }
    await fn();
  },
});

registerCommand({
  name: "web", category: "Navigation",
  description: "Toggle web search on/off",
  handler: async () => {
    webSearch = !webSearch;
    webBtn.classList.toggle("active", webSearch);
    webBtn.title = webSearch ? "Web search ON, click to disable" : "Toggle web search";
    const caution = document.getElementById("web-caution");
    if (caution) caution.classList.toggle("visible", webSearch);
    _cmdResult(`Web search <strong>${webSearch ? "ON" : "OFF"}</strong>`, "success");
  },
});

registerCommand({
  name: "vault", category: "Navigation",
  description: "Toggle File Vault (RAG) on/off",
  handler: async () => {
    ragSearch = !ragSearch;
    ragToggleBtn.classList.toggle("active", ragSearch);
    ragToggleBtn.title = ragSearch ? "File Vault active" : "File Vault off";
    if (!activeConvId) loadSuggestions();
    _cmdResult(`File Vault <strong>${ragSearch ? "ON" : "OFF"}</strong>`, "success");
  },
});

registerCommand({
  name: "attach", category: "Navigation",
  description: "Open the file/image attachment picker",
  handler: async () => {
    if (localStorage.getItem("wooz_view") !== "chat") {
      setView("chat");
      prepareModelsForView("chat");
    }
    fileInput.click();
  },
});

registerCommand({
  name: "voice", category: "Navigation",
  description: "Toggle voice conversation mode",
  handler: async () => {
    if (typeof voiceModeActive !== "undefined" && voiceModeActive) {
      stopVoiceMode();
      _cmdResult("Voice mode <strong>OFF</strong>", "success");
    } else if (typeof startVoiceMode === "function") {
      startVoiceMode();
    } else {
      _cmdResult("Voice mode not available.", "error");
    }
  },
});

registerCommand({
  name: "settings", category: "Navigation", universal: true,
  description: "Open the settings panel",
  handler: async () => {
    if (typeof openSettings === "function") openSettings();
  },
});

registerCommand({
  name: "logout", category: "Navigation", universal: true,
  description: "Log out of your account",
  handler: async () => {
    const ok = await showConfirm({ title: "Log out", message: "Are you sure you want to log out?", okLabel: "Log out", okClass: "danger" });
    if (!ok) return;
    try { await apiFetch("/auth/logout", { method: "POST" }); } catch {}
    if (typeof clearSession === "function") clearSession();
    location.reload();
  },
});

registerCommand({
  name: "debug", category: "Navigation", universal: true,
  description: "Toggle debug mode on/off",
  handler: async () => {
    debugMode = !debugMode;
    document.getElementById("debug-toggle").checked = debugMode;
    document.body.classList.toggle("debug-on", debugMode);
    saveSettings(); scheduleSettingsSync();
    _cmdResult(`Debug mode <strong>${debugMode ? "ON" : "OFF"}</strong>`, "success");
  },
});

registerCommand({
  name: "theme", category: "Navigation", universal: true,
  description: "Change the color theme",
  usage: "/theme <name>",
  handler: async (args) => {
    const current = localStorage.getItem("wooz_theme") || "midnight";
    const themeNames = Object.keys(THEMES).sort();
    if (!args) {
      const pills = themeNames.map(n =>
        `<span class="theme-pill${n === current ? " active" : ""}" data-theme="${esc(n)}">${esc(n)}</span>`
      ).join(" ");
      _cmdResult(`<strong>Themes</strong><br><br>${pills}`);
      _bindThemePills();
      return;
    }
    const name = args.toLowerCase();
    if (!THEMES[name]) {
      const pills = themeNames.map(n =>
        `<span class="theme-pill" data-theme="${esc(n)}">${esc(n)}</span>`
      ).join(" ");
      _cmdResult(`Unknown theme <code>${esc(name)}</code><br><br>${pills}`, "error");
      _bindThemePills();
      return;
    }
    applyTheme(name);
    scheduleSettingsSync();
    _cmdResult(`Theme set to <strong>${esc(name)}</strong>`, "success");
  },
});


// ── Chat Power Tools ──

registerCommand({
  name: "model", category: "Chat",
  description: "Switch the active LLM model",
  usage: "/model [name]",
  handler: async (args) => {
    if (!args) {
      const current = selectedModel || modelSelect.value || "(default)";
      const opts = [...modelSelect.options].map(o => o.value).filter(Boolean);
      _cmdResult(`Current: <strong>${esc(current)}</strong>. Available: <code>${opts.map(esc).join("</code>, <code>")}</code>`);
      return;
    }
    // Find matching option (case-insensitive, partial match)
    const opt = [...modelSelect.options].find(o =>
      o.value && o.value.toLowerCase().includes(args.toLowerCase())
    );
    if (!opt) {
      _cmdResult(`No model matching <code>${esc(args)}</code>`, "error");
      return;
    }
    modelSelect.value = opt.value;
    modelSelect.dispatchEvent(new Event("change"));
    _cmdResult(`Model set to <strong>${esc(opt.value)}</strong>`, "success");
  },
});

registerCommand({
  name: "temp", category: "Chat",
  description: "Set LLM temperature (0.0 - 2.0)",
  usage: "/temp <value>",
  handler: async (args) => {
    if (!args) {
      _cmdResult(`Temperature: <strong>${parseFloat(tempSlider.value).toFixed(2)}</strong>`);
      return;
    }
    const val = parseFloat(args);
    if (isNaN(val) || val < 0 || val > 2) {
      _cmdResult("Temperature must be between 0.0 and 2.0", "error");
      return;
    }
    tempSlider.value = val;
    updateSettingLabels(); saveSettings(); scheduleSettingsSync();
    _cmdResult(`Temperature set to <strong>${val.toFixed(2)}</strong>`, "success");
  },
});

let customSystemPrompt = null;

registerCommand({
  name: "system", category: "Chat",
  description: "Set a custom system prompt for this session",
  usage: "/system <prompt> (or /system clear)",
  handler: async (args) => {
    if (!args) {
      if (customSystemPrompt) {
        _cmdResult(`Custom system prompt: <em>${esc(customSystemPrompt)}</em>`);
      } else {
        _cmdResult("No custom system prompt set. Usage: <code>/system &lt;prompt&gt;</code> or <code>/system clear</code>");
      }
      return;
    }
    if (args.toLowerCase() === "clear" || args.toLowerCase() === "reset") {
      customSystemPrompt = null;
      _cmdResult("Custom system prompt cleared", "success");
      return;
    }
    customSystemPrompt = args;
    _cmdResult(`System prompt set: <em>${esc(args.length > 120 ? args.slice(0, 120) + "..." : args)}</em>`, "success");
  },
});

registerCommand({
  name: "compact", category: "Chat", universal: true,
  description: "Summarize and compact the current conversation or code session",
  handler: async () => {
    // Detect if we're in Code Studio
    const inCodeStudio = document.getElementById("code-studio")?.classList.contains("active");
    if (inCodeStudio) {
      if (typeof compactCodeSession !== "function") { _cmdResult("Compact not available.", "error"); return; }
      const confirmed = await showConfirm({
        title: "Compact Session",
        message: "This will summarize older messages and replace them with a compact summary. Recent messages are kept. Continue?",
        okLabel: "Compact",
      });
      if (!confirmed) return;
      await compactCodeSession();
      return;
    }
    if (!activeConvId) { _cmdResult("No active conversation to compact.", "error"); return; }
    const confirmed = await showConfirm({
      title: "Compact Conversation",
      message: "This will summarize all messages and replace them with a compact summary. Continue?",
      okLabel: "Compact",
    });
    if (!confirmed) return;
    _cmdResult("Compacting conversation...", "info");
    try {
      const res = await apiFetch(`/conversations/${activeConvId}/compact`, { method: "POST" });
      if (!res.ok) {
        const err = await res.text();
        _cmdResult(`Compact failed: ${esc(err)}`, "error");
        return;
      }
      await loadConversation(activeConvId);
      _cmdResult("Conversation compacted.", "success");
    } catch (e) {
      _cmdResult(`Compact failed: ${esc(e.message)}`, "error");
    }
  },
});

registerCommand({
  name: "summarize", category: "Chat",
  description: "Show a quick summary of the current conversation",
  handler: async () => {
    const rows = chatWindow.querySelectorAll(".message-row");
    let userCount = 0, aiCount = 0;
    rows.forEach(r => {
      if (r.querySelector(".user-bubble")) userCount++;
      else if (r.querySelector(".bubble")) aiCount++;
    });
    const model = selectedModel || modelSelect.value || "default";
    const convId = activeConvId || "none";
    _cmdResult(
      `<strong>Conversation stats</strong><br>` +
      `Messages: ${userCount} user, ${aiCount} assistant<br>` +
      `Model: <code>${esc(model)}</code><br>` +
      `Conversation ID: <code>${esc(convId)}</code>`
    );
  },
});

registerCommand({
  name: "rename", category: "Chat", universal: true,
  description: "Rename the current conversation or session",
  usage: "/rename <title>",
  handler: async (args) => {
    if (!args) { _cmdResult("Usage: <code>/rename &lt;title&gt;</code>", "error"); return; }
    const view = localStorage.getItem("wooz_view") || "chat";
    if (view === "chat") {
      if (!activeConvId) { _cmdResult("No active conversation.", "error"); return; }
      await apiFetch(`/conversations/${activeConvId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: args }),
      });
      loadConversations();
      _cmdResult(`Renamed to <strong>${esc(args)}</strong>`, "success");
      return;
    }
    // Studio session rename
    const studioMap = {
      studio:  { id: () => typeof activeStudioSessionId !== "undefined" ? activeStudioSessionId : null, api: "image", refresh: () => typeof renderStudioSessionsList === "function" && renderStudioSessionsList() },
      music:   { id: () => typeof activeMusicSessionId !== "undefined" ? activeMusicSessionId : null,   api: "music", refresh: () => typeof renderMusicSessionsList === "function" && renderMusicSessionsList() },
      video:   { id: () => typeof activeVideoSessionId !== "undefined" ? activeVideoSessionId : null,   api: "video", refresh: () => typeof renderVideoSessionsList === "function" && renderVideoSessionsList() },
      code:    { id: () => typeof activeCodeSessionId !== "undefined" ? activeCodeSessionId : null,      api: "code",  refresh: () => typeof renderCodeSessionsList === "function" && renderCodeSessionsList() },
    };
    const info = studioMap[view];
    if (!info) { _cmdResult("Rename is not supported in this view.", "error"); return; }
    const sessionId = info.id();
    if (!sessionId) { _cmdResult("No active session.", "error"); return; }
    // Find the first item in this session to PATCH its title
    try {
      const res = await apiFetch(`/studio/${info.api}/items`);
      if (!res.ok) throw new Error("Failed to load items");
      const items = await res.json();
      const match = items.filter(r => r.session_id === sessionId).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      if (!match.length) { _cmdResult("No items in this session to rename.", "error"); return; }
      await apiFetch(`/studio/${info.api}/items/${match[0].id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: args }),
      });
      info.refresh();
      _cmdResult(`Session renamed to <strong>${esc(args)}</strong>`, "success");
    } catch (e) {
      _cmdResult(`Rename failed: ${esc(e.message)}`, "error");
    }
  },
});

registerCommand({
  name: "export", category: "Chat",
  description: "Export conversation as markdown to clipboard",
  handler: async () => {
    const rows = chatWindow.querySelectorAll(".message-row");
    if (!rows.length) { _cmdResult("Nothing to export.", "error"); return; }
    let md = "";
    rows.forEach(r => {
      const userBubble = r.querySelector(".user-bubble");
      const aiBubble = r.querySelector(".bubble:not(.user-bubble)");
      if (userBubble) md += `## User\n${userBubble.textContent.trim()}\n\n`;
      else if (aiBubble) md += `## Assistant\n${aiBubble.textContent.trim()}\n\n---\n\n`;
    });
    try {
      await navigator.clipboard.writeText(md.trim());
      _cmdResult("Conversation exported to clipboard as markdown.", "success");
    } catch {
      _cmdResult("Clipboard write failed - check browser permissions.", "error");
    }
  },
});

registerCommand({
  name: "tts", category: "Chat",
  description: "Toggle TTS or read last response aloud",
  handler: async () => {
    // If currently speaking, stop all playback
    if (typeof ttsEnabled !== "undefined" && ttsEnabled) {
      stopAllTts();
      applyTTS(false);
      _cmdResult("TTS <strong>OFF</strong>", "success");
      return;
    }
    // Enable TTS and read last response
    applyTTS(true);
    const bubbles = chatWindow.querySelectorAll(".message-row .bubble:not(.user-bubble)");
    const last = bubbles[bubbles.length - 1];
    if (last) {
      speakText(last.textContent.trim(), getVoice(), null);
      _cmdResult("TTS <strong>ON</strong> - speaking last response...", "success");
    } else {
      _cmdResult("TTS <strong>ON</strong> - future responses will be read aloud.", "success");
    }
  },
});

registerCommand({
  name: "copy", category: "Chat",
  description: "Copy last AI response to clipboard",
  handler: async () => {
    const bubbles = chatWindow.querySelectorAll(".message-row .bubble:not(.user-bubble)");
    const last = bubbles[bubbles.length - 1];
    if (!last) { _cmdResult("No AI response to copy.", "error"); return; }
    try {
      await navigator.clipboard.writeText(last.textContent.trim());
      _cmdResult("Last response copied to clipboard.", "success");
    } catch {
      _cmdResult("Clipboard write failed.", "error");
    }
  },
});


// ── Memory ──

registerCommand({
  name: "remember", category: "Memory",
  description: "Save a fact to memory",
  usage: "/remember <fact>",
  handler: async (args) => {
    if (!args) { _cmdResult("Usage: <code>/remember &lt;fact&gt;</code>", "error"); return; }
    await apiFetch("/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fact: args }),
    });
    if (typeof loadMemory === "function") loadMemory();
    _cmdResult(`Remembered: <em>${esc(args)}</em>`, "success");
  },
});

registerCommand({
  name: "forget", category: "Memory",
  description: "Delete a memory fact by keyword",
  usage: "/forget <keyword>",
  handler: async (args) => {
    if (!args) { _cmdResult("Usage: <code>/forget &lt;keyword&gt;</code>", "error"); return; }
    const res = await apiFetch("/memory");
    if (!res.ok) { _cmdResult("Failed to load memory.", "error"); return; }
    const facts = await res.json();
    const matches = facts.filter(m => m.fact.toLowerCase().includes(args.toLowerCase()));
    if (!matches.length) { _cmdResult(`No memories matching <code>${esc(args)}</code>`, "error"); return; }
    if (matches.length > 1) {
      const confirmed = await showConfirm({
        title: "Delete Memories",
        message: `Found ${matches.length} matching memories:\n\n${matches.map(m => "- " + m.fact).join("\n")}\n\nDelete all?`,
        okLabel: "Delete All",
        okClass: "danger",
      });
      if (!confirmed) return;
    }
    for (const m of matches) {
      await apiFetch(`/memory/${m.id}`, { method: "DELETE" });
    }
    if (typeof loadMemory === "function") loadMemory();
    _cmdResult(`Deleted ${matches.length} memory fact${matches.length > 1 ? "s" : ""}.`, "success");
  },
});

registerCommand({
  name: "memories", category: "Memory",
  description: "List all stored memory facts",
  handler: async () => {
    const res = await apiFetch("/memory");
    if (!res.ok) { _cmdResult("Failed to load memory.", "error"); return; }
    const facts = await res.json();
    if (!facts.length) { _cmdResult("No memories stored."); return; }
    const list = facts.map(m => `- ${esc(m.fact)}`).join("<br>");
    _cmdResult(`<strong>Memory (${facts.length})</strong><br>${list}`);
  },
});


// ── Generation Shortcuts ──

// Wait for _modelReady[key] to become true (polls every 500ms, 60s timeout)
function _waitForModel(key, timeoutMs) {
  timeoutMs = timeoutMs || 60000;
  return new Promise((resolve, reject) => {
    if (_modelReady[key]) { resolve(); return; }
    const start = Date.now();
    const poll = setInterval(() => {
      if (_modelReady[key]) { clearInterval(poll); resolve(); }
      else if (Date.now() - start > timeoutMs) { clearInterval(poll); reject(new Error("Model load timed out")); }
    }, 500);
  });
}

registerCommand({
  name: "image", category: "Generate", universal: true,
  description: "Generate an image (switches to Image Studio)",
  usage: "/image <prompt>",
  handler: async (args) => {
    if (!args) { _cmdResult("Usage: <code>/image &lt;prompt&gt;</code>", "error"); return; }
    await showStudio();
    studioPrompt.value = args;
    studioPrompt.style.height = "auto";
    studioPrompt.style.height = Math.min(studioPrompt.scrollHeight, 140) + "px";
    await _waitForModel("studio");
    studioGenerate();
  },
});

registerCommand({
  name: "music", category: "Generate", universal: true,
  description: "Generate a music track (switches to Music Studio)",
  usage: "/music <prompt>",
  handler: async (args) => {
    if (!args) { _cmdResult("Usage: <code>/music &lt;prompt&gt;</code>", "error"); return; }
    await showMusicStudio();
    musicPrompt.value = args;
    await _waitForModel("music");
    musicGenerate();
  },
});

registerCommand({
  name: "video", category: "Generate", universal: true,
  description: "Generate a video clip (switches to Video Studio)",
  usage: "/video <prompt>",
  handler: async (args) => {
    if (!args) { _cmdResult("Usage: <code>/video &lt;prompt&gt;</code>", "error"); return; }
    await showVideoStudio();
    document.getElementById("video-prompt").value = args;
    await _waitForModel("video");
    videoGenerate();
  },
});

registerCommand({
  name: "code", category: "Generate", universal: true,
  description: "Generate code (switches to Code Studio)",
  usage: "/code <language> <description>",
  handler: async (args) => {
    if (!args) { _cmdResult("Usage: <code>/code &lt;language&gt; &lt;description&gt;</code>", "error"); return; }
    const spaceIdx = args.indexOf(" ");
    let lang, desc;
    if (spaceIdx === -1) {
      lang = args; desc = "";
    } else {
      lang = args.slice(0, spaceIdx);
      desc = args.slice(spaceIdx + 1).trim();
    }
    await showCodeStudio();
    // Try to set language dropdown
    if (codeLanguageSelect) {
      const opt = [...codeLanguageSelect.options].find(o =>
        o.value.toLowerCase() === lang.toLowerCase() ||
        o.textContent.toLowerCase() === lang.toLowerCase()
      );
      if (opt) codeLanguageSelect.value = opt.value;
    }
    if (desc) {
      codePrompt.value = desc;
      await _waitForModel("code");
      codeGenerate();
    }
  },
});


// ── Utility ──

registerCommand({
  name: "help", category: "Utility", universal: true,
  description: "Show all available slash commands",
  usage: "/help [command]",
  handler: async (args) => {
    if (args) {
      const cmd = SLASH_COMMANDS[args.toLowerCase().replace(/^\//, "")];
      if (!cmd) { _cmdResult(`Unknown command: <code>/${esc(args)}</code>`, "error"); return; }
      _cmdResult(
        `<strong>/${esc(cmd.name)}</strong> - ${esc(cmd.description)}<br>` +
        `Usage: <code>${esc(cmd.usage)}</code><br>` +
        `Category: ${esc(cmd.category)}`
      );
      return;
    }
    // Group by category, filter by context
    const isChat = (_activeInput === input);
    const groups = {};
    for (const cmd of Object.values(SLASH_COMMANDS)) {
      if (!isChat && !cmd.universal) continue;
      (groups[cmd.category] = groups[cmd.category] || []).push(cmd);
    }
    let html = "<strong>Slash Commands</strong><br><br>";
    for (const [cat, cmds] of Object.entries(groups)) {
      html += `<strong>${esc(cat)}</strong><br>`;
      for (const c of cmds.sort((a, b) => a.name.localeCompare(b.name))) {
        html += `<code>${esc(c.usage)}</code> - ${esc(c.description)}<br>`;
      }
      html += "<br>";
    }
    _cmdResult(html);
  },
});

registerCommand({
  name: "stats", category: "Utility",
  description: "Show current session stats and settings",
  handler: async () => {
    const rows = chatWindow.querySelectorAll(".message-row");
    let msgCount = 0;
    rows.forEach(r => { if (r.querySelector(".bubble")) msgCount++; });
    const model = selectedModel || modelSelect.value || "default";
    const temp = parseFloat(tempSlider.value).toFixed(2);
    const compact = parseInt(compactSlider.value);
    _cmdResult(
      `<strong>Session Stats</strong><br>` +
      `Model: <code>${esc(model)}</code><br>` +
      `Temperature: ${temp}<br>` +
      `Compact threshold: ${compact === 0 ? "Off" : compact + "%"}<br>` +
      `Web search: ${webSearch ? "ON" : "OFF"}<br>` +
      `File Vault: ${ragSearch ? "ON" : "OFF"}<br>` +
      `Debug: ${debugMode ? "ON" : "OFF"}<br>` +
      `Messages in view: ${msgCount}<br>` +
      `Conversation: <code>${esc(activeConvId || "none")}</code>`
    );
  },
});

registerCommand({
  name: "clear", category: "Utility", universal: true,
  description: "Clear the current conversation",
  handler: async () => {
    if (!activeConvId) { _cmdResult("No active conversation to clear.", "error"); return; }
    const confirmed = await showConfirm({
      title: "Clear Conversation",
      message: "Delete all messages in this conversation? This cannot be undone.",
      okLabel: "Clear",
      okClass: "danger",
    });
    if (!confirmed) return;
    await apiFetch(`/conversations/${activeConvId}`, { method: "DELETE" });
    loadConversations();
    newChatBtn.click();
    _cmdResult("Conversation cleared.", "success");
  },
});

registerCommand({
  name: "search", category: "Utility", universal: true,
  description: "Search across conversations",
  usage: "/search <query>",
  handler: async (args) => {
    if (!args) { _cmdResult("Usage: <code>/search &lt;query&gt;</code>", "error"); return; }
    openSearchModal();
    setTimeout(() => {
      searchInput.value = args;
      searchInput.dispatchEvent(new Event("input"));
    }, 100);
  },
});
