// ══════════════════════════════════════════════════════════════
// VIDEO STUDIO
// ══════════════════════════════════════════════════════════════

const videoStudio = document.getElementById("video-studio");
const videoCanvas = document.getElementById("video-canvas");
const videoCanvasEmpty = document.getElementById("video-canvas-empty");
const videoPrompt = document.getElementById("video-prompt");
const videoGenerateBtn = document.getElementById("video-generate-btn");
const videoFavPanel = document.getElementById("video-fav-panel");
const videoFavToggle = document.getElementById("video-fav-toggle");
const videoFavContent = document.getElementById("video-fav-content");
const videoFavBadge = document.getElementById("video-fav-badge");
const videoFavCountLabel = document.getElementById("video-fav-count-label");

let _videoGenerating = false;
let _videoStartingImage = null; // base64 for I2V

// ── Video IndexedDB (via factory) ──
const _videoDB = createStudioDB({
  name: "diab_video", version: 2,
  stores: ["videos", "favorites", "trash", "folders"],
});
function openVideoDB()                  { return _videoDB.open(); }
async function saveVideoClip(record)    { return _videoDB.save("videos", record); }
async function loadAllVideoClips()      { return _videoDB.loadAll("videos"); }
async function deleteVideoClip(id)      { return _videoDB.remove("videos", id); }
async function saveVideoFavorite(rec)   { return _videoDB.save("favorites", rec); }
async function deleteVideoFavorite(id)  { return _videoDB.remove("favorites", id); }
async function loadAllVideoFavorites()  { return _videoDB.loadAll("favorites"); }
async function isVideoFavorite(id)      { return _videoDB.has("favorites", id); }
async function saveVideoToTrash(record) { return _videoDB.save("trash", { ...record, deletedAt: Date.now() }); }
async function loadAllVideoTrash()      { return _videoDB.loadAll("trash"); }
async function deleteFromVideoTrash(id) { return _videoDB.remove("trash", id); }
async function emptyVideoTrash()        { return _videoDB.clear("trash"); }
async function saveVideoFolder(col)     { return _videoDB.save("folders", col); }
async function deleteVideoFolder(id)    { return _videoDB.remove("folders", id); }
async function loadAllVideoFolders()    { return _videoDB.loadAll("folders"); }

// ── Video sessions & folders ──
let videoFolders = [];
let activeVideoFolderId = localStorage.getItem("diab_video_folder") || null;
let activeVideoSessionId = localStorage.getItem("diab_video_session") || null;

function _newVideoSessionId() {
  const arr = new Uint8Array(12);
  crypto.getRandomValues(arr);
  return "vsess_" + Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
}

function _ensureVideoSession() {
  if (!activeVideoSessionId) {
    activeVideoSessionId = _newVideoSessionId();
    localStorage.setItem("diab_video_session", activeVideoSessionId);
  }
}

async function _getVideoSessions() {
  const clips = await loadAllVideoClips();
  const map = {};
  for (const c of clips) {
    const clipFolder = c.folder_id || (videoFolders.length ? videoFolders[0].id : null);
    if (activeVideoFolderId && clipFolder !== activeVideoFolderId) continue;
    const sid = c.session_id || "default";
    if (!map[sid]) map[sid] = { id: sid, clips: [], title: null, ts: 0 };
    map[sid].clips.push(c);
    if (c.timestamp > map[sid].ts) { map[sid].ts = c.timestamp; map[sid].title = c.title || null; }
  }
  return Object.values(map).sort((a, b) => b.ts - a.ts);
}

async function renderVideoSessionsList() {
  const list = document.getElementById("video-sessions-list");
  if (!list) return;
  const sessions = await _getVideoSessions();
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
    row.className = "sidebar-row video-session-item" + (s.id === activeVideoSessionId ? " active" : "");
    const label = s.title || s.clips[0]?.rawPrompt?.slice(0, 40) || "Untitled";
    const count = s.clips.length;
    row.innerHTML = `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.82rem;">${esc(label)}</span><span style="font-size:0.68rem;color:var(--text-dim);flex-shrink:0;">${count}</span>`;
    row.addEventListener("click", () => {
      activeVideoSessionId = s.id;
      localStorage.setItem("diab_video_session", s.id);
      restoreVideoClips();
      renderVideoSessionsList();
    });
    list.appendChild(row);
  }
}

