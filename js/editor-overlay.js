/**
 * editor-overlay.js — Full-screen font editor overlay.
 *
 * UI structure (modelled on Glyphs.app / Runebender):
 *
 *  ┌─────────────────────────────────────────────────────┐
 *  │ ComfyFont — FontName          [Save] [✕]           │  header
 *  ├────────────────────────────────────────────────────┤
 *  │ [Font ×]  [A ×]  [g ×]                      [+]   │  tab bar
 *  ├────────────────────────────────────────────────────┤
 *  │                                                    │
 *  │   <active tab content>                             │
 *  │                                                    │
 *  └────────────────────────────────────────────────────┘
 *
 * The "Font" tab is always present and shows the glyph grid.
 * Double-clicking a glyph opens it in a new editor tab.
 */

import { GlyphGrid } from "./glyph-grid.js";
import { GlyphEditorTab } from "./glyph-editor-tab.js";
import { getFontController } from "./font-controller.js";
import { T, GAP, PANEL_R } from "./theme.js";

// ---------------------------------------------------------------------------

let _overlay = null;

export function openEditor(fontName) {
  if (!_overlay) _overlay = new EditorOverlay();
  _overlay.open(fontName);
}


// ---------------------------------------------------------------------------

const CSS = `
#cf-overlay {
  position: fixed; inset: 0; z-index: 9999;
  display: flex; flex-direction: column;
  gap: ${GAP}px; padding: ${GAP}px;
  background: ${T.bg}; color: ${T.glyphFill};
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 13px;
  box-sizing: border-box;
}

/* Header panel */
#cf-header {
  display: flex; align-items: center; gap: 8px;
  padding: 0 14px; height: 44px; min-height: 44px; flex-shrink: 0;
  background: ${T.panel}; border-radius: ${PANEL_R}px; border: 1.5px solid ${T.border};
  user-select: none;
}
#cf-title { flex: 1; font-weight: 600; font-size: 13px; color: ${T.glyphFill}; }
#cf-save-btn {
  background: none; color: ${T.sidebarText}; border: 1px solid ${T.border};
  padding: 3px 14px; border-radius: 12px; cursor: pointer; font-size: 13px;
  white-space: nowrap; font-weight: 500; transition: color 0.1s, border-color 0.1s, background 0.1s;
}
#cf-save-btn:hover { background: #122a18; color: #34c759; border-color: #34c759; }
#cf-save-btn.multi-master:hover { background: #2a2000; color: #c8960c; border-color: #c8960c; }
#cf-close-btn {
  background: none; color: ${T.sidebarText}; border: 1px solid ${T.border};
  border-radius: 50%; width: 24px; height: 24px; min-width: 24px;
  cursor: pointer; padding: 0; font-size: 13px; font-weight: 500;
  display: flex; align-items: center; justify-content: center;
  transition: color 0.1s, border-color 0.1s, background 0.1s;
}
#cf-close-btn:hover { background: #2e1010; color: #c0392b; border-color: #c0392b; }

/* Axis sliders */
#cf-axes {
  display: flex; align-items: center; gap: 12px; flex-shrink: 0;
}
.cf-axis-row {
  display: flex; align-items: center; gap: 6px;
}
.cf-axis-label {
  font-size: 11px; color: ${T.sidebarText}; white-space: nowrap; min-width: 24px;
  text-align: right; font-variant-numeric: tabular-nums;
}
.cf-axis-slider {
  width: 96px; accent-color: ${T.accent}; cursor: pointer;
}
.cf-axis-value {
  font-size: 11px; color: ${T.labelText}; min-width: 28px;
  font-variant-numeric: tabular-nums;
}

/* Master pills */
#cf-masters {
  display: flex; align-items: center; gap: 4px;
}
.cf-master-pill {
  background: none; color: ${T.sidebarText}; border: 1px solid ${T.border};
  padding: 3px 10px; border-radius: 12px; cursor: pointer;
  font-size: 13px; white-space: nowrap; transition: color 0.1s, border-color 0.1s, background 0.1s;
}
.cf-master-pill:hover { background: #0f2012; color: #5a8f60; border-color: #3a6040; }
.cf-master-pill.active { color: ${T.glyphFill}; border-color: #666; }

/* Tab bar: row of individual panels */
#cf-tabs {
  display: flex; align-items: center; gap: ${GAP}px;
  height: 36px; min-height: 36px; flex-shrink: 0;
  overflow-x: auto; overflow-y: hidden;
}
.cf-tab {
  display: flex; align-items: center; gap: 6px;
  padding: 0 14px; height: 100%;
  background: ${T.panel}; border-radius: ${PANEL_R}px; border: 1.5px solid ${T.border};
  cursor: pointer; white-space: nowrap;
  color: ${T.sidebarText}; font-size: 13px;
  box-sizing: border-box;
}
.cf-tab:hover { color: ${T.glyphFill}; border-color: #5a5a5a; }
.cf-tab.active { color: ${T.glyphFill}; border-color: #666; }
.cf-tab-close {
  background: none; border: none; color: #555; font-size: 13px;
  cursor: pointer; padding: 0; line-height: 1; margin-left: 2px;
}
.cf-tab-close:hover { color: #e44; }
#cf-tab-add {
  padding: 0 14px; height: 100%;
  background: ${T.panel}; border-radius: ${PANEL_R}px; border: 1.5px solid ${T.border};
  color: #555; font-size: 13px; cursor: pointer; box-sizing: border-box;
}
#cf-tab-add:hover { color: #aaa; border-color: #5a5a5a; }
#cf-tab-spacer {
  flex: 1;
  height: 100%;
  background: ${T.panel}; border-radius: ${PANEL_R}px; border: 1.5px solid ${T.border};
  box-sizing: border-box;
  min-width: 0;
}

/* Content area */
#cf-content {
  flex: 1; overflow: hidden; position: relative; min-height: 0;
}
.cf-pane {
  position: absolute; inset: 0;
  display: none;
}
.cf-pane.active { display: flex; flex-direction: column; }
/* Font tab pane: let GlyphGrid's 3-column root fill the space */
.cf-pane-font.active { display: flex; flex-direction: row; padding: 0; }
`;

