/**
 * notetaker.js - Meeting Note Taker module for WoozleBox.
 *
 * Record or upload audio/video, transcribe with whisperX,
 * diarize speakers, and generate AI summaries.
 */

/* global createStudioAPI, mediaFetch, showToast, esc, wireSettingsToggle,
   trashAge, updateBadge, purgeOldTrash, showNotetaker, setView,
   renderMarkdown, makePanelResizable */

// ── DOM refs ──
const ntCanvas = document.getElementById("notetaker-canvas");
const ntCanvasEmpty = document.getElementById("notetaker-canvas-empty");
const ntPlayer = document.getElementById("notetaker-player");
const ntAudio = document.getElementById("notetaker-audio");
const ntSummaryPanel = document.getElementById("notetaker-summary-panel");
const ntSummaryText = document.getElementById("notetaker-summary-text");
const ntSummaryEmpty = document.getElementById("notetaker-summary-empty");
let _ntProgressCard = null; // shared gen-progress card

// ── Summary panel ──
function openSummaryPanel() {
  ntSummaryPanel.classList.add("open");
  document.getElementById("notetaker-summarize-btn").classList.add("active");
}
function closeSummaryPanel() {
  ntSummaryPanel.classList.remove("open");
  document.getElementById("notetaker-summarize-btn").classList.remove("active");
}

// ── Server-side persistence (via studio API) ──
const _notetakerAPI = createStudioAPI("notetaker");

async function saveNote(r) { return _notetakerAPI.save("notes", r); }
async function loadAllNotes() { return _notetakerAPI.loadAll("notes"); }
async function deleteNote(id) { return _notetakerAPI.remove("notes", id); }
async function saveNtFavorite(r) { return _notetakerAPI.save("favorites", r); }
async function deleteNtFavorite(id) { return _notetakerAPI.remove("favorites", id); }
async function loadAllNtFavorites() { return _notetakerAPI.loadAll("favorites"); }
async function isNtFavorite(id) { return _notetakerAPI.has("favorites", id); }
async function saveNtTrash(r) { return _notetakerAPI.save("trash", r); }
async function loadAllNtTrash() { return _notetakerAPI.loadAll("trash"); }
async function deleteFromNtTrash(id) { return _notetakerAPI.remove("trash", id); }
async function emptyNtTrash() { return _notetakerAPI.clear("trash"); }
async function saveNtFolder(r) { return _notetakerAPI.save("folders", r); }
async function deleteNtFolder(id) { return _notetakerAPI.remove("folders", id); }
async function loadAllNtFolders() { return _notetakerAPI.loadAll("folders"); }

// ── State ──
let ntFolders = [];
let activeNtFolderId = localStorage.getItem("wooz_nt_folder") || null;
let activeNtSessionId = localStorage.getItem("wooz_nt_session") || null;

let _ntRecording = false;
let _ntMediaRecorder = null;
let _ntRecordedChunks = [];
let _ntRecordStream = null;
let _ntAudioCtx = null;
let _ntAnalyser = null;
let _ntAnimFrame = null;
let _ntRecordStart = 0;
let _ntPausedAt = 0;
let _ntPausedTotal = 0;
let _ntTimerInterval = null;
let _ntUploadedFile = null;
let _ntPollTimer = null;
let _ntTranscribing = false;
let _ntCurrentNote = null;  // currently displayed note
let _ntSpeakerColors = {};  // speaker -> color index mapping

// Live streaming state
let _ntStreamSocket = null;
let _ntLiveSegments = [];
let _ntLiveUnconfirmed = "";
const _MEDIA_WS_URL = MEDIA_API.replace(/^http/, "ws");

// ── Session helpers ──

function _newNtSessionId() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return "notesess_" + Array.from(a, b => b.toString(16).padStart(2, "0")).join("");
}

function _ensureNotetakerSession() {
  if (!activeNtSessionId) {
    activeNtSessionId = _newNtSessionId();
    localStorage.setItem("wooz_nt_session", activeNtSessionId);
  }
}

// ── Sessions list ──

async function _getNotetakerSessions() {
  const all = await loadAllNotes();
  const map = {};
  for (const n of all) {
    const sid = n.session_id || "default";
    if (activeNtFolderId && n.folder_id && n.folder_id !== activeNtFolderId) continue;
    if (!activeNtFolderId && n.folder_id) {
      const folders = ntFolders.map(f => f.id);
      if (folders.length > 0 && !folders.includes(n.folder_id)) continue;
    }
    if (!map[sid]) map[sid] = { id: sid, notes: [], title: "", ts: 0 };
    map[sid].notes.push(n);
    if (n.timestamp > map[sid].ts) {
      map[sid].ts = n.timestamp;
      if (n.title) map[sid].title = n.title;
    }
  }
  return Object.values(map).sort((a, b) => b.ts - a.ts);
}

