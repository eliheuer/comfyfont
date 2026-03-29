/**
 * font-controller.js — JS-side font model with LRU glyph cache.
 *
 * Mirrors Fontra's src-js/fontra-core/src/font-controller.js.
 *
 * Connects to the Python FontHandler via WebSocket RPC and caches
 * VariableGlyph objects so repeated access is instantaneous.
 */

import { RemoteObject, getRemoteProxy } from "./remote.js";
import { VarPackedPath } from "./packed-path.js";

const GLYPH_CACHE_SIZE = 500;

// ---------------------------------------------------------------------------
// Glyph object model (mirrors Python dataclasses)

export class StaticGlyphController {
  constructor(data) {
    this.xAdvance = data.xAdvance ?? null;
    this.yAdvance = data.yAdvance ?? null;
    this.components = data.components ?? [];
    this.anchors = data.anchors ?? [];
    this.guidelines = data.guidelines ?? [];
    this.path = VarPackedPath.fromObject(data.path ?? {});
    this._path2d = null;
  }

  /** Pre-computed Path2D for this static glyph (flattens components lazily). */
  get flattenedPath2d() {
    if (!this._path2d) {
      this._path2d = this.path.toPath2D();
    }
    return this._path2d;
  }

  invalidate() {
    this._path2d = null;
    this.path.invalidate();
  }
}

export class VariableGlyphController {
  constructor(data) {
    this.name = data.name;
    this.axes = data.axes ?? [];
    this.sources = data.sources ?? [];
    this.layers = {};
    for (const [name, layer] of Object.entries(data.layers ?? {})) {
      this.layers[name] = new StaticGlyphController(layer.glyph ?? {});
    }
    this.customData = data.customData ?? {};
  }

  /** Return the default (first source) StaticGlyphController. */
  get defaultLayer() {
    const src = this.sources[0];
    return src ? this.layers[src.layerName] : null;
  }

  /** Return the StaticGlyphController for a specific master (FontSource identifier). */
  layerForMaster(masterId) {
    if (!masterId) return this.defaultLayer;
    const src = this.sources.find((s) => s.locationBase === masterId);
    return src ? (this.layers[src.layerName] ?? this.defaultLayer) : this.defaultLayer;
  }
}

// ---------------------------------------------------------------------------
// LRU cache

class LRUCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this._map = new Map();
  }

  get(key) {
    if (!this._map.has(key)) return undefined;
    const val = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, val);
    return val;
  }

  set(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, value);
    if (this._map.size > this.maxSize) {
      this._map.delete(this._map.keys().next().value);
    }
  }

  delete(key) {
    this._map.delete(key);
  }

  has(key) {
    return this._map.has(key);
  }
}

// ---------------------------------------------------------------------------
// FontController

export class FontController {
  /**
   * @param {string} fontName  – filename in the ComfyFont workspace (e.g. "MyFont.ttf")
   */
  constructor(fontName) {
    this.fontPath = fontName;
    const wsPath = `/comfyfont/ws?name=${encodeURIComponent(fontName)}`;
    this._remote = new RemoteObject(wsPath);
    this._backend = getRemoteProxy(this._remote);
    this._glyphCache = new LRUCache(GLYPH_CACHE_SIZE);
    this._glyphMap = null;
    this._fontInfo = null;
    this._axes = null;
    this._changeListeners = new Set();

    // Register server-push handlers
    this._remote.registerServerMethod("externalChange", (change, isLive) => {
      this._handleExternalChange(change, isLive);
    });
  }

  async connect() {
    await this._remote.connect();
  }

  disconnect() {
    this._remote.close();
  }

  // -----------------------------------------------------------------------
  // Font-level data

  async getGlyphMap() {
    if (!this._glyphMap) {
      this._glyphMap = await this._backend.getGlyphMap();
    }
    return this._glyphMap;
  }

  async getFontInfo() {
    if (!this._fontInfo) {
      this._fontInfo = await this._backend.getFontInfo();
    }
    return this._fontInfo;
  }

  async getAxes() {
    if (!this._axes) {
      this._axes = await this._backend.getAxes();
    }
    return this._axes;
  }

  async getSources() {
    if (!this._sources) {
      this._sources = await this._backend.getSources();
    }
    return this._sources;
  }

  /**
   * Bulk-interpolate multiple glyphs at a given axis location.
   * Returns {glyphName: StaticGlyphController} for all glyphs that exist.
   */
  async getSpecimenAtLocation(glyphNames, location) {
    const data = await this._backend.getSpecimenAtLocation(glyphNames, location);
    const result = {};
    for (const [name, glyphData] of Object.entries(data ?? {})) {
      result[name] = new StaticGlyphController(glyphData);
    }
    return result;
  }

  async getUnitsPerEm() {
    const info = await this.getFontInfo();
    return info.unitsPerEm ?? 1000;
  }

  // -----------------------------------------------------------------------
  // Glyph access

  async getGlyph(glyphName) {
    if (this._glyphCache.has(glyphName)) {
      return this._glyphCache.get(glyphName);
    }
    const data = await this._backend.getGlyph(glyphName);
    if (data == null) return null;
    const glyph = new VariableGlyphController(data);
    this._glyphCache.set(glyphName, glyph);
    return glyph;
  }

  // -----------------------------------------------------------------------
  // Editing

  /**
   * Send a live (in-progress) change. No disk write on server.
   * Call this during drag operations for real-time multi-client preview.
   */
  async editIncremental(change) {
    await this._backend.editIncremental(change);
  }

  /**
   * Send a completed change with its rollback dict (for undo).
   * The server writes to disk and broadcasts to other clients.
   */
  async editFinal(change, rollback, label = "") {
    await this._backend.editFinal(change, rollback, label);
  }

  // -----------------------------------------------------------------------
  // Change listeners (for editor panels to react to external changes)

  addChangeListener(fn) {
    this._changeListeners.add(fn);
  }

  removeChangeListener(fn) {
    this._changeListeners.delete(fn);
  }

  _handleExternalChange(change, isLive) {
    // Invalidate cached glyph if the change affects it
    const path = change.p ?? [];
    if (path[0] === "glyphs" && path[1]) {
      this._glyphCache.delete(path[1]);
    }
    for (const fn of this._changeListeners) {
      try { fn(change, isLive); } catch { /* ignore listener errors */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Global registry — one FontController per font name

const _controllers = new Map();

export async function getFontController(fontName) {
  if (!_controllers.has(fontName)) {
    const ctrl = new FontController(fontName);
    await ctrl.connect();
    _controllers.set(fontName, ctrl);
  }
  return _controllers.get(fontName);
}
