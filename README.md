# ComfyFont

A font editing and rendering extension for [ComfyUI](https://github.com/comfyanonymous/ComfyUI). Treat fonts as a first-class data type in your AI image workflows — load, edit, render, and fork font sources within the node graph.

---

## What it does

ComfyFont brings professional font editing tools into ComfyUI's node-graph model. The key idea is that fonts are **mutable workspace objects**, not just files. You can:

- Load a font into the workspace and render text or individual glyphs as `IMAGE` + `MASK` tensors that connect to any ComfyUI node
- Open the full-screen font editor to inspect and edit glyph outlines (bezier curves) directly
- Fork a font — create a copy with a new name — then apply different AI models or edits to each fork in parallel and compare the results
- Wire font nodes together with image generation, inpainting, and compositing nodes in the same workflow

---

## Installation

1. Clone or copy this folder into `ComfyUI/custom_nodes/comfyfont`
2. Install dependencies into the ComfyUI Python environment:
   ```bash
   pip install -r requirements.txt
   ```
3. Restart ComfyUI

All nodes appear under the **ComfyFont** category in the Add Node menu.

---

## The Font Workspace

ComfyFont manages a local workspace at `comfyfont/fonts/`. Every font you work with is stored here as two paired files:

| File | Purpose |
|------|---------|
| `MyFont.ttf` | Compiled font — used by rendering nodes (fast) |
| `MyFont.ufo/` | Editable source — used by the font editor and AI nodes |

**The workspace is always the working copy.** When you import a font, ComfyFont copies it into the workspace and converts it — the original file on disk is never modified. This means you can safely import fonts from anywhere, work on them inside ComfyUI, and the source of truth lives in the workspace.

For variable fonts, the workspace will contain a `.designspace` file alongside multiple UFO masters (e.g. `MyFont-Regular.ufo/`, `MyFont-Bold.ufo/`).

---

## Nodes

### Load Font (`ComfyFont > Load Font`)

The starting node. Selects a font from the workspace and outputs it as a `FONT` value that all other ComfyFont nodes accept.

**Output:** `font` (FONT)

**Controls:**
- **Font dropdown** — lists all fonts currently in the workspace
- **Import Font…** — opens a file picker; imports the selected file into the workspace (copies it and creates the TTF/UFO pair)
- **Edit Font** — opens the full-screen font editor for the selected font

The node shows a live **type specimen preview** of the selected font, rendered from the actual vector outlines.

---

### Text Render (`ComfyFont/Render > Text Render`)

Renders a string of text to an image using a loaded font.

**Inputs:**
| Input | Type | Description |
|-------|------|-------------|
| `font` | FONT | Font from Load Font |
| `text` | STRING | Text to render |
| `font_size` | INT | Size in pixels (6–1024) |
| `canvas_width` | INT | Output image width (64–4096) |
| `canvas_height` | INT | Output image height (64–4096) |
| `x` | INT | X position; `-1` = auto-center |
| `y` | INT | Y position; `-1` = auto-center |
| `color` | STRING | Hex color, e.g. `#FFFFFF` (optional, default white) |

**Outputs:** `image` (IMAGE), `mask` (MASK)

The `mask` is the alpha channel of the rendered text. Use it with `SetLatentNoiseMask`, `MaskToImage`, or any compositing node to control where the text influences generation.

---

### Glyph Render (`ComfyFont/Render > Glyph Render`)

Renders a single glyph at high quality using FreeType vector rasterisation.

**Inputs:**
| Input | Type | Description |
|-------|------|-------------|
| `font` | FONT | Font from Load Font |
| `glyph_name` | STRING | Glyph name (`A`), single character (`A`), or unicode (`U+0041`) |
| `canvas_width` | INT | Output width (64–4096) |
| `canvas_height` | INT | Output height (64–4096) |
| `padding` | INT | Margin around the glyph in pixels (default 32) |
| `even_odd` | BOOLEAN | Fill rule: off = non-zero (default), on = even-odd |

**Outputs:** `image` (IMAGE), `mask` (MASK)

The glyph is auto-fitted to fill the canvas (minus padding). Use `padding` to control how close to the edges it renders.

---

### Font Composite (`ComfyFont/Render > Font Composite`)

Composites a text or glyph image over a background image using its mask.

**Inputs:**
| Input | Type | Description |
|-------|------|-------------|
| `background` | IMAGE | Background image |
| `overlay` | IMAGE | Text/glyph image from a render node |
| `mask` | MASK | Mask from the same render node |
| `opacity` | FLOAT | Blend opacity 0.0–1.0 |

**Output:** `image` (IMAGE)

---

## The Font Editor

Click **Edit Font** on any Load Font node to open the full-screen editor. This is a vector glyph editor similar to Glyphs.app or RoboFont, running inside ComfyUI and communicating with the backend via WebSocket.

### Layout

```
┌─────────────────────────────────────────────────┐
│  ComfyFont — MyFont.ufo               [✕ close] │
├─────────────────────────────────────────────────┤
│  [Font ×]  [A ×]  [g ×]             [+]         │  ← tab bar
├─────────────────────────────────────────────────┤
│                                                  │
│  Font tab: grid of all glyphs                    │
│  Double-click any glyph → opens an editor tab   │
│                                                  │
│  Glyph tab: bezier canvas                        │
│  Pan: scroll or middle-drag                      │
│  Zoom: pinch or Cmd/Ctrl + scroll                │
│                                                  │
└─────────────────────────────────────────────────┘
```

- The **Font tab** (always open, cannot be closed) shows all glyphs in a scrollable grid
- **Double-clicking** a glyph opens it in a new editor tab
- Edits are saved directly to the `.ufo` source in the workspace
- Close the editor with ✕ or Escape to return to the ComfyUI canvas

The editor reads and writes UFO format directly. UFO stores each glyph as an individual `.glif` file — a plain XML file containing bezier contours and advance width. This is the same format used by professional font editors.

---

## Supported Font Formats

| Format | Import | Edit | Render |
|--------|--------|------|--------|
| TTF / OTF | ✓ | via UFO conversion | ✓ |
| WOFF / WOFF2 | ✓ | via UFO conversion | ✓ |
| UFO | ✓ | ✓ directly | via compiled TTF |
| Designspace (variable) | planned | planned | planned |

When you import a compiled font (TTF/OTF/WOFF), ComfyFont automatically converts it to a UFO alongside the original so editing works. When you import a UFO, ComfyFont compiles a TTF so rendering works.

---

## Common Workflows

### Render text over a generated image

```
[Load Font] → [Text Render: "Hello"] → image + mask
[KSampler output] ────────────────────────────────→ [Font Composite] → final image
```

### Generate a glyph and use it as an inpaint mask

```
[Load Font] → [Glyph Render: "A"] → mask → [SetLatentNoiseMask] → [KSampler]
```

### Compare two AI kerning models on the same font

```
[Load Font: MyFont]
        ├─→ [Fork Font] → [AI Kerning: Model A] → [Text Render: "AVAST"] → IMAGE_A
        └─→ [Fork Font] → [AI Kerning: Model B] → [Text Render: "AVAST"] → IMAGE_B
```

*(Fork Font and AI kerning nodes are on the roadmap.)*

---

## The FONT Type

`FONT` is a custom ComfyUI data type — a wire carrying a reference to a font in the workspace. It flows from `Load Font` to any rendering or editing node. It is an absolute filesystem path to the compiled TTF (or designspace) inside the workspace, resolved at execution time.

Because the FONT type is just a path, any Python node that accepts `("FONT",)` as an input type can work with it. An AI node that modifies font sources would read the UFO at the corresponding path, make changes, and output a new FONT pointing to the modified (or forked) workspace entry.

---

## File Formats: UFO Explained

[UFO (Unified Font Object)](https://unifiedfontobject.org/) is an open, human-readable font source format used by all major professional font editors. Each font is a directory:

```
MyFont.ufo/
├── metainfo.plist       — format version
├── fontinfo.plist       — family name, UPM, ascender/descender, etc.
├── lib.plist            — arbitrary metadata
├── features.fea         — OpenType feature code
├── kerning.plist        — kerning pairs
├── groups.plist         — glyph groups
└── glyphs/
    ├── contents.plist   — glyph name → filename map
    ├── A_.glif          — glyph "A": bezier contours + advance width
    ├── a.glif
    └── ...
```

Each `.glif` file is a small XML document — this is what AI models operate on when doing glyph-level work.

---

## Roadmap

- **Fork Font node** — create a named workspace copy for parallel experimentation
- **DrawBot Render node** — run a DrawBot-skia script against a font, output IMAGE; the intended tool for high-quality typographic specimen generation
- **Variable font / designspace** — load and edit multi-master fonts; axis sliders for previewing interpolated instances
- **Git import** — load a font directly from a GitHub repository into the workspace
- **AI node protocol** — standard interface for AI models to read/write font sources (kerning, glyph generation, script extension, quality checking)
