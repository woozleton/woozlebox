// ── Chat suggestions ──
function renderSuggestions(suggestions) {
  const el = document.getElementById("chat-suggestions");
  if (!el) return;
  el.innerHTML = suggestions.map(s =>
    `<button class="suggestion-chip">${s}</button>`
  ).join("");
  el.querySelectorAll(".suggestion-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      input.value = chip.textContent;
      input.style.height = "44px";
      input.dispatchEvent(new Event("input"));
      sendMessage();
    });
  });
}
async function loadSuggestions() {
  const el = document.getElementById("chat-suggestions");
  if (el) el.innerHTML = `<span style="font-size:0.75rem;color:var(--text-faint);font-style:italic;">Generating suggestions…</span>`;
  try {
    const model = selectedModel || "";
    const params = model ? `?model=${encodeURIComponent(model)}` : "";
    const res = await apiFetch(`/suggestions${params}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (data.suggestions?.length) renderSuggestions(data.suggestions);
    else if (el) el.innerHTML = "";
  } catch {
    if (el) el.innerHTML = "";
  }
}

// ── Re-index (shared logic) ──
async function runReindex({ statusBtn, statusBtnLabel } = {}) {
  if (statusBtn) {
    statusBtn.disabled = true;
    statusBtn.innerHTML = `<span class="step-spinner" style="display:inline-block;width:10px;height:10px;margin-right:4px;vertical-align:middle;"></span>Starting…`;
  }
  try {
    const res = await apiFetch(`/index/stream`, { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
        if (evt.error) { showToast(`Re-index failed: ${evt.error}`); break; }
        if (statusBtn) {
          if (evt.complete) {
            const doneMsg = evt.new === 0
              ? `✓ Up to date`
              : `✓ ${evt.new} new file${evt.new !== 1 ? "s" : ""} indexed`;
            statusBtn.innerHTML = doneMsg;
            setTimeout(() => {
              statusBtn.disabled = false;
              statusBtn.textContent = statusBtnLabel || "↺ Re-index";
            }, 1800);
          } else if (evt.total > 0) {
            statusBtn.innerHTML = `<span class="step-spinner" style="display:inline-block;width:10px;height:10px;margin-right:4px;vertical-align:middle;"></span>${evt.done}/${evt.total} files`;
          }
        }
        if (evt.complete) {
          if (vaultPanel.classList.contains("open") || vaultPanel.classList.contains("pinned")) loadVaultFiles();
          checkHealth();
        }
      }
    }
  } catch (e) {
    showToast(`Re-index failed: ${e.message}`);
    if (statusBtn) { statusBtn.disabled = false; statusBtn.textContent = statusBtnLabel || "↺ Re-index"; }
  }
}


// ── Chat Folders ──
let chatFolders = [];
let activeChatFolderId = localStorage.getItem("wooz_chat_folder") || null;
let editingFolderId = null;
let folderCtxTargetId = null;

async function ensureDefaultFolder() {
  if (chatFolders.length === 0) {
    // Auto-create a General folder instead of blocking with a modal
    try {
      const res = await apiFetch("/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "General", description: "Default folder for all conversations" }),
      });
      if (res.ok) {
        const created = await res.json();
        chatFolders.push(created);
      }
    } catch (_) {}
  }
  // Always keep activeChatFolderId valid
  const valid = chatFolders.find(p => p.id === activeChatFolderId);
  if (!valid && chatFolders.length > 0) {
    activeChatFolderId = chatFolders[0].id;
    localStorage.setItem("wooz_chat_folder", activeChatFolderId);
  }
}


function renderFoldersSidebar() {
  const list = document.getElementById("chat-folders-list");
  list.innerHTML = "";
  chatFolders.forEach(p => {
    const row = document.createElement("div");
    row.className = "sb-folder-row" + (p.id === activeChatFolderId ? " active" : "");
    row.dataset.id = p.id;
    row.innerHTML = `
      <svg class="sb-folder-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M1.5 3.5C1.5 2.948 1.948 2.5 2.5 2.5H6.086a1 1 0 0 1 .707.293L7.914 3.914A1 1 0 0 0 8.621 4.2H13.5c.552 0 1 .448 1 1v7.3c0 .552-.448 1-1 1h-11c-.552 0-1-.448-1-1V3.5z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
      </svg>
      <div class="sb-folder-info">
        <div class="sb-folder-name">${esc(p.name)}</div>
        ${p.description ? `<div class="sb-folder-desc">${esc(p.description)}</div>` : ""}
      </div>
      <button class="sb-folder-menu" title="Folder options">⋯</button>`;
    // Click to select (no deselect - a folder is always active)
    row.addEventListener("click", e => {
      if (e.target.classList.contains("sb-folder-menu")) return;
      activeChatFolderId = p.id;
      localStorage.setItem("wooz_chat_folder", p.id);
      renderFoldersSidebar();
      renderSidebar(allConversations, false);
    });
    // Drag-and-drop target
    row.addEventListener("dragover", e => {
      e.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", async e => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const cid = e.dataTransfer.getData("text/plain");
      if (!cid || p.id === activeChatFolderId) {
        // Moving within same folder or to same folder - still reassign
      }
      if (!cid) return;
      await apiFetch(`/conversations/${cid}/move`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder_id: p.id }),
      });
      activeChatFolderId = p.id;
      localStorage.setItem("wooz_chat_folder", p.id);
      await loadConversations();
    });
    row.querySelector(".sb-folder-menu").addEventListener("click", e => {
      e.stopPropagation();
      folderCtxTargetId = p.id;
      const menu = document.getElementById("folder-ctx-menu");
      menu.style.display = "block";
      menu.style.left = e.clientX + "px";
      menu.style.top = Math.min(e.clientY, window.innerHeight - 80) + "px";
    });
    list.appendChild(row);
  });
}

// Folder context menu
document.getElementById("folder-ctx-edit").addEventListener("click", () => {
  const p = chatFolders.find(p => p.id === folderCtxTargetId);
  if (p) openFolderModal(p);
  document.getElementById("folder-ctx-menu").style.display = "none";
});
document.getElementById("folder-ctx-delete").addEventListener("click", async () => {
  if (!folderCtxTargetId) return;
  document.getElementById("folder-ctx-menu").style.display = "none";
  if (chatFolders.length <= 1) {
    showToast("At least one folder must exist.");
    return;
  }
  const target = chatFolders.find(p => p.id === folderCtxTargetId);
  const fallback = chatFolders.find(p => p.id !== folderCtxTargetId);
  const chatCount = allConversations.filter(c => c.folder_id === folderCtxTargetId).length;
  const msg = chatCount > 0
    ? `Delete "${target?.name}"? Its ${chatCount} chat${chatCount !== 1 ? "s" : ""} will be moved to "${fallback?.name}".`
    : `Delete "${target?.name}"? This folder has no chats.`;
  const confirmed = await showConfirm({ title: "Delete Folder", message: msg });
  if (!confirmed) return;
  // Move all chats from deleted folder to first remaining folder
  const chatsToMove = allConversations.filter(c => c.folder_id === folderCtxTargetId);
  await Promise.all(chatsToMove.map(c =>
    apiFetch(`/conversations/${c.id}/move`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_id: fallback.id }),
    })
  ));
  await apiFetch(`/folders/${folderCtxTargetId}`, { method: "DELETE" });
  if (activeChatFolderId === folderCtxTargetId) {
    activeChatFolderId = fallback.id;
    localStorage.setItem("wooz_chat_folder", fallback.id);
  }
  folderCtxTargetId = null;
  await loadConversations();
});
document.addEventListener("click", e => {
  if (!e.target.closest("#folder-ctx-menu")) {
    document.getElementById("folder-ctx-menu").style.display = "none";
  }
});

// New folder button
document.getElementById("folder-new-btn").addEventListener("click", () => openFolderModal(null));

// Folder modal (uses shared-folder-modal)
let _folderModalResolve = null;
function openFolderModal(folder, { required = false } = {}) {
  editingFolderId = folder ? folder.id : null;
  document.getElementById("shared-folder-title").textContent = folder ? "Edit Folder" : "New Folder";
  document.getElementById("shared-folder-hint").textContent = "Folders organize your conversations and files into separate workspaces. Each folder can have its own AI behavior.";
  document.getElementById("shared-folder-name").value = folder?.name || "";
  document.getElementById("shared-folder-name").placeholder = "e.g. Research, Work, Personal";
  document.getElementById("shared-folder-desc").value = folder?.description || "";
  document.getElementById("shared-folder-prompt-wrap").style.display = "";
  document.getElementById("shared-folder-prompt").value = folder?.system_prompt || "";
  document.getElementById("shared-folder-save").textContent = folder ? "Save" : "Save Folder";
  // Hide close/cancel when a folder is required
  document.getElementById("shared-folder-close").style.display = required ? "none" : "";
  document.getElementById("shared-folder-cancel").style.display = required ? "none" : "";
  document.getElementById("shared-folder-save").onclick = async () => {
    const name = document.getElementById("shared-folder-name").value.trim();
    if (!name) { document.getElementById("shared-folder-name").focus(); return; }
    const body = {
      name,
      description: document.getElementById("shared-folder-desc").value.trim() || null,
      system_prompt: document.getElementById("shared-folder-prompt").value.trim() || null,
    };
    if (editingFolderId) {
      await apiFetch(`/folders/${editingFolderId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
    } else {
      const res = await apiFetch(`/folders`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.id) {
        activeChatFolderId = data.id;
        localStorage.setItem("wooz_chat_folder", data.id);
      }
    }
    closeFolderModal();
    await loadConversations();
  };
  document.getElementById("shared-folder-modal").classList.add("open");
  setTimeout(() => document.getElementById("shared-folder-name").focus(), 50);
  if (required) {
    return new Promise(resolve => { _folderModalResolve = resolve; });
  }
}
function closeFolderModal() {
  document.getElementById("shared-folder-modal").classList.remove("open");
  document.getElementById("shared-folder-close").style.display = "";
  document.getElementById("shared-folder-cancel").style.display = "";
  editingFolderId = null;
  if (_folderModalResolve) { _folderModalResolve(); _folderModalResolve = null; }
}


// ── Conversation sidebar ──
let allConversations = [];


async function loadConversations() {
  try {
    const [convRes, projRes] = await Promise.all([
      apiFetch(`/conversations`),
      apiFetch(`/folders`),
    ]);
    allConversations = await convRes.json();
    chatFolders = await projRes.json();
    await ensureDefaultFolder();
    renderFoldersSidebar();
    renderSidebar(allConversations, false);
  } catch(e) { console.error("loadConversations error:", e); }
}

function groupByDate(convs) {
  const groups = { Today: [], Yesterday: [], "Last 7 Days": [], Older: [] };
  const now = new Date();
  const today = now.toDateString();
  const yesterday = new Date(now - 86400000).toDateString();
  const week = new Date(now - 7 * 86400000);
  convs.forEach(c => {
    const d = new Date(c.updated_at);
    if (d.toDateString() === today) groups.Today.push(c);
    else if (d.toDateString() === yesterday) groups.Yesterday.push(c);
    else if (d >= week) groups["Last 7 Days"].push(c);
    else groups.Older.push(c);
  });
  return groups;
}

function makeConvItem(c) {
  const el = document.createElement("div");
  el.className = "sb-item conv-item" + (c.id === activeConvId ? " active" : "");
  el.dataset.id = c.id;
  el.dataset.initial = (c.title || "?")[0].toUpperCase();
  el.draggable = true;
  el.innerHTML = `<span class="sb-item-title conv-title">${esc(c.title)}</span><button class="sb-item-menu conv-menu-btn" data-id="${c.id}">⋯</button>`;
  el.addEventListener("click", (e) => {
    if (e.target.classList.contains("conv-menu-btn")) return;
    loadConversation(c.id);
  });
  el.querySelector(".conv-menu-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    openCtxMenu(e, c.id);
  });
  el.addEventListener("dragstart", e => {
    e.dataTransfer.setData("text/plain", c.id);
    el.classList.add("dragging");
  });
  el.addEventListener("dragend", () => el.classList.remove("dragging"));
  return el;
}

