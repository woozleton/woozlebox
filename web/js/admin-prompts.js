/* admin-prompts.js - Admin prompt template editor (accordion UI) */

let _promptData = [];
const _promptSaveTimers = {};

async function loadPromptTemplates() {
  const container = document.getElementById("prompt-editor-list");
  if (!container) return;
  try {
    const resp = await apiFetch("/prompts");
    _promptData = await resp.json();
    _renderPromptAccordion(container);
    _wirePromptHelp();
  } catch (e) {
    container.innerHTML = '<div class="setting-desc">Failed to load prompt templates.</div>';
  }
}

function _wirePromptHelp() {
  const btn = document.getElementById("prompt-help-btn");
  const panel = document.getElementById("prompt-help-panel");
  if (!btn || !panel) return;
  btn.onclick = () => {
    const show = panel.style.display === "none";
    panel.style.display = show ? "" : "none";
    btn.style.color = show ? "var(--accent)" : "";
  };
}

function _renderPromptAccordion(container) {
  container.innerHTML = "";

  // Group by category, preserving order from server
  const categories = [];
  const catMap = {};
  for (const p of _promptData) {
    if (!catMap[p.category]) {
      catMap[p.category] = [];
      categories.push(p.category);
    }
    catMap[p.category].push(p);
  }

  for (const cat of categories) {
    const prompts = catMap[cat];
    const modCount = prompts.filter(p => p.modified).length;
    const section = document.createElement("div");
    section.className = "prompt-section";

    // Header
    const header = document.createElement("div");
    header.className = "prompt-section-header";
    header.innerHTML =
      '<svg class="prompt-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>' +
      '<span class="prompt-section-name">' + esc(cat) + '</span>' +
      '<span class="prompt-section-count">' + prompts.length + ' prompt' + (prompts.length !== 1 ? 's' : '') + '</span>' +
      (modCount > 0 ? '<span class="prompt-section-modified">' + modCount + ' modified</span>' : '');
    header.onclick = () => {
      const wasOpen = section.classList.contains("open");
      container.querySelectorAll(".prompt-section.open").forEach(s => s.classList.remove("open"));
      if (!wasOpen) section.classList.add("open");
    };
    section.appendChild(header);

    // Body
    const body = document.createElement("div");
    body.className = "prompt-section-body";
    for (const p of prompts) {
      body.appendChild(_buildPromptCard(p));
    }
    section.appendChild(body);
    container.appendChild(section);
  }

  // Reset All button
  const resetAllBtn = document.getElementById("prompt-reset-all-btn");
  if (resetAllBtn) {
    const anyModified = _promptData.some(p => p.modified);
    resetAllBtn.disabled = !anyModified;
    resetAllBtn.onclick = async () => {
      const confirmed = await showConfirm({
        title: "Reset All Prompts",
        message: "Reset all prompt templates to their defaults? This cannot be undone.",
        okLabel: "Reset All",
        okClass: "danger",
      });
      if (!confirmed) return;
      try {
        await apiFetch("/admin/prompts", { method: "DELETE" });
        await loadPromptTemplates();
      } catch (e) {
        console.error("Reset all failed:", e);
      }
    };
  }
}

