/**
 * load-node-widget.js
 *
 * Customises the ComfyFontLoad node:
 *  - Type specimen rendered directly to canvas via Path2D
 *  - "Import Font…" button → file picker → uploads to /comfyfont/import
 *  - "Edit Font" button → opens the full-screen editor overlay
 *
 * The `font` input is a standard ComfyUI COMBO dropdown; this extension adds
 * the specimen preview and action buttons without replacing the dropdown itself.
 */

import { app } from "../../scripts/app.js";
import { openEditor } from "./editor-overlay.js";
import { getFontController } from "./font-controller.js";

// ---------------------------------------------------------------------------
// Latin specimen lines

const LATIN_SPECIMEN = [
  "ABCDEFGHIJKLM",
  "NOPQRSTUVWXYZ",
  "abcdefghijklm",
  "nopqrstuvwxyz",
  "0123456789",
];

// ---------------------------------------------------------------------------
// Layout — pure sync, called on every draw so it always matches current size.
// Returns an array of draw commands: [{path2d, tx, ty, s}]

function specimenLayout(filteredLines, glyphData, upm, ascender, descender, availW, availH) {
  if (availW < 20 || availH < 20) return [];

  // Inner margin: 8% of the shorter dimension on each side for breathing room.
  const margin = Math.min(availW, availH) * 0.08;
  const innerW = availW - margin * 2;
  const innerH = availH - margin * 2;

  const line_h = ascender - descender;  // font units
  const gap    = line_h * 0.06;

  // Drop lines from the end until cap height is at least 18px
  let lines = filteredLines;
  while (lines.length > 1) {
    const n      = lines.length;
    const widths = lines.map((chars) =>
      chars.reduce((s, ch) => s + (glyphData[ch]?.xAdvance ?? 0), 0)
    );
    const maxW   = Math.max(...widths, 1);
    const totalH = n * line_h + (n - 1) * gap;
    const scale  = Math.min(innerW / maxW, innerH / totalH);
    if (ascender * scale >= 18) break;
    lines = lines.slice(0, -1);
  }

  const n      = lines.length;
  const widths = lines.map((chars) =>
    chars.reduce((s, ch) => s + (glyphData[ch]?.xAdvance ?? 0), 0)
  );
  const maxW   = Math.max(...widths, 1);
  const totalH = n * line_h + (n - 1) * gap;
  const scale  = Math.min(innerW / maxW, innerH / totalH);

  const blockTop = margin + (innerH - totalH * scale) / 2;

  const cmds = [];
  for (let i = 0; i < lines.length; i++) {
    const chars      = lines[i];
    const baseline_y = blockTop + (i * (line_h + gap) + ascender) * scale;
    const x_start    = margin + (innerW - widths[i] * scale) / 2;

    let x_ufo = 0;
    for (const ch of chars) {
      const g = glyphData[ch];
      if (g) {
        cmds.push({ path2d: g.path2d, tx: x_start + x_ufo * scale, ty: baseline_y, s: scale });
      }
      x_ufo += g?.xAdvance ?? 0;
    }
  }

  return cmds;
}

// ---------------------------------------------------------------------------
// Axis helpers

/**
 * For a VariableGlyphController, pick the layer whose source's font-level
 * location is closest to axisLocation (nearest-master approach).
 * Falls back to defaultLayer when there are no font sources or no axes.
 */
function nearestSourceLayer(glyph, fontSources, axisLocation) {
  if (!glyph) return null;
  const axisNames = Object.keys(axisLocation ?? {});
  if (!axisNames.length || !fontSources || !Object.keys(fontSources).length) {
    return glyph.defaultLayer;
  }

  let bestLayer = glyph.defaultLayer;
  let bestDist  = Infinity;

  for (const src of glyph.sources ?? []) {
    const fs = fontSources[src.locationBase];
    if (!fs) continue;
    const fsLoc = fs.location ?? {};
    let dist = 0;
    for (const name of axisNames) {
      const diff = (axisLocation[name] ?? 0) - (fsLoc[name] ?? 0);
      dist += diff * diff;
    }
    if (dist < bestDist) {
      bestDist = dist;
      const layer = glyph.layers[src.layerName];
      if (layer) bestLayer = layer;
    }
  }
  return bestLayer;
}

/**
 * Add or remove axis number widgets to match the given axes array.
 * Skips the update if the axis names haven't changed (slider values are preserved).
 */