function renderSidebar(convs, flat = false) {
  convList.innerHTML = "";
  if (!convs.length) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:12px 10px;font-size:0.76rem;color:var(--text-faint);";
    empty.textContent = flat ? "No matching chats." : "No conversations yet.";
    convList.appendChild(empty);
    return;
  }
  if (flat) {
    convs.forEach(c => convList.appendChild(makeConvItem(c)));
    return;
  }
  // Always filter by active folder
  const filtered = activeChatFolderId
    ? convs.filter(c => c.folder_id === activeChatFolderId)
    : convs;

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:12px 10px;font-size:0.76rem;color:var(--text-faint);";
    empty.textContent = "No chats in this folder yet.";
    convList.appendChild(empty);
    return;
  }

  const groups = groupByDate(filtered);
  Object.entries(groups).forEach(([label, items]) => {
    if (!items.length) return;
    const gl = document.createElement("div");
    gl.className = "conv-group-label";
    gl.textContent = label;
    convList.appendChild(gl);
    items.forEach(c => convList.appendChild(makeConvItem(c)));
  });
}

async function loadConversation(id) {
  if (localStorage.getItem("wooz_view") !== "chat") {
    setView("chat");
    prepareModelsForView("chat");
  }
  try {
    const res = await apiFetch(`/conversations/${id}`);
    if (!res.ok) return;
    const data = await res.json();
    activeConvId = id;
    chatWindow.innerHTML = "";
    chatWindow.classList.remove("welcome-only");
    data.messages.forEach(msg => {
      if (msg.role === "user") appendUserBubble(msg.content);
      else appendAIBubble(msg.content, msg.sources || [], msg.web_sources || [], msg.model_used, null, null, msg.web_search_query || "");
    });
    updateActiveSidebar();
    scrollBottom();
    updateContextBar(id);
  } catch {}
}

