// ── VRAM status indicator (admin only) ──
const vramStatusEl = document.getElementById("vram-status");

// Restore persisted activity-log height (drag-resize handle, see below).
// Stored as an integer pixel value in localStorage. Default 140 matches
// the original max-height before the panel became resizable.
const VRAM_LOG_HEIGHT_KEY = "wooz_vram_log_height";
const VRAM_LOG_MIN_PX = 80;
const VRAM_LOG_MAX_PX = 600;
(function _restoreVramLogHeight() {
  const saved = parseInt(localStorage.getItem(VRAM_LOG_HEIGHT_KEY) || "", 10);
  if (saved && saved >= VRAM_LOG_MIN_PX && saved <= VRAM_LOG_MAX_PX) {
    document.documentElement.style.setProperty("--vram-log-height", saved + "px");
  }
})();

// One-time delegated mousedown listener for the resize handle. The
// handle is re-rendered inside the log on every _renderVramDisplay
// rebuild, so we delegate from #vram-status (which is stable) and
// match the handle by class.
function _initVramLogResize() {
  if (!vramStatusEl || vramStatusEl._resizeWired) return;
  vramStatusEl._resizeWired = true;
  vramStatusEl.addEventListener("mousedown", (e) => {
    const handle = e.target.closest(".vram-status-resize-handle");
    if (!handle) return;
    e.preventDefault();
    const logEl = vramStatusEl.querySelector(".vram-log");
    if (!logEl) return;
    const startY = e.clientY;
    const startH = logEl.getBoundingClientRect().height;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev) => {
      // Drag UP grows the panel (the log lives at the bottom of the
      // sidebar), so subtract the delta rather than add it.
      const delta = startY - ev.clientY;
      const next = Math.max(VRAM_LOG_MIN_PX, Math.min(VRAM_LOG_MAX_PX, startH + delta));
      document.documentElement.style.setProperty("--vram-log-height", next + "px");
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const finalH = parseInt(getComputedStyle(logEl).height, 10);
      if (finalH) localStorage.setItem(VRAM_LOG_HEIGHT_KEY, String(finalH));
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}
_initVramLogResize();

let _vramStatusTimer = null;
let _vramEventSource = null;
let _vramSSEConnected = false;
let _vramPendingAcquire = null;
let _vramPendingModel = null; // actual model name to display
let _vramAcquirePhase = null; // "unloading" | "loading" | null
const _vramLogBuffer = [];     // rolling buffer of recent log entries
const VRAM_LOG_MAX = 1000;
let _lastVramLoaded = [];      // last known loaded models for re-rendering
let _vramLogSeqHigh = 0;       // highest server seq seen (dedupe on SSE reconnect)
let _vramSSEVerbose = false;   // verbose flag used by the current SSE connection
let _vramSSEReconnectTimer = null; // pending onerror reconnect timeout
// Track whether a given log entry came from a "switch" synthesized on
// the client (acquiring phase) vs the server ring buffer, so dedupe is
// based on seq only for server entries.

function setVramAcquiring(service, modelName) {
  _vramPendingAcquire = service;
  _vramPendingModel = modelName || service;
  _vramAcquirePhase = "unloading";
  pollVramStatus();
}
function clearVramAcquiring() {
  _vramPendingAcquire = null;
  _vramPendingModel = null;
  _vramAcquirePhase = null;
}

let _gpuStats = { used_mb: 0, free_mb: 0, total_mb: 24576, gpu_name: "" };

// Icon + class lookup for log entries. Unknown actions fall through to
// the neutral "call" class. Verbose engine events (fit-check, phase,
// fast-path, idle-unload, tts-block, acquire-start, acquire-done) all
// share the "call" class so they stay visually calmer than
// load/unload/evict events.
const VRAM_ACTION_ICONS = {
  load: "▲",
  unload: "▼",
  evict: "✕",
  keep: "◆",
  download: "⬇",
  load_begin: "…",
  ready: "✓",
  error: "!",
  "fit-check": "≈",
  "fast-path": "»",
  phase: "·",
  "idle-unload": "◌",
  "tts-block": "⊘",
  "acquire-start": "⇢",
  "acquire-done": "⇠",
};
const VRAM_ACTION_CLASS = {
  load: "load", unload: "unload", evict: "evict", keep: "keep",
  download: "call", load_begin: "call", ready: "load", error: "evict",
  "fit-check": "call", "fast-path": "keep", phase: "call",
  "idle-unload": "unload", "tts-block": "evict",
  "acquire-start": "call", "acquire-done": "call",
};

function _vramHeaderHtml(loaded) {
  const usedMb = _gpuStats.used_mb;
  const totalMb = _gpuStats.total_mb;
  const usedGb = (usedMb / 1024).toFixed(1);
  const totalGb = (totalMb / 1024).toFixed(0);
  const pct = totalMb > 0 ? Math.min(100, Math.round(usedMb / totalMb * 100)) : 0;
  const barColor = pct > 90 ? "#ef4444" : pct > 70 ? "#f59e0b" : "#34d399";

  // Drag handle pinned to the very top edge of #vram-status, survives
  // header rebuilds (delegation is on #vram-status itself).
  let html = `<div class="vram-status-resize-handle" title="Drag to resize"></div>`;
  html += `<div class="vram-label">VRAM · ${usedGb} / ${totalGb} GB (${pct}%)</div>`;
  html += `<div class="vram-bar"><div class="vram-bar-fill" style="width:${pct}%;background:${barColor}"></div></div>`;

  if (loaded.length) {
    for (const m of loaded) {
      const sizeStr = m.vram_mb > 0 ? `<span class="vram-size">${(m.vram_mb / 1024).toFixed(1)}G</span>` : "";
      html += `<div class="vram-item"><span class="vram-dot loaded"></span><span class="vram-name">${m.name}</span>${sizeStr}</div>`;
    }
  } else {
    html += `<div class="vram-item" style="opacity:0.5">No models loaded</div>`;
  }

  // System (non-model) VRAM = total used minus the sum of currently
  // loaded models. Recomputed every render so it stays accurate.
  const modelMb = loaded.reduce((s, m) => s + (m.vram_mb || 0), 0);
  const systemMb = Math.max(0, usedMb - modelMb);
  if (systemMb > 100) {
    const sysGb = (systemMb / 1024).toFixed(1);
    html += `<div class="vram-item" style="opacity:0.65"><span class="vram-dot" style="background:var(--text-dim)"></span><span class="vram-name">system</span><span class="vram-size">${sysGb}G</span></div>`;
  }
  return html;
}

function _escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function _vramLogEntryHtml(e) {
  if (e.action === "switch") {
    return `<div class="vram-log-separator"><span class="vram-log-time">${_escapeHtml(e.time)}</span> Switching to <strong>${_escapeHtml(e.model)}</strong></div>`;
  }
  const icon = VRAM_ACTION_ICONS[e.action] || "●";
  const cls = VRAM_ACTION_CLASS[e.action] || "call";
  const levelCls = e.level === "verbose" ? " verbose" : "";
  const detail = e.detail ? ` · ${_escapeHtml(e.detail)}` : "";
  return `<div class="vram-log-entry${levelCls}"><span class="vram-log-icon ${cls}">${icon}</span><span class="vram-log-time">${_escapeHtml(e.time)}</span> <span class="vram-log-svc">${_escapeHtml(e.service)}</span> ${_escapeHtml(e.action)} <strong>${_escapeHtml(e.model)}</strong>${detail}</div>`;
}

function _ensureVramLogContainer() {
  if (!vramStatusEl || !debugMode) return null;
  let logEl = vramStatusEl.querySelector(".vram-log");
  if (!logEl) {
    logEl = document.createElement("div");
    logEl.className = "vram-log";
    logEl.innerHTML = `<div class="vram-label vram-log-label" style="margin-top:4px">`
      + `<span>Activity</span>`
      + `<button type="button" class="vram-log-popout" id="vram-log-popout-btn" title="Pop out activity log">`
      + `<svg><use href="#i-maximize"/></svg>`
      + `</button>`
      + `</div><div class="vram-log-body"></div>`;
    vramStatusEl.appendChild(logEl);
    const btn = logEl.querySelector("#vram-log-popout-btn");
    if (btn) btn.addEventListener("click", () => toggleActivityLogModal());
    _reflectActivityLogModalButton();
  }
  return logEl.querySelector(".vram-log-body") || logEl;
}

function _renderVramHeader(loaded) {
  if (!vramStatusEl) return;
  _lastVramLoaded = loaded;
  const headerHtml = _vramHeaderHtml(loaded);
  // Preserve the existing .vram-log subtree so appended entries and
  // scroll position survive header rebuilds.
  const existingLog = vramStatusEl.querySelector(".vram-log");
  if (vramStatusEl._lastHeaderHtml !== headerHtml) {
    vramStatusEl._lastHeaderHtml = headerHtml;
    // Rebuild just the non-log portion.
    // Strategy: wipe and reinsert header HTML + re-attach preserved log.
    vramStatusEl.innerHTML = headerHtml;
    if (existingLog) vramStatusEl.appendChild(existingLog);
  }
  // If debug is on and the log container doesn't exist yet, create it
  // so subsequent appends have somewhere to land and any pre-existing
  // buffer entries (e.g. after a full SSE replay) are rendered.
  if (debugMode) _syncVramLogFromBuffer();
}

function _syncVramLogFromBuffer() {
  const body = _ensureVramLogContainer();
  if (!body) return;
  // If the DOM is already in sync (same number of entries and the last
  // seq matches), do nothing. Otherwise rebuild from buffer - this path
  // is only taken on first render, header-triggered rebuilds, and debug
  // toggle.
  const expected = _vramLogBuffer.length;
  if (body.childElementCount === expected && body._lastSeq === _vramLogSeqHigh) return;
  body.innerHTML = _vramLogBuffer.map(_vramLogEntryHtml).join("");
  body._lastSeq = _vramLogSeqHigh;
  body.scrollTop = body.scrollHeight;
}

function _appendVramLogEntry(entry) {
  const wasAtCap = _vramLogBuffer.length >= VRAM_LOG_MAX;
  _vramLogBuffer.push(entry);
  if (_vramLogBuffer.length > VRAM_LOG_MAX) _vramLogBuffer.shift();
  // Fan out to the pop-out modal (defined below). Runs even when
  // Debug Info is off only if the modal is somehow open; currently
  // the modal is debug-gated so this is a no-op in that case.
  _appendActivityLogModalEntry(entry);
  if (!debugMode) return;
  const body = _ensureVramLogContainer();
  if (!body) return;
  // Fast incremental path: the DOM already holds the pre-push buffer.
  //   * Not yet at cap: DOM has (buffer.length - 1) children, just append.
  //   * At cap: DOM had 1000 children, buffer shifted out the oldest, so
  //     remove the first child and append the new one.
  const target = _vramLogBuffer.length;
  if (!wasAtCap && body.childElementCount === target - 1) {
    body.insertAdjacentHTML("beforeend", _vramLogEntryHtml(entry));
  } else if (wasAtCap && body.childElementCount === target) {
    if (body.firstElementChild) body.removeChild(body.firstElementChild);
    body.insertAdjacentHTML("beforeend", _vramLogEntryHtml(entry));
  } else {
    // Out-of-sync (first paint, debug just toggled on, etc.) - rebuild.
    body.innerHTML = _vramLogBuffer.map(_vramLogEntryHtml).join("");
  }
  if (typeof entry.seq === "number") body._lastSeq = entry.seq;
  body.scrollTop = body.scrollHeight;
}

function _formatVramLogTime(tsMs) {
  const d = tsMs ? new Date(tsMs) : new Date();
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Expose under the legacy name so callers outside this file (if any)
// still work. Internally split into header + log pipeline above.
function _renderVramDisplay(loaded) {
  _renderVramHeader(loaded);
}

// Hook the debug toggle: when debug flips on we need the log container
// to appear and populate; when it flips off the CSS hides it. Called
// from settings.js after it updates `debugMode`.
function onVramDebugToggle() {
  if (!vramStatusEl) return;
  if (debugMode) {
    _syncVramLogFromBuffer();
    // loadSettings() calls us after hydrating debugMode, which is the
    // only reliable point to honor a persisted "open" state - at
    // startVramPolling() time debugMode was still its default (false).
    if (!_activityLogModalOpen) {
      try {
        if (localStorage.getItem("wooz_activity_log_open") === "1") {
          openActivityLogModal();
        }
      } catch {}
    }
  } else {
    // Debug just flipped off - the sidebar log is now hidden via CSS,
    // and the modal has nowhere useful to live. Auto-close it and
    // clear the persisted open-state so re-enabling Debug doesn't pop
    // it back unexpectedly.
    if (_activityLogModalOpen) {
      closeActivityLogModal();
    }
    try { localStorage.setItem("wooz_activity_log_open", "0"); } catch {}
  }
}

const _VRAM_SWITCH_SERVICE_LABELS = {
  chat: "Chat",
  ollama: "Chat",
  image: "Image Studio",
  music: "Music Studio",
  video: "Video Studio",
  code: "Code Studio",
  notetaker: "Note Taker",
  tts: "TTS",
  songwriting: "Music Studio",
};

function _handleVramLogPayload(data) {
  // Dedupe by server seq: any payload with seq <= the highest seen is
  // a replay duplicate (SSE reconnect + ring-buffer replay).
  if (typeof data.seq === "number") {
    if (data.seq <= _vramLogSeqHigh) return;
    _vramLogSeqHigh = data.seq;
  }
  // Drop verbose events defensively if the client somehow has them
  // disabled; the server is already filtering but the double-check
  // keeps mode switches consistent.
  if (data.level === "verbose" && typeof verboseMode !== "undefined" && !verboseMode) return;
  const time = _formatVramLogTime(data.ts);
  _appendVramLogEntry({ ...data, time });
}

function _connectVramSSE() {
  if (_vramEventSource) return;
  try {
    const wantVerbose = (typeof verboseMode !== "undefined" && verboseMode) ? 1 : 0;
    _vramSSEVerbose = !!wantVerbose;
    const src = new EventSource(`${GPU_API}/events?verbose=${wantVerbose}`);
    _vramEventSource = src;
    // Capture src in closures so late-firing events from a stale
    // source (e.g. after reconnectVramSSE replaced the global) can
    // ignore themselves rather than tearing down the new connection.
    src.onopen = () => {
      if (_vramEventSource !== src) return;
      _vramSSEConnected = true;
      // SSE is authoritative now - stop redundant 1s polling.
      if (_vramStatusTimer) {
        clearInterval(_vramStatusTimer);
        _vramStatusTimer = null;
      }
    };
    src.addEventListener("status", (e) => {
      if (_vramEventSource !== src) return;
      try {
        const data = JSON.parse(e.data);
        if (data.gpu) _gpuStats = data.gpu;
        _renderVramHeader(data.loaded || []);
      } catch {}
    });
    src.addEventListener("acquiring", (e) => {
      if (_vramEventSource !== src) return;
      try {
        const data = JSON.parse(e.data);
        _vramPendingAcquire = data.service;
        _vramPendingModel = data.model || data.service;
        _vramAcquirePhase = data.phase || "loading";
        const label = _VRAM_SWITCH_SERVICE_LABELS[data.service] || data.service || "another module";
        if (data.phase === "unloading") {
          const time = _formatVramLogTime();
          _appendVramLogEntry({
            service: "switch", action: "switch", model: label,
            detail: "", time, level: "normal",
          });
        } else if (data.phase === "loading") {
          const time = _formatVramLogTime();
          _appendVramLogEntry({
            service: "switch", action: "switch", model: `${label} (loading)`,
            detail: "", time, level: "normal",
          });
        }
      } catch {}
    });
    src.addEventListener("vram_log", (e) => {
      if (_vramEventSource !== src) return;
      try {
        _handleVramLogPayload(JSON.parse(e.data));
      } catch {}
    });
    src.onerror = () => {
      // If this source is stale (reconnectVramSSE already replaced
      // the global), silently ignore - the new connection is already
      // handling things and closing it would tear it down.
      if (_vramEventSource !== src) {
        try { src.close(); } catch {}
        return;
      }
      _vramSSEConnected = false;
      try { src.close(); } catch {}
      _vramEventSource = null;
      // Fall back to HTTP polling until SSE comes back, and schedule
      // a reconnect attempt.
      if (!_vramStatusTimer && currentUser && currentUser.role === "admin") {
        _vramStatusTimer = setInterval(pollVramStatus, 1000);
      }
      _vramSSEReconnectTimer = setTimeout(_connectVramSSE, 2000);
    };
  } catch {}
}

// Called after loadSettings() hydrates verboseMode from localStorage.
// startVramPolling() runs earlier in the bootstrap sequence (before
// settings are restored), so the first SSE connection may have been
// opened with the wrong verbose flag. If the hydrated preference
// differs from what the live connection was opened with, reconnect
// to pick up the change.
function syncVramSSEVerbose() {
  const wantVerbose = (typeof verboseMode !== "undefined" && verboseMode);
  if (_vramEventSource && _vramSSEVerbose !== wantVerbose) {
    reconnectVramSSE();
  }
}

function reconnectVramSSE() {
  // Used by settings.js when the verbose toggle flips, so the new
  // preference is reflected in the SSE query string. We clear the
  // client buffer and the seq high-water so the upcoming ring buffer
  // replay fully rehydrates the log under the new visibility level
  // (otherwise verbose entries the client never received would be
  // dropped as "already seen" by seq).
  if (_vramSSEReconnectTimer) {
    clearTimeout(_vramSSEReconnectTimer);
    _vramSSEReconnectTimer = null;
  }
  if (_vramEventSource) {
    try { _vramEventSource.close(); } catch {}
    _vramEventSource = null;
  }
  _vramSSEConnected = false;
  _vramLogBuffer.length = 0;
  _vramLogSeqHigh = 0;
  const body = vramStatusEl && vramStatusEl.querySelector(".vram-log-body");
  if (body) { body.innerHTML = ""; body._lastSeq = 0; }
  // Clear the modal body too so it's consistent with the buffer.
  const modalBody = document.getElementById("activity-log-body");
  if (modalBody) modalBody.innerHTML = "";
  _updateActivityLogCount();
  _connectVramSSE();
}

async function pollVramStatus() {
  if (!currentUser || currentUser.role !== "admin") return;
  // If SSE is live the status events are authoritative; polling
  // would only duplicate work and race the SSE render.
  if (_vramSSEConnected) return;
  try {
    // Always fetch full status (models + GPU stats) to catch on-demand model loads
    const res = await fetch(GPU_API + "/status");
    const data = await res.json();
    if (data.gpu) _gpuStats = data.gpu;
    _renderVramHeader(data.loaded || []);
  } catch {}
}

function startVramPolling() {
  if (!currentUser || currentUser.role !== "admin") return;
  vramStatusEl.style.display = "";
  initActivityLogModal();
  _connectVramSSE();
  // Kick one immediate status fetch so the sidebar lights up before
  // SSE's first status frame arrives. Subsequent 1s polling only
  // starts if SSE fails (see onerror handler).
  pollVramStatus();
}

// ── Activity log pop-out modal ──────────────────────────────────────
// A second, larger, filterable view of the same _vramLogBuffer. The
// buffer stays the single source of truth; this pane is a downstream
// consumer that listens on _appendActivityLogModalEntry.
let _activityLogModalOpen = false;
let _activityLogPaused = false;
let _activityLogStickyBottom = true;
let _activityLogPendingCount = 0;
let _activityLogSearchTimer = null;
let _activityLogFilter = { search: "", level: "all" };
let _activityLogInited = false;
let _activityLogFontIdx = 1; // default: medium
let _activityLogResetPos = null;
const ACTIVITY_LOG_FONT_SIZES = ["sm", "md", "lg", "xl"];

function initActivityLogModal() {
  if (_activityLogInited) return;
  const modal = document.getElementById("activity-log-modal");
  if (!modal) return;
  _activityLogInited = true;

  // 1. Restore filter state (so the first render applies it).
  try {
    const raw = localStorage.getItem("wooz_activity_log_filter");
    if (raw) {
      const f = JSON.parse(raw);
      _activityLogFilter.search = typeof f.search === "string" ? f.search : "";
      _activityLogFilter.level = ["all", "normal", "verbose"].includes(f.level) ? f.level : "all";
    }
  } catch {}

  // 2. Wire toolbar.
  const searchInput = document.getElementById("activity-log-search");
  const levelSel = document.getElementById("activity-log-level");
  if (searchInput) {
    searchInput.value = _activityLogFilter.search;
    searchInput.addEventListener("input", () => {
      clearTimeout(_activityLogSearchTimer);
      _activityLogSearchTimer = setTimeout(() => {
        _activityLogFilter.search = searchInput.value.trim();
        _persistActivityLogFilter();
        _syncActivityLogModalFromBuffer();
      }, 150);
    });
  }
  if (levelSel) {
    levelSel.value = _activityLogFilter.level;
    levelSel.addEventListener("change", () => {
      _activityLogFilter.level = levelSel.value;
      _persistActivityLogFilter();
      _syncActivityLogModalFromBuffer();
    });
  }

  // 2b. Restore + wire font size buttons.
  try {
    const savedFont = localStorage.getItem("wooz_activity_log_font");
    const idx = ACTIVITY_LOG_FONT_SIZES.indexOf(savedFont);
    if (idx >= 0) _activityLogFontIdx = idx;
  } catch {}
  _applyActivityLogFont();
  const fontDec = document.getElementById("activity-log-font-dec");
  const fontInc = document.getElementById("activity-log-font-inc");
  if (fontDec) fontDec.addEventListener("click", () => _bumpActivityLogFont(-1));
  if (fontInc) fontInc.addEventListener("click", () => _bumpActivityLogFont(1));

  // 3. Wire header buttons.
  const closeBtn = document.getElementById("activity-log-close-btn");
  const pauseBtn = document.getElementById("activity-log-pause-btn");
  const copyBtn = document.getElementById("activity-log-copy-btn");
  const clearBtn = document.getElementById("activity-log-clear-btn");
  if (closeBtn) closeBtn.addEventListener("click", () => closeActivityLogModal());
  if (pauseBtn) pauseBtn.addEventListener("click", _toggleActivityLogPause);
  if (copyBtn) copyBtn.addEventListener("click", _copyActivityLogVisible);
  if (clearBtn) clearBtn.addEventListener("click", _clearActivityLog);

  // 4. Scroll handler for sticky-bottom detection.
  const body = document.getElementById("activity-log-body");
  if (body) body.addEventListener("scroll", _onActivityLogBodyScroll, { passive: true });

  // 5. Esc to close.
  modal.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _activityLogModalOpen) closeActivityLogModal();
  });

  // 6. Draggable + resizable with persisted position/size.
  const inner = modal.querySelector(".activity-log-modal-inner");
  const header = document.getElementById("activity-log-header");
  if (inner && header && typeof makeModalDraggable === "function") {
    _activityLogResetPos = makeModalDraggable(inner, header, {
      resizeHandle: document.getElementById("activity-log-resize"),
      minWidth: 420,
      minHeight: 280,
      persistKey: "wooz_activity_log",
    });
  }

  // 7. Restore open state (last, so body render is against final layout).
  try {
    if (localStorage.getItem("wooz_activity_log_open") === "1"
        && typeof debugMode !== "undefined" && debugMode) {
      openActivityLogModal();
    }
  } catch {}
}

