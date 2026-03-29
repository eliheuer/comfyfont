/**
 * glyph-grid.js — Font overview: a scrollable grid of glyph cells.
 *
 * Shows every glyph in the font with its name below. Double-clicking
 * a cell fires onGlyphOpen(glyphName).
 */

const CELL_SIZE = 80;   // px
const CELL_PAD  = 6;    // inner padding
const LABEL_H   = 18;   // px for name label below glyph

const CSS = `
.cf-grid-wrap {
  flex: 1; overflow-y: auto; overflow-x: hidden;
  background: #1a1a1a; padding: 12px;
}
.cf-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(${CELL_SIZE}px, 1fr));
  gap: 4px;
}
.cf-cell {
  display: flex; flex-direction: column; align-items: center;
  background: #242424; border-radius: 4px;
  cursor: pointer; user-select: none;
  border: 1px solid transparent;
  transition: border-color 0.1s, background 0.1s;
}
.cf-cell:hover { background: #2e2e2e; border-color: #444; }
.cf-cell:active { background: #383838; }
.cf-cell canvas {
  width: ${CELL_SIZE}px; height: ${CELL_SIZE}px;
  display: block;
}
.cf-cell-label {
  font-size: 10px; color: #777;
  padding: 2px 4px 4px;
  max-width: ${CELL_SIZE}px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  text-align: center;
}
.cf-grid-empty {
  color: #555; text-align: center; padding: 48px 0; font-size: 13px;
}
`;

