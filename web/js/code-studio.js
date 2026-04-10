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
const codeCanvas = document.getElementById("code-canvas");
const codeCanvasEmpty = document.getElementById("code-canvas-empty");
const codePrompt = document.getElementById("code-prompt");
const codeGenerateBtn = document.getElementById("code-generate-btn");
const codeFavPanel = document.getElementById("code-fav-panel");
const codeFavToggle = document.getElementById("code-fav-toggle");
const codeFavList = document.getElementById("code-fav-list");
const codeFavEmpty = document.getElementById("code-fav-empty");
const codeFavCount = document.getElementById("code-fav-count");
const codeLanguageSelect = document.getElementById("code-language-select");
const codeModeRow = document.getElementById("code-mode-row");

let _codeGenerating = false;
let _codeMode = localStorage.getItem("wooz_code_mode") || "generate";

// ── Code IndexedDB (via factory) ──
const _codeDB = createStudioDB({
  name: "wooz_code", version: 1,
  stores: ["snippets", "favorites", "trash", "folders"],
});
function openCodeDB()                   { return _codeDB.open(); }
async function saveCodeSnippet(record)  { return _codeDB.save("snippets", record); }
async function loadAllCodeSnippets()    { return _codeDB.loadAll("snippets"); }
async function deleteCodeSnippet(id)    { return _codeDB.remove("snippets", id); }
async function saveCodeFavorite(rec)    { return _codeDB.save("favorites", rec); }
async function deleteCodeFavorite(id)   { return _codeDB.remove("favorites", id); }
async function loadAllCodeFavorites()   { return _codeDB.loadAll("favorites"); }
async function isCodeFavorite(id)       { return _codeDB.has("favorites", id); }
async function saveCodeToTrash(record)  { return _codeDB.save("trash", { ...record, deletedAt: Date.now() }); }
async function loadAllCodeTrash()       { return _codeDB.loadAll("trash"); }
async function deleteFromCodeTrash(id)  { return _codeDB.remove("trash", id); }
async function emptyCodeTrash()         { return _codeDB.clear("trash"); }
async function saveCodeFolder(col)      { return _codeDB.save("folders", col); }
async function deleteCodeFolder(id)     { return _codeDB.remove("folders", id); }
async function loadAllCodeFolders()     { return _codeDB.loadAll("folders"); }

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
    if (s.timestamp > map[sid].ts) { map[sid].ts = s.timestamp; map[sid].title = s.title || null; }
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
      h.className = "sb-date-group";
      h.textContent = group;
      list.appendChild(h);
      lastGroup = group;
    }
    const row = document.createElement("div");
    row.className = "sidebar-row code-session-item" + (s.id === activeCodeSessionId ? " active" : "");
    const label = s.title || s.snippets[0]?.rawPrompt?.slice(0, 40) || "Untitled";
    const count = s.snippets.length;
    row.innerHTML = `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.82rem;">${esc(label)}</span><span style="font-size:0.68rem;color:var(--text-dim);flex-shrink:0;">${count}</span>`;
    row.addEventListener("click", () => {
      activeCodeSessionId = s.id;
      localStorage.setItem("wooz_code_session", s.id);
      restoreCodeSnippets();
      renderCodeSessionsList();
    });
    list.appendChild(row);
  }
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
  for (const f of codeFolders) {
    const row = document.createElement("div");
    row.className = "sidebar-row sb-folder-row" + (f.id === activeCodeFolderId ? " active" : "");
    row.dataset.folderId = f.id;
    row.innerHTML = `<svg width="14" height="14"><use href="#i-folder"/></svg><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.82rem;">${esc(f.name)}</span>`;
    row.addEventListener("click", () => {
      activeCodeFolderId = f.id;
      localStorage.setItem("wooz_code_folder", f.id);
      _renderCodeFoldersSidebar();
      renderCodeSessionsList();
      restoreCodeSnippets();
    });
    // Drag-drop target
    row.addEventListener("dragover", e => { e.preventDefault(); row.classList.add("drag-over"); });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", async e => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const sessionId = e.dataTransfer.getData("text/plain");
      if (!sessionId) return;
      const all = await loadAllCodeSnippets();
      for (const s of all) {
        if (s.session_id === sessionId) {
          s.folder_id = f.id;
          await saveCodeSnippet(s);
        }
      }
      renderCodeSessionsList();
    });
    container.appendChild(row);
  }
}

