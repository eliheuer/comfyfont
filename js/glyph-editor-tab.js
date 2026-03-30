/**
 * glyph-editor-tab.js — Bezier glyph editor for one glyph.
 *
 * Rendered inside a .cf-pane div. Uses CanvasController for pan/zoom.
 *
 * Options:
 *   onNavigate(glyphName)  — called when user opens an adjacent glyph
 *   masterId               — initial master/source ID
 */

import { CanvasController } from "./canvas-controller.js";
import { T, GAP, PANEL_R } from "./theme.js";

// ---------------------------------------------------------------------------
// Point type constants (PackedPath encoding)

const PT_OFF_QUAD  = 1;
const PT_OFF_CUBIC = 2;
// On-curve smooth: types[i] & 0x08 !== 0 (value 8)

// Runebender Xilem point color vocabulary
const C_CORNER_FILL = '#6AE756';
const C_CORNER_STK  = '#208E56';
const C_SMOOTH_FILL = '#579AFF';
const C_SMOOTH_STK  = '#4428EC';
const C_OFF_FILL    = '#CC99FF';
const C_OFF_STK     = '#9900FF';
const C_SEL_FILL    = '#FFEE55';
const C_SEL_STK     = '#FFAA33';
const C_HANDLE      = '#505050';

const HIT_R = 6; // CSS px — pointer hit radius for points

// ---------------------------------------------------------------------------
// Toolbar tools

const TOOLS = [
  { id: 'select', icon: '🖱️',  title: 'Select' },
  { id: 'pen',    icon: '🖊️', title: 'Pen' },
  { id: 'knife',  icon: '🔪',  title: 'Knife' },
  { id: 'ruler',  icon: '📏',  title: 'Ruler' },
  { id: 'hand',   icon: '✋',  title: 'Hand' },
  { id: 'rotate', icon: '🔄',  title: 'Rotate' },
  { id: 'text',   icon: '📝',  title: 'Text' },
];

// ---------------------------------------------------------------------------
// CSS

const CSS = `
/* Editor root fills the pane; canvas behind, toolbar floats on top */
.cf-editor-root {
  position: relative; width: 100%; height: 100%;
  background: ${T.bg}; overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 13px; box-sizing: border-box;
}
/* Canvas fills the entire pane */
.cf-editor-canvas-wrap {
  position: absolute; inset: 0;
  background: ${T.bg}; overflow: hidden;
}
/* Toolbar floats over canvas — top:0 so spacing above = overlay gap only (matches header↔tabs) */
.cf-editor-toolbar {
  position: absolute; top: 0; left: 0; z-index: 1;
  display: flex; align-items: center; gap: ${GAP}px;
  pointer-events: none;
}
.cf-editor-toolbar > * { pointer-events: auto; }
.cf-editor-tools {
  display: flex; align-items: center; gap: 1px;
  background: ${T.panel}; border: 1.5px solid ${T.border};
  border-radius: ${PANEL_R}px; padding: 3px 5px;
  flex-shrink: 0;
}
.cf-editor-tool-btn {
  background: none; border: none; cursor: pointer;
  color: #505050;
  width: 30px; height: 30px; border-radius: 5px;
  font-size: 16px; display: flex; align-items: center; justify-content: center;
  transition: background 0.1s;
  user-select: none;
}
.cf-editor-tool-btn:hover { background: #272727; color: ${T.sidebarText}; }
.cf-editor-tool-btn.active { background: #2c2c2c; color: ${T.glyphFill}; }
`;