async function loadVideoFolders() {
  videoFolders = await loadAllVideoFolders();
  if (videoFolders.length === 0) {
    const defaultCol = { id: "vfolder_" + Date.now(), name: "My Videos", description: "Default folder for generated videos", timestamp: Date.now() };
    await saveVideoFolder(defaultCol);
    videoFolders = [defaultCol];
  }
  if (!activeVideoFolderId || !videoFolders.find(c => c.id === activeVideoFolderId)) {
    activeVideoFolderId = videoFolders[0].id;
    localStorage.setItem("diab_video_folder", activeVideoFolderId);
  }
  renderVideoFoldersSidebar();
}

function renderVideoFoldersSidebar() {
  const listEl = document.getElementById("video-folders-list");
  if (!listEl) return;
  listEl.innerHTML = "";
  for (const col of videoFolders) {
    const row = document.createElement("div");
    row.className = "sb-folder-row" + (activeVideoFolderId === col.id ? " active" : "");
    row.dataset.id = col.id;
    const iconSvg = `<svg class="sb-folder-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 3.5C1.5 2.948 1.948 2.5 2.5 2.5H6.086a1 1 0 0 1 .707.293L7.914 3.914A1 1 0 0 0 8.621 4.2H13.5c.552 0 1 .448 1 1v7.3c0 .552-.448 1-1 1h-11c-.552 0-1-.448-1-1V3.5z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>`;
    row.innerHTML = `${iconSvg}<div class="sb-folder-info"><div class="sb-folder-name">${esc(col.name)}</div>${col.description ? `<div class="sb-folder-desc">${esc(col.description)}</div>` : ""}</div><button class="sb-folder-menu" title="Options">⋯</button>`;
    row.addEventListener("click", e => {
      if (e.target.classList.contains("sb-folder-menu")) return;
      if (col.id === activeVideoFolderId) return;
      activeVideoFolderId = col.id;
      localStorage.setItem("diab_video_folder", col.id);
      renderVideoFoldersSidebar();
      renderVideoSessionsList();
      restoreVideoClips();
    });
    row.querySelector(".sb-folder-menu").addEventListener("click", e => {
      e.stopPropagation();
      showVideoFolderCtxMenu(col, e);
    });
    // Drag-and-drop target for video sessions
    row.addEventListener("dragover", e => {
      if (!e.dataTransfer.types.includes("text/video-session")) return;
      e.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", async e => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const sid = e.dataTransfer.getData("text/video-session");
      if (!sid) return;
      try {
        const allClips = await loadAllVideoClips();
        const matching = allClips.filter(r => (r.session_id || "default") === sid);
        if (!matching.length) return;
        const db = await openVideoDB();
        const tx = db.transaction("videos", "readwrite");
        const store = tx.objectStore("videos");
        for (const rec of matching) {
          rec.folder_id = col.id;
          store.put(rec);
        }
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
        renderVideoSessionsList();
      } catch (err) { console.warn("Failed to move video session:", err); }
    });
    listEl.appendChild(row);
  }
}

