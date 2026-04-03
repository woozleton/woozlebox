// ── Image Studio ──
const imageStudio = document.getElementById("image-studio");
const chatArea = document.getElementById("chat-area");
const studioPrompt = document.getElementById("studio-prompt");
const studioNegative = document.getElementById("studio-negative");
const studioModelSelect = document.getElementById("studio-model-select");
const studioModelLabel = document.getElementById("studio-model-label");
const studioSteps = document.getElementById("studio-steps");
const studioStepsVal = document.getElementById("studio-steps-val");
const studioGuidance = document.getElementById("studio-guidance");
const studioGuidanceVal = document.getElementById("studio-guidance-val");
const studioSeed = document.getElementById("studio-seed");
const studioGenerateBtn = document.getElementById("studio-generate-btn");
const studioCanvas = document.getElementById("studio-canvas");
const studioCanvasEmpty = document.getElementById("studio-canvas-empty");
const studioSettingsCrumb = document.getElementById("studio-settings-crumb");
const studioSettingsPanel = document.getElementById("studio-settings-panel");
const studioSettingsSummary = document.getElementById("studio-settings-summary");

// Settings panel toggle
document.getElementById("studio-settings-trigger").addEventListener("click", () => {
  studioSettingsCrumb.classList.toggle("open");
  studioSettingsPanel.classList.toggle("open");
});

function updateStudioSettingsSummary() {
  const modelEl = studioModelSelect.options[studioModelSelect.selectedIndex];
  const modelName = modelEl ? modelEl.text : "Model";
  const aspectLabels = { square: "Square", landscape: "Landscape", portrait: "Portrait" };
  const aspect = aspectLabels[studioAspect] || studioAspect;
  const parts = [modelName, aspect, studioCount + "x"];
  if (studioActivePreset) {
    const label = studioActivePreset.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    parts.push(label);
  }
  studioSettingsSummary.textContent = parts.join(" \u00b7 ");
}

let studioAspect = "square";
let studioActivePreset = null;
let studioGenerating = false;
let studioQueue = []; // [{rawPrompt, body, count}]
let _studioModelsCache = [];
let studioCount = 1;

// Count selector
document.querySelectorAll(".studio-count-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".studio-count-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    studioCount = parseInt(btn.dataset.count);
    saveStudioControls();
  });
});

// ── Studio IndexedDB persistence ──
const _imageDB = createStudioDB({
  name: "diab_studio", version: 6,
  stores: ["images", "favorites", "folders", "trash"],
  onUpgrade(e, req) {
    if (e.oldVersion < 4) {
      const store = req.transaction.objectStore("images");
      store.openCursor().onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (cursor) {
          const rec = cursor.value;
          if (!rec.session_id) { rec.session_id = "sess_" + rec.id; cursor.update(rec); }
          cursor.continue();
        }
      };
    }
  }
});
const STUDIO_DB_STORE = "images";
function openStudioDB() { return _imageDB.open(); }

// ── Image Folders CRUD ──
async function saveImageFolder(pg) { return _imageDB.save("folders", pg); }
async function deleteImageFolder(id) { return _imageDB.remove("folders", id); }
async function loadAllImageFolders() { return _imageDB.loadAll("folders"); }
let imageFolders = [];
let activeImageFolderId = localStorage.getItem("diab_image_folder") || null;
async function saveStudioImage(record) { return _imageDB.save("images", record); }
async function deleteStudioImage(id) { return _imageDB.remove("images", id); }
async function loadAllStudioImages() { return _imageDB.loadAll("images"); }

// ── Trash CRUD ──
async function saveToTrash(item) { return _imageDB.save("trash", item); }
async function loadAllTrash() { return _imageDB.loadAll("trash"); }
async function deleteFromTrash(id) { return _imageDB.remove("trash", id); }
async function emptyTrash() { return _imageDB.clear("trash"); }
function _makeTrashId() {
  return "trash_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
}

// ── Favorites CRUD ──
async function saveFavorite(record) { return _imageDB.save("favorites", record); }
async function deleteFavorite(id) { return _imageDB.remove("favorites", id); }
async function loadAllFavorites() { return _imageDB.loadAll("favorites"); }

const studioFavPanel = document.getElementById("studio-fav-panel");
const studioFavToggle = document.getElementById("studio-fav-toggle");
const studioFavContent = document.getElementById("studio-fav-content");
const studioFavEmpty = document.getElementById("studio-fav-empty");
const studioFavBadge = document.getElementById("studio-fav-badge");
const studioFavCountLabel = document.getElementById("studio-fav-count-label");

studioFavToggle.addEventListener("click", () => {
  const open = studioFavPanel.classList.toggle("open");
  studioFavToggle.classList.toggle("active", open);
  localStorage.setItem("diab_fav_open", open ? "1" : "0");
  if (open) refreshFavoritesPanel();
});
document.getElementById("studio-fav-close").addEventListener("click", () => {
  studioFavPanel.classList.remove("open");
  studioFavToggle.classList.remove("active");
  localStorage.setItem("diab_fav_open", "0");
});

// Fav zoom controls
const _favZoomLevels = [80, 100, 120, 150, 180, 220];
let _favZoomIdx = parseInt(localStorage.getItem("diab_fav_zoom") || "2");
function _applyFavZoom() {
  const content = document.getElementById("studio-fav-content");
  if (content) {
    content.style.setProperty("--fav-thumb-size", _favZoomLevels[_favZoomIdx] + "px");
  }
  localStorage.setItem("diab_fav_zoom", _favZoomIdx);
}
document.getElementById("fav-zoom-in").addEventListener("click", () => {
  if (_favZoomIdx < _favZoomLevels.length - 1) { _favZoomIdx++; _applyFavZoom(); }
});
document.getElementById("fav-zoom-out").addEventListener("click", () => {
  if (_favZoomIdx > 0) { _favZoomIdx--; _applyFavZoom(); }
});
_applyFavZoom();

async function refreshFavoritesPanel() {
  try {
    const favs = await loadAllFavorites();
    favs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    updateFavCount(favs.length);

    // Clear existing cards (keep empty placeholder)
    studioFavContent.querySelectorAll(".fav-card").forEach(c => c.remove());

    if (favs.length === 0) {
      studioFavEmpty.style.display = "";
      return;
    }
    studioFavEmpty.style.display = "none";

    // Build lightbox image list from all favorites
    const favLightboxList = favs.map(f => ({
      src: `data:image/png;base64,${f.image}`, base64: f.image, rawPrompt: f.prompt, body: f.body,
      model: f.model, width: f.width, height: f.height,
    }));

    favs.forEach((fav, favIdx) => {
      const card = document.createElement("div");
      card.className = "fav-card";
      card.dataset.favId = fav.id;
      card.innerHTML = `
        <img src="data:image/png;base64,${fav.image}" alt="${esc(fav.prompt)}" draggable="false" />
        <span class="img-res-label"></span>
        <div class="fav-card-actions">
          <button class="img-action-btn fav-dl" title="Download">${icon("download", 12)}</button>
          <button class="img-action-btn fav-reuse" title="Reuse settings">${icon("refresh", 12)}</button>
          <button class="img-action-btn fav-vary" title="Generate variation">${icon("bolt", 12)}</button>
          <button class="img-action-btn fav-remove img-del" title="Remove from favorites"><svg width="12" height="12" viewBox="0 0 24 24" fill="#f472b6" stroke="#f472b6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg></button>
        </div>
      `;
      // Click image to lightbox with full favorites navigation
      const favImgEl = card.querySelector("img");
      card.addEventListener("mouseenter", () => {
        const lbl = card.querySelector(".img-res-label");
        if (lbl && favImgEl.naturalWidth) lbl.textContent = `${favImgEl.naturalWidth} × ${favImgEl.naturalHeight}`;
      });
      favImgEl.addEventListener("click", () => openLightbox(favImgEl.src, favLightboxList, favIdx));
      // Download
      card.querySelector(".fav-dl").addEventListener("click", () => {
        const a = document.createElement("a");
        a.href = `data:image/png;base64,${fav.image}`;
        a.download = `favorite-${Date.now()}.png`;
        a.click();
      });
      // Reuse settings
      card.querySelector(".fav-reuse").addEventListener("click", () => {
        if (fav.body) {
          studioPrompt.value = fav.prompt;
          studioNegative.value = fav.body.negative_prompt || "";
          studioSteps.value = fav.body.steps;
          studioStepsVal.textContent = fav.body.steps;
          studioGuidance.value = fav.body.guidance_scale;
          studioGuidanceVal.textContent = fav.body.guidance_scale.toFixed(1);
          document.querySelectorAll(".studio-aspect-btn").forEach(b => {
            b.classList.toggle("active", b.dataset.aspect === fav.body.aspect);
          });
          studioAspect = fav.body.aspect;
          updateStudioResolutions();
          if (fav.body.width && fav.body.height) studioResolution.value = `${fav.body.width}x${fav.body.height}`;
        }
        studioPrompt.focus();
      });
      // Variation
      card.querySelector(".fav-vary").addEventListener("click", () => {
        if (fav.body) {
          studioPrompt.value = fav.prompt;
          studioNegative.value = fav.body.negative_prompt || "";
          studioSteps.value = fav.body.steps;
          studioStepsVal.textContent = fav.body.steps;
          studioGuidance.value = fav.body.guidance_scale;
          studioGuidanceVal.textContent = fav.body.guidance_scale.toFixed(1);
          studioSeed.value = Math.floor(Math.random() * 2147483647);
          document.querySelectorAll(".studio-aspect-btn").forEach(b => {
            b.classList.toggle("active", b.dataset.aspect === fav.body.aspect);
          });
          studioAspect = fav.body.aspect;
          updateStudioResolutions();
        }
        studioGenerate();
      });
      // Remove from favorites
      card.querySelector(".fav-remove").addEventListener("click", async () => {
        await deleteFavorite(fav.id);
        card.remove();
        // Un-heart the image in the main canvas if visible
        const favIdParts = fav.id.split("_");
        document.querySelectorAll(`.studio-img-wrap .img-fav.is-fav`).forEach(btn => {
          // Check by matching parent record and index
          const parentResult = btn.closest(".studio-result");
          if (parentResult) {
            const wrap = btn.closest(".studio-img-wrap");
            const parentId = parentResult.dataset.studioId;
            const wrapIdx = wrap.dataset.idx;
            if (`fav_${parentId}_${wrapIdx}` === fav.id) {
              btn.classList.remove("is-fav");
            }
          }
        });
        const remaining = studioFavContent.querySelectorAll(".fav-card");
        updateFavCount(remaining.length);
        if (remaining.length === 0) studioFavEmpty.style.display = "";
      });

      studioFavContent.appendChild(card);
    });
  } catch (e) {
    console.warn("Failed to load favorites:", e);
  }
}

function updateFavCount(count) {
  studioFavBadge.textContent = count;
  studioFavCountLabel.textContent = count;
  studioFavBadge.style.display = count > 0 ? "" : "none";
}

// Restore favorites panel state (suppress slide animation on load)
document.querySelectorAll(".fav-panel, #vault-panel").forEach(p => p.classList.add("no-transition"));
if (localStorage.getItem("diab_fav_open") === "1") {
  studioFavPanel.classList.add("open");
  studioFavToggle.classList.add("active");
  refreshFavoritesPanel();
}
requestAnimationFrame(() => {
  document.querySelectorAll(".fav-panel, #vault-panel").forEach(p => p.classList.remove("no-transition"));
});

// Initialize favorites count on studio open
async function initFavCount() {
  try {
    const favs = await loadAllFavorites();
    updateFavCount(favs.length);
    // Mark any already-favorited images in canvas
    favs.forEach(fav => {
      const parts = fav.id.match(/^fav_(.+)_(\d+)$/);
      if (parts) {
        const parentResult = document.querySelector(`.studio-result[data-studio-id="${parts[1]}"]`);
        if (parentResult) {
          const wrap = parentResult.querySelectorAll(".studio-img-wrap")[parseInt(parts[2])];
          if (wrap) wrap.querySelector(".img-fav")?.classList.add("is-fav");
        }
      }
    });
  } catch {}
}

// ── Image lightbox ──
const studioLightbox = document.getElementById("studio-lightbox");
const studioLightboxImg = document.getElementById("studio-lightbox-img");
let _lightboxContext = { images: [], index: 0 };
// images: array of { src, base64, recordId, imgIdx, rawPrompt, body }

function openLightbox(src, imageList, currentIndex) {
  if (imageList && imageList.length > 0) {
    _lightboxContext = { images: imageList, index: currentIndex || 0 };
  } else {
    _lightboxContext = { images: [{ src }], index: 0 };
  }
  _renderLightboxImage();
  studioLightbox.classList.add("open");
}