async function renderNotetakerSessionsList() {
  const list = document.getElementById("notetaker-sessions-list");
  if (!list) return;
  const sessions = await _getNotetakerSessions();
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
    row.className = "sb-item nt-session-item" + (s.id === activeNtSessionId ? " active" : "");
    row.dataset.sessionId = s.id;
    row.draggable = true;
    const label = s.title || s.notes[0]?.title || "Untitled Note";
    const dur = s.notes[0]?.duration_s ? _fmtDuration(s.notes[0].duration_s) : "";
    row.innerHTML = `<span class="sb-item-title">${esc(label)}</span>${dur ? `<span class="sb-item-badge">${dur}</span>` : ""}<button class="sb-item-menu nt-session-menu" title="Options">&#x22EF;</button>`;
    row.addEventListener("dragstart", e => {
      e.dataTransfer.setData("text/nt-session", s.id);
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("click", e => {
      if (e.target.closest(".nt-session-menu")) return;
      activeNtSessionId = s.id;
      localStorage.setItem("wooz_nt_session", s.id);
      restoreNotes();
      renderNotetakerSessionsList();
    });
    row.querySelector(".nt-session-menu").addEventListener("click", e => {
      e.stopPropagation();
      _showNtSessionMenu(s, row, e);
    });
    list.appendChild(row);
  }
}

function _showNtSessionMenu(sess, itemEl, e) {
  document.querySelectorAll(".nt-session-ctx-menu, .nt-folder-sub-menu").forEach(m => m.remove());
  const menu = document.createElement("div");
  menu.className = "nt-session-ctx-menu";
  menu.style.cssText = `position:fixed;z-index:9999;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:4px;min-width:160px;box-shadow:0 8px 24px rgba(0,0,0,0.3);`;

  // Rename
  const renameItem = document.createElement("div");
  renameItem.style.cssText = "padding:6px 12px;cursor:pointer;font-size:0.8rem;border-radius:6px;color:var(--text-dim);";
  renameItem.textContent = "Rename";
  renameItem.addEventListener("mouseenter", () => renameItem.style.background = "var(--surface2)");
  renameItem.addEventListener("mouseleave", () => renameItem.style.background = "");
  renameItem.addEventListener("click", async () => {
    menu.remove();
    const name = await showPromptModal({ title: "Rename Session", label: "Session name:", value: sess.title || sess.notes[0]?.title || "Untitled Note" });
    if (!name) return;
    try {
      const firstNote = sess.notes[sess.notes.length - 1];
      if (firstNote) {
        await apiFetch(`/studio/notetaker/items/${firstNote.id}`, {
          method: "PATCH",
          body: JSON.stringify({ title: name.trim() }),
        });
      }
    } catch {}
    renderNotetakerSessionsList();
  });
  menu.appendChild(renameItem);

  // Move to Folder
  if (ntFolders.length > 1) {
    const moveWrap = document.createElement("div");
    moveWrap.style.position = "relative";
    const moveBtn = document.createElement("div");
    moveBtn.style.cssText = "padding:6px 12px;cursor:pointer;font-size:0.8rem;border-radius:6px;color:var(--text-dim);display:flex;align-items:center;justify-content:space-between;";
    moveBtn.innerHTML = `Move to Folder <span>&#x25B8;</span>`;
    moveBtn.addEventListener("mouseenter", () => {
      moveBtn.style.background = "var(--surface2)";
      document.querySelectorAll(".nt-folder-sub-menu").forEach(m => m.remove());
      const sub = document.createElement("div");
      sub.className = "nt-folder-sub-menu";
      sub.style.cssText = `position:fixed;z-index:10000;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,0.4);min-width:140px;`;
      const menuRect = menu.getBoundingClientRect();
      sub.style.left = (menuRect.right + 2) + "px";
      sub.style.top = moveBtn.getBoundingClientRect().top + "px";
      ntFolders.filter(f => f.id !== activeNtFolderId).forEach(folder => {
        const item = document.createElement("div");
        item.style.cssText = "padding:6px 12px;cursor:pointer;font-size:0.78rem;border-radius:6px;color:var(--text-dim);";
        item.textContent = folder.name;
        item.addEventListener("mouseenter", () => item.style.background = "var(--surface2)");
        item.addEventListener("mouseleave", () => item.style.background = "");
        item.addEventListener("click", async () => {
          menu.remove(); sub.remove();
          try {
            for (const n of sess.notes) {
              await apiFetch(`/studio/notetaker/items/${n.id}`, {
                method: "PATCH",
                body: JSON.stringify({ folder_id: folder.id }),
              });
            }
            renderNotetakerSessionsList();
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
    for (const n of sess.notes) {
      await apiFetch(`/studio/notetaker/items/${n.id}/trash`, { method: "POST" });
    }
    _refreshNotetakerTrashBadge();
    if (activeNtSessionId === sess.id) {
      activeNtSessionId = _newNtSessionId();
      localStorage.setItem("wooz_nt_session", activeNtSessionId);
    }
    renderNotetakerSessionsList();
    restoreNotes();
  });
  menu.appendChild(deleteItem);

  const rect = itemEl.getBoundingClientRect();
  menu.style.top = rect.bottom + 4 + "px";
  menu.style.left = rect.left + "px";
  document.body.appendChild(menu);
  const _closeMenu = (ev) => {
    if (!menu.contains(ev.target) && !document.querySelector(".nt-folder-sub-menu")?.contains(ev.target)) {
      menu.remove(); document.querySelectorAll(".nt-folder-sub-menu").forEach(m => m.remove());
      document.removeEventListener("click", _closeMenu);
    }
  };
  setTimeout(() => document.addEventListener("click", _closeMenu), 10);
}

// ── Folders ──

async function loadNotetakerFolders() {
  ntFolders = await loadAllNtFolders();
  if (ntFolders.length === 0) {
    const def = { id: "ntfolder_" + Date.now(), name: "My Notes", description: "Default folder", timestamp: Date.now() };
    await saveNtFolder(def);
    ntFolders = [def];
  }
  if (activeNtFolderId && !ntFolders.find(f => f.id === activeNtFolderId)) {
    activeNtFolderId = ntFolders[0].id;
    localStorage.setItem("wooz_nt_folder", activeNtFolderId);
  }
  _renderNtFoldersSidebar();
}

function _renderNtFoldersSidebar() {
  const container = document.getElementById("notetaker-folders-list");
  if (!container) return;
  container.innerHTML = "";
  const iconSvg = `<svg class="sb-folder-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 3.5C1.5 2.948 1.948 2.5 2.5 2.5H6.086a1 1 0 0 1 .707.293L7.914 3.914A1 1 0 0 0 8.621 4.2H13.5c.552 0 1 .448 1 1v7.3c0 .552-.448 1-1 1h-11c-.552 0-1-.448-1-1V3.5z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>`;
  for (const f of ntFolders) {
    const row = document.createElement("div");
    row.className = "sb-folder-row" + (f.id === activeNtFolderId ? " active" : "");
    row.dataset.id = f.id;
    row.innerHTML = `${iconSvg}<div class="sb-folder-info"><div class="sb-folder-name">${esc(f.name)}</div>${f.description ? `<div class="sb-folder-desc">${esc(f.description)}</div>` : ""}</div><button class="sb-folder-menu" title="Options">&#x22EF;</button>`;
    row.addEventListener("click", e => {
      if (e.target.classList.contains("sb-folder-menu")) return;
      if (f.id === activeNtFolderId) return;
      activeNtFolderId = f.id;
      localStorage.setItem("wooz_nt_folder", f.id);
      _renderNtFoldersSidebar();
      renderNotetakerSessionsList();
    });
    row.querySelector(".sb-folder-menu").addEventListener("click", e => {
      e.stopPropagation();
      _showNtFolderCtxMenu(f, e);
    });
    // Drag-drop target for note sessions
    row.addEventListener("dragover", e => {
      if (!e.dataTransfer.types.includes("text/nt-session")) return;
      e.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", async e => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const sessionId = e.dataTransfer.getData("text/nt-session");
      if (!sessionId) return;
      try {
        const all = await loadAllNotes();
        const matching = all.filter(n => n.session_id === sessionId);
        for (const n of matching) {
          await apiFetch(`/studio/notetaker/items/${n.id}`, {
            method: "PATCH",
            body: JSON.stringify({ folder_id: f.id }),
          });
        }
        renderNotetakerSessionsList();
      } catch (err) { console.warn("Failed to move session:", err); }
    });
    container.appendChild(row);
  }
}

function _showNtFolderCtxMenu(f, e) {
  document.querySelectorAll(".nt-folder-ctx-menu").forEach(el => el.remove());
  const menu = document.createElement("div");
  menu.className = "nt-folder-ctx-menu";
  menu.style.cssText = `position:fixed;z-index:999;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,0.4);min-width:120px;`;
  menu.innerHTML = `
    <div class="nt-folder-ctx-item" data-action="rename" style="padding:6px 12px;cursor:pointer;font-size:0.8rem;border-radius:6px;color:var(--text-dim);">Edit</div>
    <div class="nt-folder-ctx-item" data-action="delete" style="padding:6px 12px;cursor:pointer;font-size:0.8rem;border-radius:6px;color:var(--danger);">Delete</div>
  `;
  menu.style.left = e.clientX + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - 80) + "px";
  document.body.appendChild(menu);
  menu.querySelector('[data-action="rename"]').addEventListener("click", () => {
    menu.remove();
    openNtFolderModal(f);
  });
  menu.querySelector('[data-action="delete"]').addEventListener("click", async () => {
    menu.remove();
    if (ntFolders.length <= 1) { showToast("At least one folder must exist."); return; }
    const confirmed = await showConfirm({ title: "Delete Folder", message: `Delete "${f.name}"? All notes in this folder will be moved to trash.` });
    if (!confirmed) return;
    const allNotes = await loadAllNotes();
    const toDelete = allNotes.filter(n => n.folder_id === f.id);
    for (const n of toDelete) {
      await apiFetch(`/studio/notetaker/items/${n.id}/trash`, { method: "POST" });
    }
    _refreshNotetakerTrashBadge();
    await deleteNtFolder(f.id);
    ntFolders = ntFolders.filter(x => x.id !== f.id);
    if (activeNtFolderId === f.id) {
      activeNtFolderId = ntFolders[0].id;
      localStorage.setItem("wooz_nt_folder", activeNtFolderId);
    }
    _renderNtFoldersSidebar();
    activeNtSessionId = null;
    localStorage.removeItem("wooz_nt_session");
    restoreNotes();
    renderNotetakerSessionsList();
  });
  menu.querySelectorAll(".nt-folder-ctx-item").forEach(item => {
    item.addEventListener("mouseenter", () => item.style.background = "var(--surface2)");
    item.addEventListener("mouseleave", () => item.style.background = "");
  });
  setTimeout(() => {
    const closeMenu = (ev) => {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("click", closeMenu); }
    };
    document.addEventListener("click", closeMenu);
  }, 10);
}

// Note Taker Folder modal
let _editingNtFolderId = null;
function openNtFolderModal(f) {
  _editingNtFolderId = f ? f.id : null;
  document.getElementById("shared-folder-title").textContent = f ? "Edit Folder" : "New Folder";
  document.getElementById("shared-folder-hint").textContent = "Folders organize your recorded notes into separate groups.";
  document.getElementById("shared-folder-name").value = f?.name || "";
  document.getElementById("shared-folder-name").placeholder = "e.g. Work Meetings, Lectures, Interviews";
  document.getElementById("shared-folder-desc").value = f?.description || "";
  document.getElementById("shared-folder-prompt-wrap").style.display = "none";
  document.getElementById("shared-folder-save").textContent = f ? "Save" : "Create Folder";
  document.getElementById("shared-folder-save").onclick = async () => {
    const name = document.getElementById("shared-folder-name").value.trim();
    const description = document.getElementById("shared-folder-desc").value.trim() || "";
    if (!name) { document.getElementById("shared-folder-name").focus(); return; }
    if (_editingNtFolderId) {
      const existing = ntFolders.find(x => x.id === _editingNtFolderId);
      if (existing) { existing.name = name; existing.description = description; await saveNtFolder(existing); }
    } else {
      const folder = { id: "ntfolder_" + Date.now(), name, description, timestamp: Date.now() };
      await saveNtFolder(folder);
      ntFolders.push(folder);
      activeNtFolderId = folder.id;
      localStorage.setItem("wooz_nt_folder", folder.id);
      activeNtSessionId = null;
      localStorage.removeItem("wooz_nt_session");
      restoreNotes();
      renderNotetakerSessionsList();
    }
    closeNtFolderModal();
    _renderNtFoldersSidebar();
  };
  document.getElementById("shared-folder-modal").classList.add("open");
  setTimeout(() => document.getElementById("shared-folder-name").focus(), 50);
}
function closeNtFolderModal() {
  document.getElementById("shared-folder-modal").classList.remove("open");
  _editingNtFolderId = null;
}
document.getElementById("notetaker-folder-new-btn").addEventListener("click", () => openNtFolderModal(null));

// ── Restore notes (canvas) ──

async function restoreNotes() {
  if (!ntCanvas) return;
  const all = await loadAllNotes();
  const sessionNotes = all.filter(n => n.session_id === activeNtSessionId);

  ntCanvas.innerHTML = "";
  _ntCurrentNote = null;

  if (sessionNotes.length === 0) {
    ntCanvas.style.display = "none";
    ntCanvasEmpty.style.display = "";
    ntPlayer.style.display = "none";
    ntPlayer.classList.remove("visible");
    closeSummaryPanel();
    document.getElementById("notetaker-summarize-btn").style.display = "none";
    document.getElementById("notetaker-copy-md-btn").style.display = "none";
    document.getElementById("notetaker-export-md-btn").style.display = "none";
    return;
  }

  // Show the most recent note in this session
  const note = sessionNotes.sort((a, b) => b.timestamp - a.timestamp)[0];
  _displayNote(note);
}

function _displayNote(note) {
  _ntCurrentNote = note;

  // Build speaker color map
  _ntSpeakerColors = {};
  (note.speakers || []).forEach((s, i) => { _ntSpeakerColors[s] = i % 8; });

  // Render transcript
  ntCanvas.innerHTML = "";
  ntCanvas.style.display = "";
  ntCanvasEmpty.style.display = "none";

  if (note.timestamp || note.title || note.duration_s) {
    const hdr = document.createElement("div");
    hdr.className = "nt-transcript-header";
    const title = note.title || "Untitled Note";
    const meta = [];
    if (note.timestamp) meta.push(formatStudioTimestamp(note.timestamp));
    if (note.duration_s) meta.push(_fmtDuration(Math.round(note.duration_s)));
    hdr.innerHTML = `<div class="nt-transcript-title">${esc(title)}</div>`
      + (meta.length ? `<div class="nt-transcript-meta">${esc(meta.join("  -  "))}</div>` : "");
    ntCanvas.appendChild(hdr);
  }

  // Merge consecutive segments from the same speaker into visual blocks
  const segments = note.segments || [];
  const merged = [];
  for (const seg of segments) {
    const prev = merged[merged.length - 1];
    if (prev && prev.speaker === seg.speaker) {
      prev.texts.push(seg.text);
      prev.end = seg.end;
    } else {
      merged.push({ speaker: seg.speaker, start: seg.start, end: seg.end, texts: [seg.text] });
    }
  }

  for (const block of merged) {
    const div = document.createElement("div");
    div.className = "nt-segment";
    div.dataset.start = block.start;
    div.dataset.end = block.end;

    const displayName = (note.speakerNames && note.speakerNames[block.speaker]) || block.speaker;
    const colorIdx = _ntSpeakerColors[block.speaker] || 0;

    const timeStr = block.end > block.start ? `${_fmtTime(block.start)} - ${_fmtTime(block.end)}` : _fmtTime(block.start);
    div.innerHTML = `<div class="nt-segment-header"><span class="nt-speaker-label nt-speaker-${colorIdx}" data-speaker="${esc(block.speaker)}">${esc(displayName)}</span><span class="nt-segment-time">${timeStr}</span></div><div class="nt-segment-text">${block.texts.map(t => esc(t)).join(" ")}</div>`;

    // Click to seek audio
    div.addEventListener("click", () => {
      if (ntAudio.src) {
        ntAudio.currentTime = block.start;
        ntAudio.play();
      }
    });

    // Click speaker label to rename
    const label = div.querySelector(".nt-speaker-label");
    label.addEventListener("click", async e => {
      e.stopPropagation();
      const spk = label.dataset.speaker;
      const currentName = (note.speakerNames && note.speakerNames[spk]) || spk;
      const newName = await showPromptModal({
        title: "Rename Speaker",
        label: `Rename "${currentName}" to:`,
        value: currentName,
        placeholder: "Enter speaker name",
      });
      if (!newName || newName === currentName) return;
      if (!note.speakerNames) note.speakerNames = {};
      note.speakerNames[spk] = newName;
      await saveNote(note);
      _displayNote(note);
    });

    ntCanvas.appendChild(div);
  }

  // Audio player
  if (note.audioUrl) {
    ntPlayer.style.display = "";
    ntPlayer.classList.add("visible");
    // Fetch audio with auth token and create blob URL for playback
    _loadAudioWithAuth(note.id);
    _setupAudioPlayer();
  } else {
    ntPlayer.style.display = "none";
    ntPlayer.classList.remove("visible");
  }

  // Summary panel
  if (note.summary) {
    ntSummaryText.innerHTML = _renderSummaryWithDate(note);
    ntSummaryEmpty.style.display = "none";
    ntSummaryText.style.display = "";
    openSummaryPanel();
  } else {
    ntSummaryText.innerHTML = "";
    ntSummaryText.style.display = "none";
    ntSummaryEmpty.style.display = "";
  }

  // Show summarize button if transcript exists
  document.getElementById("notetaker-summarize-btn").style.display = note.segments?.length ? "" : "none";

  // Show export buttons
  document.getElementById("notetaker-copy-md-btn").style.display = "";
  document.getElementById("notetaker-export-md-btn").style.display = "";
}

// ── Audio player ──

async function _loadAudioWithAuth(noteId) {
  try {
    const resp = await mediaFetch("/notetaker/audio/" + noteId);
    if (!resp.ok) return;
    const blob = await resp.blob();
    // Revoke previous blob URL if any
    if (ntAudio._blobUrl) URL.revokeObjectURL(ntAudio._blobUrl);
    ntAudio._blobUrl = URL.createObjectURL(blob);
    ntAudio.src = ntAudio._blobUrl;
  } catch (e) {
    console.warn("Failed to load audio:", e);
  }
}

let _ntPlayerWired = false;
function _setupAudioPlayer() {
  if (_ntPlayerWired) return;
  _ntPlayerWired = true;

  const seekBar = document.getElementById("notetaker-seek");
  const timeCurrent = document.getElementById("notetaker-time-current");
  const timeTotal = document.getElementById("notetaker-time-total");
  const playBtn = document.getElementById("notetaker-play-btn");
  const speedSel = document.getElementById("notetaker-speed");

  ntAudio.addEventListener("loadedmetadata", () => {
    seekBar.max = Math.floor(ntAudio.duration);
    timeTotal.textContent = _fmtTime(ntAudio.duration);
  });

  ntAudio.addEventListener("timeupdate", () => {
    seekBar.value = Math.floor(ntAudio.currentTime);
    timeCurrent.textContent = _fmtTime(ntAudio.currentTime);
    _highlightActiveSegment(ntAudio.currentTime);
  });

  seekBar.addEventListener("input", () => {
    ntAudio.currentTime = Number(seekBar.value);
  });

  playBtn.addEventListener("click", () => {
    if (ntAudio.paused) ntAudio.play();
    else ntAudio.pause();
  });

  ntAudio.addEventListener("play", () => {
    playBtn.innerHTML = '<svg width="14" height="14"><use href="#i-pause"/></svg>';
  });
  ntAudio.addEventListener("pause", () => {
    playBtn.innerHTML = '<svg width="14" height="14"><use href="#i-play"/></svg>';
  });

  speedSel.addEventListener("change", () => {
    ntAudio.playbackRate = Number(speedSel.value);
  });
}

function _highlightActiveSegment(t) {
  const segs = ntCanvas.querySelectorAll(".nt-segment");
  for (const s of segs) {
    const start = Number(s.dataset.start);
    const end = Number(s.dataset.end);
    s.classList.toggle("active", t >= start && t < end);
  }
}

// ── Audio source tabs ──

const _ntSourceTabs = document.querySelectorAll(".nt-source-tab");
const _ntRecordSection = document.getElementById("notetaker-record-section");
const _ntUploadSection = document.getElementById("notetaker-upload-section");

const _ntTranscribeBtn = document.getElementById("notetaker-transcribe-btn");

_ntSourceTabs.forEach(tab => {
  tab.addEventListener("click", () => {
    _ntSourceTabs.forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    const src = tab.dataset.source;
    _ntRecordSection.style.display = (src === "mic" || src === "system") ? "" : "none";
    _ntUploadSection.style.display = src === "upload" ? "" : "none";
    _ntTranscribeBtn.style.display = src === "upload" ? "" : "none";
  });
});

// ── Recording ──

const _ntRecordBtn = document.getElementById("notetaker-record-btn");
const _ntPauseBtn = document.getElementById("notetaker-pause-btn");
const _ntStopBtn = document.getElementById("notetaker-stop-btn");
const _ntRecordTimer = document.getElementById("notetaker-record-timer");
const _ntWaveformCanvas = document.getElementById("notetaker-waveform");

_ntRecordBtn.addEventListener("click", async () => {
  if (_ntRecording) return;
  if (!_modelReady.notetaker) {
    showToast("Whisper model is loading, please wait...");
    return;
  }

  // Confirm overwrite if a transcription already exists
  if (_ntCurrentNote && ntCanvas.querySelector(".nt-segment")) {
    const ok = await showConfirm({ title: "New Recording", message: "This will overwrite the existing transcription. Continue?", okLabel: "Record", okClass: "danger" });
    if (!ok) return;
  }

  const activeTab = document.querySelector(".nt-source-tab.active");
  const source = activeTab?.dataset.source || "mic";

  try {
    let stream;
    if (source === "system") {
      // System audio capture (Chrome/Edge)
      if (!navigator.mediaDevices.getDisplayMedia) {
        showToast("System audio capture is not supported in this browser", "error");
        return;
      }
      stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false });
    } else {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }

    _ntRecordStream = stream;
    _ntRecordedChunks = [];

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus" : "audio/webm";
    _ntMediaRecorder = new MediaRecorder(stream, { mimeType });

    _ntMediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) {
        _ntRecordedChunks.push(e.data);
        // Send to live stream if connected
        if (_ntStreamSocket && _ntStreamSocket.readyState === WebSocket.OPEN) {
          console.log("[NT-STREAM] Sending chunk, size:", e.data.size);
          _ntStreamSocket.send(e.data);
        } else if (_ntStreamSocket) {
          console.log("[NT-STREAM] Socket not open, readyState:", _ntStreamSocket.readyState);
        }
      }
    };

    _ntMediaRecorder.onstop = () => {
      const blob = new Blob(_ntRecordedChunks, { type: mimeType });
      _ntUploadedFile = new File([blob], "recording.webm", { type: mimeType });
      _stopWaveform();
      _ntRecording = false;
      _ntRecordBtn.style.display = "";
      _ntPauseBtn.style.display = "none";
      _ntStopBtn.style.display = "none";
      clearInterval(_ntTimerInterval);

      // Close live stream
      _stopLiveStream();

      // Dim live segments while final transcription runs
      ntCanvas.querySelectorAll(".nt-segment-live, .nt-segment-unconfirmed")
        .forEach(el => el.classList.add("nt-finalizing"));

      // Auto-trigger full transcription
      _runFullTranscription();
    };

    _ntMediaRecorder.start(1000);
    _ntRecording = true;
    _ntRecordStart = Date.now();
    _ntPausedAt = 0;
    _ntPausedTotal = 0;

    // Start live streaming if enabled
    const liveCheck = document.getElementById("notetaker-live-check");
    if (liveCheck && liveCheck.checked) {
      _startLiveStream();
    }

    // UI
    _ntRecordBtn.style.display = "none";
    _ntPauseBtn.style.display = "";
    _ntStopBtn.style.display = "";

    // Timer (excludes paused time)
    _ntTimerInterval = setInterval(() => {
      if (_ntPausedAt) return;
      const elapsed = Math.floor((Date.now() - _ntRecordStart - _ntPausedTotal) / 1000);
      _ntRecordTimer.textContent = _fmtDuration(elapsed);
    }, 1000);

    // Waveform
    _startWaveform(stream);

  } catch (err) {
    if (err.name !== "NotAllowedError") {
      showToast("Could not access audio: " + err.message, "error");
    }
  }
});

_ntPauseBtn.addEventListener("click", () => {
  if (!_ntMediaRecorder) return;
  if (_ntMediaRecorder.state === "recording") {
    _ntMediaRecorder.pause();
    _ntPausedAt = Date.now();
    _ntPauseBtn.innerHTML = '<svg width="14" height="14"><use href="#i-record"/></svg>';
    _ntPauseBtn.title = "Resume";
  } else if (_ntMediaRecorder.state === "paused") {
    _ntMediaRecorder.resume();
    _ntPausedTotal += Date.now() - _ntPausedAt;
    _ntPausedAt = 0;
    _ntPauseBtn.innerHTML = '<svg width="14" height="14"><use href="#i-pause"/></svg>';
    _ntPauseBtn.title = "Pause";
  }
});

_ntStopBtn.addEventListener("click", () => {
  if (_ntMediaRecorder && _ntMediaRecorder.state !== "inactive") {
    _ntMediaRecorder.stop();
  }
  if (_ntRecordStream) {
    _ntRecordStream.getTracks().forEach(t => t.stop());
    _ntRecordStream = null;
  }
});

// ── Waveform visualization ──

function _startWaveform(stream) {
  _ntAudioCtx = new AudioContext();
  const source = _ntAudioCtx.createMediaStreamSource(stream);
  _ntAnalyser = _ntAudioCtx.createAnalyser();
  _ntAnalyser.fftSize = 256;
  source.connect(_ntAnalyser);

  const canvas = _ntWaveformCanvas;
  const ctx = canvas.getContext("2d");
  const bufLen = _ntAnalyser.frequencyBinCount;
  const data = new Uint8Array(bufLen);

  function draw() {
    _ntAnimFrame = requestAnimationFrame(draw);
    _ntAnalyser.getByteFrequencyData(data);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const barW = canvas.width / bufLen;
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#818cf8";
    ctx.fillStyle = accent;
    for (let i = 0; i < bufLen; i++) {
      const barH = (data[i] / 255) * canvas.height;
      ctx.fillRect(i * barW, canvas.height - barH, barW - 1, barH);
    }
  }
  draw();
}

function _stopWaveform() {
  if (_ntAnimFrame) cancelAnimationFrame(_ntAnimFrame);
  if (_ntAudioCtx) { _ntAudioCtx.close(); _ntAudioCtx = null; }
  _ntAnalyser = null;
  const ctx = _ntWaveformCanvas.getContext("2d");
  ctx.clearRect(0, 0, _ntWaveformCanvas.width, _ntWaveformCanvas.height);
}

// ── Live streaming ──

function _startLiveStream() {
  const language = document.getElementById("notetaker-lang-select").value;
  const wsUrl = _MEDIA_WS_URL + "/notetaker/stream?language=" + encodeURIComponent(language);

  _ntLiveSegments = [];
  _ntLiveUnconfirmed = "";
  _ntStreamSocket = new WebSocket(wsUrl);

  _ntStreamSocket.onopen = () => {
    console.log("[NT-STREAM] WebSocket opened");
  };

  _ntStreamSocket.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.error) { showToast("Live transcription error: " + data.error, "error"); return; }
      _ntLiveSegments = data.confirmed || [];
      _ntLiveUnconfirmed = data.unconfirmed || "";
      _renderLiveSegments();
    } catch (_) {}
  };

  _ntStreamSocket.onerror = (e) => {
    console.error("[NT-STREAM] WebSocket error:", e);
  };

  _ntStreamSocket.onclose = (e) => {
    console.log("[NT-STREAM] WebSocket closed, code:", e.code, "reason:", e.reason, "wasClean:", e.wasClean);
    _ntStreamSocket = null;
  };
}