function showVideoFolderCtxMenu(col, e) {
  document.querySelectorAll(".video-folder-ctx-menu").forEach(el => el.remove());
  const menu = document.createElement("div");
  menu.className = "video-folder-ctx-menu";
  menu.style.cssText = `position:fixed;z-index:999;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,0.4);min-width:120px;`;
  menu.innerHTML = `
    <div class="video-folder-ctx-item" data-action="rename" style="padding:6px 12px;cursor:pointer;font-size:0.8rem;border-radius:6px;color:var(--text-dim);">Edit</div>
    <div class="video-folder-ctx-item" data-action="delete" style="padding:6px 12px;cursor:pointer;font-size:0.8rem;border-radius:6px;color:var(--danger);">Delete</div>
  `;
  menu.style.left = e.clientX + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - 80) + "px";
  document.body.appendChild(menu);
  menu.querySelector('[data-action="rename"]').addEventListener("click", () => {
    menu.remove();
    const newName = prompt("Rename folder:", col.name);
    if (!newName?.trim()) return;
    col.name = newName.trim();
    saveVideoFolder(col).then(() => renderVideoFoldersSidebar());
  });
  menu.querySelector('[data-action="delete"]').addEventListener("click", async () => {
    menu.remove();
    if (videoFolders.length <= 1) { showToast("At least one folder must exist."); return; }
    const confirmed = await showConfirm({ title: "Delete Folder", message: `Delete "${col.name}"? All videos will be deleted.` });
    if (!confirmed) return;
    const allClips = await loadAllVideoClips();
    const toDelete = allClips.filter(r => r.folder_id === col.id);
    for (const clip of toDelete) { await deleteVideoClip(clip.id); }
    await deleteVideoFolder(col.id);
    videoFolders = videoFolders.filter(c => c.id !== col.id);
    if (activeVideoFolderId === col.id) {
      activeVideoFolderId = videoFolders[0].id;
      localStorage.setItem("diab_video_folder", activeVideoFolderId);
    }
    renderVideoFoldersSidebar();
    activeVideoSessionId = null;
    localStorage.removeItem("diab_video_session");
    restoreVideoClips();
    renderVideoSessionsList();
  });
  menu.querySelectorAll(".video-folder-ctx-item").forEach(item => {
    item.addEventListener("mouseenter", () => item.style.background = "var(--surface2)");
    item.addEventListener("mouseleave", () => item.style.background = "");
  });
  setTimeout(() => {
    const handler = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("click", handler); } };
    document.addEventListener("click", handler);
  });
}

document.getElementById("video-folder-new-btn").addEventListener("click", async () => {
  const name = prompt("Folder name:");
  if (!name?.trim()) return;
  const col = { id: "vfolder_" + Date.now(), name: name.trim(), timestamp: Date.now() };
  await saveVideoFolder(col);
  videoFolders.push(col);
  activeVideoFolderId = col.id;
  localStorage.setItem("diab_video_folder", col.id);
  renderVideoFoldersSidebar();
  activeVideoSessionId = null;
  localStorage.removeItem("diab_video_session");
  restoreVideoClips();
  renderVideoSessionsList();
});

// ── Video view switching ──
function toggleVideoStudio() {
  if (videoStudio.classList.contains("active")) return;
  showVideoStudio();
}
document.getElementById("video-sidebar-btn").addEventListener("click", toggleVideoStudio);
document.getElementById("strip-video-btn").addEventListener("click", toggleVideoStudio);
document.getElementById("video-new-session-btn").addEventListener("click", () => {
  activeVideoSessionId = _newVideoSessionId();
  localStorage.setItem("diab_video_session", activeVideoSessionId);
  document.querySelectorAll(".video-session-item").forEach(el => el.classList.remove("active"));
  videoCanvas.querySelectorAll(".video-result").forEach(el => el.remove());
  if (videoCanvasEmpty) videoCanvasEmpty.style.display = "";
  videoPrompt.focus();
});

// ── Video settings panel ──
document.getElementById("video-settings-trigger").addEventListener("click", function() {
  document.getElementById("video-settings-crumb").classList.toggle("open");
  document.getElementById("video-settings-panel").classList.toggle("open");
});

document.getElementById("video-advanced-toggle").addEventListener("click", function() {
  this.classList.toggle("open");
  document.getElementById("video-advanced-body").classList.toggle("open");
});