function _applyActivityLogFont() {
  const modal = document.getElementById("activity-log-modal");
  if (!modal) return;
  for (const s of ACTIVITY_LOG_FONT_SIZES) modal.classList.remove(`font-${s}`);
  modal.classList.add(`font-${ACTIVITY_LOG_FONT_SIZES[_activityLogFontIdx]}`);
  const dec = document.getElementById("activity-log-font-dec");
  const inc = document.getElementById("activity-log-font-inc");
  if (dec) dec.disabled = _activityLogFontIdx <= 0;
  if (inc) inc.disabled = _activityLogFontIdx >= ACTIVITY_LOG_FONT_SIZES.length - 1;
}

function _bumpActivityLogFont(delta) {
  const next = _activityLogFontIdx + delta;
  if (next < 0 || next >= ACTIVITY_LOG_FONT_SIZES.length) return;
  _activityLogFontIdx = next;
  try {
    localStorage.setItem("wooz_activity_log_font", ACTIVITY_LOG_FONT_SIZES[_activityLogFontIdx]);
    if (typeof scheduleSettingsSync === "function") scheduleSettingsSync();
  } catch {}
  _applyActivityLogFont();
  // Keep user pinned to the bottom if they were auto-following.
  if (_activityLogStickyBottom) {
    const body = document.getElementById("activity-log-body");
    if (body) body.scrollTop = body.scrollHeight;
  }
}