function _stopLiveStream() {
  if (_ntStreamSocket) {
    _ntStreamSocket.close();
    _ntStreamSocket = null;
  }
}

function _renderLiveSegments() {
  ntCanvas.style.display = "";
  ntCanvasEmpty.style.display = "none";
  ntCanvas.innerHTML = "";

  // Merge consecutive same-speaker segments
  const merged = [];
  for (const seg of _ntLiveSegments) {
    const prev = merged[merged.length - 1];
    if (prev && prev.speaker === seg.speaker) {
      prev.texts.push(seg.text);
      prev.end = seg.end;
    } else {
      merged.push({ speaker: seg.speaker, start: seg.start, end: seg.end, texts: [seg.text] });
    }
  }

  for (const block of merged) {
    const div = document.createElement("div");
    div.className = "nt-segment nt-segment-live";
    const timeStr = block.end > block.start ? `${_fmtTime(block.start)} - ${_fmtTime(block.end)}` : _fmtTime(block.start);
    div.innerHTML = `<div class="nt-segment-header"><span class="nt-speaker-label nt-speaker-0">${esc(block.speaker)}</span><span class="nt-segment-time">${timeStr}</span></div><div class="nt-segment-text">${block.texts.map(t => esc(t)).join(" ")}</div>`;
    ntCanvas.appendChild(div);
  }

  if (_ntLiveUnconfirmed) {
    const div = document.createElement("div");
    div.className = "nt-segment nt-segment-unconfirmed";
    div.innerHTML = `<div class="nt-segment-header"><span class="nt-speaker-label nt-speaker-0">Speaker</span></div><div class="nt-segment-text">${esc(_ntLiveUnconfirmed)}</div>`;
    ntCanvas.appendChild(div);
  }

  ntCanvas.scrollTop = ntCanvas.scrollHeight;
}

