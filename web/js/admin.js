// ── Admin panel ──
async function loadAdminUsers() {
  if (!currentUser || currentUser.role !== "admin") return;
  try {
    const res = await apiFetch("/admin/users");
    const users = await res.json();
    const list = document.getElementById("admin-user-list");
    list.innerHTML = "";
    users.forEach(u => {
      let profileName = "";
      let userAvatarUrl = "";
      try {
        const s = JSON.parse(u.settings || "{}");
        const p = JSON.parse(s.diab_profile || "{}");
        profileName = p.name || "";
        userAvatarUrl = s.diab_avatar || "";
      } catch {}
      const initials = profileName ? profileName.trim().split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 2) : u.username[0].toUpperCase();
      const adminAvatarInner = userAvatarUrl
        ? `<img src="${userAvatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`
        : esc(initials);
      const row = document.createElement("tr");
      row.innerHTML = `
        <td><div class="admin-avatar">${adminAvatarInner}</div></td>
        <td class="admin-user-name">${esc(u.username)}</td>
        <td style="color:var(--text-dim);font-size:0.8rem;">${esc(profileName)}</td>
        <td><span class="role-badge ${u.role}">${u.role}</span></td>
        <td>
          <label class="admin-active-wrap" title="${u.is_active ? "Deactivate" : "Activate"} user">
            <input type="checkbox" ${u.is_active ? "checked" : ""} data-uid="${u.id}" class="admin-active-toggle" />
            <span class="admin-toggle-track"></span>
            <span class="admin-active-label">${u.is_active ? "Active" : "Inactive"}</span>
          </label>
        </td>
        <td style="white-space:nowrap;text-align:right;">
          <button class="admin-icon-btn admin-reset-pw-btn" data-uid="${u.id}" data-uname="${esc(u.username)}" title="Reset password">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </button>
          ${u.id !== currentUser.id ? `<button class="admin-icon-btn danger admin-del-btn" data-uid="${u.id}" data-uname="${esc(u.username)}" title="Delete user">
            ${icon("trash-lines", 15)}
          </button>` : ""}
        </td>
      `;
      list.appendChild(row);
    });

    list.querySelectorAll(".admin-active-toggle").forEach(cb => {
      cb.addEventListener("change", async () => {
        if (cb.dataset.uid === currentUser.id && !cb.checked) {
          showToast("Cannot disable your own account"); cb.checked = true; return;
        }
        const label = cb.closest(".admin-active-wrap").querySelector(".admin-active-label");
        if (label) label.textContent = cb.checked ? "Active" : "Inactive";
        await apiFetch(`/admin/users/${cb.dataset.uid}`, {
          method: "PATCH",
          body: JSON.stringify({ is_active: cb.checked }),
        });
      });
    });

    list.querySelectorAll(".admin-reset-pw-btn").forEach(btn => {
      btn.addEventListener("click", () => openResetPwModal(btn.dataset.uid, btn.dataset.uname));
    });

    list.querySelectorAll(".admin-del-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const ok = await showConfirm({ title: "Delete User", message: `Delete user "${btn.dataset.uname}"? This cannot be undone.`, okLabel: "Delete", okClass: "danger" });
        if (!ok) return;
        await apiFetch(`/admin/users/${btn.dataset.uid}`, { method: "DELETE" });
        loadAdminUsers();
      });
    });
  } catch {}
}

const addUserModal = document.getElementById("add-user-modal");
function openAddUserModal() {
  document.getElementById("admin-new-username").value = "";
  document.getElementById("admin-new-password").value = "";
  document.getElementById("admin-new-role").value = "user";
  document.getElementById("admin-create-error").textContent = "";
  addUserModal.classList.add("open");
  setTimeout(() => document.getElementById("admin-new-username").focus(), 50);
}
function closeAddUserModal() { addUserModal.classList.remove("open"); }
document.getElementById("admin-add-user-toggle").addEventListener("click", openAddUserModal);
document.getElementById("admin-add-cancel-btn").addEventListener("click", closeAddUserModal);
addUserModal.addEventListener("click", e => { if (e.target === addUserModal) closeAddUserModal(); });

