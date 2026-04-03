// ══════════════════════════════════════════════════════════════
// SHARED STUDIO UTILITIES
// Small helpers used by image, music, and video studios.
// ══════════════════════════════════════════════════════════════

/**
 * Format a timestamp as a relative trash age string.
 * Used by all three trash modals.
 */
function trashAge(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Update a badge element's text and visibility.
 * Works for both trash badges and fav badges.
 */
function updateBadge(elementId, count) {
  const el = document.getElementById(elementId);
  if (el) {
    el.textContent = count || "";
    el.style.display = count ? "" : "none";
  }
}

/**
 * Wire a settings panel toggle: clicking the trigger toggles
 * both the crumb and the panel open/closed.
 */
function wireSettingsToggle(triggerId, crumbId, panelId) {
  document.getElementById(triggerId).addEventListener("click", () => {
    document.getElementById(crumbId).classList.toggle("open");
    document.getElementById(panelId).classList.toggle("open");
  });
}

/**
 * Auto-purge trash items older than 30 days.
 * Returns the remaining items after purge.
 */
async function purgeOldTrash(loadFn, deleteFn, days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const all = await loadFn();
  for (const item of all) {
    if (item.deletedAt < cutoff) await deleteFn(item.id);
  }
}
