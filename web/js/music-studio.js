// ── Music prompt suggestions ──
const MUSIC_SUGGESTIONS = [
  // Pop
  "upbeat pop anthem, catchy synth hook, claps and snaps, feel-good summer vibe",
  "dreamy synth-pop ballad, soft female vocals, shimmering pads, nostalgic 80s feel",
  "indie pop with ukulele and handclaps, sunny and playful, whistling melody",
  // Rock
  "driving rock with heavy electric guitar riffs, pounding drums, raw energy",
  "alternative rock, distorted guitar, melancholic vocals, 90s grunge influence",
  "classic rock anthem with soaring guitar solo, arena-ready chorus",
  // Electronic / EDM
  "deep house groove, warm bassline, filtered chords, late-night club atmosphere",
  "ambient electronic with evolving synth textures, ethereal pads, space and reverb",
  "high-energy EDM drop, festival anthem, massive synths, build-up and release",
  "lo-fi chill beats, vinyl crackle, mellow piano chords, rainy day mood",
  "retro synthwave, pulsing arpeggios, neon-lit nightdrive, 80s nostalgia",
  // Hip Hop / R&B
  "old school boom bap hip hop, dusty vinyl samples, head-nodding groove",
  "smooth R&B with silky vocals, lush harmonies, slow jam groove",
  "trap beat with heavy 808 bass, hi-hat rolls, dark and moody atmosphere",
  // Jazz
  "smoky jazz club, piano trio with walking bass, brushed drums, intimate mood",
  "bossa nova with nylon guitar, soft percussion, warm and relaxed tropical feel",
  "big band swing, brass section, energetic rhythm, 1940s dance hall energy",
  // Classical / Orchestral
  "epic orchestral soundtrack, sweeping strings, french horns, cinematic and heroic",
  "gentle piano sonata, classical elegance, emotional and contemplative",
  "dramatic film score, tension building, percussion hits, full orchestra crescendo",
  // Country / Folk
  "country ballad with acoustic guitar and pedal steel, heartfelt storytelling",
  "upbeat bluegrass with banjo, fiddle, and standup bass, foot-stomping energy",
  "indie folk with fingerpicked acoustic guitar, soft harmonies, campfire warmth",
  // World / Latin
  "reggae groove with offbeat guitar, deep bass, laid-back island vibes",
  "Latin salsa with brass, congas, and piano montuno, danceable and fiery",
  "African highlife with bright guitars, percussion, joyful and rhythmic",
  "Middle Eastern fusion with oud, tabla, and atmospheric pads, mystical mood",
  // Metal / Punk
  "thrash metal with fast double-kick drums, aggressive riffs, shredding solo",
  "punk rock with fast power chords, shouted vocals, raw and rebellious energy",
  // Ambient / Chill
  "peaceful ambient soundscape, nature sounds, gentle drones, meditation music",
  "chillwave with washed-out synths, dreamy reverb, sunset beach atmosphere",
  "dark ambient with deep drones, distant echoes, haunting and atmospheric",
  // Funk / Soul
  "funky groove with slap bass, wah guitar, tight horns, get-up-and-dance energy",
  "classic Motown soul, warm vocals, organ, tambourine, uplifting spirit",
  // Cinematic / Game
  "fantasy RPG adventure theme, orchestral with choir, heroic and mystical",
  "horror game soundtrack, dissonant strings, creepy whispers, building tension",
  "8-bit chiptune, retro video game music, energetic and nostalgic",
  "epic battle music, pounding war drums, intense brass, choir chanting",
  // Experimental
  "glitch hop with stuttering beats, digital artifacts, quirky synth melodies",
  "post-rock with layered guitars, slow build to massive wall of sound",
];

let _lastMusicSuggestionIdx = -1;
function _pickLocalMusicSuggestion() {
  let idx;
  do { idx = Math.floor(Math.random() * MUSIC_SUGGESTIONS.length); }
  while (idx === _lastMusicSuggestionIdx && MUSIC_SUGGESTIONS.length > 1);
  _lastMusicSuggestionIdx = idx;
  musicPrompt.value = MUSIC_SUGGESTIONS[idx];
  musicPrompt.focus();
  musicPrompt.style.height = "auto";
  musicPrompt.style.height = Math.min(musicPrompt.scrollHeight, 140) + "px";
}

async function pickMusicSuggestion() {
  const btn = document.getElementById("music-suggest-btn");
  btn.disabled = true;
  btn.classList.add("loading");
  musicPrompt.classList.add("songwriting", "prompt-locked");
  musicPrompt.value = "Thinking of something...";
  try {
    const res = await mediaFetch("/music/inspire");
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (data.prompt) {
      musicPrompt.value = data.prompt;
      musicPrompt.style.height = "auto";
      musicPrompt.style.height = Math.min(musicPrompt.scrollHeight, 140) + "px";
    } else {
      _pickLocalMusicSuggestion();
    }
  } catch {
    _pickLocalMusicSuggestion();
  } finally {
    musicPrompt.classList.remove("songwriting", "prompt-locked");
    btn.disabled = false;
    btn.classList.remove("loading");
  }
  musicPrompt.focus();
}
document.getElementById("music-suggest-btn").addEventListener("click", pickMusicSuggestion);

