// ── Sidebar toggle ──
const SIDEBAR_KEY = "diab_sidebar_open";
function applySidebar(open) {
  document.body.classList.toggle("sidebar-collapsed", !open);
  sidebarOpenBtn.style.display = "none";
  const sidebar = document.getElementById("sidebar");
  if (!open) {
    sidebar.style.width = "";
  } else {
    const saved = parseInt(localStorage.getItem("diab_sidebar_w"));
    if (saved) sidebar.style.width = saved + "px";
  }
}
let sidebarOpen = localStorage.getItem(SIDEBAR_KEY) !== "false";
applySidebar(sidebarOpen);
sidebarToggle.addEventListener("click", () => {
  sidebarOpen = !sidebarOpen;
  localStorage.setItem(SIDEBAR_KEY, sidebarOpen);
  applySidebar(sidebarOpen);
  if (!sidebarOpen) closeVaultPanel();
});

document.getElementById("strip-expand-btn").addEventListener("click", () => {
  sidebarOpen = true;
  localStorage.setItem(SIDEBAR_KEY, true);
  applySidebar(true);
});
document.getElementById("strip-new-chat-btn").addEventListener("click", () => {
  sidebarOpen = true;
  localStorage.setItem(SIDEBAR_KEY, true);
  applySidebar(true);
  document.getElementById("new-chat-btn").click();
});
document.getElementById("strip-search-btn").addEventListener("click", openSearchModal);
document.getElementById("strip-settings-btn").addEventListener("click", () => document.getElementById("settings-btn").click());

// ── Mobile sidebar ──
const mobileMenuBtn = document.getElementById("mobile-menu-btn");
const mobileSidebarBackdrop = document.getElementById("mobile-sidebar-backdrop");
const sidebar = document.getElementById("sidebar");

function isMobile() { return window.innerWidth <= 768; }

function openMobileSidebar() {
  sidebar.classList.add("mobile-open");
  mobileSidebarBackdrop.classList.add("show");
  document.body.classList.add("mobile-sidebar-open");
}
function closeMobileSidebar() {
  sidebar.classList.remove("mobile-open");
  mobileSidebarBackdrop.classList.remove("show");
  document.body.classList.remove("mobile-sidebar-open");
}

mobileMenuBtn.addEventListener("click", () => {
  if (sidebar.classList.contains("mobile-open")) closeMobileSidebar();
  else openMobileSidebar();
});
mobileSidebarBackdrop.addEventListener("click", closeMobileSidebar);

// Close mobile sidebar when a nav action is taken
["new-chat-btn", "settings-btn", "search-open-btn", "logout-btn"].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("click", () => { if (isMobile()) closeMobileSidebar(); });
});
// Also close on conversation item click
document.getElementById("conv-list").addEventListener("click", (e) => {
  if (isMobile() && e.target.closest(".conv-item")) closeMobileSidebar();
});
// Also close on folder click
document.getElementById("chat-folders-list").addEventListener("click", (e) => {
  if (isMobile() && e.target.closest(".sb-folder-row")) closeMobileSidebar();
});

// On resize, clean up mobile state if switching to desktop
window.addEventListener("resize", () => {
  if (!isMobile()) {
    closeMobileSidebar();
  }
});


// ── Search modal ──
const searchModal = document.getElementById("search-modal");
const searchInput = document.getElementById("search-modal-input");
const searchResults = document.getElementById("search-modal-results");
let searchDebounce = null;

function openSearchModal() {
  searchModal.style.display = "flex";
  searchInput.value = "";
  searchResults.innerHTML = "";
  setTimeout(() => searchInput.focus(), 50);
}
function closeSearchModal() {
  searchModal.style.display = "none";
}

document.getElementById("search-open-btn").addEventListener("click", openSearchModal);
document.getElementById("search-modal-esc").addEventListener("click", closeSearchModal);
searchModal.addEventListener("click", (e) => { if (e.target === searchModal) closeSearchModal(); });
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(); openSearchModal(); }
  if (e.key === "Escape" && searchModal.style.display === "flex") closeSearchModal();
});

searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  if (!q) { searchResults.innerHTML = ""; return; }
  searchDebounce = setTimeout(() => runSearch(q), 250);
});

async function runSearch(q) {
  searchResults.innerHTML = `<div style="padding:20px 16px;color:var(--text-faint);font-size:0.85rem;">Searching…</div>`;
  try {
    const res = await apiFetch(`/conversations/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    renderSearchResults(data, q);
  } catch {
    searchResults.innerHTML = `<div style="padding:20px 16px;color:var(--text-faint);font-size:0.85rem;">Search failed.</div>`;
  }
}

function renderSearchResults(results, q) {
  if (!results.length) {
    searchResults.innerHTML = `<div style="padding:20px 16px;color:var(--text-faint);font-size:0.85rem;">No results for "<strong style="color:var(--text)">${escHtml(q)}</strong>"</div>`;
    return;
  }
  searchResults.innerHTML = results.map(r => `
    <div class="search-result-row" data-cid="${r.id}">
      <div class="search-result-title">${highlightMatch(escHtml(r.title), q)}</div>
      ${r.snippet ? `<div class="search-result-snippet">${highlightMatch(escHtml(r.snippet), q)}</div>` : ""}
    </div>
  `).join("");
  searchResults.querySelectorAll(".search-result-row").forEach(row => {
    row.addEventListener("click", () => {
      closeSearchModal();
      loadConversation(row.dataset.cid);
    });
  });
}

function highlightMatch(html, q) {
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html.replace(new RegExp(escaped, "gi"), m => `<mark style="background:var(--accent-dim);color:#fff;border-radius:2px;padding:0 1px;">${m}</mark>`);
}

function escHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}


// ── Image generation mode ──
// ── Confirm modal ──
function showConfirm({ title = "Confirm", message, okLabel = "Delete", okClass = "danger" } = {}) {
  return new Promise(resolve => {
    document.getElementById("confirm-modal-title").textContent = title;
    document.getElementById("confirm-modal-body").textContent = message;
    const okBtn = document.getElementById("confirm-ok-btn");
    okBtn.textContent = okLabel;
    okBtn.className = okClass;
    document.getElementById("confirm-modal").classList.add("open");
    function finish(result) {
      document.getElementById("confirm-modal").classList.remove("open");
      okBtn.removeEventListener("click", onOk);
      document.getElementById("confirm-cancel-btn").removeEventListener("click", onCancel);
      resolve(result);
    }
    function onOk() { finish(true); }
    function onCancel() { finish(false); }
    okBtn.addEventListener("click", onOk);
    document.getElementById("confirm-cancel-btn").addEventListener("click", onCancel);
  });
}


// ── Toast ──
let toastTimer;
function showToast(msg, type = "error") {
  toast.textContent = msg;
  toast.className = type === "success" ? "success" : "";
  toast.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.display = "none"; }, 4000);
}

function showMemoryToast(msg) {
  toast.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> ${msg}</span>`;
  toast.className = "success";
  toast.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.display = "none"; }, 3000);
}