function _persistActivityLogFilter() {
  try {
    localStorage.setItem("wooz_activity_log_filter", JSON.stringify({
      search: _activityLogFilter.search,
      level: _activityLogFilter.level,
    }));
    if (typeof scheduleSettingsSync === "function") scheduleSettingsSync();
  } catch {}
}

function toggleActivityLogModal() {
  if (_activityLogModalOpen) closeActivityLogModal();
  else openActivityLogModal();
}

function openActivityLogModal() {
  const modal = document.getElementById("activity-log-modal");
  if (!modal) return;
  // Reset to default position so it never opens off-screen
  if (_activityLogResetPos) _activityLogResetPos();
  modal.classList.add("open");
  _activityLogModalOpen = true;
  _activityLogStickyBottom = true;
  _syncActivityLogModalFromBuffer();
  _reflectActivityLogModalButton();
  try { localStorage.setItem("wooz_activity_log_open", "1"); } catch {}
  if (typeof scheduleSettingsSync === "function") scheduleSettingsSync();
  // Focus the search input for immediate filtering.
  const searchInput = document.getElementById("activity-log-search");
  if (searchInput) setTimeout(() => searchInput.focus(), 0);
}

function closeActivityLogModal() {
  const modal = document.getElementById("activity-log-modal");
  if (!modal) return;
  modal.classList.remove("open");
  _activityLogModalOpen = false;
  _reflectActivityLogModalButton();
  try { localStorage.setItem("wooz_activity_log_open", "0"); } catch {}
  if (typeof scheduleSettingsSync === "function") scheduleSettingsSync();
  // Return focus to the sidebar pop-out button that launched it.
  const btn = document.getElementById("vram-log-popout-btn");
  if (btn) btn.focus();
}

