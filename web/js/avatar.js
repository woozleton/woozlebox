// ── Local 3D Talking Avatar (TalkingHead) ──
// ES module - loaded via <script type="module"> in index.html
// Floats over the chat as a draggable overlay.
// Lip-sync is amplitude-driven using Web Audio AnalyserNode.

import { TalkingHead } from '/lib/talkinghead/talkinghead.mjs';

const AVATAR_KEY = 'wooz_avatar_enabled';
let head = null;
let headInitialized = false;
let avatarEnabled = localStorage.getItem(AVATAR_KEY) === 'true';

// ── Shared AudioContext ──
// Created here so tts.js (a regular defer script) can pick it up via
// window._ttsAudioCtx when the user first triggers TTS (always after this
// module has run, since modules execute before DOMContentLoaded).
const sharedAudioCtx = new AudioContext();
window._ttsAudioCtx = sharedAudioCtx;

// AnalyserNode on the shared context - tts.js connects each audio source to it.
const analyser = sharedAudioCtx.createAnalyser();
analyser.fftSize = 256;
window._avatarAnalyser = analyser;

// ── Draggable panel ──
function makeDraggable(panel, handle) {
  let ox = 0, oy = 0;
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    ox = e.clientX - panel.getBoundingClientRect().left;
    oy = e.clientY - panel.getBoundingClientRect().top;
    function onMove(ev) {
      panel.style.left   = (ev.clientX - ox) + 'px';
      panel.style.top    = (ev.clientY - oy) + 'px';
      panel.style.right  = 'auto';
      panel.style.bottom = 'auto';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Amplitude-driven jaw animation ──
// Only drives jawOpen - mouthOpen is a synthetic TalkingHead key that mixes
// into jawOpen at 0.5x, so setting both would double the effect.
function startAnimLoop() {
  const data = new Uint8Array(analyser.frequencyBinCount);
  function tick() {
    requestAnimationFrame(tick);
    if (!head || !head.mtAvatar) return;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += Math.abs(data[i] - 128);
    const amplitude = Math.min(1, (sum / data.length / 128) * 5);
    const jaw = head.mtAvatar['jawOpen'];
    if (jaw) { jaw.realtime = amplitude; jaw.needsUpdate = true; }
  }
  tick();
}

// ── Lazy TalkingHead init ──
// Only called the first time the avatar is enabled - avoids loading the 4.7MB
// GLB and starting the WebGL render loop on every page load.
async function initTalkingHead() {
  if (headInitialized) return;
  headInitialized = true;

  const wrap = document.getElementById('avatar-canvas-wrap');
  head = new TalkingHead(wrap, {
    ttsEndpoint: '',
    audioCtx: sharedAudioCtx,
    modelPixelRatio: 1,
    cameraView: 'upper',
  });

  await head.showAvatar('/models/avatar.glb');
  startAnimLoop();
}

// ── Toggle ──
function applyAvatar(enabled) {
  avatarEnabled = enabled;
  localStorage.setItem(AVATAR_KEY, enabled);
  const panel = document.getElementById('avatar-float');
  if (!panel) return;
  if (enabled) {
    panel.style.display = 'flex';
    initTalkingHead().catch(err => console.error('Avatar init failed:', err));
  } else {
    panel.style.display = 'none';
  }
}

// Expose for settings toggle wired in index.html
window.applyAvatar = applyAvatar;
window._avatarEnabled = () => avatarEnabled;

// ── Build panel DOM ──
function buildPanel() {
  const panel = document.createElement('div');
  panel.id = 'avatar-float';
  panel.innerHTML =
    '<div id="avatar-float-header">' +
      '<span>Avatar</span>' +
      '<button id="avatar-close-btn" title="Close avatar">&#x2715;</button>' +
    '</div>' +
    '<div id="avatar-canvas-wrap"></div>';
  document.body.appendChild(panel);

  makeDraggable(panel, document.getElementById('avatar-float-header'));

  document.getElementById('avatar-close-btn').addEventListener('click', () => {
    applyAvatar(false);
    const cb = document.getElementById('avatar-toggle');
    if (cb) cb.checked = false;
  });

  // Restore saved preference - if enabled, show panel and start TalkingHead
  applyAvatar(avatarEnabled);
}

// Guard for cases where DOMContentLoaded may have already fired
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', buildPanel);
} else {
  buildPanel();
}
