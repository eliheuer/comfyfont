/**
 * glyph-grid.js — Font overview: scrollable bento-box glyph grid.
 *
 * Three-column layout:
 *   [category sidebar] | [scrollable glyph grid] | [glyph info panel]
 *
 * Visual design follows Runebender-Xilem (see context/glyph-grid-plan.md).
 * Each cell uses an inline SVG with viewBox for correct, resolution-independent
 * scaling at any cell width — required for the span-aware bento layout.
 */

import { GF_SETS, coverage, getSetCodepoints } from './gf-character-sets.js';

// ---------------------------------------------------------------------------
// Theme — from Runebender theme.rs

const T = {
  bg:              '#101010',
  panel:           '#1c1c1c',
  cellOutline:     '#606060',
  cellSelected:    '#66ee88',
  glyphFill:       '#a0a0a0',
  glyphSelected:   '#66ee88',
  labelText:       '#808080',
  labelUnicode:    '#505050',
  labelSelected:   '#66ee88',
  sidebarText:     '#808080',
  headerText:      '#404040',
  accent:          '#66ee88',
};

// ---------------------------------------------------------------------------
// Layout constants — from Runebender + CLAUDE.md spec

const GAP       = 6;    // px between all cells (BENTO_GAP)
const CELL_W    = 128;  // base cell width (1-column)
const CELL_H    = 192;  // cell height
const LABEL_H   = 52;   // label zone at bottom of cell (CELL_LABEL_HEIGHT ≈ 56)
const PANEL_R   = 8;    // border-radius (PANEL_RADIUS)
const SIDEBAR_W = 168;  // category sidebar width
const INFO_W    = 168;  // glyph info panel width

const CATEGORIES = ['All', 'Letter', 'Number', 'Punctuation', 'Symbol', 'Mark', 'Separator', 'Other'];

// Mark color palette — from Runebender theme.rs
const MARK_COLORS = [
  { hex: '#FF5533', rgba: '1,0.333,0.2,1',       label: 'red'    },
  { hex: '#FF9911', rgba: '1,0.6,0.067,1',        label: 'orange' },
  { hex: '#CCDD00', rgba: '0.8,0.867,0,1',        label: 'yellow' },
  { hex: '#44DD44', rgba: '0.267,0.867,0.267,1',  label: 'green'  },
  { hex: '#00CCBB', rgba: '0,0.8,0.733,1',        label: 'teal'   },
  { hex: '#9944CC', rgba: '0.6,0.267,0.8,1',      label: 'purple' },
  { hex: '#CC44AA', rgba: '0.8,0.267,0.667,1',    label: 'pink'   },
];

// ---------------------------------------------------------------------------
// CSS