// ── Context menu ──
function openCtxMenu(e, id) {
  ctxTargetId = id;
  // Build move submenu
  const sub = document.getElementById("ctx-move-sub");
  sub.innerHTML = "";
  sub.style.display = "none";
  chatFolders.forEach(p => {
    const btn = document.createElement("button");
    btn.style.cssText = "display:block;width:100%;text-align:left;background:none;border:none;color:var(--text-dim);cursor:pointer;padding:6px 12px;font-size:0.82rem;border-radius:5px;white-space:nowrap;";
    btn.textContent = p.name;
    const conv = allConversations.find(c => c.id === id);
    if (conv && conv.folder_id === p.id) btn.style.color = "var(--accent)";
    btn.addEventListener("mouseenter", () => btn.style.background = "var(--surface3)");
    btn.addEventListener("mouseleave", () => btn.style.background = "none");
    btn.addEventListener("click", async ev => {
      ev.stopPropagation();
      ctxMenu.style.display = "none";
      await apiFetch(`/conversations/${id}/move`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder_id: p.id }),
      });
      activeChatFolderId = p.id;
      localStorage.setItem("diab_chat_folder", p.id);
      await loadConversations();
    });
    sub.appendChild(btn);
  });
  ctxMenu.style.display = "block";
  ctxMenu.style.left = e.clientX + "px";
  ctxMenu.style.top  = Math.min(e.clientY, window.innerHeight - 120) + "px";
}
document.getElementById("ctx-move").addEventListener("mouseenter", () => {
  document.getElementById("ctx-move-sub").style.display = "block";
});
document.getElementById("ctx-move-wrap").addEventListener("mouseleave", () => {
  document.getElementById("ctx-move-sub").style.display = "none";
});
document.addEventListener("click", () => { ctxMenu.style.display = "none"; });

