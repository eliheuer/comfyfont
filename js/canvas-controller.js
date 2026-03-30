/**
 * canvas-controller.js — HiDPI canvas with pan, zoom, and Y-axis flip.
 *
 * Mirrors Fontra's src-js/fontra-core/src/canvas-controller.js.
 *
 * Font coordinates are y-up; canvas coordinates are y-down.
 * We apply a y-flip so all drawing code can use font units directly.
 *
 * Coordinate spaces:
 *   screen  → event.clientX / clientY
 *   canvas  → screen × devicePixelRatio
 *   scene   → font units (after pan + zoom + y-flip)
 */

export class CanvasController {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {function} drawCallback  – called with (this) when a redraw is needed
   */
  constructor(canvas, drawCallback) {
    this.canvas = canvas;
    this._drawCallback = drawCallback;

    this.magnification = 1;
    this.origin = { x: 0, y: 0 }; // canvas-space origin of scene (0, 0)

    this._animFrameId = null;
    this._pointerDown = false;
    this._lastPointer = null;

    this._resizeObserver = new ResizeObserver(() => this._onResize());
    this._resizeObserver.observe(canvas.parentElement ?? canvas);

    canvas.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
    canvas.addEventListener("pointerdown", (e) => this._onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this._onPointerMove(e));
    canvas.addEventListener("pointerup", (e) => this._onPointerUp(e));
    canvas.addEventListener("pointerleave", (e) => this._onPointerUp(e));

    this._onResize();
  }

  // -----------------------------------------------------------------------
  // Coordinate transforms

  /** Convert a canvas-space point to scene (font) coordinates. */
  canvasToScene(x, y) {
    return {
      x: (x - this.origin.x) / this.magnification,
      y: -(y - this.origin.y) / this.magnification,
    };
  }

  /** Convert scene (font) coordinates to canvas space. */
  sceneToCanvas(x, y) {
    return {
      x: x * this.magnification + this.origin.x,
      y: -y * this.magnification + this.origin.y,
    };
  }

  /** Convert a DOM event's clientX/Y to scene coordinates. */
  eventToScene(event) {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cx = (event.clientX - rect.left) * dpr;
    const cy = (event.clientY - rect.top) * dpr;
    return this.canvasToScene(cx, cy);
  }

  // -----------------------------------------------------------------------
  // Drawing

  /**
   * Set up the canvas transform and call the draw callback.
   * The transform: scale by DPR, translate to origin, scale(mag, -mag) for y-flip.
   */
  draw() {
    const canvas = this.canvas;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(this.origin.x / dpr, this.origin.y / dpr);
    // magnification is in physical px/unit; dividing by dpr here means the
    // effective font→physical-pixel scale is (mag/dpr)*dpr = mag, which matches
    // what sceneToCanvas() returns (physical px).
    ctx.scale(this.magnification / dpr, -this.magnification / dpr);

    this._drawCallback(ctx, this);

    ctx.restore();
  }

  scheduleRedraw() {
    if (this._animFrameId !== null) return;
    this._animFrameId = requestAnimationFrame(() => {
      this._animFrameId = null;
      this.draw();
    });
  }

  // -----------------------------------------------------------------------
  // Zoom / pan

  zoomTo(magnification, centerX, centerY) {
    // Zoom around a canvas-space center point
    const cx = centerX ?? this.canvas.width / 2;
    const cy = centerY ?? this.canvas.height / 2;
    const scene = this.canvasToScene(cx, cy);
    this.magnification = Math.max(0.01, Math.min(1000, magnification));
    // Recompute origin so scene point stays under cursor
    this.origin.x = cx - scene.x * this.magnification;
    this.origin.y = cy + scene.y * this.magnification;
    this.scheduleRedraw();
  }

  zoomBy(factor, centerX, centerY) {
    this.zoomTo(this.magnification * factor, centerX, centerY);
  }

  /** Fit a scene-space bounding box into the canvas with padding. */
  zoomFit(xMin, yMin, xMax, yMax, padding = 40) {
    const dpr = window.devicePixelRatio || 1;
    const pw = this.canvas.width;   // physical px
    const ph = this.canvas.height;
    const bw = xMax - xMin;
    const bh = yMax - yMin;
    if (bw === 0 || bh === 0) return;
    const pad = padding * dpr;
    // magnification stored in physical px/unit throughout (consistent with zoomTo/pan/sceneToCanvas)
    const mag = Math.min((pw - pad * 2) / bw, (ph - pad * 2) / bh);
    this.magnification = mag;
    this.origin.x = (pw - bw * mag) / 2 - xMin * mag;  // physical px
    this.origin.y = (ph + bh * mag) / 2 + yMin * mag;  // physical px, y-flip
    this.scheduleRedraw();
  }

  // -----------------------------------------------------------------------
  // Event handlers

  _onResize() {
    const dpr = window.devicePixelRatio || 1;
    const parent = this.canvas.parentElement ?? this.canvas;
    const w = parent.clientWidth || 400;
    const h = parent.clientHeight || 400;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.scheduleRedraw();
  }

  _onWheel(event) {
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cx = (event.clientX - rect.left) * dpr;
    const cy = (event.clientY - rect.top) * dpr;

    if (event.ctrlKey || event.metaKey) {
      // Pinch-zoom or ctrl+wheel → zoom
      const factor = Math.exp(-event.deltaY * 0.01);
      this.zoomBy(factor, cx, cy);
    } else {
      // Pan
      this.origin.x -= event.deltaX * dpr;
      this.origin.y -= event.deltaY * dpr;
      this.scheduleRedraw();
    }
  }

  _onPointerDown(event) {
    if (event.button === 1 || (event.button === 0 && event.altKey)) {
      // Middle-click or alt+drag → pan
      this._pointerDown = true;
      this._lastPointer = { x: event.clientX, y: event.clientY };
      this.canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
  }

  _onPointerMove(event) {
    if (!this._pointerDown) return;
    const dpr = window.devicePixelRatio || 1;
    const dx = (event.clientX - this._lastPointer.x) * dpr;
    const dy = (event.clientY - this._lastPointer.y) * dpr;
    this.origin.x += dx;
    this.origin.y += dy;
    this._lastPointer = { x: event.clientX, y: event.clientY };
    this.scheduleRedraw();
  }

  _onPointerUp(event) {
    this._pointerDown = false;
  }

  destroy() {
    this._resizeObserver.disconnect();
    if (this._animFrameId !== null) cancelAnimationFrame(this._animFrameId);
  }
}