// Return the longest common word-boundary prefix shared by all strings.
// Stops at word boundaries so "Instruments Serif" strips cleanly, not mid-word.
function _commonPrefix(names) {
  if (!names.length) return "";
  let prefix = names[0];
  for (const name of names.slice(1)) {
    while (!name.startsWith(prefix)) {
      // Trim back to last space
      const idx = prefix.lastIndexOf(" ");
      if (idx <= 0) return "";
      prefix = prefix.slice(0, idx);
    }
  }
  return prefix;
}

class EditorOverlay {
  constructor() {
    this._injectCSS();
    this._el = null;
    this._fontController = null;
    this._fontName = null;

    // Tab state
    this._tabs = [];   // [{id, label, closeable, pane, instance}]
    this._activeTabId = null;

    // Master state
    this._sources = {};   // {id: {name, location, ...}}
    this._activeMasterId = null;

    // Axis state
    this._axes          = [];   // [{name, tag, minimum, default, maximum}]
    this._activeLocation = {};  // {axisName: value}

    // Key handler
    this._keyHandler = (e) => {
      if (e.key === "Escape") this.close();
    };
  }

  _injectCSS() {
    if (document.getElementById("cf-overlay-css")) return;
    const style = document.createElement("style");
    style.id = "cf-overlay-css";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // -------------------------------------------------------------------------

  async open(fontName) {
    this._fontName = fontName;

    // Connect font controller
    this._fontController = await getFontController(fontName);

    // Build DOM (or reuse)
    if (!this._el) this._buildDOM();
    document.body.appendChild(this._el);
    document.addEventListener("keydown", this._keyHandler);

    // Update title
    this._el.querySelector("#cf-title").textContent = `ComfyFont — ${fontName}`;

    // Load sources + axes
    try {
      this._sources = await this._fontController.getSources() ?? {};
    } catch {
      this._sources = {};
    }
    const sourceIds = Object.keys(this._sources);
    if (!this._activeMasterId || !this._sources[this._activeMasterId]) {
      this._activeMasterId = sourceIds[0] ?? null;
    }
    try {
      this._axes = await this._fontController.getAxes() ?? [];
    } catch {
      this._axes = [];
    }
    // Initialise location to axis defaults
    this._activeLocation = Object.fromEntries(
      this._axes.map((ax) => [ax.name, ax.default ?? 0])
    );
    this._renderMasterPills();
    this._renderAxisSliders();

    // Ensure Font tab exists and is active
    if (!this._tabs.find((t) => t.id === "__font__")) {
      this._addFontTab();
    }
    this._activate("__font__");
  }

  close() {
    if (this._el?.parentNode) {
      this._el.parentNode.removeChild(this._el);
    }
    document.removeEventListener("keydown", this._keyHandler);
    this._fontController?.disconnect();
    this._fontController = null;
  }

  // -------------------------------------------------------------------------
  // DOM construction

  _buildDOM() {
    const el = document.createElement("div");
    el.id = "cf-overlay";

    // Header
    el.innerHTML = `
      <div id="cf-header">
        <span id="cf-title">ComfyFont</span>
        <div id="cf-axes"></div>
        <div id="cf-masters"></div>
        <button id="cf-save-btn">Save</button>
        <button id="cf-close-btn" title="Close (Esc)">✕</button>
      </div>
      <div id="cf-tabs">
        <button id="cf-tab-add" title="Open glyph…">+</button>
      </div>
      <div id="cf-content"></div>
    `;

    el.querySelector("#cf-close-btn").onclick = () => this.close();
    el.querySelector("#cf-save-btn").onclick = () => this._save();
    el.querySelector("#cf-tab-add").onclick = () => this._promptOpenGlyph();

    this._tabBar    = el.querySelector("#cf-tabs");
    this._content   = el.querySelector("#cf-content");
    this._mastersEl = el.querySelector("#cf-masters");
    this._axesEl    = el.querySelector("#cf-axes");
    this._el = el;
  }

  // -------------------------------------------------------------------------
  // Master pills

  _renderMasterPills() {
    if (!this._mastersEl) return;
    this._mastersEl.innerHTML = "";

    const ids = Object.keys(this._sources);
    const hasMasters = ids.length >= 2;
    this._el?.querySelector("#cf-save-btn")?.classList.toggle("multi-master", hasMasters);
    if (!hasMasters) return;

    // Strip shared family name prefix so pills show just the style part
    // e.g. "Instruments Serif Regular" → "Regular"
    const allNames = ids.map((id) => this._sources[id].name || id);
    const prefix   = _commonPrefix(allNames);

    for (const id of ids) {
      const src      = this._sources[id];
      const fullName = src.name || id;
      const label    = fullName.slice(prefix.length).trim() || fullName;
      const pill = document.createElement("button");
      pill.className = "cf-master-pill" + (id === this._activeMasterId ? " active" : "");
      pill.dataset.masterId = id;
      pill.textContent = label;
      pill.title = fullName;
      pill.onclick = () => this._setMaster(id);
      this._mastersEl.appendChild(pill);
    }
  }

  _setMaster(masterId) {
    this._activeMasterId = masterId;

    for (const pill of this._mastersEl.querySelectorAll(".cf-master-pill")) {
      pill.classList.toggle("active", pill.dataset.masterId === masterId);
    }

    for (const tab of this._tabs) {
      tab.instance?.setMaster?.(masterId);
    }
  }

  // -------------------------------------------------------------------------
  // Axis sliders

  _renderAxisSliders() {
    if (!this._axesEl) return;
    this._axesEl.innerHTML = "";
    if (!this._axes.length) return;

    for (const ax of this._axes) {
      const row = document.createElement("div");
      row.className = "cf-axis-row";

      const label = document.createElement("span");
      label.className = "cf-axis-label";
      label.textContent = ax.tag || ax.name;

      const slider = document.createElement("input");
      slider.type      = "range";
      slider.className = "cf-axis-slider";
      slider.min       = ax.minimum ?? 0;
      slider.max       = ax.maximum ?? 1000;
      slider.step      = 1;
      slider.value     = this._activeLocation[ax.name] ?? ax.default ?? 0;

      const valueEl = document.createElement("span");
      valueEl.className = "cf-axis-value";
      valueEl.textContent = String(Math.round(slider.value));

      slider.addEventListener("input", () => {
        const v = parseFloat(slider.value);
        valueEl.textContent = String(Math.round(v));
        this._setLocation({ ...this._activeLocation, [ax.name]: v });
      });

      row.appendChild(label);
      row.appendChild(slider);
      row.appendChild(valueEl);
      this._axesEl.appendChild(row);
    }
  }

  _setLocation(location) {
    this._activeLocation = location;
    for (const tab of this._tabs) {
      tab.instance?.setLocation?.(location);
    }
  }

  // -------------------------------------------------------------------------
  // Tab management

  _addFontTab() {
    const pane = document.createElement("div");
    pane.className = "cf-pane cf-pane-font";
    this._content.appendChild(pane);

    const grid = new GlyphGrid(pane, this._fontController, (glyphName) => {
      this.openGlyphTab(glyphName);
    }, this._activeMasterId);

    const tab = { id: "__font__", label: "Font", closeable: false, pane, instance: grid };
    this._tabs.unshift(tab);
    this._renderTabBar();
    grid.load();
  }

  openGlyphTab(glyphName) {
    // Reuse existing tab if already open
    const existing = this._tabs.find((t) => t.id === glyphName);
    if (existing) { this._activate(glyphName); return; }

    const pane = document.createElement("div");
    pane.className = "cf-pane";
    this._content.appendChild(pane);

    const editor = new GlyphEditorTab(pane, this._fontController, glyphName, {
      onNavigate: (name) => this.openGlyphTab(name),
      masterId: this._activeMasterId,
    });

    const tab = { id: glyphName, label: glyphName, closeable: true, pane, instance: editor };
    this._tabs.push(tab);
    this._renderTabBar();
    this._activate(glyphName);
    editor.load();
  }

  _closeTab(id) {
    const idx = this._tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const tab = this._tabs[idx];
    tab.instance?.destroy?.();
    tab.pane.remove();
    this._tabs.splice(idx, 1);
    this._renderTabBar();

    // Activate adjacent tab
    if (this._activeTabId === id) {
      const next = this._tabs[Math.min(idx, this._tabs.length - 1)];
      if (next) this._activate(next.id);
    }
  }

  _activate(id) {
    this._activeTabId = id;
    for (const t of this._tabs) {
      const isActive = t.id === id;
      t.pane.classList.toggle("active", isActive);
      const tabEl = this._tabBar.querySelector(`[data-tab="${CSS.escape?.(id) ?? id}"]`);
      tabEl?.classList.toggle("active", isActive);
    }
    // Re-render tab bar to apply active class correctly
    this._renderTabBar();
    // Notify active instance
    const tab = this._tabs.find((t) => t.id === id);
    tab?.instance?.onActivated?.();
  }

  _renderTabBar() {
    // Remove existing tab elements (keep the + button)
    const addBtn = this._tabBar.querySelector("#cf-tab-add");
    this._tabBar.innerHTML = "";

    for (const tab of this._tabs) {
      const el = document.createElement("div");
      el.className = "cf-tab" + (tab.id === this._activeTabId ? " active" : "");
      el.dataset.tab = tab.id;
      el.textContent = tab.label;
      el.onclick = () => this._activate(tab.id);

      if (tab.closeable) {
        const x = document.createElement("button");
        x.className = "cf-tab-close";
        x.textContent = "×";
        x.title = "Close tab";
        x.onclick = (e) => { e.stopPropagation(); this._closeTab(tab.id); };
        el.appendChild(x);
      }

      this._tabBar.appendChild(el);
    }

    this._tabBar.appendChild(addBtn);

    const spacer = document.createElement("div");
    spacer.id = "cf-tab-spacer";
    this._tabBar.appendChild(spacer);
  }

  // -------------------------------------------------------------------------

  _promptOpenGlyph() {
    const name = prompt("Open glyph (name or character):");
    if (name?.trim()) this.openGlyphTab(name.trim());
  }

  async _save() {
    // Trigger a save on all open glyph editor tabs
    for (const tab of this._tabs) {
      await tab.instance?.save?.();
    }
  }
}