ctxRename.addEventListener("click", async () => {
  const name = prompt("Rename conversation:");
  if (!name?.trim()) return;
  await apiFetch(`/conversations/${ctxTargetId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: name.trim() }),
  });
  loadConversations();
});

ctxDelete.addEventListener("click", async () => {
  const confirmed = await showConfirm({ title: "Delete Conversation", message: "Delete this conversation? This cannot be undone." });
  if (!confirmed) return;
  await apiFetch(`/conversations/${ctxTargetId}`, { method: "DELETE" });
  if (activeConvId === ctxTargetId) {
    activeConvId = null;
    chatWindow.innerHTML = "";
    chatWindow.appendChild(makeWelcome());
  }
  loadConversations();
});


// ── Panel resize handles ──
function makePanelResizable(panelId, handleId, storageKey, defaultWidth, minWidth = 220, maxWidth = 700) {
  const panel = document.getElementById(panelId);
  const handle = document.getElementById(handleId);

  // Use CSS custom property for saved width so transitions work smoothly
  const saved = parseInt(localStorage.getItem(storageKey));
  if (saved && saved >= minWidth && saved <= maxWidth) {
    panel.style.setProperty("--panel-w", saved + "px");
  }

  let startX, startW;
  handle.addEventListener("mousedown", e => {
    e.preventDefault();
    startX = e.clientX;
    startW = panel.offsetWidth || parseInt(localStorage.getItem(storageKey)) || defaultWidth;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = e => {
      const delta = startX - e.clientX;
      const newW = Math.min(maxWidth, Math.max(minWidth, startW + delta));
      panel.style.setProperty("--panel-w", newW + "px");
    };
    const onUp = () => {
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(storageKey, panel.offsetWidth);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

makePanelResizable("vault-panel", "vault-resize-handle", "diab_vault_w", 320);
makePanelResizable("studio-fav-panel", "fav-resize-handle", "diab_fav_w", 340);
makePanelResizable("music-fav-panel", "music-fav-resize-handle", "diab_music_fav_w", 340);
makePanelResizable("video-fav-panel", "video-fav-resize-handle", "diab_video_fav_w", 340);

// ── Sidebar resize ──
(function() {
  const sidebar = document.getElementById("sidebar");
  const handle  = document.getElementById("sidebar-resize-handle");
  const MIN = 180, MAX = 480, KEY = "diab_sidebar_w";
  const saved = parseInt(localStorage.getItem(KEY));
  if (saved && saved >= MIN && saved <= MAX) {
    sidebar.style.width = saved + "px";
    document.documentElement.style.setProperty("--sidebar-w", saved + "px");
  }
  let startX, startW;
  handle.addEventListener("mousedown", e => {
    e.preventDefault();
    startX = e.clientX;
    startW = sidebar.offsetWidth;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = e => {
      const newW = Math.min(MAX, Math.max(MIN, startW + (e.clientX - startX)));
      sidebar.style.width = newW + "px";
      document.documentElement.style.setProperty("--sidebar-w", newW + "px");
    };
    const onUp = () => {
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(KEY, sidebar.offsetWidth);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
})();


// ── File modal resize ──
(function() {
  const modal = document.getElementById("file-modal-inner");
  let resizing = false;
  function startResize(e, allowW, allowH) {
    e.preventDefault();
    e.stopPropagation();
    resizing = true;
    window._modalResizing = true;
    const startX = e.clientX, startY = e.clientY;
    const startW = modal.offsetWidth, startH = modal.offsetHeight;
    document.body.style.userSelect = "none";
    const onMove = e => {
      if (allowW) modal.style.width  = Math.max(400, Math.min(window.innerWidth  - 40, startW + e.clientX - startX)) + "px";
      if (allowH) modal.style.height = Math.max(300, Math.min(window.innerHeight - 40, startH + e.clientY - startY)) + "px";
    };
    const onUp = e => {
      e.stopPropagation();
      resizing = false;
      setTimeout(() => { window._modalResizing = false; }, 50);
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }
  document.getElementById("modal-resize-se").addEventListener("mousedown", e => startResize(e, true, true));
})();

async function loadVaultFiles() {
  vaultFileList.innerHTML = `<div style="padding:16px;font-size:0.78rem;color:var(--text-dim)">Loading…</div>`;
  vaultMeta.innerHTML = "";
  try {
    const res = await apiFetch(`/vault/files`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    renderVaultMeta(data);
    renderVaultFiles(data.files, data.folders || []);
  } catch (e) {
    vaultFileList.innerHTML = `<div style="padding:16px;font-size:0.78rem;color:var(--danger)">Failed to load: ${esc(e.message)}</div>`;
  }
}

function renderVaultMeta(data) {
  let lastIndexed = "Never";
  if (data.last_indexed) {
    const d = new Date(data.last_indexed);
    lastIndexed = d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }
  const fileCount = data.files?.length || data.files_processed || 0;
  const chunkCount = data.chunks_upserted || 0;
  const SVG_FOLDER_NEW = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>`;
  const SVG_REINDEX    = `${icon("redo", 12)}`;
  vaultMeta.innerHTML = `
    <div class="vault-meta-info"><span>${fileCount}</span> file${fileCount !== 1 ? "s" : ""} · <span>${chunkCount}</span> chunks</div>
    <div class="vault-meta-actions">
      <button id="vault-new-folder-btn" class="vault-action-btn" title="New folder">${SVG_FOLDER_NEW} New folder</button>
      <button id="vault-reindex-btn"    class="vault-action-btn" title="Re-index vault">${SVG_REINDEX} Re-index</button>
    </div>`;
  document.getElementById("vault-reindex-btn").addEventListener("click", () => runReindex({ statusBtn: document.getElementById("vault-reindex-btn"), statusBtnLabel: "Re-index" }));
  document.getElementById("vault-new-folder-btn").addEventListener("click", () => {
    if (vaultFileList.querySelector(".vault-new-folder-row")) return;
    const row = document.createElement("div");
    row.className = "vault-new-folder-row";
    row.innerHTML = `
      ${icon("folder", 13)}
      <input type="text" placeholder="Folder name…" />
      <button class="vault-new-folder-confirm" title="Create">✓</button>
      <button class="vault-new-folder-cancel" title="Cancel">✕</button>
    `;
    vaultFileList.prepend(row);
    const inp = row.querySelector("input");
    inp.focus();
    const confirm = async () => {
      const name = inp.value.trim();
      if (!name) { cancel(); return; }
      try {
        const res = await apiFetch(`/vault/folder`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ folder: name }) });
        if (!res.ok) throw new Error((await res.json()).detail);
        loadVaultFiles();
      } catch(e) { showToast(`Could not create folder: ${e.message}`); }
    };
    const cancel = () => row.remove();
    row.querySelector(".vault-new-folder-confirm").addEventListener("click", confirm);
    row.querySelector(".vault-new-folder-cancel").addEventListener("click", cancel);
    inp.addEventListener("keydown", e => { if (e.key === "Enter") confirm(); if (e.key === "Escape") cancel(); });
    inp.addEventListener("blur", e => { if (!row.contains(e.relatedTarget)) cancel(); });
  });
}

