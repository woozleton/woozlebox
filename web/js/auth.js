function showLoginScreen() {
  document.getElementById("setup-screen").classList.remove("active");
  document.getElementById("login-screen").classList.add("active");
  document.getElementById("login-error").textContent = "";
}

function showSetupScreen() {
  document.getElementById("login-screen").classList.remove("active");
  document.getElementById("setup-screen").classList.add("active");
  document.getElementById("setup-error").textContent = "";
}

function hideAuthScreens() {
  document.getElementById("login-screen").classList.remove("active");
  document.getElementById("setup-screen").classList.remove("active");
}
// ── Auth button handlers ──
// ── Auth button handlers ──
document.getElementById("login-submit-btn").addEventListener("click", async () => {
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value;
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";
  if (!username || !password) { errEl.textContent = "Enter username and password."; return; }
  try {
    const res = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); errEl.textContent = d.detail || "Invalid credentials"; const card = document.querySelector("#login-screen .auth-card"); card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake"); return; }
    const data = await res.json();
    localStorage.setItem("diab_token", data.token);
    applyUserSession(data.user);
    hideAuthScreens();
    loadApp();
  } catch (e) { errEl.textContent = `Error: ${e.message}`; }
});
document.getElementById("login-password").addEventListener("keydown", e => {
  if (e.key === "Enter") document.getElementById("login-submit-btn").click();
});

document.getElementById("setup-submit-btn").addEventListener("click", async () => {
  const username = document.getElementById("setup-username").value.trim();
  const password = document.getElementById("setup-password").value;
  const confirm  = document.getElementById("setup-confirm").value;
  const errEl    = document.getElementById("setup-error");
  errEl.textContent = "";
  if (!username) { errEl.textContent = "Username is required."; return; }
  if (password.length < 6) { errEl.textContent = "Password must be at least 6 characters."; return; }
  if (password !== confirm) { errEl.textContent = "Passwords do not match."; return; }
  try {
    const res = await fetch(`${API}/admin/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, role: "admin" }),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); errEl.textContent = d.detail || "Error creating account"; return; }
    // Now log in
    const loginRes = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!loginRes.ok) { showLoginScreen(); return; }
    const data = await loginRes.json();
    localStorage.setItem("diab_token", data.token);
    applyUserSession(data.user);
    hideAuthScreens();
    loadApp();
  } catch (e) { errEl.textContent = `Error: ${e.message}`; }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  const ok = await showConfirm({ title: "Log out", message: "Are you sure you want to log out?", okLabel: "Log out", okClass: "danger" });
  if (!ok) return;
  try { await apiFetch("/auth/logout", { method: "POST" }); } catch {}
  clearSession();
  location.reload();
});

