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

// ── Global music playback control ──
// Only one audio stream plays at a time across all music contexts
let _activeMusicAudio = null;
let _activeMusicPlayBtn = null;

function stopAllMusicPlayback() {
  if (_activeMusicAudio) {
    _activeMusicAudio.pause();
    _activeMusicAudio.currentTime = 0;
  }
  if (_activeMusicPlayBtn) {
    _activeMusicPlayBtn.classList.remove("playing");
    _activeMusicPlayBtn.innerHTML = icon("play", 16);
  }
  _activeMusicAudio = null;
  _activeMusicPlayBtn = null;
}

function _setActiveMusicAudio(audio, playBtn) {
  if (_activeMusicAudio && _activeMusicAudio !== audio) {
    stopAllMusicPlayback();
  }
  _activeMusicAudio = audio;
  _activeMusicPlayBtn = playBtn;
}

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

  const origPrompt = desc;
  const box = document.getElementById("music-prompt-box");
  // Lock prompt + clear text so the shimmer is the only thing visible.
  // Mirrors the model-loading lock pattern in app.js _setModelLoading.
  musicPrompt.dataset.prevPlaceholder = musicPrompt.placeholder;
  musicPrompt.placeholder = "";
  musicPrompt.value = "";
  musicPrompt.classList.add("prompt-locked");
  if (box) box.querySelectorAll("button").forEach(b => b.disabled = true);

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

  // Inject the same shimmer + spinner markup the model loader uses
  // (.prompt-load-dots > .step-spinner + .prompt-load-text). The phrase
  // rotation now updates .prompt-load-primary instead of the textarea
  // value, so the look matches "loading model" while keeping the playful
  // copy.
  let _shimmer = box ? box.querySelector(".prompt-load-dots") : null;
  if (box && !_shimmer) {
    _shimmer = document.createElement("span");
    _shimmer.className = "prompt-load-dots";
    _shimmer.innerHTML = `<span class="step-spinner"></span><span class="prompt-load-text"><span class="prompt-load-primary"></span><span class="prompt-load-bytes"></span></span>`;
    box.prepend(_shimmer);
  }
  const _primaryEl = _shimmer ? _shimmer.querySelector(".prompt-load-primary") : null;
  let _phraseIdx = Math.floor(Math.random() * _songwritePhrases.length);
  if (_primaryEl) _primaryEl.textContent = _songwritePhrases[_phraseIdx];
  const _phraseTimer = setInterval(() => {
    _phraseIdx = (_phraseIdx + 1) % _songwritePhrases.length;
    if (_primaryEl) _primaryEl.textContent = _songwritePhrases[_phraseIdx];
  }, 2500);

  const langSel = document.getElementById("music-vocal-language");
  const lang = langSel.value || "en";

  try {
    const res = await mediaFetch("/music/write-song", {
      method: "POST",
      body: JSON.stringify({ description: desc, language: lang, model: localStorage.getItem("wooz_songwrite_model") || selectedModel || null }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Failed");
    }
    const data = await res.json();

    // Backend now guarantees data.lyrics is non-empty (returns 502 otherwise).
    if (data.lyrics) {
      const lyricsEl = document.getElementById("music-lyrics");
      if (lyricsEl) lyricsEl.value = data.lyrics;
      document.getElementById("music-settings-crumb").classList.add("open");
      document.getElementById("music-settings-panel").classList.add("open");
      _updateMusicSettingsSummary();
    }
  } catch (e) {
    console.error("AI Songwrite failed:", e);
    if (typeof showToast === "function") showToast("Songwriting failed: " + (e.message || "unknown error"), "error");
  } finally {
    clearInterval(_phraseTimer);
    if (_shimmer) _shimmer.remove();
    musicPrompt.placeholder = musicPrompt.dataset.prevPlaceholder || "";
    delete musicPrompt.dataset.prevPlaceholder;
    musicPrompt.classList.remove("prompt-locked");
    musicPrompt.value = origPrompt;
    musicPrompt.style.height = "auto";
    musicPrompt.style.height = Math.min(musicPrompt.scrollHeight, 140) + "px";
    if (box) box.querySelectorAll("button").forEach(b => b.disabled = false);
    musicPrompt.focus();
  }
});


// ── Music server-side persistence (via studio API) ──
const _musicAPI = createStudioAPI("music");

async function saveMusicTrack(record) { return _musicAPI.save("tracks", record); }
async function loadAllMusicTracks() { return _musicAPI.loadAll("tracks"); }
async function deleteMusicTrack(id) { return _musicAPI.remove("tracks", id); }
async function saveMusicFavorite(fav) { return _musicAPI.save("favorites", fav); }
async function deleteMusicFavorite(id) { return _musicAPI.remove("favorites", id); }
async function loadAllMusicFavorites() { return _musicAPI.loadAll("favorites"); }
async function isMusicFavorite(id) { return _musicAPI.has("favorites", id); }

// ── Music trash CRUD ──
async function saveMusicToTrash(item) { return _musicAPI.save("trash", item); }
async function loadAllMusicTrash() { return _musicAPI.loadAll("trash"); }
async function deleteFromMusicTrash(id) { return _musicAPI.remove("trash", id); }
async function emptyMusicTrash() { return _musicAPI.clear("trash"); }
function _makeMusicTrashId() {
  return "mtrash_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
}

// Helper: get audio playback URL from a record (blob URL from base64, or server URL)
function _musicAudioUrl(record) {
  if (record.audio) {
    const byteStr = atob(record.audio);
    const bytes = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
    const mime = (record.format === "wav") ? "audio/wav" : "audio/mpeg";
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  }
  return record._audioUrl || studioMediaUrl("music", record.id, "audio." + (record.format || "mp3"));
}

// Helper: ensure base64 audio is available on a record (fetches from server if needed)
async function _ensureMusicBase64(record) {
  if (record.audio) return record.audio;
  const url = record._audioUrl || studioMediaUrl("music", record.id, "audio." + (record.format || "mp3"));
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const b64 = await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.readAsDataURL(blob);
    });
    record.audio = b64;
    return b64;
  } catch { return null; }
}

// ── Music Folders CRUD ──
async function saveMusicFolder(col) { return _musicAPI.save("folders", col); }
async function deleteMusicFolder(id) { return _musicAPI.remove("folders", id); }
async function loadAllMusicFolders() { return _musicAPI.loadAll("folders"); }
let musicFolders = [];
let activeMusicFolderId = localStorage.getItem("wooz_music_folder") || null;

// ── Music sessions ──
let activeMusicSessionId = localStorage.getItem("wooz_music_session") || null;

function _newMusicSessionId() {
  const arr = new Uint8Array(12);
  crypto.getRandomValues(arr);
  return "msess_" + Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
}

