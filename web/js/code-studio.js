// ══════════════════════════════════════════════════════════════
// CODE STUDIO
// ══════════════════════════════════════════════════════════════

const CODE_SUGGESTIONS = [
  "Write a Python script that reads a CSV file and generates a summary report",
  "Create a REST API endpoint with input validation and error handling",
  "Build a function that finds duplicate files in a directory by comparing hashes",
  "Write a recursive function to flatten a deeply nested JSON object",
  "Create a CLI tool that converts markdown files to HTML",
  "Build a simple web scraper that extracts article titles and links",
  "Write a function to validate and parse email addresses using regex",
  "Create a rate limiter class with sliding window algorithm",
  "Build a simple key-value store with TTL expiration",
  "Write a function that generates a random password meeting complexity requirements",
  "Create a decorator that caches function results with configurable TTL",
  "Build a simple task queue with priority support",
  "Write a function to diff two JSON objects and return the changes",
  "Create a middleware that logs request/response details with timing",
  "Build a retry wrapper with exponential backoff for API calls",
];

// ── DOM refs ──
const codePrompt = document.getElementById("code-prompt");
const codeGenerateBtn = document.getElementById("code-generate-btn");

// Thread panel refs
const codeThreadScroll = document.getElementById("code-thread-scroll");
const codeThreadEmpty = document.getElementById("code-thread-empty");

// Code panel refs
const codePanelToggle = document.getElementById("code-panel-toggle");
const codePanel = document.getElementById("code-panel");
const codePanelContent = document.getElementById("code-panel-content");
const codeDisplay = document.getElementById("code-display");
const codeEditor = document.getElementById("code-editor");
const codePanelEmpty = document.getElementById("code-panel-empty");
const codePanelLang = document.getElementById("code-panel-lang");
const codeEditToggle = document.getElementById("code-edit-toggle");
const codeCopyBtn = document.getElementById("code-copy-btn");
const codeDownloadBtn = document.getElementById("code-download-btn");
const codeRunBtn = document.getElementById("code-run-btn");
const codePreviewToggle = document.getElementById("code-preview-toggle");
const codePreviewPanel = document.getElementById("code-preview-panel");
const codePreviewFrame = document.getElementById("code-preview-frame");
const codeExecOutput = document.getElementById("code-exec-output");
const codeExecResize = document.getElementById("code-exec-resize");
const codeFindBar = document.getElementById("code-find-bar");
const codeFindInput = document.getElementById("code-find-input");
const codeReplaceInput = document.getElementById("code-replace-input");
const codeFindCount = document.getElementById("code-find-count");
const codeWrapToggle = document.getElementById("code-wrap-toggle");
const codeFindBtn = document.getElementById("code-find-btn");
const codeDiffBtn = document.getElementById("code-diff-btn");

let _codeGenerating = false;
let _codeAbortController = null;
const SVG_CODE_BOLT = `<svg width="16" height="16"><use href="#i-bolt"/></svg>`;
const SVG_CODE_STOP = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none"/></svg>`;
function _setCodeGenerating(v) {
  _codeGenerating = v;
  codeGenerateBtn.innerHTML = v ? SVG_CODE_STOP : SVG_CODE_BOLT;
  codeGenerateBtn.title = v ? "Stop" : "Generate (Enter)";
  codeGenerateBtn.classList.toggle("stopping", v);
}
function stopCodeGenerate() {
  if (_codeAbortController) {
    try { _codeAbortController.abort(); } catch {}
    _codeAbortController = null;
  }
}
let _currentCode = "";
let _currentLanguage = "python";
let _codeEditMode = false;
let _codePreviewOpen = false;
let _codeWrapEnabled = false;
let _codeDiffMode = false;
let _previousCode = "";

// Context usage indicator
const codeCtxBar = document.getElementById("code-ctx-bar");
const codeCtxArc = document.getElementById("code-ctx-arc");
const codeCtxLabel = document.getElementById("code-ctx-label");

// Context settings
const codeCtxSlider = document.getElementById("code-ctx-slider");
const codeCtxVal = document.getElementById("code-ctx-val");
const codeCompactSlider = document.getElementById("code-compact-slider");
const codeCompactVal = document.getElementById("code-compact-val");
let _codeContextWindow = parseInt(localStorage.getItem("wooz_code_ctx_window") || "8192", 10);
let _codeAutoCompactPct = parseInt(localStorage.getItem("wooz_code_auto_compact") || "0", 10);

// Init sliders from saved values
codeCtxSlider.value = _codeContextWindow;
codeCtxVal.textContent = _codeContextWindow >= 1024 ? (_codeContextWindow / 1024) + "k" : _codeContextWindow;
codeCompactSlider.value = _codeAutoCompactPct;
codeCompactVal.textContent = _codeAutoCompactPct ? _codeAutoCompactPct + "%" : "Off";

codeCtxSlider.addEventListener("input", () => {
  _codeContextWindow = parseInt(codeCtxSlider.value, 10);
  codeCtxVal.textContent = _codeContextWindow >= 1024 ? (_codeContextWindow / 1024) + "k" : _codeContextWindow;
  localStorage.setItem("wooz_code_ctx_window", _codeContextWindow);
  scheduleSettingsSync();
  _updateCodeContextBar();
});

codeCompactSlider.addEventListener("input", () => {
  _codeAutoCompactPct = parseInt(codeCompactSlider.value, 10);
  codeCompactVal.textContent = _codeAutoCompactPct ? _codeAutoCompactPct + "%" : "Off";
  localStorage.setItem("wooz_code_auto_compact", _codeAutoCompactPct);
  scheduleSettingsSync();
});

// Plan mode, thinking, permissions state
const codePlanToggle = document.getElementById("code-plan-toggle");
const codeThinkToggle = document.getElementById("code-think-toggle");
const codePermissionsRow = document.getElementById("code-permissions-row");
let _codePlanMode = localStorage.getItem("wooz_code_plan_mode") === "1";
let _codeThinking = localStorage.getItem("wooz_code_thinking") === "1";
let _codePermissions = localStorage.getItem("wooz_code_permissions") || "normal";
let _codeModelSupportsThinking = false;

codePlanToggle.checked = _codePlanMode;
codeThinkToggle.checked = _codeThinking;
// Set active permission button from saved value
codePermissionsRow.querySelectorAll(".studio-preset-btn").forEach(btn => {
  btn.classList.toggle("active", btn.dataset.perm === _codePermissions);
});

codePlanToggle.addEventListener("change", () => {
  _codePlanMode = codePlanToggle.checked;
  localStorage.setItem("wooz_code_plan_mode", _codePlanMode ? "1" : "0");
  scheduleSettingsSync();
  updateCodeSettingsSummary();
});

codeThinkToggle.addEventListener("change", () => {
  _codeThinking = codeThinkToggle.checked;
  localStorage.setItem("wooz_code_thinking", _codeThinking ? "1" : "0");
  scheduleSettingsSync();
  updateCodeSettingsSummary();
});