// Update the sidebar pop-out button icon + title to reflect modal open
// state. Called from _ensureVramLogContainer (on create) and from
// open/close so the button is always in sync.
function _reflectActivityLogModalButton() {
  const btn = document.getElementById("vram-log-popout-btn");
  if (!btn) return;
  if (_activityLogModalOpen) {
    btn.innerHTML = `<svg><use href="#i-x"/></svg>`;
    btn.title = "Close activity log pop-out";
  } else {
    btn.innerHTML = `<svg><use href="#i-maximize"/></svg>`;
    btn.title = "Pop out activity log";
  }
}

function _activityLogMatches(entry) {
  if (_activityLogFilter.level === "normal" && entry.level === "verbose") return false;
  if (_activityLogFilter.level === "verbose" && entry.level !== "verbose") return false;
  const q = _activityLogFilter.search;
  if (q) {
    const hay = `${entry.action || ""} ${entry.model || ""} ${entry.detail || ""} ${entry.service || ""}`.toLowerCase();
    if (!hay.includes(q.toLowerCase())) return false;
  }
  return true;
}

function _syncActivityLogModalFromBuffer() {
  const body = document.getElementById("activity-log-body");
  if (!body) return;
  const parts = [];
  for (const e of _vramLogBuffer) {
    if (_activityLogMatches(e)) {
      // Inject data-seq so the append path can drop evicted entries.
      const seq = typeof e.seq === "number" ? e.seq : -1;
      parts.push(_vramLogEntryHtml(e).replace(/^<div /, `<div data-seq="${seq}" `));
    }
  }
  body.innerHTML = parts.join("");
  _updateActivityLogCount();
  if (_activityLogStickyBottom) body.scrollTop = body.scrollHeight;
}

