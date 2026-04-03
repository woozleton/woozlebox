// ── VRAM status indicator (admin only) ──
const vramStatusEl = document.getElementById("vram-status");
let _vramStatusTimer = null;
let _vramEventSource = null;
let _vramSSEConnected = false;
let _vramPendingAcquire = null;
let _vramPendingModel = null; // actual model name to display
let _vramAcquirePhase = null; // "unloading" | "loading" | null
const _vramLogBuffer = [];     // rolling buffer of recent log entries
const VRAM_LOG_MAX = 30;
let _lastVramLoaded = [];      // last known loaded models for re-rendering

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

function _renderVramDisplay(loaded) {
  if (!vramStatusEl) return;
  _lastVramLoaded = loaded;
  const displayItems = [];

  for (const m of loaded) {
    const sizeStr = m.vram_mb > 0 ? `<span class="vram-size">${(m.vram_mb / 1024).toFixed(1)}G</span>` : "";
    displayItems.push(`<div class="vram-item"><span class="vram-dot loaded"></span><span class="vram-name">${m.name}</span>${sizeStr}</div>`);
  }

  const usedMb = _gpuStats.used_mb;
  const totalMb = _gpuStats.total_mb;
  const usedGb = (usedMb / 1024).toFixed(1);
  const totalGb = (totalMb / 1024).toFixed(0);
  const pct = totalMb > 0 ? Math.min(100, Math.round(usedMb / totalMb * 100)) : 0;
  const barColor = pct > 90 ? "#ef4444" : pct > 70 ? "#f59e0b" : "#34d399";

  let html = `<div class="vram-label">VRAM · ${usedGb} / ${totalGb} GB (${pct}%)</div>`;
  html += `<div class="vram-bar"><div class="vram-bar-fill" style="width:${pct}%;background:${barColor}"></div></div>`;

  if (displayItems.length) {
    html += displayItems.join("");
  } else {
    html += `<div class="vram-item" style="opacity:0.5">No models loaded</div>`;
  }

  // Debug: show VRAM activity log
  if (debugMode && _vramLogBuffer.length) {
    const entries = _vramLogBuffer.map(e => {
      if (e.action === "switch") {
        return `<div class="vram-log-separator"><span class="vram-log-time">${e.time}</span> Switching to <strong>${e.model}</strong></div>`;
      }
      const icon = e.action === "load" ? "▲" : e.action === "unload" ? "▼" : e.action === "evict" ? "✕" : "●";
      const cls = e.action === "load" || e.action === "unload" || e.action === "evict" || e.action === "call" ? e.action : "call";
      const detail = e.detail ? ` · ${e.detail}` : "";
      return `<div class="vram-log-entry"><span class="vram-log-icon ${cls}">${icon}</span><span class="vram-log-time">${e.time}</span> <span class="vram-log-svc">${e.service}</span> ${e.action} <strong>${e.model}</strong>${detail}</div>`;
    }).join("");
    html += `<div class="vram-log"><div class="vram-label" style="margin-top:4px">Activity</div>${entries}</div>`;
  }

  if (html === vramStatusEl._lastHtml) return;
  vramStatusEl._lastHtml = html;
  vramStatusEl.innerHTML = html;

  if (debugMode) {
    const logEl = vramStatusEl.querySelector(".vram-log");
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  }
}

function _connectVramSSE() {
  if (_vramEventSource) return;
  try {
    _vramEventSource = new EventSource(GPU_API + "/events");
    _vramEventSource.onopen = () => { _vramSSEConnected = true; };
    _vramEventSource.addEventListener("status", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.gpu) _gpuStats = data.gpu;
        _renderVramDisplay(data.loaded || []);
      } catch {}
    });
    _vramEventSource.addEventListener("acquiring", (e) => {
      try {
        const data = JSON.parse(e.data);
        _vramPendingAcquire = data.service;
        _vramPendingModel = data.model || data.service;
        _vramAcquirePhase = data.phase || "loading";
        if (data.phase === "unloading") {
          const now = new Date();
          const time = now.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
          _vramLogBuffer.push({ service: "switch", action: "switch", model: data.model || data.service, detail: "", time });
          while (_vramLogBuffer.length > VRAM_LOG_MAX) _vramLogBuffer.shift();
          if (debugMode) _renderVramDisplay(_lastVramLoaded || []);
        }
      } catch {}
    });
    _vramEventSource.addEventListener("vram_log", (e) => {
      try {
        const data = JSON.parse(e.data);
        const now = new Date();
        const time = now.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
        _vramLogBuffer.push({ ...data, time });
        while (_vramLogBuffer.length > VRAM_LOG_MAX) _vramLogBuffer.shift();
        if (debugMode) _renderVramDisplay(_lastVramLoaded || []);
      } catch {}
    });
    _vramEventSource.onerror = () => {
      _vramSSEConnected = false;
      _vramEventSource.close();
      _vramEventSource = null;
      setTimeout(_connectVramSSE, 2000);
    };
  } catch {}
}

async function pollVramStatus() {
  if (!currentUser || currentUser.role !== "admin") return;
  try {
    // Always fetch full status (models + GPU stats) to catch on-demand model loads
    const res = await fetch(GPU_API + "/status");
    const data = await res.json();
    if (data.gpu) _gpuStats = data.gpu;
    _renderVramDisplay(data.loaded || []);
  } catch {}
}

function startVramPolling() {
  if (_vramStatusTimer) return;
  if (!currentUser || currentUser.role !== "admin") return;
  vramStatusEl.style.display = "";
  _connectVramSSE();
  pollVramStatus();
  _vramStatusTimer = setInterval(pollVramStatus, 1000);
}