function _renderLightboxImage() {
  const ctx = _lightboxContext;
  const img = ctx.images[ctx.index];
  if (!img) return;
  studioLightboxImg.src = img.src;
  // Update resolution label when image loads
  const _lbResLabel = document.getElementById("studio-lightbox-res");
  if (_lbResLabel) {
    studioLightboxImg.onload = () => {
      _lbResLabel.textContent = `${studioLightboxImg.naturalWidth} × ${studioLightboxImg.naturalHeight}`;
    };
    if (studioLightboxImg.complete && studioLightboxImg.naturalWidth) {
      _lbResLabel.textContent = `${studioLightboxImg.naturalWidth} × ${studioLightboxImg.naturalHeight}`;
    }
  }
  // Update arrow states
  const prevBtn = studioLightbox.querySelector(".lb-prev");
  const nextBtn = studioLightbox.querySelector(".lb-next");
  if (prevBtn) prevBtn.disabled = ctx.index <= 0;
  if (nextBtn) nextBtn.disabled = ctx.index >= ctx.images.length - 1;
  // Show/hide arrows based on count
  const hasMultiple = ctx.images.length > 1;
  if (prevBtn) prevBtn.style.display = hasMultiple ? "" : "none";
  if (nextBtn) nextBtn.style.display = hasMultiple ? "" : "none";
  // Update fav button state
  const favBtn = studioLightbox.querySelector(".lb-fav");
  if (favBtn && img.recordId != null) {
    const favId = `fav_${img.recordId}_${img.imgIdx}`;
    favBtn.classList.toggle("is-fav", !!document.querySelector(`.img-fav.is-fav[data-fav-id="${favId}"]`));
  }
}

function _lightboxNav(delta) {
  const ctx = _lightboxContext;
  const newIdx = ctx.index + delta;
  if (newIdx < 0 || newIdx >= ctx.images.length) return;
  ctx.index = newIdx;
  _renderLightboxImage();
}

function closeLightbox() {
  studioLightbox.classList.remove("open");
  studioLightboxImg.src = "";
  _lightboxContext = { images: [], index: 0 };
}
studioLightbox.addEventListener("click", closeLightbox);
document.getElementById("studio-lightbox-close").addEventListener("click", closeLightbox);
document.getElementById("studio-lightbox-inner").addEventListener("click", e => e.stopPropagation());
studioLightbox.querySelector(".lb-prev").addEventListener("click", e => { e.stopPropagation(); _lightboxNav(-1); });
studioLightbox.querySelector(".lb-next").addEventListener("click", e => { e.stopPropagation(); _lightboxNav(1); });

// Lightbox action buttons
studioLightbox.querySelector(".lb-dl").addEventListener("click", e => {
  e.stopPropagation();
  const img = _lightboxContext.images[_lightboxContext.index];
  if (!img) return;
  _downloadImg(studioLightboxImg);
});
studioLightbox.querySelector(".lb-fav").addEventListener("click", async e => {
  e.stopPropagation();
  const img = _lightboxContext.images[_lightboxContext.index];
  if (!img || img.recordId == null) return;
  const favBtn = studioLightbox.querySelector(".lb-fav");
  const isFav = favBtn.classList.toggle("is-fav");
  const favId = `fav_${img.recordId}_${img.imgIdx}`;
  if (isFav) {
    await saveFavorite({ id: favId, image: img.base64, model: img.model, width: img.width, height: img.height, prompt: img.rawPrompt, body: img.body, timestamp: Date.now() });
  } else {
    await deleteFavorite(favId);
  }
  // Sync the card-level fav button too
  const cardFav = document.querySelector(`.studio-result[data-studio-id="${img.recordId}"] .studio-img-wrap[data-idx="${img.imgIdx}"] .img-fav`);
  if (cardFav) cardFav.classList.toggle("is-fav", isFav);
  refreshFavoritesPanel();
});
studioLightbox.querySelector(".lb-vary").addEventListener("click", e => {
  e.stopPropagation();
  const img = _lightboxContext.images[_lightboxContext.index];
  if (!img || !img.body) return;
  closeLightbox();
  studioPrompt.value = img.rawPrompt;
  studioNegative.value = img.body.negative_prompt || "";
  studioSteps.value = img.body.steps;
  studioStepsVal.textContent = img.body.steps;
  studioGuidance.value = img.body.guidance_scale;
  studioGuidanceVal.textContent = img.body.guidance_scale.toFixed(1);
  studioSeed.value = Math.floor(Math.random() * 2147483647);
  document.querySelectorAll(".studio-aspect-btn").forEach(b => b.classList.toggle("active", b.dataset.aspect === img.body.aspect));
  studioAspect = img.body.aspect;
  updateStudioResolutions();
  if (img.body.width && img.body.height) studioResolution.value = `${img.body.width}x${img.body.height}`;
  studioGenerate();
});
studioLightbox.querySelector(".lb-del").addEventListener("click", async e => {
  e.stopPropagation();
  const img = _lightboxContext.images[_lightboxContext.index];
  if (!img || img.recordId == null) return;
  // Delete image from IndexedDB record
  try {
    const db = await openStudioDB();
    // Read in its own transaction
    const rec = await new Promise(r => { const tx = db.transaction(STUDIO_DB_STORE, "readonly"); const g = tx.objectStore(STUDIO_DB_STORE).get(img.recordId); g.onsuccess = () => r(g.result); });
    if (rec) {
      const imgData = rec.images[img.imgIdx];
      if (imgData) await saveToTrash({ id: _makeTrashId(), deletedAt: Date.now(), image: imgData.image, rawPrompt: rec.rawPrompt, body: rec.body, model: imgData.model, width: imgData.width, height: imgData.height, session_id: rec.session_id, folder_id: rec.folder_id });
      _refreshTrashBadge();
      // New transaction for the update/delete
      rec.images.splice(img.imgIdx, 1);
      const resultEl = studioCanvas.querySelector(`.studio-result[data-studio-id="${img.recordId}"]`);
      const tx2 = db.transaction(STUDIO_DB_STORE, "readwrite");
      if (rec.images.length === 0) {
        tx2.objectStore(STUDIO_DB_STORE).delete(img.recordId);
        if (resultEl) resultEl.remove();
      } else {
        tx2.objectStore(STUDIO_DB_STORE).put(rec);
        if (resultEl) {
          const wrap = resultEl.querySelector(`.studio-img-wrap[data-idx="${img.imgIdx}"]`);
          if (wrap) wrap.remove();
          resultEl.querySelectorAll(".studio-img-wrap").forEach((w, i) => w.dataset.idx = i);
          const grid = resultEl.querySelector(".studio-result-images");
          if (grid) grid.className = `studio-result-images grid-${rec.images.length}`;
        }
      }
    }
  } catch {}
  // Remove from lightbox context and navigate
  _lightboxContext.images.splice(_lightboxContext.index, 1);
  if (_lightboxContext.images.length === 0) { closeLightbox(); return; }
  if (_lightboxContext.index >= _lightboxContext.images.length) _lightboxContext.index = _lightboxContext.images.length - 1;
  _renderLightboxImage();
});

document.addEventListener("keydown", e => {
  if (!studioLightbox.classList.contains("open")) return;
  if (e.key === "Escape") closeLightbox();
  else if (e.key === "ArrowLeft") _lightboxNav(-1);
  else if (e.key === "ArrowRight") _lightboxNav(1);
});

// Lightbox enhance button
studioLightbox.querySelector(".lb-enhance").addEventListener("click", async e => {
  e.stopPropagation();
  const img = _lightboxContext.images[_lightboxContext.index];
  if (!img || !img.base64 || img.recordId == null) return;
  const enhBtn = studioLightbox.querySelector(".lb-enhance");
  enhBtn.disabled = true;
  enhBtn.style.opacity = "0.4";
  studioLightboxImg.style.opacity = "0.5";
  try {
    const cardWrap = document.querySelector(`.studio-result[data-studio-id="${img.recordId}"] .studio-img-wrap[data-idx="${img.imgIdx}"]`);
    const cardImg = cardWrap?.querySelector("img");
    await _upscaleImage(img.base64, img.recordId, img.imgIdx, cardWrap, cardImg, (newB64) => {
      // Update lightbox image
      const newSrc = `data:image/png;base64,${newB64}`;
      studioLightboxImg.src = newSrc;
      img.src = newSrc;
      img.base64 = newB64;
    });
  } finally {
    enhBtn.disabled = false;
    enhBtn.style.opacity = "";
    studioLightboxImg.style.opacity = "";
  }
});

// Lightbox edit (inpaint) button
studioLightbox.querySelector(".lb-edit").addEventListener("click", e => {
  e.stopPropagation();
  const img = _lightboxContext.images[_lightboxContext.index];
  if (!img || !img.base64) return;
  openInpaintEditor(img.src, img.base64, img.recordId, img.imgIdx, img.rawPrompt, img.body);
});

// ═══════════════════════════════════════
//   INPAINT EDITOR
// ═══════════════════════════════════════
const _inpaint = {
  editor: document.getElementById("inpaint-editor"),
  sourceImg: document.getElementById("inpaint-source-img"),
  canvas: document.getElementById("inpaint-canvas"),
  inner: document.getElementById("inpaint-canvas-inner"),
  prompt: document.getElementById("inpaint-prompt"),
  submitBtn: document.getElementById("inpaint-submit"),
  brushSlider: document.getElementById("inpaint-brush-size"),
  brushVal: document.getElementById("inpaint-brush-val"),
  eraserBtn: document.getElementById("inpaint-eraser"),
  undoBtn: document.getElementById("inpaint-undo"),
  clearBtn: document.getElementById("inpaint-clear"),
  closeBtn: document.getElementById("inpaint-close"),
  resetBtn: document.getElementById("inpaint-reset"),
  saveBtn: document.getElementById("inpaint-save"),
  loading: document.getElementById("inpaint-loading"),
  zoomRange: document.getElementById("inpaint-zoom-range"),
  zoomVal: document.getElementById("inpaint-zoom-val"),
  zoomInBtn: document.getElementById("inpaint-zoom-in"),
  zoomOutBtn: document.getElementById("inpaint-zoom-out"),
  ctx: null,
  drawing: false,
  erasing: false,
  history: [],
  brushSize: 30,
  zoom: 100,
  lastSavedId: null,
  unsaved: false,
  lastPrompt: "",
  lastWidth: 0,
  lastHeight: 0,
  // source info
  originalSrc: null,
  originalBase64: null,
  imageSrc: null,
  imageBase64: null,
  recordId: null,
  imgIdx: null,
  rawPrompt: "",
  body: null,
};

function openInpaintEditor(src, base64, recordId, imgIdx, rawPrompt, body) {
  _inpaint.originalSrc = src;
  _inpaint.originalBase64 = base64;
  _inpaint.imageSrc = src;
  _inpaint.imageBase64 = base64;
  _inpaint.recordId = recordId;
  _inpaint.imgIdx = imgIdx;
  _inpaint.rawPrompt = rawPrompt || "";
  _inpaint.body = body || {};
  _inpaint.erasing = false;
  _inpaint.eraserBtn.classList.remove("active");
  _inpaint.history = [];
  _inpaint.prompt.value = "";
  _inpaint.submitBtn.disabled = false;
  _inpaint.loading.classList.remove("active");
  _inpaint.lastSavedId = null;
  _inpaint.unsaved = false;
  _inpaint.saveBtn.classList.remove("has-result");
  _inpaint.zoom = 100;
  _inpaint.zoomRange.value = 100;
  _inpaint.zoomVal.textContent = "100%";

  _inpaint.sourceImg.onload = () => {
    _sizeInpaintCanvas();
    _inpaint.ctx = _inpaint.canvas.getContext("2d");
    _inpaint.ctx.clearRect(0, 0, _inpaint.canvas.width, _inpaint.canvas.height);
    _inpaint.history = [];
  };
  _inpaint.sourceImg.src = src;
  _inpaint.editor.classList.add("active");
  _updateInpaintCursor();
}

function closeInpaintEditor() {
  _inpaint.editor.classList.remove("active");
  _inpaint.sourceImg.src = "";
  _inpaint.history = [];
}

function _sizeInpaintCanvas() {
  const img = _inpaint.sourceImg;
  const wrap = document.getElementById("inpaint-canvas-wrap");
  const wrapW = wrap.clientWidth;
  const wrapH = wrap.clientHeight;

  // Fit image to wrap at 100% zoom
  const scale = Math.min(wrapW / img.naturalWidth, wrapH / img.naturalHeight, 1);
  const baseW = img.naturalWidth * scale;
  const baseH = img.naturalHeight * scale;
  const zoomFactor = _inpaint.zoom / 100;
  const displayW = baseW * zoomFactor;
  const displayH = baseH * zoomFactor;

  _inpaint.inner.style.width = displayW + "px";
  _inpaint.inner.style.height = displayH + "px";
  img.style.width = displayW + "px";
  img.style.height = displayH + "px";

  _inpaint.canvas.width = img.naturalWidth;
  _inpaint.canvas.height = img.naturalHeight;
  _inpaint.canvas.style.width = displayW + "px";
  _inpaint.canvas.style.height = displayH + "px";
}

function _setInpaintZoom(z) {
  _inpaint.zoom = Math.max(25, Math.min(300, Math.round(z)));
  _inpaint.zoomRange.value = _inpaint.zoom;
  _inpaint.zoomVal.textContent = _inpaint.zoom + "%";
  // Re-apply mask data after resize
  const maskData = _inpaint.ctx ? _inpaint.ctx.getImageData(0, 0, _inpaint.canvas.width, _inpaint.canvas.height) : null;
  _sizeInpaintCanvas();
  if (maskData && _inpaint.ctx) _inpaint.ctx.putImageData(maskData, 0, 0);
}

// Zoom controls
_inpaint.zoomRange.addEventListener("input", () => _setInpaintZoom(parseInt(_inpaint.zoomRange.value)));
_inpaint.zoomInBtn.addEventListener("click", () => _setInpaintZoom(_inpaint.zoom + 25));
_inpaint.zoomOutBtn.addEventListener("click", () => _setInpaintZoom(_inpaint.zoom - 25));