function _appendActivityLogModalEntry(entry) {
  const body = document.getElementById("activity-log-body");
  if (!body) return;
  if (!_activityLogModalOpen) return;
  if (_activityLogPaused) {
    _activityLogPendingCount += 1;
    _updateActivityLogPauseBadge();
    return;
  }
  // If the buffer rolled, drop any leading modal children whose
  // data-seq is below the new buffer-front seq.
  const frontSeq = _vramLogBuffer.length ? (_vramLogBuffer[0].seq ?? -1) : -1;
  while (body.firstElementChild) {
    const s = parseInt(body.firstElementChild.getAttribute("data-seq") || "-1", 10);
    if (s >= 0 && frontSeq >= 0 && s < frontSeq) {
      body.removeChild(body.firstElementChild);
    } else {
      break;
    }
  }
  if (!_activityLogMatches(entry)) {
    _updateActivityLogCount();
    return;
  }
  const seq = typeof entry.seq === "number" ? entry.seq : -1;
  const html = _vramLogEntryHtml(entry).replace(/^<div /, `<div data-seq="${seq}" `);
  body.insertAdjacentHTML("beforeend", html);
  _updateActivityLogCount();
  if (_activityLogStickyBottom) body.scrollTop = body.scrollHeight;
}

function _onActivityLogBodyScroll() {
  const body = document.getElementById("activity-log-body");
  if (!body) return;
  _activityLogStickyBottom = (body.scrollTop + body.clientHeight >= body.scrollHeight - 4);
}