document.getElementById("admin-create-user-btn").addEventListener("click", async () => {
  const username = document.getElementById("admin-new-username").value.trim();
  const password = document.getElementById("admin-new-password").value;
  const role     = document.getElementById("admin-new-role").value;
  const errEl    = document.getElementById("admin-create-error");
  errEl.textContent = "";
  if (!username) { errEl.textContent = "Username required"; return; }
  if (password.length < 6) { errEl.textContent = "Min 6 chars"; return; }
  const res = await apiFetch("/admin/users", {
    method: "POST",
    body: JSON.stringify({ username, password, role }),
  });
  if (res.ok) {
    closeAddUserModal();
    loadAdminUsers();
    showToast(`User "${username}" created`);
  } else {
    const d = await res.json().catch(() => ({}));
    errEl.textContent = d.detail || "Error creating user";
  }
});


// ── Admin default settings ──
const ADMIN_DEFAULTS_KEY = "diab_admin_defaults";

function loadAdminDefaults() {
  // Populate model list from main select
  const srcSel = document.getElementById("model-select");
  const dstSel = document.getElementById("admin-default-model");
  if (srcSel && dstSel && srcSel.options.length > 1) dstSel.innerHTML = srcSel.innerHTML;
  try {
    const d = JSON.parse(localStorage.getItem(ADMIN_DEFAULTS_KEY) || "{}");
    if (d.model && dstSel) dstSel.value = d.model;
    if (d.prompt !== undefined) document.getElementById("admin-default-prompt").value = d.prompt;
    if (d.temperature !== undefined) {
      document.getElementById("admin-temp-slider").value = d.temperature;
      document.getElementById("admin-temp-val").textContent = parseFloat(d.temperature).toFixed(2);
    }
    if (d.threshold !== undefined) {
      document.getElementById("admin-thresh-slider").value = d.threshold;
      document.getElementById("admin-thresh-val").textContent = parseFloat(d.threshold).toFixed(2);
    }
    if (d.topk !== undefined) {
      document.getElementById("admin-topk-slider").value = d.topk;
      document.getElementById("admin-topk-val").textContent = d.topk;
    }
    if (d.history !== undefined) {
      document.getElementById("admin-history-slider").value = d.history;
      document.getElementById("admin-history-val").textContent = d.history;
    }
    if (d.compact !== undefined) {
      document.getElementById("admin-compact-slider").value = d.compact;
      document.getElementById("admin-compact-val").textContent = d.compact + "%";
    }
    if (d.textSize !== undefined) {
      const idx = parseInt(d.textSize) || 1;
      document.getElementById("admin-text-size-slider").value = idx;
      document.getElementById("admin-text-size-val").textContent = TEXT_SIZE_LABELS[idx] || "Medium";
    }
    if (d.theme) {
      document.querySelectorAll("#admin-theme-presets [data-admin-theme]").forEach(el => {
        el.classList.toggle("active", el.dataset.adminTheme === d.theme);
      });
    }
    if (d.accent) {
      document.querySelectorAll("#admin-color-swatches [data-admin-color]").forEach(el => {
        el.classList.toggle("active", el.dataset.adminColor === d.accent);
      });
      document.getElementById("admin-accent-custom").value = d.accent;
    }
    if (d.tts !== undefined) document.getElementById("admin-tts-toggle").checked = !!d.tts;
    if (d.voice) document.getElementById("admin-default-voice").value = d.voice;
  } catch {}
}

// Slider live-update labels
document.getElementById("admin-temp-slider").addEventListener("input", e => {
  document.getElementById("admin-temp-val").textContent = parseFloat(e.target.value).toFixed(2);
});
document.getElementById("admin-thresh-slider").addEventListener("input", e => {
  document.getElementById("admin-thresh-val").textContent = parseFloat(e.target.value).toFixed(2);
});
document.getElementById("admin-topk-slider").addEventListener("input", e => {
  document.getElementById("admin-topk-val").textContent = e.target.value;
});
document.getElementById("admin-history-slider").addEventListener("input", e => {
  document.getElementById("admin-history-val").textContent = e.target.value;
});
document.getElementById("admin-compact-slider").addEventListener("input", e => {
  document.getElementById("admin-compact-val").textContent = e.target.value + "%";
});
document.getElementById("admin-text-size-slider").addEventListener("input", e => {
  const idx = parseInt(e.target.value);
  document.getElementById("admin-text-size-val").textContent = TEXT_SIZE_LABELS[idx] || "Medium";
});