function updateActiveSidebar() {
  document.querySelectorAll(".conv-item").forEach(el => {
    el.classList.toggle("active", el.dataset.id === activeConvId);
  });
}


// ── New chat ──
newChatBtn.addEventListener("click", async () => {
  if (localStorage.getItem("wooz_view") !== "chat") {
    setView("chat");
    prepareModelsForView("chat");
  }
  await ensureDefaultFolder();
  if (chatFolders.length === 0) return;
  activeConvId = null;
  chatWindow.innerHTML = "";
  chatWindow.appendChild(makeWelcome());
  document.getElementById("ctx-bar-wrap").style.display = "none";
  updateActiveSidebar();
  input.focus();
  loadSuggestions();
});

document.getElementById("conv-new-btn").addEventListener("click", () => {
  newChatBtn.click();
});

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}
function getWelcomeAvatarHtml() {
  const url = localStorage.getItem(AVATAR_KEY) || "";
  if (url) return `<img src="${url}" />`;
  const profile = JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}");
  const name = profile.name || currentUser?.username || "";
  return name ? name.charAt(0).toUpperCase() : "?";
}
function getWelcomeTitle() {
  const profile = JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}");
  const name = profile.name || currentUser?.username || "";
  return name ? `${getGreeting()}, ${name}` : getGreeting();
}
function makeWelcome() {
  const el = document.createElement("div");
  el.className = "welcome";
  el.id = "welcome-msg";
  el.innerHTML = `<div class="welcome-avatar" id="welcome-avatar">${getWelcomeAvatarHtml()}</div><h2 id="welcome-title">${getWelcomeTitle()}</h2><p class="welcome-sub">Ask me anything about your files, or turn on web search below.</p><div id="chat-suggestions"></div>`;
  document.getElementById("chat-window")?.classList.add("welcome-only");
  return el;
}


// ── Input ──
input.addEventListener("input", () => {
  input.style.height = "44px";
  if (input.scrollHeight > input.clientHeight) {
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  }
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  if (e.key === "ArrowUp" && !isLoading) {
    if (messageHistory.length === 0) return;
    if (historyIndex === -1) historyIndex = messageHistory.length - 1;
    else if (historyIndex > 0) historyIndex--;
    input.value = messageHistory[historyIndex];
    e.preventDefault();
    setTimeout(() => { input.setSelectionRange(input.value.length, input.value.length); }, 0);
  }
  if (e.key === "ArrowDown" && historyIndex !== -1) {
    historyIndex++;
    if (historyIndex >= messageHistory.length) { historyIndex = -1; input.value = ""; }
    else input.value = messageHistory[historyIndex];
    e.preventDefault();
  }
});
sendBtn.addEventListener("click", () => { if (isLoading) stopStream(); else sendMessage(); });

function ts() { return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }

// Memory brain button SVG helpers
// active=false: outline brain (unsaved), active=true: filled accent brain (saved)
function memBrainSvg(active) {
  const fill = active ? 'var(--accent)' : 'none';
  const stroke = active ? 'var(--accent)' : 'currentColor';
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="${fill}" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/></svg>`;
}
// Spinning arc shown while saving/loading
function memSpinSvg() {
  return `<svg class="mem-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="9" stroke-dasharray="42 14"/></svg>`;
}

// esc() is defined in config.js
function scrollBottom() { chatWindow.scrollTop = chatWindow.scrollHeight; }
const SVG_SEND = icon("send", 16);
const SVG_STOP = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none"/></svg>`;

let chatAbortController = null;

function stopStream() {
  chatAbortController?.abort();
  chatAbortController = null;
}

function setLoading(v) {
  isLoading = v;
  input.disabled = false; // keep input enabled so user can queue more messages
  sendBtn.disabled = false; // always clickable - acts as stop when loading
  sendBtn.innerHTML = v ? SVG_STOP : SVG_SEND;
  sendBtn.title = v ? "Stop" : "Send (Enter)";
  sendBtn.classList.toggle("stopping", v);
}