function _toggleActivityLogPause() {
  _activityLogPaused = !_activityLogPaused;
  const modal = document.getElementById("activity-log-modal");
  if (modal) modal.classList.toggle("paused", _activityLogPaused);
  const btn = document.getElementById("activity-log-pause-btn");
  if (btn) {
    btn.innerHTML = _activityLogPaused
      ? `<svg width="15" height="15"><use href="#i-play"/></svg>`
      : `<svg width="15" height="15"><use href="#i-pause"/></svg>`;
    btn.title = _activityLogPaused ? "Resume live updates" : "Pause live updates";
  }
  if (!_activityLogPaused) {
    _activityLogPendingCount = 0;
    _updateActivityLogPauseBadge();
    _syncActivityLogModalFromBuffer();
  }
}

function _updateActivityLogPauseBadge() {
  const btn = document.getElementById("activity-log-pause-btn");
  if (!btn) return;
  if (_activityLogPaused && _activityLogPendingCount > 0) {
    btn.title = `Resume live updates (${_activityLogPendingCount} pending)`;
  } else if (_activityLogPaused) {
    btn.title = "Resume live updates";
  } else {
    btn.title = "Pause live updates";
  }
}

function _copyActivityLogVisible() {
  const lines = [];
  for (const e of _vramLogBuffer) {
    if (!_activityLogMatches(e)) continue;
    const t = _formatVramLogTime(e.ts);
    const lvl = e.level === "verbose" ? "verbose" : "normal";
    const detail = e.detail ? ` - ${e.detail}` : "";
    lines.push(`[${t}] ${lvl} ${e.service || ""} ${e.action || ""} - ${e.model || ""}${detail}`);
  }
  const text = lines.join("\n");
  try {
    navigator.clipboard.writeText(text).then(
      () => { if (typeof showToast === "function") showToast(`Copied ${lines.length} entries`); },
      () => { if (typeof showToast === "function") showToast("Clipboard copy failed", "error"); },
    );
  } catch {
    if (typeof showToast === "function") showToast("Clipboard copy failed", "error");
  }
}

function _clearActivityLog() {
  _vramLogBuffer.length = 0;
  // Deliberately do NOT reset _vramLogSeqHigh - existing dedupe will
  // drop any replayed history on reconnect, so the clear sticks.
  const body = vramStatusEl && vramStatusEl.querySelector(".vram-log-body");
  if (body) { body.innerHTML = ""; body._lastSeq = _vramLogSeqHigh; }
  const modalBody = document.getElementById("activity-log-body");
  if (modalBody) modalBody.innerHTML = "";
  _activityLogPendingCount = 0;
  _updateActivityLogPauseBadge();
  _updateActivityLogCount();
}

function _updateActivityLogCount() {
  const el = document.getElementById("activity-log-count");
  if (!el) return;
  const total = _vramLogBuffer.length;
  let visible = 0;
  for (const e of _vramLogBuffer) if (_activityLogMatches(e)) visible += 1;
  el.textContent = visible === total ? `${total}` : `${visible} / ${total}`;
}