// ── File upload ──

const _ntDropzone = document.getElementById("notetaker-dropzone");
const _ntFileInput = document.getElementById("notetaker-file-input");
const _ntFileInfo = document.getElementById("notetaker-file-info");

_ntFileInput.addEventListener("change", () => {
  if (_ntFileInput.files[0]) _handleUploadedFile(_ntFileInput.files[0]);
});

_ntDropzone.addEventListener("dragover", e => {
  e.preventDefault();
  _ntDropzone.classList.add("dragover");
});
_ntDropzone.addEventListener("dragleave", () => _ntDropzone.classList.remove("dragover"));
_ntDropzone.addEventListener("drop", e => {
  e.preventDefault();
  _ntDropzone.classList.remove("dragover");
  if (e.dataTransfer.files[0]) _handleUploadedFile(e.dataTransfer.files[0]);
});

const _ntDropzoneLabel = document.getElementById("notetaker-dropzone-label");

function _handleUploadedFile(file) {
  const ext = "." + file.name.split(".").pop().toLowerCase();
  const supported = new Set([".wav", ".mp3", ".m4a", ".flac", ".mp4", ".mkv", ".webm", ".mov", ".ogg", ".wma"]);
  if (!supported.has(ext)) {
    showToast("Unsupported format: " + ext, "error");
    return;
  }
  _ntUploadedFile = file;
  const sizeMB = (file.size / 1024 / 1024).toFixed(1);
  _ntFileInfo.textContent = `${file.name} (${sizeMB} MB)`;
  _ntFileInfo.style.display = "";
  _ntDropzoneLabel.style.display = "none";
}