// ── Append user bubble ──
function appendUserBubble(text, images) {
  document.getElementById("welcome-msg")?.remove();
  document.getElementById("chat-window")?.classList.remove("welcome-only");
  const row = document.createElement("div");
  row.className = "message-row user";
  // Build avatar from profile name or username
  let avatarInitials = "?";
  let avatarDataUrl = localStorage.getItem(AVATAR_KEY) || "";
  try {
    const p = JSON.parse(localStorage.getItem("wooz_profile") || "{}");
    const name = p.name || currentUser?.username || "";
    avatarInitials = name.trim().split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 2) || "?";
  } catch {}
  const avatarInner = avatarDataUrl
    ? `<img src="${avatarDataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`
    : avatarInitials;
  const imagesHtml = (images && images.length) ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;">${images.map(src => `<img src="${src}" style="max-width:180px;max-height:140px;border-radius:8px;border:1px solid var(--border);cursor:pointer;" onclick="window.open(this.src)" />`).join("")}</div>` : "";
  row.innerHTML = `
    <div class="bubble-wrap">
      <div class="user-avatar-bubble">${avatarInner}</div>
      <div class="bubble">${imagesHtml}${esc(text)}</div>
      <div class="msg-meta">
        <span class="timestamp">${ts()}</span>
        <span class="bubble-actions">
          <button class="mem-btn bubble-action-btn" title="Save to memory">${memBrainSvg(false)}</button>
          <button class="tts-btn bubble-action-btn" title="Read aloud">${icon("play", 13)}</button>
          <button class="copy-btn bubble-action-btn" title="Copy">${icon("copy", 13)}</button>
        </span>
      </div>
    </div>
  `;

  // Memory brain button (toggle save/remove) for user messages
  row.querySelector(".mem-btn").addEventListener("click", async function() {
    const btn = this;
    if (btn.dataset.memoryActive === "true") {
      btn.disabled = true;
      btn.innerHTML = memSpinSvg();
      try {
        await apiFetch(`/memory/${btn.dataset.memoryId}`, { method: "DELETE" });
        showMemoryToast("Memory removed");
        btn.dataset.memoryActive = "";
        btn.dataset.memoryId = "";
        btn.classList.remove("active");
        btn.title = "Save to memory";
        btn.innerHTML = memBrainSvg(false);
      } catch { showToast("Failed to remove memory."); btn.innerHTML = memBrainSvg(true); }
      btn.disabled = false;
      return;
    }
    btn.disabled = true;
    btn.innerHTML = memSpinSvg();
    try {
      const res = await apiFetch("/memory", {
        method: "POST",
        body: JSON.stringify({ fact: text }),
      });
      const data = await res.json();
      showMemoryToast("Saved to memory");
      btn.innerHTML = memBrainSvg(true);
      btn.classList.add("active");
      btn.dataset.memoryActive = "true";
      btn.dataset.memoryId = data.id || "";
      btn.title = "Remove from memory";
    } catch (e) {
      showToast("Failed to save memory.");
      btn.innerHTML = memBrainSvg(false);
    }
    btn.disabled = false;
  });

  row.querySelector(".copy-btn").addEventListener("click", function() {
    navigator.clipboard.writeText(text).then(() => {
      this.innerHTML = icon("check", 13);
      this.classList.add("copied");
      setTimeout(() => {
        this.innerHTML = icon("copy", 13);
        this.classList.remove("copied");
      }, 2000);
    });
  });

  const playBtn = row.querySelector(".tts-btn");
  playBtn.addEventListener("click", () => {
    if (playBtn.classList.contains("playing")) stopSpeaking();
    else speakText(text, getVoice(), playBtn);
  });

  chatWindow.appendChild(row);
  scrollBottom();
}