codePermissionsRow.addEventListener("click", (e) => {
  const btn = e.target.closest(".studio-preset-btn");
  if (!btn) return;
  codePermissionsRow.querySelectorAll(".studio-preset-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  _codePermissions = btn.dataset.perm;
  localStorage.setItem("wooz_code_permissions", _codePermissions);
  scheduleSettingsSync();
  updateCodeSettingsSummary();
});

// ── Code Studio attachment state ──
const codeAttachBtn = document.getElementById("code-attach-btn");
const codeFileInput = document.getElementById("code-file-input");
const codeImagePreviewBar = document.getElementById("code-image-preview-bar");
const codeFilePreviewBar = document.getElementById("code-file-preview-bar");
let codePendingImages = [];
let codePendingFiles = [];
let _codeModelSupportsVision = false;
const CODE_PASTE_THRESHOLD = 500;

// Extract creation timestamp from snippet id (format: code_<timestamp>_<rand>)
function _createdAt(s) { return parseInt((s.id || "").split("_")[1], 10) || s.timestamp || 0; }

// ── Code server-side persistence (via studio API) ──
const _codeAPI = createStudioAPI("code");
async function saveCodeSnippet(record)  { return _codeAPI.save("snippets", record); }
async function loadAllCodeSnippets()    { return _codeAPI.loadAll("snippets"); }
async function deleteCodeSnippet(id)    { return _codeAPI.remove("snippets", id); }
async function saveCodeToTrash(record)  { return _codeAPI.save("trash", { ...record, deletedAt: Date.now() }); }
async function loadAllCodeTrash()       { return _codeAPI.loadAll("trash"); }
async function deleteFromCodeTrash(id)  { return _codeAPI.remove("trash", id); }
async function emptyCodeTrash()         { return _codeAPI.clear("trash"); }
async function saveCodeFolder(col)      { return _codeAPI.save("folders", col); }
async function deleteCodeFolder(id)     { return _codeAPI.remove("folders", id); }
async function loadAllCodeFolders()     { return _codeAPI.loadAll("folders"); }

async function saveCodeSessionState(sessionId, state) {
  return _codeAPI.save("session_state", { id: sessionId, ...state });
}
async function loadCodeSessionState(sessionId) {
  const all = await _codeAPI.loadAll("session_state");
  return all.find(s => s.id === sessionId) || null;
}

async function compactCodeSession() {
  if (!activeCodeSessionId) { showToast("No active session to compact"); return; }
  const snippets = await loadAllCodeSnippets();
  const sessionSnips = snippets
    .filter(s => s.session_id === activeCodeSessionId && s.rawPrompt !== "(manual edit)")
    .sort((a, b) => _createdAt(a) - _createdAt(b));
  if (sessionSnips.length < 3) { showToast("Session too short to compact"); return; }

  // Build history from all but the last 2 snippets (keep recent context intact)
  const toCompact = sessionSnips.slice(0, -2);
  const history = [];
  for (const s of toCompact) {
    history.push({ role: "user", content: s.rawPrompt });
    history.push({ role: "assistant", content: s.editComment || "Code generated." });
  }

  showToast("Compacting session...");
  try {
    const res = await mediaFetch("/code/compact", {
      method: "POST",
      body: JSON.stringify({ history }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();

    // Delete old snippets and replace with a single summary snippet
    for (const s of toCompact) {
      await deleteCodeSnippet(s.id);
    }
    const summaryRecord = {
      id: "code_" + Date.now() + "_cmpct",
      session_id: activeCodeSessionId,
      folder_id: activeCodeFolderId || null,
      rawPrompt: "(session context)",
      title: null,
      code: "",
      language: _currentLanguage,
      model: null,
      timestamp: toCompact[0].timestamp,
      conversational: true,
      editComment: data.summary,
    };
    await saveCodeSnippet(summaryRecord);

    await restoreCodeThread();
    showToast("Session compacted");
  } catch (e) {
    showToast("Compact failed: " + e.message);
  }
}

// ── Sessions & folders ──
let codeFolders = [];
let activeCodeFolderId = localStorage.getItem("wooz_code_folder") || null;
let activeCodeSessionId = localStorage.getItem("wooz_code_session") || null;

function _newCodeSessionId() {
  const arr = new Uint8Array(12);
  crypto.getRandomValues(arr);
  return "csess_" + Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
}

function _ensureCodeSession() {
  if (!activeCodeSessionId) {
    activeCodeSessionId = _newCodeSessionId();
    localStorage.setItem("wooz_code_session", activeCodeSessionId);
  }
}

async function _getCodeSessions() {
  const snippets = await loadAllCodeSnippets();
  const map = {};
  for (const s of snippets) {
    const sf = s.folder_id || (codeFolders.length ? codeFolders[0].id : null);
    if (activeCodeFolderId && sf !== activeCodeFolderId) continue;
    const sid = s.session_id || "default";
    if (!map[sid]) map[sid] = { id: sid, snippets: [], title: null, ts: 0 };
    map[sid].snippets.push(s);
    if (s.timestamp > map[sid].ts) map[sid].ts = s.timestamp;
    if (s.title) map[sid].title = s.title;
  }
  return Object.values(map).sort((a, b) => b.ts - a.ts);
}

async function renderCodeSessionsList() {
  const list = document.getElementById("code-sessions-list");
  if (!list) return;
  const sessions = await _getCodeSessions();
  list.innerHTML = "";
  const now = Date.now();
  const DAY = 86400000;
  let lastGroup = "";
  for (const s of sessions) {
    const age = now - s.ts;
    const group = age < DAY ? "Today" : age < 2 * DAY ? "Yesterday" : age < 7 * DAY ? "This Week" : "Older";
    if (group !== lastGroup) {
      const h = document.createElement("div");
      h.className = "conv-group-label";
      h.textContent = group;
      list.appendChild(h);
      lastGroup = group;
    }
    const row = document.createElement("div");
    row.className = "sb-item code-session-item" + (s.id === activeCodeSessionId ? " active" : "");
    row.dataset.sessionId = s.id;
    const label = s.title || s.snippets[0]?.rawPrompt?.slice(0, 40) || "Untitled";
    row.innerHTML = `<span class="sb-item-title">${esc(label)}</span><button class="sb-item-menu code-session-menu" title="Options">&#x22EF;</button>`;
    row.draggable = true;
    row.addEventListener("dragstart", e => {
      e.dataTransfer.setData("text/code-session", s.id);
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("click", e => {
      if (e.target.closest(".code-session-menu")) return;
      activeCodeSessionId = s.id;
      localStorage.setItem("wooz_code_session", s.id);
      restoreCodeThread();
      renderCodeSessionsList();
    });
    row.querySelector(".code-session-menu").addEventListener("click", e => {
      e.stopPropagation();
      _showCodeSessionMenu(s, row, e);
    });
    list.appendChild(row);
  }
}

function _showCodeSessionMenu(sess, itemEl, e) {
  document.querySelectorAll(".code-session-ctx-menu, .code-folder-sub-menu").forEach(m => m.remove());
  const menu = document.createElement("div");
  menu.className = "code-session-ctx-menu";
  menu.style.cssText = `position:fixed;z-index:9999;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:4px;min-width:160px;box-shadow:0 8px 24px rgba(0,0,0,0.3);`;

  // Rename
  const renameItem = document.createElement("div");
  renameItem.style.cssText = "padding:6px 12px;cursor:pointer;font-size:0.8rem;border-radius:6px;color:var(--text-dim);";
  renameItem.textContent = "Rename";
  renameItem.addEventListener("mouseenter", () => renameItem.style.background = "var(--surface2)");
  renameItem.addEventListener("mouseleave", () => renameItem.style.background = "");
  renameItem.addEventListener("click", async () => {
    menu.remove();
    const name = await showPromptModal({ title: "Rename Session", label: "Session name:", value: sess.title || sess.snippets[0]?.rawPrompt?.slice(0, 40) || "Untitled" });
    if (!name) return;
    try {
      const firstSnippet = sess.snippets[sess.snippets.length - 1];
      if (firstSnippet) {
        await apiFetch(`/studio/code/items/${firstSnippet.id}`, {
          method: "PATCH",
          body: JSON.stringify({ title: name.trim() }),
        });
      }
    } catch {}
    renderCodeSessionsList();
  });
  menu.appendChild(renameItem);

  // Move to Folder
  if (codeFolders.length > 1) {
    const moveWrap = document.createElement("div");
    moveWrap.style.position = "relative";
    const moveBtn = document.createElement("div");
    moveBtn.style.cssText = "padding:6px 12px;cursor:pointer;font-size:0.8rem;border-radius:6px;color:var(--text-dim);display:flex;align-items:center;justify-content:space-between;";
    moveBtn.innerHTML = `Move to Folder <span>&#x25B8;</span>`;
    moveBtn.addEventListener("mouseenter", () => {
      moveBtn.style.background = "var(--surface2)";
      document.querySelectorAll(".code-folder-sub-menu").forEach(m => m.remove());
      const sub = document.createElement("div");
      sub.className = "code-folder-sub-menu";
      sub.style.cssText = `position:fixed;z-index:10000;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,0.4);min-width:140px;`;
      const menuRect = menu.getBoundingClientRect();
      sub.style.left = (menuRect.right + 2) + "px";
      sub.style.top = moveBtn.getBoundingClientRect().top + "px";
      codeFolders.filter(f => f.id !== activeCodeFolderId).forEach(folder => {
        const item = document.createElement("div");
        item.style.cssText = "padding:6px 12px;cursor:pointer;font-size:0.78rem;border-radius:6px;color:var(--text-dim);";
        item.textContent = folder.name;
        item.addEventListener("mouseenter", () => item.style.background = "var(--surface2)");
        item.addEventListener("mouseleave", () => item.style.background = "");
        item.addEventListener("click", async () => {
          menu.remove(); sub.remove();
          try {
            for (const s of sess.snippets) {
              await apiFetch(`/studio/code/items/${s.id}`, {
                method: "PATCH",
                body: JSON.stringify({ folder_id: folder.id }),
              });
            }
            renderCodeSessionsList();
          } catch (err) { console.warn("Failed to move session:", err); }
        });
        sub.appendChild(item);
      });
      document.body.appendChild(sub);
    });
    moveBtn.addEventListener("mouseleave", () => moveBtn.style.background = "");
    moveWrap.appendChild(moveBtn);
    menu.appendChild(moveWrap);
  }

  // Delete
  const deleteItem = document.createElement("div");
  deleteItem.style.cssText = "padding:6px 12px;cursor:pointer;font-size:0.8rem;border-radius:6px;color:var(--danger);";
  deleteItem.textContent = "Delete session";
  deleteItem.addEventListener("mouseenter", () => deleteItem.style.background = "var(--surface2)");
  deleteItem.addEventListener("mouseleave", () => deleteItem.style.background = "");
  deleteItem.addEventListener("click", async () => {
    menu.remove();
    for (const s of sess.snippets) {
      await apiFetch(`/studio/code/items/${s.id}/trash`, { method: "POST" });
    }
    _refreshCodeTrashBadge();
    if (activeCodeSessionId === sess.id) {
      activeCodeSessionId = _newCodeSessionId();
      localStorage.setItem("wooz_code_session", activeCodeSessionId);
    }
    renderCodeSessionsList();
    restoreCodeThread();
  });
  menu.appendChild(deleteItem);

  const rect = itemEl.getBoundingClientRect();
  menu.style.top = rect.bottom + 4 + "px";
  menu.style.left = rect.left + "px";
  document.body.appendChild(menu);
  const _closeMenu = (ev) => {
    if (!menu.contains(ev.target) && !document.querySelector(".code-folder-sub-menu")?.contains(ev.target)) {
      menu.remove(); document.querySelectorAll(".code-folder-sub-menu").forEach(m => m.remove());
      document.removeEventListener("click", _closeMenu);
    }
  };
  setTimeout(() => document.addEventListener("click", _closeMenu), 10);
}

// ── Folders ──

async function loadCodeFolders() {
  codeFolders = await loadAllCodeFolders();
  if (codeFolders.length === 0) {
    const def = { id: "cfolder_" + Date.now(), name: "My Code", description: "Default folder", timestamp: Date.now() };
    await saveCodeFolder(def);
    codeFolders = [def];
  }
  if (!activeCodeFolderId || !codeFolders.find(c => c.id === activeCodeFolderId)) {
    activeCodeFolderId = codeFolders[0].id;
    localStorage.setItem("wooz_code_folder", activeCodeFolderId);
  }
  _renderCodeFoldersSidebar();
}

function _renderCodeFoldersSidebar() {
  const container = document.getElementById("code-folders-list");
  if (!container) return;
  container.innerHTML = "";
  const iconSvg = `<svg class="sb-folder-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 3.5C1.5 2.948 1.948 2.5 2.5 2.5H6.086a1 1 0 0 1 .707.293L7.914 3.914A1 1 0 0 0 8.621 4.2H13.5c.552 0 1 .448 1 1v7.3c0 .552-.448 1-1 1h-11c-.552 0-1-.448-1-1V3.5z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>`;
  for (const f of codeFolders) {
    const row = document.createElement("div");
    row.className = "sb-folder-row" + (f.id === activeCodeFolderId ? " active" : "");
    row.dataset.id = f.id;
    row.innerHTML = `${iconSvg}<div class="sb-folder-info"><div class="sb-folder-name">${esc(f.name)}</div>${f.description ? `<div class="sb-folder-desc">${esc(f.description)}</div>` : ""}</div><button class="sb-folder-menu" title="Options">&#x22EF;</button>`;
    row.addEventListener("click", e => {
      if (e.target.classList.contains("sb-folder-menu")) return;
      if (f.id === activeCodeFolderId) return;
      activeCodeFolderId = f.id;
      localStorage.setItem("wooz_code_folder", f.id);
      _renderCodeFoldersSidebar();
      renderCodeSessionsList();
      restoreCodeThread();
    });
    row.querySelector(".sb-folder-menu").addEventListener("click", e => {
      e.stopPropagation();
      _showCodeFolderCtxMenu(f, e);
    });
    // Drag-drop target for code sessions
    row.addEventListener("dragover", e => {
      if (!e.dataTransfer.types.includes("text/code-session")) return;
      e.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", async e => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const sessionId = e.dataTransfer.getData("text/code-session");
      if (!sessionId) return;
      try {
        const all = await loadAllCodeSnippets();
        const matching = all.filter(s => s.session_id === sessionId);
        for (const s of matching) {
          await apiFetch(`/studio/code/items/${s.id}`, {
            method: "PATCH",
            body: JSON.stringify({ folder_id: f.id }),
          });
        }
        renderCodeSessionsList();
      } catch (err) { console.warn("Failed to move session:", err); }
    });
    container.appendChild(row);
  }
}

function _showCodeFolderCtxMenu(f, e) {
  document.querySelectorAll(".code-folder-ctx-menu").forEach(el => el.remove());
  const menu = document.createElement("div");
  menu.className = "code-folder-ctx-menu";
  menu.style.cssText = `position:fixed;z-index:999;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,0.4);min-width:120px;`;
  menu.innerHTML = `
    <div class="code-folder-ctx-item" data-action="rename" style="padding:6px 12px;cursor:pointer;font-size:0.8rem;border-radius:6px;color:var(--text-dim);">Edit</div>
    <div class="code-folder-ctx-item" data-action="delete" style="padding:6px 12px;cursor:pointer;font-size:0.8rem;border-radius:6px;color:var(--danger);">Delete</div>
  `;
  menu.style.left = e.clientX + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - 80) + "px";
  document.body.appendChild(menu);
  menu.querySelector('[data-action="rename"]').addEventListener("click", () => {
    menu.remove();
    openCodeFolderModal(f);
  });
  menu.querySelector('[data-action="delete"]').addEventListener("click", async () => {
    menu.remove();
    if (codeFolders.length <= 1) { showToast("At least one folder must exist."); return; }
    const confirmed = await showConfirm({ title: "Delete Folder", message: `Delete "${f.name}"? All code snippets will be moved to trash.` });
    if (!confirmed) return;
    const allSnippets = await loadAllCodeSnippets();
    const toDelete = allSnippets.filter(r => r.folder_id === f.id);
    for (const s of toDelete) {
      await apiFetch(`/studio/code/items/${s.id}/trash`, { method: "POST" });
    }
    _refreshCodeTrashBadge();
    await deleteCodeFolder(f.id);
    codeFolders = codeFolders.filter(c => c.id !== f.id);
    if (activeCodeFolderId === f.id) {
      activeCodeFolderId = codeFolders[0].id;
      localStorage.setItem("wooz_code_folder", activeCodeFolderId);
    }
    _renderCodeFoldersSidebar();
    activeCodeSessionId = null;
    localStorage.removeItem("wooz_code_session");
    restoreCodeThread();
    renderCodeSessionsList();
  });
  menu.querySelectorAll(".code-folder-ctx-item").forEach(item => {
    item.addEventListener("mouseenter", () => item.style.background = "var(--surface2)");
    item.addEventListener("mouseleave", () => item.style.background = "");
  });
  setTimeout(() => {
    const handler = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("click", handler); } };
    document.addEventListener("click", handler);
  });
}

// Code Studio Folder modal
let _editingCodeFolderId = null;
function openCodeFolderModal(f) {
  _editingCodeFolderId = f ? f.id : null;
  document.getElementById("shared-folder-title").textContent = f ? "Edit Folder" : "New Folder";
  document.getElementById("shared-folder-hint").textContent = "Folders organize your code snippets into separate groups.";
  document.getElementById("shared-folder-name").value = f?.name || "";
  document.getElementById("shared-folder-name").placeholder = "e.g. Python Scripts, Web Projects, Algorithms";
  document.getElementById("shared-folder-desc").value = f?.description || "";
  document.getElementById("shared-folder-prompt-wrap").style.display = "none";
  document.getElementById("shared-folder-save").textContent = f ? "Save" : "Create Folder";
  document.getElementById("shared-folder-save").onclick = async () => {
    const name = document.getElementById("shared-folder-name").value.trim();
    const description = document.getElementById("shared-folder-desc").value.trim() || "";
    if (!name) { document.getElementById("shared-folder-name").focus(); return; }
    if (_editingCodeFolderId) {
      const existing = codeFolders.find(c => c.id === _editingCodeFolderId);
      if (existing) { existing.name = name; existing.description = description; await saveCodeFolder(existing); }
    } else {
      const folder = { id: "cfolder_" + Date.now(), name, description, timestamp: Date.now() };
      await saveCodeFolder(folder);
      codeFolders.push(folder);
      activeCodeFolderId = folder.id;
      localStorage.setItem("wooz_code_folder", folder.id);
      activeCodeSessionId = null;
      localStorage.removeItem("wooz_code_session");
      restoreCodeThread();
      renderCodeSessionsList();
    }
    closeCodeFolderModal();
    _renderCodeFoldersSidebar();
  };
  document.getElementById("shared-folder-modal").classList.add("open");
  setTimeout(() => document.getElementById("shared-folder-name").focus(), 50);
}
function closeCodeFolderModal() {
  document.getElementById("shared-folder-modal").classList.remove("open");
  _editingCodeFolderId = null;
}
document.getElementById("code-folder-new-btn").addEventListener("click", () => openCodeFolderModal(null));

// ── Settings toggle ──
wireSettingsToggle("code-settings-trigger", "code-settings-crumb", "code-settings-panel");

// Advanced toggle
document.getElementById("code-advanced-toggle").addEventListener("click", function() {
  this.classList.toggle("open");
  document.getElementById("code-advanced-body").classList.toggle("open");
});

function updateCodeSettingsSummary() {
  const summary = document.getElementById("code-settings-summary");
  if (!summary) return;
  const modelSel = document.getElementById("code-model-select");
  const model = modelSel?.options[modelSel.selectedIndex]?.textContent || "Model";
  const parts = [model];
  if (_codePlanMode || _codeThinking || _codePermissions !== "normal") {
    const flags = [];
    if (_codePlanMode) flags.push("Plan");
    if (_codeThinking) flags.push("Think");
    if (_codePermissions === "restrictive") flags.push("Strict");
    if (_codePermissions === "permissive") flags.push("Auto");
    if (flags.length) parts.push(flags.join("+"));
  }
  summary.textContent = parts.join(" \u00b7 ");
}

// ── Language extension map ──
const CODE_EXT_MAP = {
  python: ".py", javascript: ".js", typescript: ".ts", bash: ".sh",
  html: ".html", css: ".css", sql: ".sql", go: ".go", rust: ".rs",
  json: ".json", yaml: ".yml", auto: ".txt",
};

// ── Highlight.js language class map ──
const CODE_HLJS_MAP = {
  python: "python", javascript: "javascript", typescript: "typescript",
  bash: "bash", html: "xml", css: "css", sql: "sql", go: "go", rust: "rust",
  json: "json", yaml: "yaml", auto: "", text: "",
};

// ══════════════════════════════════════════════════════════════
// THREAD + CODE PANEL CORE FUNCTIONS
// ══════════════════════════════════════════════════════════════

// Heuristic: does the first non-blank line of `text` look like a line of code?
// Used as a fallback when the model skips the markdown fence and emits raw code.
function _looksLikeBareCode(text) {
  if (!text) return false;
  const lines = text.split("\n");
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    return /^(import |from |def |class |function\b|const |let |var |public |private |protected |package |#include|#!|using |fn |impl |pub |async |struct |interface |enum |namespace |module |export |require\(|console\.|print\(|return |if __name__|@\w)/.test(t)
        || /^(<\?xml|<!doctype|<!DOCTYPE|<html|<\?php|<\w+[\s>]|\/\/|\/\*)/i.test(t);
  }
  return false;
}

// Extract code from LLM output - strips markdown fences and commentary
function _extractCode(raw) {
  if (!raw) return { code: "", comment: "", fenceLang: "" };
  // Look for code inside markdown fences, capturing optional language hint
  const fenceMatch = raw.match(/```(\w*)\n([\s\S]*?)```/);
  if (fenceMatch) {
    const before = raw.slice(0, raw.indexOf("```")).trim();
    return { code: fenceMatch[2].replace(/\n$/, ""), comment: before, fenceLang: fenceMatch[1] || "" };
  }
  // No fences - return as-is
  return { code: raw, comment: "", fenceLang: "" };
}

// Parse SEARCH/REPLACE blocks from model output and apply to existing code
// Handles format variations: <<<<<<< SEARCH, <<<< SEARCH, <<<<search, etc.
function _parseSearchReplaceBlocks(raw) {
  const blocks = [];
  const regex = /<{3,7}\s*search\s*\n([\s\S]*?)\n={3,7}\n([\s\S]*?)\n>{3,7}\s*replace/gi;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    blocks.push({ search: match[1], replace: match[2] });
  }
  return blocks;
}

function _applySearchReplace(existingCode, modelOutput) {
  const blocks = _parseSearchReplaceBlocks(modelOutput);
  if (blocks.length === 0) return null; // no blocks found - caller should fall back

  let result = existingCode;
  let allApplied = true;
  for (const block of blocks) {
    const idx = result.indexOf(block.search);
    if (idx === -1) {
      // Try trimmed match as fallback (model sometimes gets trailing whitespace wrong)
      const lines = result.split("\n");
      const searchLines = block.search.split("\n");
      let found = false;
      for (let i = 0; i <= lines.length - searchLines.length; i++) {
        const slice = lines.slice(i, i + searchLines.length);
        if (slice.every((l, j) => l.trimEnd() === searchLines[j].trimEnd())) {
          const before = lines.slice(0, i);
          const after = lines.slice(i + searchLines.length);
          const replaceLines = block.replace ? block.replace.split("\n") : [];
          result = [...before, ...replaceLines, ...after].join("\n");
          found = true;
          break;
        }
      }
      if (!found) allApplied = false;
    } else {
      result = result.slice(0, idx) + block.replace + result.slice(idx + block.search.length);
    }
  }
  // Extract preamble (before first block) and summary (after last block)
  const firstIdx = modelOutput.search(/<{3,7}\s*search/i);
  const preamble = firstIdx > 0 ? modelOutput.slice(0, firstIdx).trim() : "";
  const lastEnd = modelOutput.search(/>{3,7}\s*replace\s*$/im);
  let summary = "";
  if (lastEnd > -1) {
    const afterLast = modelOutput.slice(lastEnd).replace(/>{3,7}\s*replace\s*/i, "").trim();
    if (afterLast && !afterLast.match(/<{3,7}\s*search/i)) summary = afterLast;
  }
  return { code: result, preamble, summary, blocksApplied: blocks.length, allApplied };
}

// Detect language from code content + fence hint
const _FENCE_LANG_MAP = {
  html: "html", css: "css", js: "javascript", javascript: "javascript",
  ts: "typescript", typescript: "typescript", python: "python", py: "python",
  bash: "bash", sh: "bash", shell: "bash", sql: "sql", go: "go",
  rust: "rust", rs: "rust", json: "json", xml: "html",
};

function _detectLanguage(code, fenceLang) {
  // 1. Fence language hint (most reliable)
  if (fenceLang) {
    const mapped = _FENCE_LANG_MAP[fenceLang.toLowerCase()];
    if (mapped) return mapped;
  }
  // 2. Heuristic detection from content
  const trimmed = code.trim();
  if (!trimmed) return "text";

  // HTML - DOCTYPE, root tag, or any tag start with a matching close somewhere
  if (/^<!DOCTYPE\b|^<html[\s>]|^<\?xml\b/i.test(trimmed)) return "html";
  if (/^<\w+(\s|>)/.test(trimmed) && /<\/\w+>/.test(trimmed)) return "html";

  // CSS - @-rules or selector { property: value; } blocks
  if (/(?:^|\n)\s*@(?:media|import|keyframes|font-face|charset|supports|page|namespace)\b/i.test(trimmed)
      || /[#.\w-]+\s*(?:,\s*[#.\w-]+)*\s*\{\s*[\w-]+\s*:\s*[^;{}]+;/.test(trimmed)) return "css";

  // Python - shebang, imports, defs, decorators
  if (/^#!.*python/.test(trimmed)
      || /^(import\s|from\s+\S+\s+import\s|def\s|class\s+\S+.*:|if\s+__name__\b|@\w[\w.]*(?:\s|\(|\n))/.test(trimmed)) return "python";

  // Bash - shebang or common shell commands
  if (/^#!\s*\/(?:usr\/)?bin\/(?:ba|z|k)?sh\b/.test(trimmed)
      || /^\s*(?:echo |apt(?:-get)? |sudo |cd |ls\b|grep |mkdir |rm\b|cp\b|mv\b|chmod |chown |export\s+\w+=)/.test(trimmed)) return "bash";

  // JavaScript / TypeScript - allow leading line/block comments
  const noComments = trimmed.replace(/^(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)+/, "").trimStart();
  if (/^(?:const\s|let\s|var\s|import\s|export\s|function\b|async\s+function\b|class\s+\w+|require\s*\(|module\.exports|window\.|document\.|\w+\s*=\s*function\b|\w+\s*=\s*\([^)]*\)\s*=>)/.test(noComments)) {
    if (/(?:^|\W)(?:interface\s+\w+|type\s+\w+\s*=|:\s*(?:string|number|boolean|any|unknown|void|never)\b)/.test(trimmed)) return "typescript";
    return "javascript";
  }
  if (/^(?:interface\s+\w+|type\s+\w+\s*=|enum\s+\w+)/.test(noComments)) return "typescript";

  // SQL
  if (/^\s*(?:SELECT\s|INSERT\s|CREATE\s+TABLE\b|ALTER\s+TABLE\b|DROP\s+TABLE\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b|WITH\s)/i.test(trimmed)) return "sql";

  // Go
  if (/^package\s+\w+/.test(trimmed) && /\bfunc\s+/.test(trimmed)) return "go";

  // Rust
  if (/^(?:use\s+\w+|fn\s+\w+|pub\s+(?:fn|struct|enum|mod|trait)\s)/.test(trimmed)) return "rust";

  // JSON
  if (/^\s*[\{\[][\s\S]*[\}\]]\s*$/.test(trimmed)) {
    try { JSON.parse(trimmed); return "json"; } catch {}
  }

  // Unknown - return "text" so callers can hide Run/Preview rather than guessing.
  return "text";
}

function _renderCodeWithLineNumbers(code, language) {
  const codeEl = codeDisplay.querySelector("code");
  codeEl.className = "";
  delete codeEl.dataset.highlighted;
  const hljsClass = CODE_HLJS_MAP[language] || "";
  if (hljsClass) codeEl.className = "language-" + hljsClass;
  codeEl.textContent = code;
  if (typeof hljs !== "undefined") {
    try { hljs.highlightElement(codeEl); } catch {}
  }
  // Wrap each line with line numbers
  const highlighted = codeEl.innerHTML;
  const lines = highlighted.split("\n");
  // Remove trailing empty line that split often creates
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  codeEl.innerHTML = lines.map((line, i) =>
    `<div class="code-line"><span class="line-num">${i + 1}</span><span class="line-content">${line || " "}</span></div>`
  ).join("");
}

async function _updateCodeContextBar() {
  try {
    const snippets = await loadAllCodeSnippets();
    const sessionSnips = snippets
      .filter(s => s.session_id === activeCodeSessionId && s.rawPrompt !== "(manual edit)")
      .sort((a, b) => _createdAt(a) - _createdAt(b));
    if (!sessionSnips.length) { codeCtxBar.style.display = "none"; return; }

    // Estimate total chars in context (prompts + responses + current code)
    let totalChars = 0;
    for (const s of sessionSnips) {
      totalChars += (s.rawPrompt || "").length;
      totalChars += (s.editComment || "").length;
    }
    totalChars += (_currentCode || "").length;

    // Rough token estimate (~4 chars per token), against model context window
    const estimatedTokens = Math.ceil(totalChars / 4);
    const pct = Math.min(Math.round((estimatedTokens / _codeContextWindow) * 100), 100);

    const circumference = 2 * Math.PI * 6;
    const filled = (pct / 100) * circumference;
    const color = pct > 80 ? "var(--danger)" : pct > 60 ? "#f59e0b" : "var(--accent)";

    codeCtxBar.style.display = "flex";
    codeCtxArc.setAttribute("stroke-dasharray", `${filled.toFixed(1)} ${circumference.toFixed(1)}`);
    codeCtxArc.setAttribute("stroke", color);
    codeCtxLabel.textContent = `${pct}% context`;
    codeCtxLabel.style.color = pct > 80 ? "var(--danger)" : pct > 60 ? "#f59e0b" : "var(--text-faint)";

    // Auto-compact if threshold is set and exceeded
    if (_codeAutoCompactPct > 0 && pct >= _codeAutoCompactPct && sessionSnips.length >= 4) {
      compactCodeSession();
    }
  } catch { codeCtxBar.style.display = "none"; }
}

function _highlightChangedLines(lineNums) {
  const lineEls = codeDisplay.querySelectorAll(".code-line");
  const changedSet = new Set(lineNums);
  lineEls.forEach((el, i) => {
    if (changedSet.has(i + 1)) el.classList.add("code-line-changed");
  });
}

// ── Diff view ──
function _computeDiff(oldText, newText) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  // Simple LCS-based diff
  const m = oldLines.length, n = newLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  // Backtrack to build diff
  const result = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: "same", line: oldLines[i - 1], oldNum: i, newNum: j });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: "add", line: newLines[j - 1], newNum: j });
      j--;
    } else {
      result.unshift({ type: "del", line: oldLines[i - 1], oldNum: i });
      i--;
    }
  }
  return result;
}

