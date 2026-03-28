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
  background: #1a1a1a; color: #ddd;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 13px;
}

/* Header */
#cf-header {
  display: flex; align-items: center; gap: 8px;
  padding: 0 12px; height: 44px; min-height: 44px;
  background: #222; border-bottom: 1px solid #333;
  user-select: none;
}
#cf-title { flex: 1; font-weight: 600; font-size: 14px; color: #eee; }
#cf-save-btn {
  background: #1a6e2e; color: #fff; border: none;
  padding: 4px 14px; border-radius: 5px; cursor: pointer; font-size: 12px;
}
#cf-save-btn:hover { background: #228b3b; }
#cf-close-btn {
  background: none; border: none; color: #888; font-size: 18px;
  cursor: pointer; padding: 0 4px; line-height: 1;
}
#cf-close-btn:hover { color: #fff; }

/* Tab bar */
#cf-tabs {
  display: flex; align-items: center; gap: 0;
  height: 36px; min-height: 36px;
  background: #1e1e1e; border-bottom: 1px solid #333;
  overflow-x: auto; overflow-y: hidden;
}
#cf-tabs::-webkit-scrollbar { height: 3px; }
#cf-tabs::-webkit-scrollbar-thumb { background: #444; }

.cf-tab {
  display: flex; align-items: center; gap: 6px;
  padding: 0 14px; height: 100%;
  border-right: 1px solid #2a2a2a;
  cursor: pointer; white-space: nowrap;
  color: #888; transition: background 0.1s;
  font-size: 12px;
}
.cf-tab:hover { background: #282828; color: #ccc; }
.cf-tab.active { background: #1a1a1a; color: #eee; border-bottom: 2px solid #4a9eff; }
.cf-tab-close {
  background: none; border: none; color: #555; font-size: 14px;
  cursor: pointer; padding: 0; line-height: 1; margin-left: 2px;
}
.cf-tab-close:hover { color: #e44; }
#cf-tab-add {
  padding: 0 14px; height: 100%; border: none;
  background: none; color: #555; font-size: 18px; cursor: pointer;
}
#cf-tab-add:hover { color: #aaa; }

/* Content area */
#cf-content {
  flex: 1; overflow: hidden; position: relative;
}
.cf-pane {
  position: absolute; inset: 0;
  display: none;
}
.cf-pane.active { display: flex; flex-direction: column; }
`;

class EditorOverlay {
  constructor() {
    this._injectCSS();
    this._el = null;
    this._fontController = null;
    this._fontName = null;

    // Tab state
    this._tabs = [];   // [{id, label, closeable, pane, instance}]
    this._activeTabId = null;

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

    this._tabBar = el.querySelector("#cf-tabs");
    this._content = el.querySelector("#cf-content");
    this._el = el;
  }

  // -------------------------------------------------------------------------
  // Tab management

  _addFontTab() {
    const pane = document.createElement("div");
    pane.className = "cf-pane";
    this._content.appendChild(pane);

    const grid = new GlyphGrid(pane, this._fontController, (glyphName) => {
      this.openGlyphTab(glyphName);
    });

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