// Scroll-to-zoom on the canvas area
document.getElementById("inpaint-canvas-wrap").addEventListener("wheel", e => {
  if (!_inpaint.editor.classList.contains("active")) return;
  e.preventDefault();
  const delta = e.deltaY > 0 ? -15 : 15;
  _setInpaintZoom(_inpaint.zoom + delta);
}, { passive: false });

// Resize canvas when window resizes
window.addEventListener("resize", () => {
  if (_inpaint.editor.classList.contains("active")) _sizeInpaintCanvas();
});

// Drawing helpers
function _getCanvasPos(e) {
  const rect = _inpaint.canvas.getBoundingClientRect();
  const scaleX = _inpaint.canvas.width / rect.width;
  const scaleY = _inpaint.canvas.height / rect.height;
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}

function _saveSnapshot() {
  _inpaint.history.push(_inpaint.ctx.getImageData(0, 0, _inpaint.canvas.width, _inpaint.canvas.height));
  if (_inpaint.history.length > 30) _inpaint.history.shift();
}

function _drawStroke(pos) {
  const ctx = _inpaint.ctx;
  const rect = _inpaint.canvas.getBoundingClientRect();
  const scale = _inpaint.canvas.width / rect.width;
  const radius = _inpaint.brushSize * scale;

  if (_inpaint.erasing) {
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  } else {
    ctx.fillStyle = "rgba(255, 60, 60, 0.4)";
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius / 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Mouse/touch events on canvas
_inpaint.canvas.addEventListener("mousedown", e => {
  _inpaint.drawing = true;
  _saveSnapshot();
  _drawStroke(_getCanvasPos(e));
});
_inpaint.canvas.addEventListener("mousemove", e => {
  if (!_inpaint.drawing) return;
  _drawStroke(_getCanvasPos(e));
});
_inpaint.canvas.addEventListener("mouseup", () => { _inpaint.drawing = false; });
_inpaint.canvas.addEventListener("mouseleave", () => { _inpaint.drawing = false; });

// Touch support
_inpaint.canvas.addEventListener("touchstart", e => {
  e.preventDefault();
  _inpaint.drawing = true;
  _saveSnapshot();
  _drawStroke(_getCanvasPos(e));
}, { passive: false });
_inpaint.canvas.addEventListener("touchmove", e => {
  e.preventDefault();
  if (!_inpaint.drawing) return;
  _drawStroke(_getCanvasPos(e));
}, { passive: false });
_inpaint.canvas.addEventListener("touchend", () => { _inpaint.drawing = false; });

// Brush cursor -circle reflecting brush size
function _updateInpaintCursor() {
  const size = _inpaint.brushSize;
  const r = size / 2;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'><circle cx='${r}' cy='${r}' r='${r - 1}' fill='none' stroke='rgba(255,255,255,0.7)' stroke-width='1.5'/></svg>`;
  _inpaint.canvas.style.cursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${r} ${r}, crosshair`;
}

// Brush size
_inpaint.brushSlider.addEventListener("input", () => {
  _inpaint.brushSize = parseInt(_inpaint.brushSlider.value);
  _inpaint.brushVal.textContent = _inpaint.brushSize;
  _updateInpaintCursor();
});

// Eraser toggle
_inpaint.eraserBtn.addEventListener("click", () => {
  _inpaint.erasing = !_inpaint.erasing;
  _inpaint.eraserBtn.classList.toggle("active", _inpaint.erasing);
});

// Undo
_inpaint.undoBtn.addEventListener("click", () => {
  if (_inpaint.history.length === 0) return;
  _inpaint.ctx.putImageData(_inpaint.history.pop(), 0, 0);
});

// Clear
_inpaint.clearBtn.addEventListener("click", () => {
  _saveSnapshot();
  _inpaint.ctx.clearRect(0, 0, _inpaint.canvas.width, _inpaint.canvas.height);
});

// Close
_inpaint.closeBtn.addEventListener("click", closeInpaintEditor);
_inpaint.editor.addEventListener("click", e => {
  if (e.target === _inpaint.editor) closeInpaintEditor();
});

// Save -persist the current inpaint result to the session feed
_inpaint.saveBtn.addEventListener("click", async () => {
  if (!_inpaint.unsaved || !_inpaint.imageBase64) return;
  const prompt = _inpaint.lastPrompt || _inpaint.prompt.value.trim() || "Inpainted image";
  const newId = "studio_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
  const newRecord = {
    id: newId,
    images: [{ image: _inpaint.imageBase64, model: "sd-inpaint", width: _inpaint.lastWidth, height: _inpaint.lastHeight }],
    rawPrompt: prompt,
    body: { prompt, negative_prompt: _inpaint.body.negative_prompt || "", inpaint: true, source_record: _inpaint.recordId },
    timestamp: Date.now(),
    folder_id: activeImageFolderId,
    session_id: activeStudioSessionId,
  };
  await saveStudioImage(newRecord);
  _inpaint.lastSavedId = newId;
  appendStudioResult(
    [{ image: _inpaint.imageBase64, model: "sd-inpaint", width: _inpaint.lastWidth, height: _inpaint.lastHeight }],
    prompt,
    newRecord.body,
    newId
  );
  renderStudioSessionsList();
  _inpaint.unsaved = false;
  _inpaint.saveBtn.classList.remove("has-result");
});

// Reset -restore original image, clear mask, remove last saved inpaint record
_inpaint.resetBtn.addEventListener("click", async () => {
  _inpaint.imageSrc = _inpaint.originalSrc;
  _inpaint.imageBase64 = _inpaint.originalBase64;
  _inpaint.sourceImg.src = _inpaint.originalSrc;
  _inpaint.ctx.clearRect(0, 0, _inpaint.canvas.width, _inpaint.canvas.height);
  _inpaint.history = [];
  _inpaint.unsaved = false;
  _inpaint.saveBtn.classList.remove("has-result");
  // Remove the last saved inpaint record from IndexedDB and canvas
  if (_inpaint.lastSavedId) {
    const rid = _inpaint.lastSavedId;
    _inpaint.lastSavedId = null;
    try { await deleteStudioImage(rid); } catch {}
    const el = document.querySelector(`.studio-result[data-studio-id="${rid}"]`);
    if (el) el.remove();
    renderStudioSessionsList();
  }
});

// Keyboard shortcuts in inpaint editor
document.addEventListener("keydown", e => {
  if (!_inpaint.editor.classList.contains("active")) return;
  if (e.target === _inpaint.prompt) return; // don't intercept typing in prompt
  if (e.key === "Escape") closeInpaintEditor();
  else if (e.key === "[") {
    _inpaint.brushSize = Math.max(5, _inpaint.brushSize - 5);
    _inpaint.brushSlider.value = _inpaint.brushSize;
    _inpaint.brushVal.textContent = _inpaint.brushSize;
  } else if (e.key === "]") {
    _inpaint.brushSize = Math.min(80, _inpaint.brushSize + 5);
    _inpaint.brushSlider.value = _inpaint.brushSize;
    _inpaint.brushVal.textContent = _inpaint.brushSize;
  } else if (e.key === "e" || e.key === "E") {
    _inpaint.erasing = !_inpaint.erasing;
    _inpaint.eraserBtn.classList.toggle("active", _inpaint.erasing);
  } else if (e.key === "z" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (_inpaint.history.length > 0) _inpaint.ctx.putImageData(_inpaint.history.pop(), 0, 0);
  }
});

// Inpaint settings panel toggle + sliders
document.getElementById("inpaint-settings-toggle").addEventListener("click", function() {
  this.classList.toggle("open");
  document.getElementById("inpaint-settings-panel").classList.toggle("open");
});
document.getElementById("inpaint-set-steps").addEventListener("input", function() {
  document.getElementById("inpaint-set-steps-val").textContent = this.value;
});
document.getElementById("inpaint-set-guidance").addEventListener("input", function() {
  document.getElementById("inpaint-set-guidance-val").textContent = parseFloat(this.value).toFixed(1);
});
document.getElementById("inpaint-set-strength").addEventListener("input", function() {
  document.getElementById("inpaint-set-strength-val").textContent = parseFloat(this.value).toFixed(2);
});

// Export mask: red painted → white, unpainted → black
function _exportInpaintMask() {
  const w = _inpaint.canvas.width, h = _inpaint.canvas.height;
  const srcData = _inpaint.ctx.getImageData(0, 0, w, h);
  const offscreen = document.createElement("canvas");
  offscreen.width = w; offscreen.height = h;
  const offCtx = offscreen.getContext("2d");
  const dest = offCtx.createImageData(w, h);
  for (let i = 0; i < srcData.data.length; i += 4) {
    const alpha = srcData.data[i + 3];
    const val = alpha > 10 ? 255 : 0; // any painted pixel → white (inpaint here)
    dest.data[i] = val;
    dest.data[i + 1] = val;
    dest.data[i + 2] = val;
    dest.data[i + 3] = 255;
  }
  offCtx.putImageData(dest, 0, 0);
  return offscreen.toDataURL("image/png").split(",")[1]; // base64 without prefix
}

// Submit inpaint
_inpaint.submitBtn.addEventListener("click", async () => {
  const prompt = _inpaint.prompt.value.trim();
  if (!prompt) { _inpaint.prompt.focus(); return; }

  // Check if any mask was painted
  const srcData = _inpaint.ctx.getImageData(0, 0, _inpaint.canvas.width, _inpaint.canvas.height);
  let hasPaint = false;
  for (let i = 3; i < srcData.data.length; i += 4) {
    if (srcData.data[i] > 10) { hasPaint = true; break; }
  }
  if (!hasPaint) { alert("Paint the area you want to edit first."); return; }

  _inpaint.submitBtn.disabled = true;
  _inpaint.loading.classList.add("active");

  try {
    const mask = _exportInpaintMask();
    const res = await mediaFetch("/image/inpaint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: _inpaint.imageBase64,
        mask,
        prompt,
        negative_prompt: _inpaint.body.negative_prompt || null,
        steps: parseInt(document.getElementById("inpaint-set-steps").value),
        guidance_scale: parseFloat(document.getElementById("inpaint-set-guidance").value),
        strength: parseFloat(document.getElementById("inpaint-set-strength").value),
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Inpainting failed");
    }
    const data = await res.json();

    // Show result in editor -user can keep editing, save, or close
    const newSrc = `data:image/png;base64,${data.image}`;
    _inpaint.sourceImg.src = newSrc;
    _inpaint.imageBase64 = data.image;
    _inpaint.lastPrompt = prompt;
    _inpaint.lastWidth = data.width;
    _inpaint.lastHeight = data.height;
    _inpaint.unsaved = true;
    _inpaint.saveBtn.classList.add("has-result");
    _inpaint.ctx.clearRect(0, 0, _inpaint.canvas.width, _inpaint.canvas.height);
    _inpaint.history = [];
  } catch (err) {
    alert(err.message || "Inpainting failed");
  } finally {
    _inpaint.submitBtn.disabled = false;
    _inpaint.loading.classList.remove("active");
  }
});

// Enter key submits inpaint prompt
_inpaint.prompt.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    _inpaint.submitBtn.click();
  }
});

// ── Download helper -always reads current pixel state from the img element ──
function _downloadImg(imgEl) {
  const canvas = document.createElement("canvas");
  canvas.width = imgEl.naturalWidth;
  canvas.height = imgEl.naturalHeight;
  canvas.getContext("2d").drawImage(imgEl, 0, 0);
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `studio-${Date.now()}.png`;
  a.click();
}

// ── Upscale helper ──
async function _upscaleImage(base64, recordId, imgIdx, wrap, imgEl, onDone) {
  // Show overlay on card
  const enhBtn = wrap?.querySelector(".img-enhance");
  if (enhBtn) enhBtn.disabled = true;
  let overlay = null;
  if (wrap) {
    overlay = document.createElement("div");
    overlay.className = "enhance-overlay";
    overlay.innerHTML = `<div class="enhance-overlay-spinner"></div><div class="enhance-overlay-label">Enhancing…</div>`;
    wrap.appendChild(overlay);
  }
  // Also show overlay on lightbox if it's open and showing this image
  let lbOverlay = null;
  if (studioLightbox.classList.contains("open")) {
    const lbInner = document.getElementById("studio-lightbox-inner");
    lbOverlay = document.createElement("div");
    lbOverlay.className = "enhance-overlay";
    lbOverlay.innerHTML = `<div class="enhance-overlay-spinner"></div><div class="enhance-overlay-label">Enhancing…</div>`;
    lbInner.appendChild(lbOverlay);
    studioLightbox.querySelector(".lb-enhance").disabled = true;
  }

  try {
    const res = await mediaFetch("/image/upscale", {
      method: "POST",
      body: JSON.stringify({ image: base64, scale: 2 }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.detail || `HTTP ${res.status}`);
    }
    const data = await res.json();

    // Update the displayed image
    const newSrc = `data:image/png;base64,${data.image}`;
    if (imgEl) imgEl.src = newSrc;

    // Update IndexedDB record
    try {
      const db = await openStudioDB();
      const tx = db.transaction(STUDIO_DB_STORE, "readwrite");
      const store = tx.objectStore(STUDIO_DB_STORE);
      const rec = await new Promise(r => { const g = store.get(recordId); g.onsuccess = () => r(g.result); });
      if (rec && rec.images[imgIdx]) {
        rec.images[imgIdx].image = data.image;
        rec.images[imgIdx].width = data.width;
        rec.images[imgIdx].height = data.height;
        store.put(rec);
      }
    } catch (e) { console.warn("Failed to update upscaled image in DB:", e); }

    if (onDone) onDone(data.image);
    showToast(`Enhanced to ${data.width}x${data.height} (${data.elapsed_s}s)`);
  } catch (err) {
    showToast(`Enhance failed: ${err.message}`, "error");
  } finally {
    if (enhBtn) enhBtn.disabled = false;
    overlay?.remove();
    if (lbOverlay) {
      lbOverlay.remove();
      const lbEnh = studioLightbox.querySelector(".lb-enhance");
      if (lbEnh) lbEnh.disabled = false;
    }
  }
}

const studioResolution = document.getElementById("studio-resolution");

const STUDIO_RESOLUTIONS = {
  square:    [
    { w: 512,  h: 512,  label: "512 × 512" },
    { w: 768,  h: 768,  label: "768 × 768" },
    { w: 1024, h: 1024, label: "1024 × 1024", default: true },
    { w: 1536, h: 1536, label: "1536 × 1536" },
  ],
  landscape: [
    { w: 768,  h: 432,  label: "768 × 432" },
    { w: 1024, h: 576,  label: "1024 × 576" },
    { w: 1344, h: 768,  label: "1344 × 768", default: true },
    { w: 1536, h: 864,  label: "1536 × 864" },
  ],
  portrait:  [
    { w: 432,  h: 768,  label: "432 × 768" },
    { w: 576,  h: 1024, label: "576 × 1024" },
    { w: 768,  h: 1344, label: "768 × 1344", default: true },
    { w: 864,  h: 1536, label: "864 × 1536" },
  ],
};

function updateStudioResolutions() {
  const options = STUDIO_RESOLUTIONS[studioAspect] || STUDIO_RESOLUTIONS.square;
  studioResolution.innerHTML = "";
  options.forEach(r => {
    const opt = document.createElement("option");
    opt.value = `${r.w}x${r.h}`;
    opt.textContent = r.label;
    if (r.default) opt.selected = true;
    studioResolution.appendChild(opt);
  });
}

updateStudioResolutions();

const STUDIO_PRESETS = {
  "cinematic":     { suffix: ", cinematic lighting, dramatic composition, film grain, anamorphic lens, movie still", negative: "cartoon, anime, painting, illustration" },
  "anime":         { suffix: ", anime style, cel-shaded, vibrant colors, detailed, studio ghibli quality", negative: "photorealistic, photograph, 3d render" },
  "photorealistic":{ suffix: ", photorealistic, DSLR photograph, 8K UHD, sharp focus, professional photography", negative: "cartoon, painting, illustration, drawing, anime" },
  "digital-art":   { suffix: ", digital art, highly detailed, trending on artstation, vibrant, sharp", negative: "photograph, blurry, low quality" },
  "oil-painting":  { suffix: ", oil painting, classical art, rich textures, brushstrokes visible, masterpiece", negative: "photograph, digital, anime, cartoon" },
  "watercolor":    { suffix: ", watercolor painting, soft edges, translucent colors, paper texture, artistic", negative: "photograph, digital, sharp edges, 3d" },
  "pixel-art":     { suffix: ", pixel art, retro game style, 16-bit, clean pixels, sprite art", negative: "photorealistic, blurry, smooth, 3d render" },
  "3d-render":     { suffix: ", 3D render, octane render, ray tracing, volumetric lighting, highly detailed", negative: "painting, drawing, 2d, flat, cartoon" },
};

// Restore saved images from IndexedDB
let _studioRestored = false;
async function restoreStudioImages(forceReload = false) {
  if (_studioRestored && !forceReload) return;
  _studioRestored = true;
  // Clear canvas for reload
  if (forceReload) {
    studioCanvas.querySelectorAll(".studio-result").forEach(el => el.remove());
    if (studioCanvasEmpty) { studioCanvasEmpty.style.display = ""; studioCanvas.prepend(studioCanvasEmpty); }
  }
  try {
    const records = await loadAllStudioImages();
    const filtered = records.filter(r =>
      (r.folder_id || null) === (activeImageFolderId || null) &&
      (!activeStudioSessionId || r.session_id === activeStudioSessionId)
    );
    filtered.sort((a, b) => a.timestamp - b.timestamp);
    for (const rec of filtered) {
      appendStudioResult(rec.images, rec.rawPrompt, rec.body, rec.id);
    }
    if (filtered.length > 0 && studioCanvasEmpty) studioCanvasEmpty.style.display = "none";
  } catch (e) { console.warn("Failed to restore studio images:", e); }
  renderStudioSessionsList();
}

// Presets details toggle persistence
const scPresetsDetails = document.getElementById("sc-presets-details");
if (scPresetsDetails) {
  scPresetsDetails.addEventListener("toggle", () => {
    localStorage.setItem("diab_studio_presets_open", scPresetsDetails.open ? "1" : "0");
    scheduleSettingsSync();
  });
}
// Restore studio settings from localStorage (called on page load and after login sync)
function restoreStudioSettings() {
  // Presets details open state
  try {
    const presetsOpen = localStorage.getItem("diab_studio_presets_open");
    if (presetsOpen === "1" && scPresetsDetails) scPresetsDetails.open = true;
  } catch {}
  // Control values
  try {
    const c = JSON.parse(localStorage.getItem("diab_studio_controls") || "{}");
    if (c.steps) { studioSteps.value = c.steps; studioStepsVal.textContent = c.steps; }
    if (c.guidance) { studioGuidance.value = c.guidance; studioGuidanceVal.textContent = parseFloat(c.guidance).toFixed(1); }
    if (c.aspect) {
      studioAspect = c.aspect;
      document.querySelectorAll(".studio-aspect-btn").forEach(b => b.classList.toggle("active", b.dataset.aspect === c.aspect));
      updateStudioResolutions();
      if (c.resolution) studioResolution.value = c.resolution;
    }
    if (c.count) {
      studioCount = parseInt(c.count);
      document.querySelectorAll(".studio-count-btn").forEach(b => b.classList.toggle("active", parseInt(b.dataset.count) === studioCount));
    }
    if (c.model) {
      localStorage.setItem("diab_image_model", c.model);
    }
  } catch {}
  // Presets
  if (typeof renderPresetButtons === "function") renderPresetButtons();
}
restoreStudioSettings();
updateStudioSettingsSummary();

// ── Studio image suggestions ──
const STUDIO_SUGGESTIONS = [
  // Portraits & People
  "A weathered fisherman mending nets at dawn, golden hour light, photorealistic",
  "Elegant woman in a flowing silk dress standing in a field of lavender at sunset",
  "Old man playing chess in a sunlit park, autumn leaves falling around him",
  "A young dancer mid-leap, dramatic stage lighting, motion blur on extremities",
  "Street musician playing saxophone in the rain, neon reflections on wet pavement",
  // Animals & Nature
  "Majestic snow leopard resting on a Himalayan cliff, mist rolling through the valley",
  "Hummingbird drinking from a glowing flower in an enchanted forest",
  "Pack of wolves crossing a frozen lake under the aurora borealis",
  "Macro photo of a dragonfly perched on a dewdrop-covered leaf at sunrise",
  "A fox curled up asleep in a hollow tree, soft forest light filtering through",
  // Fantasy & Sci-Fi
  "Ancient dragon perched atop a crumbling Gothic cathedral, stormy sky",
  "Cyberpunk street market at night, holographic signs, steam rising from food stalls",
  "Floating islands connected by rope bridges, waterfalls cascading into clouds below",
  "A wizard's study filled with glowing potions, ancient books, and a crystal ball",
  "Massive space station orbiting a ringed planet, viewed from a shuttle window",
  "Steampunk airship docking at a Victorian sky-port above the clouds",
  "An elven city built into the branches of enormous trees, bioluminescent plants",
  "Robot samurai standing in a zen garden, cherry blossoms falling",
  // Landscapes & Architecture
  "Abandoned Japanese temple overgrown with wisteria, koi pond in foreground",
  "Cozy cabin in a snowy forest at night, warm light glowing from windows, smoke from chimney",
  "Venice canals at twilight, gondola gliding past ornate buildings, soft reflections",
  "Terraced rice fields in Bali at sunrise, mist in the valleys, vibrant green",
  "Art deco skyscraper piercing through low clouds, city lights below, golden hour",
  "A hidden waterfall in a tropical jungle, sunbeams breaking through the canopy",
  "Lighthouse on a rocky cliff during a violent storm, massive waves crashing",
  "Ancient Roman aqueduct stretching across a lush green valley at dawn",
  "A narrow cobblestone alley in Santorini, white and blue buildings, bougainvillea",
  "Crystal cave with bioluminescent formations reflecting in an underground lake",
  // Still Life & Objects
  "Vintage typewriter on a desk by a rainy window, cup of coffee steaming",
  "An old leather-bound spellbook open to a page with glowing runes",
  "Ornate pocket watch lying on autumn leaves, raindrops on the glass",
  "A glass terrarium containing a miniature ecosystem with tiny waterfalls",
  "Collection of antique astronomical instruments on a mahogany desk, candlelight",
  // Food & Drink
  "Artisan chocolate cake with gold leaf decoration, moody food photography",
  "Japanese tea ceremony setup, matcha in a handmade ceramic bowl, zen garden",
  "A rustic wooden table with fresh bread, cheese, wine, and wildflowers",
  // Abstract & Artistic
  "Surreal melting clock landscape inspired by Dali, desert setting at twilight",
  "Abstract fluid art explosion of neon colors on a dark background",
  "Geometric impossible architecture in the style of M.C. Escher, dramatic shadows",
  "Paper quilling artwork of a detailed ocean wave with tiny ships",
  "Stained glass window depicting a cosmic scene with galaxies and nebulae",
  // Vehicles & Transportation
  "Classic 1960s muscle car on Route 66 at sunset, desert landscape",
  "Futuristic solar-powered yacht sailing through bioluminescent waters at night",
  "Steam locomotive crossing a towering bridge in the Scottish Highlands, fog",
  // Seasonal & Weather
  "Cherry blossom tunnel in full bloom, petals drifting in a gentle breeze",
  "Northern lights over a mirror-still fjord, mountains reflected perfectly",
  "Thunderstorm rolling over a vast wheat field, lightning illuminating the sky",
  "First snow falling on a quiet village street, warm shop windows glowing",
  // Underwater & Ocean
  "Underwater coral reef city inhabited by merpeople, sunlight filtering through water",
  "Giant whale swimming through clouds above a mountain range, surreal dreamscape",
  "Shipwreck on the ocean floor covered in coral and surrounded by fish",
  // Interior & Rooms
  "A cozy reading nook in a tower room, circular window overlooking a forest",
  "Abandoned grand ballroom with chandelier, light streaming through broken windows",
  "A modern minimalist living room with floor-to-ceiling windows facing a mountain lake",
  "An alchemist's workshop with bubbling flasks, mysterious ingredients, warm firelight",
  // Space & Cosmic
  "Astronaut floating above Earth, reflection of a nebula in the visor",
  "Alien landscape with twin suns setting behind crystalline rock formations",
  "Space garden on a generation ship, plants growing in zero-gravity pods",
  "A comet passing close to a space station, viewed from an observation deck",
  // Dark & Moody
  "Gothic castle on a hill, full moon, bats silhouetted against the sky",
  "A lone figure with an umbrella walking through a foggy Victorian street, gas lamps",
  "Abandoned amusement park at night, one carousel still lit and slowly turning",
  "Dark forest path illuminated by floating lanterns, mysterious atmosphere",
  // Cute & Whimsical
  "A tiny village built inside a hollowed-out pumpkin, fairy lights, miniature detail",
  "Cat wearing a tiny space suit floating among stars and planets",
  "A magical library where the books fly off shelves and arrange themselves",
  "Miniature garden city on the back of a giant tortoise, detailed tilt-shift",
  // Cinematic Scenes
  "Samurai standing alone on a misty bridge, katana drawn, cherry blossoms falling",
  "A heist scene: figure in black rappelling down a glass skyscraper at night",
  "Two knights jousting in a grand medieval tournament, crowd cheering",
  "Explorer discovering a hidden temple in dense jungle, vines and ruins",
  // Portraits & Characters
  "Cybernetic detective in a noir-style office, rain on the window, blue neon glow",
  "Viking shieldmaiden standing on a longship prow, stormy seas, fierce expression",
  "Elderly Japanese artisan crafting pottery, serene expression, natural light",
  "A pirate captain at the helm during a sunset, tattered flag flying",
  // Mashups & Unique
  "A library that is also an aquarium, fish swimming between bookshelves",
  "Medieval castle built on top of a massive mushroom in an enchanted forest",
  "A train station where the trains are clouds and passengers float to board",
  "City skyline made entirely of musical instruments, surreal architecture",
];

let _lastSuggestionIdx = -1;
function _pickLocalStudioSuggestion() {
  let idx;
  do { idx = Math.floor(Math.random() * STUDIO_SUGGESTIONS.length); }
  while (idx === _lastSuggestionIdx && STUDIO_SUGGESTIONS.length > 1);
  _lastSuggestionIdx = idx;
  studioPrompt.value = STUDIO_SUGGESTIONS[idx];
  studioPrompt.style.height = "auto";
  studioPrompt.style.height = Math.min(studioPrompt.scrollHeight, 140) + "px";
}
async function pickStudioSuggestion() {
  const btn = document.getElementById("studio-suggest-btn");
  btn.disabled = true;
  btn.classList.add("loading");
  studioPrompt.value = "Thinking of something...";
  studioPrompt.classList.add("prompt-locked");
  try {
    const res = await mediaFetch("/image/inspire");
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (data.prompt) {
      studioPrompt.value = data.prompt;
      studioPrompt.style.height = "auto";
      studioPrompt.style.height = Math.min(studioPrompt.scrollHeight, 140) + "px";
    } else {
      _pickLocalStudioSuggestion();
    }
  } catch {
    _pickLocalStudioSuggestion();
  } finally {
    studioPrompt.classList.remove("prompt-locked");
    btn.disabled = false;
    btn.classList.remove("loading");
  }
  studioPrompt.focus();
}
document.getElementById("studio-suggest-btn").addEventListener("click", pickStudioSuggestion);


// ── Image Studio Trash ──
const studioTrashModal = document.getElementById("studio-trash-modal");
document.getElementById("studio-trash-btn").addEventListener("click", () => openTrashModal());
document.getElementById("studio-trash-close-btn").addEventListener("click", () => studioTrashModal.classList.remove("open"));
studioTrashModal.addEventListener("click", e => { if (e.target === studioTrashModal) studioTrashModal.classList.remove("open"); });

async function openTrashModal() {
  // Auto-purge items older than 30 days
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const all = await loadAllTrash();
  for (const item of all) { if (item.deletedAt < cutoff) await deleteFromTrash(item.id); }
  studioTrashModal.classList.add("open");
  await renderTrashGrid();
}

async function renderTrashGrid() {
  const grid = document.getElementById("studio-trash-grid");
  const countLabel = document.getElementById("studio-trash-count-label");
  const items = (await loadAllTrash()).sort((a, b) => b.deletedAt - a.deletedAt);
  grid.innerHTML = "";
  countLabel.textContent = items.length ? `${items.length} item${items.length !== 1 ? "s" : ""}` : "";
  updateTrashBadge(items.length);
  items.forEach(item => {
    const card = document.createElement("div");
    card.className = "trash-card";
    const age = _trashAge(item.deletedAt);
    card.innerHTML = `
      <img src="data:image/png;base64,${item.image}" alt="${esc(item.rawPrompt || "")}" />
      <div class="trash-card-info">
        <div class="trash-card-prompt">${esc(item.rawPrompt || "")}</div>
        <div class="trash-card-age">Deleted ${age}</div>
      </div>
      <div class="trash-card-actions">
        <button class="trash-restore-btn" title="Restore">${icon("refresh")}</button>
        <button class="trash-del-btn" title="Delete permanently">${icon("trash")}</button>
      </div>
    `;
    card.querySelector(".trash-restore-btn").addEventListener("click", async () => {
      await _restoreFromTrash(item);
      await deleteFromTrash(item.id);
      card.remove();
      const remaining = document.querySelectorAll(".trash-card").length;
      countLabel.textContent = remaining ? `${remaining} item${remaining !== 1 ? "s" : ""}` : "";
      updateTrashBadge(remaining);
    });
    card.querySelector(".trash-del-btn").addEventListener("click", async () => {
      await deleteFromTrash(item.id);
      card.remove();
      const remaining = document.querySelectorAll(".trash-card").length;
      countLabel.textContent = remaining ? `${remaining} item${remaining !== 1 ? "s" : ""}` : "";
      updateTrashBadge(remaining);
    });
    grid.appendChild(card);
  });
}

async function _restoreFromTrash(item) {
  const db = await openStudioDB();
  const id = `studio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = item.session_id || ("sess_" + id);
  const record = {
    id, session_id: sessionId, folder_id: item.folder_id || activeImageFolderId,
    rawPrompt: item.rawPrompt, body: item.body || {},
    images: [{ image: item.image, model: item.model, width: item.width, height: item.height, elapsed_s: 0 }],
    timestamp: Date.now(),
  };
  await new Promise((res, rej) => {
    const tx = db.transaction(STUDIO_DB_STORE, "readwrite");
    tx.objectStore(STUDIO_DB_STORE).put(record);
    tx.oncomplete = res; tx.onerror = rej;
  });
  // If restored to active image folder/session, re-render
  if (record.folder_id === activeImageFolderId) {
    appendStudioResult(record.images, record.rawPrompt, record.body, record.id);
    renderStudioSessionsList();
  }
}

function _trashAge(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function updateTrashBadge(count) {
  const badge = document.getElementById("studio-trash-badge");
  if (badge) { badge.textContent = count; badge.style.display = ""; }
}

async function _refreshTrashBadge() {
  const items = await loadAllTrash();
  updateTrashBadge(items.length);
}

document.getElementById("studio-trash-empty-btn").addEventListener("click", async () => {
  const count = document.querySelectorAll(".trash-card").length;
  if (!count) return;
  if (!confirm(`Permanently delete ${count} item${count !== 1 ? "s" : ""} from trash?`)) return;
  await emptyTrash();
  updateTrashBadge(0);
  studioTrashModal.classList.remove("open");
});

// ── Image Folders ──
async function loadImageFolders() {
  try {
    imageFolders = await loadAllImageFolders();
    if (imageFolders.length === 0) {
      // Create a default image folder
      const defaultPg = { id: "pg_" + Date.now(), name: "My Images", description: "Default folder for generated images", timestamp: Date.now() };
      await saveImageFolder(defaultPg);
      imageFolders = [defaultPg];
    }
    if (!activeImageFolderId || !imageFolders.find(p => p.id === activeImageFolderId)) {
      activeImageFolderId = imageFolders[0].id;
      localStorage.setItem("diab_image_folder", activeImageFolderId);
    }
    renderImageFoldersSidebar();
  } catch (e) { console.warn("Failed to load image folders:", e); }
}

function renderImageFoldersSidebar() {
  const list = document.getElementById("image-folders-list");
  list.innerHTML = "";
  imageFolders.forEach(pg => {
    const row = document.createElement("div");
    row.className = "sb-folder-row" + (pg.id === activeImageFolderId ? " active" : "");
    row.dataset.id = pg.id;
    const iconSvg = `<svg class="sb-folder-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 3.5C1.5 2.948 1.948 2.5 2.5 2.5H6.086a1 1 0 0 1 .707.293L7.914 3.914A1 1 0 0 0 8.621 4.2H13.5c.552 0 1 .448 1 1v7.3c0 .552-.448 1-1 1h-11c-.552 0-1-.448-1-1V3.5z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>`;
    row.innerHTML = `${iconSvg}<div class="sb-folder-info"><div class="sb-folder-name">${esc(pg.name)}</div>${pg.description ? `<div class="sb-folder-desc">${esc(pg.description)}</div>` : ""}</div><button class="sb-folder-menu" title="Options">⋯</button>`;
    row.addEventListener("click", e => {
      if (e.target.classList.contains("sb-folder-menu")) return;
      if (pg.id === activeImageFolderId) return;
      activeImageFolderId = pg.id;
      localStorage.setItem("diab_image_folder", pg.id);
      renderImageFoldersSidebar();
      _studioRestored = false;
      restoreStudioImages(true);
    });
    row.querySelector(".sb-folder-menu").addEventListener("click", e => {
      e.stopPropagation();
      showImageFolderCtxMenu(pg, e);
    });
    // Drag-and-drop target for studio sessions
    row.addEventListener("dragover", e => {
      if (!e.dataTransfer.types.includes("text/studio-session")) return;
      e.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", async e => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const sid = e.dataTransfer.getData("text/studio-session");
      if (!sid) return;
      try {
        const db = await openStudioDB();
        // Get all records, find those belonging to this session_id
        const all = await new Promise((res, rej) => {
          const tx = db.transaction("images", "readonly");
          const r = tx.objectStore("images").getAll();
          r.onsuccess = () => res(r.result);
          r.onerror = rej;
        });
        const matching = all.filter(r => (r.session_id || ("sess_" + r.id)) === sid);
        if (!matching.length) return;
        const tx = db.transaction("images", "readwrite");
        const store = tx.objectStore("images");
        for (const rec of matching) {
          rec.folder_id = pg.id;
          store.put(rec);
        }
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
        // Remove session's result cards from current canvas
        matching.forEach(rec => {
          const resultEl = studioCanvas.querySelector(`.studio-result[data-studio-id="${rec.id}"]`);
          if (resultEl) resultEl.remove();
        });
        renderStudioSessionsList();
      } catch (err) { console.warn("Failed to move session:", err); }
    });
    list.appendChild(row);
  });
}

let activeSessionId = null;
let activeStudioSessionId = localStorage.getItem("diab_studio_session") || null;

function relativeTime(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

function _groupSessionsByDate(records) {
  const groups = { Today: [], Yesterday: [], "Last 7 Days": [], Older: [] };
  const now = new Date();
  const today = now.toDateString();
  const yesterday = new Date(now - 86400000).toDateString();
  const week = new Date(now - 7 * 86400000);
  records.forEach(r => {
    const d = new Date(r.timestamp);
    if (d.toDateString() === today) groups.Today.push(r);
    else if (d.toDateString() === yesterday) groups.Yesterday.push(r);
    else if (d >= week) groups["Last 7 Days"].push(r);
    else groups.Older.push(r);
  });
  return groups;
}

async function renderStudioSessionsList() {
  const list = document.getElementById("studio-sessions-list");
  if (!list || list.style.display === "none") return;
  list.innerHTML = "";
  try {
    const records = await loadAllStudioImages();
    const filtered = records
      .filter(r => r.folder_id === activeImageFolderId)
      .sort((a, b) => b.timestamp - a.timestamp);
    if (!filtered.length) return;

    // Group records by session_id
    const sessionMap = new Map();
    for (const rec of filtered) {
      const sid = rec.session_id || ("sess_" + rec.id);
      if (!sessionMap.has(sid)) {
        sessionMap.set(sid, { session_id: sid, records: [], firstPrompt: rec.sessionName || rec.rawPrompt, latestTimestamp: rec.timestamp, imageCount: 0 });
      }
      const sess = sessionMap.get(sid);
      sess.records.push(rec);
      sess.imageCount += (rec.images ? rec.images.length : 1);
      if (rec.timestamp > sess.latestTimestamp) sess.latestTimestamp = rec.timestamp;
      // Use sessionName if available on any record in the session
      if (rec.sessionName && !sess._hasSessionName) {
        sess.firstPrompt = rec.sessionName;
        sess._hasSessionName = true;
      }
    }

    // Sort sessions by latest timestamp descending
    const sessions = Array.from(sessionMap.values()).sort((a, b) => b.latestTimestamp - a.latestTimestamp);

    // Group sessions by date
    const dateGroups = _groupSessionsByDate(sessions.map(s => ({ ...s, timestamp: s.latestTimestamp })));
    Object.entries(dateGroups).forEach(([label, items]) => {
      if (!items.length) return;
      const gl = document.createElement("div");
      gl.className = "conv-group-label";
      gl.textContent = label;
      list.appendChild(gl);
      items.forEach(sess => list.appendChild(_makeGroupedSessionItem(sess)));
    });
  } catch (e) { console.warn("Failed to render sessions:", e); }
}

function _makeGroupedSessionItem(sess) {
  const item = document.createElement("div");
  item.className = "sb-item studio-session-item" + (sess.session_id === activeStudioSessionId ? " active" : "");
  item.dataset.sessionId = sess.session_id;
  item.draggable = true;
  const badge = `<span class="sb-item-badge studio-session-badge">${sess.imageCount}</span>`;
  item.innerHTML = `<span class="sb-item-title studio-session-prompt">${esc(sess.firstPrompt)}</span>${badge}<button class="sb-item-menu studio-session-menu" title="Options">&#x22EF;</button>`;
  item.addEventListener("dragstart", e => {
    e.dataTransfer.setData("text/studio-session", sess.session_id);
    item.classList.add("dragging");
  });
  item.addEventListener("dragend", () => item.classList.remove("dragging"));
  item.addEventListener("click", e => {
    if (e.target.classList.contains("studio-session-menu")) return;
    // Switch to this session
    activeStudioSessionId = sess.session_id;
    localStorage.setItem("diab_studio_session", sess.session_id);
    document.querySelectorAll(".studio-session-item").forEach(el =>
      el.classList.toggle("active", el.dataset.sessionId === sess.session_id));
    // Re-render canvas filtered to this session
    _studioRestored = false;
    restoreStudioImages(true);
  });
  item.querySelector(".studio-session-menu").addEventListener("click", e => {
    e.stopPropagation();
    showGroupedSessionCtxMenu(sess, item, e);
  });
  return item;
}

function showGroupedSessionCtxMenu(sess, itemEl, e) {
  document.querySelectorAll(".session-ctx-menu, .session-sub-menu").forEach(m => m.remove());
  const menu = document.createElement("div");
  menu.className = "session-ctx-menu";
  menu.style.cssText = `position:fixed;z-index:999;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,0.4);min-width:160px;`;

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
      // Rename the first (oldest) record in the session
      const firstRec = sess.records[sess.records.length - 1];
      if (firstRec) {
        const db = await openStudioDB();
        const tx = db.transaction(STUDIO_DB_STORE, "readwrite");
        const store = tx.objectStore(STUDIO_DB_STORE);
        const existing = await new Promise(r => { const g = store.get(firstRec.id); g.onsuccess = () => r(g.result); });
        if (existing) { existing.sessionName = name.trim(); store.put(existing); }
      }
    } catch {}
    renderStudioSessionsList();
  });
  menu.appendChild(renameItem);

  // Move to Folder
  const moveWrap = document.createElement("div");
  moveWrap.style.position = "relative";
  const moveBtn = document.createElement("div");
  moveBtn.style.cssText = "padding:6px 12px;cursor:pointer;font-size:0.8rem;border-radius:6px;color:var(--text-dim);display:flex;align-items:center;justify-content:space-between;";
  moveBtn.innerHTML = `Move to Folder <span>&#x25B8;</span>`;
  const otherPgs = imageFolders.filter(pg => pg.id !== activeImageFolderId);
  if (otherPgs.length === 0) moveBtn.style.opacity = "0.4";
  moveBtn.addEventListener("mouseenter", () => {
    moveBtn.style.background = "var(--surface2)";
    if (otherPgs.length === 0) return;
    document.querySelectorAll(".session-sub-menu").forEach(m => m.remove());
    const sub = document.createElement("div");
    sub.className = "session-sub-menu";
    sub.style.cssText = `position:fixed;z-index:1000;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,0.4);min-width:140px;`;
    const rect = moveBtn.getBoundingClientRect();
    sub.style.left = (rect.right + 4) + "px";
    sub.style.top = rect.top + "px";
    otherPgs.forEach(pg => {
      const pgItem = document.createElement("div");
      pgItem.style.cssText = "padding:6px 12px;cursor:pointer;font-size:0.8rem;border-radius:6px;color:var(--text-dim);";
      pgItem.textContent = pg.name;
      pgItem.addEventListener("mouseenter", () => pgItem.style.background = "var(--surface2)");
      pgItem.addEventListener("mouseleave", () => pgItem.style.background = "");
      pgItem.addEventListener("click", async () => {
        try {
          const db = await openStudioDB();
          const tx = db.transaction(STUDIO_DB_STORE, "readwrite");
          const store = tx.objectStore(STUDIO_DB_STORE);
          for (const rec of sess.records) {
            const existing = await new Promise(r => { const g = store.get(rec.id); g.onsuccess = () => r(g.result); });
            if (existing) { existing.folder_id = pg.id; store.put(existing); }
          }
        } catch {}
        sess.records.forEach(rec => {
          studioCanvas.querySelector(`.studio-result[data-studio-id="${rec.id}"]`)?.remove();
        });
        itemEl.remove();
        menu.remove();
        document.querySelectorAll(".session-sub-menu").forEach(m => m.remove());
        if (studioCanvas.querySelectorAll(".studio-result").length === 0 && studioCanvasEmpty)
          studioCanvasEmpty.style.display = "";
      });
      sub.appendChild(pgItem);
    });
    document.body.appendChild(sub);
  });
  moveBtn.addEventListener("mouseleave", () => {
    moveBtn.style.background = "";
    setTimeout(() => { if (!document.querySelector(".session-sub-menu:hover")) document.querySelectorAll(".session-sub-menu").forEach(m => m.remove()); }, 150);
  });
  moveWrap.appendChild(moveBtn);
  menu.appendChild(moveWrap);

  // Delete entire session
  const delItem = document.createElement("div");
  delItem.style.cssText = "padding:6px 12px;cursor:pointer;font-size:0.8rem;border-radius:6px;color:var(--danger);";
  delItem.textContent = `Delete session (${sess.imageCount} image${sess.imageCount !== 1 ? "s" : ""})`;
  delItem.addEventListener("mouseenter", () => delItem.style.background = "rgba(239,68,68,0.1)");
  delItem.addEventListener("mouseleave", () => delItem.style.background = "");
  delItem.addEventListener("click", async () => {
    try {
      for (const rec of sess.records) {
        // Trash each image before deleting the record
        if (rec.images) {
          for (const imgData of rec.images) {
            await saveToTrash({ id: _makeTrashId(), deletedAt: Date.now(), image: imgData.image, rawPrompt: rec.rawPrompt, body: rec.body, model: imgData.model, width: imgData.width, height: imgData.height, session_id: rec.session_id, folder_id: rec.folder_id });
          }
        }
        await deleteStudioImage(rec.id);
        studioCanvas.querySelector(`.studio-result[data-studio-id="${rec.id}"]`)?.remove();
      }
      _refreshTrashBadge();
    } catch {}
    itemEl.remove();
    menu.remove();
    if (studioCanvas.querySelectorAll(".studio-result").length === 0 && studioCanvasEmpty)
      studioCanvasEmpty.style.display = "";
    if (activeStudioSessionId === sess.session_id) {
      activeStudioSessionId = null;
      localStorage.removeItem("diab_studio_session");
    }
  });
  menu.appendChild(delItem);

  menu.style.left = e.clientX + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - 140) + "px";
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener("click", () => {
    menu.remove();
    document.querySelectorAll(".session-sub-menu").forEach(m => m.remove());
  }, { once: true }), 0);
}