function _buildPromptCard(p) {
  const card = document.createElement("div");
  card.className = "prompt-card" + (p.modified ? " modified" : "");
  card.dataset.key = p.key;

  // Header row (always visible, clickable to expand/collapse)
  const headerRow = document.createElement("div");
  headerRow.className = "prompt-card-header";

  const headerLeft = document.createElement("div");
  headerLeft.className = "prompt-card-header-left";
  headerLeft.innerHTML =
    '<svg class="prompt-card-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

  const label = document.createElement("span");
  label.className = "prompt-card-label";
  label.textContent = p.label;
  headerLeft.appendChild(label);

  const badge = document.createElement("span");
  badge.className = "prompt-card-badge";
  badge.textContent = p.service === "rag" ? "rag-api" : "media-api";
  headerLeft.appendChild(badge);

  const modPill = document.createElement("span");
  modPill.className = "prompt-card-modified-pill";
  modPill.textContent = "modified";
  headerLeft.appendChild(modPill);

  headerRow.appendChild(headerLeft);

  // Right side of header: status + reset (always visible)
  const headerRight = document.createElement("div");
  headerRight.className = "prompt-card-actions";

  const statusEl = document.createElement("span");
  statusEl.className = "prompt-status";
  headerRight.appendChild(statusEl);

  const resetBtn = document.createElement("button");
  resetBtn.className = "prompt-reset-btn";
  resetBtn.textContent = "Reset";
  resetBtn.title = "Reset to default";
  if (!p.modified) resetBtn.disabled = true;
  headerRight.appendChild(resetBtn);

  headerRow.appendChild(headerRight);
  card.appendChild(headerRow);

  // Collapsible body
  const body = document.createElement("div");
  body.className = "prompt-card-body";

  // Click header to toggle body
  headerRow.onclick = (e) => {
    // Don't toggle if clicking the reset button
    if (e.target.closest(".prompt-reset-btn")) return;
    card.classList.toggle("open");
  };

  // Description
  const desc = document.createElement("div");
  desc.className = "prompt-card-desc";
  desc.textContent = p.description;
  body.appendChild(desc);

  // Preview (rendered markdown-ish view) + Textarea (edit mode)
  const preview = document.createElement("div");
  preview.className = "prompt-preview";
  preview.innerHTML = _renderPromptPreview(p.content);
  preview.title = "Click to edit";
  body.appendChild(preview);

  const textarea = document.createElement("textarea");
  textarea.className = "setting-input prompt-textarea";
  textarea.value = p.content;
  textarea.rows = Math.max(4, Math.min(16, Math.ceil(p.content.length / 70)));
  textarea.style.display = "none";
  body.appendChild(textarea);

  // Trap scroll inside textarea so settings modal never scrolls during edit
  function _trapScroll(e) {
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.scrollTop += e.deltaY;
  }

  // Click preview to switch to edit mode
  preview.onclick = () => {
    preview.style.display = "none";
    textarea.style.display = "";
    textarea.addEventListener("wheel", _trapScroll, { passive: false });
    textarea.focus();
  };

  // Blur textarea to switch back to preview
  textarea.onblur = () => {
    textarea.removeEventListener("wheel", _trapScroll);
    textarea.style.display = "none";
    preview.style.display = "";
    preview.innerHTML = _renderPromptPreview(textarea.value);
  };

  textarea.oninput = () => {
    _debouncePromptSave(p.key, textarea, card, statusEl, preview);
  };

  // Footer row (variable hints)
  const vars = _extractVars(p.default);
  if (vars.length) {
    const hint = document.createElement("div");
    hint.className = "prompt-var-hint";
    hint.textContent = "Uses variables: " + vars.join(", ");
    body.appendChild(hint);
  }

  card.appendChild(body);

  // Reset button handler
  resetBtn.onclick = async (e) => {
    e.stopPropagation();
    try {
      await apiFetch("/admin/prompts/" + p.key, { method: "DELETE" });
      textarea.value = p.default;
      preview.innerHTML = _renderPromptPreview(p.default);
      p.content = p.default;
      p.modified = false;
      card.classList.remove("modified");
      resetBtn.disabled = true;
      _flashStatus(statusEl, "Reset");
      _updateSectionCounts(card.closest(".prompt-section"));
    } catch (e) {
      console.error("Reset failed:", e);
    }
  };

  return card;
}