function _injectCSS() {
  if (document.getElementById("cf-editor-css")) return;
  const s = document.createElement("style");
  s.id = "cf-editor-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ---------------------------------------------------------------------------

export class GlyphEditorTab {
  /**
   * @param {HTMLElement} container
   * @param {object}      fontController
   * @param {string}      glyphName
   * @param {{onNavigate?: function, masterId?: string}} options
   */
  constructor(container, fontController, glyphName, options = {}) {
    _injectCSS();

    this._fc         = fontController;
    this._glyphName  = glyphName;
    this._onNavigate = options.onNavigate ?? (() => {});
    this._masterId   = options.masterId ?? null;
    this._glyph      = null;
    this._fontInfo   = null;
    this._dirty      = false;
    this._fittedOnce = false;
    this._activeTool = 'select';

    // Selection / drag state
    this._selectedPoints = new Set();
    this._isDragging     = false;
    this._dragStart      = null;  // scene coords at drag start
    this._origCoords     = null;  // Float64Array copy of coords before drag

    // Box-select state
    this._isBoxing = false;
    this._boxStart = null;  // CSS px {x, y}
    this._boxEnd   = null;

    this._buildDOM(container);
    this._setupPointerHandlers();

    // Hook into CanvasController's resize so zoomFit runs after the canvas
    // has its real dimensions (ResizeObserver fires AFTER rAF, so rAF-based
    // delays don't work — intercepting _onResize is the reliable fix).
    const origResize = this._cc._onResize.bind(this._cc);
    this._cc._onResize = () => {
      origResize();
      // After a real resize (canvas > 400px fallback), fit if not done yet
      const dpr = window.devicePixelRatio || 1;
      if (!this._fittedOnce && this._glyph && (this._canvas.width / dpr) > 400) {
        this._applyZoomFit();
      }
    };

    this._keyHandler = (e) => this._onKey(e);
    document.addEventListener("keydown", this._keyHandler);
  }

  // -------------------------------------------------------------------------
  // DOM construction

  _buildDOM(container) {
    const root = document.createElement("div");
    root.className = "cf-editor-root";

    // Toolbar
    const toolbar = document.createElement("div");
    toolbar.className = "cf-editor-toolbar";

    // Tool pill group
    const toolsEl = document.createElement("div");
    toolsEl.className = "cf-editor-tools";
    this._toolBtns = {};
    for (const tool of TOOLS) {
      const btn = document.createElement("button");
      btn.className = "cf-editor-tool-btn" + (tool.id === this._activeTool ? " active" : "");
      btn.textContent = tool.icon;
      btn.title = tool.title;
      btn.onclick = () => this._setTool(tool.id);
      toolsEl.appendChild(btn);
      this._toolBtns[tool.id] = btn;
    }

    toolbar.appendChild(toolsEl);

    // Canvas area (fills root) with toolbar floating on top
    const canvasWrap = document.createElement("div");
    canvasWrap.className = "cf-editor-canvas-wrap";
    const canvas = document.createElement("canvas");
    canvasWrap.appendChild(canvas);

    root.appendChild(canvasWrap);
    root.appendChild(toolbar);
    container.appendChild(root);

    this._root   = root;
    this._canvas = canvas;
    this._cc = new CanvasController(canvas, (ctx) => this._draw(ctx));
  }

  _setTool(id) {
    this._activeTool = id;
    for (const [tid, btn] of Object.entries(this._toolBtns)) {
      btn.classList.toggle("active", tid === id);
    }
  }

  // -------------------------------------------------------------------------
  // Pointer event handling (selection + drag)

  _setupPointerHandlers() {
    const canvas = this._canvas;

    canvas.addEventListener("pointerdown", (e) => {
      // CanvasController owns alt+drag (pan) and middle-click — skip those
      if (e.button !== 0 || e.altKey) return;
      if (this._activeTool !== "select") return;

      const idx = this._hitTestPoint(e.clientX, e.clientY);
      if (idx >= 0) {
        // Hit a point — start drag
        if (!e.shiftKey && !this._selectedPoints.has(idx)) {
          this._selectedPoints.clear();
        }
        this._selectedPoints.add(idx);

        this._isDragging = true;
        this._dragStart  = this._cc.eventToScene(e);
        const layer = this._defaultLayer();
        this._origCoords = Float64Array.from(layer?.path?.coordinates ?? []);

        canvas.setPointerCapture(e.pointerId);
        e.stopPropagation();
        this._cc.scheduleRedraw();
      } else {
        // Empty space — start box select
        if (!e.shiftKey) this._selectedPoints.clear();

        const rect = canvas.getBoundingClientRect();
        this._isBoxing = true;
        this._boxStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        this._boxEnd   = { ...this._boxStart };

        canvas.setPointerCapture(e.pointerId);
        e.stopPropagation();
        this._cc.scheduleRedraw();
      }
    });

    canvas.addEventListener("pointermove", (e) => {
      if (this._isDragging) {
        const cur = this._cc.eventToScene(e);
        const dx = cur.x - this._dragStart.x;
        const dy = cur.y - this._dragStart.y;

        const layer = this._defaultLayer();
        const coords = layer?.path?.coordinates;
        if (coords) {
          for (const idx of this._selectedPoints) {
            coords[idx * 2]     = this._origCoords[idx * 2]     + dx;
            coords[idx * 2 + 1] = this._origCoords[idx * 2 + 1] + dy;
          }
          this._dirty = true;
          this._cc.scheduleRedraw();
        }
      } else if (this._isBoxing) {
        const rect = canvas.getBoundingClientRect();
        this._boxEnd = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        this._cc.scheduleRedraw();
      }
    });

    canvas.addEventListener("pointerup", () => {
      if (this._isDragging) {
        this._isDragging = false;
        this._dragStart  = null;
        this._origCoords = null;
        this._updateInfo();
      } else if (this._isBoxing) {
        this._finishBoxSelect();
        this._isBoxing = false;
        this._boxStart = null;
        this._boxEnd   = null;
        this._cc.scheduleRedraw();
      }
    });

    canvas.addEventListener("pointerleave", () => {
      if (this._isBoxing) {
        this._isBoxing = false;
        this._boxStart = null;
        this._boxEnd   = null;
        this._cc.scheduleRedraw();
      }
    });
  }

  _hitTestPoint(clientX, clientY) {
    const layer  = this._defaultLayer();
    const coords = layer?.path?.coordinates ?? [];
    const cc  = this._cc;
    const dpr = window.devicePixelRatio || 1;
    const rect = this._canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;

    for (let i = 0; i < coords.length / 2; i++) {
      const { x: cx, y: cy } = cc.sceneToCanvas(coords[i * 2], coords[i * 2 + 1]);
      if (Math.hypot(sx - cx / dpr, sy - cy / dpr) < HIT_R) return i;
    }
    return -1;
  }

  _finishBoxSelect() {
    if (!this._boxStart || !this._boxEnd) return;
    const cc  = this._cc;
    const dpr = window.devicePixelRatio || 1;

    const x0 = Math.min(this._boxStart.x, this._boxEnd.x);
    const y0 = Math.min(this._boxStart.y, this._boxEnd.y);
    const x1 = Math.max(this._boxStart.x, this._boxEnd.x);
    const y1 = Math.max(this._boxStart.y, this._boxEnd.y);

    // CSS px → canvas px → scene coords (y-flip handled by canvasToScene)
    const s0 = cc.canvasToScene(x0 * dpr, y0 * dpr);
    const s1 = cc.canvasToScene(x1 * dpr, y1 * dpr);
    const sceneXMin = Math.min(s0.x, s1.x);
    const sceneXMax = Math.max(s0.x, s1.x);
    const sceneYMin = Math.min(s0.y, s1.y);
    const sceneYMax = Math.max(s0.y, s1.y);

    const layer  = this._defaultLayer();
    const coords = layer?.path?.coordinates ?? [];
    for (let i = 0; i < coords.length / 2; i++) {
      const px = coords[i * 2], py = coords[i * 2 + 1];
      if (px >= sceneXMin && px <= sceneXMax && py >= sceneYMin && py <= sceneYMax) {
        this._selectedPoints.add(i);
      }
    }
  }

  _onKey(e) {
    if (e.key === "Escape" && this._selectedPoints.size > 0) {
      this._selectedPoints.clear();
      this._cc.scheduleRedraw();
      e.stopPropagation();
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  async load() {
    try {
      [this._glyph, this._fontInfo] = await Promise.all([
        this._fc.getGlyph(this._glyphName),
        this._fc.getFontInfo().catch(() => null),
      ]);
    } catch (err) {
      console.error(`ComfyFont: ${this._glyphName} — load error:`, err);
      return;
    }

    this._updateInfo();
    // Try to fit now; if canvas isn't sized yet the _onResize hook will retry.
    this._applyZoomFit();
  }

  _applyZoomFit() {
    const dpr = window.devicePixelRatio || 1;
    // CanvasController uses 400×400 as a fallback when the canvas parent has
    // no size yet (pane is display:none).  Skip fitting until the pane is
    // visible and the canvas has its real dimensions (> 400 CSS px wide).
    if ((this._canvas.width / dpr) <= 400) return;
    const layer     = this._defaultLayer();
    const advance   = layer?.xAdvance ?? 1000;
    const info      = this._fontInfo;
    const ascender  = info?.ascender  ?? 800;
    const descender = info?.descender ?? -200;
    this._cc.zoomFit(0, descender, Math.max(advance, 1), ascender, 40);
    this._fittedOnce = true;
  }

  async save() {
    if (!this._dirty || !this._glyph) return;
    try {
      const layer = this._defaultLayer();
      await this._fc.editFinal(this._glyphName, null, { "=": ["layers", layer] }, false);
      this._dirty = false;
      this._updateInfo();
    } catch (err) {
      console.error("ComfyFont save error:", err);
    }
  }

  onActivated() {
    // Try to fit if data is ready and canvas is now properly sized.
    // _applyZoomFit guards against the 400px fallback and sets _fittedOnce.
    if (this._glyph && !this._fittedOnce) this._applyZoomFit();
    this._cc.scheduleRedraw();
  }

  destroy() {
    this._cc.destroy?.();
    document.removeEventListener("keydown", this._keyHandler);
  }

  setMaster(masterId) {
    this._masterId = masterId;
    this._selectedPoints.clear();
    this._cc.scheduleRedraw();
    this._updateInfo();
  }

  // -------------------------------------------------------------------------
  // Drawing — pixel space (reset CanvasController's y-flip transform)

  _draw(ctx) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); // draw in raw canvas pixel space

    const layer = this._defaultLayer();
    if (!layer) { ctx.restore(); return; }

    const advance = layer.xAdvance ?? 1000;

    this._drawMetrics(ctx, advance);

    const path = layer.path;
    if (path?.coordinates?.length) {
      this._drawOutline(ctx, path);
      this._drawHandles(ctx, path);
      this._drawNodes(ctx, path);
    }

    if (this._isBoxing && this._boxStart && this._boxEnd) {
      this._drawBoxSelect(ctx);
    }

    ctx.restore();
  }

  _drawMetrics(ctx, advance) {
    const cc   = this._cc;
    const info = this._fontInfo;

    const ascender  = info?.ascender  ?? 800;
    const descender = info?.descender ?? -200;
    const xHeight   = info?.xHeight   ?? 500;
    const capHeight = info?.capHeight  ?? 700;

    // Glyph metrics rectangle (Runebender style) — thin box bounding the em square
    const { x: rxMin, y: ryTop } = cc.sceneToCanvas(0,       ascender);
    const { x: rxMax, y: ryBot } = cc.sceneToCanvas(advance, descender);
    ctx.strokeStyle = 'rgba(255,255,255,0.20)';
    ctx.lineWidth = 1;
    ctx.globalAlpha = 1;
    ctx.strokeRect(rxMin, ryTop, rxMax - rxMin, ryBot - ryTop);

    // Horizontal metric subdivisions clipped to rectangle width
    const metrics = [
      { y: capHeight, alpha: 0.18 },
      { y: xHeight,   alpha: 0.18 },
      { y: 0,         alpha: 0.35 },  // baseline
    ];
    for (const m of metrics) {
      const { y: cy } = cc.sceneToCanvas(0, m.y);
      ctx.beginPath();
      ctx.moveTo(rxMin, cy);
      ctx.lineTo(rxMax, cy);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.globalAlpha = m.alpha;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  _drawOutline(ctx, path) {
    const p2d = _buildPath2D(path, this._cc);
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    ctx.strokeStyle = T.glyphFill;
    ctx.lineWidth = 1.5;
    ctx.fill(p2d, "nonzero");
    ctx.stroke(p2d);
  }

  _drawHandles(ctx, path) {
    const coords   = path.coordinates ?? [];
    const types    = path.pointTypes  ?? [];
    const contours = path.contourInfo ?? [];
    const cc = this._cc;

    ctx.strokeStyle = C_HANDLE;
    ctx.lineWidth = 1;

    let ci = 0;
    for (const { endPoint } of contours) {
      const n = endPoint - ci + 1;
      for (let k = 0; k < n; k++) {
        const i    = ci + k;
        const base = types[i] & 0x0f;
        if (base !== PT_OFF_QUAD && base !== PT_OFF_CUBIC) continue;

        const { x: cx, y: cy } = cc.sceneToCanvas(coords[i * 2], coords[i * 2 + 1]);

        // Draw line to each adjacent point (both prev and next in contour)
        for (const delta of [-1, 1]) {
          const j = ci + (k + delta + n) % n;
          const { x: nx, y: ny } = cc.sceneToCanvas(coords[j * 2], coords[j * 2 + 1]);
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(nx, ny);
          ctx.stroke();
        }
      }
      ci = endPoint + 1;
    }
  }

  _drawNodes(ctx, path) {
    const coords   = path.coordinates ?? [];
    const types    = path.pointTypes  ?? [];
    const cc  = this._cc;
    const dpr = window.devicePixelRatio || 1;
    const R_ON  = 4 * dpr;
    const R_OFF = 3 * dpr;

    for (let i = 0; i < types.length; i++) {
      const sx = coords[i * 2], sy = coords[i * 2 + 1];
      const { x: cx, y: cy } = cc.sceneToCanvas(sx, sy);
      const base   = types[i] & 0x0f;
      const smooth = (types[i] & 0x08) !== 0;
      const isOff  = base === PT_OFF_QUAD || base === PT_OFF_CUBIC;
      const sel    = this._selectedPoints.has(i);

      let fill, stroke, r;
      if (sel) {
        fill = C_SEL_FILL;    stroke = C_SEL_STK;    r = R_ON;
      } else if (isOff) {
        fill = C_OFF_FILL;    stroke = C_OFF_STK;    r = R_OFF;
      } else if (smooth) {
        fill = C_SMOOTH_FILL; stroke = C_SMOOTH_STK; r = R_ON;
      } else {
        fill = C_CORNER_FILL; stroke = C_CORNER_STK; r = R_ON;
      }

      ctx.beginPath();
      if (isOff || smooth || sel) {
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
      } else {
        // Corner on-curve: square
        ctx.rect(cx - r, cy - r, r * 2, r * 2);
      }
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  _drawBoxSelect(ctx) {
    const dpr = window.devicePixelRatio || 1;
    const x0 = Math.min(this._boxStart.x, this._boxEnd.x) * dpr;
    const y0 = Math.min(this._boxStart.y, this._boxEnd.y) * dpr;
    const w  = Math.abs(this._boxEnd.x - this._boxStart.x) * dpr;
    const h  = Math.abs(this._boxEnd.y - this._boxStart.y) * dpr;

    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = T.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, y0, w, h);
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = T.accent;
    ctx.fillRect(x0, y0, w, h);
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------------------

  _defaultLayer() {
    return this._glyph?.layerForMaster(this._masterId) ?? null;
  }

  _updateInfo() {
    // Info bar removed — nothing to update.
  }
}

// ---------------------------------------------------------------------------
// Path2D builder — converts scene (font) coordinates to canvas coordinates

function _buildPath2D(packed, cc) {
  const p2d    = new Path2D();
  const coords   = packed.coordinates ?? [];
  const types    = packed.pointTypes  ?? [];
  const contours = packed.contourInfo ?? [];

  let ci = 0;
  for (const { endPoint, isClosed } of contours) {
    const pts = [];
    for (let i = ci; i <= endPoint; i++) {
      const { x: cx, y: cy } = cc.sceneToCanvas(coords[i * 2], coords[i * 2 + 1]);
      pts.push({ x: cx, y: cy, t: types[i] & 0x0f });
    }
    _drawContour(p2d, pts, isClosed);
    ci = endPoint + 1;
  }
  return p2d;
}

const OFF_QUAD  = 1;
const OFF_CUBIC = 2;

function _drawContour(p2d, pts, isClosed) {
  if (pts.length === 0) return;

  let startIdx = pts.findIndex((p) => p.t !== OFF_QUAD && p.t !== OFF_CUBIC);
  if (startIdx === -1) startIdx = 0;

  const n  = pts.length;
  const at = (i) => pts[(startIdx + i) % n];

  p2d.moveTo(at(0).x, at(0).y);

  let i = 1;
  while (i < n) {
    const cur = at(i);
    if (cur.t === OFF_CUBIC) {
      const c1 = cur, c2 = at(i + 1), ep = at(i + 2);
      p2d.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, ep.x, ep.y);
      i += 3;
    } else if (cur.t === OFF_QUAD) {
      const offCurves = [cur];
      let j = i + 1;
      while (j < n && at(j).t === OFF_QUAD) { offCurves.push(at(j)); j++; }
      const on = at(j);
      for (let k = 0; k < offCurves.length; k++) {
        const cp = offCurves[k];
        const ep = k + 1 < offCurves.length
          ? { x: (cp.x + offCurves[k + 1].x) / 2, y: (cp.y + offCurves[k + 1].y) / 2 }
          : on;
        p2d.quadraticCurveTo(cp.x, cp.y, ep.x, ep.y);
      }
      i = j + 1;
    } else {
      p2d.lineTo(cur.x, cur.y);
      i++;
    }
  }

  if (isClosed) p2d.closePath();
}