function showImageFolderCtxMenu(pg, e) {
  // Remove any existing menu
  document.querySelectorAll(".pg-ctx-menu").forEach(el => el.remove());
  const menu = document.createElement("div");
  menu.className = "pg-ctx-menu";
  menu.style.cssText = `position:fixed;z-index:999;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,0.4);min-width:120px;`;
  menu.innerHTML = `
    <div class="pg-ctx-item" data-action="rename" style="padding:6px 12px;cursor:pointer;font-size:0.8rem;border-radius:6px;color:var(--text-dim);">Edit</div>
    <div class="pg-ctx-item" data-action="delete" style="padding:6px 12px;cursor:pointer;font-size:0.8rem;border-radius:6px;color:var(--danger);">Delete</div>
  `;
  menu.style.left = e.clientX + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - 80) + "px";
  document.body.appendChild(menu);

  menu.querySelector('[data-action="rename"]').addEventListener("click", () => {
    menu.remove();
    openImageFolderModal(pg);
  });
  menu.querySelector('[data-action="delete"]').addEventListener("click", async () => {
    menu.remove();
    if (imageFolders.length <= 1) {
      showToast("At least one folder must exist.");
      return;
    }
    const confirmed = await showConfirm({ title: "Delete Folder", message: `Delete "${pg.name}"? All images in this folder will be deleted.` });
    if (!confirmed) return;
    // Delete all images in this folder
    const allImages = await loadAllStudioImages();
    const toDelete = allImages.filter(r => r.folder_id === pg.id);
    for (const img of toDelete) {
      await deleteStudioImage(img.id);
    }
    await deleteImageFolder(pg.id);
    imageFolders = imageFolders.filter(p => p.id !== pg.id);
    if (activeImageFolderId === pg.id) {
      activeImageFolderId = imageFolders[0].id;
      localStorage.setItem("diab_image_folder", activeImageFolderId);
    }
    renderImageFoldersSidebar();
    _studioRestored = false;
    restoreStudioImages(true);
  });

  // Hover styles
  menu.querySelectorAll(".pg-ctx-item").forEach(item => {
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

// Image Folder modal
let _editingImageFolderId = null;
function openImageFolderModal(pg) {
  _editingImageFolderId = pg ? pg.id : null;
  document.getElementById("image-folder-modal-title").textContent = pg ? "Edit Folder" : "New Folder";
  document.getElementById("image-folder-name").value = pg?.name || "";
  document.getElementById("image-folder-desc").value = pg?.description || "";
  document.getElementById("image-folder-save").textContent = pg ? "Save" : "Create Folder";
  document.getElementById("image-folder-modal").classList.add("open");
  document.getElementById("image-folder-name").focus();
}
function closeImageFolderModal() {
  document.getElementById("image-folder-modal").classList.remove("open");
  _editingImageFolderId = null;
}
document.getElementById("image-folder-modal-close").addEventListener("click", closeImageFolderModal);
document.getElementById("image-folder-cancel").addEventListener("click", closeImageFolderModal);
document.getElementById("image-folder-modal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeImageFolderModal();
});
document.getElementById("image-folder-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("image-folder-save").click();
  if (e.key === "Escape") closeImageFolderModal();
});
document.getElementById("image-folder-save").addEventListener("click", async () => {
  const name = document.getElementById("image-folder-name").value.trim();
  const description = document.getElementById("image-folder-desc").value.trim() || "";
  if (!name) { document.getElementById("image-folder-name").focus(); return; }
  if (_editingImageFolderId) {
    const pg = imageFolders.find(p => p.id === _editingImageFolderId);
    if (pg) { pg.name = name; pg.description = description; await saveImageFolder(pg); }
  } else {
    const pg = { id: "pg_" + Date.now(), name, description, timestamp: Date.now() };
    await saveImageFolder(pg);
    imageFolders.push(pg);
    activeImageFolderId = pg.id;
    localStorage.setItem("diab_image_folder", pg.id);
    _studioRestored = false;
    restoreStudioImages(true);
  }
  closeImageFolderModal();
  renderImageFoldersSidebar();
});
document.getElementById("image-folder-new-btn").addEventListener("click", () => openImageFolderModal(null));

