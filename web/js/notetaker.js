/**
 * notetaker.js - Meeting Note Taker module for WoozleBox.
 *
 * Record or upload audio/video, transcribe with whisperX,
 * diarize speakers, and generate AI summaries.
 */

/* global createStudioDB, mediaFetch, showToast, esc, wireSettingsToggle,
   trashAge, updateBadge, purgeOldTrash, showNotetaker, setView */

// ── DOM refs ──
const ntCanvas = document.getElementById("notetaker-canvas");
const ntCanvasEmpty = document.getElementById("notetaker-canvas-empty");
const ntPlayer = document.getElementById("notetaker-player");
const ntAudio = document.getElementById("notetaker-audio");
const ntSummaryPanel = document.getElementById("notetaker-summary-panel");
const ntSummaryText = document.getElementById("notetaker-summary-text");
const ntProgress = document.getElementById("notetaker-progress");
const ntProgressText = document.getElementById("notetaker-progress-text");

// ── IndexedDB ──
const _notetakerDB = createStudioDB({
  name: "wooz_notetaker", version: 1,
  stores: ["notes", "favorites", "trash", "folders"],
});

async function saveNote(r) { return _notetakerDB.save("notes", r); }
async function loadAllNotes() { return _notetakerDB.loadAll("notes"); }
async function deleteNote(id) { return _notetakerDB.remove("notes", id); }
async function saveNtFavorite(r) { return _notetakerDB.save("favorites", r); }
async function deleteNtFavorite(id) { return _notetakerDB.remove("favorites", id); }
async function loadAllNtFavorites() { return _notetakerDB.loadAll("favorites"); }
async function isNtFavorite(id) { return _notetakerDB.has("favorites", id); }
async function saveNtTrash(r) { return _notetakerDB.save("trash", r); }
async function loadAllNtTrash() { return _notetakerDB.loadAll("trash"); }
async function deleteFromNtTrash(id) { return _notetakerDB.remove("trash", id); }
async function emptyNtTrash() { return _notetakerDB.clear("trash"); }
async function saveNtFolder(r) { return _notetakerDB.save("folders", r); }
async function deleteNtFolder(id) { return _notetakerDB.remove("folders", id); }
async function loadAllNtFolders() { return _notetakerDB.loadAll("folders"); }

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
let _ntTimerInterval = null;
let _ntUploadedFile = null;
let _ntPollTimer = null;
let _ntCurrentNote = null;  // currently displayed note
let _ntSpeakerColors = {};  // speaker -> color index mapping

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
      h.className = "sb-date-group";
      h.textContent = group;
      list.appendChild(h);
      lastGroup = group;
    }
    const row = document.createElement("div");
    row.className = "sidebar-row nt-sidebar-item" + (s.id === activeNtSessionId ? " active" : "");
    const label = s.title || s.notes[0]?.title || "Untitled Note";
    const dur = s.notes[0]?.duration_s ? _fmtDuration(s.notes[0].duration_s) : "";
    row.innerHTML = `<svg width="14" height="14"><use href="#i-mic"/></svg><span class="nt-item-title">${esc(label)}</span><span class="nt-item-duration">${dur}</span>`;
    row.addEventListener("click", () => {
      activeNtSessionId = s.id;
      localStorage.setItem("wooz_nt_session", s.id);
      restoreNotes();
      renderNotetakerSessionsList();
    });
    list.appendChild(row);
  }
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
  for (const f of ntFolders) {
    const row = document.createElement("div");
    row.className = "sidebar-row sb-folder-row" + (f.id === activeNtFolderId ? " active" : "");
    row.dataset.folderId = f.id;
    row.innerHTML = `<svg width="14" height="14"><use href="#i-folder"/></svg><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.82rem;">${esc(f.name)}</span>`;
    row.addEventListener("click", () => {
      activeNtFolderId = f.id;
      localStorage.setItem("wooz_nt_folder", f.id);
      _renderNtFoldersSidebar();
      renderNotetakerSessionsList();
    });
    // Drag-drop target
    row.addEventListener("dragover", e => { e.preventDefault(); row.classList.add("drag-over"); });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", async e => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const sessionId = e.dataTransfer.getData("text/plain");
      if (!sessionId) return;
      const all = await loadAllNotes();
      for (const n of all) {
        if (n.session_id === sessionId) {
          n.folder_id = f.id;
          await saveNote(n);
        }
      }
      renderNotetakerSessionsList();
    });
    container.appendChild(row);
  }
}