function _renderDiffView(oldCode, newCode, language) {
  const diff = _computeDiff(oldCode, newCode);
  const codeEl = codeDisplay.querySelector("code");
  const hljsClass = CODE_HLJS_MAP[language] || "";
  codeEl.className = hljsClass ? "language-" + hljsClass : "";

  codeEl.innerHTML = diff.map(d => {
    const lineContent = esc(d.line) || " ";
    if (d.type === "same") {
      return `<div class="code-line code-diff-same"><span class="line-num">${d.oldNum}</span><span class="line-num diff-new-num">${d.newNum}</span><span class="line-content">${lineContent}</span></div>`;
    } else if (d.type === "add") {
      return `<div class="code-line code-diff-add"><span class="line-num"></span><span class="line-num diff-new-num">${d.newNum}</span><span class="line-content">${lineContent}</span></div>`;
    } else {
      return `<div class="code-line code-diff-del"><span class="line-num">${d.oldNum}</span><span class="line-num diff-new-num"></span><span class="line-content">${lineContent}</span></div>`;
    }
  }).join("");
}

function _toggleDiffView() {
  if (!_previousCode && !_currentCode) { showToast("No code to diff"); return; }
  _codeDiffMode = !_codeDiffMode;
  codeDiffBtn.classList.toggle("active", _codeDiffMode);

  if (_codeDiffMode) {
    if (!_previousCode) { showToast("No previous version to compare"); _codeDiffMode = false; codeDiffBtn.classList.remove("active"); return; }
    _exitEditMode();
    _renderDiffView(_previousCode, _currentCode, _currentLanguage);
    codeDisplay.classList.add("diff-mode");
  } else {
    codeDisplay.classList.remove("diff-mode");
    _renderCodeWithLineNumbers(_currentCode, _currentLanguage);
  }
}

// Version pill system - shows which code version is active in the thread
function _setActiveVersionPill(activeIdx, skipPersist) {
  const pills = codeThreadScroll.querySelectorAll(".code-version-pill");
  if (!skipPersist && activeCodeSessionId) {
    saveCodeSessionState(activeCodeSessionId, { activeVersionIdx: activeIdx });
  }
  pills.forEach((pill, i) => {
    const isCurrent = i === activeIdx;
    const isManual = pill.classList.contains("manual");
    const label = isCurrent ? "Current" : "Restore";
    pill.textContent = label;
    pill.className = "code-version-pill" + (isCurrent ? " current" : "") + (isManual ? " manual" : "");
    pill.onclick = isCurrent ? null : (e) => {
      e.stopPropagation();
      const code = pill.dataset.snippetCode;
      const lang = pill.dataset.snippetLang;
      _previousCode = _currentCode;
      _currentCode = code;
      _currentLanguage = lang;
      // Exit diff mode if active
      if (_codeDiffMode) { _codeDiffMode = false; codeDiffBtn.classList.remove("active"); codeDisplay.classList.remove("diff-mode"); }
      _renderCodeWithLineNumbers(code, lang);
      codePanelLang.textContent = lang.toUpperCase();
      codeDiffBtn.style.display = _previousCode ? "" : "none";
      _refreshPreview(code);
      _setActiveVersionPill(i);
    };
  });
}

function _userAvatarHtml() {
  let initials = "?";
  const avatarDataUrl = localStorage.getItem(AVATAR_KEY) || "";
  try {
    const p = JSON.parse(localStorage.getItem("wooz_profile") || "{}");
    const name = p.name || currentUser?.username || "";
    initials = name.trim().split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 2) || "?";
  } catch {}
  return avatarDataUrl
    ? `<img src="${avatarDataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`
    : initials;
}

function _aiAvatarHtml() {
  const url = localStorage.getItem(AI_AVATAR_KEY) || "";
  const letter = (JSON.parse(localStorage.getItem(BRAND_KEY) || "{}").name || "D").trim().charAt(0).toUpperCase();
  return url
    ? `<img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`
    : letter;
}

