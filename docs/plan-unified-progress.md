# Unified Generation Progress Component

## Context
The three studios (image, music, video) each have their own progress UI with different class names, slightly different layouts, and duplicated CSS. The user wants a polished, consistent look using shared CSS classes. Currently: image uses a horizontal layout with a small ring, music uses a centered vertical layout with a larger ring, video uses a minimal centered layout. All share the same concept (ring + bar + status + stop) but implemented separately.

## Design

### Shared `.gen-progress` component
A single CSS component class used by all three studios. Centered vertical layout (like music/video currently) since it works best in all container widths.

**Structure:**
```
.gen-progress
  .gen-progress-ring (SVG ring with percentage)
  .gen-progress-status (step text + elapsed time)
  .gen-progress-bar > .gen-progress-bar-fill
  .gen-progress-stop (stop button)
```

**Visual design:**
- Larger ring (72x72) with accent glow background, percentage in center
- Pulsing accent border on the container card to indicate activity
- Status text with monospace step counter
- Thin accent progress bar
- Subtle stop button that highlights red on hover
- `fadeIn` animation on mount

### Changes

#### 1. `web/styles.css` - add shared `.gen-progress` styles, remove old per-studio styles
- Add new `.gen-progress` block (~40 lines)
- Remove `.studio-gen-placeholder`, `.studio-gen-ring-wrap`, `.studio-gen-info`, `.studio-gen-title`, `.studio-gen-detail`, `.studio-gen-bar`, `.studio-gen-bar-fill`, `.studio-placeholder-stop` (~55 lines)
- Remove `.music-gen-placeholder`, `.music-gen-ring-wrap`, `.music-gen-status`, `.music-gen-bar`, `.music-gen-bar-fill`, `.music-gen-stop` (~20 lines)
- Remove `.video-gen-placeholder`, nested `.progress-ring`, `.status-text`, `.progress-bar`, `.progress-bar-fill`, `.stop-btn` (~15 lines)

#### 2. `web/index.html` - shared JS factory function + update all three studios
- Add `_createGenProgress(opts)` factory that returns `{ el, update(step, total, elapsed), setStatus(msg), destroy() }`
- Update `createStudioPlaceholder` (image) to use the shared factory
- Update music placeholder creation to use the shared factory
- Update video placeholder creation to use the shared factory
- All three use the same DOM structure and class names

### CSS spec

```css
.gen-progress {
  background: var(--surface);
  border: 1px solid var(--accent-dim);
  border-radius: 14px;
  padding: 28px 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  animation: fadeIn 0.3s ease;
  position: relative;
}

.gen-progress-ring {
  position: relative;
  width: 72px;
  height: 72px;
}
.gen-progress-ring svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.gen-progress-ring .ring-bg {
  fill: none;
  stroke: var(--surface3);
  stroke-width: 4;
}
.gen-progress-ring .ring-fill {
  fill: none;
  stroke: var(--accent);
  stroke-width: 4;
  stroke-linecap: round;
  transition: stroke-dashoffset 0.4s ease;
}
.gen-progress-pct {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.85rem;
  font-weight: 700;
  font-family: monospace;
  color: var(--accent);
}

.gen-progress-status {
  font-size: 0.82rem;
  color: var(--text-dim);
  text-align: center;
  font-family: monospace;
}

.gen-progress-bar {
  width: 100%;
  max-width: 320px;
  height: 3px;
  background: var(--surface3);
  border-radius: 2px;
  overflow: hidden;
}
.gen-progress-bar-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 0.4s ease;
  width: 0%;
}

.gen-progress-stop {
  padding: 5px 16px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface2);
  color: var(--text-dim);
  cursor: pointer;
  font-size: 0.75rem;
  transition: all 0.15s;
}
.gen-progress-stop:hover {
  border-color: var(--danger);
  color: var(--danger);
}
```

### JS factory function