// Slider value displays
document.getElementById("video-frames").addEventListener("input", function() {
  const fps = parseInt(document.getElementById("video-fps").value) || 24;
  const dur = (parseInt(this.value) / fps).toFixed(1);
  document.getElementById("video-frames-val").textContent = `${this.value} (~${dur}s)`;
  _updateVideoSettingsSummary();
});
document.getElementById("video-steps").addEventListener("input", function() {
  document.getElementById("video-steps-val").textContent = this.value;
});
document.getElementById("video-guidance").addEventListener("input", function() {
  document.getElementById("video-guidance-val").textContent = parseFloat(this.value).toFixed(1);
});
document.getElementById("video-fps").addEventListener("change", function() {
  const frames = parseInt(document.getElementById("video-frames").value) || 97;
  const dur = (frames / parseInt(this.value)).toFixed(1);
  document.getElementById("video-frames-val").textContent = `${frames} (~${dur}s)`;
  _updateVideoSettingsSummary();
});
document.getElementById("video-resolution").addEventListener("change", function() {
  const slider = document.getElementById("video-frames");
  const res = this.value;
  if (res === "1280x704") {
    slider.max = 161;
    if (parseInt(slider.value) > 161) slider.value = 161;
  } else {
    slider.max = 257;
  }
  slider.dispatchEvent(new Event("input"));
  _updateVideoSettingsSummary();
});

function _updateVideoSettingsSummary() {
  const res = document.getElementById("video-resolution").value;
  const frames = document.getElementById("video-frames").value;
  const fps = document.getElementById("video-fps").value;
  const dur = (parseInt(frames) / parseInt(fps)).toFixed(1);
  document.getElementById("video-settings-summary").textContent = `${res} · ${frames} frames · ~${dur}s`;
}

document.getElementById("video-random-seed").addEventListener("click", () => {
  document.getElementById("video-seed").value = "";
});

// ── I2V image upload ──
const videoI2VDropzone = document.getElementById("video-i2v-dropzone");
const videoI2VInput = document.getElementById("video-i2v-input");
const videoI2VPreview = document.getElementById("video-i2v-preview");
const videoI2VLabel = document.getElementById("video-i2v-label");
const videoI2VRemove = document.getElementById("video-i2v-remove");

function _handleVideoI2VFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    _videoStartingImage = e.target.result.split(",")[1]; // base64 without prefix
    videoI2VPreview.src = e.target.result;
    videoI2VPreview.style.display = "block";
    videoI2VLabel.style.display = "none";
    videoI2VRemove.style.display = "flex";
  };
  reader.readAsDataURL(file);
}

videoI2VDropzone.addEventListener("click", (e) => {
  if (e.target === videoI2VRemove || e.target.closest(".remove-img")) return;
  videoI2VInput.click();
});
videoI2VInput.addEventListener("change", () => {
  if (videoI2VInput.files[0]) _handleVideoI2VFile(videoI2VInput.files[0]);
});
videoI2VDropzone.addEventListener("dragover", (e) => { e.preventDefault(); videoI2VDropzone.classList.add("dragover"); });
videoI2VDropzone.addEventListener("dragleave", () => videoI2VDropzone.classList.remove("dragover"));
videoI2VDropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  videoI2VDropzone.classList.remove("dragover");
  if (e.dataTransfer.files[0]) _handleVideoI2VFile(e.dataTransfer.files[0]);
});
videoI2VRemove.addEventListener("click", (e) => {
  e.stopPropagation();
  _videoStartingImage = null;
  videoI2VPreview.style.display = "none";
  videoI2VLabel.style.display = "";
  videoI2VRemove.style.display = "none";
  videoI2VInput.value = "";
});

// ── Inspire button ──
document.getElementById("video-suggest-btn").addEventListener("click", async () => {
  try {
    const res = await mediaFetch("/video/inspire");
    const data = await res.json();
    if (data.prompt) videoPrompt.value = data.prompt;
  } catch (e) {
    showToast("Could not generate suggestion");
  }
});