// ── AI Songwrite -send brief description to LLM, get back style prompt + lyrics ──
document.getElementById("music-write-song-btn").addEventListener("click", async function() {
  const desc = musicPrompt.value.trim();
  if (!desc) {
    // If empty, pick a random suggestion first
    pickMusicSuggestion();
    return;
  }

  const btn = this;
  const origPrompt = desc;
  btn.disabled = true;
  btn.classList.add("loading");
  musicPrompt.classList.add("songwriting", "prompt-locked");

  const _songwritePhrases = [
    "Tuning the creative strings...",
    "Channeling the muse...",
    "Composing something special...",
    "Finding the perfect melody...",
    "Brewing lyrical magic...",
    "Putting pen to paper...",
    "Warming up the vocal cords...",
    "Searching for the right words...",
    "Mixing inspiration and caffeine...",
    "Consulting the music gods...",
    "Harmonizing thoughts...",
    "Dropping beats and bars...",
    "Crafting your masterpiece...",
    "Summoning the songwriter within...",
    "Loading creative juices...",
  ];
  let _phraseIdx = Math.floor(Math.random() * _songwritePhrases.length);
  musicPrompt.value = _songwritePhrases[_phraseIdx];
  const _phraseTimer = setInterval(() => {
    _phraseIdx = (_phraseIdx + 1) % _songwritePhrases.length;
    musicPrompt.value = _songwritePhrases[_phraseIdx];
  }, 2500);

  const langSel = document.getElementById("music-vocal-language");
  const lang = langSel.value || "en";

  try {
    const res = await mediaFetch("/music/write-song", {
      method: "POST",
      body: JSON.stringify({ description: desc, language: lang, model: localStorage.getItem("diab_songwrite_model") || selectedModel || null }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Failed");
    }
    const data = await res.json();

    // Fill in the style prompt
    if (data.style) {
      musicPrompt.value = data.style;
      musicPrompt.style.height = "auto";
      musicPrompt.style.height = Math.min(musicPrompt.scrollHeight, 140) + "px";
    }

    // Fill in lyrics and open settings panel
    if (data.lyrics) {
      musicLyrics.value = data.lyrics;
      document.getElementById("music-settings-crumb").classList.add("open");
      document.getElementById("music-settings-panel").classList.add("open");
      _updateMusicSettingsSummary();
    }

    musicPrompt.focus();
  } catch (e) {
    console.error("AI Songwrite failed:", e);
    musicPrompt.value = origPrompt;
  } finally {
    clearInterval(_phraseTimer);
    musicPrompt.classList.remove("songwriting", "prompt-locked");
    btn.disabled = false;
    btn.classList.remove("loading");
  }
});


// ── Music IndexedDB ──
const _musicDB = createStudioDB({
  name: "diab_music", version: 4,
  stores: ["tracks", "favorites", "trash", "folders"],
  onUpgrade(e, req) {
    if (e.oldVersion < 3 && req.result.objectStoreNames.contains("tracks")) {
      try {
        const store = req.transaction.objectStore("tracks");
        store.openCursor().onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (cursor) {
            const rec = cursor.value;
            if (!rec.folder_id) { rec.folder_id = null; cursor.update(rec); }
            cursor.continue();
          }
        };
      } catch {}
    }
  }
});
function openMusicDB() { return _musicDB.open(); }

async function saveMusicTrack(record) { return _musicDB.save("tracks", record); }
async function loadAllMusicTracks() { return _musicDB.loadAll("tracks"); }
async function deleteMusicTrack(id) { return _musicDB.remove("tracks", id); }
async function saveMusicFavorite(fav) { return _musicDB.save("favorites", fav); }
async function deleteMusicFavorite(id) { return _musicDB.remove("favorites", id); }
async function loadAllMusicFavorites() { return _musicDB.loadAll("favorites"); }
async function isMusicFavorite(id) { return _musicDB.has("favorites", id); }

// ── Music trash CRUD ──
async function saveMusicToTrash(item) { return _musicDB.save("trash", item); }
async function loadAllMusicTrash() { return _musicDB.loadAll("trash"); }
async function deleteFromMusicTrash(id) { return _musicDB.remove("trash", id); }
async function emptyMusicTrash() { return _musicDB.clear("trash"); }
function _makeMusicTrashId() {
  return "mtrash_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
}

// ── Music Folders CRUD ──
async function saveMusicFolder(col) { return _musicDB.save("folders", col); }
async function deleteMusicFolder(id) { return _musicDB.remove("folders", id); }
async function loadAllMusicFolders() { return _musicDB.loadAll("folders"); }
let musicFolders = [];
let activeMusicFolderId = localStorage.getItem("diab_music_folder") || null;

// ── Music sessions ──
let activeMusicSessionId = localStorage.getItem("diab_music_session") || null;

function _newMusicSessionId() {
  const arr = new Uint8Array(12);
  crypto.getRandomValues(arr);
  return "msess_" + Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
}

function _ensureMusicSession() {
  if (!activeMusicSessionId) {
    activeMusicSessionId = _newMusicSessionId();
    localStorage.setItem("diab_music_session", activeMusicSessionId);
  }
  return activeMusicSessionId;
}

async function _getMusicSessions() {
  const tracks = await loadAllMusicTracks();
  const map = {};
  for (const t of tracks) {
    // Filter by active music folder
    if ((t.folder_id || null) !== (activeMusicFolderId || null)) continue;
    const sid = t.session_id || "default";
    if (!map[sid]) map[sid] = { session_id: sid, records: [], firstPrompt: "", latestTimestamp: 0, trackCount: 0 };
    map[sid].records.push(t);
    if (!map[sid].firstPrompt && (t.title || t.rawPrompt)) map[sid].firstPrompt = t.title || t.rawPrompt;
    if ((t.timestamp || 0) > map[sid].latestTimestamp) map[sid].latestTimestamp = t.timestamp || 0;
    map[sid].trackCount++;
  }
  return Object.values(map).sort((a, b) => b.latestTimestamp - a.latestTimestamp);
}

async function renderMusicSessionsList() {
  const list = document.getElementById("music-sessions-list");
  if (!list) return;
  list.innerHTML = "";
  const sessions = await _getMusicSessions();
  if (sessions.length === 0) return;

  // Group by date like image studio and chat
  const dateGroups = _groupSessionsByDate(sessions.map(s => ({ ...s, timestamp: s.latestTimestamp })));
  Object.entries(dateGroups).forEach(([label, items]) => {
    if (!items.length) return;
    const gl = document.createElement("div");
    gl.className = "conv-group-label";
    gl.textContent = label;
    list.appendChild(gl);
    items.forEach(sess => list.appendChild(_makeMusicSessionItem(sess)));
  });
}

function _makeMusicSessionItem(sess) {
    const item = document.createElement("div");
    item.className = "sb-item music-session-item" + (sess.session_id === activeMusicSessionId ? " active" : "");
    item.dataset.sessionId = sess.session_id;
    item.draggable = true;
    const badge = `<span class="sb-item-badge music-session-badge">${sess.trackCount}</span>`;
    item.innerHTML = `
      <span class="sb-item-title music-session-prompt">${esc(sess.firstPrompt || "Untitled")}</span>
      ${badge}
      <button class="sb-item-menu music-session-menu" title="Options">&hellip;</button>
    `;
    item.addEventListener("dragstart", e => {
      e.dataTransfer.setData("text/music-session", sess.session_id);
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => item.classList.remove("dragging"));
    item.addEventListener("click", (e) => {
      if (e.target.closest(".music-session-menu")) return;
      activeMusicSessionId = sess.session_id;
      localStorage.setItem("diab_music_session", activeMusicSessionId);
      renderMusicSessionsList();
      restoreMusicTracks();
    });
    item.querySelector(".music-session-menu").addEventListener("click", (e) => {
      e.stopPropagation();
      _showMusicSessionMenu(sess, item, e);
    });
    return item;
}

function _showMusicSessionMenu(sess, itemEl, e) {
  document.querySelectorAll(".ctx-menu, .music-folder-sub-menu").forEach(m => m.remove());
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.cssText = `position:fixed;z-index:9999;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:4px;min-width:160px;box-shadow:0 8px 24px rgba(0,0,0,0.3);`;

  // Rename
  const renameItem = document.createElement("div");
  renameItem.style.cssText = "padding:6px 12px;cursor:pointer;font-size:0.8rem;border-radius:6px;color:var(--text-dim);";
  renameItem.textContent = "Rename";
  renameItem.addEventListener("mouseenter", () => renameItem.style.background = "var(--surface2)");
  renameItem.addEventListener("mouseleave", () => renameItem.style.background = "");
  renameItem.addEventListener("click", async () => {
    menu.remove();
    const name = prompt("Rename session:", sess.firstPrompt);
    if (!name?.trim()) return;
    try {
      const firstRec = sess.records[sess.records.length - 1];
      if (firstRec) {
        const db = await openMusicDB();
        const tx = db.transaction("tracks", "readwrite");
        const store = tx.objectStore("tracks");
        const existing = await new Promise(r => { const g = store.get(firstRec.id); g.onsuccess = () => r(g.result); });
        if (existing) { existing.title = name.trim(); store.put(existing); }
      }
    } catch {}
    renderMusicSessionsList();
  });
  menu.appendChild(renameItem);

  // Move to Folder
  if (musicFolders.length > 1) {
    const moveWrap = document.createElement("div");
    moveWrap.style.position = "relative";
    const moveBtn = document.createElement("div");
    moveBtn.style.cssText = "padding:6px 12px;cursor:pointer;font-size:0.8rem;border-radius:6px;color:var(--text-dim);display:flex;align-items:center;justify-content:space-between;";
    moveBtn.innerHTML = `Move to Folder <span>&#x25B8;</span>`;
    moveBtn.addEventListener("mouseenter", () => {
      moveBtn.style.background = "var(--surface2)";
      document.querySelectorAll(".music-folder-sub-menu").forEach(m => m.remove());
      const sub = document.createElement("div");
      sub.className = "music-folder-sub-menu";
      sub.style.cssText = `position:fixed;z-index:1000;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,0.4);min-width:140px;`;
      const menuRect = menu.getBoundingClientRect();
      sub.style.left = (menuRect.right + 2) + "px";
      sub.style.top = moveBtn.getBoundingClientRect().top + "px";
      musicFolders.filter(c => c.id !== activeMusicFolderId).forEach(col => {
        const item = document.createElement("div");
        item.style.cssText = "padding:6px 12px;cursor:pointer;font-size:0.78rem;border-radius:6px;color:var(--text-dim);";
        item.textContent = col.name;
        item.addEventListener("mouseenter", () => item.style.background = "var(--surface2)");
        item.addEventListener("mouseleave", () => item.style.background = "");
        item.addEventListener("click", async () => {
          menu.remove(); sub.remove();
          try {
            const db = await openMusicDB();
            const tx = db.transaction("tracks", "readwrite");
            const store = tx.objectStore("tracks");
            for (const rec of sess.records) { rec.folder_id = col.id; store.put(rec); }
            await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
            sess.records.forEach(rec => {
              const el = musicCanvas.querySelector(`.music-result[data-music-id="${rec.id}"]`);
              if (el) el.remove();
            });
            renderMusicSessionsList();
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
    for (const rec of sess.records) {
      await saveMusicToTrash({
        id: _makeMusicTrashId(), deletedAt: Date.now(),
        audio: rec.audio, rawPrompt: rec.rawPrompt, title: rec.title || null, lyrics: rec.lyrics,
        body: rec.body, coverArt: rec.coverArt || null, duration: rec.duration, elapsed_s: rec.elapsed_s,
        model: rec.model, seed: rec.seed, sample_rate: rec.sample_rate,
        format: rec.format || "mp3",
        session_id: rec.session_id, folder_id: rec.folder_id,
      });
      await deleteMusicTrack(rec.id);
    }
    _refreshMusicTrashBadge();
    if (activeMusicSessionId === sess.session_id) {
      activeMusicSessionId = _newMusicSessionId();
      localStorage.setItem("diab_music_session", activeMusicSessionId);
    }
    renderMusicSessionsList();
    restoreMusicTracks();
  });
  menu.appendChild(deleteItem);

  const rect = itemEl.getBoundingClientRect();
  menu.style.top = rect.bottom + 4 + "px";
  menu.style.left = rect.left + "px";
  document.body.appendChild(menu);
  const _closeMenu = (ev) => {
    if (!menu.contains(ev.target) && !document.querySelector(".music-folder-sub-menu")?.contains(ev.target)) {
      menu.remove(); document.querySelectorAll(".music-folder-sub-menu").forEach(m => m.remove());
      document.removeEventListener("click", _closeMenu);
    }
  };
  setTimeout(() => document.addEventListener("click", _closeMenu), 10);
}

document.getElementById("music-new-session-btn").addEventListener("click", () => {
  activeMusicSessionId = _newMusicSessionId();
  localStorage.setItem("diab_music_session", activeMusicSessionId);
  renderMusicSessionsList();
  restoreMusicTracks();
  musicPrompt.focus();
});

// ── Music Folders ──
async function loadMusicFolders() {
  try {
    musicFolders = await loadAllMusicFolders();
    if (musicFolders.length === 0) {
      const defaultCol = { id: "mfolder_" + Date.now(), name: "My Music", description: "Default folder for generated music", timestamp: Date.now() };
      await saveMusicFolder(defaultCol);
      musicFolders = [defaultCol];
    }
    if (!activeMusicFolderId || !musicFolders.find(c => c.id === activeMusicFolderId)) {
      activeMusicFolderId = musicFolders[0].id;
      localStorage.setItem("diab_music_folder", activeMusicFolderId);
    }
    renderMusicFoldersSidebar();
  } catch (e) { console.warn("Failed to load music folders:", e); }
}

function renderMusicFoldersSidebar() {
  const list = document.getElementById("music-folders-list");
  if (!list) return;
  list.innerHTML = "";
  musicFolders.forEach(col => {
    const row = document.createElement("div");
    row.className = "sb-folder-row" + (col.id === activeMusicFolderId ? " active" : "");
    row.dataset.id = col.id;
    const iconSvg = `<svg class="sb-folder-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 3.5C1.5 2.948 1.948 2.5 2.5 2.5H6.086a1 1 0 0 1 .707.293L7.914 3.914A1 1 0 0 0 8.621 4.2H13.5c.552 0 1 .448 1 1v7.3c0 .552-.448 1-1 1h-11c-.552 0-1-.448-1-1V3.5z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>`;
    row.innerHTML = `${iconSvg}<div class="sb-folder-info"><div class="sb-folder-name">${esc(col.name)}</div>${col.description ? `<div class="sb-folder-desc">${esc(col.description)}</div>` : ""}</div><button class="sb-folder-menu" title="Options">⋯</button>`;
    row.addEventListener("click", e => {
      if (e.target.classList.contains("sb-folder-menu")) return;
      if (col.id === activeMusicFolderId) return;
      activeMusicFolderId = col.id;
      localStorage.setItem("diab_music_folder", col.id);
      renderMusicFoldersSidebar();
      // Reset session and reload
      activeMusicSessionId = null;
      localStorage.removeItem("diab_music_session");
      restoreMusicTracks();
      renderMusicSessionsList();
    });
    row.querySelector(".sb-folder-menu").addEventListener("click", e => {
      e.stopPropagation();
      showMusicColCtxMenu(col, e);
    });
    // Drag-and-drop target for music sessions
    row.addEventListener("dragover", e => {
      if (!e.dataTransfer.types.includes("text/music-session")) return;
      e.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", async e => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const sid = e.dataTransfer.getData("text/music-session");
      if (!sid) return;
      try {
        const allTracks = await loadAllMusicTracks();
        const matching = allTracks.filter(r => (r.session_id || "default") === sid);
        if (!matching.length) return;
        const db = await openMusicDB();
        const tx = db.transaction("tracks", "readwrite");
        const store = tx.objectStore("tracks");
        for (const rec of matching) {
          rec.folder_id = col.id;
          store.put(rec);
        }
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
        // Remove moved session cards from current canvas
        matching.forEach(rec => {
          const resultEl = musicCanvas.querySelector(`.music-result[data-music-id="${rec.id}"]`);
          if (resultEl) resultEl.remove();
        });
        renderMusicSessionsList();
      } catch (err) { console.warn("Failed to move music session:", err); }
    });
    list.appendChild(row);
  });
}

function showMusicColCtxMenu(col, e) {
  document.querySelectorAll(".music-folder-ctx-menu").forEach(el => el.remove());
  const menu = document.createElement("div");
  menu.className = "music-folder-ctx-menu";
  menu.style.cssText = `position:fixed;z-index:999;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,0.4);min-width:120px;`;
  menu.innerHTML = `
    <div class="music-folder-ctx-item" data-action="rename" style="padding:6px 12px;cursor:pointer;font-size:0.8rem;border-radius:6px;color:var(--text-dim);">Edit</div>
    <div class="music-folder-ctx-item" data-action="delete" style="padding:6px 12px;cursor:pointer;font-size:0.8rem;border-radius:6px;color:var(--danger);">Delete</div>
  `;
  menu.style.left = e.clientX + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - 80) + "px";
  document.body.appendChild(menu);
  menu.querySelector('[data-action="rename"]').addEventListener("click", () => {
    menu.remove();
    openMusicFolderModal(col);
  });
  menu.querySelector('[data-action="delete"]').addEventListener("click", async () => {
    menu.remove();
    if (musicFolders.length <= 1) { showToast("At least one folder must exist."); return; }
    const confirmed = await showConfirm({ title: "Delete Folder", message: `Delete "${col.name}"? All tracks will be moved to trash.` });
    if (!confirmed) return;
    const allTracks = await loadAllMusicTracks();
    const toDelete = allTracks.filter(r => r.folder_id === col.id);
    for (const t of toDelete) {
      await saveMusicToTrash({
        id: _makeMusicTrashId(), deletedAt: Date.now(),
        audio: t.audio, rawPrompt: t.rawPrompt, title: t.title || null, lyrics: t.lyrics,
        body: t.body, coverArt: t.coverArt || null, duration: t.duration, elapsed_s: t.elapsed_s,
        model: t.model, seed: t.seed, sample_rate: t.sample_rate,
        format: t.format || "mp3",
        session_id: t.session_id, folder_id: t.folder_id,
      });
      await deleteMusicTrack(t.id);
    }
    _refreshMusicTrashBadge();
    await deleteMusicFolder(col.id);
    musicFolders = musicFolders.filter(c => c.id !== col.id);
    if (activeMusicFolderId === col.id) {
      activeMusicFolderId = musicFolders[0].id;
      localStorage.setItem("diab_music_folder", activeMusicFolderId);
    }
    renderMusicFoldersSidebar();
    activeMusicSessionId = null;
    localStorage.removeItem("diab_music_session");
    restoreMusicTracks();
    renderMusicSessionsList();
  });
  menu.querySelectorAll(".music-folder-ctx-item").forEach(item => {
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

// Music Folder modal
let _editingMusicFolderId = null;
function openMusicFolderModal(col) {
  _editingMusicFolderId = col ? col.id : null;
  document.getElementById("music-folder-modal-title").textContent = col ? "Edit Folder" : "New Folder";
  document.getElementById("music-folder-name").value = col?.name || "";
  document.getElementById("music-folder-desc").value = col?.description || "";
  document.getElementById("music-folder-save").textContent = col ? "Save" : "Create Folder";
  document.getElementById("music-folder-modal").classList.add("open");
  document.getElementById("music-folder-name").focus();
}
function closeMusicFolderModal() {
  document.getElementById("music-folder-modal").classList.remove("open");
  _editingMusicFolderId = null;
}
document.getElementById("music-folder-modal-close").addEventListener("click", closeMusicFolderModal);
document.getElementById("music-folder-cancel").addEventListener("click", closeMusicFolderModal);
document.getElementById("music-folder-modal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeMusicFolderModal();
});
document.getElementById("music-folder-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("music-folder-save").click();
  if (e.key === "Escape") closeMusicFolderModal();
});
document.getElementById("music-folder-save").addEventListener("click", async () => {
  const name = document.getElementById("music-folder-name").value.trim();
  const description = document.getElementById("music-folder-desc").value.trim() || "";
  if (!name) { document.getElementById("music-folder-name").focus(); return; }
  if (_editingMusicFolderId) {
    const col = musicFolders.find(c => c.id === _editingMusicFolderId);
    if (col) { col.name = name; col.description = description; await saveMusicFolder(col); }
  } else {
    const col = { id: "mfolder_" + Date.now(), name, description, timestamp: Date.now() };
    await saveMusicFolder(col);
    musicFolders.push(col);
    activeMusicFolderId = col.id;
    localStorage.setItem("diab_music_folder", col.id);
    activeMusicSessionId = null;
    localStorage.removeItem("diab_music_session");
    restoreMusicTracks();
    renderMusicSessionsList();
  }
  closeMusicFolderModal();
  renderMusicFoldersSidebar();
});
document.getElementById("music-folder-new-btn").addEventListener("click", () => openMusicFolderModal(null));

// ── Music favorites panel ──
function updateMusicFavCount(count) {
  if (musicFavBadge) {
    musicFavBadge.textContent = count;
    musicFavBadge.style.display = count > 0 ? "" : "none";
  }
  if (musicFavCountLabel) musicFavCountLabel.textContent = count;
}

async function refreshMusicFavoritesPanel() {
  const favs = await loadAllMusicFavorites();
  favs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  updateMusicFavCount(favs.length);
  const emptyEl = document.getElementById("music-fav-empty");
  // Clear existing cards
  musicFavContent.querySelectorAll(".music-fav-card").forEach(c => c.remove());
  if (favs.length === 0) {
    if (emptyEl) emptyEl.style.display = "";
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";
  for (const fav of favs) {
    musicFavContent.appendChild(_createMusicFavCard(fav));
  }
}

function _createMusicFavCard(fav) {
  const card = document.createElement("div");
  card.className = "music-fav-card";
  card.dataset.favId = fav.id;

  // Decode audio
  const byteStr = atob(fav.audio);
  const bytes = new Uint8Array(byteStr.length);
  for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
  const _favMime = (fav.format === "wav") ? "audio/wav" : "audio/mpeg";
  const blob = new Blob([bytes], { type: _favMime });
  const audioUrl = URL.createObjectURL(blob);
  const audio = new Audio(audioUrl);

  const coverSrc = fav.coverArt ? `<img src="data:image/png;base64,${fav.coverArt}" alt="" />` : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M9 8l6 4-6 4V8z" fill="var(--text-faint)" stroke="none"/></svg>`;
  const durStr = fav.duration ? _formatMusicTime(fav.duration) : "";
  card.innerHTML = `
    <div class="music-fav-cover">
      ${coverSrc}
      <button class="music-fav-play" title="Play/Pause">
        ${icon("play", 16)}
      </button>
    </div>
    <div class="music-fav-info">
      <div class="music-fav-title">${esc(fav.title || fav.rawPrompt || "Untitled")}</div>
      <div class="music-fav-duration">${durStr}</div>
    </div>
    <div class="music-fav-card-actions">
      <button class="music-action-btn music-fav-dl" title="Download">${icon("download", 12)}</button>
      <button class="music-action-btn music-fav-reuse" title="Reuse settings">${icon("refresh", 12)}</button>
      <button class="music-action-btn music-fav-remove" title="Remove from favorites">${icon("heart", 12)}</button>
    </div>
  `;

  const playBtn = card.querySelector(".music-fav-play");

  let isPlaying = false;
  playBtn.addEventListener("click", () => {
    if (isPlaying) {
      audio.pause(); playBtn.classList.remove("playing");
      playBtn.innerHTML = icon("play", 16);
    } else {
      document.querySelectorAll(".music-fav-play.playing").forEach(b => b.click());
      audio.play(); playBtn.classList.add("playing");
      playBtn.innerHTML = icon("pause", 16);
    }
    isPlaying = !isPlaying;
  });
  audio.addEventListener("ended", () => {
    isPlaying = false; playBtn.classList.remove("playing");
    playBtn.innerHTML = icon("play", 16);
  });

  // Download
  card.querySelector(".music-fav-dl").addEventListener("click", () => {
    const a = document.createElement("a"); a.href = audioUrl;
    a.download = (fav.title || fav.rawPrompt || "music").slice(0, 40).replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, "_") + ((fav.format === "wav") ? ".wav" : ".mp3");
    a.click();
  });

  // Reuse settings
  card.querySelector(".music-fav-reuse").addEventListener("click", () => {
    if (fav.rawPrompt) musicPrompt.value = fav.rawPrompt;
    if (fav.body) {
      if (fav.body.duration) document.getElementById("music-duration").value = fav.body.duration;
      if (fav.body.infer_steps) document.getElementById("music-steps").value = fav.body.infer_steps;
      if (fav.body.guidance_scale) document.getElementById("music-guidance").value = fav.body.guidance_scale;
      _updateMusicSettingsSummary();
      // Trigger input events for slider display
      document.getElementById("music-duration").dispatchEvent(new Event("input"));
      document.getElementById("music-steps").dispatchEvent(new Event("input"));
      document.getElementById("music-guidance").dispatchEvent(new Event("input"));
    }
    if (fav.body.batch_size) {
      document.querySelectorAll("#music-count-row .studio-count-btn").forEach(b => b.classList.toggle("active", b.dataset.count === String(fav.body.batch_size)));
    }
    if (fav.body.vocal_language) {
      document.getElementById("music-vocal-language").value = fav.body.vocal_language;
    }
    if (fav.lyrics && fav.lyrics !== "[Instrumental]") {
      musicLyrics.value = fav.lyrics;
      document.getElementById("music-settings-crumb").classList.add("open");
      document.getElementById("music-settings-panel").classList.add("open");
    } else {
      musicLyrics.value = "";
    }
    _updateMusicSettingsSummary();
    musicPrompt.focus();
  });

  // Remove from favorites
  card.querySelector(".music-fav-remove").addEventListener("click", async () => {
    await deleteMusicFavorite(fav.id);
    card.remove();
    // Sync heart on canvas card
    const canvasCard = musicCanvas.querySelector(`[data-music-id="${fav.id}"]`);
    if (canvasCard) {
      const heartBtn = canvasCard.querySelector(".music-fav-btn");
      if (heartBtn) heartBtn.classList.remove("is-fav");
    }
    refreshMusicFavoritesPanel();
  });

  return card;
}

musicFavToggle.addEventListener("click", () => {
  const isOpen = musicFavPanel.classList.toggle("open");
  musicFavToggle.classList.toggle("active", isOpen);
  if (isOpen) refreshMusicFavoritesPanel();
  localStorage.setItem("diab_music_fav_open", isOpen ? "1" : "0");
});
document.getElementById("music-fav-close").addEventListener("click", () => {
  musicFavPanel.classList.remove("open");
  musicFavToggle.classList.remove("active");
  localStorage.setItem("diab_music_fav_open", "0");
});

// ── Music view switching ──
// showMusicStudio, hideMusicStudio, toggleMusicStudio defined above in centralized view switching

function toggleMusicStudio() {
  if (musicStudio.classList.contains("active")) return;
  showMusicStudio();
}
document.getElementById("music-sidebar-btn").addEventListener("click", toggleMusicStudio);
document.getElementById("strip-music-btn").addEventListener("click", toggleMusicStudio);

// ── Music settings panel ──
document.getElementById("music-settings-trigger").addEventListener("click", function() {
  document.getElementById("music-settings-crumb").classList.toggle("open");
  document.getElementById("music-settings-panel").classList.toggle("open");
});

// ── Music style presets ──
const MUSIC_PRESETS = {
  "pop":          { suffix: "pop, catchy melody, polished production, upbeat" },
  "rock":         { suffix: "rock, electric guitar, drums, energetic, powerful" },
  "hip-hop":      { suffix: "hip-hop, trap beats, 808 bass, modern rap production" },
  "jazz":         { suffix: "jazz, smooth saxophone, piano chords, swing rhythm, warm" },
  "classical":    { suffix: "classical, orchestral, strings, piano, elegant composition" },
  "electronic":   { suffix: "electronic, synth, EDM, pulsing bass, atmospheric pads" },
  "r&b":          { suffix: "R&B, soulful vocals, smooth groove, modern R&B production" },
  "country":      { suffix: "country, acoustic guitar, fiddle, storytelling, Nashville" },
  "lo-fi":        { suffix: "lo-fi, chill beats, vinyl crackle, mellow, relaxing" },
  "ambient":      { suffix: "ambient, ethereal pads, atmospheric, dreamy, soundscape" },
};
const MUSIC_CUSTOM_PRESETS_KEY = "diab_music_custom_presets";
const _bpmSteps = [70, 90, 110, 120, 140, 170];
let musicActivePreset = null;
function getMusicCustomPresets() {
  try { return JSON.parse(localStorage.getItem(MUSIC_CUSTOM_PRESETS_KEY) || "{}"); } catch { return {}; }
}
function saveMusicCustomPresets(presets) {
  localStorage.setItem(MUSIC_CUSTOM_PRESETS_KEY, JSON.stringify(presets));
}
function getAllMusicPresets() {
  return { ...MUSIC_PRESETS, ...getMusicCustomPresets() };
}
function renderMusicPresetButtons() {
  const grid = document.getElementById("music-preset-grid");
  grid.innerHTML = "";
  const all = getAllMusicPresets();
  const custom = getMusicCustomPresets();
  Object.keys(all).forEach(key => {
    const btn = document.createElement("button");
    btn.className = "studio-preset-btn" + (musicActivePreset === key ? " active" : "");
    btn.dataset.preset = key;
    const isCustom = key in custom;
    const label = key.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    btn.innerHTML = label + (isCustom ? ` <span class="preset-del" title="Delete preset">&times;</span>` : "");
    btn.addEventListener("click", (e) => {
      if (e.target.classList.contains("preset-del")) {
        const cp = getMusicCustomPresets();
        delete cp[key];
        saveMusicCustomPresets(cp);
        if (musicActivePreset === key) musicActivePreset = null;
        renderMusicPresetButtons();
        return;
      }
      musicActivePreset = (musicActivePreset === key) ? null : key;
      renderMusicPresetButtons();
      _updateMusicSettingsSummary();
    });
    grid.appendChild(btn);
  });
}
renderMusicPresetButtons();

document.getElementById("music-save-preset-btn").addEventListener("click", () => {
  const nameInput = document.getElementById("music-custom-preset-name");
  const name = nameInput.value.trim();
  if (!name) return;
  const key = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9&-]/g, "");
  if (!key) return;
  const cp = getMusicCustomPresets();
  cp[key] = { suffix: name.toLowerCase() };
  saveMusicCustomPresets(cp);
  nameInput.value = "";
  musicActivePreset = key;
  renderMusicPresetButtons();
  _updateMusicSettingsSummary();
});

function _updateMusicSettingsSummary() {
  const durVal = parseInt(document.getElementById("music-duration").value);
  const durStr = durVal >= 60 ? Math.floor(durVal/60) + "m" + (durVal%60 ? String(durVal%60).padStart(2,"0") + "s" : "") : durVal + "s";
  const bpm = _bpmSteps[document.getElementById("music-bpm").value];
  const lyricsText = document.getElementById("music-lyrics")?.value?.trim() || "";
  let parts = [`${durStr}`, `${bpm} bpm`];
  if (musicActivePreset) {
    parts.push(musicActivePreset.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "));
  }
  if (lyricsText) {
    const lineCount = lyricsText.split("\n").filter(l => l.trim()).length;
    parts.push(`${lineCount} line${lineCount !== 1 ? "s" : ""}`);
  }
  document.getElementById("music-settings-summary").textContent = parts.join(" · ");
}

// Settings sliders live values
document.getElementById("music-duration").addEventListener("input", function() {
  const v = parseInt(this.value);
  document.getElementById("music-duration-val").textContent = v >= 60 ? Math.floor(v/60) + "m" + (v%60 ? String(v%60).padStart(2,"0") + "s" : "") : v + "s";
  _updateMusicSettingsSummary();
});
document.getElementById("music-steps").addEventListener("input", function() {
  document.getElementById("music-steps-val").textContent = this.value;
  _updateMusicSettingsSummary();
});
document.getElementById("music-guidance").addEventListener("input", function() {
  document.getElementById("music-guidance-val").textContent = parseFloat(this.value).toFixed(1);
  _updateMusicSettingsSummary();
});
document.getElementById("music-bpm").addEventListener("input", function() {
  document.getElementById("music-bpm-val").textContent = _bpmSteps[this.value];
  _updateMusicSettingsSummary();
});

// Count buttons (batch size)
document.querySelectorAll("#music-count-row .studio-count-btn").forEach(btn => {
  btn.addEventListener("click", function() {
    document.querySelectorAll("#music-count-row .studio-count-btn").forEach(b => b.classList.remove("active"));
    this.classList.add("active");
    _updateMusicSettingsSummary();
  });
});

// Vocal language
document.getElementById("music-vocal-language").addEventListener("change", _updateMusicSettingsSummary);

// Lyrics change updates summary
document.getElementById("music-lyrics").addEventListener("input", _updateMusicSettingsSummary);

// Advanced toggle
document.getElementById("music-advanced-toggle").addEventListener("click", function() {
  this.classList.toggle("open");
  document.getElementById("music-advanced-body").classList.toggle("open");
});

// Seed randomize
document.getElementById("music-random-seed").addEventListener("click", () => {
  document.getElementById("music-seed").value = "";
});

// ── Music prompt auto-resize ──
musicPrompt.addEventListener("input", function() {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 140) + "px";
});

// ── Music waveform drawing ──
const _musicAudioCtx = new (window.AudioContext || window.webkitAudioContext)();

function drawMusicWaveform(canvas, audioBuffer) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const data = audioBuffer.getChannelData(0);
  const step = Math.ceil(data.length / w);
  const mid = h / 2;

  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#6366f1";
  ctx.fillStyle = accent;

  for (let i = 0; i < w; i++) {
    let min = 1, max = -1;
    for (let j = 0; j < step; j++) {
      const val = data[i * step + j] || 0;
      if (val < min) min = val;
      if (val > max) max = val;
    }
    const barH = Math.max(2, (max - min) * mid);
    ctx.fillRect(i, mid - barH / 2, 1, barH);
  }
}

function _formatMusicTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ":" + String(sec).padStart(2, "0");
}

// ── Create music result card ──
function createMusicResultCard(record) {
  const el = document.createElement("div");
  el.className = "music-result";
  el.dataset.musicId = record.id;

  // Decode base64 audio to blob
  const rawB64 = record.audio;
  const byteStr = atob(rawB64);
  const bytes = new Uint8Array(byteStr.length);
  for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
  const _recMime = (record.format === "wav") ? "audio/wav" : "audio/mpeg";
  const blob = new Blob([bytes], { type: _recMime });
  const audioUrl = URL.createObjectURL(blob);
  const audio = new Audio(audioUrl);

  const hasLyrics = record.lyrics && record.lyrics !== "[Instrumental]";
  const lyricsToggleHtml = hasLyrics
    ? `<button class="music-lyrics-toggle">${icon("chevron-down", 8)} Lyrics</button>` : "";
  const lyricsBodyHtml = hasLyrics ? `<div class="music-meta-lyrics">${esc(record.lyrics)}</div>` : "";
  const pills = [];
  pills.push(record.model || "ACE-Step 1.5");
  if (record.duration) pills.push(record.duration + "s");
  if (record.body?.infer_steps) pills.push(record.body.infer_steps + " steps");
  if (record.body?.guidance_scale) pills.push("cfg " + record.body.guidance_scale);
  if (record.body?.bpm) pills.push(record.body.bpm + " bpm");
  if (record.elapsed_s) pills.push(record.elapsed_s + "s");

  const coverHtml = record.coverArt
    ? `<img src="data:image/png;base64,${record.coverArt}" alt="Cover art" />`
    : record._pendingCoverArt
      ? `<div class="cover-spinner"></div>`
      : "";

  el.innerHTML = `
    ${coverHtml ? `<div class="music-result-cover">${coverHtml}<button class="img-fav-solo music-fav-btn" title="Favorite">${icon("heart", 18)}</button></div>` : ""}
    <div class="music-result-body">
      <div class="music-result-player">
        <button class="music-play-btn" title="Play/Pause">
          ${icon("play", 16)}
        </button>
        <div class="music-waveform-wrap">
          <canvas></canvas>
          <div class="music-waveform-progress"></div>
        </div>
        <span class="music-time">0:00 / ${_formatMusicTime(record.duration || 0)}</span>
      </div>
      <div class="music-meta-details">
        ${record.title ? `<div class="music-meta-title">${esc(record.title)}</div>` : ""}
        <div class="music-meta-prompt">${esc(record.rawPrompt)}</div>
        <div class="music-meta-bottom">
          <div class="music-meta-pills">
            ${pills.map(p => `<span class="meta-pill">${esc(p)}</span>`).join("")}
            <button class="music-prompt-toggle">${icon("chevron-down", 8)} Prompt</button>
            ${lyricsToggleHtml}
          </div>
          <div class="music-result-actions">
            <button class="music-action-btn music-reuse" title="Reuse settings">
              ${icon("refresh", 12)}
            </button>
            <button class="music-action-btn music-dl" title="Download">
              ${icon("download", 12)}
            </button>
            <button class="music-action-btn music-del" title="Delete">
              ${icon("trash-simple", 12)}
            </button>
          </div>
        </div>
        ${lyricsBodyHtml}
      </div>
    </div>
  `;

  const playBtn = el.querySelector(".music-play-btn");
  const waveWrap = el.querySelector(".music-waveform-wrap");
  const waveCanvas = el.querySelector("canvas");
  const waveProgress = el.querySelector(".music-waveform-progress");
  const timeEl = el.querySelector(".music-time");
  const favBtn = el.querySelector(".music-fav-btn");

  // Lyrics toggle
  const lyricsToggle = el.querySelector(".music-lyrics-toggle");
  if (lyricsToggle) {
    lyricsToggle.addEventListener("click", () => {
      lyricsToggle.classList.toggle("open");
      el.querySelector(".music-meta-lyrics").classList.toggle("open");
    });
  }

  // Prompt toggle
  const promptToggle = el.querySelector(".music-prompt-toggle");
  if (promptToggle) {
    promptToggle.addEventListener("click", () => {
      promptToggle.classList.toggle("open");
      el.querySelector(".music-meta-prompt").classList.toggle("open");
    });
  }

  // Check if already favorited
  isMusicFavorite(record.id).then(isFav => {
    if (isFav) favBtn.classList.add("is-fav");
  });

  // Draw waveform after audio is decoded AND canvas is in the DOM with dimensions
  fetch(audioUrl).then(r => r.arrayBuffer()).then(buf => {
    _musicAudioCtx.decodeAudioData(buf.slice(0), decoded => {
      function _tryDraw() {
        if (waveCanvas.clientWidth > 0) {
          drawMusicWaveform(waveCanvas, decoded);
        } else {
          requestAnimationFrame(_tryDraw);
        }
      }
      _tryDraw();
    });
  }).catch(() => {});

  // Play/pause
  let isPlaying = false;
  playBtn.addEventListener("click", () => {
    if (isPlaying) {
      audio.pause();
      playBtn.classList.remove("playing");
      playBtn.innerHTML = icon("play", 16);
    } else {
      document.querySelectorAll(".music-play-btn.playing").forEach(btn => btn.click());
      audio.play();
      playBtn.classList.add("playing");
      playBtn.innerHTML = '';
    }
    isPlaying = !isPlaying;
  });

  audio.addEventListener("ended", () => {
    isPlaying = false;
    playBtn.classList.remove("playing");
    playBtn.innerHTML = icon("play", 16);
    waveProgress.style.width = "0%";
  });

  audio.addEventListener("timeupdate", () => {
    if (audio.duration) {
      const pct = (audio.currentTime / audio.duration) * 100;
      waveProgress.style.width = pct + "%";
      timeEl.textContent = _formatMusicTime(audio.currentTime) + " / " + _formatMusicTime(audio.duration);
    }
  });

  // Click-to-seek on waveform
  waveWrap.addEventListener("click", (e) => {
    const rect = waveWrap.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    if (audio.duration) audio.currentTime = pct * audio.duration;
  });

  // Favorite toggle
  favBtn.addEventListener("click", async () => {
    const isActive = favBtn.classList.contains("is-fav");
    if (isActive) {
      await deleteMusicFavorite(record.id);
      favBtn.classList.remove("is-fav");
    } else {
      await saveMusicFavorite({
        id: record.id,
        audio: record.audio,
        rawPrompt: record.rawPrompt,
        title: record.title || null,
        lyrics: record.lyrics,
        body: record.body,
        coverArt: record.coverArt || null,
        duration: record.duration,
        elapsed_s: record.elapsed_s,
        model: record.model,
        seed: record.seed,
        sample_rate: record.sample_rate,
        format: record.format || "mp3",
        timestamp: Date.now(),
      });
      favBtn.classList.add("is-fav");
    }
    if (musicFavPanel.classList.contains("open")) refreshMusicFavoritesPanel();
  });

  // Reuse settings
  el.querySelector(".music-reuse").addEventListener("click", () => {
    if (record.rawPrompt) musicPrompt.value = record.rawPrompt;
    if (record.body) {
      if (record.body.duration) document.getElementById("music-duration").value = record.body.duration;
      if (record.body.infer_steps) document.getElementById("music-steps").value = record.body.infer_steps;
      if (record.body.guidance_scale) document.getElementById("music-guidance").value = record.body.guidance_scale;
      _updateMusicSettingsSummary();
      document.getElementById("music-duration").dispatchEvent(new Event("input"));
      document.getElementById("music-steps").dispatchEvent(new Event("input"));
      document.getElementById("music-guidance").dispatchEvent(new Event("input"));
    }
    if (record.body?.vocal_language) document.getElementById("music-vocal-language").value = record.body.vocal_language;
    if (record.lyrics && record.lyrics !== "[Instrumental]") {
      musicLyrics.value = record.lyrics;
      document.getElementById("music-settings-crumb").classList.add("open");
      document.getElementById("music-settings-panel").classList.add("open");
    } else {
      musicLyrics.value = "";
    }
    _updateMusicSettingsSummary();
    musicPrompt.focus();
  });

  // Download
  el.querySelector(".music-dl").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = audioUrl;
    const safeName = (record.title || record.rawPrompt || "music").slice(0, 40).replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, "_");
    const _dlExt = (record.format === "wav") ? ".wav" : ".mp3";
    a.download = safeName + _dlExt;
    a.click();
  });

  // Delete (move to trash)
  el.querySelector(".music-del").addEventListener("click", async () => {
    await saveMusicToTrash({
      id: _makeMusicTrashId(), deletedAt: Date.now(),
      audio: record.audio, rawPrompt: record.rawPrompt, title: record.title || null, lyrics: record.lyrics,
      body: record.body, coverArt: record.coverArt || null, duration: record.duration, elapsed_s: record.elapsed_s,
      model: record.model, seed: record.seed, sample_rate: record.sample_rate,
      format: record.format || "mp3",
      session_id: record.session_id, folder_id: record.folder_id,
    });
    await deleteMusicTrack(record.id);
    _refreshMusicTrashBadge();
    el.remove();
    audio.pause();
    URL.revokeObjectURL(audioUrl);
    if (!musicCanvas.querySelector(".music-result")) musicCanvasEmpty.style.display = "";
    renderMusicSessionsList();
  });

  return el;
}

// ── Restore saved tracks (filtered by active session) ──
async function restoreMusicTracks() {
  try {
    const tracks = await loadAllMusicTracks();
    const filtered = tracks.filter(t =>
      (t.folder_id || null) === (activeMusicFolderId || null) &&
      (!activeMusicSessionId || t.session_id === activeMusicSessionId)
    );
    const sessionTracks = filtered;
    sessionTracks.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    // Remove existing cards
    musicCanvas.querySelectorAll(".music-result, .gen-progress").forEach(el => el.remove());
    if (sessionTracks.length === 0) {
      musicCanvasEmpty.style.display = "";
      return;
    }
    musicCanvasEmpty.style.display = "none";
    for (const track of sessionTracks) {
      musicCanvas.appendChild(createMusicResultCard(track));
    }
    musicCanvas.scrollTop = musicCanvas.scrollHeight;
  } catch (e) {
    console.error("Failed to restore music tracks:", e);
  }
}

// ── Shared generation progress component ──
function _createGenProgress() {
  const el = document.createElement("div");
  el.className = "gen-progress";
  el.innerHTML = `
    <div class="gen-cube-scene">
      <div class="gen-cube">
        <div class="gen-cube-face front visible"></div>
        <div class="gen-cube-face right"></div>
        <div class="gen-cube-face back"></div>
        <div class="gen-cube-face left"></div>
        <div class="gen-cube-face top"></div>
        <div class="gen-cube-face bottom"></div>
      </div>
    </div>
    <div class="gen-progress-status">Preparing...</div>
    <div class="gen-progress-bar"><div class="gen-progress-bar-fill"></div></div>
    <button class="gen-progress-stop">Stop</button>`;
  const cube = el.querySelector(".gen-cube");
  const faces = el.querySelectorAll(".gen-cube-face");
  const statusEl = el.querySelector(".gen-progress-status");
  const barFill = el.querySelector(".gen-progress-bar-fill");
  const stopBtn = el.querySelector(".gen-progress-stop");
  const thresholds = [0, 17, 33, 50, 67, 83];
  return {
    el, stopBtn,
    update(step, total, elapsed) {
      const pct = total > 0 ? Math.round(step / total * 100) : 0;
      barFill.style.width = pct + "%";
      faces.forEach((face, i) => {
        face.classList.toggle("visible", pct >= thresholds[i]);
      });
      cube.classList.toggle("complete", pct >= 100);
      if (step >= total && total > 0) {
        statusEl.textContent = `Finalizing... · ${elapsed}s`;
      } else {
        statusEl.textContent = `Step ${step}/${total} · ${elapsed}s`;
      }
    },
    setStatus(msg) { statusEl.textContent = msg; },
    destroy() { el.remove(); },
  };
}

// ── Music generation ──
let _musicGenerating = false;
let _musicProgressTimer = null;

async function musicGenerate() {
  if (_musicGenerating) return;
  const rawPrompt = musicPrompt.value.trim();
  if (!rawPrompt) return;
  if (!_modelReady.music) {
    showToast("Music model is loading, please wait...");
    return;
  }

  // Append style preset suffix if active
  let prompt = rawPrompt;
  if (musicActivePreset) {
    const allP = getAllMusicPresets();
    const preset = allP[musicActivePreset];
    if (preset && preset.suffix) prompt += ", " + preset.suffix;
  }

  _musicGenerating = true;
  musicGenerateBtn.disabled = true;
  musicCanvasEmpty.style.display = "none";

  const duration = parseFloat(document.getElementById("music-duration").value) || 30;
  const infer_steps = parseInt(document.getElementById("music-steps").value) || 40;
  const guidance_scale = parseFloat(document.getElementById("music-guidance").value) || 7.0;
  const seedVal = document.getElementById("music-seed").value.trim();
  const seed = seedVal ? parseInt(seedVal) : null;
  const lyrics = musicLyrics.value.trim() || null;
  const instrumental = !lyrics;
  const count = parseInt(document.querySelector("#music-count-row .studio-count-btn.active")?.dataset.count || "1");
  const vocal_language = !instrumental ? document.getElementById("music-vocal-language").value || null : null;
  const bpm = _bpmSteps[document.getElementById("music-bpm").value] || 120;

  const progress = _createGenProgress();
  musicCanvas.appendChild(progress.el);
  musicCanvas.scrollTop = musicCanvas.scrollHeight;

  // Poll progress
  const t0 = Date.now();
  let _currentIdx = 0;
  _musicProgressTimer = setInterval(async () => {
    try {
      const res = await mediaFetch("/music/progress");
      const data = await res.json();
      if (data.running && data.total_steps > 0) {
        const iterPct = (data.step / data.total_steps);
        const overallPct = Math.min(100, ((_currentIdx + iterPct) / count) * 100);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const overallStep = Math.round(overallPct / 100 * data.total_steps * count);
        const overallTotal = data.total_steps * count;
        progress.update(overallStep, overallTotal, elapsed);
        if (count > 1) {
          progress.setStatus(`Track ${_currentIdx + 1}/${count} · Step ${data.step}/${data.total_steps} · ${elapsed}s`);
        }
      }
    } catch {}
  }, 500);

  // Stop button
  let _aborted = false;
  progress.stopBtn.addEventListener("click", () => {
    _aborted = true;
    mediaFetch("/music/cancel", { method: "POST" }).catch(() => {});
    clearInterval(_musicProgressTimer);
    progress.destroy();
    _musicGenerating = false;
    musicGenerateBtn.disabled = false;
    if (!musicCanvas.querySelector(".music-result")) musicCanvasEmpty.style.display = "";
  });

  const sessionId = _ensureMusicSession();
  const cards = [];

  try {
    for (let i = 0; i < count; i++) {
      if (_aborted) return;
      _currentIdx = i;

      const body = { prompt, duration, infer_steps, guidance_scale, instrumental };
      // Use different seed for each variation
      if (seed !== null) {
        body.seed = seed + i;
      }
      if (lyrics) body.lyrics = lyrics;
      if (vocal_language) body.vocal_language = vocal_language;
      if (bpm) body.bpm = bpm;

      progress.setStatus(count > 1 ? `Generating track ${i + 1} of ${count}...` : "Generating...");

      const res = await mediaFetch("/music/generate", {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (_aborted) return;

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Generation failed");
      }

      const data = await res.json();
      // Ask LLM to name the song
      let songTitle = "";
      try {
        const nameResp = await mediaFetch("/music/name-song", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: rawPrompt, lyrics: lyrics || null }),
        });
        if (nameResp.ok) {
          const nameData = await nameResp.json();
          songTitle = (nameData.title || "").trim();
        }
      } catch (e) { console.warn("Song naming failed:", e); }

      const record = {
        id: "music_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6) + "_" + i,
        session_id: sessionId,
        folder_id: activeMusicFolderId || null,
        rawPrompt: rawPrompt,
        title: songTitle || null,
        lyrics: lyrics || (instrumental ? "[Instrumental]" : null),
        body: body,
        audio: data.audio,
        sample_rate: data.sample_rate || 48000,
        duration: data.duration,
        elapsed_s: data.elapsed_s,
        model: data.model || "ACE-Step 1.5",
        seed: data.seed,
        format: data.format || "mp3",
        timestamp: Date.now() + i,
        _pendingCoverArt: true,
      };
      await saveMusicTrack(record);
      const card = createMusicResultCard(record);
      card._musicRecord = record;
      cards.push(card);
    }

    clearInterval(_musicProgressTimer);

    // Replace progress with first card, append the rest
    progress.el.replaceWith(cards[0]);
    for (let i = 1; i < cards.length; i++) {
      musicCanvas.appendChild(cards[i]);
    }
    musicCanvas.scrollTop = musicCanvas.scrollHeight;
    renderMusicSessionsList();

    // Generate cover art in background (one per batch, shared across all tracks)
    (async () => {
      try {
        const artResp = await mediaFetch("/music/cover-art", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: rawPrompt, title: cards[0]?._musicRecord?.title || null, lyrics: lyrics || null }),
        });
        if (!artResp.ok) return;
        const artData = await artResp.json();
        const coverB64 = artData.image;
        if (!coverB64) return;
        // Update all cards in this batch with the cover art
        for (const card of cards) {
          const rec = card._musicRecord;
          if (!rec) continue;
          rec.coverArt = coverB64;
          // Update IndexedDB
          try {
            const mdb = await openMusicDB();
            const tx = mdb.transaction("tracks", "readwrite");
            const store = tx.objectStore("tracks");
            const existing = await new Promise(r => { const g = store.get(rec.id); g.onsuccess = () => r(g.result); });
            if (existing) { existing.coverArt = coverB64; store.put(existing); }
          } catch (_) {}
          // Update DOM - insert or replace cover
          let coverWrap = card.querySelector(".music-result-cover");
          if (coverWrap) {
            coverWrap.innerHTML = `<img src="data:image/png;base64,${coverB64}" alt="Cover art" />`;
          } else {
            coverWrap = document.createElement("div");
            coverWrap.className = "music-result-cover";
            coverWrap.innerHTML = `<img src="data:image/png;base64,${coverB64}" alt="Cover art" />`;
            card.prepend(coverWrap);
          }
        }
      } catch (_) {
        // Cover art is non-critical - just remove spinner covers
        for (const card of cards) {
          const cw = card.querySelector(".music-result-cover");
          if (cw && !cw.querySelector("img")) cw.remove();
        }
      }
    })();
  } catch (e) {
    if (!_aborted) {
      clearInterval(_musicProgressTimer);
      // If some tracks succeeded, show them before the error
      if (cards.length > 0) {
        progress.el.replaceWith(cards[0]);
        for (let i = 1; i < cards.length; i++) {
          musicCanvas.appendChild(cards[i]);
        }
        renderMusicSessionsList();
      } else {
        progress.setStatus("Error: " + (e.message || "Generation failed"));
        progress.stopBtn.textContent = "Dismiss";
        progress.stopBtn.addEventListener("click", () => {
          progress.destroy();
          if (!musicCanvas.querySelector(".music-result")) musicCanvasEmpty.style.display = "";
        }, { once: true });
      }
    }
  } finally {
    _musicGenerating = false;
    musicGenerateBtn.disabled = false;
  }
}

