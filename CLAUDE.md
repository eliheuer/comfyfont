# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Vision

ComfyFont is a next-generation font editor for the AI era — a rethinking of tools like Glyphs, RoboFont, and Fontra in the context of ComfyUI as an "operating system for visual AI workflows."

The core insight is that **forking is the fundamental operation**. A traditional font editor is a single-document application where you make one set of decisions. ComfyFont lets you load a font, fork it as many times as you want, run different AI models on each fork in parallel, and generate rendered specimens to compare the outputs side by side — all within a single workflow graph.

Example workflows that represent the vision:

**Kerning comparison:**
```
[Load Font: MyFont] → FONT
                         ↓
              ┌─ [Fork Font] → [AI Kerning: local model]  → FONT_A ─→ [DrawBot Render] → IMAGE_A
              └─ [Fork Font] → [AI Kerning: QuiverAI]     → FONT_B ─→ [DrawBot Render] → IMAGE_B
                                                                              ↓
                                                                    compare / post to social
```

**Script extension:**
```
[Load Font: Latin-only font] → [AI: Add Arabic] → FONT → [Text Render: arabic text] → IMAGE
```

**Quality assurance:**
```
[Load Font] → [AI: Check Google Fonts requirements] → report + corrected FONT
```

The UFO format is what makes AI integration tractable. Each glyph is a list of bezier contours — coordinates and on/off-curve point types — a structured representation that models can reason over directly. AI nodes would communicate with the same `FontHandler` backend the manual editor uses, reading and writing UFO sources via the existing RPC.

## Two Compilation Tools

- **fontmake** (Python) — current default for UFO→TTF compilation. Well-integrated with the Python ecosystem.
- **fontc** (Rust) — faster, stricter compiler. An option for the future.

## Setup & Development

Install Python dependencies into the ComfyUI venv (located at `~/Documents/ComfyUI/.venv`):

```bash
/Users/eli/Documents/ComfyUI/.venv/bin/pip3 install -r requirements.txt
```

The extension loads at ComfyUI startup (placed in `ComfyUI/custom_nodes/`). No build step — JS files are ES modules served directly via `WEB_DIRECTORY = "./js"`.

ComfyFont is symlinked: `~/Documents/ComfyUI/custom_nodes/comfyfont` → this repo.

There is no test suite yet.

## Architecture

### Font Workspace

Every font ComfyFont works with lives in `comfyfont/fonts/` — the **workspace**. This is the key design decision:

- **Import = copy to workspace.** The original file on disk is never touched.
- The workspace always maintains both forms: `MyFont.ttf` (compiled, for fast PIL rendering) and `MyFont.ufo/` (editable source, for the glyph editor and AI nodes).
- For variable fonts: the workspace will hold a `.designspace` file alongside multiple `Master-Light.ufo/`, `Master-Bold.ufo/` directories.
- **FONT type** (flowing through wires) is an absolute path to the TTF/designspace in the workspace. `_resolve_font()` maps this to a renderable TTF, compiling from UFO if needed.

### Idiomatic ComfyUI: COMBO + Workspace = same pattern as every built-in node

ComfyUI's file-loading nodes (Load Image, Load Checkpoint, Load LoRA) all use the same idiom: a **COMBO dropdown** listing files in a managed directory. `ComfyFontLoad` follows this pattern exactly — `INPUT_TYPES` returns a list of filenames from the workspace, ComfyUI renders it as a dropdown.

The COMBO value is a filename ("MyFont.ttf"). Python's `load()` resolves it to an absolute workspace path and outputs that as the FONT type. `folder_paths.add_search_path("comfyfont", FONTS_DIR)` registers the workspace with ComfyUI's ecosystem.

After importing a font, the JS extension manually adds the new filename to the COMBO widget's `options.values` so it appears immediately without a page reload. On next page load, `INPUT_TYPES` is re-evaluated and scans the workspace fresh.

### Entry Point (`__init__.py`)

Handles all ComfyUI integration: node class registration, HTTP route mounting on `PromptServer`, WebSocket RPC setup, `folder_paths` registration.

Server routes accept `?name=<filename>` (resolved relative to FONTS_DIR) or `?path=<absolute>` for backward compatibility.

### Node Classes (`nodes/`)

ComfyUI nodes declare inputs/outputs via class-level attributes that ComfyUI reads to build the UI and wire up the workflow graph:

- `INPUT_TYPES` — dict of inputs; the first element of a tuple being a list makes it a COMBO dropdown
- `RETURN_TYPES` / `RETURN_NAMES` — output socket types and labels
- `FUNCTION` — method ComfyUI calls to execute
- `IS_CHANGED` — return value ComfyUI compares to decide whether to re-execute (return mtime for file-based cache invalidation)

**`ComfyFontNode`** (`nodes/comfyfont.py`) — display name: "ComfyFont"
- Input: `font` (COMBO of workspace filenames)
- Output: `font` (FONT — absolute workspace path)
- `get_font_list()` lives here and is re-exported from `nodes/load.py` for `GET /comfyfont/fonts`
- Purely a font selector; Import Font… and Edit Font buttons added by JS extension