// ── Create video result card ──
function createVideoResultCard(record) {
  const el = document.createElement("div");
  el.className = "video-result";
  el.dataset.videoId = record.id;

  // Decode base64 video to blob
  const rawB64 = record.video;
  const byteStr = atob(rawB64);
  const bytes = new Uint8Array(byteStr.length);
  for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
  const blob = new Blob([bytes], { type: "video/mp4" });
  const blobUrl = URL.createObjectURL(blob);

  const pills = [];
  if (record.model) pills.push(record.model);
  if (record.duration) pills.push(record.duration + "s");
  if (record.width && record.height) pills.push(record.width + "x" + record.height);
  if (record.body?.num_frames) pills.push(record.body.num_frames + " frames");
  if (record.body?.num_inference_steps) pills.push(record.body.num_inference_steps + " steps");
  if (record.elapsed_s) pills.push(record.elapsed_s + "s gen");
  if (record.has_audio) pills.push("audio");
  if (record.seed != null) pills.push("seed: " + record.seed);

  const title = record.title || record.rawPrompt?.slice(0, 50) || "Untitled";
  const promptText = record.rawPrompt || "";

  el.innerHTML = `
    <div class="video-result-cover">
      <video src="${blobUrl}" controls preload="metadata"></video>
    </div>
    <div class="video-result-body">
      <div class="video-result-title">${esc(title)}</div>
      <div class="video-result-prompt" title="${esc(promptText)}">${esc(promptText)}</div>
      <div class="video-result-pills">${pills.map(p => `<span>${esc(p)}</span>`).join("")}</div>
      <div class="video-result-actions">
        <button class="music-action-btn video-fav-btn" title="Favorite">
          ${icon("heart")}
        </button>
        <button class="music-action-btn video-reuse-btn" title="Reuse settings">
          ${icon("refresh", 12)}
        </button>
        <button class="music-action-btn video-download-btn" title="Download">
          ${icon("download", 12)}
        </button>
        <button class="music-action-btn video-delete-btn" title="Delete">
          ${icon("trash-simple", 12)}
        </button>
      </div>
    </div>
  `;

  // Favorite button
  const favBtn = el.querySelector(".video-fav-btn");
  isVideoFavorite(record.id).then(fav => {
    if (fav) { favBtn.classList.add("active"); favBtn.querySelector("svg").setAttribute("fill", "#f472b6"); }
  });
  favBtn.addEventListener("click", async () => {
    const isFav = favBtn.classList.contains("active");
    if (isFav) {
      await deleteVideoFavorite(record.id);
      favBtn.classList.remove("active");
      favBtn.querySelector("svg").setAttribute("fill", "none");
    } else {
      await saveVideoFavorite(record);
      favBtn.classList.add("active");
      favBtn.querySelector("svg").setAttribute("fill", "#f472b6");
    }
    refreshVideoFavoritesPanel();
    _updateVideoFavBadge();
  });

  // Reuse button
  el.querySelector(".video-reuse-btn").addEventListener("click", () => {
    if (record.rawPrompt) videoPrompt.value = record.rawPrompt;
    if (record.body) {
      const b = record.body;
      if (b.width && b.height) document.getElementById("video-resolution").value = b.width + "x" + b.height;
      if (b.num_frames) { document.getElementById("video-frames").value = b.num_frames; document.getElementById("video-frames").dispatchEvent(new Event("input")); }
      if (b.num_inference_steps) { document.getElementById("video-steps").value = b.num_inference_steps; document.getElementById("video-steps").dispatchEvent(new Event("input")); }
      if (b.guidance_scale) { document.getElementById("video-guidance").value = b.guidance_scale; document.getElementById("video-guidance").dispatchEvent(new Event("input")); }
      if (b.fps) document.getElementById("video-fps").value = b.fps;
      if (b.seed) document.getElementById("video-seed").value = b.seed;
    }
    videoPrompt.focus();
  });

  // Download button
  el.querySelector(".video-download-btn").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = (record.title || "video").replace(/[^a-zA-Z0-9_-]/g, "_") + ".mp4";
    a.click();
  });

  // Delete button
  el.querySelector(".video-delete-btn").addEventListener("click", async () => {
    await saveVideoToTrash(record);
    await deleteVideoClip(record.id);
    el.remove();
    if (!videoCanvas.querySelector(".video-result")) videoCanvasEmpty.style.display = "";
    renderVideoSessionsList();
    _refreshVideoTrashBadge();
  });

  return el;
}