function _renderPromptPreview(text) {
  // Escape HTML first
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Highlight markdown headings: ## Heading
  html = html.replace(/^(#{1,3}\s.+)$/gm, '<span class="prompt-hl-heading">$1</span>');

  // Highlight bullet lists: - item
  html = html.replace(/^(\s*-\s)/gm, '<span class="prompt-hl-bullet">-</span> ');

  // Highlight template variables: {variable_name}
  html = html.replace(/(\{[a-z_]+\})/g, '<span class="prompt-hl-var">$1</span>');

  // Highlight emotion/special tags: <laugh>, <sigh>, etc. (already escaped to &lt;...&gt;)
  html = html.replace(/(&lt;[a-z_]+&gt;)/g, '<span class="prompt-hl-tag">$1</span>');

  // Highlight SEARCH/REPLACE markers
  html = html.replace(/((?:&lt;){7}\s*SEARCH)/g, '<span class="prompt-hl-marker">$1</span>');
  html = html.replace(/(={7})/g, '<span class="prompt-hl-marker">$1</span>');
  html = html.replace(/((?:&gt;){7}\s*REPLACE)/g, '<span class="prompt-hl-marker">$1</span>');

  // Highlight section tags in brackets: [verse], [chorus], etc.
  html = html.replace(/(\[[a-z_-]+\])/gi, '<span class="prompt-hl-tag">$1</span>');

  // Highlight SAVE_MEMORY / DELETE_MEMORY tags
  html = html.replace(/(\[(?:SAVE_MEMORY|DELETE_MEMORY):[^\]]*\])/g, '<span class="prompt-hl-marker">$1</span>');

  // Highlight /no_think directive
  html = html.replace(/(\/no_think)/g, '<span class="prompt-hl-marker">$1</span>');

  // Convert newlines to <br>
  html = html.replace(/\n/g, "<br>");

  return html;
}

function _extractVars(text) {
  const matches = text.match(/\{[a-z_]+\}/g);
  if (!matches) return [];
  return [...new Set(matches)];
}

function _debouncePromptSave(key, textarea, card, statusEl, preview) {
  clearTimeout(_promptSaveTimers[key]);
  _flashStatus(statusEl, "");
  _promptSaveTimers[key] = setTimeout(async () => {
    const content = textarea.value;
    const p = _promptData.find(x => x.key === key);
    if (!p) return;

    // If content matches default, reset instead
    if (content === p.default) {
      if (p.modified) {
        try {
          await apiFetch("/admin/prompts/" + key, { method: "DELETE" });
          p.modified = false;
          p.content = p.default;
          card.classList.remove("modified");
          card.querySelector(".prompt-reset-btn").disabled = true;
          preview.innerHTML = _renderPromptPreview(p.default);
          _flashStatus(statusEl, "Reset");
          _updateSectionCounts(card.closest(".prompt-section"));
        } catch (e) {
          console.error("Reset failed:", e);
        }
      }
      return;
    }

    try {
      await apiFetch("/admin/prompts/" + key, {
        method: "PUT",
        body: JSON.stringify({ content }),
      });
      p.content = content;
      p.modified = true;
      card.classList.add("modified");
      card.querySelector(".prompt-reset-btn").disabled = false;
      _flashStatus(statusEl, "Saved");
      _updateSectionCounts(card.closest(".prompt-section"));
    } catch (e) {
      _flashStatus(statusEl, "Error", true);
      console.error("Save failed:", e);
    }
  }, 1500);
}

function _flashStatus(el, text, isError) {
  el.textContent = text;
  el.classList.remove("visible", "ok", "err");
  if (text) {
    el.classList.add("visible", isError ? "err" : "ok");
    setTimeout(() => { el.classList.remove("visible", "ok", "err"); el.textContent = ""; }, 2000);
  }
}

function _updateSectionCounts(section) {
  if (!section) return;
  const resetAllBtn = document.getElementById("prompt-reset-all-btn");
  if (resetAllBtn) resetAllBtn.disabled = !_promptData.some(p => p.modified);
  const modCount = section.querySelectorAll(".prompt-card.modified").length;
  const existing = section.querySelector(".prompt-section-modified");
  if (modCount > 0) {
    if (existing) {
      existing.textContent = modCount + " modified";
    } else {
      const badge = document.createElement("span");
      badge.className = "prompt-section-modified";
      badge.textContent = modCount + " modified";
      section.querySelector(".prompt-section-header").appendChild(badge);
    }
  } else if (existing) {
    existing.remove();
  }
}
