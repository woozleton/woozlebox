// ══════════════════════════════════════════════════════════════
// STUDIO API - Server-backed persistence for all studios.
// Drop-in replacement for createStudioDB() but uses REST API.
// ══════════════════════════════════════════════════════════════

/* global apiFetch, API, getToken */

/**
 * Map each studio's IndexedDB store names to API concepts.
 * Each studio uses different store names (e.g., "images" vs "tracks" vs "snippets")
 * but they all map to the same API: items, favorites, trash, folders.
 */
const _studioStoreMap = {
  image:     { items: "images",   favorites: "favorites", trash: "trash", folders: "folders" },
  music:     { items: "tracks",   favorites: "favorites", trash: "trash", folders: "folders" },
  video:     { items: "videos",   favorites: "favorites", trash: "trash", folders: "folders" },
  code:      { items: "snippets", favorites: "favorites", trash: "trash", folders: "folders" },
  notetaker: { items: "notes",    favorites: "favorites", trash: "trash", folders: "folders" },
};

function _storeCategory(studio, storeName) {
  const map = _studioStoreMap[studio];
  if (!map) return null;
  for (const [category, name] of Object.entries(map)) {
    if (name === storeName) return category;
  }
  return null;
}


/**
 * Create a server-backed API object with the same interface as createStudioDB():
 *   save(storeName, record)
 *   loadAll(storeName)
 *   remove(storeName, id)
 *   clear(storeName)
 *   has(storeName, id)
 */