// Build interactive plan question form from markdown comment and append to bubble
function _buildPlanForm(comment, bubble) {
  const questions = [];
  const lines = comment.split("\n");
  let current = null;
  let inQuestionsSection = false;
  for (const line of lines) {
    // Only parse questions after a "## Questions" heading
    if (/^#{1,3}\s+questions/i.test(line.trim())) {
      inQuestionsSection = true;
      continue;
    }
    // Stop if we hit another heading after Questions
    if (inQuestionsSection && /^#{1,3}\s+/.test(line.trim()) && !/questions/i.test(line)) {
      if (current) questions.push(current);
      current = null;
      break;
    }
    if (!inQuestionsSection) continue;
    const qMatch = line.match(/^\d+\.\s+\*\*(.+?)\*\*:?\s*(.*)/);
    if (qMatch) {
      if (current) questions.push(current);
      const qText = qMatch[2].replace(/\*\*/g, "").trim();
      const qFull = qMatch[1] + " " + qText;
      const multi = /select all|choose multiple|pick any|multiple/i.test(qFull);
      current = { label: qMatch[1], question: qText, options: [], multi };
      continue;
    }
    if (current) {
      const optMatch = line.match(/^\s+[-*]\s+(.+)/);
      if (optMatch) current.options.push(optMatch[1].trim());
    }
  }
  if (current) questions.push(current);
  const withOpts = questions.filter(q => q.options.length >= 2);
  if (!withOpts.length) return;

  const formWrap = document.createElement("div");
  formWrap.className = "code-plan-form";
  let activeTab = 0;

  // Tab row
  const tabRow = document.createElement("div");
  tabRow.className = "code-plan-tabs";
  const tabBtns = [];
  for (let i = 0; i < withOpts.length; i++) {
    const tab = document.createElement("button");
    tab.className = "code-plan-tab" + (i === 0 ? " active" : "");
    tab.textContent = (i + 1);
    tab.addEventListener("click", () => showTab(i));
    tabRow.appendChild(tab);
    tabBtns.push(tab);
  }
  formWrap.appendChild(tabRow);

  // Panels
  const panels = [];
  for (let i = 0; i < withOpts.length; i++) {
    const q = withOpts[i];
    const panel = document.createElement("div");
    panel.className = "code-plan-panel" + (i === 0 ? " active" : "");

    const title = document.createElement("div");
    title.className = "code-plan-question-label";
    title.innerHTML = renderMarkdown(q.label + (q.question ? ": " + q.question : ""));
    panel.appendChild(title);

    const inputType = q.multi ? "checkbox" : "radio";
    const optionsWrap = document.createElement("div");
    optionsWrap.className = "code-plan-options";
    for (const opt of q.options) {
      const optLabel = document.createElement("label");
      optLabel.className = "code-plan-option";
      const input = document.createElement("input");
      input.type = inputType;
      input.name = "plan-q-" + i;
      input.value = opt;
      input.addEventListener("change", () => updateTabState());
      optLabel.appendChild(input);
      const span = document.createElement("span");
      span.innerHTML = renderMarkdown(opt);
      optLabel.appendChild(span);
      optionsWrap.appendChild(optLabel);
    }
    // Custom answer row with radio/checkbox + text input
    const customRow = document.createElement("div");
    customRow.className = "code-plan-custom-row";
    const customRadio = document.createElement("input");
    customRadio.type = inputType;
    customRadio.name = "plan-q-" + i;
    customRadio.value = "__custom__";
    customRadio.addEventListener("change", () => { customInput.focus(); updateTabState(); });
    customRow.appendChild(customRadio);
    const customInput = document.createElement("input");
    customInput.type = "text";
    customInput.className = "code-plan-custom-input";
    customInput.placeholder = "Type your own answer...";
    customInput.addEventListener("focus", () => { customRadio.checked = true; updateTabState(); });
    customRow.appendChild(customInput);
    optionsWrap.appendChild(customRow);

    panel.appendChild(optionsWrap);
    formWrap.appendChild(panel);
    panels.push(panel);
  }

  function showTab(idx) {
    activeTab = idx;
    panels.forEach((p, j) => p.classList.toggle("active", j === idx));
    tabBtns.forEach((t, j) => t.classList.toggle("active", j === idx));
  }
  function updateTabState() {
    for (let i = 0; i < withOpts.length; i++) {
      const sel = formWrap.querySelector(`input[name="plan-q-${i}"]:checked`);
      tabBtns[i].classList.toggle("answered", !!sel);
    }
  }

  // Buttons
  const btnRow = document.createElement("div");
  btnRow.className = "code-plan-btn-row";
  const submitBtn = document.createElement("button");
  submitBtn.className = "code-plan-submit";
  submitBtn.textContent = "Submit Answers";
  submitBtn.addEventListener("click", () => {
    const answers = [];
    for (let i = 0; i < withOpts.length; i++) {
      const checked = formWrap.querySelectorAll(`input[name="plan-q-${i}"]:checked`);
      const customInp = panels[i].querySelector(".code-plan-custom-input");
      const customVal = customInp ? customInp.value.trim() : "";
      const vals = [];
      for (const sel of checked) {
        if (sel.value === "__custom__") {
          if (customVal) vals.push(customVal);
        } else {
          vals.push(sel.value);
        }
      }
      if (!checked.length && customVal) vals.push(customVal);
      if (!vals.length) continue;
      answers.push(withOpts[i].label + ": " + vals.join(", "));
    }
    if (answers.length === 0) return;
    codePrompt.value = "My answers:\n" + answers.join("\n");
    codeGenerate({ silent: true, planAnswers: true });
  });
  btnRow.appendChild(submitBtn);
  formWrap.appendChild(btnRow);
  bubble.appendChild(formWrap);
}

function appendThreadMessage(role, text, opts = {}) {
  if (codeThreadEmpty) codeThreadEmpty.style.display = "none";
  const row = document.createElement("div");
  row.className = `message-row ${role}`;

  const avatarClass = role === "user" ? "user-avatar-bubble" : "ai-avatar-bubble";
  const avatarInner = role === "user" ? _userAvatarHtml() : _aiAvatarHtml();

  const images = opts.images || [];
  const files = opts.files || [];
  const imagesHtml = images.length ? `<div class="bubble-attachments">${images.map(src =>
    `<div class="bubble-img-thumb"><img src="${src}" /></div>`).join("")}</div>` : "";
  const filesHtml = files.length ? `<div class="bubble-file-chips">${files.map(f => {
    const ext = f.split(".").pop().toUpperCase();
    return `<a class="file-chip"><span class="file-ext">${ext}</span>${esc(f)}</a>`;
  }).join("")}</div>` : "";

  row.innerHTML = `
    <div class="bubble-wrap">
      <div class="${avatarClass}">${avatarInner}</div>
      <div class="bubble">${imagesHtml}${filesHtml}${esc(text)}</div>
      <div class="msg-meta">
        <span class="timestamp">${ts(opts.timestamp)}</span>
        <span class="bubble-actions">
          <button class="tts-btn bubble-action-btn" title="Read aloud">${icon("play", 13)}</button>
          <button class="copy-btn bubble-action-btn" title="Copy">${icon("copy", 13)}</button>
        </span>
      </div>
    </div>
  `;

  const bubble = row.querySelector(".bubble");

  // Wire copy button
  row.querySelector(".copy-btn").addEventListener("click", function() {
    const content = bubble.textContent || text;
    navigator.clipboard.writeText(content).then(() => {
      this.innerHTML = icon("check", 13);
      this.classList.add("copied");
      setTimeout(() => { this.innerHTML = icon("copy", 13); this.classList.remove("copied"); }, 2000);
    });
  });

  // Wire TTS button
  const playBtn = row.querySelector(".tts-btn");
  playBtn.addEventListener("click", () => {
    const content = bubble.textContent || text;
    if (playBtn.classList.contains("playing")) stopAllTts();
    else speakText(content, getVoice(), playBtn);
  });

  codeThreadScroll.appendChild(row);
  codeThreadScroll.scrollTop = codeThreadScroll.scrollHeight;
  return bubble;
}

async function restoreCodeThread() {
  // Clear thread
  codeThreadScroll.querySelectorAll(".message-row").forEach(el => el.remove());

  // Clear code panel
  _currentCode = "";
  _currentLanguage = "python";
  _exitEditMode();
  _closePreview();
  codeDisplay.querySelector("code").textContent = "";
  codeExecOutput.style.display = "none";

  const snippets = await loadAllCodeSnippets();
  const sessionSnippets = snippets
    .filter(s => s.session_id === activeCodeSessionId && s.rawPrompt !== "(manual edit)")
    .sort((a, b) => _createdAt(a) - _createdAt(b));

  if (sessionSnippets.length) {
    codeThreadEmpty.style.display = "none";
    for (const s of sessionSnippets) {
      const extracted = _extractCode(s.code);
      const lines = extracted.code.split("\n").length;
      const langLabel = (s.language && s.language !== "auto") ? s.language : "code";
      const isEdit = !!s.previousCode;
      const statusText = `${isEdit ? "Edited" : "Generated"} ${langLabel} - ${lines} line${lines !== 1 ? "s" : ""}`;
      let bubble;

      const snapTs = _createdAt(s) || s.timestamp;
      appendThreadMessage("user", s.rawPrompt, {
        images: s.images || [],
        files: s.fileNames || [],
        timestamp: snapTs,
      });

      if (s.conversational) {
        // Conversational response - render markdown, no version pill
        bubble = appendThreadMessage("ai", "", { timestamp: snapTs });
        const rawComment = s.editComment || "";
        // Strip Questions section from bubble if plan form will be built
        const strippedComment = rawComment.replace(/#{1,3}\s+questions[\s\S]*/i, "").trim();
        bubble.innerHTML = renderMarkdown(strippedComment || rawComment);
        // Re-build plan question form if applicable
        _buildPlanForm(rawComment, bubble);
      } else {
        if (s.editComment) {
          bubble = appendThreadMessage("ai", "", { timestamp: snapTs });
          bubble.innerHTML = renderMarkdown(s.editComment)
            + '<br><span style="color:var(--text-faint);font-size:0.8em;">' + esc(statusText) + '</span>';
        } else {
          bubble = appendThreadMessage("ai", extracted.comment || statusText, { timestamp: snapTs });
        }

        // Add version pill to AI bubbles
        const pill = document.createElement("span");
        pill.className = "code-version-pill" + (s.manuallyEdited ? " manual" : "");
        pill.dataset.snippetCode = s.code;
        pill.dataset.snippetLang = s.language || "python";
        bubble.appendChild(pill);
        bubble.classList.add("code-version-bubble");
      }
    }
    // Restore active version (saved index or latest) - only count code snippets
    const codeSnippets = sessionSnippets.filter(s => !s.conversational);
    const pillCount = codeSnippets.length;
    if (pillCount > 0) {
      const sessionState = await loadCodeSessionState(activeCodeSessionId);
      const savedIdx = sessionState?.activeVersionIdx ?? -1;
      const activeIdx = (savedIdx >= 0 && savedIdx < pillCount) ? savedIdx : pillCount - 1;
      _setActiveVersionPill(activeIdx, true);
      const active = codeSnippets[activeIdx];
      const activeExtracted = _extractCode(active.code);
      // Set previous code for diff (from the snippet before the active one)
      if (activeIdx > 0) {
        const prev = codeSnippets[activeIdx - 1];
        _previousCode = _extractCode(prev.code).code;
      } else {
        _previousCode = active.previousCode || "";
      }
      codeDiffBtn.style.display = _previousCode ? "" : "none";
      updateCodePanel(activeExtracted.code, active.language);
    }
    // Scroll to bottom after full thread is rendered
    requestAnimationFrame(() => {
      codeThreadScroll.scrollTop = codeThreadScroll.scrollHeight;
    });
    _updateCodeContextBar();
  } else {
    codeThreadEmpty.style.display = "";
    codePanelEmpty.style.display = "";
    codePanelContent.style.display = "none";
    codeCtxBar.style.display = "none";
  }
}

function updateCodePanel(code, language) {
  _currentCode = code || "";

  // Auto-detect language if set to "auto"
  let resolvedLang = language || "python";
  if (resolvedLang === "auto") {
    const extracted = _extractCode(code);
    resolvedLang = _detectLanguage(extracted.code || code, extracted.fenceLang);
  }
  _currentLanguage = resolvedLang;

  // Show content, hide empty state, auto-open panel
  codePanelContent.style.display = "";
  codePanelEmpty.style.display = "none";
  openCodePanel();

  // Update language badge
  codePanelLang.textContent = resolvedLang.toUpperCase();

  // Update code display
  _renderCodeWithLineNumbers(_currentCode, resolvedLang);

  // Show/hide preview toggle based on resolved language
  const previewable = ["html", "javascript", "css"].includes(resolvedLang);
  codePreviewToggle.style.display = previewable ? "" : "none";

  // Show/hide run button based on resolved language
  const runnable = ["python", "javascript", "bash"].includes(resolvedLang);
  codeRunBtn.style.display = runnable ? "" : "none";

  // Live-update any open previews
  _refreshPreview();
}

function getCurrentCode() {
  if (_codeEditMode) return _getEditorText();
  return _currentCode;
}

function toggleCodeEdit() {
  if (_codeEditMode) {
    _exitEditMode();
  } else {
    _enterEditMode();
  }
}

const codeEditorWrap = document.getElementById("code-editor-wrap");
const codeEditorGutter = document.getElementById("code-editor-gutter");
const codeEditorHighlight = document.getElementById("code-editor-highlight");

// ── Caret helpers for contenteditable ──

function _saveCaretOffset() {
  const sel = window.getSelection();
  if (!sel.rangeCount || !codeEditor.contains(sel.anchorNode)) return 0;
  const range = document.createRange();
  range.selectNodeContents(codeEditor);
  range.setEnd(sel.anchorNode, sel.anchorOffset);
  return range.toString().length;
}

function _restoreCaretOffset(offset) {
  const walker = document.createTreeWalker(codeEditor, NodeFilter.SHOW_TEXT);
  let count = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (count + node.length >= offset) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(node, offset - count);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    count += node.length;
  }
}

function _selectRange(start, end) {
  const walker = document.createTreeWalker(codeEditor, NodeFilter.SHOW_TEXT);
  let count = 0, startNode, startOff, endNode, endOff;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!startNode && count + node.length >= start) {
      startNode = node;
      startOff = start - count;
    }
    if (count + node.length >= end) {
      endNode = node;
      endOff = end - count;
      break;
    }
    count += node.length;
  }
  if (startNode && endNode) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

// ── Editor helpers ──

function _getEditorText() {
  return codeEditor.innerText;
}

function _updateEditorGutter() {
  const text = _getEditorText();
  const lines = text.split("\n").length;
  codeEditorGutter.innerHTML = Array.from({length: lines}, (_, i) => i + 1).join("<br>");
}

let _highlightTimer = null;
function _updateEditorHighlight() {
  _updateEditorGutter();
  clearTimeout(_highlightTimer);
  _highlightTimer = setTimeout(() => {
    const codeEl = codeEditorHighlight.querySelector("code");
    codeEl.className = "";
    delete codeEl.dataset.highlighted;
    const hljsClass = CODE_HLJS_MAP[_currentLanguage] || "";
    if (hljsClass) codeEl.className = "language-" + hljsClass;
    codeEl.textContent = _getEditorText();
    if (typeof hljs !== "undefined") {
      try { hljs.highlightElement(codeEl); } catch {}
    }
  }, 30);
}

function _setHighlight(text) {
  const codeEl = codeEditorHighlight.querySelector("code");
  codeEl.className = "";
  delete codeEl.dataset.highlighted;
  const hljsClass = CODE_HLJS_MAP[_currentLanguage] || "";
  if (hljsClass) codeEl.className = "language-" + hljsClass;
  codeEl.textContent = text;
  if (typeof hljs !== "undefined") {
    try { hljs.highlightElement(codeEl); } catch {}
  }
}

const codeEditorArea = document.getElementById("code-editor-area");

function _syncEditorScroll() {
  codeEditorGutter.scrollTop = codeEditorArea.scrollTop;
}