function syncAxisWidgets(node, axes) {
  const existing = (node.widgets ?? []).filter((w) => w._isAxisWidget);
  const existingNames = existing.map((w) => w._axisName);
  const newNames = (axes ?? []).map((a) => a.name);

  // No change needed.
  if (
    existingNames.length === newNames.length &&
    existingNames.every((n, i) => n === newNames[i])
  ) return;

  // Remove old axis widgets.
  node.widgets = (node.widgets ?? []).filter((w) => !w._isAxisWidget);

  if (!axes?.length) return;

  for (const axis of axes) {
    if (!(axis.name in node._axisLocation)) {
      node._axisLocation[axis.name] = axis.default ?? 0;
    }
    const range = axis.maximum - axis.minimum;
    const step  = range > 10 ? 1 : 0.01;
    const w = node.addWidget(
      "number",
      axis.label || axis.name,
      node._axisLocation[axis.name],
      (value) => {
        node._axisLocation[axis.name] = value;
        clearTimeout(node._axisDebounce);
        node._axisDebounce = setTimeout(() => refreshSpecimen(node), 80);
      },
      { min: axis.minimum, max: axis.maximum, step, precision: step < 1 ? 2 : 0 }
    );
    w._isAxisWidget = true;
    w._axisName     = axis.name;
  }

  // Ensure the node is tall enough to show the specimen below the new widgets.
  const minH = specimenY(node) + SPECIMEN_MIN_H + 6;
  if (node.size[1] < minH) node.size[1] = minH;
}

// ---------------------------------------------------------------------------
// Specimen data fetch

async function refreshSpecimen(node) {
  const fontWidget = node.widgets?.find((w) => w.name === "font");
  const fontName   = fontWidget?.value?.trim();
  if (!fontName) {
    node._specimenData = null;
    return;
  }

  // Reset axis location when the font changes.
  if (node._specimenFontName !== fontName) {
    node._axisLocation     = {};
    node._specimenFontName = fontName;
  }

  try {
    const fc = await getFontController(fontName);
    const [info, glyphMap, axes, fontSources] = await Promise.all([
      fc.getFontInfo(),
      fc.getGlyphMap(),
      fc.getAxes(),
      fc.getSources(),
    ]);

    // Sync axis sliders (no-op if axes haven't changed).
    syncAxisWidgets(node, axes);

    // Seed default axis values for any axis not yet in _axisLocation.
    for (const axis of axes ?? []) {
      if (!(axis.name in node._axisLocation)) {
        node._axisLocation[axis.name] = axis.default ?? 0;
      }
    }

    const cpToGlyph = new Map();
    for (const [name, codepoints] of Object.entries(glyphMap)) {
      for (const cp of codepoints) cpToGlyph.set(cp, name);
    }

    const filteredLines = LATIN_SPECIMEN
      .map((line) => [...line].filter((ch) => cpToGlyph.has(ch.codePointAt(0))))
      .filter((line) => line.length > 0);

    const uniqueChars  = [...new Set(filteredLines.flat())];
    const uniqueGlyphs = [...new Set(
      uniqueChars.map((ch) => cpToGlyph.get(ch.codePointAt(0))).filter(Boolean)
    )];
    const glyphData = {};

    if (axes?.length) {
      // Variable font — fetch all interpolated outlines in one bulk RPC call.
      const interpolated = await fc.getSpecimenAtLocation(uniqueGlyphs, node._axisLocation);
      console.log("[ComfyFont] getSpecimenAtLocation returned", Object.keys(interpolated).length, "glyphs for location", node._axisLocation, "; uniqueGlyphs requested:", uniqueGlyphs.length, "; glyphMap size:", Object.keys(glyphMap).length);
      for (const ch of uniqueChars) {
        const glyphName = cpToGlyph.get(ch.codePointAt(0));
        const layer     = glyphName ? interpolated[glyphName] : null;
        if (!layer) continue;
        glyphData[ch] = { path2d: layer.flattenedPath2d, xAdvance: layer.xAdvance ?? 0 };
      }
    } else {
      // Single master — use cached VariableGlyph data (no RPC needed after first load).
      await Promise.all(
        uniqueChars.map(async (ch) => {
          const glyphName = cpToGlyph.get(ch.codePointAt(0));
          if (!glyphName) return;
          const glyph = await fc.getGlyph(glyphName);
          const layer = nearestSourceLayer(glyph, fontSources, node._axisLocation);
          if (!layer) return;
          glyphData[ch] = { path2d: layer.flattenedPath2d, xAdvance: layer.xAdvance ?? 0 };
        })
      );
    }

    const upm       = info.unitsPerEm ?? 1000;
    const ascender  = info.ascender   ?? Math.round(upm * 0.8);
    const descender = info.descender  ?? Math.round(upm * -0.2);

    node._specimenData = { upm, ascender, descender, filteredLines, glyphData };
    node.setDirtyCanvas(true, false);

  } catch (err) {
    console.warn("ComfyFont specimen error:", err);
    node._specimenData = null;
  }
}

// ---------------------------------------------------------------------------
// Font import helper