// ── Append AI bubble (final) ──
function appendAIBubble(text, sources, webSources, modelUsed, debugData, stepRows, webSearchQuery) {
  // Remove status steps if they exist
  stepRows?.forEach(r => r.remove());

  const row = document.createElement("div");
  row.className = "message-row ai";

  // AI avatar html
  const aiAvatarDataUrl = localStorage.getItem(AI_AVATAR_KEY) || "";
  const aiAvatarLetter = (JSON.parse(localStorage.getItem(BRAND_KEY) || "{}").name || "D").trim().charAt(0).toUpperCase();
  const aiAvatarInner = aiAvatarDataUrl
    ? `<img src="${aiAvatarDataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`
    : aiAvatarLetter;

  // Sources HTML
  let sourcesToggle = "";
  let sourcesPanelHtml = "";
  const totalSources = sources.length + webSources.length;
  if (totalSources > 0) {
    const parts = [];
    if (sources.length) parts.push(`${sources.length} vault source${sources.length>1?"s":""}`);
    if (webSources.length) parts.push(`${webSources.length} web result${webSources.length>1?"s":""}`);
    const label = parts.join(", ");
    sourcesToggle = `<button class="sources-toggle" title="Show sources">${icon("chevron-right", 7)}${label}</button>`;
    let panelItems = "";
    if (sources.length) {
      panelItems += `<div class="sources-panel-label">Vault</div>`;
      sources.forEach(s => {
        const name = s.split("/").pop();
        panelItems += `<button class="source-link" data-path="${esc(s)}">${icon("file", 11)}${esc(name)}</button>`;
      });
    }
    if (webSources.length) {
      const webLabel = webSearchQuery ? `Web: <em style="opacity:0.6;font-style:normal;">${esc(webSearchQuery)}</em>` : "Web";
      panelItems += `<div class="sources-panel-label" style="margin-top:4px;">${webLabel}</div>`;
      webSources.forEach(s => {
        panelItems += `<a class="web-link" href="${esc(s.url)}" target="_blank" rel="noopener">${icon("globe", 11)}<span>${esc(s.title||s.url)}</span></a>`;
      });
    }
    sourcesPanelHtml = `<div class="sources-panel">${panelItems}</div>`;
  }

  // Debug pill
  let debugHtml = "";
  if (debugData) {
    const t = debugData.timings || {};
    // Timing labels: emb=embed query, vlt=vault search, web=web search, ttft=time-to-first-token, tot=total wall-clock
    const timingParts = [];
    if (t.embed_ms != null) timingParts.push(`emb:${t.embed_ms}ms`);
    if (t.vault_ms != null) timingParts.push(`vlt:${t.vault_ms}ms`);
    if (t.web_ms != null) timingParts.push(`web:${t.web_ms}ms`);
    if (t.ttft_ms != null) timingParts.push(`ttft:${t.ttft_ms}ms`);
    if (t.total_ms != null) timingParts.push(`tot:${t.total_ms}ms`);
    const timingStr = timingParts.length ? ` · ${timingParts.join(" ")}` : "";
    debugHtml = `<span class="debug-pill">dist:${debugData.best_distance?.toFixed(3)} thr:${debugData.threshold} chunks:${debugData.chunks_used}/${debugData.chunks_retrieved}${debugData.tok_s ? ` ${debugData.tok_s} tok/s` : ""}${timingStr}</span>`;
  }

  const modelTag = modelUsed ? `<span class="model-tag">${esc(modelUsed)}</span>` : "";

  row.innerHTML = `
    <div class="bubble-wrap">
      <div class="ai-avatar-bubble">${aiAvatarInner}</div>
      <div class="bubble">${renderMarkdown(text)}</div>
      <div class="msg-meta">
        <span class="timestamp">${ts()}</span>
        ${modelUsed ? `<span class="meta-sep">·</span>${modelTag}` : ""}
        ${debugHtml}
        ${sourcesToggle ? `<span class="meta-sep">·</span>${sourcesToggle}` : ""}
        <span class="bubble-actions" style="margin-left:auto;">
          <button class="mem-btn bubble-action-btn" title="Save to memory">${memBrainSvg(false)}</button>
          <button class="tts-btn bubble-action-btn" title="Play">${icon("play", 13)}</button>
          <button class="copy-btn bubble-action-btn" title="Copy">${icon("copy", 13)}</button>
        </span>
      </div>
      ${sourcesPanelHtml}
    </div>
  `;

  // Memory brain button (toggle save/remove)
  row.querySelector(".mem-btn").addEventListener("click", async function() {
    const btn = this;
    if (btn.dataset.memoryActive === "true") {
      btn.disabled = true;
      btn.innerHTML = memSpinSvg();
      try {
        await apiFetch(`/memory/${btn.dataset.memoryId}`, { method: "DELETE" });
        showMemoryToast("Memory removed");
        btn.dataset.memoryActive = "";
        btn.dataset.memoryId = "";
        btn.classList.remove("active");
        btn.title = "Save to memory";
        btn.innerHTML = memBrainSvg(false);
      } catch { showToast("Failed to remove memory."); btn.innerHTML = memBrainSvg(true); }
      btn.disabled = false;
      return;
    }
    btn.disabled = true;
    btn.innerHTML = memSpinSvg();
    try {
      const res = await apiFetch("/chat/extract-memory", {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (data.saved) {
        showMemoryToast("Saved to memory: " + data.fact);
        btn.innerHTML = memBrainSvg(true);
        btn.classList.add("active");
        btn.dataset.memoryActive = "true";
        btn.dataset.memoryId = data.id || "";
        btn.title = "Remove from memory";
      } else {
        showToast(data.reason || "Nothing to save.", "success");
        btn.innerHTML = memBrainSvg(false);
      }
    } catch (e) {
      showToast("Failed to save memory.");
      btn.innerHTML = memBrainSvg(false);
    }
    btn.disabled = false;
  });

  // Copy button
  row.querySelector(".copy-btn").addEventListener("click", function() {
    navigator.clipboard.writeText(text).then(() => {
      this.innerHTML = icon("check", 13);
      this.classList.add("copied");
      setTimeout(() => {
        this.innerHTML = icon("copy", 13);
        this.classList.remove("copied");
      }, 2000);
    });
  });

  // TTS play button
  const playBtn = row.querySelector(".tts-btn");
  playBtn.addEventListener("click", () => {
    if (playBtn.classList.contains("playing")) {
      stopSpeaking();
    } else {
      speakText(text, getVoice(), playBtn);
    }
  });

  // Sources toggle
  const toggle = row.querySelector(".sources-toggle");
  if (toggle) {
    const panel = row.querySelector(".sources-panel");
    toggle.addEventListener("click", () => {
      const open = panel.classList.toggle("open");
      toggle.classList.toggle("open", open);
      if (open) setTimeout(() => {
        const panelBottom = panel.getBoundingClientRect().bottom;
        const windowBottom = chatWindow.getBoundingClientRect().bottom;
        if (panelBottom > windowBottom) chatWindow.scrollTop += panelBottom - windowBottom + 8;
      }, 50);
    });
  }

  chatWindow.appendChild(row);
  scrollBottom();
  return row;
}

// ── File preview modal ──
chatWindow.addEventListener("click", async (e) => {
  const btn = e.target.closest(".source-link");
  if (!btn) return;
  const path = btn.dataset.path;
  const name = path.split("/").pop();
  previewVaultFile({ name, path });
});
function expandTable(btn) {
  const table = btn.closest(".md-table-wrap").querySelector(".md-table");
  const modal = document.getElementById("file-modal");
  const title = document.getElementById("file-modal-title");
  const content = document.getElementById("file-modal-content");
  const pdfFrame = document.getElementById("file-modal-pdf");
  title.textContent = "Table View";
  pdfFrame.style.display = "none";
  pdfFrame.src = "";
  content.style.display = "";
  content.style.whiteSpace = "normal";
  content.style.padding = "20px 24px";
  const clone = table.cloneNode(true);
  clone.style.cssText = "border-collapse:collapse;width:100%;font-size:0.9rem;table-layout:fixed;";
  clone.querySelectorAll("th,td").forEach(c => {
    c.style.cssText = "border:1px solid var(--border);padding:10px 16px;text-align:left;vertical-align:top;white-space:normal;word-break:break-word;";
  });
  clone.querySelectorAll("th").forEach(c => {
    c.style.background = "var(--surface3)";
    c.style.fontWeight = "600";
    c.style.color = "var(--text)";
  });
  content.innerHTML = "";
  content.appendChild(clone);
  modal.style.display = "flex";
}

function closeFileModal() {
  document.getElementById("file-modal").style.display = "none";
  document.getElementById("file-modal-pdf").src = "";
}
document.getElementById("file-modal-close").addEventListener("click", closeFileModal);

// ── Streaming status steps ──
function createStatusSteps() {
  const container = document.createElement("div");
  container.className = "status-steps";
  chatWindow.appendChild(container);

  // One label that updates in-place. Hidden until first step.
  const row = document.createElement("div");
  row.className = "status-step";
  row.style.display = "none";
  row.innerHTML = `<span class="step-icon"><span class="step-spinner"></span></span><span class="step-text"></span>`;
  container.appendChild(row);
  const label = row.querySelector(".step-text");

  function addStep(text) {
    label.textContent = text;
    row.style.display = "flex";
    row.querySelector(".step-icon").innerHTML = `<span class="step-spinner"></span>`;
    scrollBottom();
    return row;
  }
  function updateStep(_, text) {
    label.textContent = text;
  }
  function completeStep(_, text) {
    // Just update text - don't hide, next addStep will overwrite
    label.textContent = text;
    row.querySelector(".step-icon").innerHTML = `<span class="step-check">✓</span>`;
  }

  return { container, addStep, updateStep, completeStep };
}

// ── Streaming AI bubble ──
function createStreamingBubble() {
  const row = document.createElement("div");
  row.className = "message-row ai";
  const aiAvatarDataUrl = localStorage.getItem(AI_AVATAR_KEY) || "";
  const aiAvatarLetterS = (JSON.parse(localStorage.getItem(BRAND_KEY) || "{}").name || "D").trim().charAt(0).toUpperCase();
  const aiAvatarInnerS = aiAvatarDataUrl
    ? `<img src="${aiAvatarDataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`
    : aiAvatarLetterS;
  const wrap = document.createElement("div");
  wrap.className = "bubble-wrap";
  wrap.innerHTML = `<div class="ai-avatar-bubble">${aiAvatarInnerS}</div>`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  // Show typing dots until first token arrives
  bubble.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div>`;
  wrap.appendChild(bubble);
  row.appendChild(wrap);
  chatWindow.appendChild(row);
  scrollBottom();

  let rawText = "";
  let typingDotsRemoved = false;

  function appendToken(token) {
    if (!typingDotsRemoved) {
      bubble.innerHTML = `<span class="stream-cursor"></span>`;
      typingDotsRemoved = true;
    }
    rawText += token;
    const cursor = bubble.querySelector(".stream-cursor");
    const textNode = document.createTextNode(token);
    bubble.insertBefore(textNode, cursor);
    scrollBottom();
  }

  function finalize(fullText, sources, webSources, modelUsed, debugData, stepRows, webSearchQuery) {
    // Remove status steps
    stepRows?.forEach(r => r.remove());

    // Replace streaming bubble content with rendered markdown in-place (no DOM remove/re-add)
    bubble.innerHTML = renderMarkdown(fullText);

    // Build meta row
    const totalSources = sources.length + webSources.length;
    let sourcesToggle = "", sourcesPanelHtml = "";
    if (totalSources > 0) {
      const parts = [];
      if (sources.length) parts.push(`${sources.length} vault source${sources.length>1?"s":""}`);
      if (webSources.length) parts.push(`${webSources.length} web result${webSources.length>1?"s":""}`);
      sourcesToggle = `<button class="sources-toggle" title="Show sources">${icon("chevron-right", 7)}${parts.join(", ")}</button>`;
      let panelItems = "";
      if (sources.length) {
        panelItems += `<div class="sources-panel-label">Vault</div>`;
        sources.forEach(s => { const name = s.split("/").pop(); panelItems += `<button class="source-link" data-path="${esc(s)}">${icon("file", 11)}${esc(name)}</button>`; });
      }
      if (webSources.length) {
        const webLabel = webSearchQuery ? `Web: <em style="opacity:0.6;font-style:normal;">${esc(webSearchQuery)}</em>` : "Web";
        panelItems += `<div class="sources-panel-label" style="margin-top:4px;">${webLabel}</div>`;
        webSources.forEach(s => { panelItems += `<a class="web-link" href="${esc(s.url)}" target="_blank" rel="noopener">${icon("globe", 11)}<span>${esc(s.title||s.url)}</span></a>`; });
      }
      sourcesPanelHtml = `<div class="sources-panel">${panelItems}</div>`;
    }
    const _t = (debugData?.timings) || {};
    // Timing labels: emb=embed query, vlt=vault search, web=web search, ttft=time-to-first-token, tot=total wall-clock
    const _tp = [];
    if (_t.embed_ms != null) _tp.push(`emb:${_t.embed_ms}ms`);
    if (_t.vault_ms != null) _tp.push(`vlt:${_t.vault_ms}ms`);
    if (_t.web_ms != null) _tp.push(`web:${_t.web_ms}ms`);
    if (_t.ttft_ms != null) _tp.push(`ttft:${_t.ttft_ms}ms`);
    if (_t.total_ms != null) _tp.push(`tot:${_t.total_ms}ms`);
    const _timingStr = _tp.length ? ` · ${_tp.join(" ")}` : "";
    const debugHtml = debugData ? `<span class="debug-pill">dist:${debugData.best_distance?.toFixed(3)} thr:${debugData.threshold} chunks:${debugData.chunks_used}/${debugData.chunks_retrieved}${debugData.tok_s ? ` ${debugData.tok_s} tok/s` : ""}${_timingStr}</span>` : "";
    const modelTag = modelUsed ? `<span class="model-tag">${esc(modelUsed)}</span>` : "";

    const meta = document.createElement("div");
    meta.className = "msg-meta";
    meta.innerHTML = `<span class="timestamp">${ts()}</span>${modelUsed ? `<span class="meta-sep">·</span>${modelTag}` : ""}${debugHtml}${sourcesToggle ? `<span class="meta-sep">·</span>${sourcesToggle}` : ""}<span class="bubble-actions" style="margin-left:auto;"><button class="mem-btn bubble-action-btn" title="Save to memory">${memBrainSvg(false)}</button><button class="tts-btn bubble-action-btn" title="Play">${icon("play", 13)}</button><button class="copy-btn bubble-action-btn" title="Copy">${icon("copy", 13)}</button></span>`;
    wrap.appendChild(meta);
    if (sourcesPanelHtml) { const sp = document.createElement("div"); sp.innerHTML = sourcesPanelHtml; wrap.appendChild(sp.firstChild); }

    // Wire copy button
    meta.querySelector(".copy-btn").addEventListener("click", function() {
      navigator.clipboard.writeText(fullText).then(() => {
        this.innerHTML = icon("check", 13);
        this.classList.add("copied");
        setTimeout(() => { this.innerHTML = icon("copy", 13); this.classList.remove("copied"); }, 2000);
      });
    });
    // Wire TTS button
    const playBtn = meta.querySelector(".tts-btn");
    playBtn.addEventListener("click", () => { if (playBtn.classList.contains("playing")) { stopSpeaking(); } else { speakText(fullText, getVoice(), playBtn); } });
    // Wire sources toggle
    const toggle = meta.querySelector(".sources-toggle");
    if (toggle) {
      const panel = wrap.querySelector(".sources-panel");
      toggle.addEventListener("click", () => {
        const open = panel.classList.toggle("open");
        toggle.classList.toggle("open", open);
        if (open) setTimeout(() => { const pb = panel.getBoundingClientRect().bottom; const wb = chatWindow.getBoundingClientRect().bottom; if (pb > wb) chatWindow.scrollTop += pb - wb + 8; }, 50);
      });
    }
    // Wire vault source links
    wrap.querySelectorAll(".source-link").forEach(btn => { btn.addEventListener("click", () => openVaultFile(btn.dataset.path)); });

    // Wire memory brain button (toggle save/remove)
    meta.querySelector(".mem-btn").addEventListener("click", async function() {
      const btn = this;
      if (btn.dataset.memoryActive === "true") {
        btn.disabled = true;
        btn.innerHTML = memSpinSvg();
        try {
          await apiFetch(`/memory/${btn.dataset.memoryId}`, { method: "DELETE" });
          showMemoryToast("Memory removed");
          btn.dataset.memoryActive = "";
          btn.dataset.memoryId = "";
          btn.classList.remove("active");
          btn.title = "Save to memory";
          btn.innerHTML = memBrainSvg(false);
        } catch { showToast("Failed to remove memory."); btn.innerHTML = memBrainSvg(true); }
        btn.disabled = false;
        return;
      }
      btn.disabled = true;
      btn.innerHTML = memSpinSvg();
      try {
        const res = await apiFetch("/chat/extract-memory", {
          method: "POST",
          body: JSON.stringify({ text: fullText }),
        });
        const data = await res.json();
        if (data.saved) {
          showMemoryToast("Saved to memory: " + data.fact);
          btn.innerHTML = memBrainSvg(true);
          btn.classList.add("active");
          btn.dataset.memoryActive = "true";
          btn.dataset.memoryId = data.id || "";
          btn.title = "Remove from memory";
        } else {
          showToast(data.reason || "Nothing to save.", "success");
          btn.innerHTML = memBrainSvg(false);
        }
      } catch (e) {
        showToast("Failed to save memory.");
        btn.innerHTML = memBrainSvg(false);
      }
      btn.disabled = false;
    });

    scrollBottom();
  }

  return { row, appendToken, finalize };
}

// ── Image generation ──

function appendImageBubble(prompt, b64Image, elapsedS, modelName) {
  const row = document.createElement("div");
  row.className = "message-row ai";

  const aiAvatarDataUrl = localStorage.getItem(AI_AVATAR_KEY) || "";
  const aiAvatarLetter = (JSON.parse(localStorage.getItem(BRAND_KEY) || "{}").name || "D").trim().charAt(0).toUpperCase();
  const aiAvatarInner = aiAvatarDataUrl
    ? `<img src="${aiAvatarDataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`
    : aiAvatarLetter;

  const src = `data:image/png;base64,${b64Image}`;
  const elapsedLabel = elapsedS ? ` · ${elapsedS}s` : "";

  const wrap = document.createElement("div");
  wrap.className = "bubble-wrap";
  wrap.innerHTML = `
    <div class="ai-avatar-bubble">${aiAvatarInner}</div>
    <div class="bubble">
      <div class="generated-image-wrap">
        <img src="${src}" alt="${esc(prompt)}" onclick="window.open(this.src)" />
        <div class="generated-image-caption">${esc(prompt)}</div>
        <button class="image-download-btn">
          ${icon("upload", 12)}
          Save image
        </button>
      </div>
    </div>
    <div class="msg-meta">
      <span class="timestamp">${ts()}</span>
      <span class="meta-sep">·</span>
      <span class="model-tag">${esc(modelName || "image-gen")}${elapsedLabel}</span>
    </div>
  `;

  wrap.querySelector(".image-download-btn").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = src;
    a.download = `generated-${Date.now()}.png`;
    a.click();
  });

  row.appendChild(wrap);
  chatWindow.appendChild(row);
  scrollBottom();
  return row;
}