const CSS = `
.cf-grid-root {
  display: flex;
  flex-direction: row;
  height: 100%;
  overflow: hidden;
  background: ${T.bg};
  color: #ccc;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 12px;
  gap: ${GAP}px;
  padding: ${GAP * 2}px;
  box-sizing: border-box;
}

/* ---- Sidebar ---- */
.cf-sidebar {
  width: ${SIDEBAR_W}px;
  min-width: ${SIDEBAR_W}px;
  display: flex;
  flex-direction: column;
  gap: ${GAP}px;
}
.cf-sidebar-box {
  background: ${T.panel};
  border-radius: ${PANEL_R}px;
  border: 1.5px solid #2a2a2a;
  padding: 10px 0;
  overflow: hidden;
}
.cf-sidebar-header {
  font-size: 12px;
  color: ${T.headerText};
  padding: 0 12px 6px;
}
.cf-cat-item {
  display: block;
  padding: 6px 12px;
  cursor: pointer;
  color: ${T.sidebarText};
  font-size: 12px;
  user-select: none;
  transition: color 0.1s;
}
.cf-cat-item:hover { color: #bbb; }
.cf-cat-item.active {
  color: ${T.accent};
  box-shadow: inset 2px 0 0 ${T.accent};
}

/* ---- Grid area ---- */
.cf-grid-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  min-width: 0;
}
.cf-grid-scroll::-webkit-scrollbar { width: 6px; }
.cf-grid-scroll::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 3px; }
.cf-grid-rows {
  display: flex;
  flex-direction: column;
  gap: ${GAP}px;
}
.cf-grid-row {
  display: flex;
  flex-direction: row;
  gap: ${GAP}px;
  align-items: stretch;
}
.cf-grid-empty {
  color: #444;
  padding: 40px 20px;
  font-size: 12px;
}

/* ---- Cell ---- */
.cf-cell {
  height: ${CELL_H}px;
  background: ${T.panel};
  border-radius: ${PANEL_R}px;
  border: 1.5px solid var(--cell-border, ${T.cellOutline});
  cursor: pointer;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-width: 0;
  transition: border-color 0.1s;
  box-sizing: border-box;
}
/* Hover: use mark color when set, else #888 */
.cf-cell:hover { border-color: var(--cell-border, #888); }
.cf-cell.selected { border-color: ${T.cellSelected}; }

.cf-cell-preview {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.cf-cell-preview svg {
  width: 100%;
  height: 100%;
  display: block;
}
.cf-cell-preview svg path {
  fill: var(--cell-fill, ${T.glyphFill});
}
.cf-cell.selected .cf-cell-preview svg path { fill: ${T.glyphSelected}; }

.cf-cell-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #2e2e2e;
  font-size: 12px;
}

.cf-cell-labels {
  height: ${LABEL_H}px;
  padding: 0 9px 9px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 2px;
  flex-shrink: 0;
}
.cf-cell-name {
  font-size: 12px;
  color: ${T.labelText};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}
.cf-cell-unicode {
  font-size: 12px;
  color: ${T.labelUnicode};
  white-space: nowrap;
  line-height: 1.3;
}
.cf-cell.selected .cf-cell-name    { color: ${T.labelSelected}; }
.cf-cell.selected .cf-cell-unicode { color: ${T.labelSelected}; opacity: 0.65; }

/* ---- Info panel ---- */
.cf-info-panel {
  width: ${INFO_W}px;
  min-width: ${INFO_W}px;
  display: flex;
  flex-direction: column;
  gap: ${GAP}px;
}
.cf-info-box {
  background: ${T.panel};
  border-radius: ${PANEL_R}px;
  border: 1.5px solid #2a2a2a;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.cf-info-row { display: flex; flex-direction: column; gap: 3px; }
.cf-info-label {
  font-size: 12px;
  color: ${T.headerText};
}
.cf-info-value { font-size: 12px; color: #bbb; }
.cf-info-hint  { color: #444; font-size: 12px; padding: 4px 0; }

/* ---- Color swatches ---- */
.cf-colors-row {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px 2px;
  flex-wrap: wrap;
}
.cf-color-clear {
  width: 22px; height: 22px;
  border-radius: 4px;
  border: 1.5px solid #444;
  background: none;
  cursor: pointer;
  appearance: none;
  display: flex; align-items: center; justify-content: center;
  color: #555; font-size: 12px; line-height: 1;
  flex-shrink: 0; padding: 0;
  transition: border-color 0.1s, color 0.1s;
}
.cf-color-clear:hover { border-color: #888; color: #aaa; }
.cf-color-clear.active { border-color: ${T.accent}; color: ${T.accent}; }
.cf-color-swatch {
  width: 22px; height: 22px;
  border-radius: 4px;
  border: 2px solid transparent;
  cursor: pointer;
  appearance: none;
  flex-shrink: 0;
  transition: transform 0.1s, border-color 0.1s;
}
.cf-color-swatch:hover { transform: scale(1.15); }
.cf-color-swatch.active { border-color: ${T.accent}; }

/* ---- GF character sets ---- */
.cf-gfset-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 5px 12px;
  cursor: pointer;
  user-select: none;
  transition: background 0.1s;
  border-left: 2px solid transparent;
}
.cf-gfset-item:hover { background: #242424; }
.cf-gfset-item.active {
  border-left-color: ${T.accent};
  background: #1f2a21;
}
.cf-gfset-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px;
}
.cf-gfset-name {
  font-size: 12px;
  color: ${T.sidebarText};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}
.cf-gfset-item.active .cf-gfset-name { color: ${T.accent}; }
.cf-gfset-count {
  font-size: 12px;
  color: #555;
  white-space: nowrap;
  flex-shrink: 0;
}
.cf-gfset-item.active .cf-gfset-count { color: ${T.accent}; opacity: 0.7; }
.cf-gfset-bar {
  height: 3px;
  border-radius: 2px;
  background: #2a2a2a;
  overflow: hidden;
}
.cf-gfset-bar-fill {
  height: 100%;
  border-radius: 2px;
  background: #445;
  transition: width 0.3s;
}
.cf-gfset-item.active .cf-gfset-bar-fill { background: ${T.accent}; opacity: 0.6; }
.cf-gfset-loading {
  font-size: 12px;
  color: #444;
  padding: 6px 12px;
  font-style: italic;
}

/* Ghost cells for missing glyphs */
.cf-cell.ghost {
  border-style: dashed;
  border-color: #383838;
  opacity: 0.6;
  cursor: default;
}
.cf-cell.ghost:hover { border-color: #555; opacity: 0.8; }
.cf-ghost-label {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 6px;
  color: #444;
}
.cf-ghost-char { font-size: 48px; line-height: 1; color: #333; }
.cf-ghost-cp   { font-size: 12px; }
.cf-ghost-add {
  margin-top: 4px;
  background: none;
  border: 1px solid #333;
  border-radius: 4px;
  color: #555;
  font-size: 16px;
  width: 28px; height: 28px;
  cursor: pointer;
  appearance: none;
  display: flex; align-items: center; justify-content: center;
  transition: border-color 0.1s, color 0.1s;
}
.cf-ghost-add:hover { border-color: ${T.accent}; color: ${T.accent}; }
`;



