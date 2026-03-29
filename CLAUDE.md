# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Vision

ComfyFont is best understood as **a port of Fontra into ComfyUI**. Fontra's architecture — pluggable async backends, a unified `VariableGlyph` data model, WebSocket JSON-RPC, change objects — maps directly onto ComfyUI's node-graph model. ComfyFont follows Fontra's backend and data model design as closely as possible.

The UI (glyph grid, glyph editor canvas) follows **Runebender Xilem** rather than Fontra — bento-box span-aware grid, the Runebender point color vocabulary, floating canvas-first toolbars.

The core insight that makes ComfyFont distinct from both: **forking is the fundamental operation**. A traditional font editor is single-document. ComfyFont lets you load a font, fork it as many times as you want, run different AI models on each fork in parallel, and render specimens to compare — all within a single workflow graph.

**Kerning comparison:**
```
[Load Font: MyFont] → FONT
         ├─ [Fork Font] → [AI Kerning: local model] → FONT_A → [DrawBot] → IMAGE_A
         └─ [Fork Font] → [AI Kerning: QuiverAI]    → FONT_B → [DrawBot] → IMAGE_B
```

**Script extension:**
```
[Load Font: Latin-only font] → [AI: Add Arabic] → FONT → [DrawBot: arabic text] → IMAGE
```

The UFO/designspace format is what makes AI integration tractable — each glyph is a list of bezier contours (coordinates + point types), a structured representation that models can reason over directly.

## Two Compilation Tools

- **fontmake** (Python) — current default for UFO→TTF compilation.
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

Every font ComfyFont works with lives in `comfyfont/fonts/` — the **workspace**:

- **Import = copy to workspace.** The original file is never modified.
- The workspace maintains paired forms: `MyFont.ttf` (compiled, for PIL rendering) + `MyFont.ufo/` (editable source).
- For variable fonts: a `.designspace` file alongside multiple UFO masters (`Master-Light.ufo/`, `Master-Bold.ufo/`, etc.).
- **FONT type** (on wires) is an absolute path to the TTF or designspace in the workspace.

### Data Model — Follow Fontra Exactly

ComfyFont's data model in `core/classes.py` mirrors Fontra's `src/fontra/core/classes.py`. When in doubt, check Fontra's source.

**`VariableGlyph`** — everything is one unified object:
```python
VariableGlyph
  ├── name: str
  ├── axes: list[GlyphAxis]       # LOCAL per-glyph axes; can shadow font-level axes by name
  ├── sources: list[GlyphSource]  # each maps a location → a layer name
  └── layers: dict[str, Layer]    # named layers; each holds a StaticGlyph
```
Sources and layers are decoupled by name. Multiple sources can share a layer. Layers can exist with no source (background/reference layers).

**`GlyphSource`** — the `locationBase` pattern is critical:
```python
GlyphSource
  ├── name: str
  ├── layerName: str           # which Layer to use
  ├── location: Location       # RELATIVE offset from the font source (usually {})
  └── locationBase: str | None # opaque ID of the parent FontSource
```
`location` is a delta from the named `FontSource`, not an absolute position. Absolute = `fontSource.location | glyphSource.location`.

**`FontSource`** — keyed by opaque UUID string, not by location:
```python
FontSource
  ├── name: str
  ├── location: Location       # always in USER SPACE (not normalized, not design space)
  ├── isSparse: bool           # True = a UFO layer within an existing UFO, not its own UFO
  └── lineMetrics, italicAngle, guidelines...
```

**`FontAxis` / `GlyphAxis`** — two-level axis architecture:
```python
FontAxis      # font-level: has OT tag, user↔design space mapping (avar), hidden flag
GlyphAxis     # glyph-level: local to one glyph, no tag, same min/default/max
DiscreteFontAxis  # for roman/italic: discrete allowed values, no interpolation between them
```
All `Location` values throughout the system are always in **user space**. The backend handles avar mapping internally.

