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
import { applyChange, consolidateChanges, hasChange } from "./changes.js";
import { applyEditBehavior, nudgePoints, toggleSmooth } from "./edit-behavior.js";
import { findHoveredSegment, buildSegmentPath2D, insertOnSegment } from "./segment-utils.js";

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
const C_COMP_FILL   = '#4488CC';  // component fill (blue-gray, Fontra-style)
const C_COMP_STK    = '#5599EE';

const HIT_R = 6; // CSS px — pointer hit radius for points

// ---------------------------------------------------------------------------
// Async event stream for tool drag handling
// Creates an async iterable of pointermove/pointerup events on the canvas.

function makeEventStream(canvas) {
  const queue   = [];
  let   resolve = null;
  let   done    = false;

  function push(e) {
    if (resolve) {
      const r = resolve; resolve = null;
      r({ value: e, done: false });
    } else {
      queue.push(e);
    }
  }

  function finish() {
    done = true;
    canvas.removeEventListener("pointermove",   onMove);
    canvas.removeEventListener("pointerup",     onUp);
    canvas.removeEventListener("pointercancel", onUp);
    if (resolve) { const r = resolve; resolve = null; r({ value: undefined, done: true }); }
  }

  const onMove = (e) => push(e);
  const onUp   = (e) => { push(e); finish(); };

  canvas.addEventListener("pointermove",   onMove);
  canvas.addEventListener("pointerup",     onUp);
  canvas.addEventListener("pointercancel", onUp);

  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (done)         return Promise.resolve({ value: undefined,     done: true  });
          return new Promise(r => { resolve = r; });
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tool base class

class BaseTool {
  constructor(editor) { this._editor = editor; }
  activate()   {}
  deactivate() {}
  /** @param {PointerEvent} _e */
  handleHover(_e) {}
  /**
   * Handle a pointer drag starting with downEvent.
   * stream is an async iterable of subsequent pointermove/pointerup events.
   * @param {AsyncIterable<PointerEvent>} _stream
   * @param {PointerEvent} _downEvent
   */
  async handleDrag(_stream, _downEvent) {}
  /** @param {KeyboardEvent} _e */
  handleKeyDown(_e) {}
  /** Draw any tool-specific overlay (called in pixel/canvas space). */
  drawOverlay(_ctx) {}
  get cursor() { return 'default'; }
}

// Orange accent for hovered segments
const C_SEG_HOVER = '#FF8800';

// ---------------------------------------------------------------------------
// SelectTool — point drag, segment hover/insert, box-select

class SelectTool extends BaseTool {
  constructor(editor) {
    super(editor);
    this._isBoxing       = false;
    this._boxStart       = null;
    this._boxEnd         = null;
    this._hoveredSegment = null;  // { ci, segIdx, t, pts, canvasPt } or null
  }

  get cursor() { return 'default'; }

  activate() { this._hoveredSegment = null; }
  deactivate() {
    if (this._hoveredSegment) {
      this._hoveredSegment = null;
      this._editor._cc.scheduleRedraw();
    }
  }

  handleHover(e) {
    const ed = this._editor;
    if (!e) {
      if (this._hoveredSegment) { this._hoveredSegment = null; ed._cc.scheduleRedraw(); }
      return;
    }

    const layer = ed._defaultLayer();
    const path  = layer?.path;
    if (!path?.coordinates?.length) {
      if (this._hoveredSegment) { this._hoveredSegment = null; ed._cc.scheduleRedraw(); }
      return;
    }

    // Points take priority over segments
    if (ed._hitTestPoint(e.clientX, e.clientY) >= 0) {
      if (this._hoveredSegment) { this._hoveredSegment = null; ed._cc.scheduleRedraw(); }
      return;
    }

    const dpr  = window.devicePixelRatio || 1;
    const rect = ed._canvas.getBoundingClientRect();
    const cpx  = (e.clientX - rect.left) * dpr;
    const cpy  = (e.clientY - rect.top)  * dpr;

    const hit = findHoveredSegment(path, ed._cc, cpx, cpy, HIT_R * dpr * 2);
    const prev = this._hoveredSegment;
    this._hoveredSegment = hit;
    if ((hit?.ci !== prev?.ci) || (hit?.segIdx !== prev?.segIdx) || (!hit && prev)) {
      ed._cc.scheduleRedraw();
    }
  }

  handleDblClick(e) {
    const ed  = this._editor;
    const idx = ed._hitTestPoint(e.clientX, e.clientY);
    if (idx < 0) return;
    const layer = ed._defaultLayer();
    if (!layer?.path) return;
    const { fwdChanges, rbkChanges } = toggleSmooth(layer.path, idx);
    if (!fwdChanges.length) return;
    layer.path.invalidate();
    ed._cc.scheduleRedraw();
    ed._pushEdit(fwdChanges, rbkChanges, layer.path, "toggle smooth");
  }

  async handleDrag(stream, downEvent) {
    const ed  = this._editor;
    const idx = ed._hitTestPoint(downEvent.clientX, downEvent.clientY);

    if (idx >= 0) {
      // --- Point drag ---
      if (!downEvent.shiftKey && !ed._selectedPoints.has(idx)) {
        ed._selectedPoints.clear();
      }
      ed._selectedPoints.add(idx);
      ed._hoveredSegment = null;
      ed._cc.scheduleRedraw();

      const dragStart  = ed._cc.eventToScene(downEvent);
      const layer      = ed._defaultLayer();
      const origCoords = Float64Array.from(layer?.path?.coordinates ?? []);

      for await (const e of stream) {
        if (e.type === "pointermove") {
          const cur = ed._cc.eventToScene(e);
          const dx  = cur.x - dragStart.x;
          const dy  = cur.y - dragStart.y;
          const path   = layer?.path;
          const coords = path?.coordinates;
          if (coords) {
            for (const i of ed._selectedPoints) {
              coords[i * 2]     = origCoords[i * 2]     + dx;
              coords[i * 2 + 1] = origCoords[i * 2 + 1] + dy;
            }
            applyEditBehavior(path, ed._selectedPoints, dx, dy, origCoords);
            path.invalidate();
            ed._dirty = true;
            ed._cc.scheduleRedraw();
          }
        } else if (e.type === "pointerup") {
          ed._recordDragUndo(origCoords);
          break;
        }
      }

    } else if (this._hoveredSegment) {
      // --- Segment click: insert point, then drag it ---
      const seg   = this._hoveredSegment;
      const layer = ed._defaultLayer();
      const path  = layer?.path;
      if (path) {
        const { fwdChanges, rbkChanges, newAbsIdx } = insertOnSegment(path, seg, seg.t);
        if (fwdChanges.length) {
          path.invalidate();
          ed._dirty = true;
          this._hoveredSegment = null;

          // Select the new point and start dragging it
          if (!downEvent.shiftKey) ed._selectedPoints.clear();
          if (newAbsIdx >= 0) ed._selectedPoints.add(newAbsIdx);
          ed._cc.scheduleRedraw();

          // Finalize insert edit
          ed._pushEdit(fwdChanges, rbkChanges, path, "insert point");

          // Start dragging the new point
          const dragStart  = ed._cc.eventToScene(downEvent);
          const origCoords = Float64Array.from(path.coordinates);

          for await (const e of stream) {
            if (e.type === "pointermove") {
              const cur = ed._cc.eventToScene(e);
              const dx  = cur.x - dragStart.x, dy = cur.y - dragStart.y;
              const coords = path.coordinates;
              if (coords && newAbsIdx >= 0) {
                coords[newAbsIdx * 2]     = origCoords[newAbsIdx * 2]     + dx;
                coords[newAbsIdx * 2 + 1] = origCoords[newAbsIdx * 2 + 1] + dy;
                applyEditBehavior(path, ed._selectedPoints, dx, dy, origCoords);
                path.invalidate();
                ed._dirty = true;
                ed._cc.scheduleRedraw();
              }
            } else if (e.type === "pointerup") {
              ed._recordDragUndo(origCoords);
              break;
            }
          }
        } else {
          for await (const e of stream) { if (e.type === "pointerup") break; }
        }
      } else {
        for await (const e of stream) { if (e.type === "pointerup") break; }
      }

    } else {
      const compIdx = ed._hitTestComponent(downEvent.clientX, downEvent.clientY);

      if (compIdx >= 0) {
        // --- Component click / drag ---
        if (!downEvent.shiftKey) {
          ed._selectedPoints.clear();
          ed._selectedComponents.clear();
        }
        ed._selectedComponents.add(compIdx);
        ed._cc.scheduleRedraw();

        const layer = ed._defaultLayer();
        const comp  = layer?.components?.[compIdx];
        if (comp) {
          const dragStart = ed._cc.eventToScene(downEvent);
          const origDx = comp.transformation?.dx ?? 0;
          const origDy = comp.transformation?.dy ?? 0;

          for await (const e of stream) {
            if (e.type === "pointermove") {
              const cur = ed._cc.eventToScene(e);
              if (comp.transformation) {
                comp.transformation.dx = origDx + (cur.x - dragStart.x);
                comp.transformation.dy = origDy + (cur.y - dragStart.y);
              }
              ed._dirty = true;
              ed._cc.scheduleRedraw();
            } else if (e.type === "pointerup") { break; }
          }
        } else {
          for await (const e of stream) { if (e.type === "pointerup") break; }
        }

      } else {
        // --- Box select ---
        if (!downEvent.shiftKey) {
          ed._selectedPoints.clear();
          ed._selectedComponents.clear();
        }

        const rect = ed._canvas.getBoundingClientRect();
        this._boxStart = { x: downEvent.clientX - rect.left, y: downEvent.clientY - rect.top };
        this._boxEnd   = { ...this._boxStart };
        this._isBoxing = true;
        ed._cc.scheduleRedraw();

        for await (const e of stream) {
          if (e.type === "pointermove") {
            const r = ed._canvas.getBoundingClientRect();
            this._boxEnd = { x: e.clientX - r.left, y: e.clientY - r.top };
            ed._cc.scheduleRedraw();
          } else if (e.type === "pointerup") {
            ed._finishBoxSelect(this._boxStart, this._boxEnd);
            break;
          }
        }

        this._isBoxing = false;
        this._boxStart = null;
        this._boxEnd   = null;
        ed._cc.scheduleRedraw();
      }
    }
  }

  drawOverlay(ctx) {
    // Hovered segment highlight
    if (this._hoveredSegment) {
      const { pts, canvasPt } = this._hoveredSegment;
      const cc = this._editor._cc;
      const canvasPts = pts.map(p => cc.sceneToCanvas(p.x, p.y));
      const p2d = buildSegmentPath2D(canvasPts);

      ctx.save();
      ctx.strokeStyle = C_SEG_HOVER;
      ctx.lineWidth   = 3;
      ctx.globalAlpha = 0.7;
      ctx.stroke(p2d);

      // Small dot at the insertion point
      const dpr = window.devicePixelRatio || 1;
      ctx.beginPath();
      ctx.arc(canvasPt.x, canvasPt.y, 4 * dpr, 0, Math.PI * 2);
      ctx.fillStyle   = C_SEG_HOVER;
      ctx.globalAlpha = 1;
      ctx.fill();
      ctx.restore();
    }

    // Box-select rectangle
    if (this._isBoxing && this._boxStart && this._boxEnd) {
      this._editor._drawBoxSelect(ctx, this._boxStart, this._boxEnd);
    }
  }
}

// ---------------------------------------------------------------------------
// PenTool — draw new contours by clicking/dragging

const PEN_CLOSE_R = 12;  // CSS px — snap-close distance to first point
const PEN_DRAG_THRESHOLD = 3;  // CSS px — min drag to activate handle creation

class PenTool extends BaseTool {
  constructor(editor) {
    super(editor);
    this._contour        = [];  // array of {x, y, type} in scene space
    this._pendingHandle  = null; // outgoing off-curve for the last placed smooth point
    this._previewPt      = null; // scene pt under cursor (for preview)
    this._firstPtCanvas  = null; // {x, y} canvas CSS px of first on-curve (for close detection)
  }

  get cursor() { return 'crosshair'; }

  activate() {
    this._contour       = [];
    this._pendingHandle = null;
    this._previewPt     = null;
    this._firstPtCanvas = null;
  }

  deactivate() {
    // Discard any in-progress contour
    this._contour       = [];
    this._pendingHandle = null;
    this._previewPt     = null;
    this._firstPtCanvas = null;
  }

  handleHover(e) {
    const ed = this._editor;
    if (!e) { this._previewPt = null; ed._cc.scheduleRedraw(); return; }
    this._previewPt = ed._cc.eventToScene(e);
    ed._cc.scheduleRedraw();
  }

  handleKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (this._contour.length >= 4) {
        // Commit what we have as an open contour
        this._commitContour(false);
      } else {
        this._contour = [];
        this._pendingHandle = null;
        this._editor._cc.scheduleRedraw();
      }
    }
  }

  async handleDrag(stream, downEvent) {
    const ed    = this._editor;
    const scene = ed._cc.eventToScene(downEvent);

    // Check if near first point → close contour
    if (this._contour.length >= 4 && this._firstPtCanvas) {
      const dpr  = window.devicePixelRatio || 1;
      const rect = ed._canvas.getBoundingClientRect();
      const cx   = downEvent.clientX - rect.left;
      const cy   = downEvent.clientY - rect.top;
      if (Math.hypot(cx - this._firstPtCanvas.x, cy - this._firstPtCanvas.y) < PEN_CLOSE_R) {
        // Flush pending handle then close
        if (this._pendingHandle) this._contour.push(this._pendingHandle);
        this._pendingHandle = null;
        this._commitContour(true);
        // Drain stream
        for await (const e of stream) { if (e.type === "pointerup") break; }
        return;
      }
    }

    // Determine if this is a drag (smooth point) or click (corner)
    let dragDelta = null;

    for await (const e of stream) {
      if (e.type === "pointermove") {
        const dx = e.clientX - downEvent.clientX;
        const dy = e.clientY - downEvent.clientY;
        if (Math.hypot(dx, dy) > PEN_DRAG_THRESHOLD) {
          const cur = ed._cc.eventToScene(e);
          dragDelta = { x: cur.x - scene.x, y: cur.y - scene.y };
        }
        this._previewPt = ed._cc.eventToScene(e);
        ed._cc.scheduleRedraw();
      } else if (e.type === "pointerup") {
        break;
      }
    }

    // First: flush pending outgoing handle from previous smooth point
    if (this._pendingHandle) {
      this._contour.push(this._pendingHandle);
      this._pendingHandle = null;
    }

    if (dragDelta && (Math.abs(dragDelta.x) > 1 || Math.abs(dragDelta.y) > 1)) {
      // Smooth point: add in-handle (mirror of drag), on-curve, remember out-handle
      this._contour.push({ x: scene.x - dragDelta.x, y: scene.y - dragDelta.y, type: 2 });
      this._contour.push({ x: scene.x,               y: scene.y,               type: 8 });
      this._pendingHandle = { x: scene.x + dragDelta.x, y: scene.y + dragDelta.y, type: 2 };
    } else {
      // Corner on-curve
      this._contour.push({ x: scene.x, y: scene.y, type: 0 });
    }

    // Record canvas position of first on-curve for close detection
    if (this._firstPtCanvas === null) {
      const dpr  = window.devicePixelRatio || 1;
      const rect = ed._canvas.getBoundingClientRect();
      this._firstPtCanvas = {
        x: downEvent.clientX - rect.left,
        y: downEvent.clientY - rect.top,
      };
    }

    ed._cc.scheduleRedraw();
  }

  _commitContour(close) {
    const ed = this._editor;
    const layer = ed._defaultLayer();
    if (!layer?.path) return;
    if (this._contour.length < 2) return;

    const contour = { points: this._contour.map(p => ({ ...p })), isClosed: close };
    const path = layer.path;
    const numContours = path.contourInfo.length;

    path.insertContour(numContours, contour);
    path.invalidate();

    const fwd = { f: "insertContour", a: [numContours, contour] };
    const rbk = { f: "deleteContour", a: [numContours] };
    ed._pushEdit([fwd], [rbk], path, "draw contour");

    ed._dirty = true;
    ed._cc.scheduleRedraw();

    this._contour       = [];
    this._pendingHandle = null;
    this._firstPtCanvas = null;
  }

  drawOverlay(ctx) {
    const ed = this._editor;
    const cc = ed._cc;
    const dpr = window.devicePixelRatio || 1;

    // Build display contour (contour + pending handle + preview segment)
    const display = [...this._contour];
    if (this._pendingHandle) display.push(this._pendingHandle);

    if (display.length === 0) return;

    // Convert all display points to canvas coords
    const cvPts = display.map(p => cc.sceneToCanvas(p.x, p.y));

    // Draw the in-progress path
    ctx.save();
    ctx.strokeStyle = T.glyphFill;
    ctx.lineWidth   = 1.5;

    if (cvPts.length >= 2) {
      const p2d = _buildInProgressPath2D(display, cvPts);
      ctx.stroke(p2d);
    }

    // Preview line to cursor
    if (this._previewPt && display.length >= 1) {
      const lastOnCurve = _lastOnCurve(display);
      if (lastOnCurve) {
        const lc = cc.sceneToCanvas(lastOnCurve.x, lastOnCurve.y);
        const pc = cc.sceneToCanvas(this._previewPt.x, this._previewPt.y);
        ctx.beginPath();
        ctx.setLineDash([3 * dpr, 3 * dpr]);
        ctx.moveTo(lc.x, lc.y);
        ctx.lineTo(pc.x, pc.y);
        ctx.globalAlpha = 0.4;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }

    // Draw handle lines
    ctx.strokeStyle = C_HANDLE;
    ctx.lineWidth   = 1;
    for (let i = 0; i < display.length; i++) {
      const t = display[i].type & 0x0f;
      if (t === 1 || t === 2) {
        const cv = cvPts[i];
        // Connect to adjacent on-curve
        for (const d of [-1, 1]) {
          const j = i + d;
          if (j >= 0 && j < display.length && (display[j].type & 0x0f) === 0) {
            ctx.beginPath();
            ctx.moveTo(cv.x, cv.y);
            ctx.lineTo(cvPts[j].x, cvPts[j].y);
            ctx.stroke();
          }
        }
      }
    }

    // Draw nodes
    for (let i = 0; i < display.length; i++) {
      const p = cvPts[i];
      const t = display[i].type & 0x0f;
      const isOff = t === 1 || t === 2;
      const r = isOff ? 3 * dpr : 4 * dpr;
      ctx.beginPath();
      if (isOff) {
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      } else {
        ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
      }
      ctx.fillStyle   = i === 0 ? T.accent : (isOff ? C_OFF_FILL : C_CORNER_FILL);
      ctx.fill();
      ctx.strokeStyle = i === 0 ? T.accent : (isOff ? C_OFF_STK  : C_CORNER_STK);
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    }

    // Close indicator: ring around first point when cursor is near
    if (this._contour.length >= 3 && this._firstPtCanvas && this._previewPt) {
      const pc = cc.sceneToCanvas(this._previewPt.x, this._previewPt.y);
      const fpc = cc.sceneToCanvas(this._contour.find(p => (p.type & 0x03) === 0)?.x ?? 0, this._contour.find(p => (p.type & 0x03) === 0)?.y ?? 0);
      const distCss = Math.hypot((pc.x/dpr) - this._firstPtCanvas.x, (pc.y/dpr) - this._firstPtCanvas.y);
      if (distCss < PEN_CLOSE_R * 2) {
        ctx.beginPath();
        ctx.arc(fpc.x, fpc.y, 8 * dpr, 0, Math.PI * 2);
        ctx.strokeStyle = T.accent;
        ctx.lineWidth   = 2;
        ctx.globalAlpha = 0.7;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Tool stubs — to be implemented in later phases

class KnifeTool  extends BaseTool { get cursor() { return 'crosshair'; } }
class HandTool   extends BaseTool { get cursor() { return 'grab';      } }
class RulerTool  extends BaseTool { get cursor() { return 'crosshair'; } }
class RotateTool extends BaseTool { get cursor() { return 'default';   } }
class TextTool   extends BaseTool { get cursor() { return 'text';      } }

// ---------------------------------------------------------------------------
// Toolbar tool definitions

const TOOLS = [
  { id: 'select', icon: '\uE010', title: 'Select',  toolClass: SelectTool },
  { id: 'pen',    icon: '\uE011', title: 'Pen',     toolClass: PenTool    },
  { id: 'knife',  icon: '\uE013', title: 'Knife',   toolClass: KnifeTool  },
  { id: 'ruler',  icon: '\uE015', title: 'Ruler',   toolClass: RulerTool  },
  { id: 'hand',   icon: '\uE014', title: 'Hand',    toolClass: HandTool   },
  { id: 'rotate', icon: '\uE015', title: 'Rotate',  toolClass: RotateTool },
  { id: 'text',   icon: '\uE017', title: 'Text',    toolClass: TextTool   },
];

// ---------------------------------------------------------------------------
// CSS

const CSS = `
@font-face {
  font-family: 'ComfyFontIcons';
  src: url('/comfyfont/assets/icons.ttf') format('truetype');
  font-weight: normal;
  font-style: normal;
}
.cf-icon {
  font-family: 'ComfyFontIcons', sans-serif;
  font-size: 18px;
  line-height: 1;
  font-style: normal;
  font-weight: normal;
  -webkit-font-smoothing: antialiased;
}
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
// UndoStack — client-side undo/redo, max 128 entries (Runebender)

class UndoStack {
  constructor() {
    this._undo = [];
    this._redo = [];
  }

  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }

  push(record) {
    this._undo.push(record);
    if (this._undo.length > 128) this._undo.shift();
    this._redo = [];
  }

  popUndo() {
    const r = this._undo.pop();
    if (r) this._redo.push(r);
    return r;
  }

  popRedo() {
    const r = this._redo.pop();
    if (r) this._undo.push(r);
    return r;
  }
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
    this._undoStack  = new UndoStack();

    // Selection state (shared with tools via this._editor reference)
    this._selectedPoints     = new Set();
    this._selectedComponents = new Set();  // indices into layer.components

    // Component cache: glyphName → StaticGlyphController (default layer)
    this._componentGlyphs = new Map();
    // Last-drawn component Path2Ds (rebuilt each _draw call, used for hit testing)
    this._componentPaths  = [];

    // Axis location + ghost (interpolated glyph shown at non-default axis position)
    this._axisLocation = {};
    this._ghostLayer   = null;

    this._buildDOM(container);
    this._setupPointerHandlers();

    // Hook into CanvasController's resize so zoomFit runs after the canvas
    // has its real dimensions (ResizeObserver fires AFTER rAF, so rAF-based
    // delays don't work — intercepting _onResize is the reliable fix).
    const origResize = this._cc._onResize.bind(this._cc);
    this._cc._onResize = () => {
      origResize();
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

    this._toolBtns     = {};
    this._tools        = {};
    this._activeTool   = null;
    this._activeToolId = null;

    for (const tool of TOOLS) {
      const btn = document.createElement("button");
      btn.className = "cf-editor-tool-btn cf-icon";
      btn.textContent = tool.icon;
      btn.title = tool.title;
      btn.onclick = () => this._setTool(tool.id);
      toolsEl.appendChild(btn);
      this._toolBtns[tool.id] = btn;
      this._tools[tool.id]    = new tool.toolClass(this);
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

    // Activate initial tool
    this._setTool('select');
  }

  _setTool(id) {
    this._activeTool?.deactivate();
    this._activeTool   = this._tools[id] ?? null;
    this._activeToolId = id;
    this._activeTool?.activate();

    for (const [tid, btn] of Object.entries(this._toolBtns)) {
      btn.classList.toggle("active", tid === id);
    }
  }

  // -------------------------------------------------------------------------
  // Pointer event handling — routes down events to the active tool

  _setupPointerHandlers() {
    const canvas = this._canvas;

    canvas.addEventListener("pointerdown", (e) => {
      // CanvasController owns alt+drag (pan) and middle-click — skip those
      if (e.button !== 0 || e.altKey) return;
      const tool = this._activeTool;
      if (!tool) return;

      canvas.setPointerCapture(e.pointerId);
      e.stopPropagation();

      const stream = makeEventStream(canvas);
      tool.handleDrag(stream, e).catch(console.error);
    });

    canvas.addEventListener("pointermove", (e) => {
      if (e.buttons === 0) this._activeTool?.handleHover?.(e);
    });

    canvas.addEventListener("pointerleave", () => {
      this._activeTool?.handleHover?.(null);
    });

    canvas.addEventListener("dblclick", (e) => {
      this._activeTool?.handleDblClick?.(e);
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

  _finishBoxSelect(boxStart, boxEnd) {
    if (!boxStart || !boxEnd) return;
    const cc  = this._cc;
    const dpr = window.devicePixelRatio || 1;

    const x0 = Math.min(boxStart.x, boxEnd.x);
    const y0 = Math.min(boxStart.y, boxEnd.y);
    const x1 = Math.max(boxStart.x, boxEnd.x);
    const y1 = Math.max(boxStart.y, boxEnd.y);

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
    const cmd = e.metaKey || e.ctrlKey;

    if (cmd && e.key === "z") {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) this._doRedo();
      else            this._doUndo();
      return;
    }

    if (cmd && e.key === "a") {
      e.preventDefault();
      e.stopPropagation();
      const layer = this._defaultLayer();
      const count = layer?.path?.pointTypes?.length ?? 0;
      this._selectedPoints = new Set(Array.from({ length: count }, (_, i) => i));
      this._cc.scheduleRedraw();
      return;
    }

    if (cmd && e.key === "c") {
      e.preventDefault();
      this._copyToClipboard();
      return;
    }

    if (cmd && e.key === "x") {
      e.preventDefault();
      this._copyToClipboard();
      this._deleteSelectedPoints();
      return;
    }

    if (cmd && e.key === "v") {
      e.preventDefault();
      this._pasteFromClipboard().catch(console.error);
      return;
    }

    if (e.key === "Escape" && (this._selectedPoints.size > 0 || this._selectedComponents.size > 0)) {
      this._selectedPoints.clear();
      this._selectedComponents.clear();
      this._cc.scheduleRedraw();
      e.stopPropagation();
      return;
    }

    // Arrow key nudge (Runebender: 1 / 10 / 100 units)
    const arrowDelta = { ArrowLeft: [-1,0], ArrowRight:[1,0], ArrowUp:[0,1], ArrowDown:[0,-1] }[e.key];
    if (arrowDelta && this._selectedPoints.size > 0) {
      e.preventDefault();
      e.stopPropagation();
      const mult = e.shiftKey && e.altKey ? 100 : e.shiftKey ? 10 : 1;
      const layer = this._defaultLayer();
      if (!layer?.path) return;
      const { fwdChanges, rbkChanges } = nudgePoints(
        layer.path, this._selectedPoints,
        arrowDelta[0] * mult, arrowDelta[1] * mult
      );
      if (fwdChanges.length) {
        this._dirty = true;
        this._cc.scheduleRedraw();
        this._pushEdit(fwdChanges, rbkChanges, layer.path, "nudge");
      }
      return;
    }

    // Delete / Backspace — remove selected points
    if ((e.key === "Delete" || e.key === "Backspace") && this._selectedPoints.size > 0) {
      e.preventDefault();
      e.stopPropagation();
      this._deleteSelectedPoints();
      return;
    }

    this._activeTool?.handleKeyDown(e);
  }

  _deleteSelectedPoints() {
    const layer = this._defaultLayer();
    if (!layer?.path || !this._selectedPoints.size) return;
    const path = layer.path;

    // Delete from highest index down so indices stay valid
    const sorted = [...this._selectedPoints].sort((a, b) => b - a);
    const fwdChanges = [];
    const rbkChanges = [];

    for (const absIdx of sorted) {
      // Find contour + contour-local index
      let ci = 0, localIdx = -1;
      let start = 0;
      for (let c = 0; c < path.contourInfo.length; c++) {
        const { endPoint } = path.contourInfo[c];
        if (absIdx <= endPoint) {
          ci = c; localIdx = absIdx - start; break;
        }
        start = endPoint + 1;
      }
      if (localIdx < 0) continue;

      const snap = path.getContourPoint(ci, localIdx);
      fwdChanges.push({ f: "deletePoint", a: [ci, localIdx] });
      rbkChanges.unshift({ f: "insertPoint", a: [ci, localIdx, snap] });
      path.deletePoint(ci, localIdx);
    }

    this._selectedPoints.clear();
    path.invalidate();
    this._dirty = true;
    this._cc.scheduleRedraw();

    if (fwdChanges.length) {
      this._pushEdit(fwdChanges, rbkChanges, path, "delete points");
    }
  }

  // -------------------------------------------------------------------------
  // Clipboard — copy / paste / cut

  _copyToClipboard() {
    const layer = this._defaultLayer();
    const path  = layer?.path;
    if (!path || !this._selectedPoints.size) return;

    const contours = [];
    let absStart = 0;

    for (let ci = 0; ci < path.contourInfo.length; ci++) {
      const { endPoint, isClosed } = path.contourInfo[ci];
      const n = endPoint - absStart + 1;

      const selectedLocal = [];
      for (let k = 0; k < n; k++) {
        if (this._selectedPoints.has(absStart + k)) selectedLocal.push(k);
      }

      if (selectedLocal.length === 0) { absStart = endPoint + 1; continue; }

      if (selectedLocal.length === n) {
        // Full contour: copy with all point types preserved
        const points = [];
        for (let k = 0; k < n; k++) {
          const abs = absStart + k;
          points.push({
            x: path.coordinates[abs * 2],
            y: path.coordinates[abs * 2 + 1],
            type: path.pointTypes[abs],
          });
        }
        contours.push({ points, isClosed });
      } else {
        // Partial selection: copy selected points as a new open contour (corners only)
        const points = selectedLocal.map(k => {
          const abs = absStart + k;
          return {
            x: path.coordinates[abs * 2],
            y: path.coordinates[abs * 2 + 1],
            type: 0,
          };
        });
        contours.push({ points, isClosed: false });
      }

      absStart = endPoint + 1;
    }

    if (!contours.length) return;
    navigator.clipboard.writeText(
      JSON.stringify({ "comfyfont/glyphs": contours })
    ).catch(console.error);
  }

  async _pasteFromClipboard() {
    const layer = this._defaultLayer();
    if (!layer?.path) return;

    let text;
    try { text = await navigator.clipboard.readText(); }
    catch { return; }

    let data;
    try { data = JSON.parse(text); }
    catch { return; }

    const incoming = data?.["comfyfont/glyphs"];
    if (!Array.isArray(incoming) || !incoming.length) return;

    const path        = layer.path;
    const fwdChanges  = [];
    const rbkChanges  = [];
    const OFFSET      = 20;

    for (const contour of incoming) {
      if (!Array.isArray(contour.points) || !contour.points.length) continue;
      const pts = contour.points.map(p => ({
        x:    (p.x ?? 0) + OFFSET,
        y:    (p.y ?? 0) + OFFSET,
        type: p.type ?? 0,
      }));
      const ci  = path.contourInfo.length;
      const nc  = { points: pts, isClosed: contour.isClosed ?? false };
      path.insertContour(ci, nc);
      fwdChanges.push({ f: "insertContour", a: [ci, nc] });
      rbkChanges.unshift({ f: "deleteContour", a: [ci] });
    }

    if (!fwdChanges.length) return;

    path.invalidate();
    this._dirty = true;

    // Select all pasted points
    this._selectedPoints.clear();
    let absStart = 0;
    const pastedStart = path.contourInfo.length - fwdChanges.length;
    for (let ci = 0; ci < path.contourInfo.length; ci++) {
      const { endPoint } = path.contourInfo[ci];
      if (ci >= pastedStart) {
        for (let abs = absStart; abs <= endPoint; abs++) this._selectedPoints.add(abs);
      }
      absStart = endPoint + 1;
    }

    this._cc.scheduleRedraw();
    this._pushEdit(fwdChanges, rbkChanges, path, "paste");
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

    // Prefetch component glyphs (fire-and-forget; triggers redraw when ready)
    this._loadComponents().catch(console.error);
    // Try to fit now; if canvas isn't sized yet the _onResize hook will retry.
    this._applyZoomFit();
  }

  async _loadComponents() {
    const layer = this._defaultLayer();
    const components = layer?.components ?? [];
    const names = [...new Set(components.map(c => c.name))];
    if (!names.length) return;

    await Promise.all(names.map(async (name) => {
      if (this._componentGlyphs.has(name)) return;
      const glyph = await this._fc.getGlyph(name).catch(() => null);
      if (!glyph) return;
      const baseLayer = glyph.layerForMaster(this._masterId);
      if (baseLayer) {
        this._componentGlyphs.set(name, baseLayer);
        this._cc.scheduleRedraw();
      }
    }));
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

  onActivated() {
    if (this._glyph && !this._fittedOnce) this._applyZoomFit();
    this._cc.scheduleRedraw();
  }

  destroy() {
    this._activeTool?.deactivate();
    this._cc.destroy?.();
    document.removeEventListener("keydown", this._keyHandler);
  }

  setMaster(masterId) {
    this._masterId = masterId;
    this._selectedPoints.clear();
    this._selectedComponents.clear();
    this._componentGlyphs.clear();
    this._loadComponents().catch(console.error);
    this._cc.scheduleRedraw();
  }

  setLocation(location) {
    this._axisLocation = { ...location };
    // Fetch interpolated glyph for ghost rendering (fire-and-forget)
    if (this._glyph && Object.keys(location).length) {
      this._fc.getSpecimenAtLocation([this._glyphName], location)
        .then(result => {
          this._ghostLayer = result[this._glyphName] ?? null;
          this._cc.scheduleRedraw();
        })
        .catch(() => { this._ghostLayer = null; });
    } else {
      this._ghostLayer = null;
      this._cc.scheduleRedraw();
    }
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
    this._drawGhost(ctx);
    this._drawComponents(ctx);

    const path = layer.path;
    if (path?.coordinates?.length) {
      this._drawOutline(ctx, path);
      this._drawHandles(ctx, path);
      this._drawNodes(ctx, path);
    }

    this._activeTool?.drawOverlay(ctx);

    ctx.restore();
  }

  _drawGhost(ctx) {
    if (!this._ghostLayer?.path?.coordinates?.length) return;
    const p2d = _buildPath2D(this._ghostLayer.path, this._cc);
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle   = '#66EE88';
    ctx.fill(p2d, 'evenodd');
    ctx.globalAlpha = 1;
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

  _drawComponents(ctx) {
    const layer = this._defaultLayer();
    const components = layer?.components ?? [];
    this._componentPaths = [];

    for (let ci = 0; ci < components.length; ci++) {
      const comp = components[ci];
      const baseLayer = this._componentGlyphs.get(comp.name);
      if (!baseLayer?.path?.coordinates?.length) {
        this._componentPaths.push(null);
        continue;
      }

      const p2d = _buildPath2D(baseLayer.path, this._cc, comp.transformation);
      this._componentPaths.push(p2d);

      const sel = this._selectedComponents.has(ci);
      ctx.globalAlpha = 0.12;
      ctx.fillStyle   = sel ? T.accent : C_COMP_FILL;
      ctx.fill(p2d, "nonzero");
      ctx.globalAlpha = sel ? 0.9 : 0.6;
      ctx.strokeStyle = sel ? T.accent : C_COMP_STK;
      ctx.lineWidth   = 1.5;
      ctx.stroke(p2d);
      ctx.globalAlpha = 1;
    }
  }

  /** Returns component index (0-based) at the given client coords, or -1. */
  _hitTestComponent(clientX, clientY) {
    if (!this._componentPaths.length) return -1;
    const dpr  = window.devicePixelRatio || 1;
    const rect = this._canvas.getBoundingClientRect();
    const px   = (clientX - rect.left) * dpr;
    const py   = (clientY - rect.top)  * dpr;
    const ctx  = this._canvas.getContext('2d');
    // Test from top (last drawn) to bottom so upper components win
    for (let i = this._componentPaths.length - 1; i >= 0; i--) {
      const p2d = this._componentPaths[i];
      if (p2d && ctx.isPointInPath(p2d, px, py)) return i;
    }
    return -1;
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

  _drawBoxSelect(ctx, boxStart, boxEnd) {
    const dpr = window.devicePixelRatio || 1;
    const x0 = Math.min(boxStart.x, boxEnd.x) * dpr;
    const y0 = Math.min(boxStart.y, boxEnd.y) * dpr;
    const w  = Math.abs(boxEnd.x - boxStart.x) * dpr;
    const h  = Math.abs(boxEnd.y - boxStart.y) * dpr;

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
  // Edit + undo

  /**
   * Build an undo record for a completed drag and push it to the stack.
   * Checks ALL points (selected + constraint-moved handles) for changes.
   */
  _recordDragUndo(origCoords) {
    const layer = this._defaultLayer();
    const coords = layer?.path?.coordinates;
    if (!coords || !origCoords) return;

    const fwdChanges = [];
    const rbkChanges = [];
    // Check all points — smooth constraints may have moved unselected handles
    for (let idx = 0; idx < origCoords.length / 2; idx++) {
      const x  = coords[idx * 2],     y  = coords[idx * 2 + 1];
      const ox = origCoords[idx * 2], oy = origCoords[idx * 2 + 1];
      if (x !== ox || y !== oy) {
        fwdChanges.push({ f: "=xy", a: [idx, x,  y ] });
        rbkChanges.unshift({ f: "=xy", a: [idx, ox, oy] });
      }
    }
    if (!fwdChanges.length) return;

    this._pushEdit(fwdChanges, rbkChanges, layer.path, "move points");
    this._dirty = true;
  }

  /**
   * Push an edit to the undo stack and send to backend.
   * fwdChanges/rbkChanges: arrays of change objects (no path prefix).
   * path: the VarPackedPath the changes were applied to (for local undo).
   */
  _pushEdit(fwdChanges, rbkChanges, path, label) {
    const localFwd = { c: fwdChanges };
    const localRbk = { c: rbkChanges };

    const layerName = this._glyph?.layerNameForMaster(this._masterId) ?? null;
    if (layerName) {
      const prefix = ["glyphs", this._glyphName, "layers", layerName, "glyph", "path"];
      const fwd = consolidateChanges(fwdChanges, prefix);
      const rbk = consolidateChanges(rbkChanges, prefix);
      this._fc.editFinal(fwd, rbk, label).catch(console.error);
      this._undoStack.push({ localFwd, localRbk, change: fwd, rollbackChange: rbk, label });
    } else {
      this._undoStack.push({ localFwd, localRbk, label });
    }
  }

  /** Undo the last edit. */
  _doUndo() {
    const record = this._undoStack.popUndo();
    if (!record) return;
    const layer = this._defaultLayer();
    if (!layer?.path) return;
    applyChange(layer.path, record.localRbk);
    layer.path.invalidate();
    this._cc.scheduleRedraw();
    if (record.rollbackChange && hasChange(record.rollbackChange)) {
      this._fc.editFinal(record.rollbackChange, record.change, `undo: ${record.label}`).catch(console.error);
    }
  }

  /** Redo the last undone edit. */
  _doRedo() {
    const record = this._undoStack.popRedo();
    if (!record) return;
    const layer = this._defaultLayer();
    if (!layer?.path) return;
    applyChange(layer.path, record.localFwd);
    layer.path.invalidate();
    this._cc.scheduleRedraw();
    if (record.change && hasChange(record.change)) {
      this._fc.editFinal(record.change, record.rollbackChange, `redo: ${record.label}`).catch(console.error);
    }
  }

  // -------------------------------------------------------------------------

  _defaultLayer() {
    return this._glyph?.layerForMaster(this._masterId) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Path2D builder — converts scene (font) coordinates to canvas coordinates

// ---------------------------------------------------------------------------
// PenTool helpers

function _lastOnCurve(pts) {
  for (let i = pts.length - 1; i >= 0; i--) {
    if ((pts[i].type & 0x03) === 0) return pts[i];
  }
  return null;
}

/**
 * Build a Path2D for the in-progress PenTool contour.
 * display: array of {x, y, type} in scene space.
 * cvPts:   matching array of {x, y} in canvas physical px.
 */
function _buildInProgressPath2D(display, cvPts) {
  const p2d = new Path2D();
  // Find first on-curve
  let start = display.findIndex(p => (p.type & 0x03) === 0);
  if (start < 0) return p2d;

  p2d.moveTo(cvPts[start].x, cvPts[start].y);
  let i = start + 1;
  while (i < display.length) {
    const t = display[i].type & 0x0f;
    if (t === 2) {
      // Cubic: collect two off-curves then on-curve
      const c1 = cvPts[i];
      const c2 = cvPts[i + 1];
      const ep = cvPts[i + 2];
      if (c2 && ep) {
        p2d.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, ep.x, ep.y);
        i += 3;
      } else { i++; }
    } else if (t === 1) {
      // Quad
      const cp = cvPts[i], ep = cvPts[i + 1];
      if (ep) { p2d.quadraticCurveTo(cp.x, cp.y, ep.x, ep.y); i += 2; }
      else { i++; }
    } else {
      p2d.lineTo(cvPts[i].x, cvPts[i].y);
      i++;
    }
  }
  return p2d;
}

// ---------------------------------------------------------------------------
// Path2D builder — scene (font) coordinates → canvas coordinates

/**
 * @param {object} [xform]  — optional {xx,xy,yx,yy,dx,dy} component transform
 */
function _buildPath2D(packed, cc, xform) {
  const p2d    = new Path2D();
  const coords   = packed.coordinates ?? [];
  const types    = packed.pointTypes  ?? [];
  const contours = packed.contourInfo ?? [];

  let ci = 0;
  for (const { endPoint, isClosed } of contours) {
    const pts = [];
    for (let i = ci; i <= endPoint; i++) {
      let fx = coords[i * 2], fy = coords[i * 2 + 1];
      if (xform) {
        // fontTools affine convention: x' = xx*x + yx*y + dx
        const tx = xform.xx * fx + xform.yx * fy + xform.dx;
        const ty = xform.xy * fx + xform.yy * fy + xform.dy;
        fx = tx; fy = ty;
      }
      const { x: cx, y: cy } = cc.sceneToCanvas(fx, fy);
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
