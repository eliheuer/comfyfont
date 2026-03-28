# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ComfyFont is a ComfyUI custom node extension that embeds a font editor. It provides nodes for loading/rendering fonts and a full-screen WebSocket-based glyph editor overlay. The architecture mirrors [Fontra](https://github.com/fontra/fontra) closely.

## Setup & Development

Install Python dependencies (into whichever Python environment ComfyUI uses):

```bash
pip install -r requirements.txt
```

The extension is loaded by ComfyUI at startup when this directory is placed in `ComfyUI/custom_nodes/`. There is no separate build step — JS files are served directly as ES modules via `WEB_DIRECTORY = "./js"`.

There is no test suite yet.

## Architecture

### Entry Point

`__init__.py` handles all ComfyUI integration: node class registration, HTTP route mounting on `PromptServer`, WebSocket RPC setup, and library auto-initialization.

### Node Classes (`nodes/`)

ComfyUI nodes are Python classes that declare their inputs, outputs, and execution method via class-level attributes. ComfyUI reads these to build the node's UI and wire up the workflow graph:

- `INPUT_TYPES` — classmethod returning a dict of input sockets and their types/defaults. Types can be built-in ComfyUI types (`STRING`, `INT`, `FLOAT`, `BOOLEAN`, `IMAGE`, `MASK`) or custom types like `FONT`. Inputs under `"required"` must be connected; `"optional"` may be left unconnected.
- `RETURN_TYPES` / `RETURN_NAMES` — tuple of output socket types and their labels.
- `FUNCTION` — name of the method ComfyUI calls to execute the node.
- `CATEGORY` — where the node appears in the Add Node menu.

The custom **FONT** type is a plain Python string (the font's name in the library). It flows from `ComfyFontLoadNode`'s output to any node with a `FONT` input, where `_resolve_font()` uses it to locate the compiled TTF on disk.

> Note: the input/output details below reflect the current implementation and will need updating as nodes evolve.

**`ComfyFontLoadNode`** (`load.py`)
- Inputs: `font` (dropdown of library font names), `specimen_text` (STRING, default `"AaBbCc 123"`)
- Outputs: `font` (FONT)
- Uses `IS_CHANGED` returning `NaN` to always re-execute so the font dropdown stays current.

**`TextRenderNode`** (`render.py`)
- Inputs: `font` (FONT), `text` (STRING), `font_size` (INT, 6–1024), `canvas_width` (INT, 64–4096), `canvas_height` (INT, 64–4096), `x` (INT, -1 = auto-center), `y` (INT, -1 = auto-center), `color` (STRING hex, optional)
- Outputs: `image` (IMAGE `[1, H, W, 3]`), `mask` (MASK `[1, H, W]`)

**`GlyphRenderNode`** (`render.py`)
- Inputs: `font` (FONT), `glyph_name` (STRING — glyph name, single character, or `U+XXXX`), `canvas_width`, `canvas_height`, `padding` (INT, default 32), `even_odd` (BOOLEAN)
- Outputs: `image` (IMAGE), `mask` (MASK)

**`FontCompositeNode`** (`render.py`)
- Inputs: `background` (IMAGE), `overlay` (IMAGE), `mask` (MASK), `opacity` (FLOAT, 0–1)
- Outputs: `image` (IMAGE)

**`FontInfoNode`** (`inspect.py`)
- Inputs: `font_file` (dropdown of font files)
- Outputs: `info_json` (STRING — JSON with family name, UPM, ascender, descender, x-height, cap height, glyph count, etc.)

**`GlyphListNode`** (`inspect.py`)
- Inputs: `font_file` (dropdown of font files), `include_unicode` (BOOLEAN)
- Outputs: `glyphs_json` (STRING — JSON array of `{name, unicodes}` objects, or just name strings if `include_unicode` is false)

### Core Library (`core/`)

- `library.py` — `FontLibrary`: Manages the `library/` directory; imports TTF/OTF → UFO, lists fonts, renders specimen PNGs
- `server.py` — `FontHandler`: Per-font RPC subject over WebSocket; loads UFO backend and handles glyph read/write
- `remote.py` — `RemoteObjectConnection`: Bidirectional JSON-RPC wire protocol
- `classes.py` — Dataclasses mirroring Fontra: `VariableGlyph`, `StaticGlyph`, `Transformation`, `Component`, `FontInfo`
- `path.py` — `PackedPath`: Flat array glyph outline representation (coordinates + point types + contour indices)
- `changes.py` — Change application for undo/redo and remote sync

### Font Backends (`core/backends/`)

Protocol-based (duck-typed) backends; `backendForPath()` factory selects by file extension:
- `ufo.py` — Read/write UFO source via `ufoLib2`
- `opentype.py` — Read-only compiled fonts (TTF/OTF/WOFF/WOFF2) via `fonttools`

### Font Library Structure

```
library/
├── FontName.ufo/      ← editable source (ufoLib2)
└── FontName.ttf       ← compiled for fast PIL rendering
```

### JavaScript (`js/`)

All files are plain ES modules with no bundler:

- `load-node-widget.js` — Hooks into ComfyUI's `app.canvas` to customize the ComfyFontLoad node: specimen preview, Import/Edit buttons
- `editor-overlay.js` — Full-screen editor shell with tab bar (Font overview + per-glyph tabs)
- `glyph-grid.js` — Font overview grid with IntersectionObserver lazy rendering; double-click to open glyph tab
- `glyph-editor-tab.js` — Per-glyph bezier editor canvas
- `font-controller.js` — `VariableGlyphController`: LRU glyph cache (500 max), connects to `FontHandler` via WebSocket RPC
- `remote.js` — WebSocket JSON-RPC client (`RemoteObject`, `getRemoteProxy()`)
- `packed-path.js` — `VarPackedPath`: glyph outline model, converts to `Path2D` for canvas
- `canvas-controller.js` — HiDPI-aware canvas with pan/zoom and Y-flip transform
- `visualization-layers.js` — Drawing primitives for outlines, points, guides

### API Routes

All mounted under `/comfyfont/`:

| Route | Method | Purpose |
|-------|--------|---------|
| `/import` | POST | Upload font file, convert to library format |
| `/library` | GET | List all fonts with metadata |
| `/specimen` | GET | Render specimen PNG (`?font=`, `?text=`, `?width=`, `?height=`) |
| `/glyph_map` | GET | Get glyph name → unicode mappings |
| `/ws` | WebSocket | Long-lived RPC to `FontHandler` (`?font=`) |

### Key Data Flow

**Font import**: POST → `library.importFont()` → TTF→UFO via fonttools → saves `FontName.ufo` + `FontName.ttf`

**Rendering**: `ComfyFontLoadNode` outputs font name → `TextRenderNode` resolves TTF → PIL renders → numpy → torch tensor `[1, H, W, 3]`

**Glyph editor**: "Edit Font" → WebSocket `/comfyfont/ws?font=Name` → `FontHandler` ↔ `font-controller.js` bidirectional RPC

### Serialization

`cattrs` (`structure`/`unstructure`) serializes all dataclasses to/from JSON for the RPC wire protocol.

## Build Plan

See `context/plan.md` for the full phased roadmap (Phases 1–4). Phase 1 (library, load node, basic rendering) is complete. Phases 2–3 (editor overlay wiring, point editing) are in progress with infrastructure already in place.
