// ── Memory ──
let memoryFacts = [];
async function loadMemory() {
  try {
    memoryFacts = await apiFetch(`/memory`).then(r => r.json());
    renderMemory();
  } catch {}
}
function renderMemory() {
  const list = document.getElementById("memory-list");
  list.innerHTML = "";
  if (!memoryFacts.length) {
    list.innerHTML = "";
    return;
  }
  memoryFacts.forEach(m => {
    const row = document.createElement("div");
    row.className = "memory-fact";
    row.innerHTML = `<span>${esc(m.fact)}</span><button title="Delete" data-id="${m.id}">✕</button>`;
    row.querySelector("button").addEventListener("click", async () => {
      await apiFetch(`/memory/${m.id}`, { method: "DELETE" });
      loadMemory();
    });
    list.appendChild(row);
  });
}
document.getElementById("memory-add-btn").addEventListener("click", async () => {
  const input = document.getElementById("memory-input");
  const fact = input.value.trim();
  if (!fact) return;
  await apiFetch(`/memory`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fact }) });
  input.value = "";
  loadMemory();
});
document.getElementById("memory-input").addEventListener("keydown", e => {
  if (e.key === "Enter") document.getElementById("memory-add-btn").click();
});

document.getElementById("change-pw-btn").addEventListener("click", async () => {
  const current = document.getElementById("change-pw-current").value;
  const next = document.getElementById("change-pw-new").value;
  const msg = document.getElementById("change-pw-msg");
  if (!current || !next) { msg.textContent = "Fill in both fields."; msg.style.color = "var(--danger,#ef4444)"; return; }
  const res = await apiFetch("/auth/me/password", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current_password: current, new_password: next }) });
  if (res.ok) {
    msg.textContent = "Password updated."; msg.style.color = "var(--accent)";
    document.getElementById("change-pw-current").value = "";
    document.getElementById("change-pw-new").value = "";
  } else {
    const err = await res.json().catch(() => ({}));
    msg.textContent = err.detail || "Error updating password."; msg.style.color = "var(--danger,#ef4444)";
  }
});

document.getElementById("clear-all-data-btn").addEventListener("click", async () => {
  const confirmed = await showConfirm({
    title: "Clear All Data",
    message: "This will permanently delete all your conversations, folders, memory, image sessions, music tracks, and video clips. Your account and settings will be kept. Continue?",
    okLabel: "Clear Everything",
    okClass: "danger",
  });
  if (!confirmed) return;
  try {
    // Clear server-side data (conversations, folders, memory)
    await apiFetch("/users/me/data", { method: "DELETE" });
    // Clear client-side IndexedDB (image studio + music studio + video studio)
    await new Promise((resolve) => { const r = indexedDB.deleteDatabase("wooz_studio"); r.onsuccess = resolve; r.onerror = resolve; });
    await new Promise((resolve) => { const r = indexedDB.deleteDatabase("wooz_music"); r.onsuccess = resolve; r.onerror = resolve; });
    await new Promise((resolve) => { const r = indexedDB.deleteDatabase("wooz_video"); r.onsuccess = resolve; r.onerror = resolve; });
    // Clear related localStorage keys
    localStorage.removeItem("wooz_studio_session");
    localStorage.removeItem("wooz_music_session");
    localStorage.removeItem("wooz_music_folder");
    localStorage.removeItem("wooz_video_session");
    localStorage.removeItem("wooz_video_folder");
    showToast("All data cleared.");
    closeSettings();
    loadConversations();
    if (typeof restoreStudioImages === "function") restoreStudioImages(true);
    if (typeof restoreMusicTracks === "function") restoreMusicTracks();
    if (typeof restoreVideoClips === "function") restoreVideoClips();
  } catch (e) {
    showToast("Error clearing data: " + (e.message || e));
  }
});

document.getElementById("delete-account-btn").addEventListener("click", async () => {
  const confirmed = await showConfirm({ title: "Delete Account", message: "Permanently delete your account and all your data? This cannot be undone.", okLabel: "Delete", okClass: "danger" });
  if (!confirmed) return;
  const res = await apiFetch("/users/me", { method: "DELETE" });
  if (res.ok) { clearSession(); showLoginScreen(); }
});

