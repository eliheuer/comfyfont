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
    const scale  = Math.min(availW / maxW, availH / totalH);
    if (ascender * scale >= 18) break;
    lines = lines.slice(0, -1);
  }

  const n      = lines.length;
  const widths = lines.map((chars) =>
    chars.reduce((s, ch) => s + (glyphData[ch]?.xAdvance ?? 0), 0)
  );
  const maxW   = Math.max(...widths, 1);
  const totalH = n * line_h + (n - 1) * gap;
  const scale  = Math.min(availW / maxW, availH / totalH);

  const blockTop = (availH - totalH * scale) / 2;

  const cmds = [];
  for (let i = 0; i < lines.length; i++) {
    const chars      = lines[i];
    const baseline_y = blockTop + (i * (line_h + gap) + ascender) * scale;
    const x_start    = (availW - widths[i] * scale) / 2;

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
// Specimen data fetch

async function refreshSpecimen(node) {
  const fontWidget = node.widgets?.find((w) => w.name === "font");
  const fontName   = fontWidget?.value?.trim();
  if (!fontName || fontName.startsWith("(")) {
    node._specimenData = null;
    return;
  }

  try {
    const fc = await getFontController(fontName);
    const [info, glyphMap] = await Promise.all([fc.getFontInfo(), fc.getGlyphMap()]);

    const cpToGlyph = new Map();
    for (const [name, codepoints] of Object.entries(glyphMap)) {
      for (const cp of codepoints) cpToGlyph.set(cp, name);
    }

    const filteredLines = LATIN_SPECIMEN
      .map((line) => [...line].filter((ch) => cpToGlyph.has(ch.codePointAt(0))))
      .filter((line) => line.length > 0);

    const uniqueChars = [...new Set(filteredLines.flat())];
    const glyphData   = {};

    await Promise.all(
      uniqueChars.map(async (ch) => {
        const glyphName = cpToGlyph.get(ch.codePointAt(0));
        if (!glyphName) return;
        const glyph = await fc.getGlyph(glyphName);
        const layer = glyph?.defaultLayer;
        if (!layer) return;
        glyphData[ch] = {
          path2d:   layer.flattenedPath2d,
          xAdvance: layer.xAdvance ?? 0,
        };
      })
    );

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
  input.accept = ".ttf,.otf,.woff,.woff2,.ufo";

  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;

    const form = new FormData();
    form.append("file", file, file.name);

    const statusWidget = node.widgets?.find((w) => w.name === "_status");
    if (statusWidget) statusWidget.value = `Uploading…`;
    node.setDirtyCanvas(true, false);

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

      if (statusWidget) statusWidget.value = "";
      await refreshSpecimen(node);

    } catch (err) {
      if (statusWidget) statusWidget.value = `✗ ${err.message}`;
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
    if (nodeData.name !== "ComfyFontLoad") return;

    // ---- onNodeCreated ----
    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      origCreated?.apply(this, arguments);

      this._specimenData = null;

      // Refresh specimen when the COMBO selection changes
      const fontWidget = this.widgets?.find((w) => w.name === "font");
      if (fontWidget) {
        const origCb = fontWidget.callback;
        fontWidget.callback = (...args) => {
          origCb?.(...args);
          refreshSpecimen(this);
        };
      }

      // Buttons
      this.addWidget("button", "Import Font…", null, () => importFont(this));
      this.addWidget("button", "Edit Font",    null, () => {
        const name = this.widgets?.find((w) => w.name === "font")?.value?.trim();
        if (name && !name.startsWith("(")) openEditor(name);
      });

      // Status label — shows transient messages (upload errors, etc.)
      const statusW    = this.addWidget("text", "_status", "", () => {});
      statusW.disabled = true;

      this.size[1] += SPECIMEN_MIN_H + 16;
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
    if (node.comfyClass !== "ComfyFontLoad") return;
    await refreshSpecimen(node);
  },
});