codeEditorArea.addEventListener("scroll", _syncEditorScroll);
codeEditor.addEventListener("input", _updateEditorHighlight);

// Live preview + auto-save while editing (debounced)
let _livePreviewTimer = null;
let _autoSaveTimer = null;
codeEditor.addEventListener("input", () => {
  // Update preview with short debounce
  clearTimeout(_livePreviewTimer);
  _livePreviewTimer = setTimeout(() => {
    _currentCode = _getEditorText();
    _refreshPreview();
  }, 400);
  // Auto-save to DB with longer debounce
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(async () => {
    _currentCode = _getEditorText();
    try {
      const snippets = await loadAllCodeSnippets();
      const sessionSnippets = snippets
        .filter(s => s.session_id === activeCodeSessionId)
        .sort((a, b) => _createdAt(a) - _createdAt(b));
      if (sessionSnippets.length) {
        const activePill = codeThreadScroll.querySelector(".code-version-pill.current");
        const activeIdx = activePill
          ? [...codeThreadScroll.querySelectorAll(".code-version-pill")].indexOf(activePill)
          : sessionSnippets.length - 1;
        const target = sessionSnippets[activeIdx] || sessionSnippets[sessionSnippets.length - 1];
        target.code = _currentCode;
        target.timestamp = Date.now();
        target.manuallyEdited = true;
        await saveCodeSnippet(target);
      }
    } catch {}
  }, 1500);
});

// Paste as plain text
codeEditor.addEventListener("paste", (e) => {
  e.preventDefault();
  const text = e.clipboardData.getData("text/plain");
  document.execCommand("insertText", false, text);
});

// Tab indent
codeEditor.addEventListener("keydown", (e) => {
  if (e.key === "Tab" && !e.shiftKey) {
    e.preventDefault();
    document.execCommand("insertText", false, "  ");
  }
});

// ── Enter/exit edit mode ──

let _codeBeforeManualEdit = "";
function _enterEditMode() {
  _codeEditMode = true;
  _codeBeforeManualEdit = _currentCode;
  const savedScroll = codePanelContent.scrollTop;
  codeEditor.textContent = _currentCode;
  codeEditor.setAttribute("contenteditable", "plaintext-only");
  _setHighlight(_currentCode);
  codeDisplay.style.display = "none";
  codeEditorWrap.style.display = "";
  codeEditToggle.classList.add("active");
  _updateEditorGutter();
  requestAnimationFrame(() => {
    _restoreCaretOffset(0);
    codeEditor.focus({ preventScroll: true });
    codeEditorArea.scrollTop = savedScroll;
    _syncEditorScroll();
  });
}

function _exitEditMode() {
  if (_codeEditMode) {
    _currentCode = _getEditorText();
    _codeEditMode = false;
    // Flush pending auto-save
    clearTimeout(_autoSaveTimer);
    const wasEdited = _currentCode !== _codeBeforeManualEdit && _currentCode.trim();
    (async () => {
      try {
        const snippets = await loadAllCodeSnippets();
        const sessionSnippets = snippets
          .filter(s => s.session_id === activeCodeSessionId)
          .sort((a, b) => _createdAt(a) - _createdAt(b));
        if (sessionSnippets.length && wasEdited) {
          // Find the active snippet and update it in place
          const activepill = codeThreadScroll.querySelector(".code-version-pill.current");
          const activeIdx = activepill
            ? [...codeThreadScroll.querySelectorAll(".code-version-pill")].indexOf(activepill)
            : sessionSnippets.length - 1;
          const target = sessionSnippets[activeIdx] || sessionSnippets[sessionSnippets.length - 1];
          target.code = _currentCode;
          target.timestamp = Date.now();
          target.manuallyEdited = true;
          await saveCodeSnippet(target);
        }
      } catch {}
    })();
    // If code changed, mark the active pill as manually edited
    if (_currentCode !== _codeBeforeManualEdit && _currentCode.trim()) {
      const activePill = codeThreadScroll.querySelector(".code-version-pill.current");
      if (activePill) {
        activePill.dataset.snippetCode = _currentCode;
        activePill.classList.add("manual");
      }
    }
  }
  codeEditor.removeAttribute("contenteditable");
  codeEditorWrap.style.display = "none";
  codeDisplay.style.display = "";
  codeEditToggle.classList.remove("active");
  _renderCodeWithLineNumbers(_currentCode, _currentLanguage);
  _refreshPreview();
}

function toggleCodePreview() {
  if (_codePreviewOpen) {
    _closePreview();
  } else {
    _openPreview();
  }
}

function _openPreview() {
  _codePreviewOpen = true;
  codePreviewToggle.classList.add("active");
  codePreviewPanel.classList.add("open");
  _refreshPreview();
}

function _buildPreviewSrcdoc(src, lang) {
  if (lang === "html") return src;
  if (lang === "css") return `<!DOCTYPE html><html><head><style>${src}</style></head><body><h1>Preview</h1><p>Sample content for CSS preview.</p><ul><li>Item 1</li><li>Item 2</li><li>Item 3</li></ul></body></html>`;
  if (lang === "javascript") return `<!DOCTYPE html><html><head></head><body><div id="app"></div><script>${src}<\/script></body></html>`;
  return "";
}

function _refreshPreview(code) {
  const src = code || getCurrentCode();
  const srcdoc = _buildPreviewSrcdoc(src, _currentLanguage);
  // Update side panel iframe
  if (_codePreviewOpen) {
    const iframe = codePreviewFrame.querySelector("iframe");
    if (iframe) iframe.srcdoc = srcdoc;
  }
  // Update fullscreen modal iframe
  if (_previewModalOpen) {
    const iframe = _previewModalFrame?.querySelector("iframe");
    if (iframe) iframe.srcdoc = srcdoc;
  }
}

function _closePreview() {
  _codePreviewOpen = false;
  if (codePreviewToggle) codePreviewToggle.classList.remove("active");
  if (codePreviewPanel) codePreviewPanel.classList.remove("open");
  const iframe = codePreviewFrame?.querySelector("iframe");
  if (iframe) iframe.srcdoc = "";
}

// ══════════════════════════════════════════════════════════════
// CODE STUDIO ATTACHMENTS
// ══════════════════════════════════════════════════════════════

function addCodeImageToPreview(dataUrl) {
  codePendingImages.push(dataUrl);
  renderCodeImagePreviews();
}

function renderCodeImagePreviews() {
  codeImagePreviewBar.innerHTML = "";
  if (codePendingImages.length === 0) { codeImagePreviewBar.classList.remove("has-images"); return; }
  codeImagePreviewBar.classList.add("has-images");
  codePendingImages.forEach((dataUrl, i) => {
    const thumb = document.createElement("div");
    thumb.className = "image-preview-thumb";
    thumb.innerHTML = `<img src="${dataUrl}" /><button class="remove-img" title="Remove">&times;</button>`;
    thumb.querySelector(".remove-img").addEventListener("click", () => { codePendingImages.splice(i, 1); renderCodeImagePreviews(); });
    codeImagePreviewBar.appendChild(thumb);
  });
}

function addCodeFileToPreview(file) {
  if (file.size > 2 * 1024 * 1024) {
    showToast("File too large (max 2 MB): " + file.name);
    return;
  }
  codePendingFiles.push(file);
  renderCodeFilePreviews();
}

function renderCodeFilePreviews() {
  codeFilePreviewBar.innerHTML = "";
  if (codePendingFiles.length === 0) { codeFilePreviewBar.classList.remove("has-files"); return; }
  codeFilePreviewBar.classList.add("has-files");
  codePendingFiles.forEach((file, i) => {
    const ext = file.name.split(".").pop().toUpperCase();
    const label = file._pasteLines ? `${file._pasteLines} lines - ${file.size.toLocaleString()} chars` : file.name;
    const thumb = document.createElement("div");
    thumb.className = "file-preview-thumb";
    thumb.innerHTML = `<span class="file-ext">${ext}</span><span class="file-name">${esc(label)}</span><button class="remove-file" title="Remove">&times;</button>`;
    thumb.querySelector(".remove-file").addEventListener("click", () => { codePendingFiles.splice(i, 1); renderCodeFilePreviews(); });
    codeFilePreviewBar.appendChild(thumb);
  });
}

function warnIfNoCodeVision() {
  if (!_codeModelSupportsVision && codePendingImages.length) {
    showToast("Current code model may not support image attachments");
  }
}

// Attach button
codeAttachBtn.addEventListener("click", () => codeFileInput.click());
codeFileInput.addEventListener("change", () => {
  for (const file of codeFileInput.files) {
    if (file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = (e) => addCodeImageToPreview(e.target.result);
      reader.readAsDataURL(file);
    } else {
      addCodeFileToPreview(file);
    }
  }
  codeFileInput.value = "";
  if (codePendingImages.length) warnIfNoCodeVision();
});

// Paste handler for code prompt
codePrompt.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  let attached = false;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      const file = item.getAsFile();
      const reader = new FileReader();
      reader.onload = (ev) => addCodeImageToPreview(ev.target.result);
      reader.readAsDataURL(file);
      attached = true;
    }
  }
  if (attached) { warnIfNoCodeVision(); return; }
  const text = e.clipboardData?.getData("text/plain");
  if (text && text.length >= CODE_PASTE_THRESHOLD) {
    e.preventDefault();
    const blob = new Blob([text], { type: "text/plain" });
    const file = new File([blob], "pasted-code.txt", { type: "text/plain" });
    const lines = text.split("\n").length;
    file._pasteLines = lines;
    file._pasteSnippet = text.slice(0, 200);
    codePendingFiles.push(file);
    renderCodeFilePreviews();
  }
});

// Vision + thinking check on code model change
(function() {
  const codeModelSelect = document.getElementById("code-model-select");
  if (codeModelSelect) {
    const _checkModelCaps = async () => {
      updateCodeSettingsSummary();
      try {
        const res = await apiFetch(`/models/info?model=${encodeURIComponent(codeModelSelect.value)}`);
        if (res.ok) {
          const data = await res.json();
          _codeModelSupportsVision = !!data.vision;
          _codeModelSupportsThinking = !!data.thinking;
        } else {
          _codeModelSupportsVision = false;
          _codeModelSupportsThinking = false;
        }
      } catch {
        _codeModelSupportsVision = false;
        _codeModelSupportsThinking = false;
      }
      // Disable thinking toggle if model doesn't support it. Plan mode is
      // gated on the same capability (reasoning-capable models) since it
      // relies on multi-turn plan/answer dialogue that weak chat models
      // don't follow reliably.
      codeThinkToggle.disabled = !_codeModelSupportsThinking;
      codeThinkToggle.parentElement?.classList.toggle("disabled", !_codeModelSupportsThinking);
      if (!_codeModelSupportsThinking && codeThinkToggle.checked) {
        codeThinkToggle.checked = false;
        _codeThinking = false;
        localStorage.setItem("wooz_code_thinking", "0");
        scheduleSettingsSync();
        updateCodeSettingsSummary();
      }
      codePlanToggle.disabled = !_codeModelSupportsThinking;
      codePlanToggle.parentElement?.classList.toggle("disabled", !_codeModelSupportsThinking);
      if (!_codeModelSupportsThinking && codePlanToggle.checked) {
        codePlanToggle.checked = false;
        _codePlanMode = false;
        localStorage.setItem("wooz_code_plan_mode", "0");
        scheduleSettingsSync();
        updateCodeSettingsSummary();
      }
    };
    codeModelSelect.addEventListener("change", _checkModelCaps);
    // Check on initial load after models populate
    setTimeout(_checkModelCaps, 2000);
  }
})();

// ══════════════════════════════════════════════════════════════
// CODE GENERATION (STREAMING)
// ══════════════════════════════════════════════════════════════