```js
function _createGenProgress() {
  const R = 30, CIRC = 2 * Math.PI * R;
  const el = document.createElement("div");
  el.className = "gen-progress";
  el.innerHTML = `
    <div class="gen-progress-ring">
      <svg viewBox="0 0 72 72">
        <circle class="ring-bg" cx="36" cy="36" r="${R}"/>
        <circle class="ring-fill" cx="36" cy="36" r="${R}"
          stroke-dasharray="${CIRC.toFixed(2)}" stroke-dashoffset="${CIRC.toFixed(2)}"/>
      </svg>
      <div class="gen-progress-pct">0%</div>
    </div>
    <div class="gen-progress-status">Preparing...</div>
    <div class="gen-progress-bar"><div class="gen-progress-bar-fill"></div></div>
    <button class="gen-progress-stop">Stop</button>`;
  const ringFill = el.querySelector(".ring-fill");
  const pctEl = el.querySelector(".gen-progress-pct");
  const statusEl = el.querySelector(".gen-progress-status");
  const barFill = el.querySelector(".gen-progress-bar-fill");
  const stopBtn = el.querySelector(".gen-progress-stop");
  return {
    el, stopBtn,
    update(step, total, elapsed) {
      const pct = total > 0 ? Math.round(step / total * 100) : 0;
      ringFill.style.strokeDashoffset = CIRC * (1 - pct / 100);
      pctEl.textContent = pct + "%";
      barFill.style.width = pct + "%";
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
```

### Server-side cancellation for image-api and music-api

Video-api already has proper cancellation: `_cancel_requested` flag, `/cancel` endpoint, callback check that raises `RuntimeError`, caught as HTTP 499. Image-api and music-api have no cancel mechanism - the GPU keeps working even when the client disconnects.

#### 3. `image-api/main.py` - add cancel support
- Add `_cancel_requested = False` global (next to `_progress`)
- Add `POST /cancel` endpoint (same pattern as video-api)
- Update `_step_callback` in `/generate` and `/inpaint` to check `_cancel_requested` and raise `RuntimeError`
- Catch cancellation in the exception handler, return HTTP 499
- Reset `_cancel_requested = False` in the `finally` block and before starting
- Note: `/upscale` uses Real-ESRGAN which has no step callback - can't be cancelled mid-inference, but it's fast (~2-3s)

#### 4. `music-api/main.py` - add cancel support
- Add `_cancel_requested = False` global
- Add `POST /cancel` endpoint
- Update `_progress_cb` inside `_run_inference` to check `_cancel_requested` and raise `RuntimeError`
- Catch cancellation, return HTTP 499
- Reset flag in `finally` and before starting

#### 5. `media-api/main.py` - add cancel proxy endpoints
- Add `POST /image/cancel` that proxies to `image-api:8100/cancel`
- Music already has no cancel proxy - add `POST /music/cancel` that proxies to `music-api:8200/cancel`
- Video already has `POST /video/cancel` proxied

#### 6. `web/index.html` - wire stop buttons to cancel endpoints
- In the shared `_createGenProgress()`, the `stopBtn` is exposed for each studio to wire up
- Image: call `mediaFetch("/image/cancel", {method:"POST"})` + abort fetch
- Music: call `mediaFetch("/music/cancel", {method:"POST"})` + abort fetch + set `_aborted = true`
- Video: already calls `mediaFetch("/video/cancel", {method:"POST"})` - keep as-is

### Files modified
- `web/styles.css` - remove 3 old progress blocks, add 1 shared `.gen-progress` block
- `web/index.html` - add `_createGenProgress()`, update image/music/video to use it, wire cancel
- `image-api/main.py` - add `_cancel_requested`, `/cancel` endpoint, callback check
- `music-api/main.py` - add `_cancel_requested`, `/cancel` endpoint, callback check
- `media-api/main.py` - add `/image/cancel` and `/music/cancel` proxy endpoints

### Verification
1. Generate an image - progress ring + bar + stop works, "Finalizing..." shows at end
2. **Stop image mid-generation** - GPU stops within 1 step, returns 499
3. Generate music - same component, step/total updates, stop works
4. **Stop music mid-generation** - GPU stops, returns 499
5. Generate video - same component, "Finalizing..." at end, stop works
6. **Stop video mid-generation** - GPU stops (already worked), returns 499
7. All three look identical in style
8. Stop button highlights red on hover in all three
9. After cancellation, can immediately start a new generation