function _ensureMusicSession() {
  if (!activeMusicSessionId) {
    activeMusicSessionId = _newMusicSessionId();
    localStorage.setItem("wooz_music_session", activeMusicSessionId);
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
      localStorage.setItem("wooz_music_session", activeMusicSessionId);
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
    const name = await showPromptModal({ title: "Rename Session", label: "Session name:", value: sess.firstPrompt });
    if (!name) return;
    try {
      const firstRec = sess.records[sess.records.length - 1];
      if (firstRec) {
        await apiFetch(`/studio/music/items/${firstRec.id}`, {
          method: "PATCH",
          body: JSON.stringify({ title: name.trim() }),
        });
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
            for (const rec of sess.records) {
              await apiFetch(`/studio/music/items/${rec.id}`, {
                method: "PATCH",
                body: JSON.stringify({ folder_id: col.id }),
              });
              const el = musicCanvas.querySelector(`.music-result[data-music-id="${rec.id}"]`);
              if (el) el.remove();
            }
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
      await apiFetch(`/studio/music/items/${rec.id}/trash`, { method: "POST" });
    }
    _refreshMusicTrashBadge();
    if (activeMusicSessionId === sess.session_id) {
      activeMusicSessionId = _newMusicSessionId();
      localStorage.setItem("wooz_music_session", activeMusicSessionId);
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
  localStorage.setItem("wooz_music_session", activeMusicSessionId);
  renderMusicSessionsList();
  restoreMusicTracks();
  musicPrompt.value = "";
  const _lyr = document.getElementById("music-lyrics");
  if (_lyr) _lyr.value = "";
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
      localStorage.setItem("wooz_music_folder", activeMusicFolderId);
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
      localStorage.setItem("wooz_music_folder", col.id);
      renderMusicFoldersSidebar();
      // Reset session and reload
      activeMusicSessionId = null;
      localStorage.removeItem("wooz_music_session");
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
        for (const rec of matching) {
          await apiFetch(`/studio/music/items/${rec.id}`, {
            method: "PATCH",
            body: JSON.stringify({ folder_id: col.id }),
          });
          const resultEl = musicCanvas.querySelector(`.music-result[data-music-id="${rec.id}"]`);
          if (resultEl) resultEl.remove();
        }
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
      await apiFetch(`/studio/music/items/${t.id}/trash`, { method: "POST" });
    }
    _refreshMusicTrashBadge();
    await deleteMusicFolder(col.id);
    musicFolders = musicFolders.filter(c => c.id !== col.id);
    if (activeMusicFolderId === col.id) {
      activeMusicFolderId = musicFolders[0].id;
      localStorage.setItem("wooz_music_folder", activeMusicFolderId);
    }
    renderMusicFoldersSidebar();
    activeMusicSessionId = null;
    localStorage.removeItem("wooz_music_session");
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
  document.getElementById("shared-folder-title").textContent = col ? "Edit Folder" : "New Folder";
  document.getElementById("shared-folder-hint").textContent = "Folders organize your generated music into separate groups.";
  document.getElementById("shared-folder-name").value = col?.name || "";
  document.getElementById("shared-folder-name").placeholder = "e.g. Ambient, Pop, Soundtracks";
  document.getElementById("shared-folder-desc").value = col?.description || "";
  document.getElementById("shared-folder-prompt-wrap").style.display = "none";
  document.getElementById("shared-folder-save").textContent = col ? "Save" : "Create Folder";
  document.getElementById("shared-folder-save").onclick = async () => {
    const name = document.getElementById("shared-folder-name").value.trim();
    const description = document.getElementById("shared-folder-desc").value.trim() || "";
    if (!name) { document.getElementById("shared-folder-name").focus(); return; }
    if (_editingMusicFolderId) {
      const col = musicFolders.find(c => c.id === _editingMusicFolderId);
      if (col) { col.name = name; col.description = description; await saveMusicFolder(col); }
    } else {
      const col = { id: "mfolder_" + Date.now(), name, description, timestamp: Date.now() };
      await saveMusicFolder(col);
      musicFolders.push(col);
      activeMusicFolderId = col.id;
      localStorage.setItem("wooz_music_folder", col.id);
      activeMusicSessionId = null;
      localStorage.removeItem("wooz_music_session");
      restoreMusicTracks();
      renderMusicSessionsList();
    }
    closeMusicFolderModal();
    renderMusicFoldersSidebar();
  };
  document.getElementById("shared-folder-modal").classList.add("open");
  setTimeout(() => document.getElementById("shared-folder-name").focus(), 50);
}
function closeMusicFolderModal() {
  document.getElementById("shared-folder-modal").classList.remove("open");
  _editingMusicFolderId = null;
}
document.getElementById("music-folder-new-btn").addEventListener("click", () => openMusicFolderModal(null));

// ── Music favorites panel ──
function updateMusicFavCount(count) {
  updateBadge("music-fav-badge", count);
  if (musicFavCountLabel) { musicFavCountLabel.textContent = count || ""; musicFavCountLabel.style.display = count ? "" : "none"; }
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

  // Audio playback URL (base64 blob or server URL)
  const audioUrl = _musicAudioUrl(fav);
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
      <button class="action-btn music-fav-edit" title="Edit">${icon("edit", 12)}</button>
      <button class="action-btn music-fav-dl" title="Download">${icon("download", 12)}</button>
      <button class="action-btn music-fav-reuse" title="Reuse settings">${icon("refresh", 12)}</button>
      <button class="action-btn music-fav-remove is-fav" title="Remove from favorites"><svg width="12" height="12"><use href="#i-heart-filled"/></svg></button>
    </div>
  `;

  const playBtn = card.querySelector(".music-fav-play");

  playBtn.addEventListener("click", () => {
    if (!audio.paused) {
      audio.pause(); playBtn.classList.remove("playing");
      playBtn.innerHTML = icon("play", 16);
      _activeMusicAudio = null;
      _activeMusicPlayBtn = null;
    } else {
      stopAllMusicPlayback();
      _setActiveMusicAudio(audio, playBtn);
      audio.play(); playBtn.classList.add("playing");
      playBtn.innerHTML = icon("pause", 16);
    }
  });
  audio.addEventListener("ended", () => {
    playBtn.classList.remove("playing");
    _activeMusicAudio = null;
    _activeMusicPlayBtn = null;
    playBtn.innerHTML = icon("play", 16);
  });

  // Edit
  card.querySelector(".music-fav-edit").addEventListener("click", async () => {
    const b64 = await _ensureMusicBase64(fav);
    if (b64) openMusicEditor(fav.id, b64, fav.format || "mp3");
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
  localStorage.setItem("wooz_music_fav_open", isOpen ? "1" : "0");
});
document.getElementById("music-fav-close").addEventListener("click", () => {
  musicFavPanel.classList.remove("open");
  musicFavToggle.classList.remove("active");
  localStorage.setItem("wooz_music_fav_open", "0");
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
wireSettingsToggle("music-settings-trigger", "music-settings-crumb", "music-settings-panel");

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
const MUSIC_CUSTOM_PRESETS_KEY = "wooz_music_custom_presets";
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

function _formatMusicTimePrecise(s) {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(2);
  return m + ":" + (sec < 10 ? "0" : "") + sec;
}

// ── Music Editor ──
const _me = {
  editor: null, card: null, canvas: null, ctx: null,
  waveWrap: null, selOverlay: null, playheadEl: null,
  playBtn: null, timeEl: null, selInfo: null,
  formatSelect: null, speedSelect: null,

  originalBuffer: null,
  buffer: null,
  sampleRate: 48000,

  source: null,
  playing: false,
  startedAt: 0,
  pausedAt: 0,
  animFrame: null,
  speed: 1.0,

  selStart: null,
  selEnd: null,
  dragging: false,
  dragStartX: null,

  // Zoom state
  zoom: 1,
  scrollOffset: 0, // in seconds

  history: [],
  historyIdx: -1,
  maxHistory: 20,

  recordId: null,
  format: "mp3",
  dirty: false,
};

function _meInitRefs() {
  if (_me.editor) return;
  _me.editor = document.getElementById("music-editor");
  _me.card = document.getElementById("music-editor-card");
  _me.canvas = document.getElementById("me-waveform-canvas");
  _me.ctx = _me.canvas.getContext("2d");
  _me.waveWrap = document.getElementById("me-waveform-wrap");
  _me.selOverlay = document.getElementById("me-selection-overlay");
  _me.playheadEl = document.getElementById("me-playhead");
  _me.playBtn = document.getElementById("me-play");
  _me.timeEl = document.getElementById("me-time");
  _me.selInfo = document.getElementById("me-selection-info");
  _me.formatSelect = document.getElementById("me-format");
  _me.speedSelect = document.getElementById("me-speed");
  _meWireEvents();
}

function _meCloneBuffer(buf) {
  const clone = _musicAudioCtx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    clone.copyToChannel(buf.getChannelData(ch).slice(), ch);
  }
  return clone;
}

function _mePushHistory() {
  // Truncate any redo branch
  _me.history = _me.history.slice(0, _me.historyIdx + 1);
  _me.history.push(_meCloneBuffer(_me.buffer));
  if (_me.history.length > _me.maxHistory) _me.history.shift();
  _me.historyIdx = _me.history.length - 1;
  _me.dirty = true;
  _meUpdateToolStates();
}

function _meUndo() {
  if (_me.historyIdx <= 0) return;
  _me.historyIdx--;
  _me.buffer = _meCloneBuffer(_me.history[_me.historyIdx]);
  _meClearSelection();
  _meStopPlayback();
  _meDrawWaveform();
  _meUpdateTime();
  _meUpdateToolStates();
}

function _meRedo() {
  if (_me.historyIdx >= _me.history.length - 1) return;
  _me.historyIdx++;
  _me.buffer = _meCloneBuffer(_me.history[_me.historyIdx]);
  _meClearSelection();
  _meStopPlayback();
  _meDrawWaveform();
  _meUpdateTime();
  _meUpdateToolStates();
}

function _meUpdateToolStates() {
  document.getElementById("me-undo").disabled = _me.historyIdx <= 0;
  document.getElementById("me-redo").disabled = _me.historyIdx >= _me.history.length - 1;
  const hasSel = _me.selStart !== null && _me.selEnd !== null && _me.selStart !== _me.selEnd;
  document.getElementById("me-trim").disabled = !hasSel;
  document.getElementById("me-cut").disabled = !hasSel;
}

// -- Waveform drawing --
function _meDrawWaveform() {
  const canvas = _me.canvas;
  const ctx = _me.ctx;
  const dpr = window.devicePixelRatio || 1;
  const w = _me.waveWrap.clientWidth;
  const h = _me.waveWrap.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  if (!_me.buffer) return;

  const data = _me.buffer.getChannelData(0);
  const dur = _me.buffer.duration;
  const visDur = _meVisibleDuration();
  const startSec = _me.scrollOffset;
  const endSec = startSec + visDur;
  const startSample = Math.floor((startSec / dur) * data.length);
  const endSample = Math.ceil((endSec / dur) * data.length);
  const visibleSamples = endSample - startSample;
  const step = Math.max(1, Math.ceil(visibleSamples / w));
  const mid = h / 2;
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#7c6af7";

  ctx.fillStyle = accent;
  for (let i = 0; i < w; i++) {
    let min = 1, max = -1;
    const sampleIdx = startSample + Math.floor(i * visibleSamples / w);
    for (let j = 0; j < step; j++) {
      const val = data[sampleIdx + j] || 0;
      if (val < min) min = val;
      if (val > max) max = val;
    }
    const barH = Math.max(2, (max - min) * mid);
    ctx.fillRect(i, mid - barH / 2, 1, barH);
  }

  // Draw timeline on separate canvas
  _meDrawTimeline(w, visDur, startSec, endSec);
}

function _meDrawTimeline(waveW, visDur, startSec, endSec) {
  const tlCanvas = document.getElementById("me-timeline-canvas");
  if (!tlCanvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = waveW || tlCanvas.parentElement.clientWidth;
  const h = tlCanvas.clientHeight;
  tlCanvas.width = w * dpr;
  tlCanvas.height = h * dpr;
  const tlCtx = tlCanvas.getContext("2d");
  tlCtx.scale(dpr, dpr);
  tlCtx.clearRect(0, 0, w, h);

  if (!_me.buffer) return;

  const cs = getComputedStyle(document.documentElement);
  const textDim = cs.getPropertyValue("--text-dim").trim() || "#888";
  const textFaint = cs.getPropertyValue("--text-faint").trim() || "#555";

  // Tick marks and labels
  const tickInterval = visDur <= 2 ? 0.25 : visDur <= 5 ? 0.5 : visDur <= 10 ? 1 : visDur <= 60 ? 5 : visDur <= 300 ? 15 : 30;
  const subTicks = visDur <= 10 ? 4 : 2;
  const subInterval = tickInterval / subTicks;

  tlCtx.textAlign = "center";

  // Sub-ticks
  tlCtx.fillStyle = textFaint;
  const firstSub = Math.ceil(startSec / subInterval) * subInterval;
  for (let t = firstSub; t <= endSec; t += subInterval) {
    const x = ((t - startSec) / visDur) * w;
    tlCtx.fillRect(x, 0, 1, 4);
  }

  // Major ticks + labels
  tlCtx.fillStyle = textDim;
  tlCtx.font = "10px sans-serif";
  const firstTick = Math.ceil(startSec / tickInterval) * tickInterval;
  for (let t = firstTick; t <= endSec; t += tickInterval) {
    const x = ((t - startSec) / visDur) * w;
    tlCtx.fillRect(x, 0, 1, 7);
    tlCtx.fillText(_formatMusicTime(t), x, 18);
  }
}

// -- Zoom helpers --
function _meVisibleDuration() {
  if (!_me.buffer) return 1;
  return _me.buffer.duration / _me.zoom;
}

function _meClampScroll() {
  if (!_me.buffer) return;
  const maxOff = _me.buffer.duration - _meVisibleDuration();
  _me.scrollOffset = Math.max(0, Math.min(_me.scrollOffset, maxOff));
}

function _meZoomIn() {
  if (!_me.buffer) return;
  const centerTime = _me.scrollOffset + _meVisibleDuration() / 2;
  _me.zoom = Math.min(_me.zoom * 1.4, 64);
  _me.scrollOffset = centerTime - _meVisibleDuration() / 2;
  _meClampScroll();
  _meDrawWaveform();
  _meUpdateSelectionOverlay();
  _meUpdateZoomLabel();
  _meUpdateScrollbar();
}

function _meZoomOut() {
  if (!_me.buffer) return;
  const centerTime = _me.scrollOffset + _meVisibleDuration() / 2;
  _me.zoom = Math.max(_me.zoom / 1.4, 1);
  _me.scrollOffset = centerTime - _meVisibleDuration() / 2;
  _meClampScroll();
  _meDrawWaveform();
  _meUpdateSelectionOverlay();
  _meUpdateZoomLabel();
  _meUpdateScrollbar();
}

function _meUpdateZoomLabel() {
  const el = document.getElementById("me-zoom-val");
  if (el) el.textContent = Math.round(_me.zoom * 100) + "%";
}

function _meUpdateScrollbar() {
  const sb = document.getElementById("me-scrollbar");
  const thumb = document.getElementById("me-scrollbar-thumb");
  if (!sb || !thumb || !_me.buffer) return;
  if (_me.zoom <= 1) {
    sb.style.display = "none";
    return;
  }
  sb.style.display = "block";
  const ratio = 1 / _me.zoom;
  const offsetRatio = _me.scrollOffset / _me.buffer.duration;
  const trackW = sb.clientWidth;
  thumb.style.width = Math.max(20, ratio * trackW) + "px";
  thumb.style.left = (offsetRatio * trackW) + "px";
}

// -- Selection --
function _mePixelToTime(px) {
  if (!_me.buffer) return 0;
  const w = _me.waveWrap.clientWidth;
  const t = _me.scrollOffset + (px / w) * _meVisibleDuration();
  return Math.max(0, Math.min(_me.buffer.duration, t));
}

function _meTimeToPixel(t) {
  if (!_me.buffer) return 0;
  const w = _me.waveWrap.clientWidth;
  return ((t - _me.scrollOffset) / _meVisibleDuration()) * w;
}

function _meUpdateSelectionOverlay() {
  if (_me.selStart === null || _me.selEnd === null || _me.selStart === _me.selEnd) {
    _me.selOverlay.classList.remove("active");
    _me.selInfo.textContent = "";
    _meUpdateToolStates();
    return;
  }
  const lo = Math.min(_me.selStart, _me.selEnd);
  const hi = Math.max(_me.selStart, _me.selEnd);
  const left = _meTimeToPixel(lo);
  const right = _meTimeToPixel(hi);
  _me.selOverlay.style.left = left + "px";
  _me.selOverlay.style.width = (right - left) + "px";
  _me.selOverlay.classList.add("active");
  _me.selInfo.textContent = "Selected: " + _formatMusicTimePrecise(lo) + " - " + _formatMusicTimePrecise(hi);
  _meUpdateToolStates();
}

function _meClearSelection() {
  _me.selStart = null;
  _me.selEnd = null;
  _meUpdateSelectionOverlay();
}

// -- Playback --
function _meStopPlayback() {
  if (_me.source) {
    try { _me.source.stop(); } catch {}
    try { _me.source.disconnect(); } catch {}
    _me.source = null;
  }
  _me.playing = false;
  if (_me.animFrame) cancelAnimationFrame(_me.animFrame);
  _me.animFrame = null;
  _me.playBtn.innerHTML = '<svg width="14" height="14"><use href="#i-play"/></svg>';
  // playhead always visible
}

function _mePlay() {
  if (!_me.buffer) return;

  // If there's a selection, start from its beginning (unless resuming a pause within the selection)
  if (_me.selStart !== null && _me.selEnd !== null && _me.selStart !== _me.selEnd) {
    const selLo = Math.min(_me.selStart, _me.selEnd);
    const selHi = Math.max(_me.selStart, _me.selEnd);
    // Only override if pausedAt is outside or at the start of selection range
    if (_me.pausedAt < selLo || _me.pausedAt >= selHi) {
      _me.pausedAt = selLo;
    }
  }

  _me.source = _musicAudioCtx.createBufferSource();
  _me.source.buffer = _me.buffer;
  _me.source.playbackRate.value = _me.speed;
  _me.source.connect(_musicAudioCtx.destination);

  _me.startedAt = _musicAudioCtx.currentTime - (_me.pausedAt / _me.speed);
  _me.source.start(0, _me.pausedAt);
  _me.playing = true;
  _me.playBtn.innerHTML = '<svg width="14" height="14"><use href="#i-pause"/></svg>';
  // playhead always visible

  _me.source.onended = () => {
    if (_me.playing) {
      _me.playing = false;
      _me.pausedAt = 0;
      _me.playBtn.innerHTML = '<svg width="14" height="14"><use href="#i-play"/></svg>';
      // playhead always visible
      _meUpdateTime();
    }
  };

  _meAnimatePlayhead();
}

function _mePause() {
  if (!_me.playing) return;
  _me.pausedAt = (_musicAudioCtx.currentTime - _me.startedAt) * _me.speed;
  _meStopPlayback();
}

function _meTogglePlay() {
  if (_me.playing) _mePause();
  else _mePlay();
}

function _meAnimatePlayhead() {
  if (!_me.playing) return;
  const elapsed = (_musicAudioCtx.currentTime - _me.startedAt) * _me.speed;
  const dur = _me.buffer.duration;
  if (elapsed >= dur) {
    _me.pausedAt = 0;
    _meStopPlayback();
    _meUpdateTime();
    return;
  }
  const px = _meTimeToPixel(elapsed);
  _me.playheadEl.style.left = px + "px";
  _me.timeEl.textContent = _formatMusicTime(elapsed) + " / " + _formatMusicTime(dur);
  _me.animFrame = requestAnimationFrame(_meAnimatePlayhead);
}

function _meUpdateTime() {
  if (!_me.buffer) { _me.timeEl.textContent = "0:00 / 0:00"; return; }
  _me.timeEl.textContent = _formatMusicTime(_me.pausedAt || 0) + " / " + _formatMusicTime(_me.buffer.duration);
}

// -- Editing operations --
function _meTrim() {
  if (_me.selStart === null || _me.selEnd === null) return;
  const lo = Math.min(_me.selStart, _me.selEnd);
  const hi = Math.max(_me.selStart, _me.selEnd);
  const sr = _me.buffer.sampleRate;
  const startSample = Math.floor(lo * sr);
  const endSample = Math.floor(hi * sr);
  const newLen = endSample - startSample;
  if (newLen < 1) return;

  const newBuf = _musicAudioCtx.createBuffer(_me.buffer.numberOfChannels, newLen, sr);
  for (let ch = 0; ch < _me.buffer.numberOfChannels; ch++) {
    const src = _me.buffer.getChannelData(ch);
    newBuf.copyToChannel(src.slice(startSample, endSample), ch);
  }
  _me.buffer = newBuf;
  _mePushHistory();
  _meClearSelection();
  _meStopPlayback();
  _me.pausedAt = 0;
  _meDrawWaveform();
  _meUpdateTime();
}

function _meCut() {
  if (_me.selStart === null || _me.selEnd === null) return;
  const lo = Math.min(_me.selStart, _me.selEnd);
  const hi = Math.max(_me.selStart, _me.selEnd);
  const sr = _me.buffer.sampleRate;
  const startSample = Math.floor(lo * sr);
  const endSample = Math.floor(hi * sr);
  const newLen = _me.buffer.length - (endSample - startSample);
  if (newLen < 1) return;

  const newBuf = _musicAudioCtx.createBuffer(_me.buffer.numberOfChannels, newLen, sr);
  for (let ch = 0; ch < _me.buffer.numberOfChannels; ch++) {
    const src = _me.buffer.getChannelData(ch);
    const dest = newBuf.getChannelData(ch);
    dest.set(src.subarray(0, startSample), 0);
    dest.set(src.subarray(endSample), startSample);
  }
  _me.buffer = newBuf;
  _mePushHistory();
  _meClearSelection();
  _meStopPlayback();
  _me.pausedAt = Math.min(_me.pausedAt, newBuf.duration);
  _meDrawWaveform();
  _meUpdateTime();
}

function _meFadeIn() {
  if (!_me.buffer) return;
  // Clone buffer so we can modify in place without corrupting history
  _me.buffer = _meCloneBuffer(_me.buffer);
  const sr = _me.buffer.sampleRate;
  let startSample, endSample;
  if (_me.selStart !== null && _me.selEnd !== null && _me.selStart !== _me.selEnd) {
    startSample = Math.floor(Math.min(_me.selStart, _me.selEnd) * sr);
    endSample = Math.floor(Math.max(_me.selStart, _me.selEnd) * sr);
  } else {
    startSample = 0;
    endSample = Math.min(Math.floor(2 * sr), _me.buffer.length);
  }
  const len = endSample - startSample;
  for (let ch = 0; ch < _me.buffer.numberOfChannels; ch++) {
    const data = _me.buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[startSample + i] *= i / len;
    }
  }
  _mePushHistory();
  _meDrawWaveform();
}

function _meFadeOut() {
  if (!_me.buffer) return;
  // Clone buffer so we can modify in place without corrupting history
  _me.buffer = _meCloneBuffer(_me.buffer);
  const sr = _me.buffer.sampleRate;
  let startSample, endSample;
  if (_me.selStart !== null && _me.selEnd !== null && _me.selStart !== _me.selEnd) {
    startSample = Math.floor(Math.min(_me.selStart, _me.selEnd) * sr);
    endSample = Math.floor(Math.max(_me.selStart, _me.selEnd) * sr);
  } else {
    endSample = _me.buffer.length;
    startSample = Math.max(0, endSample - Math.floor(2 * sr));
  }
  const len = endSample - startSample;
  for (let ch = 0; ch < _me.buffer.numberOfChannels; ch++) {
    const data = _me.buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[startSample + i] *= 1 - (i / len);
    }
  }
  _mePushHistory();
  _meDrawWaveform();
}

async function _meBakeSpeed() {
  if (_me.speed === 1.0) return _me.buffer;
  const src = _me.buffer;
  const newLen = Math.round(src.length / _me.speed);
  const offline = new OfflineAudioContext(src.numberOfChannels, newLen, src.sampleRate);
  const node = offline.createBufferSource();
  node.buffer = src;
  node.playbackRate.value = _me.speed;
  node.connect(offline.destination);
  node.start(0);
  return offline.startRendering();
}

// -- Export --
function _meEncodeWav(buffer) {
  const numCh = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = buffer.length * blockAlign;
  const headerSize = 44;
  const ab = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(ab);

  function writeStr(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let ch = 0; ch < numCh; ch++) channels.push(buffer.getChannelData(ch));
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
  }
  return new Blob([ab], { type: "audio/wav" });
}

function _meEncodeMp3(buffer) {
  const numCh = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const kbps = 128;
  const encoder = new lamejs.Mp3Encoder(numCh, sr, kbps);
  const blockSize = 1152;
  const mp3Chunks = [];

  const left = _meFloatTo16(buffer.getChannelData(0));
  const right = numCh > 1 ? _meFloatTo16(buffer.getChannelData(1)) : left;

  for (let i = 0; i < left.length; i += blockSize) {
    const lChunk = left.subarray(i, i + blockSize);
    const rChunk = right.subarray(i, i + blockSize);
    const mp3buf = encoder.encodeBuffer(lChunk, rChunk);
    if (mp3buf.length > 0) mp3Chunks.push(mp3buf);
  }
  const last = encoder.flush();
  if (last.length > 0) mp3Chunks.push(last);
  return new Blob(mp3Chunks, { type: "audio/mpeg" });
}

function _meFloatTo16(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16;
}

async function _meExport() {
  const buf = await _meBakeSpeed();
  const fmt = _me.formatSelect.value;
  const blob = fmt === "wav" ? _meEncodeWav(buf) : _meEncodeMp3(buf);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "edited-audio." + fmt;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function _meSave() {
  if (!_me.recordId) return;
  const buf = await _meBakeSpeed();
  const fmt = _me.formatSelect.value;
  const blob = fmt === "wav" ? _meEncodeWav(buf) : _meEncodeMp3(buf);

  // Convert blob to base64
  const reader = new FileReader();
  const base64 = await new Promise((resolve) => {
    reader.onload = () => {
      const dataUrl = reader.result;
      resolve(dataUrl.split(",")[1]);
    };
    reader.readAsDataURL(blob);
  });

  // Upload edited audio and update the track record via API
  try {
    const audioBlob = new Blob([blob], { type: fmt === "wav" ? "audio/wav" : "audio/mpeg" });
    const fd = new FormData();
    fd.append("files", audioBlob, "audio." + fmt);
    await apiFetch(`/studio/music/items/${_me.recordId}/media`, { method: "POST", body: fd });

    // Update metadata (format, duration)
    const currentRes = await apiFetch(`/studio/music/items/${_me.recordId}`);
    if (currentRes.ok) {
      const item = await currentRes.json();
      const meta = typeof item.meta === "string" ? JSON.parse(item.meta) : (item.meta || {});
      meta.format = fmt;
      meta.duration = buf.duration;
      delete meta.audio;
      await apiFetch(`/studio/music/items/${_me.recordId}`, {
        method: "PATCH",
        body: JSON.stringify({ meta: JSON.stringify(meta) }),
      });
    }

    // Refresh the card in the canvas
    const oldCard = document.querySelector(`.music-result[data-music-id="${_me.recordId}"]`);
    if (oldCard) {
      const allTracks = await loadAllMusicTracks();
      const rec = allTracks.find(t => t.id === _me.recordId);
      if (rec) {
        rec.audio = base64;
        const newCard = createMusicResultCard(rec);
        oldCard.replaceWith(newCard);
      }
    }
    if (typeof showToast === "function") showToast("Track saved");
    _me.dirty = false;
  } catch (err) {
    console.error("Failed to save edited track:", err);
    if (typeof showToast === "function") showToast("Save failed");
  }
}

// -- Open/Close --
async function openMusicEditor(recordId, base64Audio, format) {
  stopAllMusicPlayback();
  _meInitRefs();
  _me.recordId = recordId;
  _me.format = format || "mp3";
  _me.formatSelect.value = _me.format;
  _me.speed = 1.0;
  _me.speedSelect.value = "1";
  _me.pausedAt = 0;
  _me.dirty = false;
  _me.zoom = 1;
  _me.scrollOffset = 0;
  _meClearSelection();

  // Decode base64 to AudioBuffer
  const byteStr = atob(base64Audio);
  const bytes = new Uint8Array(byteStr.length);
  for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
  const arrayBuf = bytes.buffer;

  try {
    const decoded = await _musicAudioCtx.decodeAudioData(arrayBuf.slice(0));
    _me.buffer = decoded;
    _me.originalBuffer = _meCloneBuffer(decoded);
    _me.sampleRate = decoded.sampleRate;
    _me.history = [_meCloneBuffer(decoded)];
    _me.historyIdx = 0;
  } catch (err) {
    if (typeof showToast === "function") showToast("Failed to decode audio", "error");
    return;
  }

  // Reset drag/resize position
  if (_me._resetModal) _me._resetModal();

  _me.editor.classList.add("active");
  // Draw after layout settles
  requestAnimationFrame(() => {
    _meDrawWaveform();
    _meUpdateTime();
    _meUpdateZoomLabel();
    _meUpdateScrollbar();
    _meUpdateToolStates();
    const sv = document.getElementById("me-speed-val");
    if (sv) sv.textContent = "1x";
  });
}

function closeMusicEditor() {
  stopAllMusicPlayback();
  _meStopPlayback();
  _me.pausedAt = 0;
  _me.editor.classList.remove("active");
  _me.buffer = null;
  _me.originalBuffer = null;
  _me.history = [];
  _me.historyIdx = -1;
  _me.recordId = null;
  _me.dirty = false;
}

function _meReset() {
  if (!_me.originalBuffer) return;
  _me.buffer = _meCloneBuffer(_me.originalBuffer);
  _mePushHistory();
  _me.speed = 1.0;
  _me.speedSelect.value = "1";
  const sv = document.getElementById("me-speed-val");
  if (sv) sv.textContent = "1x";
  _me.zoom = 1;
  _me.scrollOffset = 0;
  _meClearSelection();
  _meStopPlayback();
  _me.pausedAt = 0;
  _meDrawWaveform();
  _meUpdateTime();
  _meUpdateZoomLabel();
  _meUpdateScrollbar();
}

// -- Event wiring --
function _meWireEvents() {
  // Close
  document.getElementById("music-editor-close").addEventListener("click", closeMusicEditor);
  _me.editor.addEventListener("click", (e) => {
    // Do not close on backdrop click - require explicit close button
  });

  // Drag to move + corner resize via shared utility
  _me._resetModal = makeModalDraggable(_me.card, document.getElementById("music-editor-header"));

  // Tools
  document.getElementById("me-trim").addEventListener("click", _meTrim);
  document.getElementById("me-cut").addEventListener("click", _meCut);
  document.getElementById("me-fade-in").addEventListener("click", _meFadeIn);
  document.getElementById("me-fade-out").addEventListener("click", _meFadeOut);
  document.getElementById("me-undo").addEventListener("click", _meUndo);
  document.getElementById("me-redo").addEventListener("click", _meRedo);
  document.getElementById("me-play").addEventListener("click", _meTogglePlay);
  document.getElementById("me-export").addEventListener("click", _meExport);
  document.getElementById("me-save").addEventListener("click", _meSave);
  document.getElementById("me-reset").addEventListener("click", _meReset);

  // Speed slider
  const speedVal = document.getElementById("me-speed-val");
  _me.speedSelect.addEventListener("input", () => {
    const wasPlaying = _me.playing;
    if (wasPlaying) {
      _me.pausedAt = (_musicAudioCtx.currentTime - _me.startedAt) * _me.speed;
      _meStopPlayback();
    }
    _me.speed = parseFloat(_me.speedSelect.value);
    speedVal.textContent = _me.speed + "x";
    if (wasPlaying) _mePlay();
  });

  // Scrollbar drag
  const sbThumb = document.getElementById("me-scrollbar-thumb");
  const sbTrack = document.getElementById("me-scrollbar");
  let sbDragging = false, sbStartX, sbStartOff;
  sbThumb.addEventListener("mousedown", (e) => {
    e.preventDefault();
    sbDragging = true;
    sbStartX = e.clientX;
    sbStartOff = _me.scrollOffset;
    sbThumb.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
  });
  window.addEventListener("mousemove", (e) => {
    if (!sbDragging || !_me.buffer) return;
    const dx = e.clientX - sbStartX;
    const trackW = sbTrack.clientWidth;
    _me.scrollOffset = sbStartOff + (dx / trackW) * _me.buffer.duration;
    _meClampScroll();
    _meDrawWaveform();
    _meUpdateSelectionOverlay();
    _meUpdateScrollbar();
  });
  window.addEventListener("mouseup", () => {
    if (!sbDragging) return;
    sbDragging = false;
    sbThumb.style.cursor = "";
    document.body.style.userSelect = "";
  });

  // Waveform mouse selection
  _me.waveWrap.addEventListener("mousedown", (e) => {
    if (!_me.buffer) return;
    const rect = _me.waveWrap.getBoundingClientRect();
    const x = e.clientX - rect.left;
    _me.dragging = true;
    _me.dragStartX = x;
    _me.selStart = _mePixelToTime(x);
    _me.selEnd = _me.selStart;
    _meUpdateSelectionOverlay();
  });

  window.addEventListener("mousemove", (e) => {
    if (!_me.dragging) return;
    const rect = _me.waveWrap.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    _me.selEnd = _mePixelToTime(x);
    _meUpdateSelectionOverlay();
  });

  window.addEventListener("mouseup", () => {
    if (!_me.dragging) return;
    _me.dragging = false;
    // If no drag distance, treat as seek
    if (_me.selStart !== null && _me.selEnd !== null && Math.abs(_me.selStart - _me.selEnd) < 0.02) {
      _me.pausedAt = _me.selStart;
      _meClearSelection();
      _meUpdateTime();
      _me.playheadEl.style.left = _meTimeToPixel(_me.pausedAt) + "px";
      // playhead always visible
    }
  });

  // Timeline click-to-seek
  const tlCanvas = document.getElementById("me-timeline-canvas");
  tlCanvas.addEventListener("mousedown", (e) => {
    if (!_me.buffer) return;
    const rect = _me.waveWrap.getBoundingClientRect();
    const x = e.clientX - rect.left;
    _me.pausedAt = _mePixelToTime(x);
    _meClearSelection();
    _meUpdateTime();
    _me.playheadEl.style.left = _meTimeToPixel(_me.pausedAt) + "px";
  });

  // Double-click to select all
  _me.waveWrap.addEventListener("dblclick", () => {
    if (!_me.buffer) return;
    _me.selStart = 0;
    _me.selEnd = _me.buffer.duration;
    _meUpdateSelectionOverlay();
  });

  // Scroll wheel: zoom (default), shift+wheel: pan
  _me.waveWrap.addEventListener("wheel", (e) => {
    if (!_me.buffer) return;
    e.preventDefault();
    if (e.shiftKey) {
      // Pan horizontally
      const scrollAmt = (e.deltaY / _me.waveWrap.clientWidth) * _meVisibleDuration() * 0.3;
      _me.scrollOffset += scrollAmt;
      _meClampScroll();
      _meDrawWaveform();
      _meUpdateSelectionOverlay();
      _meUpdateScrollbar();
    } else {
      // Zoom centered on mouse position
      const rect = _me.waveWrap.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseTime = _mePixelToTime(mouseX);
      if (e.deltaY < 0) _me.zoom = Math.min(_me.zoom * 1.25, 64);
      else _me.zoom = Math.max(_me.zoom / 1.25, 1);
      const w = _me.waveWrap.clientWidth;
      _me.scrollOffset = mouseTime - (mouseX / w) * _meVisibleDuration();
      _meClampScroll();
      _meDrawWaveform();
      _meUpdateSelectionOverlay();
      _meUpdateZoomLabel();
      _meUpdateScrollbar();
    }
  }, { passive: false });

  // Zoom buttons
  document.getElementById("me-zoom-in").addEventListener("click", _meZoomIn);
  document.getElementById("me-zoom-out").addEventListener("click", _meZoomOut);

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (!_me.editor.classList.contains("active")) return;
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;

    if (e.key === "Escape") { closeMusicEditor(); e.preventDefault(); return; }
    if (e.key === " ") { _meTogglePlay(); e.preventDefault(); return; }
    if (e.key === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey) { _meUndo(); e.preventDefault(); return; }
    if ((e.key === "y" && (e.ctrlKey || e.metaKey)) || (e.key === "z" && (e.ctrlKey || e.metaKey) && e.shiftKey)) {
      _meRedo(); e.preventDefault(); return;
    }
    if (e.key === "=" || e.key === "+") { _meZoomIn(); e.preventDefault(); return; }
    if (e.key === "-") { _meZoomOut(); e.preventDefault(); return; }
  });

  // Resize redraw
  const resizeObs = new ResizeObserver(() => {
    if (_me.editor.classList.contains("active") && _me.buffer) _meDrawWaveform();
  });
  resizeObs.observe(_me.waveWrap);
}

// ── Create music result card ──
function createMusicResultCard(record) {
  const el = document.createElement("div");
  el.className = "media-result music-result";
  el.dataset.musicId = record.id;

  // Audio playback URL (base64 blob or server URL)
  const audioUrl = _musicAudioUrl(record);
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
    ${coverHtml ? `<div class="music-result-cover">${coverHtml}</div>` : ""}
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
      <span class="studio-timestamp">${formatStudioTimestamp(record.timestamp)}</span>
      <div class="music-meta-details">
        ${record.title ? `<div class="music-meta-title">${esc(record.title)}</div>` : ""}
        <div class="meta-prompt">${esc(record.rawPrompt)}</div>
        <div class="meta-collapsible music-meta-pills">${pills.map(p => `<span class="meta-pill">${esc(p)}</span>`).join("")}</div>
        <div class="music-meta-bottom">
          <div class="meta-toggles">
            <button class="details-toggle">${icon("chevron-down", 8)} Details</button>
            <button class="prompt-toggle">${icon("chevron-down", 8)} Prompt</button>
            ${lyricsToggleHtml}
          </div>
          <div class="music-result-actions">
            <button class="action-btn music-fav-btn" title="Favorite">
              ${icon("heart", 12)}
            </button>
            <button class="action-btn music-edit" title="Edit">
              ${icon("edit", 12)}
            </button>
            <button class="action-btn music-reuse" title="Reuse settings">
              ${icon("refresh", 12)}
            </button>
            <button class="action-btn music-dl" title="Download">
              ${icon("download", 12)}
            </button>
            <button class="action-btn music-del" title="Delete">
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
  const promptToggle = el.querySelector(".prompt-toggle");
  if (promptToggle) {
    promptToggle.addEventListener("click", () => {
      promptToggle.classList.toggle("open");
      el.querySelector(".meta-prompt").classList.toggle("open");
    });
  }

  // Details toggle
  const detailsToggle = el.querySelector(".details-toggle");
  if (detailsToggle) {
    detailsToggle.addEventListener("click", () => {
      detailsToggle.classList.toggle("open");
      el.querySelector(".music-meta-pills").classList.toggle("open");
    });
  }

  // Check if already favorited
  isMusicFavorite(record.id).then(isFav => {
    if (isFav) {
      favBtn.classList.add("is-fav");
      setFavFilled(favBtn, true);
    }
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
  playBtn.addEventListener("click", () => {
    if (!audio.paused) {
      audio.pause();
      playBtn.classList.remove("playing");
      playBtn.innerHTML = icon("play", 16);
      _activeMusicAudio = null;
      _activeMusicPlayBtn = null;
    } else {
      stopAllMusicPlayback();
      _setActiveMusicAudio(audio, playBtn);
      audio.play();
      playBtn.classList.add("playing");
      playBtn.innerHTML = '';
    }
  });

  audio.addEventListener("ended", () => {
    playBtn.classList.remove("playing");
    playBtn.innerHTML = icon("play", 16);
    waveProgress.style.width = "0%";
    _activeMusicAudio = null;
    _activeMusicPlayBtn = null;
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
      await apiFetch(`/studio/music/items/${record.id}/favorite`, { method: "DELETE" });
      favBtn.classList.remove("is-fav");
      setFavFilled(favBtn, false);
    } else {
      await apiFetch(`/studio/music/items/${record.id}/favorite`, { method: "POST" });
      favBtn.classList.add("is-fav");
      setFavFilled(favBtn, true);
    }
    if (musicFavPanel.classList.contains("open")) refreshMusicFavoritesPanel();
  });

  // Edit
  el.querySelector(".music-edit").addEventListener("click", async () => {
    const b64 = await _ensureMusicBase64(record);
    if (b64) openMusicEditor(record.id, b64, record.format || "mp3");
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
    await apiFetch(`/studio/music/items/${record.id}/trash`, { method: "POST" });
    _refreshMusicTrashBadge();
    el.remove();
    audio.pause();
    if (record.audio) URL.revokeObjectURL(audioUrl);
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
function _createGenProgress(type) {
  type = type || "image";
  const icons = {
    image: '<use href="#i-image"/>',
    music: '<use href="#i-music"/>',
    video: '<use href="#i-video"/>',
    notetaker: '<use href="#i-mic"/>',
  };
  const el = document.createElement("div");
  el.className = "gen-progress";
  el.dataset.type = type;
  el.innerHTML =
    `<button class="gen-progress-close" title="Cancel"><svg width="12" height="12"><use href="#i-x"/></svg></button>
    <div class="gen-progress-top">
      <svg class="gen-progress-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${icons[type] || ""}</svg>
      <div class="gen-progress-status">Preparing...</div>
    </div>
    <div class="gen-progress-track"><div class="gen-progress-fill"></div></div>
    <div class="gen-progress-glow"><div class="gen-progress-glow-inner"></div></div>`;

  const statusEl = el.querySelector(".gen-progress-status");
  const barFill = el.querySelector(".gen-progress-fill");
  const glowFill = el.querySelector(".gen-progress-glow-inner");
  const stopBtn = el.querySelector(".gen-progress-close");

  return {
    el, stopBtn,
    update(step, total, elapsed) {
      const pct = total > 0 ? Math.round(step / total * 100) : 0;
      barFill.style.width = pct + "%";
      glowFill.style.width = pct + "%";
      barFill.classList.toggle("done", pct >= 100);
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

  const progress = _createGenProgress("music");
  musicCanvas.prepend(progress.el);
  musicCanvas.scrollTop = 0;

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

    // Replace progress with first card, insert the rest after it
    progress.el.replaceWith(cards[0]);
    for (let i = 1; i < cards.length; i++) {
      cards[i - 1].after(cards[i]);
    }
    musicCanvas.scrollTop = 0;
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
          // Update server metadata with cover art
          try {
            const curRes = await apiFetch(`/studio/music/items/${rec.id}`);
            if (curRes.ok) {
              const item = await curRes.json();
              const meta = typeof item.meta === "string" ? JSON.parse(item.meta) : (item.meta || {});
              meta.coverArt = coverB64;
              await apiFetch(`/studio/music/items/${rec.id}`, {
                method: "PATCH",
                body: JSON.stringify({ meta: JSON.stringify(meta) }),
              });
            }
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
          cards[i - 1].after(cards[i]);
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
    if (musicPrompt.value.trim().startsWith("/")) return; // slash command
    musicGenerate();
  }
});

// ── Music Trash ──
document.getElementById("music-trash-btn").addEventListener("click", () => openMusicTrashModal());

async function openMusicTrashModal() {
  stopAllMusicPlayback();
  await purgeOldTrash(loadAllMusicTrash, deleteFromMusicTrash);
  document.getElementById("shared-trash-modal").classList.add("open");
  await renderMusicTrashList();
  document.getElementById("shared-trash-empty-btn").onclick = async () => {
    const count = document.querySelectorAll("#shared-trash-content .studio-trash-card").length;
    if (!count) return;
    if (!confirm(`Permanently delete ${count} track${count !== 1 ? "s" : ""} from trash?`)) return;
    await emptyMusicTrash();
    updateMusicTrashBadge(0);
    document.getElementById("shared-trash-modal").classList.remove("open");
  };
}

async function renderMusicTrashList() {
  const list = document.getElementById("shared-trash-content");
  list.style.cssText = "display:flex; flex-direction:column;";
  const countLabel = document.getElementById("shared-trash-count");
  const items = (await loadAllMusicTrash()).sort((a, b) => b.deletedAt - a.deletedAt);
  list.innerHTML = "";
  countLabel.textContent = items.length ? `${items.length} track${items.length !== 1 ? "s" : ""}` : "";
  updateMusicTrashBadge(items.length);
  items.forEach(item => {
    const card = document.createElement("div");
    card.className = "studio-trash-card";
    const age = trashAge(item.deletedAt);
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
    playBtn.addEventListener("click", () => {
      if (!_trashAudio) {
        const trashUrl = _musicAudioUrl(item);
        if (!trashUrl) return;
        _trashAudio = new Audio(trashUrl);
        _trashAudio.addEventListener("ended", () => {
          playBtn.classList.remove("playing");
          playBtn.innerHTML = icon("play");
          _activeMusicAudio = null;
          _activeMusicPlayBtn = null;
        });
      }
      if (!_trashAudio.paused) {
        _trashAudio.pause();
        playBtn.classList.remove("playing");
        playBtn.innerHTML = icon("play");
        _activeMusicAudio = null;
        _activeMusicPlayBtn = null;
      } else {
        stopAllMusicPlayback();
        _setActiveMusicAudio(_trashAudio, playBtn);
        _trashAudio.play();
        playBtn.classList.add("playing");
        playBtn.innerHTML = '';
      }
    });
    card.querySelector(".studio-trash-restore").addEventListener("click", async () => {
      if (_trashAudio) { _trashAudio.pause(); _trashAudio = null; }
      await _restoreFromMusicTrash(item);
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
  await apiFetch(`/studio/music/items/${item.id}/restore`, { method: "POST" });
  // If restored to active music folder, re-render
  if ((item.folder_id || null) === (activeMusicFolderId || null)) {
    musicCanvas.appendChild(createMusicResultCard(item));
    musicCanvasEmpty.style.display = "none";
    renderMusicSessionsList();
  }
}

function updateMusicTrashBadge(count) {
  updateBadge("music-trash-badge", count);
}

async function _refreshMusicTrashBadge() {
  const items = await loadAllMusicTrash();
  updateMusicTrashBadge(items.length);
}