function _clearUploadedFile() {
  _ntUploadedFile = null;
  _ntFileInput.value = "";
  _ntFileInfo.style.display = "none";
  _ntDropzoneLabel.style.display = "";
}

// ── Transcribe ──

async function _runFullTranscription() {
  if (!_ntUploadedFile) {
    showToast("Record audio or upload a file first", "error");
    return;
  }
  if (!_modelReady.notetaker) {
    showToast("Whisper model is loading, please wait...");
    return;
  }

  const model = document.getElementById("notetaker-model-select").value;
  const language = document.getElementById("notetaker-lang-select").value;
  const diarize = document.getElementById("notetaker-diarize-check").checked;
  const numSpeakers = document.getElementById("notetaker-speakers-input").value;

  _ensureNotetakerSession();

  const fd = new FormData();
  fd.append("file", _ntUploadedFile);
  fd.append("language", language);
  fd.append("model", model);
  fd.append("diarize", diarize);
  if (numSpeakers) fd.append("num_speakers", numSpeakers);

  // Show progress card in canvas
  _ntProgressCard = _createGenProgress("notetaker");
  _ntProgressCard.el.classList.add("gen-progress-in");
  _ntProgressCard.setStatus("Transcribing...");
  _ntProgressCard.stopBtn.addEventListener("click", async () => {
    try { await mediaFetch("/notetaker/cancel", { method: "POST" }); } catch (_) {}
    showToast("Cancelling...", "info");
  });
  ntCanvasEmpty.style.display = "none";
  ntCanvas.style.display = "";
  ntCanvas.prepend(_ntProgressCard.el);
  document.getElementById("notetaker-transcribe-btn").disabled = true;
  _ntTranscribing = true;
  setVramAcquiring("notetaker", "Whisper");
  _startProgressPoll();

  try {
    const resp = await mediaFetch("/notetaker/transcribe", { method: "POST", body: fd });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: "Transcription failed" }));
      const detail = err.detail || "Transcription failed";
      const repoMatch = detail.match(/https:\/\/huggingface\.co\/[^\s]+/);
      if (resp.status === 403 && repoMatch) {
        showGatedRepoToast(repoMatch[0]);
        return;
      }
      throw new Error(detail);
    }

    const data = await resp.json();
    if (data.cancelled) {
      showToast("Transcription cancelled", "info");
      return;
    }

    // Auto-generate title
    let title = "Untitled Note";
    if (data.full_text) {
      try {
        const nameResp = await mediaFetch("/notetaker/name", {
          method: "POST",
          body: JSON.stringify({ transcript: data.full_text }),
        });
        if (nameResp.ok) {
          const nameData = await nameResp.json();
          if (nameData.name) title = nameData.name;
        }
      } catch (_) {}
    }

    // Save note
    const noteType = document.getElementById("notetaker-type-select").value;
    const customInstr = document.getElementById("notetaker-custom-instructions").value;
    const note = {
      id: data.note_id,
      session_id: activeNtSessionId,
      folder_id: activeNtFolderId,
      title,
      noteType,
      customInstructions: noteType === "custom" ? customInstr : "",
      source: _ntUploadedFile.name === "recording.webm" ? "recording" : "upload",
      fileName: _ntUploadedFile.name,
      audioUrl: data.audio_url,
      duration_s: data.duration_s,
      segments: data.segments,
      speakers: data.speakers,
      speakerNames: {},
      summary: "",
      language: data.language,
      model: data.model,
      elapsed_s: data.elapsed_s,
      timestamp: Date.now(),
    };

    await saveNote(note);
    _clearUploadedFile();

    _displayNote(note);
    renderNotetakerSessionsList();

    // Show completion state briefly
    if (_ntProgressCard) {
      _ntProgressCard.update(4, 4, Math.floor((Date.now() - _ntRecordStart) / 1000));
      _ntProgressCard.setStatus("Complete");
      await new Promise(r => setTimeout(r, 1000));
    }

  } catch (err) {
    showToast(err.message, "error");
  } finally {
    _ntTranscribing = false;
    clearVramAcquiring();
    _stopProgressPoll();
    if (_ntProgressCard) {
      _ntProgressCard.el.classList.add("gen-progress-out");
      setTimeout(() => { _ntProgressCard?.destroy(); _ntProgressCard = null; }, 300);
    }
    document.getElementById("notetaker-transcribe-btn").disabled = false;
  }
}