async function importFont(node) {
  const input  = document.createElement("input");
  input.type   = "file";
  input.accept = ".ttf,.otf,.woff,.woff2,.ufo,.designspace,.zip";

  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;

    const form = new FormData();
    form.append("file", file, file.name);

    try {
      const res  = await fetch("/comfyfont/import", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);

      // Add the new font to the COMBO and select it
      const fontWidget = node.widgets?.find((w) => w.name === "font");
      if (fontWidget) {
        if (!fontWidget.options.values.includes(data.name)) {
          fontWidget.options.values.push(data.name);
          fontWidget.options.values.sort();
        }
        fontWidget.value = data.name;
      }

      await refreshSpecimen(node);

    } catch (err) {
      alert(`ComfyFont import failed: ${err.message}`);
      console.error("ComfyFont import error:", err);
    }
  };

  input.click();
}

// ---------------------------------------------------------------------------
// Helpers

const SPECIMEN_MIN_H = 80;

function specimenY(node) {
  const widgets = node.widgets ?? [];
  const lastW   = widgets[widgets.length - 1];
  if (lastW?.last_y != null) return lastW.last_y + 26;
  return widgets.length * 24 + 10;
}

// ---------------------------------------------------------------------------
// LiteGraph extension

app.registerExtension({
  name: "ComfyFont.LoadNode",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "ComfyFont") return;

    // ---- onNodeCreated ----
    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      origCreated?.apply(this, arguments);

      this._specimenData     = null;
      this._axisLocation     = {};
      this._specimenFontName = null;

      // Refresh specimen when the COMBO selection changes
      const fontWidget = this.widgets?.find((w) => w.name === "font");
      if (fontWidget) {
        const origCb = fontWidget.callback;
        fontWidget.callback = (...args) => {
          origCb?.(...args);
          refreshSpecimen(this);
        };
      }

      this.addWidget("button", "Import Font", null, () => importFont(this));
      this.addWidget("button", "Edit Font",   null, () => {
        const name = this.widgets?.find((w) => w.name === "font")?.value?.trim();
        if (name) openEditor(name);
      });

      this.size[1] += SPECIMEN_MIN_H + 16;
    };

    // ---- onConfigure — reset stale COMBO values after workflow restore ----
    const origConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      origConfigure?.apply(this, arguments);
      const fontWidget = this.widgets?.find((w) => w.name === "font");
      if (fontWidget && !fontWidget.options.values.includes(fontWidget.value)) {
        fontWidget.value = fontWidget.options.values[0] ?? "";
      }
    };

    // ---- onDrawBackground ----
    nodeType.prototype.onDrawBackground = function (ctx) {
      const pad    = 6;
      const imgY   = specimenY(this);
      const availW = this.size[0] - pad * 2;
      const availH = this.size[1] - imgY - pad;
      if (availH < 20) return;

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(pad, imgY, availW, availH, 4);
      ctx.clip();

      ctx.fillStyle = "#1c1c1c";
      ctx.fill();

      if (this._specimenData) {
        const { ascender, descender, filteredLines, glyphData, upm } = this._specimenData;
        const cmds = specimenLayout(
          filteredLines, glyphData, upm, ascender, descender, availW, availH
        );

        ctx.translate(pad, imgY);

        ctx.fillStyle = "#dcdcdc";
        for (const { path2d, tx, ty, s } of cmds) {
          ctx.save();
          ctx.translate(tx, ty);
          ctx.scale(s, -s);
          ctx.fill(path2d, "nonzero");
          ctx.restore();
        }
      } else {
        // Empty state — centred icon and prompt
        ctx.translate(pad, imgY);

        const iconSize  = Math.max(24, Math.min(availW, availH) * 0.22);
        const labelSize = Math.max(10, Math.min(availW, availH) * 0.065);
        const cx        = availW / 2;

        ctx.textAlign    = "center";
        ctx.textBaseline = "middle";

        // "Aa" as a typographic icon, slightly above centre
        ctx.font      = `${iconSize}px serif`;
        ctx.fillStyle = "#383838";
        ctx.fillText("Aa", cx, availH * 0.44);

        // Subtitle
        ctx.font      = `${labelSize}px sans-serif`;
        ctx.fillStyle = "#3a3a3a";
        ctx.fillText("No font loaded", cx, availH * 0.44 + iconSize * 0.8);
      }

      ctx.restore();
    };

    // ---- onResize — enforce minimum height ----
    const origResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (size) {
      origResize?.apply(this, arguments);
      const minH = specimenY(this) + SPECIMEN_MIN_H + 6;
      if (size[1] < minH) size[1] = minH;
    };
  },

  // Refresh specimen once node is placed on canvas
  async nodeCreated(node) {
    if (node.comfyClass !== "ComfyFont") return;
    await refreshSpecimen(node);
  },
});