async function codeGenerate(opts = {}) {
  if (_codeGenerating) return;
  const rawPrompt = codePrompt.value.trim();
  if (!rawPrompt) return;
  if (!_modelReady.code) {
    showToast("Code model is loading, please wait...");
    return;
  }

  _ensureCodeSession();
  _setCodeGenerating(true);
  _codeAbortController = new AbortController();
  codePrompt.value = "";

  const language = "auto";
  const model = document.getElementById("code-model-select")?.value || null;

  // Capture and clear attachments
  const attachedImageDataUrls = [...codePendingImages]; // keep data URLs for bubble display
  const attachedImages = codePendingImages.map(d => d.replace(/^data:image\/[^;]+;base64,/, ""));
  const attachedFiles = [...codePendingFiles];
  const attachedFileNames = attachedFiles.map(f => f.name);
  codePendingImages = []; codePendingFiles = [];
  renderCodeImagePreviews(); renderCodeFilePreviews();

  // Prepend attached file contents as context
  let promptWithContext = rawPrompt;
  const codeFiles = attachedFiles.filter(f => !f.type.startsWith("image/"));
  if (codeFiles.length > 0) {
    const texts = await Promise.all(codeFiles.map(f => f.text()));
    const contextBlocks = texts.map((t, i) => `[ATTACHED FILE: ${codeFiles[i].name}]\n${t}\n[END FILE]`);
    promptWithContext = contextBlocks.join("\n\n") + "\n\n" + rawPrompt;
  }

  // Build conversation history from session snippets
  const history = [];
  try {
    const allSnips = await loadAllCodeSnippets();
    const sessionSnips = allSnips
      .filter(s => s.session_id === activeCodeSessionId && s.rawPrompt !== "(manual edit)")
      .sort((a, b) => _createdAt(a) - _createdAt(b));
    for (const s of sessionSnips) {
      history.push({ role: "user", content: s.rawPrompt });
      if (s.conversational && s.editComment) {
        history.push({ role: "assistant", content: s.editComment });
      } else if (s.editComment) {
        // Summarize the edit response (don't include raw SEARCH/REPLACE blocks)
        history.push({ role: "assistant", content: s.editComment });
      } else {
        const ext = _extractCode(s.code);
        const summary = ext.comment || `Generated ${s.language || "code"}`;
        history.push({ role: "assistant", content: summary });
      }
    }
  } catch {}

  // Build request body - include current code for iterative coding
  const currentCode = getCurrentCode();
  const body = { prompt: promptWithContext, language, model, history };
  if (attachedImages.length) body.images = attachedImages;
  if (currentCode) body.code = currentCode;
  if (_codePlanMode) body.plan_mode = true;
  if (_codeThinking) body.thinking = true;
  const isEditMode = !!currentCode;

  // Plan mode: always treat as plan response - LLM uses conversation context to decide whether to plan or code
  const _isPlanResponse = _codePlanMode;

  // Append user message to thread (skip for silent plan form submissions)
  if (!opts.silent) {
    appendThreadMessage("user", rawPrompt, {
      images: attachedImageDataUrls,
      files: attachedFileNames,
    });
  }

  // Create AI status bubble in thread (matching chat structure)
  const langLabel = (language && language !== "auto") ? language : "code";
  const aiRow = document.createElement("div");
  aiRow.className = "message-row ai";
  aiRow.innerHTML = `
    <div class="bubble-wrap">
      <div class="ai-avatar-bubble">${_aiAvatarHtml()}</div>
      <div class="bubble">${_isPlanResponse ? "Planning" : isEditMode ? "Editing" : "Generating"} ${_isPlanResponse ? "" : esc(langLabel)}<span class="code-stream-cursor"></span></div>
      <div class="msg-meta"><span class="timestamp">${ts()}</span></div>
    </div>
  `;
  const aiBubble = aiRow.querySelector(".bubble");
  codeThreadScroll.appendChild(aiRow);
  const hljsClass = CODE_HLJS_MAP[language] || "";

  // Also prepare code panel for streaming (skip in plan mode)
  codePanelEmpty.style.display = "none";
  codePanelContent.style.display = "";
  if (!_isPlanResponse) openCodePanel();
  codePanelLang.textContent = language === "auto" ? "AUTO" : (language || "").toUpperCase();
  _exitEditMode();
  _closePreview();
  codeExecOutput.style.display = "none";
  const panelCode = codeDisplay.querySelector("code");
  panelCode.className = hljsClass ? "language-" + hljsClass : "";
  if (!isEditMode) panelCode.textContent = "";

  let fullCode = "";
  let comment = "";
  let _liveCode = isEditMode ? currentCode : "";
  let _appliedBlocks = 0;
  let _allChangedLines = [];
  let _isConversational = false;
  let _streamPreamble = "";
  let _thinkingContent = "";
  let _inThinkBlock = false;
  let _rawWithThink = "";
  // Edit mode: which output format the LLM chose ("search-replace" | "fence" | null)
  let _editFormat = null;
  // Fresh gen: true once we commit to streaming bare (un-fenced) code into the panel
  let _freshBareCode = false;

  try {
    const res = await mediaFetch("/code/generate", {
      method: "POST",
      body: JSON.stringify(body),
      signal: _codeAbortController?.signal,
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

        if (event.type === "token") {
          _rawWithThink += event.text;

          // Handle <think> blocks - accumulate thinking content, strip from fullCode
          if (_rawWithThink.includes("<think>") && !_rawWithThink.includes("</think>")) {
            if (!_inThinkBlock) {
              _inThinkBlock = true;
              // Extract any content before <think> into fullCode
              const preThink = _rawWithThink.slice(0, _rawWithThink.indexOf("<think>"));
              fullCode = preThink;
              aiBubble.innerHTML = '<span class="code-thinking-indicator">Thinking...</span>';
              codeThreadScroll.scrollTop = codeThreadScroll.scrollHeight;
            }
            continue;
          }
          if (_inThinkBlock && _rawWithThink.includes("</think>")) {
            _inThinkBlock = false;
            const thinkMatch = _rawWithThink.match(/<think>([\s\S]*?)<\/think>/);
            if (thinkMatch) _thinkingContent = thinkMatch[1].trim();
            // Strip all think blocks from raw and rebuild fullCode
            fullCode = _rawWithThink.replace(/<think>[\s\S]*?<\/think>/, "").trimStart();
            // Continue to render the non-think content below
          } else if (!_inThinkBlock) {
            fullCode = _rawWithThink.replace(/<think>[\s\S]*?<\/think>/g, "").trimStart();
          }

          if (isEditMode) {
            // Decide which output format the LLM picked - whichever signal appears first wins.
            // After committing, we don't switch even if both appear later.
            if (_editFormat === null) {
              const sIdx = fullCode.search(/<{3,7}\s*search/i);
              const fMatch = fullCode.match(/```(\w*)\r?\n/);
              const fIdx = fMatch ? fullCode.indexOf(fMatch[0]) : -1;
              if (sIdx >= 0 && (fIdx < 0 || sIdx < fIdx)) {
                _editFormat = "search-replace";
              } else if (fIdx >= 0) {
                _editFormat = "fence";
              }
            }

            if (_editFormat === "fence" && _codePermissions !== "restrictive") {
              // Stream a full-file replacement inside a markdown fence to the panel
              const fMatch = fullCode.match(/```(\w*)\r?\n/);
              if (fMatch) {
                const fenceStart = fullCode.indexOf(fMatch[0]) + fMatch[0].length;
                const closingFence = fullCode.indexOf("\n```", fenceStart);
                const codeContent = closingFence > -1
                  ? fullCode.slice(fenceStart, closingFence)
                  : fullCode.slice(fenceStart);
                _liveCode = codeContent;
                _renderCodeWithLineNumbers(codeContent, _currentLanguage);
                codePanelContent.scrollTop = codePanelContent.scrollHeight;
                const preamble = fullCode.slice(0, fullCode.indexOf(fMatch[0])).trim();
                if (preamble) aiBubble.innerHTML = esc(preamble);
                if (closingFence > -1) {
                  const afterFence = fullCode.slice(closingFence + 4).trim();
                  if (afterFence) {
                    aiBubble.innerHTML = esc(preamble) + (preamble ? '<br><br>' : '')
                      + esc(afterFence) + '<span class="code-stream-cursor"></span>';
                  }
                }
                codeThreadScroll.scrollTop = codeThreadScroll.scrollHeight;
              }
              continue;
            }

            // Show preamble in bubble until SEARCH block markers start appearing
            // Detect partial markers too (trailing <'s at end of stream)
            if (!fullCode.match(/<{2,}/) && !fullCode.trimEnd().endsWith("<")) {
              _streamPreamble = fullCode.trim();
              aiBubble.innerHTML = esc(_streamPreamble) + '<span class="code-stream-cursor"></span>';
              codeThreadScroll.scrollTop = codeThreadScroll.scrollHeight;
            }
            // Apply completed SEARCH/REPLACE blocks to the code panel live (skip in restrictive mode)
            const completedBlocks = _codePermissions !== "restrictive" ? _parseSearchReplaceBlocks(fullCode) : [];
            if (completedBlocks.length > _appliedBlocks) {
              let editLineNum = -1;
              const changedLines = [];
              for (let bi = _appliedBlocks; bi < completedBlocks.length; bi++) {
                const block = completedBlocks[bi];
                const idx = _liveCode.indexOf(block.search);
                if (idx !== -1) {
                  const startLine = _liveCode.slice(0, idx).split("\n").length;
                  editLineNum = startLine;
                  const searchLines = block.search.split("\n");
                  const repLines = block.replace ? block.replace.split("\n") : [];
                  for (let ri = 0; ri < repLines.length; ri++) {
                    if (ri >= searchLines.length || repLines[ri] !== searchLines[ri]) {
                      changedLines.push(startLine + ri);
                    }
                  }
                  _liveCode = _liveCode.slice(0, idx) + block.replace + _liveCode.slice(idx + block.search.length);
                } else {
                  // Fuzzy match fallback
                  const lines = _liveCode.split("\n");
                  const searchLines = block.search.split("\n");
                  for (let i = 0; i <= lines.length - searchLines.length; i++) {
                    const slice = lines.slice(i, i + searchLines.length);
                    if (slice.every((l, j) => l.trimEnd() === searchLines[j].trimEnd())) {
                      editLineNum = i + 1;
                      const before = lines.slice(0, i);
                      const after = lines.slice(i + searchLines.length);
                      const replaceLines = block.replace ? block.replace.split("\n") : [];
                      for (let ri = 0; ri < replaceLines.length; ri++) {
                        if (ri >= searchLines.length || replaceLines[ri] !== searchLines[ri]) {
                          changedLines.push(i + 1 + ri);
                        }
                      }
                      _liveCode = [...before, ...replaceLines, ...after].join("\n");
                      break;
                    }
                  }
                }
              }
              _appliedBlocks = completedBlocks.length;
              _allChangedLines.push(...changedLines);
              _renderCodeWithLineNumbers(_liveCode, _currentLanguage);
              // Highlight changed lines
              _highlightChangedLines(_allChangedLines);
              // Scroll code panel to the edited region
              if (editLineNum > 0) {
                const lineEls = codeDisplay.querySelectorAll(".code-line");
                const targetIdx = Math.max(0, editLineNum - 3);
                if (lineEls[targetIdx]) {
                  lineEls[targetIdx].scrollIntoView({ block: "center", behavior: "smooth" });
                }
              }
            }
          } else if (_isPlanResponse) {
            // Plan mode - check if LLM started generating code (user said proceed)
            const planFence = fullCode.match(/```(\w*)\n/);
            if (!planFence) {
              // Still planning - render markdown in bubble
              aiBubble.innerHTML = renderMarkdown(fullCode.trim())
                + '<span class="code-stream-cursor"></span>';
              codeThreadScroll.scrollTop = codeThreadScroll.scrollHeight;
            } else {
              // Code generation started - switch to code panel
              openCodePanel();
              const preambleText = fullCode.slice(0, fullCode.indexOf(planFence[0])).trim();
              if (preambleText) {
                aiBubble.innerHTML = renderMarkdown(preambleText);
              }
              const fenceStart = fullCode.indexOf(planFence[0]) + planFence[0].length;
              const closingFence = fullCode.indexOf("\n```", fenceStart);
              const codeContent = closingFence > -1
                ? fullCode.slice(fenceStart, closingFence)
                : fullCode.slice(fenceStart);
              panelCode.textContent = codeContent;
              codePanelContent.scrollTop = codePanelContent.scrollHeight;
              codeThreadScroll.scrollTop = codeThreadScroll.scrollHeight;
            }
          } else {
            // Fresh generation - show preamble in bubble, code in panel
            const fenceMatch = fullCode.match(/```(\w*)\r?\n/);
            if (!fenceMatch && (_freshBareCode || _looksLikeBareCode(fullCode))) {
              // Model skipped the fence and is emitting raw code - route to panel anyway
              _freshBareCode = true;
              panelCode.textContent = fullCode;
              codePanelContent.scrollTop = codePanelContent.scrollHeight;
              aiBubble.innerHTML = esc("Generating code...") + '<span class="code-stream-cursor"></span>';
              codeThreadScroll.scrollTop = codeThreadScroll.scrollHeight;
            } else if (!fenceMatch) {
              // Still in preamble - show in bubble
              aiBubble.innerHTML = esc(fullCode.trim()) + '<span class="code-stream-cursor"></span>';
              codeThreadScroll.scrollTop = codeThreadScroll.scrollHeight;
            } else {
              // Code has started - freeze preamble, stream code to panel
              const fenceStart = fullCode.indexOf(fenceMatch[0]) + fenceMatch[0].length;
              const closingFence = fullCode.indexOf("\n```", fenceStart);
              const codeContent = closingFence > -1
                ? fullCode.slice(fenceStart, closingFence)
                : fullCode.slice(fenceStart);
              panelCode.textContent = codeContent;
              codePanelContent.scrollTop = codePanelContent.scrollHeight;
              // Show preamble (without cursor) once code starts
              const preamble = fullCode.slice(0, fullCode.indexOf(fenceMatch[0])).trim();
              if (preamble) {
                aiBubble.innerHTML = esc(preamble);
              }
              // If closing fence found, check for summary after it
              if (closingFence > -1) {
                const afterFence = fullCode.slice(closingFence + 4).trim();
                if (afterFence) {
                  aiBubble.innerHTML = esc(preamble) + '<br><br>' + esc(afterFence) + '<span class="code-stream-cursor"></span>';
                  codeThreadScroll.scrollTop = codeThreadScroll.scrollHeight;
                }
              }
            }
          }
        } else if (event.type === "done") {
          let finalCode;
          comment = "";

          // Plan mode response - conversational unless LLM generated code (user said proceed)
          const _planHasCode = _isPlanResponse && /```\w*\n[\s\S]+?```/.test(fullCode);
          if (_isPlanResponse && !_planHasCode) {
            finalCode = currentCode || "";
            comment = fullCode.trim();
            _isConversational = true;
          } else if (isEditMode && !_planHasCode) {
            // Strip markdown fences before parsing (model sometimes wraps blocks in fences)
            let editRaw = fullCode;
            const fenceStrip = editRaw.match(/```\w*\n([\s\S]*?)```/);
            if (fenceStrip) editRaw = fenceStrip[1];

            if (_appliedBlocks > 0) {
              // Blocks were already applied live - use _liveCode as final result
              finalCode = _liveCode;
              // Extract preamble and summary from the raw output
              const firstIdx = editRaw.search(/<{3,7}\s*search/i);
              const preamble = firstIdx > 0 ? editRaw.slice(0, firstIdx).trim() : _streamPreamble;
              comment = preamble;
              const lastReplaceMatch = editRaw.match(/>{3,7}\s*replace\s*\n?([\s\S]*)$/i);
              if (lastReplaceMatch) {
                const after = lastReplaceMatch[1].trim();
                if (after && !after.match(/<{3,7}\s*search/i)) {
                  comment += (comment ? "\n\n" : "") + after;
                }
              }
            } else {
              // No live blocks applied - try full parse
              const editResult = _applySearchReplace(currentCode, editRaw);
              if (editResult) {
                finalCode = editResult.code;
                comment = editResult.preamble || "";
                if (editResult.summary) {
                  comment += (comment ? "\n\n" : "") + editResult.summary;
                }
                if (!editResult.allApplied) {
                  comment += (comment ? "\n" : "") + "(some edits could not be matched exactly)";
                }
              } else {
                // No SEARCH/REPLACE blocks found
                const hasFence = fullCode.match(/```\w*\n[\s\S]*?```/);
                if (hasFence) {
                  // Model returned full code in fences - use as replacement
                  const extracted = _extractCode(fullCode);
                  finalCode = extracted.code;
                  comment = extracted.comment || "";
                } else {
                  // Conversational response - no code change, just show in bubble
                  finalCode = currentCode;
                  comment = fullCode.trim();
                  _isConversational = true;
                }
              }
            }
          } else {
            // Fresh generation - extract preamble, code, and summary
            const fenceMatch = fullCode.match(/```(\w*)\n([\s\S]*?)```/);
            if (fenceMatch) {
              const preamble = fullCode.slice(0, fullCode.indexOf(fenceMatch[0])).trim();
              const summary = fullCode.slice(fullCode.indexOf(fenceMatch[0]) + fenceMatch[0].length).trim();
              finalCode = fenceMatch[2].trim();
              comment = preamble;
              if (summary) comment += (comment ? "\n\n" : "") + summary;
            } else {
              const extracted = _extractCode(fullCode);
              finalCode = extracted.code;
              comment = extracted.comment;
            }
          }

          fullCode = finalCode;
          let resolvedLang = _currentLanguage || language;

          // Restrictive mode - show accept/reject instead of auto-applying edits
          const _restrictedEdit = _codePermissions === "restrictive" && isEditMode && !_isConversational && finalCode !== currentCode;
          if (_restrictedEdit) {
            // Show comment in bubble with accept/reject controls
            const commentHtml = comment ? esc(comment).replace(/\n\n/g, "<br><br>").replace(/\n/g, "<br>") : "Changes proposed.";
            const lc = finalCode.split("\n").length;
            const resolvedL = _currentLanguage || language;
            const detectedL = (resolvedL && resolvedL !== "auto") ? resolvedL : "code";
            aiBubble.innerHTML = commentHtml
              + '<br><span style="color:var(--text-faint);font-size:0.8em;">Proposed edit to ' + esc(detectedL) + '</span>';
            const acceptBtn = document.createElement("button");
            acceptBtn.className = "code-perm-accept-btn";
            acceptBtn.textContent = "Apply Changes";
            const rejectBtn = document.createElement("button");
            rejectBtn.className = "code-perm-reject-btn";
            rejectBtn.textContent = "Reject";
            const _pendingCode = finalCode;
            const _pendingLang = resolvedL;
            acceptBtn.onclick = () => {
              _renderCodeWithLineNumbers(_pendingCode, _pendingLang);
              const allLines = Array.from({ length: _pendingCode.split("\n").length }, (_, i) => i + 1);
              _highlightChangedLines(allLines);
              _currentLanguage = _pendingLang;
              codePanelLang.textContent = _pendingLang.toUpperCase();
              _previousCode = currentCode || "";
              codeDiffBtn.style.display = _previousCode ? "" : "none";
              _currentCode = _pendingCode;
              fullCode = _pendingCode;
              acceptBtn.remove();
              rejectBtn.remove();
              // Show run/preview for accepted code
              const previewable = ["html", "javascript", "css"].includes(_pendingLang);
              codePreviewToggle.style.display = previewable ? "" : "none";
              const runnable = ["python", "javascript", "bash"].includes(_pendingLang);
              codeRunBtn.style.display = runnable ? "" : "none";
              _refreshPreview(_pendingCode);
            };
            rejectBtn.onclick = () => {
              acceptBtn.remove();
              rejectBtn.remove();
              aiBubble.innerHTML += '<br><span style="color:var(--text-faint);font-size:0.8em;">Changes rejected</span>';
              _isConversational = true; // Treat as conversational so code state isn't saved
            };
            aiBubble.appendChild(acceptBtn);
            aiBubble.appendChild(rejectBtn);
            // Hide run button in restrictive mode
            codeRunBtn.style.display = "none";
          } else if (_isConversational) {
            // Conversational response - just update bubble, don't touch code panel
            // Plan mode: strip Questions section from bubble (rendered as interactive form instead)
            let bubbleComment = comment;
            if (_isPlanResponse) {
              bubbleComment = comment.replace(/#{1,3}\s+questions[\s\S]*/i, "").trim();
            }
            aiBubble.innerHTML = renderMarkdown(bubbleComment);

            // Plan mode: detect clarifying questions with selectable options
            if (_isPlanResponse) {
              _buildPlanForm(comment, aiBubble);
            }
          } else {
            // Open code panel if it wasn't opened during streaming (e.g. plan mode -> code)
            if (_planHasCode) {
              openCodePanel();
              // Extract code from fences - fullCode has preamble + fenced code
              const extracted = _extractCode(fullCode);
              fullCode = extracted.code;
              comment = extracted.comment || "";
            }
            // Resolve language - preserve existing language in edit mode
            resolvedLang = language;
            if (isEditMode) {
              resolvedLang = _currentLanguage;
            } else if (language === "auto") {
              const fenceLang = _extractCode(fullCode).fenceLang || "";
              resolvedLang = _detectLanguage(fullCode, fenceLang);
            }
            // Apply syntax highlighting + line numbers with resolved language
            _renderCodeWithLineNumbers(fullCode, resolvedLang);
            // Re-apply highlights after final render
            if (isEditMode && _allChangedLines.length) {
              _highlightChangedLines(_allChangedLines);
            } else if (!isEditMode) {
              const allLines = Array.from({ length: fullCode.split("\n").length }, (_, i) => i + 1);
              _highlightChangedLines(allLines);
            }
            _currentLanguage = resolvedLang;
            // Update lang badge
            codePanelLang.textContent = resolvedLang.toUpperCase();
            // Strip stray code fence markers from comment
            comment = comment.replace(/```\w*\s*/g, "").trim();
            // Update thread bubble
            const lc = fullCode.split("\n").length;
            const detectedLabel = (resolvedLang && resolvedLang !== "auto") ? resolvedLang : "code";
            if (isEditMode) {
              const editedCount = new Set(_allChangedLines).size || lc;
              const status = `Edited ${detectedLabel} - ${editedCount} line${editedCount !== 1 ? "s" : ""} changed`;
              if (comment) {
                const commentHtml = esc(comment).replace(/\n\n/g, "<br><br>").replace(/\n/g, "<br>");
                aiBubble.innerHTML = commentHtml
                  + '<br><span style="color:var(--text-faint);font-size:0.8em;">' + esc(status) + '</span>';
              } else {
                aiBubble.textContent = status;
              }
            } else {
              const status = `Generated ${detectedLabel} - ${lc} line${lc !== 1 ? "s" : ""}`;
              if (comment) {
                const commentHtml = _planHasCode ? renderMarkdown(comment) : esc(comment).replace(/\n\n/g, "<br><br>").replace(/\n/g, "<br>");
                aiBubble.innerHTML = commentHtml
                  + '<br><span style="color:var(--text-faint);font-size:0.8em;">' + esc(status) + '</span>';
              } else if (_planHasCode) {
                // Plan mode code generation with no preamble - use the streaming bubble content if available
                const existingBubble = aiBubble.innerHTML.replace(/<span class="code-stream-cursor"><\/span>/, "").trim();
                if (existingBubble) {
                  aiBubble.innerHTML = existingBubble
                    + '<br><span style="color:var(--text-faint);font-size:0.8em;">' + esc(status) + '</span>';
                } else {
                  aiBubble.innerHTML = renderMarkdown("Code generated from plan.")
                    + '<br><span style="color:var(--text-faint);font-size:0.8em;">' + esc(status) + '</span>';
                }
              } else {
                aiBubble.textContent = status;
              }
            }
          }
          if (!_isConversational && !_restrictedEdit) {
            // Show/hide preview + run based on resolved language
            const previewable = ["html", "javascript", "css"].includes(resolvedLang);
            codePreviewToggle.style.display = previewable ? "" : "none";
            const runnable = ["python", "javascript", "bash"].includes(resolvedLang);
            codeRunBtn.style.display = runnable ? "" : "none";
            // Live-update preview with final code
            _refreshPreview(fullCode);

            // Permissive mode - auto-run with countdown
            if (_codePermissions === "permissive" && runnable && fullCode) {
              const countdownEl = document.createElement("div");
              countdownEl.className = "code-autorun-countdown";
              let seconds = 3;
              const cancelBtn = document.createElement("button");
              cancelBtn.textContent = "Cancel";
              const countdownText = document.createElement("span");
              countdownText.textContent = `Auto-running in ${seconds}s...`;
              countdownEl.appendChild(countdownText);
              countdownEl.appendChild(cancelBtn);
              aiBubble.appendChild(countdownEl);
              let cancelled = false;
              cancelBtn.onclick = () => { cancelled = true; countdownEl.remove(); };
              const tick = () => {
                if (cancelled) return;
                seconds--;
                if (seconds <= 0) {
                  countdownEl.remove();
                  codeRunBtn.click();
                } else {
                  countdownText.textContent = `Auto-running in ${seconds}s...`;
                  setTimeout(tick, 1000);
                }
              };
              setTimeout(tick, 1000);
            }

            // Add version pill to this bubble
            const pill = document.createElement("span");
            pill.className = "code-version-pill";
            pill.dataset.snippetCode = fullCode;
            pill.dataset.snippetLang = resolvedLang;
            aiBubble.appendChild(pill);
            aiBubble.classList.add("code-version-bubble");
            // Mark all pills - this one is current
            const allPills = codeThreadScroll.querySelectorAll(".code-version-pill");
            _setActiveVersionPill(allPills.length - 1);
          }
          // Prepend thinking block if present
          if (_thinkingContent) {
            const thinkEl = document.createElement("details");
            thinkEl.className = "code-thinking-block";
            thinkEl.innerHTML = '<summary>Thinking</summary>'
              + '<div class="code-thinking-content">' + esc(_thinkingContent) + '</div>';
            aiBubble.insertBefore(thinkEl, aiBubble.firstChild);
          }

          // Auto-disable plan mode after code is generated from planning
          if (_planHasCode) {
            _codePlanMode = false;
            codePlanToggle.checked = false;
            localStorage.setItem("wooz_code_plan_mode", "0");
            scheduleSettingsSync();
            updateCodeSettingsSummary();
          }

          codeThreadScroll.scrollTop = codeThreadScroll.scrollHeight;
        }
      }
    }

    // Update tracked code state
    if (!_isConversational) {
      _previousCode = currentCode || "";
      // Show diff button when there's a previous version to compare
      codeDiffBtn.style.display = _previousCode ? "" : "none";
    }
    _currentCode = fullCode;

    // Save the result (use resolved language so restore works properly)
    const record = {
      id: "code_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      session_id: activeCodeSessionId,
      folder_id: activeCodeFolderId || null,
      rawPrompt,
      title: null,
      code: _isConversational ? "" : fullCode,
      language: _currentLanguage,
      model,
      timestamp: Date.now(),
      ...(comment ? { editComment: comment } : {}),
      ...(_isConversational ? { conversational: true } : {}),
      ...(isEditMode && currentCode && !_isConversational ? { previousCode: currentCode } : {}),
      ...(attachedImageDataUrls.length ? { images: attachedImageDataUrls } : {}),
      ...(attachedFileNames.length ? { fileNames: attachedFileNames } : {}),
    };

    await saveCodeSnippet(record);
    renderCodeSessionsList();
    _updateCodeContextBar();

    // Name session in background (only for first snippet in session)
    const allSnippets = await loadAllCodeSnippets();
    const sessionCount = allSnippets.filter(s => s.session_id === activeCodeSessionId).length;
    if (sessionCount === 1) {
      (async () => {
        try {
          const nameRes = await mediaFetch("/code/name-session", {
            method: "POST",
            body: JSON.stringify({ prompt: rawPrompt }),
          });
          const nameData = await nameRes.json();
          if (nameData.name) {
            record.title = nameData.name;
            await saveCodeSnippet(record);
            renderCodeSessionsList();
          }
        } catch {}
      })();
    }

  } catch (e) {
    if (e.name === "AbortError") {
      const stopDiv = document.createElement("div");
      stopDiv.style.cssText = "color:var(--text-faint);font-size:0.78rem;padding:6px 0;font-style:italic;";
      stopDiv.textContent = "Stopped";
      aiBubble.appendChild(stopDiv);
    } else {
      const errDiv = document.createElement("div");
      errDiv.style.cssText = "color:var(--danger);font-size:0.8rem;padding:6px 0;";
      errDiv.textContent = "Error: " + e.message;
      aiBubble.appendChild(errDiv);
    }
  } finally {
    _setCodeGenerating(false);
    _codeAbortController = null;
  }
}

codeGenerateBtn.addEventListener("click", () => {
  if (_codeGenerating) {
    stopCodeGenerate();
  } else {
    codeGenerate();
  }
});
codePrompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (codePrompt.value.trim().startsWith("/")) return; // slash command
    codeGenerate();
  }
});

// ══════════════════════════════════════════════════════════════
// CODE PANEL TOOLBAR
// ══════════════════════════════════════════════════════════════

// Edit toggle
codeEditToggle.addEventListener("click", toggleCodeEdit);

// Diff toggle
codeDiffBtn.addEventListener("click", _toggleDiffView);

// Copy
codeCopyBtn.addEventListener("click", () => {
  const code = getCurrentCode();
  if (!code) { showToast("No code to copy"); return; }
  navigator.clipboard.writeText(code).then(() => showToast("Copied to clipboard"));
});

// Download
codeDownloadBtn.addEventListener("click", () => {
  const code = getCurrentCode();
  if (!code) { showToast("No code to download"); return; }
  const ext = CODE_EXT_MAP[_currentLanguage] || ".txt";
  const filename = "code" + ext;
  const blob = new Blob([code], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
});

// Run
const RUNNABLE_LANGS = ["python", "javascript", "bash"];
codeRunBtn.addEventListener("click", async () => {
  const code = getCurrentCode();
  if (!code) { showToast("No code to run"); return; }
  const execResize = document.getElementById("code-exec-resize");
  if (execResize) execResize.style.display = "";
  codeExecOutput.style.display = "";
  const label = codeExecOutput.querySelector(".code-exec-label");
  const pre = codeExecOutput.querySelector(".code-exec-pre");

  // Re-detect from the actual code in case the user edited it after generation
  // (so the stale _currentLanguage doesn't send HTML/CSS to python3).
  let runLang = _currentLanguage;
  if (!RUNNABLE_LANGS.includes(runLang)) {
    const redetect = _detectLanguage(code, "");
    if (RUNNABLE_LANGS.includes(redetect)) runLang = redetect;
  }

  if (!RUNNABLE_LANGS.includes(runLang)) {
    label.textContent = "Not runnable";
    label.style.color = "var(--warning, #f59e0b)";
    const shown = (_currentLanguage || "unknown");
    if (shown === "html" || shown === "css") {
      pre.textContent = `Run is only supported for Python, JavaScript, and Bash.\n\nFor ${shown.toUpperCase()}, click the Preview button (eye icon) instead.`;
    } else {
      pre.textContent = `Run is only supported for Python, JavaScript, and Bash.\n\nThe current code is detected as ${shown.toUpperCase()}.\n\nIf this looks wrong, regenerate with a fence (e.g. \`\`\`python) so the language is set explicitly.`;
    }
    return;
  }

  label.textContent = "Running...";
  label.style.color = "";
  pre.textContent = "";

  try {
    const res = await mediaFetch("/code/execute", {
      method: "POST",
      body: JSON.stringify({ code, language: runLang }),
    });
    const data = await res.json();
    if (data.timed_out) {
      label.textContent = "Timed out";
      label.style.color = "var(--warning, #f59e0b)";
    } else if (data.exit_code !== 0) {
      label.textContent = `Exit code: ${data.exit_code}`;
      label.style.color = "var(--danger)";
    } else {
      label.textContent = "Output";
    }
    const out = (data.stdout || "") + (data.stderr ? (data.stdout ? "\n" : "") + data.stderr : "");
    if (out) {
      pre.textContent = out;
    } else if (data.exit_code !== 0) {
      pre.textContent = "(no output - the runner has only Python 3 stdlib / Node 20 stdlib / bash. Third-party packages like requests, pandas, axios are not installed.)";
    } else {
      pre.textContent = "(no output)";
    }
  } catch (e) {
    label.textContent = "Error";
    label.style.color = "var(--danger)";
    pre.textContent = e.message;
  }
});

// Close execution output
document.getElementById("code-exec-close").addEventListener("click", () => {
  codeExecOutput.style.display = "none";
  const execResize = document.getElementById("code-exec-resize");
  if (execResize) execResize.style.display = "none";
});

// Exec output resize handle
(function() {
  const handle = document.getElementById("code-exec-resize");
  if (!handle) return;
  let startY, startH;
  handle.addEventListener("mousedown", e => {
    e.preventDefault();
    startY = e.clientY;
    startH = codeExecOutput.offsetHeight;
    handle.classList.add("dragging");
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.querySelectorAll("iframe").forEach(f => f.style.pointerEvents = "none");
    const onMove = e => {
      const newH = Math.max(60, startH + (startY - e.clientY));
      codeExecOutput.style.setProperty("--exec-h", newH + "px");
    };
    const onUp = () => {
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.querySelectorAll("iframe").forEach(f => f.style.pointerEvents = "");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
})();

// Word wrap toggle
codeWrapToggle.addEventListener("click", () => {
  _codeWrapEnabled = !_codeWrapEnabled;
  codePanel.classList.toggle("code-wrap", _codeWrapEnabled);
  codeWrapToggle.classList.toggle("active", _codeWrapEnabled);
});

// ══════════════════════════════════════════════════════════════
// FIND & REPLACE
// ══════════════════════════════════════════════════════════════

let _findMatches = [];
let _findMatchOffsets = [];
let _findIndex = -1;

function _openFindBar() {
  codeFindBar.style.display = "";
  codeFindInput.focus();
  codeFindInput.select();
}

function _closeFindBar() {
  codeFindBar.style.display = "none";
  codeFindInput.value = "";
  codeReplaceInput.value = "";
  codeFindCount.textContent = "";
  _clearFindHighlights();
  _findMatches = [];
  _findMatchOffsets = [];
  _findIndex = -1;
}

function _clearFindHighlights() {
  // Remove highlight marks from both display and editor highlight containers
  for (const root of [codeDisplay, codeEditorHighlight]) {
    const code = root.querySelector("code");
    if (!code) continue;
    code.querySelectorAll("mark.code-find-match").forEach(m => {
      m.replaceWith(m.textContent);
    });
    code.normalize();
  }
}

function _addMarksToContainer(container, query) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  const rawMatches = [];
  const lowerQuery = query.toLowerCase();
  for (const node of textNodes) {
    const text = node.textContent;
    let idx = text.toLowerCase().indexOf(lowerQuery);
    while (idx !== -1) {
      rawMatches.push({ node, offset: idx });
      idx = text.toLowerCase().indexOf(lowerQuery, idx + 1);
    }
  }
  for (let i = rawMatches.length - 1; i >= 0; i--) {
    const { node, offset } = rawMatches[i];
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + query.length);
    const mark = document.createElement("mark");
    mark.className = "code-find-match";
    range.surroundContents(mark);
  }
  return Array.from(container.querySelectorAll("mark.code-find-match"));
}

function _doFind() {
  const query = codeFindInput.value;
  if (!query) {
    codeFindCount.textContent = "";
    _clearFindHighlights();
    _findMatches = [];
    _findMatchOffsets = [];
    _findIndex = -1;
    return;
  }

  // Choose the right container for DOM marks
  const container = _codeEditMode
    ? codeEditorHighlight.querySelector("code")
    : codeDisplay.querySelector("code");
  if (!container) return;
  _clearFindHighlights();
  _findMatches = _addMarksToContainer(container, query);
  _findIndex = _findMatches.length > 0 ? 0 : -1;

  // In edit mode, also track character offsets for replace operations
  if (_codeEditMode) {
    const text = _getEditorText();
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    _findMatchOffsets = [];
    let pos = lowerText.indexOf(lowerQuery);
    while (pos !== -1) {
      _findMatchOffsets.push(pos);
      pos = lowerText.indexOf(lowerQuery, pos + 1);
    }
  } else {
    _findMatchOffsets = [];
  }

  _updateFindCount();
  if (_findIndex >= 0) _scrollToMatch();
}

function _scrollToMatch() {
  if (_findIndex < 0 || _findIndex >= _findMatches.length) return;
  _findMatches.forEach((m, i) => m.classList.toggle("current", i === _findIndex));
  const mark = _findMatches[_findIndex];
  if (mark) {
    mark.scrollIntoView({ block: "center" });
    // scrollIntoView may not trigger the scroll event synchronously - sync gutter
    if (_codeEditMode) _syncEditorScroll();
  }
}

function _updateFindCount() {
  codeFindCount.textContent = _findMatches.length > 0
    ? `${_findIndex + 1}/${_findMatches.length}`
    : "No results";
}

function _findNext() {
  if (_findMatches.length === 0) return;
  _findIndex = (_findIndex + 1) % _findMatches.length;
  _updateFindCount();
  _scrollToMatch();
}

function _findPrev() {
  if (_findMatches.length === 0) return;
  _findIndex = (_findIndex - 1 + _findMatches.length) % _findMatches.length;
  _updateFindCount();
  _scrollToMatch();
}

function _doReplace() {
  if (!_codeEditMode) {
    showToast("Enable edit mode to replace");
    return;
  }
  const query = codeFindInput.value;
  const replacement = codeReplaceInput.value;
  if (!query || _findMatchOffsets.length === 0 || _findIndex < 0) return;
  const pos = _findMatchOffsets[_findIndex];
  if (pos == null) return;
  const text = _getEditorText();
  const newText = text.substring(0, pos) + replacement + text.substring(pos + query.length);
  codeEditor.textContent = newText;
  _setHighlight(newText);
  _updateEditorGutter();
  _doFind();
}

function _doReplaceAll() {
  if (!_codeEditMode) {
    showToast("Enable edit mode to replace");
    return;
  }
  const query = codeFindInput.value;
  const replacement = codeReplaceInput.value;
  if (!query) return;
  const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const newText = _getEditorText().replace(regex, replacement);
  codeEditor.textContent = newText;
  _setHighlight(newText);
  _updateEditorGutter();
  _doFind();
}

codeFindBtn.addEventListener("click", () => {
  if (codeFindBar.style.display === "none") _openFindBar();
  else _closeFindBar();
});
document.getElementById("code-find-close").addEventListener("click", _closeFindBar);
document.getElementById("code-find-next").addEventListener("click", _findNext);
document.getElementById("code-find-prev").addEventListener("click", _findPrev);
document.getElementById("code-replace-btn").addEventListener("click", _doReplace);
document.getElementById("code-replace-all-btn").addEventListener("click", _doReplaceAll);
codeFindInput.addEventListener("input", _doFind);
codeFindInput.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? _findPrev() : _findNext(); }
  if (e.key === "Escape") _closeFindBar();
});
codeReplaceInput.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); _doReplace(); }
  if (e.key === "Escape") _closeFindBar();
});