function renderVaultFiles(files, apiFolders) {
  vaultFileList.innerHTML = "";

  // Group files by folder
  const filesByFolder = {};
  files.forEach(f => {
    const parts = f.path.split("/");
    const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
    if (!filesByFolder[folder]) filesByFolder[folder] = [];
    filesByFolder[folder].push(f);
  });

  // Union of folders from files + folders from API (includes empty ones)
  const allFolders = new Set([
    ...Object.keys(filesByFolder).filter(f => f),
    ...(apiFolders || []),
  ]);
  const sortedFolders = [...allFolders].sort((a, b) => a.localeCompare(b));

  if (!files.length && !sortedFolders.length) {
    vaultFileList.innerHTML = `<div style="padding:16px;font-size:0.78rem;color:var(--text-faint)">No files in vault.</div>`;
    return;
  }

  sortedFolders.forEach(folder => {
    vaultFileList.appendChild(makeFolderEl(folder, filesByFolder[folder] || []));
  });
  // root files (no folder)
  (filesByFolder[""] || []).forEach(f => vaultFileList.appendChild(makeFileItem(f)));
}

function makeFolderEl(folder, items) {
  const folderEl = document.createElement("div");
  folderEl.className = "vault-folder open";
  folderEl.dataset.folder = folder;

  const SVG_FOLDER = `${icon("folder", 13)}`;
  const SVG_RENAME = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
  const SVG_TRASH  = `${icon("trash", 12)}`;

  const header = document.createElement("div");
  header.className = "vault-folder-header";
  header.innerHTML = `
    <span class="vault-folder-toggle">▶</span>
    ${SVG_FOLDER}
    <span class="vault-folder-name">${esc(folder)}</span>
    <div class="vault-folder-actions">
      <button class="vault-rename-btn" title="Rename folder">${SVG_RENAME}</button>
      <button class="vault-delete-btn" title="Delete folder">${SVG_TRASH}</button>
    </div>
  `;

  // toggle collapse on name/toggle click (not action buttons)
  header.querySelector(".vault-folder-toggle").addEventListener("click", () => folderEl.classList.toggle("open"));
  header.querySelector(".vault-folder-name").addEventListener("click", () => folderEl.classList.toggle("open"));

  // rename folder
  header.querySelector(".vault-rename-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    startFolderRename(header, folder);
  });

  // delete folder
  header.querySelector(".vault-delete-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    const confirmed = await showConfirm({ title: "Delete Folder", message: `Delete folder "${folder}" and all its files? This cannot be undone.` });
    if (!confirmed) return;
    try {
      const res = await apiFetch(`/vault/folder`, { method:"DELETE", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ folder }) });
      if (!res.ok) throw new Error((await res.json()).detail);
      showVaultBanner("Folder deleted. Search index will update automatically.");
      loadVaultFiles();
    } catch(e) { showToast(`Delete failed: ${e.message}`); }
  });

  // drag-over: files can be dropped onto folder header (internal moves + external uploads)
  let _folderDragTimer = null;
  header.addEventListener("dragover", (e) => {
    e.preventDefault(); e.stopPropagation();
    header.classList.add("drag-over", "file-drop-over");
    // Auto-expand folder after hovering 400ms
    if (!_folderDragTimer && !folderEl.classList.contains("open")) {
      _folderDragTimer = setTimeout(() => folderEl.classList.add("open"), 400);
    }
  });
  header.addEventListener("dragleave", () => {
    header.classList.remove("drag-over", "file-drop-over");
    clearTimeout(_folderDragTimer); _folderDragTimer = null;
  });
  header.addEventListener("drop", async (e) => {
    e.preventDefault(); e.stopPropagation();
    header.classList.remove("drag-over", "file-drop-over");
    clearTimeout(_folderDragTimer); _folderDragTimer = null;
    // Internal vault file move
    const path = e.dataTransfer.getData("text/vault-path");
    if (path) { await moveVaultFile(path, folder); return; }
    // External file drop - upload directly to this folder
    const files = Array.from(e.dataTransfer.files);
    if (files.length) uploadFiles(files, folder);
  });

  const filesDiv = document.createElement("div");
  filesDiv.className = "vault-folder-files";
  items.forEach(f => filesDiv.appendChild(makeFileItem(f)));
  folderEl.appendChild(header);
  folderEl.appendChild(filesDiv);
  return folderEl;
}