// ── Restore video clips for active session ──
async function restoreVideoClips() {
  videoCanvas.querySelectorAll(".video-result").forEach(el => el.remove());
  const clips = await loadAllVideoClips();
  const sessionClips = clips
    .filter(c => c.session_id === activeVideoSessionId)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (sessionClips.length) {
    videoCanvasEmpty.style.display = "none";
    for (const c of sessionClips) {
      videoCanvas.appendChild(createVideoResultCard(c));
    }
  } else {
    videoCanvasEmpty.style.display = "";
  }
}

// ── Video generation ──
async function videoGenerate() {
  if (_videoGenerating) return;
  const rawPrompt = videoPrompt.value.trim();
  if (!rawPrompt) return;
  if (!_modelReady.video) {
    showToast("Video model is loading, please wait...");
    return;
  }

  _ensureVideoSession();
  _videoGenerating = true;
  videoGenerateBtn.disabled = true;

  // Read settings
  const resParts = document.getElementById("video-resolution").value.split("x");
  const width = parseInt(resParts[0]);
  const height = parseInt(resParts[1]);
  const numFrames = parseInt(document.getElementById("video-frames").value);
  const steps = parseInt(document.getElementById("video-steps").value);
  const guidance = parseFloat(document.getElementById("video-guidance").value);
  const fps = parseInt(document.getElementById("video-fps").value);
  const seedInput = document.getElementById("video-seed").value.trim();
  const seed = seedInput ? parseInt(seedInput) : null;

  const body = {
    prompt: rawPrompt,
    num_frames: numFrames,
    height,
    width,
    fps,
    num_inference_steps: steps,
    guidance_scale: guidance,
    seed,
  };
  if (_videoStartingImage) body.image = _videoStartingImage;

  // Create shared progress component
  const progress = _createGenProgress();
  videoCanvasEmpty.style.display = "none";
  videoCanvas.appendChild(progress.el);
  videoCanvas.scrollTop = videoCanvas.scrollHeight;

  let aborted = false;
  const abortCtrl = new AbortController();
  progress.stopBtn.addEventListener("click", () => { aborted = true; mediaFetch("/video/cancel", { method: "POST" }).catch(() => {}); abortCtrl.abort(); });

  // Progress polling
  const progressInterval = setInterval(async () => {
    try {
      const res = await mediaFetch("/video/progress");
      const p = await res.json();
      if (p.running && p.total_steps > 0) {
        progress.update(p.step, p.total_steps, p.elapsed_s || 0);
      }
    } catch {}
  }, 500);

  try {
    const res = await mediaFetch("/video/generate", {
      method: "POST",
      body: JSON.stringify(body),
      signal: abortCtrl.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    const data = await res.json();

    const record = {
      id: "video_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      session_id: activeVideoSessionId,
      folder_id: activeVideoFolderId || null,
      rawPrompt,
      title: null,
      body,
      video: data.video,
      width: data.width,
      height: data.height,
      num_frames: data.num_frames,
      fps: data.fps,
      duration: data.duration,
      has_audio: data.has_audio,
      elapsed_s: data.elapsed_s,
      model: data.model,
      seed: data.seed,
      timestamp: Date.now(),
    };

    await saveVideoClip(record);
    const card = createVideoResultCard(record);
    progress.el.replaceWith(card);
    videoCanvas.scrollTop = videoCanvas.scrollHeight;
    renderVideoSessionsList();

    // Name session in background
    (async () => {
      try {
        const nameRes = await mediaFetch("/video/name-session", {
          method: "POST",
          body: JSON.stringify({ prompt: rawPrompt }),
        });
        const nameData = await nameRes.json();
        if (nameData.name) {
          record.title = nameData.name;
          await saveVideoClip(record);
          const titleEl = card.querySelector(".video-result-title");
          if (titleEl) titleEl.textContent = nameData.name;
          renderVideoSessionsList();
        }
      } catch {}
    })();

  } catch (e) {
    if (e.name === "AbortError" || aborted) {
      progress.setStatus("Generation cancelled.");
      setTimeout(() => progress.destroy(), 2000);
    } else {
      progress.setStatus("Error: " + esc(e.message));
      progress.stopBtn.textContent = "Dismiss";
      progress.stopBtn.onclick = () => progress.destroy();
    }
  } finally {
    clearInterval(progressInterval);
    _videoGenerating = false;
    videoGenerateBtn.disabled = false;
  }
}

videoGenerateBtn.addEventListener("click", videoGenerate);
videoPrompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    videoGenerate();
  }
});