async function sendImageRequest(prompt) {
  appendUserBubble(prompt, []);
  const steps = createStatusSteps();
  const step = steps.addStep("Generating image…");

  // Poll /image/progress every second and update the step label with live step count
  let pollTimer = setInterval(async () => {
    try {
      const pr = await mediaFetch("/image/progress");
      if (!pr.ok) return;
      const p = await pr.json();
      if (p.running && p.total_steps > 0) {
        steps.updateStep(step, `Generating image… step ${p.step}/${p.total_steps} (${p.elapsed_s}s)`);
      } else if (!p.running && p.step === 0) {
        steps.updateStep(step, "Unloading LLM from VRAM…");
      }
    } catch {}
  }, 1000);

  try {
    const res = await mediaFetch("/image/generate", {
      method: "POST",
      body: JSON.stringify({ prompt, aspect: "square", model: localStorage.getItem("wooz_image_model") || null }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.detail || `HTTP ${res.status}`);
    }
    steps.completeStep(step, "Image generated");
    steps.container.remove();
    const data = await res.json();
    appendImageBubble(data.prompt, data.image, data.elapsed_s, data.model);
  } catch (err) {
    steps.container.remove();
    appendAIBubble(
      `Sorry, I couldn't generate that image. ${err.message || "Please try again."}`,
      [], [], null, null, null, ""
    );
  } finally {
    clearInterval(pollTimer);
    setLoading(false);
    input.focus();
  }
}


// ── Main send ──
// ── Message Queue ──
let messageQueue = []; // [{text, images}]

function renderQueueTray() {
  const tray = document.getElementById("queue-tray");
  if (!tray) return;
  tray.innerHTML = messageQueue.map((item, i) => `
    <div class="queue-item" data-idx="${i}">
      <span class="queue-item-pos">#${i + 1}</span>
      <span class="queue-item-text">${esc(item.text)}</span>
      <button class="queue-item-cancel" title="Remove from queue" data-idx="${i}">
        ${icon("x", 11)}
      </button>
    </div>
  `).join("");
  tray.querySelectorAll(".queue-item-cancel").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      messageQueue.splice(idx, 1);
      renderQueueTray();
    });
  });
}