function startFolderRename(header, oldFolder) {
  const nameEl = header.querySelector(".vault-folder-name");
  const inp = document.createElement("input");
  inp.value = oldFolder;
  inp.style.cssText = "background:var(--surface3);border:1px solid var(--accent);border-radius:4px;color:var(--text);padding:1px 6px;font-size:0.76rem;font-family:inherit;outline:none;flex:1;min-width:0;";
  nameEl.replaceWith(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const newName = inp.value.trim();
    if (save && newName && newName !== oldFolder) {
      try {
        const res = await apiFetch(`/vault/folder/rename`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ path: oldFolder, new_name: newName }) });
        if (!res.ok) throw new Error((await res.json()).detail);
        loadVaultFiles(); return;
      } catch(e) { showToast(`Rename failed: ${e.message}`); done = false; }
    }
    inp.replaceWith(nameEl);
  };
  inp.addEventListener("keydown", e => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
  inp.addEventListener("blur", () => finish(true));
}

async function moveVaultFile(path, destFolder) {
  try {
    const res = await apiFetch(`/vault/move`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ path, dest_folder: destFolder }) });
    if (!res.ok) throw new Error((await res.json()).detail);
    showVaultBanner("File moved. Search index will update automatically.");
    loadVaultFiles();
  } catch(e) { showToast(`Move failed: ${e.message}`); }
}