document.getElementById("notetaker-transcribe-btn").addEventListener("click", async () => {
  if (_ntCurrentNote && ntCanvas.querySelector(".nt-segment")) {
    const ok = await showConfirm({ title: "New Transcription", message: "This will overwrite the existing transcription. Continue?", okLabel: "Transcribe", okClass: "danger" });
    if (!ok) return;
  }
  _runFullTranscription();
});

// ── Progress polling ──

function _startProgressPoll() {
  _ntPollTimer = setInterval(async () => {
    try {
      const resp = await mediaFetch("/notetaker/progress");
      if (!resp.ok) return;
      const p = await resp.json();
      if (_ntProgressCard && p.running) {
        // Update bar progress
        if (p.total_steps > 0) {
          _ntProgressCard.update(p.step, p.total_steps, Math.floor(p.elapsed_s || 0));
        }
        // Override status with descriptive phase message
        if (p.message) {
          if (p.message.startsWith("GATED_REPO:")) {
            const repoUrl = p.message.slice(11);
            showGatedRepoToast(repoUrl);
            _ntProgressCard.setStatus("Speaker diarization unavailable");
          } else {
            _ntProgressCard.setStatus(p.message);
          }
        }
      }
    } catch (_) {}
  }, 1500);
}

function _stopProgressPoll() {
  if (_ntPollTimer) { clearInterval(_ntPollTimer); _ntPollTimer = null; }
}



// ── Summarize ──

document.getElementById("notetaker-summarize-btn").addEventListener("click", () => {
  if (ntSummaryPanel.classList.contains("open")) closeSummaryPanel();
  else openSummaryPanel();
});
document.getElementById("notetaker-summary-close").addEventListener("click", closeSummaryPanel);
document.getElementById("notetaker-gen-summary-btn").addEventListener("click", _generateSummary);

// Notetaker-scoped TTS params. Falls back to the chat panel's voice if
// the user hasn't configured a notetaker-specific voice yet, so summary
// playback keeps working without explicit setup.
function getNotetakerTtsParams() {
  const pick = (key, fallback) => {
    const v = localStorage.getItem(key);
    return v != null ? parseFloat(v) : fallback;
  };
  const chatTts = (typeof getChatTtsParams === "function") ? getChatTtsParams() : { voice: "tara", speed: 1.0, temperature: 0.6, top_p: 0.9 };
  return {
    voice:       localStorage.getItem("wooz_nt_tts_voice") || chatTts.voice,
    speed:       pick("wooz_nt_tts_speed", chatTts.speed),
    temperature: pick("wooz_nt_tts_temp",  chatTts.temperature),
    top_p:       pick("wooz_nt_tts_top_p", chatTts.top_p),
  };
}

const _ntTtsSummaryBtn = document.getElementById("notetaker-tts-summary-btn");

// Notetaker treats tts as on-demand: summary playback explicitly acquires
// the supervisor and releases it on stop/end so Orpheus doesn't linger in
// VRAM after the user walks away from a long transcription.
async function _ntReleaseTts() {
  try {
    await fetch(GPU_API + "/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "tts" }),
    });
  } catch {}
}