document.getElementById("code-folder-new-btn").addEventListener("click", async () => {
  const name = prompt("Folder name:");
  if (!name?.trim()) return;
  const folder = { id: "cfolder_" + Date.now(), name: name.trim(), description: "", timestamp: Date.now() };
  await saveCodeFolder(folder);
  activeCodeFolderId = folder.id;
  localStorage.setItem("wooz_code_folder", folder.id);
  await loadCodeFolders();
  activeCodeSessionId = null;
  localStorage.removeItem("wooz_code_session");
  restoreCodeSnippets();
  renderCodeSessionsList();
});

// ── Settings toggle ──
wireSettingsToggle("code-settings-trigger", "code-settings-crumb", "code-settings-panel");

// ── Mode buttons ──
codeModeRow.querySelectorAll(".studio-count-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    codeModeRow.querySelectorAll(".studio-count-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    _codeMode = btn.dataset.mode;
    localStorage.setItem("wooz_code_mode", _codeMode);
    updateCodeSettingsSummary();
  });
});

// Restore saved mode
(function _restoreCodeMode() {
  const saved = localStorage.getItem("wooz_code_mode");
  if (saved) {
    codeModeRow.querySelectorAll(".studio-count-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.mode === saved);
    });
    _codeMode = saved;
  }
})();

// Restore saved language
(function _restoreCodeLanguage() {
  const saved = localStorage.getItem("wooz_code_language");
  if (saved && codeLanguageSelect) codeLanguageSelect.value = saved;
})();

codeLanguageSelect.addEventListener("change", () => {
  localStorage.setItem("wooz_code_language", codeLanguageSelect.value);
  if (typeof scheduleSettingsSync === "function") scheduleSettingsSync();
  updateCodeSettingsSummary();
});

function updateCodeSettingsSummary() {
  const summary = document.getElementById("code-settings-summary");
  if (!summary) return;
  const lang = codeLanguageSelect.options[codeLanguageSelect.selectedIndex]?.textContent || "Python";
  const mode = _codeMode.charAt(0).toUpperCase() + _codeMode.slice(1);
  summary.textContent = `${lang} - ${mode}`;
}

// ── Language extension map ──
const CODE_EXT_MAP = {
  python: ".py", javascript: ".js", typescript: ".ts", bash: ".sh",
  html: ".html", sql: ".sql", go: ".go", rust: ".rs", json: ".json", auto: ".txt",
};

// ── Highlight.js language class map ──
const CODE_HLJS_MAP = {
  python: "python", javascript: "javascript", typescript: "typescript",
  bash: "bash", html: "xml", sql: "sql", go: "go", rust: "rust",
  json: "json", auto: "",
};

