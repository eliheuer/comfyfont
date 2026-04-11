# ComfyFont

A font editing and rendering extension for [ComfyUI](https://github.com/comfyanonymous/ComfyUI). Treat fonts as a first-class data type in your AI image workflows — load, edit, render, and fork font sources within the node graph.

A **DrawBot node** is included for rendering high-quality type specimens. Scripts are written in Python using the [DrawBot](https://www.drawbot.com/) API — a scripting tool widely used by type designers for generating font proofs and specimen graphics. ComfyFont uses [drawbot-skia](https://github.com/typemytype/drawbot-skia) under the hood, so the DrawBot node works on macOS, Linux, and Windows without requiring the macOS DrawBot.app.

<img width="1920" height="1080" alt="Image" src="https://github.com/user-attachments/assets/0e7452f6-164e-415e-a811-922a2617cce3" />

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

### ComfyFont (`ComfyFont > ComfyFont`)

The primary node. Selects a font and exposes it for the rest of the workflow.

**Controls:**
- **Font dropdown** — lists all fonts currently in the workspace
- **Import Font…** — opens a file picker; copies the font into the workspace and creates the TTF/UFO pair
- **Edit Font** — opens the full-screen glyph editor

**Output:** `font` (FONT) — wire this to Render Font Specimen or any AI/Fork node.

The node canvas shows a live **vector specimen preview** of the selected font.

---

### DrawBot (`ComfyFont > DrawBot`)



Renders a type specimen using [drawbot-skia](https://github.com/typemytype/drawbot-skia) — the cross-platform Python implementation of [DrawBot](https://www.drawbot.com/), the scripting tool type designers use for specimen generation.

**Inputs:**
| Input | Type | Description |
|-------|------|-------------|
| `font` | FONT | Font wire from the Font node |
| `preset` | COMBO | Built-in script to run (see below) |
| `canvas_width` | INT | Output width in pixels (64–4096) |
| `canvas_height` | INT | Output height in pixels (64–4096) |
| `input_text` | STRING | Text passed into scripts as `input_text` — used by waterfall, glyph, and pangram presets (optional) |
| `custom_script` | STRING | DrawBot Python script — only used when preset is `custom`; right-click → "Convert to input" to wire from a Text node (optional) |

**Presets:**
| Preset | Description |
|--------|-------------|
| `specimen` | A–Z uppercase, a–z lowercase, 0–9 rows — auto-fitted to canvas |
| `waterfall` | Same text at cascading sizes (96pt down to 12pt) |
| `glyph` | Single large character centred on canvas (set `input_text` to change the glyph) |
| `pangram` | Body text in a text box (defaults to "The quick brown fox…") |
| `custom` | Run your own DrawBot script from `custom_script` |

**Output:** `image` (IMAGE)

**Writing custom scripts:**

Scripts have access to all standard DrawBot functions (`font()`, `text()`, `textBox()`, `fill()`, `rect()`, etc.) plus these injected variables:

```python
font_path   # absolute path to the loaded font
WIDTH       # canvas width
HEIGHT      # canvas height
input_text  # value from the input_text field
```

Each script should start with `newPage(WIDTH, HEIGHT)`. Example:

```python
newPage(WIDTH, HEIGHT)
fill(0.05)
rect(0, 0, WIDTH, HEIGHT)
fill(1)
font(font_path, 120)
text("Aa", (WIDTH / 2, HEIGHT * 0.25), align="center")
```

> drawbot-skia is the Python library — you do not need the macOS DrawBot.app installed. Scripts written for DrawBot.app are largely compatible.

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
[Load Font] → [Render Text: "Hello"] → image + mask
[KSampler output] ──────────────────────────────→ [ImageComposite] → final image
```

Use any standard ComfyUI compositing node with the `image` and `mask` outputs.

### Generate a glyph and use it as an inpaint mask

```
[Font: MyFont] → mask → [SetLatentNoiseMask] → [KSampler]
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