function createStudioAPI(studio) {
  const base = `/studio/${studio}`;

  async function save(storeName, record) {
    const category = _storeCategory(studio, storeName);

    if (category === "folders") {
      await apiFetch(`${base}/folders`, {
        method: "POST",
        body: JSON.stringify({
          id: record.id || null,
          name: record.name || "",
          description: record.description || null,
        }),
      });
      return;
    }

    // Items, favorites, and trash all save into the items table.
    // Favorites and trash are distinguished by is_favorite / deleted_at columns.
    const isFavorite = category === "favorites";
    const isTrash = category === "trash";

    // Build metadata - everything except fields that have dedicated columns.
    const meta = { ...record };
    delete meta.id;
    delete meta.folder_id;
    delete meta.session_id;
    delete meta.rawPrompt;
    delete meta.raw_prompt;
    delete meta.title;

    // Extract media blobs and replace with filename references.
    const mediaFiles = _extractMedia(studio, meta);

    // Determine created_at from record timestamp if present.
    const createdAt = record.timestamp
      ? new Date(record.timestamp).toISOString()
      : null;

    const itemId = record.id;
    const res = await apiFetch(`${base}/items`, {
      method: "POST",
      body: JSON.stringify({
        id: itemId,
        folder_id: record.folder_id || null,
        session_id: record.session_id || null,
        raw_prompt: record.rawPrompt || record.raw_prompt || null,
        title: record.title || null,
        meta: JSON.stringify(meta),
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Studio save failed: ${err}`);
    }

    // Set favorite/trash status if needed.
    if (isFavorite) {
      await apiFetch(`${base}/items/${itemId}/favorite`, { method: "POST" });
    }
    if (isTrash) {
      await apiFetch(`${base}/items/${itemId}/trash`, { method: "POST" });
    }

    // Upload media files if any.
    if (mediaFiles.length > 0) {
      const fd = new FormData();
      for (const f of mediaFiles) fd.append("files", f.blob, f.filename);
      await apiFetch(`${base}/items/${itemId}/media`, { method: "POST", body: fd });
    }
  }


  async function loadAll(storeName) {
    const category = _storeCategory(studio, storeName);
    let url;
    if (category === "folders") url = `${base}/folders`;
    else if (category === "favorites") url = `${base}/favorites`;
    else if (category === "trash") url = `${base}/trash`;
    else url = `${base}/items`;

    const res = await apiFetch(url);
    if (!res.ok) return [];
    const rows = await res.json();

    // Folders are simple objects - pass through as-is.
    if (category === "folders") return rows;
    // Reconstruct record shape expected by studio JS.
    return rows.map(r => _toStudioRecord(studio, r));
  }


  async function remove(storeName, id) {
    const category = _storeCategory(studio, storeName);
    if (category === "folders") {
      await apiFetch(`${base}/folders/${id}`, { method: "DELETE" });
    } else if (category === "trash") {
      await apiFetch(`${base}/trash/${id}`, { method: "DELETE" });
    } else if (category === "favorites") {
      await apiFetch(`${base}/items/${id}/favorite`, { method: "DELETE" });
    } else {
      await apiFetch(`${base}/items/${id}`, { method: "DELETE" });
    }
  }


  async function clear(storeName) {
    const category = _storeCategory(studio, storeName);
    if (category === "trash") {
      await apiFetch(`${base}/trash`, { method: "DELETE" });
    }
    // clear() on items/favorites/folders is not used in practice.
  }


  async function has(storeName, id) {
    const category = _storeCategory(studio, storeName);
    if (category === "favorites") {
      // Check if item exists and is_favorite
      try {
        const res = await apiFetch(`${base}/items/${id}`);
        if (!res.ok) return false;
        const item = await res.json();
        return !!item.is_favorite;
      } catch { return false; }
    }
    try {
      const res = await apiFetch(`${base}/items/${id}`);
      return res.ok;
    } catch { return false; }
  }


  return { save, loadAll, remove, clear, has };
}


// ── Media extraction ──
// Strips base64 blobs from records before uploading metadata,
// returns file objects for separate multipart upload.

function _extractMedia(studio, meta) {
  const files = [];

  if (studio === "image" && meta.images) {
    meta.images.forEach((img, i) => {
      if (img.image) {
        files.push({
          blob: _b64toBlob(img.image, "image/png"),
          filename: `img_${i}.png`,
        });
        img.file = `img_${i}.png`;
        delete img.image;
      }
    });
  }

  // Handle flat image format (used by image favorites/trash)
  if (studio === "image" && meta.image && !meta.images) {
    files.push({
      blob: _b64toBlob(meta.image, "image/png"),
      filename: "img_0.png",
    });
    meta.file = "img_0.png";
    delete meta.image;
  }

  if (studio === "music" && meta.audio) {
    files.push({
      blob: _b64toBlob(meta.audio, "audio/mpeg"),
      filename: "audio.mp3",
    });
    delete meta.audio;
  }

  if (studio === "video" && meta.video) {
    files.push({
      blob: _b64toBlob(meta.video, "video/mp4"),
      filename: "video.mp4",
    });
    delete meta.video;
  }

  return files;
}


function _b64toBlob(b64, mime) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}


// ── Record reconstruction ──
// Server returns {id, studio, user_id, folder_id, session_id, raw_prompt, title, meta, ...}.
// Studio JS expects the original record shape with rawPrompt, timestamp, etc.

function _toStudioRecord(studio, row) {
  let meta = {};
  try { meta = typeof row.meta === "string" ? JSON.parse(row.meta) : (row.meta || {}); } catch {}

  const rec = {
    id: row.id,
    folder_id: row.folder_id,
    session_id: row.session_id,
    rawPrompt: row.raw_prompt,
    title: row.title || meta.title || null,
    timestamp: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    _favorite: !!row.is_favorite,
    ...meta,
  };

  // Trash records need deletedAt.
  if (row.deleted_at) {
    rec.deletedAt = new Date(row.deleted_at).getTime();
  }

  // Reconstruct media URLs where base64 was stripped.
  if (studio === "image" && rec.images) {
    rec.images.forEach(img => {
      if (img.file && !img.image) {
        img._url = studioMediaUrl("image", row.id, img.file);
      }
    });
  }
  // Flat image format (favorites/trash) - reconstruct URL from file reference
  if (studio === "image" && rec.file && !rec.image && !rec.images) {
    rec._imgUrl = studioMediaUrl("image", row.id, rec.file);
  }
  if (studio === "music" && !rec.audio && row.id) {
    rec._audioUrl = studioMediaUrl("music", row.id, "audio.mp3");
  }
  if (studio === "video" && !rec.video && row.id) {
    rec._videoUrl = studioMediaUrl("video", row.id, "video.mp4");
  }

  return rec;
}


/**
 * Build an authenticated media URL for a studio item file.
 */
function studioMediaUrl(studio, itemId, filename) {
  const base = `${API}/studio/${studio}/items/${itemId}/media/${filename}`;
  const token = typeof getToken === "function" ? getToken() : "";
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}