// Ctrl+F / Ctrl+H in code panel
codePanel.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    e.preventDefault(); e.stopPropagation();
    _openFindBar();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "h") {
    e.preventDefault(); e.stopPropagation();
    _openFindBar();
    setTimeout(() => codeReplaceInput.focus(), 50);
  }
});

// Preview
codePreviewToggle.addEventListener("click", toggleCodePreview);

// ══════════════════════════════════════════════════════════════
// INSPIRE + NEW SESSION
// ══════════════════════════════════════════════════════════════

document.getElementById("code-suggest-btn").addEventListener("click", async () => {
  try {
    const res = await mediaFetch("/code/inspire");
    const data = await res.json();
    if (data.prompt) codePrompt.value = data.prompt;
  } catch {
    codePrompt.value = CODE_SUGGESTIONS[Math.floor(Math.random() * CODE_SUGGESTIONS.length)];
  }
});

document.getElementById("code-new-session-btn").addEventListener("click", () => {
  activeCodeSessionId = _newCodeSessionId();
  localStorage.setItem("wooz_code_session", activeCodeSessionId);
  document.querySelectorAll(".code-session-item").forEach(el => el.classList.remove("active"));
  // Clear thread
  codeThreadScroll.querySelectorAll(".message-row").forEach(el => el.remove());
  if (codeThreadEmpty) codeThreadEmpty.style.display = "";
  // Clear code panel
  _currentCode = "";
  _currentLanguage = "python";
  _exitEditMode();
  _closePreview();
  codeDisplay.querySelector("code").textContent = "";
  codeExecOutput.style.display = "none";
  codePanelEmpty.style.display = "";
  codePanelContent.style.display = "none";
  closeCodePanel();
  codePrompt.focus();
});

