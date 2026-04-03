// ── Vault panel ──

const vaultInputBtn = document.getElementById("vault-input-btn");

let _indexPollTimer = null;
let _lastIndexRunning = false;

function openVaultPanel() {
  closeSettings();
  vaultPanel.classList.add("open");
  vaultToggleBtn.classList.add("active");
  if (vaultInputBtn) vaultInputBtn.classList.add("active");
  localStorage.setItem("diab_vault_open", "1");
  loadVaultFiles();
  startIndexPolling();
}
function closeVaultPanel() {
  vaultPanel.classList.remove("open");
  vaultToggleBtn.classList.remove("active");
  if (vaultInputBtn) vaultInputBtn.classList.remove("active");
  localStorage.setItem("diab_vault_open", "0");
  stopIndexPolling();
}
function toggleVaultPanel() {
  if (vaultPanel.classList.contains("open")) closeVaultPanel();
  else openVaultPanel();
}

vaultToggleBtn.addEventListener("click", toggleVaultPanel);
if (vaultInputBtn) vaultInputBtn.addEventListener("click", toggleVaultPanel);
vaultClose.addEventListener("click", closeVaultPanel);

// Restore vault panel state
if (localStorage.getItem("diab_vault_open") === "1") openVaultPanel();


// ── Auto-index status polling ──
// _indexPollTimer and _lastIndexRunning declared earlier (before openVaultPanel)

async function pollIndexStatus() {
  try {
    const res = await apiFetch("/index/status");
    if (!res.ok) return;
    const { running, queued } = await res.json();
    const active = running || queued;
    const reindexBtn = document.getElementById("vault-reindex-btn");

    if (active) {
      // Show indexing indicator while active
      vaultBanner.innerHTML = `<div class="vault-indexing-msg"><span class="step-spinner" style="width:11px;height:11px;flex-shrink:0;"></span>Indexing new files…</div>`;
      if (reindexBtn) { reindexBtn.disabled = true; reindexBtn.innerHTML = `<span class="step-spinner" style="display:inline-block;width:10px;height:10px;"></span> Indexing…`; }
    } else if (_lastIndexRunning) {
      // Just finished - refresh file list, show brief done message
      if (reindexBtn) { reindexBtn.disabled = false; reindexBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Re-index`; }
      vaultBanner.innerHTML = `<div class="vault-banner-msg">Indexing complete.</div>`;
      setTimeout(() => { vaultBanner.innerHTML = ""; }, 4000);
      loadVaultFiles();
    }
    _lastIndexRunning = active;
  } catch {}
}

function startIndexPolling() {
  if (_indexPollTimer) return;
  _indexPollTimer = setInterval(pollIndexStatus, 2000);
}

function stopIndexPolling() {
  if (_indexPollTimer) { clearInterval(_indexPollTimer); _indexPollTimer = null; }
}

async function uploadFiles(files, subfolder) {
  const allowed = [".md", ".txt", ".pdf"];
  let uploaded = 0;
  const errors = [];
  for (const file of files) {
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!allowed.includes(ext)) { errors.push(`${file.name}: unsupported type`); continue; }
    const fd = new FormData();
    fd.append("file", file);
    fd.append("subfolder", subfolder || "");
    try {
      const res = await apiFetch(`/vault/upload`, { method: "POST", body: fd });
      if (!res.ok) {
        let detail = await res.text();
        try { detail = JSON.parse(detail).detail; } catch {}
        errors.push(`${file.name}: ${detail}`);
      } else {
        uploaded++;
      }
    } catch (e) { errors.push(`${file.name}: network error`); }
  }
  if (uploaded) {
    showVaultBanner(`${uploaded} file${uploaded>1?"s":""} uploaded.${errors.length ? ` ${errors.length} failed.` : ""}`);
    loadVaultFiles();
    startIndexPolling();
  }
  if (errors.length && !uploaded) {
    showToast(`Upload failed: ${errors[0]}`);
  }
}

// File picker - clicking drop zone opens picker (label handles itself)
vaultDropZone.addEventListener("click", (e) => {
  if (e.target === vaultDropZone || e.target.id === "vault-drop-hint") vaultFileInput.click();
});
vaultFileInput.addEventListener("change", () => {
  if (vaultFileInput.files.length) uploadFiles(Array.from(vaultFileInput.files), "");
  vaultFileInput.value = "";
});

// Drop zone - upload new files OR move vault files to root
vaultDropZone.addEventListener("dragover", (e) => { e.preventDefault(); vaultDropZone.classList.add("dragover"); });
vaultDropZone.addEventListener("dragleave", () => vaultDropZone.classList.remove("dragover"));
vaultDropZone.addEventListener("drop", async (e) => {
  e.preventDefault();
  vaultDropZone.classList.remove("dragover");
  const vaultPath = e.dataTransfer.getData("text/vault-path");
  if (vaultPath) { await moveVaultFile(vaultPath, ""); return; }
  const files = Array.from(e.dataTransfer.files);
  if (files.length) uploadFiles(files, "");
});

// Panel-level drag detection - highlight when dragging external files over vault panel
vaultPanel.addEventListener("dragenter", (e) => {
  if (e.dataTransfer.types.includes("Files")) vaultPanel.classList.add("drag-over");
});
vaultPanel.addEventListener("dragleave", (e) => {
  if (!vaultPanel.contains(e.relatedTarget)) vaultPanel.classList.remove("drag-over");
});
vaultPanel.addEventListener("dragover", (e) => {
  if (e.dataTransfer.types.includes("Files")) e.preventDefault();
});
vaultPanel.addEventListener("drop", (e) => {
  vaultPanel.classList.remove("drag-over");
  // If dropped on the panel but NOT on a folder header or drop zone, upload to root
  if (e.dataTransfer.types.includes("Files") && !e.defaultPrevented) {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length) uploadFiles(files, "");
  }
});