function injectGridCSS() {
  if (document.getElementById("cf-grid-css")) return;
  const s = document.createElement("style");
  s.id = "cf-grid-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

export class GlyphGrid {
  /**
   * @param {HTMLElement} container  — the .cf-pane div
   * @param {object}      fontController
   * @param {function}    onGlyphOpen  — called with glyphName on double-click
   * @param {string}      masterId    — active FontSource identifier (optional)
   */
  constructor(container, fontController, onGlyphOpen, masterId = null) {
    injectGridCSS();
    this._fc = fontController;
    this._onOpen = onGlyphOpen;
    this._masterId = masterId;
    this._glyphMap = null;   // {name: {unicodes:[...]}}
    this._renderedCells = new Map(); // glyphName → cell element

    this._wrap = document.createElement("div");
    this._wrap.className = "cf-grid-wrap";

    this._grid = document.createElement("div");
    this._grid.className = "cf-grid";
    this._wrap.appendChild(this._grid);

    container.appendChild(this._wrap);

    // Intersection Observer for lazy canvas rendering
    this._observer = new IntersectionObserver(
      (entries) => entries.forEach((e) => { if (e.isIntersecting) this._renderCell(e.target); }),
      { root: this._wrap, rootMargin: "200px" }
    );
  }

  async load() {
    this._grid.innerHTML = "";
    this._renderedCells.clear();
    try {
      this._glyphMap = await this._fc.getGlyphMap();
    } catch (err) {
      this._grid.innerHTML = `<div class="cf-grid-empty">Could not load glyph map: ${err.message}</div>`;
      return;
    }

    const names = Object.keys(this._glyphMap).sort();
    if (names.length === 0) {
      this._grid.innerHTML = `<div class="cf-grid-empty">No glyphs in font.</div>`;
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(CELL_SIZE * dpr);

    for (const name of names) {
      const cell = document.createElement("div");
      cell.className = "cf-cell";
      cell.title = name;
      cell.dataset.glyph = name;

      const canvas = document.createElement("canvas");
      canvas.width = px;
      canvas.height = px;

      const label = document.createElement("div");
      label.className = "cf-cell-label";
      // Show unicode character if available, else name
      const info = this._glyphMap[name];
      const ch = info?.unicodes?.[0] != null ? String.fromCodePoint(info.unicodes[0]) : "";
      label.textContent = ch ? `${ch} ${name}` : name;

      cell.appendChild(canvas);
      cell.appendChild(label);

      cell.addEventListener("dblclick", () => this._onOpen(name));

      this._grid.appendChild(cell);
      this._observer.observe(cell);
    }
  }

  /** Switch the active master and re-render all already-loaded cells. */
  setMaster(masterId) {
    this._masterId = masterId;
    for (const [name, cell] of this._renderedCells) {
      this._paintCell(cell, name);
    }
  }

  async _renderCell(cell) {
    this._observer.unobserve(cell);
    const name = cell.dataset.glyph;
    this._renderedCells.set(name, cell);
    await this._paintCell(cell, name);
  }

  async _paintCell(cell, name) {
    const canvas = cell.querySelector("canvas");
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext("2d");
    const pw = canvas.width;
    const ph = canvas.height;

    ctx.clearRect(0, 0, pw, ph);

    let glyph;
    try {
      glyph = await this._fc.getGlyph(name);
    } catch {
      return;
    }

    const layer = glyph?.layerForMaster(this._masterId);
    const path = layer?.path;
    const advance = layer?.xAdvance ?? 1000;

    if (!path?.coordinates?.length) return;

    // Fit within cell with padding
    const pad = Math.round(CELL_PAD * dpr);
    const inner = pw - pad * 2;

    // UPM guess from advance or ascender
    const upm = advance > 0 ? advance : 1000;

    const scale = inner / upm;
    // Center horizontally, flip Y and baseline at 80% height
    const ox = pad + (inner - advance * scale) / 2;
    const oy = ph - pad - Math.round(inner * 0.15);

    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, -scale);

    const p2d = _buildPath2D(path);
    ctx.fillStyle = "#cccccc";
    ctx.fill(p2d, "nonzero");
    ctx.restore();
  }

  onActivated() {
    // No-op — grid is always ready
  }

  destroy() {
    this._observer.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Build a Path2D from a PackedPath object

function _buildPath2D(packed) {
  const p2d = new Path2D();
  const coords = packed.coordinates ?? [];
  const types = packed.pointTypes ?? [];
  const contours = packed.contourInfo ?? [];

  let ci = 0;
  for (const { endPoint, isClosed } of contours) {
    const start = ci;
    const end = endPoint;

    // Collect points for this contour
    const pts = [];
    for (let i = start; i <= end; i++) {
      pts.push({ x: coords[i * 2], y: coords[i * 2 + 1], t: types[i] & 0x0f });
    }

    _drawContour(p2d, pts, isClosed);
    ci = end + 1;
  }

  return p2d;
}

// PointType constants
const ON_CURVE       = 0x00;
const OFF_CURVE_QUAD = 0x01;
const OFF_CURVE_CUBIC = 0x02;

function _drawContour(p2d, pts, isClosed) {
  if (pts.length === 0) return;

  // Find first on-curve point to start
  let startIdx = pts.findIndex((p) => (p.t & 0x0f) !== OFF_CURVE_QUAD && (p.t & 0x0f) !== OFF_CURVE_CUBIC);
  if (startIdx === -1) startIdx = 0;

  const n = pts.length;
  const at = (i) => pts[(startIdx + i) % n];

  p2d.moveTo(at(0).x, at(0).y);

  let i = 1;
  while (i < n) {
    const cur = at(i);
    const type = cur.t & 0x0f;

    if (type === OFF_CURVE_CUBIC) {
      const c1 = cur;
      const c2 = at(i + 1);
      const ep = at(i + 2);
      p2d.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, ep.x, ep.y);
      i += 3;
    } else if (type === OFF_CURVE_QUAD) {
      // Quadratic — may have multiple off-curves (implied on-curves between them)
      const offCurves = [cur];
      let j = i + 1;
      while (j < n && (at(j).t & 0x0f) === OFF_CURVE_QUAD) {
        offCurves.push(at(j));
        j++;
      }
      const onCurve = at(j);
      // Emit each quadratic segment
      for (let k = 0; k < offCurves.length; k++) {
        const cp = offCurves[k];
        let ep;
        if (k + 1 < offCurves.length) {
          // Implied on-curve between two off-curves
          ep = { x: (cp.x + offCurves[k + 1].x) / 2, y: (cp.y + offCurves[k + 1].y) / 2 };
        } else {
          ep = onCurve;
        }
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