// Make sidebar row highlighting work
["new-chat-btn", "search-open-btn"].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("click", hideStudio);
});

// Save studio control values
function saveStudioControls() {
  localStorage.setItem("diab_studio_controls", JSON.stringify({
    steps: studioSteps.value,
    guidance: studioGuidance.value,
    aspect: studioAspect,
    resolution: studioResolution.value,
    count: studioCount,
    model: studioModelSelect.value,
  }));
  scheduleSettingsSync();
  updateStudioSettingsSummary();
}

// Slider wiring
studioSteps.addEventListener("input", () => { studioStepsVal.textContent = studioSteps.value; saveStudioControls(); });
studioGuidance.addEventListener("input", () => { studioGuidanceVal.textContent = parseFloat(studioGuidance.value).toFixed(1); saveStudioControls(); });
studioResolution.addEventListener("change", saveStudioControls);

// Aspect ratio buttons
document.querySelectorAll(".studio-aspect-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".studio-aspect-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    studioAspect = btn.dataset.aspect;
    updateStudioResolutions();
    saveStudioControls();
  });
});

// ── Dynamic preset system with custom presets ──
const CUSTOM_PRESETS_KEY = "diab_studio_custom_presets";
function getCustomPresets() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY) || "{}"); } catch { return {}; }
}
function saveCustomPresets(presets) {
  localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(presets));
  scheduleSettingsSync();
}
function getAllPresets() {
  return { ...STUDIO_PRESETS, ...getCustomPresets() };
}
function renderPresetButtons() {
  const grid = document.getElementById("studio-preset-grid");
  grid.innerHTML = "";
  const all = getAllPresets();
  const custom = getCustomPresets();
  Object.keys(all).forEach(key => {
    const btn = document.createElement("button");
    btn.className = "studio-preset-btn" + (studioActivePreset === key ? " active" : "");
    btn.dataset.preset = key;
    const isCustom = key in custom;
    const label = key.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    btn.innerHTML = label + (isCustom ? ` <span class="preset-del" title="Delete preset">&times;</span>` : "");
    btn.addEventListener("click", (e) => {
      if (e.target.classList.contains("preset-del")) {
        const cp = getCustomPresets();
        delete cp[key];
        saveCustomPresets(cp);
        if (studioActivePreset === key) studioActivePreset = null;
        renderPresetButtons();
        return;
      }
      if (studioActivePreset === key) {
        studioActivePreset = null;
      } else {
        studioActivePreset = key;
      }
      renderPresetButtons();
      updateStudioSettingsSummary();
    });
    grid.appendChild(btn);
  });
}
renderPresetButtons();