// Theme preset clicks
document.querySelectorAll("#admin-theme-presets [data-admin-theme]").forEach(el => {
  el.addEventListener("click", () => {
    document.querySelectorAll("#admin-theme-presets [data-admin-theme]").forEach(x => x.classList.remove("active"));
    el.classList.add("active");
  });
});

// Accent color swatch clicks
document.querySelectorAll("#admin-color-swatches [data-admin-color]").forEach(el => {
  el.addEventListener("click", () => {
    document.querySelectorAll("#admin-color-swatches [data-admin-color]").forEach(x => x.classList.remove("active"));
    el.classList.add("active");
    document.getElementById("admin-accent-custom").value = el.dataset.adminColor;
  });
});
document.getElementById("admin-accent-custom").addEventListener("input", e => {
  document.querySelectorAll("#admin-color-swatches [data-admin-color]").forEach(x => x.classList.remove("active"));
});

document.getElementById("admin-save-defaults-btn").addEventListener("click", () => {
  const activeThemeEl = document.querySelector("#admin-theme-presets [data-admin-theme].active");
  const activeColorEl = document.querySelector("#admin-color-swatches [data-admin-color].active");
  const defaults = {
    model:       document.getElementById("admin-default-model").value,
    prompt:      document.getElementById("admin-default-prompt").value.trim(),
    temperature: parseFloat(document.getElementById("admin-temp-slider").value),
    threshold:   parseFloat(document.getElementById("admin-thresh-slider").value),
    topk:        parseInt(document.getElementById("admin-topk-slider").value),
    history:     parseInt(document.getElementById("admin-history-slider").value),
    compact:     parseInt(document.getElementById("admin-compact-slider").value),
    textSize:    parseInt(document.getElementById("admin-text-size-slider").value),
    theme:       activeThemeEl ? activeThemeEl.dataset.adminTheme : "dark",
    accent:      activeColorEl ? activeColorEl.dataset.adminColor : document.getElementById("admin-accent-custom").value,
    tts:         document.getElementById("admin-tts-toggle").checked,
    voice:       document.getElementById("admin-default-voice").value,
  };
  localStorage.setItem(ADMIN_DEFAULTS_KEY, JSON.stringify(defaults));
  scheduleSettingsSync();
  const msg = document.getElementById("admin-defaults-msg");
  msg.style.color = "var(--success)"; msg.textContent = "Defaults saved.";
  setTimeout(() => msg.textContent = "", 2500);
});

// ── Reset PW modal ──
let _resetPwUid = null;
const resetPwModal = document.getElementById("reset-pw-modal");
function openResetPwModal(uid, uname) {
  _resetPwUid = uid;
  document.getElementById("reset-pw-username").textContent = uname;
  document.getElementById("reset-pw-input").value = "";
  document.getElementById("reset-pw-error").textContent = "";
  resetPwModal.style.display = "flex";
  setTimeout(() => document.getElementById("reset-pw-input").focus(), 50);
}
function closeResetPwModal() { resetPwModal.style.display = "none"; _resetPwUid = null; }
document.getElementById("reset-pw-cancel-btn").addEventListener("click", closeResetPwModal);
resetPwModal.addEventListener("click", e => { if (e.target === resetPwModal) closeResetPwModal(); });
document.getElementById("reset-pw-confirm-btn").addEventListener("click", async () => {
  const pw = document.getElementById("reset-pw-input").value;
  const errEl = document.getElementById("reset-pw-error");
  if (pw.length < 6) { errEl.textContent = "Minimum 6 characters"; return; }
  const res = await apiFetch(`/admin/users/${_resetPwUid}/password`, {
    method: "PUT", body: JSON.stringify({ new_password: pw }),
  });
  if (res.ok) { closeResetPwModal(); showToast("Password updated"); }
  else { errEl.textContent = "Error updating password"; }
});