document.getElementById("notetaker-folder-new-btn").addEventListener("click", async () => {
  const name = prompt("Folder name:");
  if (!name?.trim()) return;
  const folder = { id: "ntfolder_" + Date.now(), name: name.trim(), description: "", timestamp: Date.now() };
  await saveNtFolder(folder);
  activeNtFolderId = folder.id;
  localStorage.setItem("wooz_nt_folder", folder.id);
  await loadNotetakerFolders();
  renderNotetakerSessionsList();
});

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
    ntSummaryPanel.style.display = "none";
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

  for (const seg of (note.segments || [])) {
    const div = document.createElement("div");
    div.className = "nt-segment";
    div.dataset.start = seg.start;
    div.dataset.end = seg.end;

    const displayName = (note.speakerNames && note.speakerNames[seg.speaker]) || seg.speaker;
    const colorIdx = _ntSpeakerColors[seg.speaker] || 0;

    div.innerHTML = `<div class="nt-segment-header"><span class="nt-speaker-label nt-speaker-${colorIdx}" data-speaker="${esc(seg.speaker)}">${esc(displayName)}</span><span class="nt-segment-time">${_fmtTime(seg.start)}</span></div><div class="nt-segment-text">${esc(seg.text)}</div>`;

    // Click to seek audio
    div.addEventListener("click", () => {
      if (ntAudio.src) {
        ntAudio.currentTime = seg.start;
        ntAudio.play();
      }
    });

    // Click speaker label to rename
    const label = div.querySelector(".nt-speaker-label");
    label.addEventListener("click", async e => {
      e.stopPropagation();
      const spk = label.dataset.speaker;
      const currentName = (note.speakerNames && note.speakerNames[spk]) || spk;
      const newName = prompt(`Rename "${currentName}" to:`, currentName);
      if (!newName?.trim() || newName.trim() === currentName) return;
      if (!note.speakerNames) note.speakerNames = {};
      note.speakerNames[spk] = newName.trim();
      await saveNote(note);
      _displayNote(note);
    });

    ntCanvas.appendChild(div);
  }

  // Audio player
  if (note.audioUrl) {
    ntPlayer.style.display = "";
    ntAudio.src = MEDIA_API + "/notetaker/audio/" + note.id;
    _setupAudioPlayer();
  } else {
    ntPlayer.style.display = "none";
  }

  // Summary
  if (note.summary) {
    ntSummaryPanel.style.display = "";
    ntSummaryText.textContent = note.summary;
  } else {
    ntSummaryPanel.style.display = "none";
  }

  // Show summarize button if transcript exists
  document.getElementById("notetaker-summarize-btn").style.display = note.segments?.length ? "" : "none";

  // Show export buttons
  document.getElementById("notetaker-copy-md-btn").style.display = "";
  document.getElementById("notetaker-export-md-btn").style.display = "";
}

// ── Audio player ──