// Save custom preset
document.getElementById("studio-save-preset-btn").addEventListener("click", () => {
  const nameInput = document.getElementById("studio-custom-preset-name");
  const name = nameInput.value.trim();
  if (!name) return;
  const key = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  if (!key) return;
  const suffix = studioNegative.value.trim()
    ? "" : ", " + name.toLowerCase() + " style";
  const cp = getCustomPresets();
  cp[key] = {
    suffix: ", " + name.toLowerCase() + " style, highly detailed",
    negative: studioNegative.value.trim() || "",
  };
  saveCustomPresets(cp);
  nameInput.value = "";
  studioActivePreset = key;
  renderPresetButtons();
});


// Random seed
document.getElementById("studio-random-seed").addEventListener("click", () => {
  studioSeed.value = Math.floor(Math.random() * 2147483647);
});

// Load models for studio
let _studioModelsLoaded = false;
async function loadStudioModels() {
  try {
    const res = await mediaFetch("/image/models");
    const data = await res.json();
    _studioModelsCache = data.models || [];
    studioModelSelect.innerHTML = "";
    data.models.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      if (m.id === data.current) opt.selected = true;
      studioModelSelect.appendChild(opt);
    });
    const saved = localStorage.getItem("diab_image_model");
    if (saved && data.models.some(m => m.id === saved)) studioModelSelect.value = saved;
    updateStudioModelLabel();
    // Only apply model defaults on first load if no saved controls exist
    if (!_studioModelsLoaded) {
      _studioModelsLoaded = true;
      if (!localStorage.getItem("diab_studio_controls")) updateStudioModelDefaults();
    }
    updateStudioSettingsSummary();
  } catch {
    studioModelSelect.innerHTML = `<option value="">Unavailable</option>`;
    updateStudioSettingsSummary();
  }
}