async function sendMessage() {
  const text = input.value.trim();
  if (!text) return;
  await ensureDefaultFolder();
  if (!activeChatFolderId || chatFolders.length === 0) return;

  // Capture any attached images before clearing
  const attachedImages = [...pendingImages];
  pendingImages = [];
  renderImagePreviews();

  // If already processing, push to queue instead of sending now
  if (isLoading) {
    messageQueue.push({ text, images: attachedImages });
    renderQueueTray();
    input.value = "";
    input.style.height = "44px";
    return;
  }

  messageHistory.push(text);
  historyIndex = -1;
  input.value = "";
  input.style.height = "44px";
  setLoading(true);
  stopSpeaking();
  appendUserBubble(text, attachedImages);

  const steps = createStatusSteps();
  let currentStep = null;
  let streamBubble = null;
  let fullAnswer = "";
  let convId = activeConvId;
  let tokenCount = 0;
  let firstTokenTime = null;

  const body = {
    message: text,
    model: selectedModel,
    conversation_id: convId,
    folder_id: activeChatFolderId || null,
    temperature: parseFloat(tempSlider.value),
    threshold: parseFloat(threshSlider.value),
    top_k: parseInt(topkSlider.value),
    web_search: webSearch,
    history_limit: parseInt(historySlider.value),
    compact_threshold: parseInt(compactSlider.value),
    user_context: getProfileContext(),
    default_prompt: document.getElementById("default-prompt-input").value.trim() || null,
    auto_memory: document.getElementById("auto-memory-toggle").checked,
    images: attachedImages.map(d => d.replace(/^data:image\/[^;]+;base64,/, "")),
  };

  chatAbortController = new AbortController();
  try {
    const res = await apiFetch(`/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: chatAbortController.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
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
        let event;
        try { event = JSON.parse(line.slice(6)); } catch { continue; }

        if (event.type === "status") {
          if (event.done) {
            if (currentStep) steps.completeStep(currentStep, event.text);
            currentStep = null;
          } else if (currentStep) {
            steps.updateStep(currentStep, event.text);
          } else {
            currentStep = steps.addStep(event.text);
          }
        } else if (event.type === "token") {
          if (!streamBubble) {
            steps.container.remove();
            streamBubble = createStreamingBubble();
          }
          if (!firstTokenTime) firstTokenTime = performance.now();
          tokenCount++;
          fullAnswer += event.text;
          streamBubble.appendToken(event.text);
        } else if (event.type === "memory_saved") {
          (event.facts || []).forEach(f => {
            showMemoryToast("Saved to memory: " + f.fact);
          });
        } else if (event.type === "memory_deleted") {
          (event.facts || []).forEach(f => {
            showMemoryToast("Removed from memory: " + f.fact);
          });
        } else if (event.type === "done") {
          convId = event.conversation_id || convId;
          activeConvId = convId;
          const stepRows = [steps.container];
          // Use clean answer from server (tags stripped) if available
          const answerText = event.answer || fullAnswer;
          // Compute tokens per second
          const debugWithTps = event.debug || {};
          if (firstTokenTime && tokenCount > 1) {
            const elapsed = (performance.now() - firstTokenTime) / 1000;
            debugWithTps.tok_s = (tokenCount / elapsed).toFixed(1);
          }
          if (streamBubble) {
            streamBubble.finalize(answerText, event.sources || [], event.web_sources || [], event.model_used, debugWithTps, stepRows, event.web_search_query || "");
          } else {
            // Vault miss - no streaming occurred
            stepRows.forEach(r => r.remove());
            appendAIBubble(answerText, event.sources || [], event.web_sources || [], event.model_used, debugWithTps, null, event.web_search_query || "");
          }
          updateActiveSidebar();
          loadConversations();
          updateContextBar(event.conversation_id);
          // Auto-generate smart title for new conversations
          if (convId && !body.conversation_id) {
            (async () => {
              try {
                const titleResp = await apiFetch(`/conversations/${convId}/smart-title`, { method: "POST" });
                if (titleResp.ok) loadConversations();
              } catch (_) {}
            })();
          }
          // Auto-play TTS if enabled
          if (ttsEnabled && answerText) {
            const lastBubble = chatWindow.querySelector(".message-row.ai:last-child .tts-btn");
            speakText(answerText, getVoice(), lastBubble || null);
          }
        } else if (event.type === "error") {
          steps.container.remove();
          showToast(`Error: ${event.text}`);
        }
      }
    }
  } catch (err) {
    steps.container?.remove();
    if (err.name !== "AbortError") showToast(`Error: ${err.message}`);
    // If we have partial text, finalize it as-is
    if (streamBubble && fullAnswer) streamBubble.finalize(fullAnswer, [], [], null, null, null, "");
  } finally {
    chatAbortController = null;
    setLoading(false);
    // Drain queue: if messages are waiting, fire the next one
    if (messageQueue.length > 0) {
      const next = messageQueue.shift();
      renderQueueTray();
      // Inject into input and trigger as if typed
      input.value = next.text;
      pendingImages = next.images || [];
      renderImagePreviews();
      sendMessage();
    } else {
      input.focus();
    }
  }
}


// ── Vision / Image Attachment ──
// pendingImages and currentModelSupportsVision declared earlier

function updateVisionIndicator() {
  if (!visionIndicator) return;
  if (currentModelSupportsVision) {
    visionIndicator.textContent = "Vision";
    visionIndicator.className = "";
    visionIndicator.style.display = "inline-block";
    attachBtn.disabled = false;
    attachBtn.title = "Attach image";
  } else {
    attachBtn.disabled = true;
    attachBtn.title = "Current model does not support vision";
    if (pendingImages.length > 0) {
      visionIndicator.textContent = "No vision";
      visionIndicator.className = "no-vision";
      visionIndicator.style.display = "inline-block";
    } else {
      visionIndicator.style.display = "none";
    }
  }
}

async function checkVisionSupport(modelName) {
  try {
    const res = await apiFetch(`/models/info?model=${encodeURIComponent(modelName)}`);
    if (res.ok) {
      const data = await res.json();
      currentModelSupportsVision = !!data.vision;
    } else {
      currentModelSupportsVision = false;
    }
  } catch { currentModelSupportsVision = false; }
  updateVisionIndicator();
}

function addImageToPreview(dataUrl) {
  pendingImages.push(dataUrl);
  renderImagePreviews();
}

function renderImagePreviews() {
  imagePreviewBar.innerHTML = "";
  if (pendingImages.length === 0) { imagePreviewBar.classList.remove("has-images"); updateVisionIndicator(); return; }
  imagePreviewBar.classList.add("has-images");
  pendingImages.forEach((dataUrl, i) => {
    const thumb = document.createElement("div");
    thumb.className = "image-preview-thumb";
    thumb.innerHTML = `<img src="${dataUrl}" /><button class="remove-img" title="Remove">&times;</button>`;
    thumb.querySelector(".remove-img").addEventListener("click", () => { pendingImages.splice(i, 1); renderImagePreviews(); });
    imagePreviewBar.appendChild(thumb);
  });
  updateVisionIndicator();
}

// Attach button
attachBtn.addEventListener("click", () => { if (!attachBtn.disabled) imageFileInput.click(); });
imageFileInput.addEventListener("change", () => {
  for (const file of imageFileInput.files) {
    const reader = new FileReader();
    reader.onload = (e) => addImageToPreview(e.target.result);
    reader.readAsDataURL(file);
  }
  imageFileInput.value = "";
});

// Paste images directly into chat (only if vision model is loaded)
input.addEventListener("paste", (e) => {
  if (!currentModelSupportsVision) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      const file = item.getAsFile();
      const reader = new FileReader();
      reader.onload = (ev) => addImageToPreview(ev.target.result);
      reader.readAsDataURL(file);
    }
  }
});

// Check vision on model change
modelSelect.addEventListener("change", () => { checkVisionSupport(modelSelect.value); });


// ── Bootstrap ──
initApp();