// Convert a UFO normalized RGBA string "R,G,B,A" (0–1 each) to a CSS hex color.
function markColorToHex(rgba) {
  if (!rgba) return null;
  const parts = rgba.split(',').map(Number);
  if (parts.length < 3 || parts.some(isNaN)) return null;
  const h = v => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${h(parts[0])}${h(parts[1])}${h(parts[2])}`;
}

function injectCSS() {
  if (document.getElementById('cf-gg-css')) return;
  const s = document.createElement('style');
  s.id = 'cf-gg-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ---------------------------------------------------------------------------
// Unicode general category detection

function unicodeCategory(codepoint) {
  if (codepoint == null) return 'Other';
  const ch = String.fromCodePoint(codepoint);
  if (/^\p{L}$/u.test(ch)) return 'Letter';
  if (/^\p{N}$/u.test(ch)) return 'Number';
  if (/^\p{P}$/u.test(ch)) return 'Punctuation';
  if (/^\p{S}$/u.test(ch)) return 'Symbol';
  if (/^\p{M}$/u.test(ch)) return 'Mark';
  if (/^\p{Z}$/u.test(ch)) return 'Separator';
  return 'Other';
}

// ---------------------------------------------------------------------------
// Column span — from Runebender compute_col_span (name length only for now)

function computeColSpan(_name) {
  return 1;
}

// ---------------------------------------------------------------------------
// Row packing — from Runebender pack_rows
// Last cell in each row expands to fill (no ragged right edge).

function packRows(glyphs, columns) {
  const rows = [];
  let row = [], used = 0;

  for (const g of glyphs) {
    const span = Math.min(g.span, columns);
    if (used + span > columns && row.length > 0) {
      row[row.length - 1].span += columns - used;
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push({ glyph: g, span });
    used += span;
  }
  if (row.length > 0) {
    row[row.length - 1].span += columns - used;
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Build SVG path d-string from a PackedPath (same logic as Path2D version)

const _OFF_CUBIC = 0x02;
const _OFF_QUAD  = 0x01;

function packedPathToSVGD(packed) {
  const coords   = packed.coordinates ?? [];
  const types    = packed.pointTypes  ?? [];
  const contours = packed.contourInfo ?? [];

  let d = '';
  let ci = 0;

  for (const { endPoint, isClosed } of contours) {
    const pts = [];
    for (let i = ci; i <= endPoint; i++) {
      pts.push({ x: coords[i * 2], y: coords[i * 2 + 1], t: types[i] & 0x0f });
    }

    let startIdx = pts.findIndex(p => p.t !== _OFF_CUBIC && p.t !== _OFF_QUAD);
    if (startIdx === -1) startIdx = 0;
    const n  = pts.length;
    const at = i => pts[(startIdx + i) % n];

    d += `M ${at(0).x},${at(0).y}`;

    let i = 1;
    while (i < n) {
      const cur = at(i);
      if (cur.t === _OFF_CUBIC) {
        const c2 = at(i + 1), ep = at(i + 2);
        d += ` C ${cur.x},${cur.y} ${c2.x},${c2.y} ${ep.x},${ep.y}`;
        i += 3;
      } else if (cur.t === _OFF_QUAD) {
        const offs = [cur];
        let j = i + 1;
        while (j < n && at(j).t === _OFF_QUAD) offs.push(at(j++));
        const on = at(j);
        for (let k = 0; k < offs.length; k++) {
          const cp = offs[k];
          const ep = k + 1 < offs.length
            ? { x: (cp.x + offs[k + 1].x) / 2, y: (cp.y + offs[k + 1].y) / 2 }
            : on;
          d += ` Q ${cp.x},${cp.y} ${ep.x},${ep.y}`;
        }
        i = j + 1;
      } else {
        d += ` L ${cur.x},${cur.y}`;
        i++;
      }
    }
    if (isClosed) d += ' Z';
    ci = endPoint + 1;
  }
  return d;
}

// ---------------------------------------------------------------------------
// GlyphGrid

export class GlyphGrid {
  /**
   * @param {HTMLElement}  container
   * @param {FontController} fontController
   * @param {function}     onGlyphOpen   — called with glyphName on double-click
   * @param {string|null}  masterId      — active FontSource identifier
   */
  constructor(container, fontController, onGlyphOpen, masterId = null) {
    injectCSS();
    this._fc        = fontController;
    this._onOpen    = onGlyphOpen;
    this._masterId  = masterId;
    this._selected    = null;
    this._category    = 'All';
    this._colorFilter = null;   // null = all; hex string = filter to that color
    this._markColors  = new Map();  // glyphName → hex string | null
    this._gfSetFilter = null;   // null = off; string = active GF set name
    this._gfMissing   = false;  // true = show missing-only ghost view
    this._glyphMap  = {};
    this._upm       = 1000;
    this._ascender  = 800;
    this._descender = -200;
    this._cellEls   = new Map();   // glyphName → cell element
    this._loaded    = new Set();   // glyphs whose SVG has been fetched

    this._buildDOM(container);

    this._observer = new IntersectionObserver(
      entries => entries.forEach(e => { if (e.isIntersecting) this._loadCellSVG(e.target); }),
      { root: this._scrollEl, rootMargin: '400px' }
    );

    this._lastCols = 0;
    this._resizeObserver = new ResizeObserver(() => {
      // Only reflow when the number of columns actually changes — prevents
      // layout loops where content height changes trigger spurious resize events.
      if (!this._reflowPending) {
        this._reflowPending = true;
        requestAnimationFrame(() => {
          this._reflowPending = false;
          const cols = this._columns();
          if (cols !== this._lastCols) this._reflow();
        });
      }
    });
    this._resizeObserver.observe(this._scrollEl);
  }

  // -------------------------------------------------------------------------
  // DOM construction

  _buildDOM(container) {
    const root = document.createElement('div');
    root.className = 'cf-grid-root';

    // Left: category sidebar
    this._sidebarEl = this._buildSidebar();
    root.appendChild(this._sidebarEl);

    // Centre: scrollable grid
    this._scrollEl = document.createElement('div');
    this._scrollEl.className = 'cf-grid-scroll';
    this._rowsEl = document.createElement('div');
    this._rowsEl.className = 'cf-grid-rows';
    this._scrollEl.appendChild(this._rowsEl);
    root.appendChild(this._scrollEl);

    // Right: glyph info panel
    this._infoEl = this._buildInfoPanel();
    root.appendChild(this._infoEl);

    container.appendChild(root);
    this._root = root;
  }

  _buildSidebar() {
    const sidebar = document.createElement('div');
    sidebar.className = 'cf-sidebar';

    const box = document.createElement('div');
    box.className = 'cf-sidebar-box';

    const hdr = document.createElement('div');
    hdr.className = 'cf-sidebar-header';
    hdr.textContent = 'Categories';
    box.appendChild(hdr);

    for (const cat of CATEGORIES) {
      const item = document.createElement('div');
      item.className = 'cf-cat-item' + (cat === this._category ? ' active' : '');
      item.textContent = cat;
      item.dataset.cat = cat;
      item.onclick = () => this._setCategory(cat);
      box.appendChild(item);
    }
    this._catBoxEl = box;
    sidebar.appendChild(box);

    // Colors section
    sidebar.appendChild(this._buildColorsBox());

    // GF Character Sets section
    sidebar.appendChild(this._buildGFSetsBox());

    return sidebar;
  }

  _buildColorsBox() {
    const box = document.createElement('div');
    box.className = 'cf-sidebar-box';

    const hdr = document.createElement('div');
    hdr.className = 'cf-sidebar-header';
    hdr.textContent = 'Colors';
    box.appendChild(hdr);

    const row = document.createElement('div');
    row.className = 'cf-colors-row';

    // X — clear
    const clearBtn = document.createElement('button');
    clearBtn.className = 'cf-color-clear';
    clearBtn.textContent = '✕';
    clearBtn.title = 'Clear color filter / clear color on selected glyph';
    clearBtn.onclick = () => this._onColorSwatch(null);
    this._colorClearBtn = clearBtn;
    row.appendChild(clearBtn);

    // Swatches
    this._swatchEls = [];
    for (const { hex, rgba, label } of MARK_COLORS) {
      const sw = document.createElement('button');
      sw.className = 'cf-color-swatch';
      sw.style.background = hex;
      sw.title = label;
      sw.dataset.rgba = rgba;
      sw.dataset.hex = hex;
      sw.onclick = () => this._onColorSwatch(rgba, hex);
      this._swatchEls.push(sw);
      row.appendChild(sw);
    }

    box.appendChild(row);
    this._colorsBoxEl = box;
    return box;
  }

  _buildGFSetsBox() {
    const box = document.createElement('div');
    box.className = 'cf-sidebar-box';

    const hdr = document.createElement('div');
    hdr.className = 'cf-sidebar-header';
    hdr.textContent = 'GF Character Sets';
    box.appendChild(hdr);

    this._gfSetsBoxEl = box;
    this._gfSetsLoadingEl = null;
    // Data is bundled — render after glyphMap is available (called from load())
    return box;
  }

  _renderGFSets() {
    const box = this._gfSetsBoxEl;
    if (!box || !Object.keys(this._glyphMap).length) return;

    // Remove any previously rendered rows
    for (const el of box.querySelectorAll('.cf-gfset-item')) el.remove();

    for (const { name } of GF_SETS) {
      const cov = coverage(name, this._glyphMap);
      if (cov.total === 0) continue;  // set didn't load

      const item = document.createElement('div');
      item.className = 'cf-gfset-item' + (this._gfSetFilter === name ? ' active' : '');
      item.dataset.setName = name;

      const top = document.createElement('div');
      top.className = 'cf-gfset-top';

      const nameEl = document.createElement('div');
      nameEl.className = 'cf-gfset-name';
      nameEl.textContent = name;

      const countEl = document.createElement('div');
      countEl.className = 'cf-gfset-count';
      countEl.textContent = `${cov.have}/${cov.total}`;

      top.appendChild(nameEl);
      top.appendChild(countEl);

      const bar = document.createElement('div');
      bar.className = 'cf-gfset-bar';
      const fill = document.createElement('div');
      fill.className = 'cf-gfset-bar-fill';
      fill.style.width = `${Math.round((cov.have / cov.total) * 100)}%`;
      bar.appendChild(fill);

      item.appendChild(top);
      item.appendChild(bar);

      item.onclick = () => this._onGFSetClick(name);
      box.appendChild(item);
    }
  }

  _buildInfoPanel() {
    const panel = document.createElement('div');
    panel.className = 'cf-info-panel';
    const box = document.createElement('div');
    box.className = 'cf-info-box';
    this._infoBoxEl = box;
    this._renderInfoPanel(null, null);
    panel.appendChild(box);
    return panel;
  }

  _renderInfoPanel(glyphName, layer) {
    const box = this._infoBoxEl;
    box.innerHTML = '';

    if (!glyphName) {
      const hint = document.createElement('div');
      hint.className = 'cf-info-hint';
      hint.textContent = 'Select a glyph';
      box.appendChild(hint);
      return;
    }

    const unicodes = this._glyphMap[glyphName] ?? [];
    const unicodeStr = unicodes.length
      ? unicodes.map(u => `U+${u.toString(16).toUpperCase().padStart(4, '0')}`).join(', ')
      : '—';

    const rows = [
      ['Glyph Name', glyphName],
      ['Unicode',    unicodeStr],
      ['Width',      layer?.xAdvance != null ? String(Math.round(layer.xAdvance)) : '—'],
      ['Contours',   layer?.path?.contourInfo?.length != null
                       ? String(layer.path.contourInfo.length) : '—'],
    ];

    for (const [label, value] of rows) {
      const row = document.createElement('div');
      row.className = 'cf-info-row';
      row.innerHTML =
        `<div class="cf-info-label">${label}</div>` +
        `<div class="cf-info-value">${value}</div>`;
      box.appendChild(row);
    }
  }

  // -------------------------------------------------------------------------
  // Public API

  async load() {
    try {
      const [glyphMap, fontInfo, markColors] = await Promise.all([
        this._fc.getGlyphMap(),
        this._fc.getFontInfo(),
        this._fc.getMarkColors().catch(() => ({})),
      ]);
      this._glyphMap  = glyphMap;
      this._upm       = fontInfo?.unitsPerEm  ?? 1000;
      this._ascender  = fontInfo?.ascender    ?? Math.round(this._upm * 0.8);
      this._descender = fontInfo?.descender   ?? Math.round(this._upm * -0.2);
      for (const [name, rgba] of Object.entries(markColors)) {
        this._markColors.set(name, markColorToHex(rgba));
      }
    } catch (err) {
      this._rowsEl.innerHTML =
        `<div class="cf-grid-empty">Could not load font: ${err.message}</div>`;
      return;
    }
    this._reflow();
    // Re-render GF set coverage now that we have the glyph map
    // (loadGFSets may already be done, or will call _renderGFSets when it finishes)
    this._renderGFSets();
  }

  setMaster(masterId) {
    this._masterId = masterId;
    // Re-fetch SVGs for already-loaded cells under the new master
    for (const name of this._loaded) {
      const cell = this._cellEls.get(name);
      if (cell) this._loadCellSVG(cell);
    }
  }

  onActivated() {}

  destroy() {
    this._observer.disconnect();
    this._resizeObserver.disconnect();
  }

  // -------------------------------------------------------------------------
  // Layout

  _columns() {
    const w = this._scrollEl.clientWidth || (window.innerWidth - SIDEBAR_W - INFO_W - GAP * 6);
    return Math.max(1, Math.floor(w / (CELL_W + GAP)));
  }

  _cellUnit() {
    const w = this._scrollEl.clientWidth || (window.innerWidth - SIDEBAR_W - INFO_W - GAP * 6);
    const cols = this._columns();
    return (w - (cols - 1) * GAP) / cols;
  }

  _cellPx(span) {
    return this._cellUnit() * span + (span - 1) * GAP;
  }

  _filteredGlyphs() {
    // When showing missing GF glyphs, return ghost placeholders instead
    if (this._gfSetFilter && this._gfMissing) {
      const cov = coverage(this._gfSetFilter, this._glyphMap);
      return cov.missing.map(cp => ({
        name: null,
        codepoint: cp,
        unicodes: [cp],
        span: 1,
        ghost: true,
      }));
    }

    const setPoints = this._gfSetFilter
      ? new Set(getSetCodepoints(this._gfSetFilter))
      : null;

    return Object.entries(this._glyphMap)
      .filter(([name, unicodes]) => {
        if (this._colorFilter && this._markColors.get(name) !== this._colorFilter) return false;
        if (setPoints && !unicodes.some(u => setPoints.has(u))) return false;
        if (this._category === 'All') return true;
        if (!unicodes.length) return this._category === 'Other';
        return unicodeCategory(unicodes[0]) === this._category;
      })
      .map(([name, unicodes]) => ({ name, unicodes, span: computeColSpan(name) }));
  }

  _reflow() {
    if (!Object.keys(this._glyphMap).length) return;

    this._observer.disconnect();
    this._cellEls.clear();
    this._loaded.clear();
    this._rowsEl.innerHTML = '';

    const cols   = this._columns();
    const glyphs = this._filteredGlyphs();

    if (!glyphs.length) {
      const msg = (this._gfSetFilter && this._gfMissing)
        ? `Complete coverage for ${this._gfSetFilter}.`
        : 'No glyphs in this category.';
      this._rowsEl.innerHTML = `<div class="cf-grid-empty">${msg}</div>`;
      return;
    }

    this._lastCols = cols;
    const rows = packRows(glyphs, cols);

    for (const row of rows) {
      const rowEl = document.createElement('div');
      rowEl.className = 'cf-grid-row';
      for (const { glyph, span } of row) {
        let cell;
        if (glyph.ghost) {
          cell = this._makeGhostCell(glyph, span);
        } else {
          cell = this._makeCell(glyph, span);
          this._cellEls.set(glyph.name, cell);
          this._observer.observe(cell);
        }
        rowEl.appendChild(cell);
      }
      this._rowsEl.appendChild(rowEl);
    }
  }

  _makeCell(glyph, span) {
    const cell = document.createElement('div');
    cell.className = 'cf-cell';
    cell.dataset.glyph = glyph.name;
    cell.style.width = this._cellPx(span) + 'px';

    // Apply cached mark color immediately (before SVG loads)
    const markHex = this._markColors.get(glyph.name);
    if (markHex) {
      cell.style.setProperty('--cell-border', markHex);
      cell.style.setProperty('--cell-fill', markHex);
    }

    // Preview area — SVG inserted lazily
    const preview = document.createElement('div');
    preview.className = 'cf-cell-preview';
    cell.appendChild(preview);

    // Label area
    const labels = document.createElement('div');
    labels.className = 'cf-cell-labels';

    const nameEl = document.createElement('div');
    nameEl.className = 'cf-cell-name';
    nameEl.textContent = glyph.name;

    const uniEl = document.createElement('div');
    uniEl.className = 'cf-cell-unicode';
    uniEl.textContent = glyph.unicodes.length
      ? `U+${glyph.unicodes[0].toString(16).toUpperCase().padStart(4, '0')}`
      : '';

    labels.appendChild(nameEl);
    labels.appendChild(uniEl);
    cell.appendChild(labels);

    cell.addEventListener('click',    () => this._selectCell(glyph.name, cell));
    cell.addEventListener('dblclick', () => this._onOpen(glyph.name));

    return cell;
  }

  _makeGhostCell(glyph, span) {
    const cell = document.createElement('div');
    cell.className = 'cf-cell ghost';
    cell.style.width = this._cellPx(span) + 'px';

    const cp = glyph.codepoint;
    const cpStr = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    let charDisplay = '';
    try { charDisplay = String.fromCodePoint(cp); } catch {}

    const inner = document.createElement('div');
    inner.className = 'cf-ghost-label';

    const charEl = document.createElement('div');
    charEl.className = 'cf-ghost-char';
    charEl.textContent = charDisplay;

    const cpEl = document.createElement('div');
    cpEl.className = 'cf-ghost-cp';
    cpEl.textContent = cpStr;

    const addBtn = document.createElement('button');
    addBtn.className = 'cf-ghost-add';
    addBtn.textContent = '+';
    addBtn.title = `Add stub glyph for ${cpStr}`;
    addBtn.onclick = (e) => { e.stopPropagation(); this._createGlyph(cp, cell); };

    inner.appendChild(charEl);
    inner.appendChild(cpEl);
    inner.appendChild(addBtn);
    cell.appendChild(inner);

    return cell;
  }

  // -------------------------------------------------------------------------
  // Lazy SVG rendering

  async _loadCellSVG(cell) {
    this._observer.unobserve(cell);
    const name = cell.dataset.glyph;
    if (!name) return;

    this._loaded.add(name);

    let layer;
    let glyph;
    try {
      glyph = await this._fc.getGlyph(name);
      layer = glyph?.layerForMaster(this._masterId);
    } catch { return; }

    // Update mark color cache and apply CSS custom props
    const markHex = markColorToHex(glyph?.customData?.markColor);
    this._markColors.set(name, markHex ?? null);
    if (markHex) {
      cell.style.setProperty('--cell-border', markHex);
      cell.style.setProperty('--cell-fill', markHex);
    } else {
      cell.style.removeProperty('--cell-border');
      cell.style.removeProperty('--cell-fill');
    }

    const preview = cell.querySelector('.cf-cell-preview');
    if (!preview) return;
    preview.innerHTML = '';

    const path    = layer?.path;
    const advance = layer?.xAdvance ?? this._upm;

    if (!path?.coordinates?.length) {
      const ph = document.createElement('div');
      ph.className = 'cf-cell-placeholder';
      ph.textContent = name;
      preview.appendChild(ph);
      return;
    }

    const d = packedPathToSVGD(path);

    // viewBox in font coordinate space, Y-flip via transform on path.
    // Use 1.2× UPM as the top bound so diacritics (which often exceed the
    // nominal ascender) are never clipped. Keep the actual descender below with
    // a small margin — the label area below the preview already provides visual
    // separation, so we don't need symmetric margins.
    const vbX = 0;
    const vbY = -(this._upm * 1.2);
    const vbW = Math.max(advance, this._upm * 0.05);
    const vbH = this._upm * 1.2 + Math.abs(this._descender) + this._upm * 0.05;

    const NS  = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    const pathEl = document.createElementNS(NS, 'path');
    pathEl.setAttribute('d', d);
    pathEl.setAttribute('transform', 'scale(1,-1)');  // font Y-up → SVG Y-down
    svg.appendChild(pathEl);
    preview.appendChild(svg);

    // Update info panel if this glyph is currently selected
    if (this._selected === name) {
      this._renderInfoPanel(name, layer);
    }
  }

  // -------------------------------------------------------------------------
  // Selection

  _selectCell(name, cell) {
    if (this._selected) {
      this._cellEls.get(this._selected)?.classList.remove('selected');
    }
    this._selected = name;
    cell.classList.add('selected');
    this._renderInfoPanel(name, null);  // immediate with what we have

    // Enrich info panel with glyph data (may already be cached)
    this._fc.getGlyph(name).then(glyph => {
      if (this._selected !== name) return;
      const layer = glyph?.layerForMaster(this._masterId);
      this._renderInfoPanel(name, layer);
    }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Category filter

  _setCategory(cat) {
    this._category = cat;
    for (const el of this._catBoxEl.querySelectorAll('.cf-cat-item')) {
      el.classList.toggle('active', el.dataset.cat === cat);
    }
    this._selected = null;
    this._renderInfoPanel(null, null);
    this._reflow();
  }

  // -------------------------------------------------------------------------
  // Color swatches

  _onColorSwatch(rgba, hex) {
    if (this._selected) {
      // Apply (or clear) mark color on the selected glyph
      this._applyMarkColor(this._selected, rgba ?? null);
    } else {
      // Set / toggle color filter
      const newFilter = (hex && hex !== this._colorFilter) ? hex : null;
      this._colorFilter = newFilter;
      this._updateSwatchActive();
      this._reflow();
    }
  }

  _updateSwatchActive() {
    this._colorClearBtn?.classList.toggle('active', !this._colorFilter);
    for (const sw of this._swatchEls ?? []) {
      sw.classList.toggle('active', sw.dataset.hex === this._colorFilter);
    }
  }

  _onGFSetClick(name) {
    if (this._gfSetFilter === name) {
      // Second click: toggle missing-only view
      if (!this._gfMissing) {
        this._gfMissing = true;
      } else {
        // Third click: clear filter entirely
        this._gfSetFilter = null;
        this._gfMissing   = false;
      }
    } else {
      this._gfSetFilter = name;
      this._gfMissing   = false;
    }

    // Update active state on sidebar rows
    for (const el of this._gfSetsBoxEl?.querySelectorAll('.cf-gfset-item') ?? []) {
      el.classList.toggle('active', el.dataset.setName === this._gfSetFilter);
    }

    this._selected = null;
    this._renderInfoPanel(null, null);
    this._reflow();
  }

  async _createGlyph(codepoint, cell) {
    const addBtn = cell.querySelector('.cf-ghost-add');
    if (addBtn) { addBtn.textContent = '…'; addBtn.disabled = true; }
    try {
      await this._fc.createGlyph(codepoint);
      // Reload glyph map and reflow — the ghost cell becomes a real cell
      this._glyphMap = await this._fc.getGlyphMap();
      this._reflow();
      this._renderGFSets();
    } catch (err) {
      console.error('createGlyph failed:', err);
      if (addBtn) { addBtn.textContent = '+'; addBtn.disabled = false; }
    }
  }

  async _applyMarkColor(glyphName, rgba) {
    try {
      await this._fc.putMarkColor(glyphName, rgba ?? null);
      const hex = rgba ? markColorToHex(rgba) : null;
      this._markColors.set(glyphName, hex);
      const cell = this._cellEls.get(glyphName);
      if (cell) {
        if (hex) {
          cell.style.setProperty('--cell-border', hex);
          cell.style.setProperty('--cell-fill', hex);
        } else {
          cell.style.removeProperty('--cell-border');
          cell.style.removeProperty('--cell-fill');
        }
      }
    } catch (err) {
      console.error('putMarkColor failed:', err);
    }
  }
}