function updateStudioModelLabel() {
  const m = _studioModelsCache.find(x => x.id === studioModelSelect.value);
  if (m && studioModelLabel) studioModelLabel.textContent = m.name;
}

function updateStudioModelDefaults() {
  const m = _studioModelsCache.find(x => x.id === studioModelSelect.value);
  if (!m) return;
  if (studioModelLabel) studioModelLabel.textContent = m.name;
  studioSteps.value = m.default_steps;
  studioSteps.max = m.max_steps;
  studioStepsVal.textContent = m.default_steps;
  studioGuidance.value = m.guidance_scale;
  studioGuidanceVal.textContent = m.guidance_scale.toFixed(1);
  saveStudioControls();
}

studioModelSelect.addEventListener("change", async () => {
  const newModel = studioModelSelect.value;
  if (!newModel) return;
  const modelName = studioModelSelect.options[studioModelSelect.selectedIndex]?.textContent || newModel;
  // Load new image model in background with generate-gate
  _modelReady.studio = false;
  _setModelLoading("studio", true, modelName);
  studioModelSelect.disabled = true;
  try {
    const res = await mediaFetch("/image/models/load", {
      method: "POST",
      body: JSON.stringify({ model: newModel }),
    });
    if (res.ok) {
      localStorage.setItem("diab_image_model", newModel);
      updateStudioModelDefaults();
      saveStudioControls();
      scheduleSettingsSync();
    }
  } catch {}
  _modelReady.studio = true;
  _setModelLoading("studio", false);
  studioModelSelect.disabled = false;
});

// Generate (queuing handled inside studioGenerate)
let studioAbortController = null;
studioGenerateBtn.addEventListener("click", () => studioGenerate());
studioPrompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    studioGenerate();
  }
});
studioPrompt.addEventListener("input", () => {
  studioPrompt.style.height = "auto";
  studioPrompt.style.height = Math.min(studioPrompt.scrollHeight, 140) + "px";
});

// createStudioPlaceholder — thin wrapper around shared _createGenProgress
function createStudioPlaceholder() {
  return _createGenProgress();
}

function renderStudioQueueTray() {
  const tray = document.getElementById("studio-queue-tray");
  if (!tray) return;
  tray.innerHTML = studioQueue.map((item, i) => `
    <div class="queue-item" data-idx="${i}">
      <span class="queue-item-pos">#${i + 1}</span>
      <span class="queue-item-text">${esc(item.rawPrompt)}</span>
      <button class="queue-item-cancel" title="Remove from queue" data-idx="${i}">
        ${icon("x", 11)}
      </button>
    </div>
  `).join("");
  tray.querySelectorAll(".queue-item-cancel").forEach(btn => {
    btn.addEventListener("click", () => {
      studioQueue.splice(parseInt(btn.dataset.idx), 1);
      renderStudioQueueTray();
    });
  });
}