**`Component`** — variable components:
```python
Component
  ├── name: str
  ├── transformation: DecomposedTransform
  └── location: Location   # if non-empty → variable component (references base glyph's own design space)
```

**`PackedPath`** — flat array format matching Fontra's exactly:
```
coordinates: [x0, y0, x1, y1, ...]
pointTypes:  [ON_CURVE=0, OFF_CURVE_QUAD=1, OFF_CURVE_CUBIC=2, ON_CURVE_SMOOTH=8]
contourInfo: [{endPoint, isClosed}, ...]
```

### Backend Protocol — Follow Fontra's Duck-Typed Protocol

All backends implement the same async protocol (duck-typed, no base class):
```python
async def getGlyph(self, glyphName: str) -> VariableGlyph | None
async def getFontInfo(self) -> FontInfo
async def getAxes(self) -> Axes
async def getSources(self) -> dict[str, FontSource]
async def getGlyphMap(self) -> dict[str, list[int]]
async def getKerning(self) -> dict[str, Kerning]
async def getFeatures(self) -> OpenTypeFeatures
async def getUnitsPerEm(self) -> int
# Write variants: putGlyph, putAxes, putSources, etc.
```

`backendForPath()` factory selects by extension. Current backends:
- `core/backends/ufo.py` — read/write via `ufoLib2`
- `core/backends/opentype.py` — read-only compiled fonts via `fonttools`

**Planned: `core/backends/designspace.py`** — the most important missing backend. Follow Fontra's `DesignspaceBackend` directly:
- A `DSSource` wraps a `UFOLayer` + location + opaque identifier
- A `UFOLayer` wraps a UFO path + layer name; `fontraLayerName` = the stable key used in `VariableGlyph.layers`
- `UFOBackend` refactors to subclass `DesignspaceBackend` (wraps a single-source synthetic designspace)
- Layer name encoding: default layer = source identifier; non-default = `"{sourceId}^{ufoLayerName}"`
- `DiscreteVariationModel`: wraps fontTools `VariationModel`; splits locations into (discrete, continuous) parts; runs separate models per discrete slice

### Node Classes (`nodes/`)

**`ComfyFontNode`** (`nodes/comfyfont.py`) — display name: "ComfyFont"
- Input: `font` (COMBO of workspace filenames)
- Output: `font` (FONT — absolute workspace path)
- `get_font_list()` lives here, re-exported from `nodes/load.py` for `GET /comfyfont/fonts`
- Import Font + Edit Font buttons added by JS extension; COMBO widget from ComfyUI

**`DrawBotNode`** (`nodes/drawbot.py`) — display name: "DrawBot"
- Inputs: `font` (FONT), `preset` (COMBO), `canvas_width`, `canvas_height`; optional: `input_text`, `custom_script`
- Output: `image` (IMAGE)
- Presets are DrawBot Python scripts in `nodes/drawbot.PRESETS`; `exec()` with injected namespace

**Planned nodes:**
- `ForkFontNode` — deep-copies workspace entry to new name, enabling parallel AI experimentation
- `LoadFontFromGit` — git URL → FONT: clones repo, imports into workspace

### Core Library (`core/`)