// ── Video Favorites ──
videoFavToggle.addEventListener("click", () => {
  const isOpen = videoFavPanel.classList.toggle("open");
  videoFavToggle.classList.toggle("active", isOpen);
  localStorage.setItem("diab_video_fav_open", isOpen ? "1" : "0");
  if (isOpen) refreshVideoFavoritesPanel();
});
document.getElementById("video-fav-close").addEventListener("click", () => {
  videoFavPanel.classList.remove("open");
  videoFavToggle.classList.remove("active");
  localStorage.setItem("diab_video_fav_open", "0");
});

async function refreshVideoFavoritesPanel() {
  const favs = await loadAllVideoFavorites();
  favs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  _updateVideoFavBadge();
  const emptyEl = videoFavContent.querySelector(".fav-panel-empty");
  videoFavContent.querySelectorAll(".video-fav-card").forEach(c => c.remove());
  if (!favs.length) {
    if (emptyEl) emptyEl.style.display = "";
    else videoFavContent.innerHTML = `<div class="fav-panel-empty">
      ${icon("heart", 32)}
      <p>Click the heart on any video to add it to your favorites.</p>
    </div>`;
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";
  for (const fav of favs) {
    videoFavContent.appendChild(_createVideoFavCard(fav));
  }
}

function _createVideoFavCard(fav) {
  const card = document.createElement("div");
  card.className = "video-fav-card music-fav-card";
  card.dataset.favId = fav.id;

  const durStr = fav.duration ? fav.duration + "s" : "";
  const title = fav.title || fav.rawPrompt?.slice(0, 40) || "Untitled";

  card.innerHTML = `
    <div class="music-fav-cover" style="width:56px;height:42px;border-radius:6px;">
      ${icon("video", 18)}
    </div>
    <div class="music-fav-info">
      <div class="music-fav-title">${esc(title)}</div>
      <div class="music-fav-duration">${durStr}</div>
    </div>
    <div class="music-fav-card-actions">
      <button class="music-action-btn video-fav-dl" title="Download">${icon("download", 12)}</button>
      <button class="music-action-btn video-fav-reuse" title="Reuse settings">${icon("refresh", 12)}</button>
      <button class="music-action-btn video-fav-remove" title="Remove from favorites">${icon("heart", 12)}</button>
    </div>
  `;

  // Download
  card.querySelector(".video-fav-dl").addEventListener("click", () => {
    if (!fav.video) return;
    const byteStr = atob(fav.video);
    const bytes = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
    const blob = new Blob([bytes], { type: "video/mp4" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (fav.title || "video").replace(/[^a-zA-Z0-9_-]/g, "_") + ".mp4";
    a.click();
  });

  // Reuse settings
  card.querySelector(".video-fav-reuse").addEventListener("click", () => {
    if (fav.rawPrompt) document.getElementById("video-prompt").value = fav.rawPrompt;
    if (fav.body) {
      const b = fav.body;
      if (b.width && b.height) document.getElementById("video-resolution").value = b.width + "x" + b.height;
      if (b.num_frames) { document.getElementById("video-frames").value = b.num_frames; document.getElementById("video-frames").dispatchEvent(new Event("input")); }
      if (b.num_inference_steps) { document.getElementById("video-steps").value = b.num_inference_steps; document.getElementById("video-steps").dispatchEvent(new Event("input")); }
      if (b.guidance_scale) { document.getElementById("video-guidance").value = b.guidance_scale; document.getElementById("video-guidance").dispatchEvent(new Event("input")); }
      if (b.fps) document.getElementById("video-fps").value = b.fps;
    }
    document.getElementById("video-prompt").focus();
  });

  // Remove from favorites
  card.querySelector(".video-fav-remove").addEventListener("click", async () => {
    await deleteVideoFavorite(fav.id);
    card.remove();
    _updateVideoFavBadge();
    // Update the main canvas fav button if visible
    const mainCard = videoCanvas.querySelector(`[data-video-id="${fav.id}"]`);
    if (mainCard) {
      const btn = mainCard.querySelector(".video-fav-btn");
      if (btn) { btn.classList.remove("active"); btn.querySelector("svg").setAttribute("fill", "none"); }
    }
    if (!videoFavContent.querySelector(".video-fav-card")) {
      const empty = videoFavContent.querySelector(".fav-panel-empty");
      if (empty) empty.style.display = "";
    }
  });

  return card;
}

async function _updateVideoFavBadge() {
  const favs = await loadAllVideoFavorites();
  const count = favs.length;
  videoFavBadge.textContent = count || "";
  videoFavBadge.style.display = count ? "" : "none";
  videoFavCountLabel.textContent = count;
}

// ── Video Trash ──
document.getElementById("video-trash-btn").addEventListener("click", () => openVideoTrashModal());

async function openVideoTrashModal() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const all = await loadAllVideoTrash();
  for (const item of all) { if (item.deletedAt < cutoff) await deleteFromVideoTrash(item.id); }
  document.getElementById("shared-trash-modal").classList.add("open");
  await renderVideoTrashList();
  document.getElementById("shared-trash-empty-btn").onclick = async () => {
    const count = document.querySelectorAll("#shared-trash-content .studio-trash-card").length;
    if (!count) return;
    if (!confirm(`Permanently delete ${count} clip${count !== 1 ? "s" : ""} from trash?`)) return;
    await emptyVideoTrash();
    updateVideoTrashBadge(0);
    document.getElementById("shared-trash-modal").classList.remove("open");
  };
}

async function renderVideoTrashList() {
  const list = document.getElementById("shared-trash-content");
  const countLabel = document.getElementById("shared-trash-count");
  const items = (await loadAllVideoTrash()).sort((a, b) => b.deletedAt - a.deletedAt);
  list.innerHTML = "";
  countLabel.textContent = items.length ? `${items.length} clip${items.length !== 1 ? "s" : ""}` : "";
  updateVideoTrashBadge(items.length);
  items.forEach(item => {
    const card = document.createElement("div");
    card.className = "studio-trash-card";
    const age = _trashAge(item.deletedAt);
    const durStr = item.duration ? item.duration + "s" : "";
    card.innerHTML = `
      <div class="studio-trash-card-info">
        <div class="studio-trash-card-prompt">${esc(item.title || item.rawPrompt || "Untitled")}</div>
        <div class="studio-trash-card-meta">${durStr}${durStr ? " · " : ""}Deleted ${age}</div>
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
      await saveVideoClip(record);
      await deleteFromVideoTrash(item.id);
      if ((record.folder_id || null) === (activeVideoFolderId || null)) {
        videoCanvas.appendChild(createVideoResultCard(record));
        videoCanvasEmpty.style.display = "none";
        renderVideoSessionsList();
      }
      await renderVideoTrashList();
    });
    card.querySelector(".studio-trash-del").addEventListener("click", async () => {
      await deleteFromVideoTrash(item.id);
      await renderVideoTrashList();
    });
    list.appendChild(card);
  });
}

function updateVideoTrashBadge(count) {
  const badge = document.getElementById("video-trash-badge");
  if (badge) badge.textContent = count || "";
}

async function _refreshVideoTrashBadge() {
  const items = await loadAllVideoTrash();
  updateVideoTrashBadge(items.length);
}