musicGenerateBtn.addEventListener("click", musicGenerate);
musicPrompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    musicGenerate();
  }
});

// ── Music Trash ──
const musicTrashModal = document.getElementById("music-trash-modal");
document.getElementById("music-trash-btn").addEventListener("click", () => openMusicTrashModal());
document.getElementById("music-trash-close-btn").addEventListener("click", () => musicTrashModal.classList.remove("open"));
musicTrashModal.addEventListener("click", e => { if (e.target === musicTrashModal) musicTrashModal.classList.remove("open"); });

async function openMusicTrashModal() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const all = await loadAllMusicTrash();
  for (const item of all) { if (item.deletedAt < cutoff) await deleteFromMusicTrash(item.id); }
  musicTrashModal.classList.add("open");
  await renderMusicTrashList();
}

async function renderMusicTrashList() {
  const list = document.getElementById("music-trash-list");
  const countLabel = document.getElementById("music-trash-count-label");
  const items = (await loadAllMusicTrash()).sort((a, b) => b.deletedAt - a.deletedAt);
  list.innerHTML = "";
  countLabel.textContent = items.length ? `${items.length} track${items.length !== 1 ? "s" : ""}` : "";
  updateMusicTrashBadge(items.length);
  items.forEach(item => {
    const card = document.createElement("div");
    card.className = "studio-trash-card";
    const age = _trashAge(item.deletedAt);
    const durStr = item.duration ? item.duration + "s" : "";
    card.innerHTML = `
      <button class="music-trash-play" title="Play/Pause">
        ${icon("play")}
      </button>
      <div class="studio-trash-card-info">
        <div class="studio-trash-card-prompt">${esc(item.title || item.rawPrompt || "Untitled")}</div>
        <div class="studio-trash-card-meta">${durStr}${durStr ? " · " : ""}Deleted ${age}</div>
      </div>
      <div class="studio-trash-card-actions">
        <button class="studio-trash-restore" title="Restore">${icon("refresh")}</button>
        <button class="studio-trash-del" title="Delete permanently">${icon("trash")}</button>
      </div>
    `;
    // Play/pause
    const playBtn = card.querySelector(".music-trash-play");
    let _trashAudio = null;
    let _trashPlaying = false;
    playBtn.addEventListener("click", () => {
      if (!_trashAudio && item.audio) {
        const byteStr = atob(item.audio);
        const bytes = new Uint8Array(byteStr.length);
        for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
        const mime = (item.format === "wav") ? "audio/wav" : "audio/mpeg";
        const blob = new Blob([bytes], { type: mime });
        _trashAudio = new Audio(URL.createObjectURL(blob));
        _trashAudio.addEventListener("ended", () => {
          _trashPlaying = false;
          playBtn.classList.remove("playing");
          playBtn.innerHTML = icon("play");
        });
      }
      if (!_trashAudio) return;
      if (_trashPlaying) {
        _trashAudio.pause();
        playBtn.classList.remove("playing");
        playBtn.innerHTML = icon("play");
      } else {
        // Stop any other playing trash audio
        document.querySelectorAll(".music-trash-play.playing").forEach(b => b.click());
        _trashAudio.play();
        playBtn.classList.add("playing");
        playBtn.innerHTML = '';
      }
      _trashPlaying = !_trashPlaying;
    });
    card.querySelector(".studio-trash-restore").addEventListener("click", async () => {
      if (_trashAudio) { _trashAudio.pause(); _trashAudio = null; }
      await _restoreFromMusicTrash(item);
      await deleteFromMusicTrash(item.id);
      card.remove();
      const remaining = list.querySelectorAll(".studio-trash-card").length;
      countLabel.textContent = remaining ? `${remaining} track${remaining !== 1 ? "s" : ""}` : "";
      updateMusicTrashBadge(remaining);
    });
    card.querySelector(".studio-trash-del").addEventListener("click", async () => {
      if (_trashAudio) { _trashAudio.pause(); _trashAudio = null; }
      await deleteFromMusicTrash(item.id);
      card.remove();
      const remaining = list.querySelectorAll(".studio-trash-card").length;
      countLabel.textContent = remaining ? `${remaining} track${remaining !== 1 ? "s" : ""}` : "";
      updateMusicTrashBadge(remaining);
    });
    list.appendChild(card);
  });
}