function makeFileItem(f) {
  const el = document.createElement("div");
  el.className = "vault-file-item";
  el.draggable = true;
  const chunkLabel = f.chunk_count ? `${f.chunk_count} chunks` : "not indexed";
  const ext = f.name.slice(f.name.lastIndexOf(".") + 1).toLowerCase();
  const fileIconColor = ext === "pdf" ? "#ef4444" : ext === "md" ? "#7c6af7" : "#60a5fa";
  const fileIconSvg = ext === "pdf"
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${fileIconColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>`
    : ext === "md"
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${fileIconColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M10 13l-1 4"/><path d="M14 13l1 4"/><path d="M8.5 15.5l3.5-2 3.5 2"/></svg>`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${fileIconColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>`;
  el.innerHTML = `
    ${fileIconSvg}
    <span class="vault-file-name" title="${esc(f.path)}">${esc(f.name)}</span>
    <span class="vault-chunk-count">${chunkLabel}</span>
    <button class="vault-rename-btn" title="Rename"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
    <button class="vault-delete-btn" title="Delete ${esc(f.name)}">${icon("trash", 13)}</button>
  `;
  el.querySelector(".vault-file-name").addEventListener("click", () => previewVaultFile(f));
  el.querySelector(".vault-rename-btn").addEventListener("click", (e) => { e.stopPropagation(); startRename(el, f); });
  el.querySelector(".vault-delete-btn").addEventListener("click", (e) => { e.stopPropagation(); deleteVaultFile(f); });

  // drag source
  el.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/vault-path", f.path);
    e.dataTransfer.effectAllowed = "move";
    el.classList.add("dragging");
  });
  el.addEventListener("dragend", () => el.classList.remove("dragging"));
  return el;
}

function startRename(el, f) {
  const nameEl = el.querySelector(".vault-file-name");
  const orig = f.name;
  const inp = document.createElement("input");
  inp.value = orig;
  inp.style.cssText = "background:var(--surface3);border:1px solid var(--accent);border-radius:4px;color:var(--text);padding:1px 6px;font-size:0.8rem;font-family:inherit;outline:none;flex:1;min-width:0;";
  nameEl.replaceWith(inp);
  inp.focus();
  inp.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const newName = inp.value.trim();
    if (save && newName && newName !== orig) {
      try {
        const res = await apiFetch(`/vault/rename`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ path: f.path, new_name: newName }) });
        if (!res.ok) throw new Error((await res.json()).detail);
        loadVaultFiles();
        return;
      } catch(e) { showToast(`Rename failed: ${e.message}`); done = false; }
    }
    inp.replaceWith(nameEl);
  };
  inp.addEventListener("keydown", e => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
  inp.addEventListener("blur", () => finish(true));
}

async function previewVaultFile(f) {
  const modal = document.getElementById("file-modal");
  const title = document.getElementById("file-modal-title");
  const content = document.getElementById("file-modal-content");
  const pdfFrame = document.getElementById("file-modal-pdf");
  title.textContent = f.name;
  modal.style.display = "flex";
  const isPdf = f.name.toLowerCase().endsWith(".pdf");
  if (isPdf) {
    content.style.display = "none";
    pdfFrame.style.display = "flex";
    pdfFrame.src = `${API}/vault/file?path=${encodeURIComponent(f.path)}`;
  } else {
    pdfFrame.style.display = "none";
    pdfFrame.src = "";
    content.style.display = "";
    content.textContent = "Loading…";
    try {
      const res = await apiFetch(`/vault/file?path=${encodeURIComponent(f.path)}`);
      const text = await res.text();
      const isMd = f.name.toLowerCase().endsWith(".md");
      if (isMd) {
        content.style.whiteSpace = "normal";
        content.innerHTML = renderMarkdown(text);
      } else {
        content.style.whiteSpace = "pre-wrap";
        content.textContent = text;
      }
    } catch(e) { content.textContent = `Failed to load: ${e.message}`; }
  }
}

async function deleteVaultFile(f) {
  const confirmed = await showConfirm({ title: "Delete File", message: `Delete "${f.name}"? This cannot be undone. You'll need to re-index after deletion.` });
  if (!confirmed) return;
  try {
    const res = await apiFetch(`/vault/files`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: f.path }),
    });
    if (!res.ok) throw new Error(await res.text());
    showVaultBanner("File deleted. Search index will update automatically.");
    loadVaultFiles();
  } catch (e) {
    showToast(`Delete failed: ${e.message}`);
  }
}

function showVaultBanner(msg) {
  vaultBanner.innerHTML = `<div class="vault-banner-msg">${esc(msg)}</div>`;
}


// ── iOS / Mobile fixes ──
// Prevent body scroll bounce on iOS Safari
document.body.addEventListener("touchmove", (e) => {
  // Allow scrolling inside scrollable containers
  let el = e.target;
  while (el && el !== document.body) {
    const style = window.getComputedStyle(el);
    if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) return;
    if ((style.overflowX === "auto" || style.overflowX === "scroll") && el.scrollWidth > el.clientWidth) return;
    el = el.parentElement;
  }
  e.preventDefault();
}, { passive: false });

// iOS visual viewport resize handler - adjust input when keyboard appears
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => {
    if (!isMobile()) return;
    const inputArea = document.getElementById("input-area");
    // When keyboard is up, the viewport shrinks. Move input up.
    const vvh = window.visualViewport.height;
    const wh = window.innerHeight;
    if (vvh < wh * 0.85) {
      // Keyboard visible
      inputArea.style.paddingBottom = "8px";
    } else {
      inputArea.style.paddingBottom = "";
    }
  });
}

// Focus input should scroll chat to bottom on mobile
input.addEventListener("focus", () => {
  if (isMobile()) {
    setTimeout(() => chatWindow.scrollTo({ top: chatWindow.scrollHeight }), 300);
  }
});