function _setupAudioPlayer() {
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

_ntSourceTabs.forEach(tab => {
  tab.addEventListener("click", () => {
    _ntSourceTabs.forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    const src = tab.dataset.source;
    _ntRecordSection.style.display = (src === "mic" || src === "system") ? "" : "none";
    _ntUploadSection.style.display = src === "upload" ? "" : "none";
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
      if (e.data.size > 0) _ntRecordedChunks.push(e.data);
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
      showToast("Recording saved - click Transcribe to process", "success");
    };

    _ntMediaRecorder.start(1000);
    _ntRecording = true;
    _ntRecordStart = Date.now();

    // UI
    _ntRecordBtn.style.display = "none";
    _ntPauseBtn.style.display = "";
    _ntStopBtn.style.display = "";

    // Timer
    _ntTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - _ntRecordStart) / 1000);
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
    _ntPauseBtn.innerHTML = '<svg width="14" height="14"><use href="#i-play"/></svg>';
    _ntPauseBtn.title = "Resume";
  } else if (_ntMediaRecorder.state === "paused") {
    _ntMediaRecorder.resume();
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

function _handleUploadedFile(file) {
  const ext = "." + file.name.split(".").pop().toLowerCase();
  const supported = new Set([".wav", ".mp3", ".m4a", ".flac", ".mp4", ".mkv", ".webm", ".mov", ".ogg", ".wma"]);
  if (!supported.has(ext)) {
    showToast("Unsupported format: " + ext, "error");
    return;
  }
  _ntUploadedFile = file;
  _ntFileInfo.style.display = "";
  const sizeMB = (file.size / 1024 / 1024).toFixed(1);
  _ntFileInfo.textContent = `${file.name} (${sizeMB} MB)`;
}

// ── Transcribe ──

document.getElementById("notetaker-transcribe-btn").addEventListener("click", async () => {
  if (!_ntUploadedFile) {
    showToast("Record audio or upload a file first", "error");
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

  // Show progress
  ntProgress.style.display = "";
  document.getElementById("notetaker-transcribe-btn").disabled = true;
  _startProgressPoll();

  try {
    const resp = await mediaFetch("/notetaker/transcribe", { method: "POST", body: fd });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: "Transcription failed" }));
      throw new Error(err.detail || "Transcription failed");
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
    _ntUploadedFile = null;
    _ntFileInfo.style.display = "none";

    _displayNote(note);
    renderNotetakerSessionsList();
    showToast("Transcription complete", "success");

  } catch (err) {
    showToast(err.message, "error");
  } finally {
    _stopProgressPoll();
    ntProgress.style.display = "none";
    document.getElementById("notetaker-transcribe-btn").disabled = false;
  }
});

// ── Progress polling ──

function _startProgressPoll() {
  _ntPollTimer = setInterval(async () => {
    try {
      const resp = await mediaFetch("/notetaker/progress");
      if (!resp.ok) return;
      const p = await resp.json();
      if (p.running && p.message) {
        ntProgressText.textContent = p.message;
        if (p.elapsed_s > 0) {
          ntProgressText.textContent += ` (${Math.floor(p.elapsed_s)}s)`;
        }
      }
    } catch (_) {}
  }, 1500);
}

function _stopProgressPoll() {
  if (_ntPollTimer) { clearInterval(_ntPollTimer); _ntPollTimer = null; }
}

// Cancel button
document.getElementById("notetaker-cancel-btn").addEventListener("click", async () => {
  try {
    await mediaFetch("/notetaker/cancel", { method: "POST" });
    showToast("Cancelling...", "info");
  } catch (_) {}
});

// ── Summarize ──

document.getElementById("notetaker-summarize-btn").addEventListener("click", _generateSummary);
document.getElementById("notetaker-regen-summary-btn").addEventListener("click", _generateSummary);

