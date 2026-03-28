/**
 * glyph-editor-tab.js — Bezier glyph editor for one glyph.
 *
 * Rendered inside a .cf-pane div.  Uses CanvasController for pan/zoom
 * and VisualizationLayers for drawing.
 *
 * Options:
 *   onNavigate(glyphName)  — called when user opens an adjacent glyph
 */

import { CanvasController } from "./canvas-controller.js";

// ---------------------------------------------------------------------------

const CSS = `
.cf-editor-root {
  display: flex; flex-direction: column; width: 100%; height: 100%;
  background: #1a1a1a; overflow: hidden;
}
.cf-editor-toolbar {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 12px; min-height: 36px;
  background: #222; border-bottom: 1px solid #333;
  flex-shrink: 0;
}
.cf-editor-toolbar label { color: #888; font-size: 11px; }
.cf-editor-toolbar input[type=range] { width: 80px; }
.cf-editor-spacer { flex: 1; }
.cf-editor-info { color: #555; font-size: 11px; }
.cf-editor-canvas-wrap {
  flex: 1; position: relative; overflow: hidden;
}
.cf-editor-canvas-wrap canvas {
  position: absolute; inset: 0; width: 100%; height: 100%;
}
`;

function injectEditorCSS() {
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
   * @param {{onNavigate: function}} options
   */
  constructor(container, fontController, glyphName, options = {}) {
    injectEditorCSS();

    this._fc = fontController;
    this._glyphName = glyphName;
    this._onNavigate = options.onNavigate ?? (() => {});
    this._glyph = null;
    this._dirty = false;

    // Build DOM
    const root = document.createElement("div");
    root.className = "cf-editor-root";

    // Toolbar
    const toolbar = document.createElement("div");
    toolbar.className = "cf-editor-toolbar";

    const infoEl = document.createElement("span");
    infoEl.className = "cf-editor-info";
    infoEl.textContent = glyphName;
    this._infoEl = infoEl;

    const spacer = document.createElement("div");
    spacer.className = "cf-editor-spacer";

    // Zoom label + slider
    const zoomLabel = document.createElement("label");
    zoomLabel.textContent = "Zoom";
    const zoomSlider = document.createElement("input");
    zoomSlider.type = "range";
    zoomSlider.min = "0.05";
    zoomSlider.max = "8";
    zoomSlider.step = "0.01";
    zoomSlider.value = "1";
    this._zoomSlider = zoomSlider;

    toolbar.appendChild(infoEl);
    toolbar.appendChild(spacer);
    toolbar.appendChild(zoomLabel);
    toolbar.appendChild(zoomSlider);

    // Canvas wrapper
    const canvasWrap = document.createElement("div");
    canvasWrap.className = "cf-editor-canvas-wrap";

    const canvas = document.createElement("canvas");
    canvasWrap.appendChild(canvas);

    root.appendChild(toolbar);
    root.appendChild(canvasWrap);
    container.appendChild(root);

    this._root = root;
    this._canvas = canvas;

    // CanvasController calls _draw() and handles HiDPI resize
    this._cc = new CanvasController(canvas, () => this._draw());

    // Zoom slider → canvas
    zoomSlider.addEventListener("input", () => {
      this._cc.zoomTo(parseFloat(zoomSlider.value));
    });

    // Monkey-patch scheduleRedraw to sync slider when zoom changes via wheel
    const origSchedule = this._cc.scheduleRedraw.bind(this._cc);
    this._cc.scheduleRedraw = () => {
      zoomSlider.value = String(Math.round(this._cc.magnification * 100) / 100);
      origSchedule();
    };

    // Click on point — future: select/drag
    canvas.addEventListener("click", (e) => this._onClick(e));
  }

  // -------------------------------------------------------------------------

  async load() {
    try {
      this._glyph = await this._fc.getGlyph(this._glyphName);
    } catch (err) {
      this._infoEl.textContent = `${this._glyphName} — load error: ${err.message}`;
      return;
    }

    // Gather path + metrics for the default layer (StaticGlyphController)
    const layer = this._defaultLayer();
    const advance = layer?.xAdvance ?? 1000;

    // Fit glyph into view
    const upm = advance > 0 ? advance : 1000;
    this._cc.zoomFit(0, -200, advance, upm, 32);

    this._updateInfo();
    this._draw();
  }

  async save() {
    if (!this._dirty || !this._glyph) return;
    // editFinal sends the full glyph back to the server
    try {
      const layer = this._defaultLayer();
      await this._fc.editFinal(
        this._glyphName,
        null,
        { "=": ["layers", layer] },
        false
      );
      this._dirty = false;
      this._updateInfo();
    } catch (err) {
      console.error("ComfyFont save error:", err);
    }
  }

  onActivated() {
    // Redraw in case canvas was resized while inactive
    this._cc.scheduleRedraw();
  }

  destroy() {
    this._cc.destroy?.();
  }

  // -------------------------------------------------------------------------
  // Drawing

  // Called by CanvasController — ctx has the DPR scale applied but NOT the y-flip
  // (the controller's draw() applies the y-flip transform before calling here,
  //  but we draw in pixel/canvas space using sceneToCanvas manually, so restore first)
  _draw() {
    const canvas = this._canvas;
    // CanvasController already sized the canvas and called clearRect before our callback
    const ctx = canvas.getContext("2d");

    // We draw in raw canvas pixel space (not the y-flipped scene transform)
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); // reset to pixel space

    const layer = this._defaultLayer();
    if (!layer) { ctx.restore(); return; }

    const advance = layer?.xAdvance ?? 1000;
    const upm = 1000; // TODO: read from fontInfo

    this._drawMetrics(ctx, advance, upm);

    const path = layer?.path;
    if (path?.coordinates?.length) {
      this._drawOutline(ctx, path);
      this._drawNodes(ctx, path);
    }

    ctx.restore();
  }

  _drawMetrics(ctx, advance, upm) {
    const cc = this._cc;

    // Baseline, ascender, descender lines
    const metrics = [
      { y: 0,    color: "#3a3a3a" },
      { y: 800,  color: "#2a3a2a" },
      { y: -200, color: "#3a2a2a" },
      { y: 700,  color: "#2a2e3a" },
      { y: 500,  color: "#2a2e3a" },
    ];

    const cw = ctx.canvas.width;
    for (const m of metrics) {
      const { y: cy } = cc.sceneToCanvas(0, m.y);
      ctx.beginPath();
      ctx.moveTo(0, cy);
      ctx.lineTo(cw, cy);
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Left sidebearing & advance width verticals
    for (const sx of [0, advance]) {
      const { x: cx } = cc.sceneToCanvas(sx, 0);
      const ch = ctx.canvas.height;
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, ch);
      ctx.strokeStyle = "#2e3a2e";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  _drawOutline(ctx, packed) {
    const p2d = _buildPath2D(packed, this._cc);
    ctx.fillStyle = "rgba(200,200,220,0.15)";
    ctx.strokeStyle = "#8899cc";
    ctx.lineWidth = 1.5;
    ctx.fill(p2d, "nonzero");
    ctx.stroke(p2d);
  }

  _drawNodes(ctx, packed) {
    const coords = packed.coordinates ?? [];
    const types = packed.pointTypes ?? [];
    const cc = this._cc;
    const dpr = window.devicePixelRatio || 1;
    const R_ON = 4 * dpr;
    const R_OFF = 3 * dpr;

    for (let i = 0; i < types.length; i++) {
      const sx = coords[i * 2];
      const sy = coords[i * 2 + 1];
      const { x: cx, y: cy } = cc.sceneToCanvas(sx, sy);
      const t = types[i] & 0x0f;

      ctx.beginPath();
      if (t === 0x01 || t === 0x02) {
        // Off-curve: circle
        ctx.arc(cx, cy, R_OFF, 0, Math.PI * 2);
        ctx.fillStyle = "#4477aa";
      } else {
        // On-curve: square
        ctx.rect(cx - R_ON / 2, cy - R_ON / 2, R_ON, R_ON);
        const smooth = (types[i] & 0x08) !== 0;
        ctx.fillStyle = smooth ? "#66aaff" : "#aaddff";
      }
      ctx.fill();
    }

    // Draw handles (lines from on-curve to adjacent off-curves)
    this._drawHandles(ctx, packed);
  }

  _drawHandles(ctx, packed) {
    const coords = packed.coordinates ?? [];
    const types = packed.pointTypes ?? [];
    const contours = packed.contourInfo ?? [];
    const cc = this._cc;
    const dpr = window.devicePixelRatio || 1;

    ctx.strokeStyle = "#334466";
    ctx.lineWidth = 1 * dpr;

    let ci = 0;
    for (const { endPoint } of contours) {
      const pts = [];
      for (let i = ci; i <= endPoint; i++) {
        pts.push({ x: coords[i * 2], y: coords[i * 2 + 1], t: types[i] & 0x0f });
      }
      const n = pts.length;
      for (let i = 0; i < n; i++) {
        const cur = pts[i];
        if (cur.t === 0x01 || cur.t === 0x02) {
          // Find nearest on-curve neighbours
          const prev = pts[(i - 1 + n) % n];
          const { x: cx, y: cy } = cc.sceneToCanvas(cur.x, cur.y);
          const { x: px, y: py } = cc.sceneToCanvas(prev.x, prev.y);
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(px, py);
          ctx.stroke();
        }
      }
      ci = endPoint + 1;
    }
  }

  // -------------------------------------------------------------------------

  _onClick(e) {
    // Future: hit-test points for selection
    void e;
  }

  _defaultLayer() {
    // VariableGlyphController.defaultLayer returns a StaticGlyphController
    return this._glyph?.defaultLayer ?? null;
  }

  _updateInfo() {
    const layer = this._defaultLayer();
    const adv = layer?.xAdvance;
    const pts = (layer?.path?.coordinates?.length ?? 0) / 2;
    const dirty = this._dirty ? " ●" : "";
    this._infoEl.textContent =
      `${this._glyphName}  |  advance: ${adv ?? "?"}  |  nodes: ${Math.round(pts)}${dirty}`;
  }
}

// ---------------------------------------------------------------------------
// Path2D builder (scene coords → canvas coords via CanvasController)

function _buildPath2D(packed, cc) {
  const p2d = new Path2D();
  const coords = packed.coordinates ?? [];
  const types = packed.pointTypes ?? [];
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

const OFF_CURVE_QUAD  = 0x01;
const OFF_CURVE_CUBIC = 0x02;

function _drawContour(p2d, pts, isClosed) {
  if (pts.length === 0) return;

  let startIdx = pts.findIndex((p) => p.t !== OFF_CURVE_QUAD && p.t !== OFF_CURVE_CUBIC);
  if (startIdx === -1) startIdx = 0;

  const n = pts.length;
  const at = (i) => pts[(startIdx + i) % n];

  p2d.moveTo(at(0).x, at(0).y);

  let i = 1;
  while (i < n) {
    const cur = at(i);
    if (cur.t === OFF_CURVE_CUBIC) {
      const c1 = cur, c2 = at(i + 1), ep = at(i + 2);
      p2d.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, ep.x, ep.y);
      i += 3;
    } else if (cur.t === OFF_CURVE_QUAD) {
      const offCurves = [cur];
      let j = i + 1;
      while (j < n && at(j).t === OFF_CURVE_QUAD) { offCurves.push(at(j)); j++; }
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