// ── Create code result card ──
function createCodeResultCard(record) {
  const el = document.createElement("div");
  el.className = "media-result code-result";
  el.dataset.codeId = record.id;

  const pills = [];
  if (record.language && record.language !== "auto") pills.push(record.language);
  if (record.mode) pills.push(record.mode);
  if (record.model) pills.push(record.model);

  const title = record.title || record.rawPrompt?.slice(0, 60) || "Untitled";
  const promptText = record.rawPrompt || "";
  const codeText = record.code || "";
  const hljsClass = CODE_HLJS_MAP[record.language] || "";

  el.innerHTML = `
    <div class="code-result-body">
      <div class="code-result-header">
        <div class="code-result-prompt" title="${esc(promptText)}">${esc(title)}</div>
        <div class="code-result-pills">${pills.map(p => `<span>${esc(p)}</span>`).join("")}</div>
      </div>
      <div class="code-result-content">
        <pre><code class="${hljsClass ? "language-" + hljsClass : ""}">${esc(codeText)}</code></pre>
      </div>
      ${record.execOutput ? `<div class="code-exec-output"><div class="code-exec-label">Output</div><pre>${esc(record.execOutput)}</pre></div>` : ""}
      <div class="code-result-actions">
        <button class="music-action-btn code-fav-btn" title="Favorite">
          ${icon("heart")}
        </button>
        <button class="music-action-btn code-copy-btn" title="Copy code">
          ${icon("copy", 12)}
        </button>
        ${["python", "javascript", "bash"].includes(record.language) ? `<button class="music-action-btn code-run-btn" title="Run code">${icon("bolt", 12)}</button>` : ""}
        <button class="music-action-btn code-download-btn" title="Download">
          ${icon("download", 12)}
        </button>
        <button class="music-action-btn code-delete-btn" title="Delete">
          ${icon("trash-simple", 12)}
        </button>
      </div>
    </div>
  `;

  // Apply syntax highlighting
  const codeBlock = el.querySelector("pre code");
  if (codeBlock && typeof hljs !== "undefined") {
    try { hljs.highlightElement(codeBlock); } catch {}
  }

  // Favorite button
  const favBtn = el.querySelector(".code-fav-btn");
  isCodeFavorite(record.id).then(fav => {
    if (fav) { favBtn.classList.add("active"); favBtn.querySelector("svg").setAttribute("fill", "#f472b6"); }
  });
  favBtn.addEventListener("click", async () => {
    const isFav = favBtn.classList.contains("active");
    if (isFav) {
      await deleteCodeFavorite(record.id);
      favBtn.classList.remove("active");
      favBtn.querySelector("svg").setAttribute("fill", "none");
    } else {
      await saveCodeFavorite(record);
      favBtn.classList.add("active");
      favBtn.querySelector("svg").setAttribute("fill", "#f472b6");
    }
    refreshCodeFavoritesPanel();
    _updateCodeFavBadge();
  });

  // Copy button
  el.querySelector(".code-copy-btn").addEventListener("click", () => {
    navigator.clipboard.writeText(codeText).then(() => showToast("Copied to clipboard"));
  });

  // Run button
  const runBtn = el.querySelector(".code-run-btn");
  if (runBtn) {
    runBtn.addEventListener("click", () => executeCode(record, el));
  }

  // Download button
  el.querySelector(".code-download-btn").addEventListener("click", () => {
    const ext = CODE_EXT_MAP[record.language] || ".txt";
    const filename = (record.title || "code").replace(/[^a-zA-Z0-9_-]/g, "_") + ext;
    const blob = new Blob([codeText], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // Delete button
  el.querySelector(".code-delete-btn").addEventListener("click", async () => {
    await saveCodeToTrash(record);
    await deleteCodeSnippet(record.id);
    el.remove();
    if (!codeCanvas.querySelector(".code-result")) codeCanvasEmpty.style.display = "";
    renderCodeSessionsList();
    _refreshCodeTrashBadge();
  });

  return el;
}

// ── Restore snippets for active session ──
async function restoreCodeSnippets() {
  codeCanvas.querySelectorAll(".code-result").forEach(el => el.remove());
  const snippets = await loadAllCodeSnippets();
  const sessionSnippets = snippets
    .filter(s => s.session_id === activeCodeSessionId)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (sessionSnippets.length) {
    codeCanvasEmpty.style.display = "none";
    for (const s of sessionSnippets) {
      codeCanvas.appendChild(createCodeResultCard(s));
    }
  } else {
    codeCanvasEmpty.style.display = "";
  }
}

// ── Code generation (STREAMING) ──
async function codeGenerate() {
  if (_codeGenerating) return;
  const rawPrompt = codePrompt.value.trim();
  if (!rawPrompt) return;
  if (!_modelReady.code) {
    showToast("Code model is loading, please wait...");
    return;
  }

  _ensureCodeSession();
  _codeGenerating = true;
  codeGenerateBtn.disabled = true;

  const language = codeLanguageSelect.value;
  const mode = _codeMode;
  const model = document.getElementById("code-model-select")?.value || null;

  // For refactor/explain/debug, find the most recent code snippet in session to use as context
  let existingCode = null;
  if (mode !== "generate") {
    const snippets = await loadAllCodeSnippets();
    const sessionSnippets = snippets
      .filter(s => s.session_id === activeCodeSessionId)
      .sort((a, b) => b.timestamp - a.timestamp);
    if (sessionSnippets.length > 0) {
      existingCode = sessionSnippets[0].code;
    }
  }

  const body = { prompt: rawPrompt, language, mode, model };
  if (existingCode) body.code = existingCode;

  // Create streaming placeholder
  codeCanvasEmpty.style.display = "none";
  const placeholder = document.createElement("div");
  placeholder.className = "media-result code-result code-streaming";
  const hljsClass = CODE_HLJS_MAP[language] || "";
  placeholder.innerHTML = `
    <div class="code-result-body">
      <div class="code-result-header">
        <div class="code-result-prompt">${esc(rawPrompt.slice(0, 60))}</div>
        <div class="code-result-pills"><span>${esc(mode)}</span></div>
      </div>
      <div class="code-result-content">
        <pre><code class="${hljsClass ? "language-" + hljsClass : ""}"></code></pre>
        <span class="code-stream-cursor"></span>
      </div>
    </div>
  `;
  codeCanvas.appendChild(placeholder);
  codeCanvas.scrollTop = codeCanvas.scrollHeight;

  const streamCode = placeholder.querySelector("pre code");
  let fullCode = "";

  try {
    const res = await mediaFetch("/code/generate", {
      method: "POST",
      body: JSON.stringify(body),
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
          fullCode += event.text;
          streamCode.textContent = fullCode;
          codeCanvas.scrollTop = codeCanvas.scrollHeight;
        } else if (event.type === "done") {
          // Apply syntax highlighting on completion
          if (typeof hljs !== "undefined") {
            try { hljs.highlightElement(streamCode); } catch {}
          }
        }
      }
    }

    // Save the result
    const record = {
      id: "code_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      session_id: activeCodeSessionId,
      folder_id: activeCodeFolderId || null,
      rawPrompt,
      title: null,
      code: fullCode,
      language,
      mode,
      model,
      timestamp: Date.now(),
    };

    await saveCodeSnippet(record);

    // Replace placeholder with proper result card
    const card = createCodeResultCard(record);
    placeholder.replaceWith(card);
    codeCanvas.scrollTop = codeCanvas.scrollHeight;
    renderCodeSessionsList();

    // Name session in background
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
          const titleEl = card.querySelector(".code-result-prompt");
          if (titleEl) titleEl.textContent = nameData.name;
          renderCodeSessionsList();
        }
      } catch {}
    })();

  } catch (e) {
    placeholder.querySelector(".code-stream-cursor")?.remove();
    const errMsg = document.createElement("div");
    errMsg.className = "code-exec-output";
    errMsg.innerHTML = `<div class="code-exec-label" style="color:var(--danger)">Error</div><pre>${esc(e.message)}</pre>`;
    placeholder.querySelector(".code-result-body").appendChild(errMsg);
  } finally {
    _codeGenerating = false;
    codeGenerateBtn.disabled = false;
  }
}