_ntTtsSummaryBtn.addEventListener("click", async () => {
  if (_ntTtsSummaryBtn.classList.contains("playing")) {
    stopSpeaking();
    _ntReleaseTts();
    return;
  }
  const raw = _ntCurrentNote?.summary;
  if (!raw) return;
  // Strip markdown syntax for clean TTS
  const text = raw
    .replace(/^#{1,6}\s+/gm, "")      // headings
    .replace(/\*\*(.+?)\*\*/g, "$1")   // bold
    .replace(/\*(.+?)\*/g, "$1")       // italic
    .replace(/^[-*]\s+/gm, "")         // bullet lists
    .replace(/^\d+\.\s+/gm, "")        // numbered lists
    .replace(/`(.+?)`/g, "$1")         // inline code
    .replace(/\[(.+?)\]\(.+?\)/g, "$1") // links
    .replace(/\n{2,}/g, "\n")          // collapse blank lines
    .trim();
  if (!text) return;
  // Acquire tts up-front so a 409 surfaces as a toast BEFORE we kick off
  // speakText (which would otherwise error out opaquely mid-stream).
  try {
    const resp = await fetch(GPU_API + "/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "tts" }),
    });
    if (resp.status === 409) {
      let detail = "TTS unavailable: insufficient VRAM";
      try { const j = await resp.json(); if (j && j.detail) detail = j.detail; } catch {}
      if (typeof showToast === "function") showToast(detail, "error");
      return;
    }
    if (!resp.ok) {
      if (typeof showToast === "function") showToast("TTS unavailable", "error");
      return;
    }
  } catch {
    if (typeof showToast === "function") showToast("TTS unreachable", "error");
    return;
  }
  const tts = getNotetakerTtsParams();
  try {
    await speakText(text, tts.voice, _ntTtsSummaryBtn, {
      temperature: tts.temperature, top_p: tts.top_p, speed: tts.speed,
    });
  } finally {
    _ntReleaseTts();
  }
});

function _renderSummaryWithDate(note) {
  const ts = note.timestamp ? formatStudioTimestamp(note.timestamp) : "";
  const title = note.title || "";
  const duration = note.duration_s ? _fmtDuration(Math.round(note.duration_s)) : "";
  let header = "";
  const pillType = note.detectedType || note.noteType;
  if (ts || title || duration || pillType) {
    const meta = [ts, duration ? duration : ""].filter(Boolean).join(" - ");
    const typePill = pillType ? `<span class="nt-type-pill">${esc(pillType)}</span>` : "";
    header = `<div class="nt-summary-header-info">`
      + (title ? `<div class="nt-summary-title">${esc(title)}${typePill}</div>` : typePill)
      + (meta ? `<div class="nt-summary-meta">${esc(meta)}</div>` : "")
      + `</div>`;
  }
  return header + renderMarkdown(note.summary);
}

async function _generateSummary() {
  if (!_ntCurrentNote || !_ntCurrentNote.segments?.length) return;

  const noteType = document.getElementById("notetaker-type-select").value;
  const customInstr = document.getElementById("notetaker-custom-instructions").value;

  const transcript = _ntCurrentNote.segments.map(s => {
    const name = (_ntCurrentNote.speakerNames && _ntCurrentNote.speakerNames[s.speaker]) || s.speaker;
    return `${name}: ${s.text}`;
  }).join("\n");

  ntSummaryEmpty.style.display = "none";
  ntSummaryText.style.display = "";
  ntSummaryText.innerHTML = "<p style=\"color:var(--text-dim)\"><span class=\"step-spinner\" style=\"display:inline-block;vertical-align:-2px;margin-right:8px;\"></span>Generating summary...</p>";
  openSummaryPanel();

  try {
    const resp = await mediaFetch("/notetaker/summarize", {
      method: "POST",
      body: JSON.stringify({
        transcript,
        note_type: noteType,
        custom_instructions: noteType === "custom" ? customInstr : "",
        summary_model: localStorage.getItem("wooz_notetaker_summary_model") || undefined,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: "Summary failed" }));
      throw new Error(err.detail || "Summary generation failed");
    }

    const data = await resp.json();
    _ntCurrentNote.summary = data.summary;
    _ntCurrentNote.noteType = data.note_type || noteType;
    _ntCurrentNote.detectedType = data.detected_type || null;
    if (noteType === "custom") _ntCurrentNote.customInstructions = customInstr;
    await saveNote(_ntCurrentNote);

    ntSummaryText.innerHTML = _renderSummaryWithDate(_ntCurrentNote);
  } catch (err) {
    ntSummaryText.innerHTML = "<p style=\"color:var(--text-dim)\">Failed to generate summary.</p>";
    showToast(err.message, "error");
  }
}

// ── Note type selector ──

document.getElementById("notetaker-type-select").addEventListener("change", e => {
  const customRow = document.getElementById("notetaker-custom-instructions-row");
  customRow.style.display = e.target.value === "custom" ? "" : "none";
});

// ── Markdown export ──

function _buildNoteMarkdown(note) {
  if (!note) return "";
  const names = note.speakerNames || {};
  let md = `# ${note.title || "Untitled Note"}\n\n`;
  md += `**Date:** ${new Date(note.timestamp).toLocaleDateString()}\n`;
  md += `**Duration:** ${_fmtDuration(note.duration_s || 0)}\n`;
  if (note.speakers?.length) {
    md += `**Speakers:** ${note.speakers.map(s => names[s] || s).join(", ")}\n`;
  }
  md += "\n---\n\n## Transcript\n\n";
  const segs = note.segments || [];
  const mdBlocks = [];
  for (const seg of segs) {
    const prev = mdBlocks[mdBlocks.length - 1];
    if (prev && prev.speaker === seg.speaker) {
      prev.texts.push(seg.text);
    } else {
      mdBlocks.push({ speaker: seg.speaker, start: seg.start, texts: [seg.text] });
    }
  }
  for (const b of mdBlocks) {
    const name = names[b.speaker] || b.speaker;
    md += `**${name}** *(${_fmtTime(b.start)})*\n${b.texts.join(" ")}\n\n`;
  }
  if (note.summary) {
    md += `---\n\n${note.summary}\n`;
  }
  return md;
}

document.getElementById("notetaker-copy-md-btn").addEventListener("click", () => {
  if (!_ntCurrentNote) return;
  navigator.clipboard.writeText(_buildNoteMarkdown(_ntCurrentNote));
  showToast("Copied as Markdown", "success");
});