async function studioGenerate() {
  const rawPrompt = studioPrompt.value.trim();
  if (!rawPrompt) return;
  if (!_modelReady.studio) {
    showToast("Image model is loading, please wait...");
    return;
  }

  // If already generating, queue the request
  if (studioGenerating) {
    // Capture current settings for the queue
    let qPrompt = rawPrompt;
    let qNeg = studioNegative.value.trim() || null;
    const qPresets = getAllPresets();
    if (studioActivePreset && qPresets[studioActivePreset]) {
      const p = qPresets[studioActivePreset];
      qPrompt += p.suffix;
      if (p.negative) qNeg = qNeg ? qNeg + ", " + p.negative : p.negative;
    }
    const [qW, qH] = studioResolution.value.split("x").map(Number);
    const qBody = {
      prompt: qPrompt, negative_prompt: qNeg, aspect: studioAspect,
      width: qW, height: qH, steps: parseInt(studioSteps.value),
      seed: studioSeed.value ? parseInt(studioSeed.value) : null,
      guidance_scale: parseFloat(studioGuidance.value),
      model: studioModelSelect.value || null,
      _preset: studioActivePreset || null,
    };
    studioQueue.push({ rawPrompt, body: qBody, count: studioCount });
    renderStudioQueueTray();
    studioPrompt.value = "";
    return;
  }

  studioGenerating = true;
  studioAbortController = new AbortController();

  // Build prompt with preset
  let prompt = rawPrompt;
  let negativePrompt = studioNegative.value.trim() || null;
  const allPresets = getAllPresets();
  if (studioActivePreset && allPresets[studioActivePreset]) {
    const p = allPresets[studioActivePreset];
    prompt += p.suffix;
    if (p.negative) {
      negativePrompt = negativePrompt ? negativePrompt + ", " + p.negative : p.negative;
    }
  }

  const seed = studioSeed.value ? parseInt(studioSeed.value) : null;
  const [resW, resH] = studioResolution.value.split("x").map(Number);
  const body = {
    prompt,
    negative_prompt: negativePrompt,
    aspect: studioAspect,
    width: resW,
    height: resH,
    steps: parseInt(studioSteps.value),
    seed,
    guidance_scale: parseFloat(studioGuidance.value),
    model: studioModelSelect.value || null,
    _preset: studioActivePreset || null,
  };

  const count = studioCount;

  // Insert shared generating progress into canvas
  const placeholder = createStudioPlaceholder();
  if (studioCanvasEmpty) studioCanvasEmpty.style.display = "none";
  studioCanvas.prepend(placeholder.el);
  placeholder.stopBtn.addEventListener("click", () => {
    mediaFetch("/image/cancel", { method: "POST" }).catch(() => {});
    studioAbortController?.abort();
    studioAbortController = null;
  });
  studioCanvas.scrollTo({ top: 0, behavior: "smooth" });

  let pollTimer = setInterval(async () => {
    try {
      const pr = await mediaFetch("/image/progress");
      if (!pr.ok) return;
      const p = await pr.json();
      if (p.running && p.total_steps > 0) {
        placeholder.update(p.step, p.total_steps, p.elapsed_s);
      } else if (!p.running && p.step === 0) {
        placeholder.setStatus("Preparing model…");
      }
    } catch {}
  }, 1000);

  let currentImgIdx = 1;
  const results = [];
  // Pre-create the result container so images appear as they arrive
  const resultId = `studio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let liveResult = null;
  let liveGrid = null;

  try {
    for (let i = 0; i < count; i++) {
      currentImgIdx = i + 1;
      if (count > 1) placeholder.setStatus(`Generating image ${currentImgIdx}/${count}...`);
      const iterBody = { ...body };
      delete iterBody._preset;
      if (count > 1 && !seed) {
        iterBody.seed = Math.floor(Math.random() * 2147483647);
      }
      const res = await mediaFetch("/image/generate", {
        method: "POST",
        body: JSON.stringify(iterBody),
        signal: studioAbortController?.signal,
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      results.push(data);

      // First image: create the result container and swap out placeholder
      if (i === 0 && count > 1) {
        placeholder.el.remove();
        liveResult = _createLiveResult(resultId, rawPrompt, body, count);
        liveGrid = liveResult.querySelector(".studio-result-images");
        liveResult.querySelector(".studio-live-stop").addEventListener("click", () => {
          studioAbortController?.abort();
          studioAbortController = null;
        });
        studioCanvas.prepend(liveResult);
      }

      // Append this image to the live grid
      if (liveResult && liveGrid) {
        _appendImageToGrid(liveGrid, liveResult, data, results.length - 1, resultId, rawPrompt, body, results);
        // Show progress for next image
        const progressEl = liveResult.querySelector(".studio-live-progress");
        if (progressEl && i < count - 1) {
          progressEl.style.display = "";
          progressEl.querySelector(".slp-text").textContent = `Generating image ${i + 2} of ${count}...`;
        } else {
          const liveFooter = liveResult.querySelector(".studio-live-footer");
          if (liveFooter) liveFooter.remove();
        }
      }
    }

    // Single image or finalize
    if (count === 1) {
      placeholder.el.remove();
      appendStudioResult(results, rawPrompt, body);
    } else if (liveResult) {
      const liveFooter = liveResult.querySelector(".studio-live-footer");
      if (liveFooter) liveFooter.remove();
      // Update the IndexedDB record with all images
      _persistStudioRecord(resultId, results, rawPrompt, body);
      renderStudioSessionsList();
    }
  } catch (err) {
    if (placeholder.el.parentNode) placeholder.el.remove();
    const wasCancelled = err.name === "AbortError";
    if (results.length > 0 && !liveResult) {
      appendStudioResult(results, rawPrompt, body);
    } else if (results.length > 0 && liveResult && wasCancelled) {
      // Persist partial results when cancelled mid-batch
      _persistStudioRecord(resultId, results, rawPrompt, body);
      renderStudioSessionsList();
    } else if (results.length === 0 && !liveResult) {
      if (studioCanvasEmpty) studioCanvasEmpty.style.display = "";
    }
    if (!wasCancelled) {
      appendStudioError(err.message || "Generation failed");
    }
  } finally {
    clearInterval(pollTimer);
    if (placeholder.el.parentNode) placeholder.destroy();
    studioGenerating = false;
    studioAbortController = null;
    studioGenerateBtn.disabled = false;

    // Auto-name session in background if this was the first generation
    if (results.length > 0 && rawPrompt) {
      const _nameSessionId = activeStudioSessionId;
      (async () => {
        try {
          // Wait for IndexedDB save to flush
          await new Promise(r => setTimeout(r, 500));
          const allRecs = await loadAllStudioImages();
          const sessionRecs = allRecs.filter(r => r.session_id === _nameSessionId);

          if (sessionRecs.length <= 1) {
            const nameResp = await mediaFetch("/image/name-session", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ prompt: rawPrompt }),
            });
            if (nameResp.ok) {
              const { name } = await nameResp.json();
              if (name && sessionRecs[0]) {
                const mdb = await openStudioDB();
                const tx = mdb.transaction("images", "readwrite");
                const store = tx.objectStore("images");
                const existing = await new Promise(r => { const g = store.get(sessionRecs[0].id); g.onsuccess = () => r(g.result); });
                if (existing) {
                  existing.sessionName = name;
                  store.put(existing);
                }
                renderStudioSessionsList();
              }
            }
          }
        } catch (e) { console.warn("Image session naming failed:", e); }
      })();
    }

    // Drain queue: if requests are waiting, fire the next one
    if (studioQueue.length > 0) {
      const next = studioQueue.shift();
      renderStudioQueueTray();
      // Restore settings from queued body and generate
      studioPrompt.value = next.rawPrompt;
      studioCount = next.count;
      studioGenerate();
    }
  }
}

// Create a live result container for progressive multi-image display
function _createLiveResult(id, rawPrompt, body, totalCount) {
  if (studioCanvasEmpty) studioCanvasEmpty.style.display = "none";
  const preset = body._preset || studioActivePreset || null;
  const result = document.createElement("div");
  result.className = "studio-result";
  result.dataset.studioId = id;
  result.innerHTML = `
    <div class="studio-result-images grid-${totalCount}"></div>
    <div class="studio-live-footer">
      <div class="studio-live-progress" style="display:none"><span class="slp-dot"></span><span class="slp-text"></span></div>
      <button class="studio-live-stop" title="Stop generation"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>Stop</button>
    </div>
    <div class="studio-meta-details">
      <div class="studio-meta-prompt">${esc(rawPrompt)}${preset ? ` <span style="color:var(--accent);">[${preset}]</span>` : ""}</div>
      <span class="studio-meta-pills"></span>
    </div>
  `;
  return result;
}

// Append a single image to a live result grid
function _appendImageToGrid(grid, result, data, idx, id, rawPrompt, body, allResults) {
  const wrap = document.createElement("div");
  wrap.className = "studio-img-wrap";
  wrap.dataset.idx = idx;
  wrap.innerHTML = `
    <img src="data:image/png;base64,${data.image}" alt="${esc(rawPrompt)}" />
    <span class="img-res-label"></span>
    <button class="img-fav-solo img-fav" title="Add to favorites">
      ${icon("heart", 18)}
    </button>
    <div class="studio-img-actions">
      <button class="img-action-btn img-vary" title="Generate variation">
        ${icon("bolt", 12)}
      </button>
      <button class="img-action-btn img-enhance" title="Enhance (upscale)">
        ${icon("sparkles", 12)}
      </button>
      <button class="img-action-btn img-edit" title="Edit (inpaint)">
        ${icon("edit", 12)}
      </button>
      <button class="img-action-btn img-dl" title="Download">
        ${icon("download", 12)}
      </button>
      <button class="img-action-btn img-del" title="Delete this image">
        ${icon("trash-simple", 12)}
      </button>
    </div>
  `;
  const img = wrap.querySelector("img");
  wrap.addEventListener("mouseenter", () => {
    const lbl = wrap.querySelector(".img-res-label");
    if (lbl && img.naturalWidth) lbl.textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
  });
  img.addEventListener("click", () => {
    // Build lightbox list from all images in this result
    const wraps = result.querySelectorAll(".studio-img-wrap");
    const lbList = [];
    wraps.forEach((w, i) => {
      const wImg = w.querySelector("img");
      const wData = allResults[i] || {};
      lbList.push({ src: wImg.src, base64: wData.image, recordId: id, imgIdx: i, rawPrompt, body, model: wData.model, width: wData.width, height: wData.height });
    });
    openLightbox(img.src, lbList, idx);
  });
  wrap.querySelector(".img-fav").addEventListener("click", async () => {
    const favBtn = wrap.querySelector(".img-fav");
    const isFav = favBtn.classList.toggle("is-fav");
    const favId = `fav_${id}_${idx}`;
    favBtn.dataset.favId = favId;
    if (isFav) {
      await saveFavorite({ id: favId, image: data.image, model: data.model, width: data.width, height: data.height, prompt: rawPrompt, body, timestamp: Date.now() });
    } else {
      await deleteFavorite(favId);
    }
    refreshFavoritesPanel();
  });
  wrap.querySelector(".img-vary").addEventListener("click", () => {
    studioPrompt.value = rawPrompt;
    studioNegative.value = body.negative_prompt || "";
    studioSteps.value = body.steps;
    studioStepsVal.textContent = body.steps;
    studioGuidance.value = body.guidance_scale;
    studioGuidanceVal.textContent = body.guidance_scale.toFixed(1);
    studioSeed.value = Math.floor(Math.random() * 2147483647);
    document.querySelectorAll(".studio-aspect-btn").forEach(b => b.classList.toggle("active", b.dataset.aspect === body.aspect));
    studioAspect = body.aspect;
    updateStudioResolutions();
    if (body.width && body.height) studioResolution.value = `${body.width}x${body.height}`;
    studioGenerate();
  });
  wrap.querySelector(".img-dl").addEventListener("click", () => _downloadImg(img));
  wrap.querySelector(".img-enhance").addEventListener("click", () => {
    const currentB64 = img.src.startsWith("data:image/png;base64,") ? img.src.slice(22) : img.src.split(",")[1];
    _upscaleImage(currentB64, id, idx, wrap, img);
  });
  wrap.querySelector(".img-edit").addEventListener("click", () => {
    const b64 = img.src.startsWith("data:image/png;base64,") ? img.src.slice(22) : img.src.split(",")[1];
    openInpaintEditor(img.src, b64, id, idx, rawPrompt, body);
  });
  wrap.querySelector(".img-del").addEventListener("click", async () => {
    wrap.remove();
    try {
      const db = await openStudioDB();
      // Read record in its own transaction
      const rec = await new Promise(r => { const tx = db.transaction(STUDIO_DB_STORE, "readonly"); const g = tx.objectStore(STUDIO_DB_STORE).get(id); g.onsuccess = () => r(g.result); });
      if (rec) {
        const imgIdx = parseInt(wrap.dataset.idx);
        const imgData = rec.images[imgIdx];
        if (imgData) await saveToTrash({ id: _makeTrashId(), deletedAt: Date.now(), image: imgData.image, rawPrompt: rec.rawPrompt, body: rec.body, model: imgData.model, width: imgData.width, height: imgData.height, session_id: rec.session_id, folder_id: rec.folder_id });
        // New transaction for the update/delete
        rec.images.splice(imgIdx, 1);
        const tx2 = db.transaction(STUDIO_DB_STORE, "readwrite");
        if (rec.images.length === 0) { tx2.objectStore(STUDIO_DB_STORE).delete(id); result.remove(); }
        else {
          tx2.objectStore(STUDIO_DB_STORE).put(rec);
          result.querySelectorAll(".studio-img-wrap").forEach((w, i) => w.dataset.idx = i);
          grid.className = `studio-result-images grid-${rec.images.length}`;
        }
        _refreshTrashBadge();
      }
    } catch {}
  });
  grid.appendChild(wrap);

  // Update meta pills (target inner span to preserve action buttons)
  const totalElapsed = allResults.reduce((s, d) => s + (d.elapsed_s || 0), 0);
  result.querySelector(".studio-meta-pills").innerHTML = `
    <span class="meta-pill">${esc(data.model)}</span>
    <span class="meta-pill">${data.width}×${data.height}</span>
    <span class="meta-pill">${body.steps} steps</span>
    <span class="meta-pill">cfg ${body.guidance_scale}</span>
    <span class="meta-pill">${totalElapsed.toFixed(1)}s</span>
  `;
}

// Persist a studio record to IndexedDB
function _persistStudioRecord(id, results, rawPrompt, body) {
  const preset = body._preset || studioActivePreset || null;
  // Auto-create a session if none active
  if (!activeStudioSessionId) {
    activeStudioSessionId = "sess_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
    localStorage.setItem("diab_studio_session", activeStudioSessionId);
  }
  const record = {
    id,
    images: results.map(d => ({ image: d.image, model: d.model, width: d.width, height: d.height, elapsed_s: d.elapsed_s })),
    rawPrompt,
    body: { ...body, _preset: preset },
    timestamp: Date.now(),
    folder_id: activeImageFolderId,
    session_id: activeStudioSessionId,
  };
  saveStudioImage(record).catch(e => console.warn("Failed to save studio image:", e));
}

function appendStudioResult(dataArr, rawPrompt, body, recordId) {
  if (!Array.isArray(dataArr)) dataArr = [dataArr];
  if (studioCanvasEmpty) studioCanvasEmpty.style.display = "none";

  const id = recordId || `studio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const preset = body._preset || studioActivePreset || null;
  const totalElapsed = dataArr.reduce((s, d) => s + (d.elapsed_s || 0), 0);

  const result = document.createElement("div");
  result.className = "studio-result";
  result.dataset.studioId = id;

  // Build image grid with per-image overlay controls
  const gridClass = `grid-${dataArr.length}`;
  const imagesHtml = dataArr.map((d, i) => `
    <div class="studio-img-wrap" data-idx="${i}">
      <img src="data:image/png;base64,${d.image}" alt="${esc(rawPrompt)}" />
      <span class="img-res-label"></span>
      <button class="img-fav-solo img-fav" title="Add to favorites">
        ${icon("heart", 18)}
      </button>
      <div class="studio-img-actions">
        <button class="img-action-btn img-vary" title="Generate variation">
          ${icon("bolt", 12)}
        </button>
        <button class="img-action-btn img-enhance" title="Enhance (upscale)">
          ${icon("sparkles", 12)}
        </button>
        <button class="img-action-btn img-edit" title="Edit (inpaint)">
          ${icon("edit", 12)}
        </button>
        <button class="img-action-btn img-dl" title="Download">
          ${icon("download", 12)}
        </button>
        <button class="img-action-btn img-del" title="Delete this image">
          ${icon("trash-simple", 12)}
        </button>
      </div>
    </div>
  `).join("");

  result.innerHTML = `
    <div class="studio-result-images ${gridClass}">${imagesHtml}</div>
    <div class="studio-meta-details">
      <span class="studio-meta-pills">
        ${dataArr[0].model ? `<span class="meta-pill">${esc(dataArr[0].model)}</span>` : ""}
        ${dataArr[0].width ? `<span class="meta-pill">${dataArr[0].width}×${dataArr[0].height}</span>` : ""}
        ${body?.steps ? `<span class="meta-pill">${body.steps} steps</span>` : ""}
        ${body?.guidance_scale != null ? `<span class="meta-pill">cfg ${body.guidance_scale}</span>` : ""}
        ${totalElapsed > 0 ? `<span class="meta-pill">${totalElapsed.toFixed(1)}s</span>` : ""}
        <button class="studio-prompt-toggle">${icon("chevron-down", 8)} Prompt</button>
      </span>
      <div class="studio-meta-prompt">${esc(rawPrompt)}${preset ? ` <span style="color:var(--accent);">[${preset}]</span>` : ""}</div>
    </div>
  `;

  // Build lightbox list for this result
  const _lbListForResult = dataArr.map((d, i) => ({
    src: `data:image/png;base64,${d.image}`, base64: d.image, recordId: id, imgIdx: i,
    rawPrompt, body, model: d.model, width: d.width, height: d.height,
  }));

  // Prompt toggle
  const promptToggle = result.querySelector(".studio-prompt-toggle");
  if (promptToggle) {
    promptToggle.addEventListener("click", () => {
      promptToggle.classList.toggle("open");
      result.querySelector(".studio-meta-prompt").classList.toggle("open");
    });
  }

  // Per-image: click to lightbox, info toggle, download, delete
  result.querySelectorAll(".studio-img-wrap").forEach(wrap => {
    const img = wrap.querySelector("img");
    const idx = parseInt(wrap.dataset.idx);
    wrap.addEventListener("mouseenter", () => {
      const lbl = wrap.querySelector(".img-res-label");
      if (lbl && img.naturalWidth) lbl.textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
    });
    img.addEventListener("click", () => openLightbox(img.src, _lbListForResult, idx));
    wrap.querySelector(".img-fav").addEventListener("click", async () => {
      const favBtn = wrap.querySelector(".img-fav");
      const isFav = favBtn.classList.toggle("is-fav");
      const imgData = dataArr[idx];
      const favId = `fav_${id}_${idx}`;
      favBtn.dataset.favId = favId;
      if (isFav) {
        await saveFavorite({ id: favId, image: imgData.image, model: imgData.model, width: imgData.width, height: imgData.height, prompt: rawPrompt, body, timestamp: Date.now() });
      } else {
        await deleteFavorite(favId);
      }
      refreshFavoritesPanel();
    });
    wrap.querySelector(".img-vary").addEventListener("click", () => {
      studioPrompt.value = rawPrompt;
      studioNegative.value = body.negative_prompt || "";
      studioSteps.value = body.steps;
      studioStepsVal.textContent = body.steps;
      studioGuidance.value = body.guidance_scale;
      studioGuidanceVal.textContent = body.guidance_scale.toFixed(1);
      studioSeed.value = Math.floor(Math.random() * 2147483647);
      document.querySelectorAll(".studio-aspect-btn").forEach(b => b.classList.toggle("active", b.dataset.aspect === body.aspect));
      studioAspect = body.aspect;
      updateStudioResolutions();
      if (body.width && body.height) studioResolution.value = `${body.width}x${body.height}`;
      studioGenerate();
    });
    wrap.querySelector(".img-dl").addEventListener("click", () => _downloadImg(img));
    wrap.querySelector(".img-enhance").addEventListener("click", () => {
      const currentB64 = img.src.startsWith("data:image/png;base64,") ? img.src.slice(22) : img.src.split(",")[1];
      _upscaleImage(currentB64, id, idx, wrap, img);
    });
    wrap.querySelector(".img-edit").addEventListener("click", () => {
      const b64 = img.src.startsWith("data:image/png;base64,") ? img.src.slice(22) : img.src.split(",")[1];
      openInpaintEditor(img.src, b64, id, idx, rawPrompt, body);
    });
    wrap.querySelector(".img-del").addEventListener("click", async () => {
      wrap.remove();
      // Update IndexedDB -remove this image from the record
      try {
        const db = await openStudioDB();
        // Read in its own transaction
        const rec = await new Promise(r => { const tx = db.transaction(STUDIO_DB_STORE, "readonly"); const g = tx.objectStore(STUDIO_DB_STORE).get(id); g.onsuccess = () => r(g.result); });
        if (rec) {
          const imgData = rec.images[idx];
          if (imgData) await saveToTrash({ id: _makeTrashId(), deletedAt: Date.now(), image: imgData.image, rawPrompt: rec.rawPrompt, body: rec.body, model: imgData.model, width: imgData.width, height: imgData.height, session_id: rec.session_id, folder_id: rec.folder_id });
          _refreshTrashBadge();
          // New transaction for the update/delete
          rec.images.splice(idx, 1);
          const tx2 = db.transaction(STUDIO_DB_STORE, "readwrite");
          if (rec.images.length === 0) {
            tx2.objectStore(STUDIO_DB_STORE).delete(id);
            result.remove();
          } else {
            tx2.objectStore(STUDIO_DB_STORE).put(rec);
            // Re-index remaining wraps
            result.querySelectorAll(".studio-img-wrap").forEach((w, i) => w.dataset.idx = i);
            // Update grid class
            const grid = result.querySelector(".studio-result-images");
            grid.className = `studio-result-images grid-${rec.images.length}`;
          }
        }
      } catch {}
    });
  });


  studioCanvas.insertBefore(result, studioCanvas.firstChild);
  studioCanvas.scrollTop = 0;

  // Persist to IndexedDB (unless restoring from DB)
  if (!recordId) {
    // Auto-create a session if none active
    if (!activeStudioSessionId) {
      activeStudioSessionId = "sess_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
      localStorage.setItem("diab_studio_session", activeStudioSessionId);
    }
    const record = {
      id,
      images: dataArr.map(d => ({ image: d.image, model: d.model, width: d.width, height: d.height, elapsed_s: d.elapsed_s })),
      rawPrompt,
      body: { ...body, _preset: preset },
      timestamp: Date.now(),
      folder_id: activeImageFolderId,
      session_id: activeStudioSessionId,
    };
    saveStudioImage(record).catch(e => console.warn("Failed to save studio image:", e));
    renderStudioSessionsList();
  }
}

function appendStudioError(msg) {
  const result = document.createElement("div");
  result.className = "studio-result";
  result.style.borderColor = "var(--danger)";
  result.innerHTML = `
    <div style="padding:20px;text-align:center;">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <p style="color:var(--danger);margin-top:8px;font-size:0.85rem;">${esc(msg)}</p>
    </div>
  `;
  studioCanvas.insertBefore(result, studioCanvas.firstChild);
}