async function _generateSummary() {
  if (!_ntCurrentNote || !_ntCurrentNote.segments?.length) return;

  const noteType = document.getElementById("notetaker-type-select").value;
  const customInstr = document.getElementById("notetaker-custom-instructions").value;

  const transcript = _ntCurrentNote.segments.map(s => {
    const name = (_ntCurrentNote.speakerNames && _ntCurrentNote.speakerNames[s.speaker]) || s.speaker;
    return `${name}: ${s.text}`;
  }).join("\n");

  ntSummaryPanel.style.display = "";
  ntSummaryText.textContent = "Generating summary...";

  try {
    const resp = await mediaFetch("/notetaker/summarize", {
      method: "POST",
      body: JSON.stringify({
        transcript,
        note_type: noteType,
        custom_instructions: noteType === "custom" ? customInstr : "",
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: "Summary failed" }));
      throw new Error(err.detail || "Summary generation failed");
    }

    const data = await resp.json();
    _ntCurrentNote.summary = data.summary;
    _ntCurrentNote.noteType = noteType;
    if (noteType === "custom") _ntCurrentNote.customInstructions = customInstr;
    await saveNote(_ntCurrentNote);

    ntSummaryText.textContent = data.summary;
    showToast("Summary generated", "success");
  } catch (err) {
    ntSummaryText.textContent = "Failed to generate summary.";
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
  for (const seg of (note.segments || [])) {
    const name = names[seg.speaker] || seg.speaker;
    md += `**${name}** *(${_fmtTime(seg.start)})*\n${seg.text}\n\n`;
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
document.getElementById("notetaker-copy-summary-btn").addEventListener("click", () => {
  if (_ntCurrentNote?.summary) {
    navigator.clipboard.writeText(_ntCurrentNote.summary);
    showToast("Summary copied", "success");
  }
});

// ── Trash ──

async function _refreshNotetakerTrashBadge() {
  const items = await loadAllNtTrash();
  updateBadge("notetaker-trash-badge", items.length);
}

document.getElementById("notetaker-trash-btn").addEventListener("click", () => _openNtTrashModal());

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
  const countLabel = document.getElementById("shared-trash-count");
  const items = (await loadAllNtTrash()).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  list.innerHTML = "";
  countLabel.textContent = items.length ? `${items.length} note${items.length !== 1 ? "s" : ""}` : "";
  _refreshNotetakerTrashBadge();

  for (const item of items) {
    const card = document.createElement("div");
    card.className = "studio-trash-card";
    card.innerHTML = `<div class="studio-trash-card-info"><div class="studio-trash-card-prompt">${esc(item.title || "Untitled Note")}</div><div class="studio-trash-card-meta">${trashAge(item.deletedAt)}</div></div><div class="studio-trash-card-actions"><button class="restore-btn" title="Restore">Restore</button><button class="delete-btn" title="Delete permanently">Delete</button></div>`;
    card.querySelector(".restore-btn").addEventListener("click", async () => {
      delete item.deletedAt;
      await saveNote(item);
      await deleteFromNtTrash(item.id);
      await _renderNtTrashList();
      restoreNotes();
      renderNotetakerSessionsList();
    });
    card.querySelector(".delete-btn").addEventListener("click", async () => {
      try { await mediaFetch("/notetaker/audio/" + item.id, { method: "DELETE" }); } catch (_) {}
      await deleteFromNtTrash(item.id);
      await _renderNtTrashList();
    });
    list.appendChild(card);
  }
}

// ── Favorites ──

document.getElementById("notetaker-fav-toggle").addEventListener("click", () => {
  const panel = document.getElementById("notetaker-fav-panel");
  const btn = document.getElementById("notetaker-fav-toggle");
  const isOpen = panel.classList.toggle("open");
  btn.classList.toggle("active", isOpen);
  localStorage.setItem("wooz_notetaker_fav_open", isOpen ? "1" : "0");
  if (isOpen) refreshNotetakerFavoritesPanel();
});

async function refreshNotetakerFavoritesPanel() {
  const list = document.getElementById("notetaker-fav-list");
  const empty = document.getElementById("notetaker-fav-empty");
  if (!list) return;
  const favs = await loadAllNtFavorites();
  list.innerHTML = "";
  empty.style.display = favs.length ? "none" : "";
  for (const fav of favs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))) {
    const row = document.createElement("div");
    row.className = "nt-sidebar-item";
    row.innerHTML = `<svg width="14" height="14"><use href="#i-mic"/></svg><span class="nt-item-title">${esc(fav.title || "Untitled")}</span>`;
    row.addEventListener("click", () => {
      if (fav.session_id) {
        activeNtSessionId = fav.session_id;
        localStorage.setItem("wooz_nt_session", fav.session_id);
      }
      restoreNotes();
      renderNotetakerSessionsList();
    });
    list.appendChild(row);
  }
}

// ── Settings toggle ──

wireSettingsToggle("notetaker-settings-trigger", "notetaker-settings-crumb", "notetaker-settings-panel");

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
  document.querySelectorAll(".nt-sidebar-item").forEach(el => el.classList.remove("active"));
  ntCanvas.innerHTML = "";
  ntCanvas.style.display = "none";
  ntCanvasEmpty.style.display = "";
  ntPlayer.style.display = "none";
  ntSummaryPanel.style.display = "none";
  _ntCurrentNote = null;
  _ntUploadedFile = null;
  _ntFileInfo.style.display = "none";
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