codeGenerateBtn.addEventListener("click", codeGenerate);
codePrompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    codeGenerate();
  }
});

// ── Code execution ──
async function executeCode(record, cardEl) {
  const existing = cardEl.querySelector(".code-exec-output");
  if (existing) existing.remove();

  const outputEl = document.createElement("div");
  outputEl.className = "code-exec-output";
  outputEl.innerHTML = `<div class="code-exec-label">Running...</div><pre></pre>`;
  cardEl.querySelector(".code-result-body").appendChild(outputEl);

  try {
    const res = await mediaFetch("/code/execute", {
      method: "POST",
      body: JSON.stringify({ code: record.code, language: record.language }),
    });
    const data = await res.json();
    const label = outputEl.querySelector(".code-exec-label");
    const pre = outputEl.querySelector("pre");

    if (data.timed_out) {
      label.textContent = "Timed out";
      label.style.color = "var(--warning, #f59e0b)";
    } else if (data.exit_code !== 0) {
      label.textContent = `Exit code: ${data.exit_code}`;
      label.style.color = "var(--danger)";
    } else {
      label.textContent = "Output";
    }
    pre.textContent = (data.stdout || "") + (data.stderr ? "\n" + data.stderr : "");

    // Save exec output to record
    record.execOutput = pre.textContent;
    await saveCodeSnippet(record);
  } catch (e) {
    outputEl.querySelector(".code-exec-label").textContent = "Error";
    outputEl.querySelector(".code-exec-label").style.color = "var(--danger)";
    outputEl.querySelector("pre").textContent = e.message;
  }
}

// ── Inspire button ──
document.getElementById("code-suggest-btn").addEventListener("click", async () => {
  try {
    const res = await mediaFetch("/code/inspire");
    const data = await res.json();
    if (data.prompt) codePrompt.value = data.prompt;
  } catch {
    // Fallback to local suggestions
    codePrompt.value = CODE_SUGGESTIONS[Math.floor(Math.random() * CODE_SUGGESTIONS.length)];
  }
});

// ── New session button ──
document.getElementById("code-new-session-btn").addEventListener("click", () => {
  activeCodeSessionId = _newCodeSessionId();
  localStorage.setItem("wooz_code_session", activeCodeSessionId);
  document.querySelectorAll(".code-session-item").forEach(el => el.classList.remove("active"));
  codeCanvas.querySelectorAll(".code-result").forEach(el => el.remove());
  if (codeCanvasEmpty) codeCanvasEmpty.style.display = "";
  codePrompt.focus();
});

