const API = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://localhost:8000"
  : `http://${window.location.hostname}:8000`;

const GPU_API = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://localhost:8400"
  : `http://${window.location.hostname}:8400`;

const MEDIA_API = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://localhost:8500"
  : `http://${window.location.hostname}:8500`;

// ── Shared utilities ──
function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function icon(name, size = 14) {
  return `<svg width="${size}" height="${size}"><use href="#i-${name}"/></svg>`;
}

// Toggle filled heart on fav buttons (SVG <use> needs fill set directly to override <symbol> fill="none")
function setFavFilled(btn, filled) {
  const u = btn.querySelector("use");
  if (!u) return;
  u.setAttribute("href", filled ? "#i-heart-filled" : "#i-heart");
}

// ── Auth state ──
let currentUser = null;

function getToken() { return localStorage.getItem("wooz_token"); }
function clearSession() {
  Object.keys(localStorage).filter(k => k.startsWith("wooz_")).forEach(k => localStorage.removeItem(k));
  currentUser = null;
}

async function apiFetch(path, options = {}) {
  const token = getToken();
  if (!(options.body instanceof FormData)) {
    options.headers = { "Content-Type": "application/json", ...options.headers };
  } else {
    options.headers = { ...options.headers };
  }
  if (token) options.headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(API + path, options);
  if (res.status === 401) {
    if (!document.getElementById("setup-screen")?.classList.contains("active")) {
      clearSession();
      showLoginScreen();
    }
    throw new Error("Session expired");
  }
  return res;
}

async function mediaFetch(path, options = {}) {
  const token = getToken();
  if (!(options.body instanceof FormData)) {
    options.headers = { "Content-Type": "application/json", ...options.headers };
  } else {
    options.headers = { ...options.headers };
  }
  if (token) options.headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(MEDIA_API + path, options);
  if (res.status === 401) {
    if (!document.getElementById("setup-screen")?.classList.contains("active")) {
      clearSession();
      showLoginScreen();
    }
    throw new Error("Session expired");
  }
  return res;
}