async function _restoreFromMusicTrash(item) {
  const record = {
    id: "music_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    session_id: item.session_id || _ensureMusicSession(),
    folder_id: item.folder_id || activeMusicFolderId || null,
    rawPrompt: item.rawPrompt,
    title: item.title || null,
    lyrics: item.lyrics,
    body: item.body || {},
    coverArt: item.coverArt || null,
    audio: item.audio,
    sample_rate: item.sample_rate || 48000,
    duration: item.duration,
    elapsed_s: item.elapsed_s,
    model: item.model,
    seed: item.seed,
    format: item.format || "mp3",
    timestamp: Date.now(),
  };
  await saveMusicTrack(record);
  // If restored to active music folder, re-render
  if ((record.folder_id || null) === (activeMusicFolderId || null)) {
    musicCanvas.appendChild(createMusicResultCard(record));
    musicCanvasEmpty.style.display = "none";
    renderMusicSessionsList();
  }
}

function updateMusicTrashBadge(count) {
  const badge = document.getElementById("music-trash-badge");
  if (badge) { badge.textContent = count || ""; }
}

async function _refreshMusicTrashBadge() {
  const items = await loadAllMusicTrash();
  updateMusicTrashBadge(items.length);
}

document.getElementById("music-trash-empty-btn").addEventListener("click", async () => {
  const count = document.querySelectorAll("#music-trash-list .studio-trash-card").length;
  if (!count) return;
  if (!confirm(`Permanently delete ${count} track${count !== 1 ? "s" : ""} from trash?`)) return;
  await emptyMusicTrash();
  updateMusicTrashBadge(0);
  musicTrashModal.classList.remove("open");
});