document.getElementById("notetaker-export-md-btn").addEventListener("click", () => {
  if (!_ntCurrentNote) return;
  const md = _buildNoteMarkdown(_ntCurrentNote);
  const blob = new Blob([md], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(_ntCurrentNote.title || "meeting-notes").replace(/\s+/g, "-").toLowerCase()}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// Copy summary
function _summaryMarkdownWithHeader() {
  if (!_ntCurrentNote?.summary) return "";
  const title = _ntCurrentNote.title || "";
  const ts = _ntCurrentNote.timestamp ? formatStudioTimestamp(_ntCurrentNote.timestamp) : "";
  const duration = _ntCurrentNote.duration_s ? _fmtDuration(Math.round(_ntCurrentNote.duration_s)) : "";
  const meta = [ts, duration].filter(Boolean).join(" - ");
  let header = "";
  if (title) header += `# ${title}\n`;
  if (meta) header += `${meta}\n`;
  if (header) header += "\n";
  return header + _ntCurrentNote.summary;
}

document.getElementById("notetaker-copy-summary-btn").addEventListener("click", () => {
  const text = _summaryMarkdownWithHeader();
  if (text) {
    navigator.clipboard.writeText(text);
    showToast("Summary copied", "success");
  }
});

// Download summary
document.getElementById("notetaker-download-summary-btn").addEventListener("click", () => {
  const text = _summaryMarkdownWithHeader();
  if (!text) return;
  const blob = new Blob([text], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(_ntCurrentNote.title || "summary").replace(/\s+/g, "-").toLowerCase()}-summary.md`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ── Trash ──

async function _refreshNotetakerTrashBadge() {
  const items = await loadAllNtTrash();
  updateBadge("notetaker-trash-badge", items.length);
}

const _ntTrashBtn = document.getElementById("notetaker-trash-btn");
if (_ntTrashBtn) _ntTrashBtn.addEventListener("click", () => _openNtTrashModal());

async function _openNtTrashModal() {
  await purgeOldTrash(loadAllNtTrash, deleteFromNtTrash);
  document.getElementById("shared-trash-modal").classList.add("open");
  await _renderNtTrashList();
  document.getElementById("shared-trash-empty-btn").onclick = async () => {
    const count = document.querySelectorAll("#shared-trash-content .studio-trash-card").length;
    if (!count) return;
    if (!confirm(`Permanently delete ${count} note${count !== 1 ? "s" : ""} from trash?`)) return;
    // Delete server-side audio for all trashed items
    const items = await loadAllNtTrash();
    for (const item of items) {
      try { await mediaFetch("/notetaker/audio/" + item.id, { method: "DELETE" }); } catch (_) {}
    }
    await emptyNtTrash();
    _refreshNotetakerTrashBadge();
    document.getElementById("shared-trash-modal").classList.remove("open");
  };
}

async function _renderNtTrashList() {
  const list = document.getElementById("shared-trash-content");
  list.style.cssText = "display:flex; flex-direction:column;";
  const countLabel = document.getElementById("shared-trash-count");
  const items = (await loadAllNtTrash()).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  list.innerHTML = "";
  countLabel.textContent = items.length ? `${items.length} note${items.length !== 1 ? "s" : ""}` : "";
  _refreshNotetakerTrashBadge();

  for (const item of items) {
    const card = document.createElement("div");
    card.className = "studio-trash-card";
    card.innerHTML = `<div class="studio-trash-card-info"><div class="studio-trash-card-prompt">${esc(item.title || "Untitled Note")}</div><div class="studio-trash-card-meta">${trashAge(item.deletedAt)}</div></div><div class="studio-trash-card-actions"><button class="studio-trash-restore" title="Restore">Restore</button><button class="studio-trash-del" title="Delete permanently">Delete</button></div>`;
    card.querySelector(".studio-trash-restore").addEventListener("click", async () => {
      delete item.deletedAt;
      await saveNote(item);
      await deleteFromNtTrash(item.id);
      await _renderNtTrashList();
      restoreNotes();
      renderNotetakerSessionsList();
    });
    card.querySelector(".studio-trash-del").addEventListener("click", async () => {
      try { await mediaFetch("/notetaker/audio/" + item.id, { method: "DELETE" }); } catch (_) {}
      await deleteFromNtTrash(item.id);
      await _renderNtTrashList();
    });
    list.appendChild(card);
  }
}

// ── Settings toggle ──

wireSettingsToggle("notetaker-settings-trigger", "notetaker-settings-crumb", "notetaker-settings-panel");

// Collapsible Voice section inside the notetaker settings panel.
(() => {
  const t = document.getElementById("nt-voice-toggle");
  const b = document.getElementById("nt-voice-body");
  if (!t || !b) return;
  t.addEventListener("click", () => {
    t.classList.toggle("open");
    b.classList.toggle("open");
  });
})();

// Notetaker-scoped TTS knob wiring. Values are persisted to individual
// wooz_nt_tts_* localStorage keys and picked up by getNotetakerTtsParams().
(() => {
  const spd  = document.getElementById("nt-tts-speed-slider");
  const spdV = document.getElementById("nt-tts-speed-val");
  const tmp  = document.getElementById("nt-tts-temp-slider");
  const tmpV = document.getElementById("nt-tts-temp-val");
  const tpp  = document.getElementById("nt-tts-topp-slider");
  const tppV = document.getElementById("nt-tts-topp-val");
  const voi  = document.getElementById("nt-voice-select");
  if (!spd || !tmp || !tpp) return;
  // Hydrate from localStorage.
  const savedSpd = localStorage.getItem("wooz_nt_tts_speed");
  const savedTmp = localStorage.getItem("wooz_nt_tts_temp");
  const savedTpp = localStorage.getItem("wooz_nt_tts_top_p");
  if (savedSpd != null) spd.value = savedSpd;
  if (savedTmp != null) tmp.value = savedTmp;
  if (savedTpp != null) tpp.value = savedTpp;
  const updateLabels = () => {
    if (spdV) spdV.textContent = parseFloat(spd.value).toFixed(2) + "x";
    if (tmpV) tmpV.textContent = parseFloat(tmp.value).toFixed(2);
    if (tppV) tppV.textContent = parseFloat(tpp.value).toFixed(2);
  };
  updateLabels();
  spd.addEventListener("input", () => {
    localStorage.setItem("wooz_nt_tts_speed", spd.value);
    updateLabels();
    if (typeof scheduleSettingsSync === "function") scheduleSettingsSync();
  });
  tmp.addEventListener("input", () => {
    localStorage.setItem("wooz_nt_tts_temp", tmp.value);
    updateLabels();
    if (typeof scheduleSettingsSync === "function") scheduleSettingsSync();
  });
  tpp.addEventListener("input", () => {
    localStorage.setItem("wooz_nt_tts_top_p", tpp.value);
    updateLabels();
    if (typeof scheduleSettingsSync === "function") scheduleSettingsSync();
  });
  voi?.addEventListener("change", () => {
    localStorage.setItem("wooz_nt_tts_voice", voi.value);
    const d = document.getElementById("nt-voice-desc");
    if (d && typeof _describeVoice === "function") d.textContent = _describeVoice(voi.value);
    if (typeof scheduleSettingsSync === "function") scheduleSettingsSync();
  });
})();
makePanelResizable("notetaker-summary-panel", "notetaker-summary-resize-handle", "wooz_nt_summary_w", 420, 300, 2000);

// ── Sidebar click handlers ──

function toggleNotetaker() {
  const ntView = document.getElementById("notetaker-view");
  if (ntView && ntView.classList.contains("active")) return;
  showNotetaker();
}

document.getElementById("notetaker-sidebar-btn").addEventListener("click", toggleNotetaker);
document.getElementById("strip-notetaker-btn").addEventListener("click", toggleNotetaker);

document.getElementById("notetaker-new-session-btn").addEventListener("click", () => {
  activeNtSessionId = _newNtSessionId();
  localStorage.setItem("wooz_nt_session", activeNtSessionId);
  document.querySelectorAll(".nt-session-item").forEach(el => el.classList.remove("active"));
  ntCanvas.innerHTML = "";
  ntCanvas.style.display = "none";
  ntCanvasEmpty.style.display = "";
  ntPlayer.style.display = "none";
  ntPlayer.classList.remove("visible");
  closeSummaryPanel();
  _ntCurrentNote = null;
  _clearUploadedFile();
  document.getElementById("notetaker-summarize-btn").style.display = "none";
  renderNotetakerSessionsList();
});

// ── Formatting helpers ──

function _fmtTime(seconds) {
  const s = Math.floor(seconds || 0);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return m + ":" + String(ss).padStart(2, "0");
}

function _fmtDuration(seconds) {
  const s = Math.floor(seconds || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
  return m + ":" + String(ss).padStart(2, "0");
}

// ── Init: auto-purge old trash ──
purgeOldTrash(loadAllNtTrash, deleteFromNtTrash);