// ── Favorites panel ──
codeFavToggle.addEventListener("click", () => {
  const isOpen = codeFavPanel.classList.toggle("open");
  codeFavToggle.classList.toggle("active", isOpen);
  localStorage.setItem("wooz_code_fav_open", isOpen ? "1" : "0");
  if (isOpen) refreshCodeFavoritesPanel();
});
document.getElementById("code-fav-close").addEventListener("click", () => {
  codeFavPanel.classList.remove("open");
  codeFavToggle.classList.remove("active");
  localStorage.setItem("wooz_code_fav_open", "0");
});

async function refreshCodeFavoritesPanel() {
  const favs = await loadAllCodeFavorites();
  favs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  _updateCodeFavBadge();
  codeFavList.querySelectorAll(".code-fav-card").forEach(c => c.remove());
  if (!favs.length) {
    codeFavEmpty.style.display = "";
    return;
  }
  codeFavEmpty.style.display = "none";
  for (const fav of favs) {
    codeFavList.appendChild(_createCodeFavCard(fav));
  }
}

function _createCodeFavCard(fav) {
  const card = document.createElement("div");
  card.className = "code-fav-card music-fav-card";
  card.dataset.favId = fav.id;

  const langStr = fav.language || "";
  const title = fav.title || fav.rawPrompt?.slice(0, 40) || "Untitled";

  card.innerHTML = `
    <div class="music-fav-cover" style="width:40px;height:40px;border-radius:6px;">
      ${icon("code", 16)}
    </div>
    <div class="music-fav-info">
      <div class="music-fav-title">${esc(title)}</div>
      <div class="music-fav-duration">${esc(langStr)}</div>
    </div>
    <div class="music-fav-card-actions">
      <button class="music-action-btn code-fav-copy" title="Copy code">${icon("copy", 12)}</button>
      <button class="music-action-btn code-fav-dl" title="Download">${icon("download", 12)}</button>
      <button class="music-action-btn code-fav-remove" title="Remove from favorites">${icon("heart", 12)}</button>
    </div>
  `;

  // Copy
  card.querySelector(".code-fav-copy").addEventListener("click", () => {
    if (fav.code) navigator.clipboard.writeText(fav.code).then(() => showToast("Copied to clipboard"));
  });

  // Download
  card.querySelector(".code-fav-dl").addEventListener("click", () => {
    if (!fav.code) return;
    const ext = CODE_EXT_MAP[fav.language] || ".txt";
    const filename = (fav.title || "code").replace(/[^a-zA-Z0-9_-]/g, "_") + ext;
    const blob = new Blob([fav.code], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // Remove from favorites
  card.querySelector(".code-fav-remove").addEventListener("click", async () => {
    await deleteCodeFavorite(fav.id);
    card.remove();
    _updateCodeFavBadge();
    const mainCard = codeCanvas.querySelector(`[data-code-id="${fav.id}"]`);
    if (mainCard) {
      const btn = mainCard.querySelector(".code-fav-btn");
      if (btn) { btn.classList.remove("active"); btn.querySelector("svg").setAttribute("fill", "none"); }
    }
    if (!codeFavList.querySelector(".code-fav-card")) {
      codeFavEmpty.style.display = "";
    }
  });

  return card;
}

async function _updateCodeFavBadge() {
  const favs = await loadAllCodeFavorites();
  const count = favs.length;
  updateBadge("code-fav-badge", count);
  if (codeFavCount) codeFavCount.textContent = count || "";
}

// ── Trash ──
document.getElementById("code-trash-btn").addEventListener("click", () => openCodeTrashModal());

async function openCodeTrashModal() {
  await purgeOldTrash(loadAllCodeTrash, deleteFromCodeTrash);
  document.getElementById("shared-trash-modal").classList.add("open");
  await renderCodeTrashList();
  document.getElementById("shared-trash-empty-btn").onclick = async () => {
    const count = document.querySelectorAll("#shared-trash-content .studio-trash-card").length;
    if (!count) return;
    if (!confirm(`Permanently delete ${count} snippet${count !== 1 ? "s" : ""} from trash?`)) return;
    await emptyCodeTrash();
    _updateCodeTrashBadge(0);
    document.getElementById("shared-trash-modal").classList.remove("open");
  };
}

async function renderCodeTrashList() {
  const list = document.getElementById("shared-trash-content");
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
        codeCanvas.appendChild(createCodeResultCard(record));
        codeCanvasEmpty.style.display = "none";
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