**`DrawBotNode`** (`nodes/drawbot.py`) — display name: "DrawBot"
- Inputs: `font` (FONT), `preset` (COMBO: specimen/waterfall/glyph/pangram/custom), `canvas_width`, `canvas_height`; optional: `input_text` (STRING), `custom_script` (STRING, multiline)
- Output: `image` (IMAGE)
- Built-in presets are DrawBot Python scripts stored in `nodes/drawbot.PRESETS`
- `custom_script` accepts a wire from a Text node (right-click → Convert to input) or inline editing
- Scripts run via `exec()` in a namespace with all drawbot-skia functions + `font_path`, `WIDTH`, `HEIGHT`, `input_text` pre-injected
- Uses drawbot-skia (cross-platform Skia-backed DrawBot); does not require the macOS DrawBot.app

**Planned nodes:**
- `ForkFontNode` — FONT → FONT: deep-copies the workspace entry to a new name, enabling parallel AI experimentation
- `DrawBotRenderNode` — FONT + script (STRING) → IMAGE: runs DrawBot-skia for publication-quality specimen generation
- `LoadFontFromGit` — git URL → FONT: clones a repo, imports the UFO/designspace into the workspace

### Core Library (`core/`)

- `compile.py` — `compile_ufo_to_ttf()`: UFO→TTF via fontmake, extracted here to avoid circular imports
- `server.py` — `FontHandler`: per-font RPC subject; loads UFO backend, handles glyph read/write
- `remote.py` — `RemoteObjectConnection`: bidirectional JSON-RPC wire protocol (mirrors Fontra's architecture)
- `classes.py` — dataclasses: `VariableGlyph`, `StaticGlyph`, `Transformation`, `Component`, `FontInfo`
- `path.py` — `PackedPath`: flat-array glyph outline (coordinates + point types + contour indices)
- `changes.py` — change application for undo/redo and remote sync

### Font Backends (`core/backends/`)

Duck-typed backends; `backendForPath()` factory selects by extension:
- `ufo.py` — read/write via `ufoLib2`
- `opentype.py` — read-only compiled fonts via `fonttools`

### JavaScript (`js/`)

Plain ES modules, no bundler:

- `load-node-widget.js` — customizes ComfyFontLoad: adds specimen preview (Path2D on canvas), Import/Edit buttons; the COMBO widget itself comes from ComfyUI
- `editor-overlay.js` — full-screen editor shell (font overview + per-glyph tabs)
- `glyph-grid.js` — font overview grid, IntersectionObserver lazy rendering
- `glyph-editor-tab.js` — per-glyph bezier editor canvas
- `font-controller.js` — `FontController`: LRU glyph cache (500 max), WS connection keyed by font name (`?name=<filename>`)
- `remote.js` — `RemoteObject` / `getRemoteProxy()`: WebSocket JSON-RPC client
- `packed-path.js` — `VarPackedPath`: glyph outline model → `Path2D` for canvas
- `canvas-controller.js` — HiDPI canvas with pan/zoom and Y-flip transform
- `visualization-layers.js` — drawing primitives for outlines, points, guides

### API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/comfyfont/import` | POST | Upload font file → copy to workspace + convert TTF↔UFO |
| `/comfyfont/fonts` | GET | JSON list of font names in workspace |
| `/comfyfont/glyph_map` | GET | Glyph name → unicode mappings (`?name=` or `?path=`) |
| `/comfyfont/ws` | WebSocket | Long-lived RPC to `FontHandler` (`?name=` or `?path=`) |

### Key Data Flow

**Import**: POST file → copy to `fonts/` → if TTF: convert to sibling UFO; if UFO: compile sibling TTF

**Rendering**: `ComfyFontLoadNode` outputs absolute workspace path → `TextRenderNode._resolve_font()` ensures a TTF exists (compiling from UFO if needed) → PIL renders → numpy → torch tensor `[1, H, W, 3]`

**Glyph editor**: "Edit Font" button → WS `?name=<filename>` → `FontHandler` opens UFO backend → bidirectional RPC with `font-controller.js`

**Specimen preview**: `load-node-widget.js` calls `getFontController(fontName)` → same WS path → `getGlyphMap()` + per-glyph `getGlyph()` → `VarPackedPath.toPath2D()` → drawn with y-flip transform (`ctx.scale(s, -s)`)

### Serialization

`cattrs` (`structure`/`unstructure`) serializes dataclasses to/from JSON for the RPC wire protocol.

## Roadmap

Phase 1 (complete): workspace, load node (COMBO), basic TTF/glyph rendering
Phase 2 (in progress): editor overlay wiring, point editing
Phase 3 (planned): ForkFont node, DrawBot render node
Phase 4 (planned): AI node protocol, variable font / designspace support, git import