// ══════════════════════════════════════════════════════════════
// CODE PANEL TOGGLE / RESIZE
// ══════════════════════════════════════════════════════════════

function openCodePanel() {
  codePanel.classList.add("open");
  codePanelToggle.classList.add("active");
  localStorage.setItem("wooz_code_panel_open", "1");
}

function closeCodePanel() {
  codePanel.classList.remove("open");
  codePanelToggle.classList.remove("active");
  localStorage.setItem("wooz_code_panel_open", "0");
}

codePanelToggle.addEventListener("click", () => {
  if (codePanel.classList.contains("open")) closeCodePanel();
  else openCodePanel();
});

document.getElementById("code-panel-close").addEventListener("click", closeCodePanel);
document.getElementById("code-preview-close").addEventListener("click", _closePreview);

// Fullscreen preview modal
const _previewModal = document.getElementById("code-preview-modal");
const _previewModalFrame = document.getElementById("code-preview-modal-frame");
let _previewModalOpen = false;

function _openPreviewModal() {
  _previewModalOpen = true;
  _previewModal.classList.add("active");
  if (typeof _resetPreviewModal === "function") _resetPreviewModal();
  // Defer srcdoc set to ensure layout has painted after display change
  requestAnimationFrame(() => _refreshPreview());
}

function _closePreviewModal() {
  _previewModalOpen = false;
  _previewModal.classList.remove("active");
  const iframe = _previewModalFrame.querySelector("iframe");
  if (iframe) iframe.srcdoc = "";
}

document.getElementById("code-preview-fullscreen").addEventListener("click", _openPreviewModal);
document.getElementById("code-preview-modal-close").addEventListener("click", _closePreviewModal);

// Make preview modal draggable + resizable (matching other modals)
const _previewModalCard = document.getElementById("code-preview-modal-card");
const _previewModalHeader = document.getElementById("code-preview-modal-header");
const _resetPreviewModal = makeModalDraggable(_previewModalCard, _previewModalHeader, {
  resizeHandle: document.getElementById("code-preview-modal-resize"),
  minWidth: 400,
  minHeight: 300
});

// Use shared resize utility from ui.js - no max limit on code panel
makePanelResizable("code-panel", "code-panel-resize-handle", "wooz_code_panel_w", 420, 220, 2000);
makePanelResizable("code-preview-panel", "code-preview-resize-handle", "wooz_code_preview_w", 400, 220, 2000);

// ══════════════════════════════════════════════════════════════
// TRASH
// ══════════════════════════════════════════════════════════════

const _codeTrashBtn = document.getElementById("code-trash-btn");
if (_codeTrashBtn) _codeTrashBtn.addEventListener("click", () => openCodeTrashModal());

async function openCodeTrashModal() {
  await purgeOldTrash(loadAllCodeTrash, deleteFromCodeTrash);
  document.getElementById("shared-trash-modal").classList.add("open");
  await renderCodeTrashList();
  document.getElementById("shared-trash-empty-btn").onclick = async () => {
    const count = document.querySelectorAll("#shared-trash-content .studio-trash-card").length;
    if (!count) return;
    const confirmed = await showConfirm({ title: "Empty Trash", message: `Permanently delete ${count} snippet${count !== 1 ? "s" : ""} from trash?` });
    if (!confirmed) return;
    await emptyCodeTrash();
    _updateCodeTrashBadge(0);
    document.getElementById("shared-trash-modal").classList.remove("open");
  };
}

async function renderCodeTrashList() {
  const list = document.getElementById("shared-trash-content");
  list.style.cssText = "display:flex; flex-direction:column;";
  const countLabel = document.getElementById("shared-trash-count");
  const items = (await loadAllCodeTrash()).sort((a, b) => b.deletedAt - a.deletedAt);
  list.innerHTML = "";
  countLabel.textContent = items.length ? `${items.length} snippet${items.length !== 1 ? "s" : ""}` : "";
  _updateCodeTrashBadge(items.length);
  items.forEach(item => {
    const card = document.createElement("div");
    card.className = "studio-trash-card";
    const age = trashAge(item.deletedAt);
    const langStr = item.language || "";
    card.innerHTML = `
      <div class="studio-trash-card-info">
        <div class="studio-trash-card-prompt">${esc(item.title || item.rawPrompt || "Untitled")}</div>
        <div class="studio-trash-card-meta">${langStr}${langStr ? " - " : ""}Deleted ${age}</div>
      </div>
      <div class="studio-trash-card-actions">
        <button class="studio-trash-restore" title="Restore">${icon("refresh")}</button>
        <button class="studio-trash-del" title="Delete permanently">${icon("trash")}</button>
      </div>
    `;
    card.querySelector(".studio-trash-restore").addEventListener("click", async () => {
      const record = { ...item };
      delete record.deletedAt;
      record.timestamp = Date.now();
      await saveCodeSnippet(record);
      await deleteFromCodeTrash(item.id);
      if ((record.folder_id || null) === (activeCodeFolderId || null)) {
        // If restored to current session, reload thread
        if (record.session_id === activeCodeSessionId) {
          restoreCodeThread();
        }
        renderCodeSessionsList();
      }
      await renderCodeTrashList();
    });
    card.querySelector(".studio-trash-del").addEventListener("click", async () => {
      await deleteFromCodeTrash(item.id);
      await renderCodeTrashList();
    });
    list.appendChild(card);
  });
}

function _updateCodeTrashBadge(count) {
  updateBadge("code-trash-badge", count);
}

async function _refreshCodeTrashBadge() {
  const items = await loadAllCodeTrash();
  _updateCodeTrashBadge(items.length);
}