- `compile.py` — `compile_ufo_to_ttf()`: UFO→TTF via fontmake
- `server.py` — `FontHandler`: per-font RPC subject; LRU cache, scheduled write queue, change broadcasting
- `remote.py` — `RemoteObjectConnection`: bidirectional JSON-RPC (mirrors Fontra's `RemoteObjectConnection`)
- `classes.py` — dataclasses: `VariableGlyph`, `GlyphSource`, `FontSource`, `FontAxis`, `Component`, `PackedPath`, etc.
- `path.py` — `PackedPath` utilities + `VarPackedPath` (JS-side equivalent: `packed-path.js`)
- `changes.py` — change application for undo/redo and remote sync (follow Fontra's change protocol)

### JavaScript (`js/`)

Plain ES modules, no bundler:

- `load-node-widget.js` — ComfyFont node customization: specimen preview (Path2D), Import/Edit buttons, `onConfigure` stale-value reset
- `editor-overlay.js` — full-screen editor shell (font overview + per-glyph tabs)
- `glyph-grid.js` — font overview grid, IntersectionObserver lazy rendering
- `glyph-editor-tab.js` — per-glyph bezier editor canvas
- `font-controller.js` — `FontController`: LRU glyph cache (500 max), WS connection keyed by font name
- `remote.js` — `RemoteObject` / `getRemoteProxy()`: WebSocket JSON-RPC client
- `packed-path.js` — `VarPackedPath`: glyph outline model → `Path2D` for canvas
- `canvas-controller.js` — HiDPI canvas with pan/zoom and Y-flip transform
- `visualization-layers.js` — drawing primitives for outlines, points, guides

### UI Design Language — Follow Runebender Xilem

The glyph grid and editor canvas follow Runebender Xilem's visual design. Key decisions:

**Color vocabulary** (from `runebender-xilem/src/theme.rs`):
- App background: `#101010`; panel background: `#1C1C1C`
- Signature accent: `#66EE88` — used for metric guides, selected cell borders, selected toolbar icons
- Smooth on-curve point: inner `#579AFF`, outer `#4428EC` (circle)
- Corner on-curve point: inner `#6AE756`, outer `#208E56` (square)
- Off-curve handle: inner `#CC99FF`, outer `#9900FF` (small circle)
- Selected point (any type): inner `#FFEE55`, outer `#FFAA33` — overrides all type colors

**Glyph grid layout** — bento-box, span-aware:
- Base cell: 128px wide, 192px tall, 6px gap
- Wide glyphs (advance width > UPM) and long names get proportionally more columns (span 2–3)
- Last cell in each row expands to fill — no ragged right edge
- Mark color = the entire cell border color (not a corner dot)
- Category filter sidebar: plain text list (All, Letter, Number, Punctuation, Symbol, Mark, Other)

**Glyph editor canvas:**
- Metric guides (descender, baseline, x-height, cap-height, ascender) in `#66EE88`
- Two-level zoom-responsive grid: mid zoom = 8/32 unit grid; close zoom = 2/8 unit grid; anchored to x=0
- Start node arrow: small filled triangle perpendicular to first on-curve point, offset ~8px
- Floating toolbars as absolute overlays (top-left), not chrome sidebars
- Interpolation errors: red circles on incompatible points + red pill badge in canvas (no modal dialogs)

### Entry Point (`__init__.py`)

ComfyUI integration: node registration, HTTP route mounting on `PromptServer`, WebSocket RPC, `folder_paths` registration.

Routes accept `?name=<filename>` (relative to FONTS_DIR) or `?path=<absolute>`.

### API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/comfyfont/import` | POST | Upload font → workspace + convert TTF↔UFO |
| `/comfyfont/fonts` | GET | JSON list of workspace font names |
| `/comfyfont/glyph_map` | GET | Glyph name → codepoints (`?name=` or `?path=`) |
| `/comfyfont/ws` | WebSocket | Long-lived RPC to `FontHandler` (`?name=` or `?path=`) |

### Serialization

`cattrs` (`structure`/`unstructure`) serializes dataclasses to/from JSON for the RPC wire protocol.

## Roadmap

Phase 1 (complete): workspace, ComfyFont node (COMBO), basic TTF/glyph rendering, DrawBot node

Phase 2 (in progress): editor overlay wiring, point editing

Phase 3 — Variable font / designspace support:
- `DesignspaceBackend` (port from Fontra)
- `DiscreteVariationModel`
- `FontAxis`, `FontSource`, `GlyphSource.locationBase` in data model
- Axis sliders on ComfyFont node
- `.designspace` in workspace + import route

Phase 4: ForkFont node, AI node protocol, git import
