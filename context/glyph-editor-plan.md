# ComfyFont Glyph Editor — Architecture & Build Plan

## Definition of Done

> **The project is complete when you can fully design and edit `assets/icons.ufo` inside
> ComfyFont itself — draw contours, move points, adjust handles, save — and compile the
> result into the icon font that the editor uses for its own toolbar.**

This is the dogfood milestone. It requires every core editing feature to actually work:
point selection, smooth constraints, pen tool, undo/redo, component resolution, glyph
grid, save to UFO. When you can sit down and draw a toolbar icon in ComfyFont and ship
it, the editor is real.

---

## What We Are Building and Why

ComfyFont is a font editor embedded in ComfyUI. The commercial model: the editor is free
and open source; the revenue is cloud AI services (kerning, auto-spacing, script
extension, style interpolation, component generation). The editor is the sales funnel —
it has to be good enough that working type designers choose it over Glyphs/RoboFont for
AI-assisted tasks. Local model support is a first-class feature; cloud services are the
paid upsell.

The two reference editors are:
- **Fontra** — Python/JS split architecture directly applicable to ComfyUI. We use its
  change protocol, edit lifecycle, async tool event stream pattern, and undo/redo design
  almost verbatim.
- **Runebender Xilem** — The last editor Eli worked on. We use its visual design exactly:
  colors, dimensions, UX patterns, keyboard shortcuts, tool state machines.

---

## Architecture Decisions (follow Fontra closely)

### Tool System

Each tool is a class with a standard interface. The current `glyph-editor-tab.js` puts
everything in one class with `if (this._activeTool === "select")` guards — this must be
replaced with a proper tool class system.

```js
class BaseTool {
  constructor(editor) {
    this.editor = editor;         // GlyphEditorTab
    this.cc = editor._cc;         // CanvasController
    this.isActive = false;
  }
  activate()   { this.isActive = true;  this._setCursor(); }
  deactivate() { this.isActive = false; }
  handleHover(event) {}
  async handleDrag(eventStream, initialEvent) {}
  handleKeyDown(event) {}
  _setCursor() { this.cc.canvas.style.cursor = "default"; }
}
```

Tools receive an **async iterable event stream** for drag handling (Fontra pattern). The
canvas wraps pointer events into an async generator — the tool `for await`s over it inside
`handleDrag`. This makes complex drag state machines readable (no `_isDragging` flags
scattered across the class).

```js
// Canvas event → async generator
_makeEventStream(canvas) {
  let resolve;
  const queue = [];
  canvas.addEventListener("pointermove", (e) => {
    queue.push(e);
    resolve?.(); resolve = null;
  });
  canvas.addEventListener("pointerup", (e) => {
    queue.push({ __done: true, event: e });
    resolve?.(); resolve = null;
  });
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise((r) => {
          if (queue.length) {
            const e = queue.shift();
            if (e.__done) r({ value: e.event, done: true });
            else r({ value: e, done: false });
          } else { resolve = () => r(this.next()); }
        })
      };
    }
  };
}
```

Drag threshold: **3px screen pixels** (Runebender) before drag events fire. Below 3px,
`pointerup` without drag = click.

Tools registered on `GlyphEditorTab`:
```
SelectTool   — select, drag, rect-select, transform handles
PenTool      — add points, open/close contours
KnifeTool    — cut contours
HandTool     — pan (wraps CanvasController pan)
RulerTool    — measurement display
RotateTool   — rotate selection
TextTool     — stub (future)
```

### Edit Lifecycle (Fontra pattern, simplified for single-user)

Fontra's `editBegin / editIncremental / editFinal` maps to our WebSocket RPC. The key
insight: **rollback changes must be built at drag-start**, not at drag-end. Every edit
must produce both a forward change and a rollback change simultaneously.

```js
// GlyphEditorTab.editGlyph(editFunc) — the only entry point for mutations
async editGlyph(editFunc) {
  const glyph = this._glyph;
  const layer = this._defaultLayer();
  try {
    const result = await editFunc(layer, glyph, this._sendIncremental.bind(this));
    // result = { changes, undoLabel }
    this._pushUndoRecord(result.changes, result.undoLabel);
    await this._fc.editFinal(this._glyphName, result.changes.change, result.changes.rollbackChange);
  } catch (err) {
    console.error("ComfyFont edit error:", err);
  }
}

// Simple wrapper for synchronous edits
async editAndRecord(editFunc) {
  await this.editGlyph(async (layer) => {
    const changes = recordChanges(layer, editFunc);
    return { changes, undoLabel: changes.label };
  });
}
```

**`recordChanges(subject, mutatorFunc)`** — port of Fontra's proxy-based recorder. Wraps
the layer in a Proxy, captures all mutations as forward + rollback changes simultaneously.
This is the hardest thing to port but the most important — everything else depends on it.

See: `src-js/fontra-core/src/change-recorder.js` in the Fontra repo. Port this file as
`js/change-recorder.js`.

### Client-Side Undo Stack (Fontra pattern)

Undo is **entirely client-side**. The server (Python backend) does not store history — it
just applies changes as they arrive. The client stores a `{ change, rollbackChange,
undoLabel, undoSelection, redoSelection }` record per edit.

```js
class UndoStack {
  constructor() { this.undo = []; this.redo = []; }
  push(record) { this.undo.push(record); this.redo = []; }
  updateTop(record) { if (this.undo.length) this.undo[this.undo.length-1] = record; }
  popUndo() { const r = this.undo.pop(); if (r) this.redo.push(r); return r; }
  popRedo() { const r = this.redo.pop(); if (r) this.undo.push(r); return r; }
}
```

During drag: `editIncremental` is sent but NOT pushed to the undo stack. Only `editFinal`
(mouse-up) pushes to the stack. Rapid edits on the same gesture coalesce via `updateTop`
rather than creating separate records (Runebender undo coalescing pattern).

External changes (from another ComfyUI session or an AI node completing) wipe the undo
stack for that glyph — no cross-session undo.

Max undo depth: **128 entries** (Runebender).

### Smooth Point Constraint System (Fontra EditBehavior, simplified)

This is what makes the editor feel like a real font editor. When you drag a smooth
on-curve point, its off-curve handles must rotate to stay tangent. When you drag one
handle of a smooth point, the opposite handle must mirror.

Port `edit-behavior.js` and `edit-behavior-support.js` from Fontra as
`js/edit-behavior.js`. The 7-point neighborhood rule table is the key. Simplified for
ComfyFont (we can start with just the most important rules):

**Rules to implement first (cover 90% of editing needs):**
1. `Move` — selected point moves by delta
2. `DontMove` — smooth unselected between two selected endpoints stays fixed
3. `RotateNext` — unselected off-curve next to a selected smooth point rotates to stay
   tangent (keep handle length, update angle)
4. `MirrorHandle` — when one handle is dragged on a smooth point, opposite handle mirrors
5. `ConstrainHorVerDiag` — shift-key snaps to 0°, 45°, 90° from handle root

The full Fontra rule table has ~20 rules for edge cases (tangent intersection, scaling
edit, etc.) — add those incrementally after the basics work.

**Two-pass application:**
1. Pass 1: apply delta to all selected points (transform pass)
2. Pass 2: fix all unselected points that have smooth constraints (constrain pass)

```js
function makeChangeForDelta(path, selection, delta, constrain=false) {
  const transforms = [];   // selected points: move by delta
  const constraints = [];  // unselected points: fix by rule

  for (let i = 0; i < path.pointTypes.length; i++) {
    const rule = matchRule(i, path, selection);
    if (rule.action === "Move")      transforms.push({ i, delta });
    if (rule.action === "Rotate")    constraints.push({ i, rule });
    if (rule.action === "Mirror")    constraints.push({ i, rule });
    if (rule.action === "DontMove")  { /* skip */ }
  }

  // Apply transforms, then constraints
  applyTransforms(path, transforms, constrain ? snapDelta(delta) : delta);
  applyConstraints(path, constraints);
}
```

### Change Protocol

Port Fontra's change protocol as-is. The format is already implemented in our
`core/changes.py`. The JS side needs `changes.js` (apply) and `change-recorder.js`
(record). The key functions:

```js
// Apply a change to a JS object
applyChange(subject, change, subjectClassDef)

// Record changes via proxy
recordChanges(subject, mutatorFunc) → ChangeCollector { change, rollbackChange }

// Consolidate a list of changes into a single tree
consolidateChanges(changes)
```

Path-specific operations on `VarPackedPath` (already in `packed-path.js`):
- `"=xy"` — set point coordinates
- `"insertPoint"` / `"deletePoint"`
- `"insertContour"` / `"deleteContour"`
- `"appendPath"`

---

## Icon System — `assets/icons.ufo`

### Concept

Runebender Xilem sources all toolbar icons from a UFO file (`assets/untitled.ufo`) where
each icon lives at a PUA codepoint (U+E010, U+E011, …). In Runebender this is a design
artifact only — paths are hand-transcribed as hardcoded Rust `BezPath` literals at
runtime. For ComfyFont we can do better: **compile the UFO to WOFF2 and use it as a
real icon font** via CSS `@font-face`. This is the standard web icon font pattern, and it
means icons render at any resolution for free.

The added bonus: the icon font is editable using ComfyFont itself. Dogfood.

### Directory

```
assets/
  icons.ufo/        ← source of truth (editable in ComfyFont)
  icons.woff2       ← pre-compiled, committed to repo
```

`assets/` is the right name — it's distinct from `js/` (served JS modules), `core/`
(Python), and `nodes/` (ComfyUI nodes). Static, non-Python, non-JS resources live here.

### PUA Codepoint Assignments

Follow Runebender's range starting at U+E000. Our 7 tool icons + UI icons:

| Codepoint | Name        | Used for                        |
|-----------|-------------|---------------------------------|
| U+E010    | select      | Select tool (arrow cursor)      |
| U+E011    | pen         | Pen tool                        |
| U+E012    | knife       | Knife tool                      |
| U+E013    | ruler       | Ruler/Measure tool              |
| U+E014    | hand        | Hand/Pan tool                   |
| U+E015    | rotate      | Rotate tool                     |
| U+E016    | text        | Text tool                       |
| U+E000    | save        | Save button                     |
| U+E001    | undo        | Undo                            |
| U+E002    | redo        | Redo                            |
| U+E003    | fork        | Fork Font (ComfyFont concept)   |
| U+E004    | ai-spark    | AI node indicator               |
| U+E020    | zoom-in     | Zoom in                         |
| U+E021    | zoom-out    | Zoom out                        |
| U+E022    | zoom-fit    | Zoom to fit                     |

Design in a 1000 UPM space, Y-up (standard UFO coordinates). Advance width = 1000.

### Compilation

`__init__.py` compiles `assets/icons.ufo → assets/icons.woff2` at startup if the .woff2
is missing or older than the UFO:

```python
import subprocess, os, time

ASSETS_DIR = os.path.join(os.path.dirname(__file__), "assets")
ICONS_UFO  = os.path.join(ASSETS_DIR, "icons.ufo")
ICONS_WOFF2 = os.path.join(ASSETS_DIR, "icons.woff2")

def maybe_compile_icons():
    if not os.path.exists(ICONS_UFO):
        return
    ufo_mtime = max(
        os.path.getmtime(os.path.join(root, f))
        for root, _, files in os.walk(ICONS_UFO)
        for f in files
    )
    if os.path.exists(ICONS_WOFF2) and os.path.getmtime(ICONS_WOFF2) >= ufo_mtime:
        return  # up to date
    subprocess.run(
        ["fontmake", "-u", ICONS_UFO, "-o", "variable", "--output-path", ICONS_WOFF2],
        check=True, capture_output=True
    )
```

The pre-compiled `icons.woff2` is committed to git so the extension works without a
fontmake recompile on every startup. Recompilation only triggers when the UFO is modified.

### CSS Usage

Serve `assets/icons.woff2` via a static route in `__init__.py`:

```python
routes.static("/comfyfont/assets", ASSETS_DIR)
```

In `theme.js` or a CSS stylesheet injected by the extension:

```css
@font-face {
  font-family: "ComfyFontIcons";
  src: url("/comfyfont/assets/icons.woff2") format("woff2");
}

.cf-icon {
  font-family: "ComfyFontIcons";
  font-size: 20px;
  color: #606060;
  speak: never;
  -webkit-font-smoothing: antialiased;
}
```

Tool buttons use the icon font by setting `textContent` to the Unicode character:

```js
const SELECT_ICON = "\uE010";
const PEN_ICON    = "\uE011";
// …

btn.textContent = SELECT_ICON;
btn.classList.add("cf-icon");
```

Icon color via CSS: unselected `#606060`, hovered `#66EE88`, active `#66EE88` — same as
Runebender's three icon states.

### Notes

- The current emoji placeholder icons (`🖱️`, `🖊️`, etc.) are replaced entirely.
- Emoji rendering is platform-inconsistent and has no color control — the icon font gives
  pixel-perfect, theme-consistent icons at any DPI.
- The UFO can be opened in ComfyFont and edited — changes are reflected after the next
  compile. This is the intended workflow for iterating on icon designs.
- `assets/icons.woff2` should be added to `.gitattributes` as a binary file.

---

## Tool Implementations

### SelectTool

States (explicit state machine, Runebender pattern):
```
Ready
DraggingPoints { lastPos, origCoords, behaviorFactory }
MarqueeSelect  { start, end, prevSelection, toggle }
```

**Mouse-down:**
- Hit test: points first, then path segments, then components
- If point hit → add to selection if not already; if shift → toggle; start `DraggingPoints`
- If segment hit → select adjacent points (optional: insert point on double-click)
- If empty → clear selection (no shift), start `MarqueeSelect`

**Drag loop:**
```js
async handleDrag(eventStream, initialEvent) {
  if (this._state.type === "DraggingPoints") {
    await this.editor.editGlyph(async (layer, glyph, sendIncremental) => {
      const factory = new EditBehaviorFactory(layer, this.editor._selectedPoints);
      for await (const event of eventStream) {
        const delta = { x: ..., y: ... };
        const behaviorName = getBehaviorName(event); // default|constrain|alternate
        const change = factory.getBehavior(behaviorName).makeChangeForDelta(delta);
        applyChange(layer, change);
        await sendIncremental(change);
      }
      return { changes: factory.buildChangeCollector(), undoLabel: "move points" };
    });
  }
}
```

**Double-click:**
- On smooth on-curve → `toggleSmooth()` (smooth ↔ corner)
- On corner on-curve → `toggleSmooth()`
- On empty space (in glyph context) → deselect all
- On component → open component's glyph in new tab

**Keyboard (all via `handleKeyDown`):**
- `Delete` / `Backspace` — delete selected points
- `←↑→↓` — nudge 1 unit; `+Shift` → 10 units; `+Cmd/Ctrl` → 100 units
- `Escape` — clear selection
- `A` — select all points in current contour (or all contours if already all selected)
- `Tab` — cycle through contour start points

**Hit testing priority** (Runebender): Points first, then path segments, then components.
Hit radius: 6px CSS (same as current `HIT_R`).

Segment hit testing: compute nearest point on cubic/quadratic segment using Newton
iteration; if distance < `HIT_R * 2`, highlight segment (orange `#FFAA33`).

### PenTool

Four phases per click: `setup → setupDrag → drag → noDrag` (Fontra PenToolBehavior
pattern). Context determines which functions run.

**Contexts:**
1. No open contour in progress → start new contour
2. Open contour in progress → append to it
3. Clicked near start of current open contour → close it
4. Clicked on another glyph's open endpoint → connect contours
5. Clicked on off-curve handle → delete it

**Click (no drag):** Add corner on-curve point.

**Click + drag:** Add smooth on-curve with two cubic handles. Handle-out tracks mouse.
Handle-in mirrors: `origin - (mouse - origin)`. Shift-lock constrains to 0°/45°/90°.

**Close path:** Within 20 design units of start point (visual indicator: dashed ring).

**Escape:** Finish current open path as-is.

**Insert on segment:** When PenTool hovers over a path segment (not a point), cursor
changes to "crosshair+" and click inserts a point at the parametric position via
de Casteljau subdivision.

### KnifeTool

Drag to draw a line across contours. Find all intersections via line-cubic intersection.
Split path at intersection points. Shift-lock to H/V.

Visual: dashed orange line while dragging, green X markers at intersections.

### HandTool

Wraps CanvasController pan. No edit operations.

---

## Component Rendering

Many glyphs are built from components (e.g., accented letters reference the base letter
plus an accent mark). The current editor shows nothing for these — a critical gap.

**Rendering approach:**
1. In `_draw()`, after drawing the primary layer's path, resolve components recursively:
   ```js
   async _resolveComponent(component) {
     const baseGlyph = await this._fc.getGlyph(component.name);
     const baseLayer = baseGlyph?.layerForMaster(this._masterId);
     if (!baseLayer) return null;
     return { path: baseLayer.path, transform: component.transformation };
   }
   ```
2. Draw resolved component paths in a distinct color (Runebender: `#6699CC` blue-gray,
   selected: `#88BBFF`).
3. Apply the component's `DecomposedTransform` as a canvas transform before drawing.
4. LRU cache resolved component glyphs (they don't change often).

**Component selection:** Single-click on a component's filled area selects it as a unit.
Drag moves the component's transformation `{translateX, translateY}` via a change to
`layers[layerName].glyph.components[i].transformation`.

**Component hit testing:** Winding number algorithm on the filled area (Runebender).

---

## Glyph Grid Overhaul

The grid is the first thing the user sees. Current state: canvas cells, wrong scaling,
too small.

### Switch to SVG cells (Fontra pattern — correct tool for the job)

Canvas cells require DPR math and exact pixel dimensions known at creation time. SVG with
`viewBox` gives declarative coordinate-space mapping for free.

```html
<svg viewBox="0 -800 780 1000" width="100%" height="auto" class="cf-cell-svg">
  <path transform="scale(1,-1)" d="M..." fill="#a0a0a0"/>
</svg>
```

The `viewBox` IS the scaling — `"0 {-ascender} {advance} {ascender-descender}"`. No DPR
handling, no redraw on zoom, no JavaScript sizing math.

**`packedPathToSVGD(packedPath)`** — same contour logic as the existing `_buildPath2D` in
`glyph-editor-tab.js` but returns an SVG `d` string instead of a `Path2D`. ~30 lines.

**Cell structure:**
```html
<div class="cf-cell" data-glyph="A">
  <svg viewBox="..." class="cf-cell-glyph">
    <path transform="scale(1,-1)" d="..." fill="var(--cell-glyph-color)"/>
  </svg>
  <div class="cf-cell-label">
    <span class="cf-cell-name">A</span>
    <span class="cf-cell-unicode">U+0041</span>
  </div>
</div>
```

Labels are real DOM — accessible, theme-responsive.

### Cell Dimensions (Runebender)

```
CELL_W = 128px
CELL_H = 192px
LABEL_H = 56px     (at bottom of cell)
CELL_PAD = 8px     (glyph preview inset)
GAP = 6px          (between cells, all axes)
PANEL_R = 8px      (cell border radius)
```

### Span-Aware Bento Layout (Runebender)

Replace `grid-template-columns: repeat(auto-fill, ...)` with explicit row building:

```js
function computeColSpan(glyphName, advance, upm) {
  const nameSpan = glyphName.length <= 14 ? 1 : glyphName.length <= 26 ? 2 : 3;
  const ratio = advance / upm;
  const widthSpan = ratio <= 1.5 ? 1 : ratio <= 2.8 ? 2 : ratio <= 4.0 ? 3 : 4;
  return Math.min(4, Math.max(nameSpan, widthSpan));
}

function packRows(glyphs, columns) {
  const rows = [];
  let row = [], used = 0;
  for (const g of glyphs) {
    const span = computeColSpan(g.name, g.advance, upm);
    if (used + span > columns) {
      // Expand last cell in row to fill
      if (row.length) row[row.length-1].span += columns - used;
      rows.push(row);
      row = []; used = 0;
    }
    row.push({ glyph: g, span });
    used += span;
  }
  if (row.length) {
    row[row.length-1].span += columns - used;
    rows.push(row);
  }
  return rows;
}
```

Cell pixel width: `span * CELL_W + (span-1) * GAP`.

Layout rendered as flex rows: each row is a `div.cf-row` with `display: flex; gap: 6px`.
Container `ResizeObserver` recomputes column count on resize.

### Mark Color System (UFO `public.markColor`)

Cell border color = mark color when set. Glyph fill color = mark color at 80% opacity.
Labels take mark color instead of default gray.

```js
function parseMarkColor(rgba) {
  // UFO format: "1,0.5,0,1" → "#FF8000"
  const [r, g, b] = rgba.split(",").map(Number);
  return `rgb(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)})`;
}
```

Mark color filter in sidebar: 7 color swatches (red, orange, yellow, green, teal, purple,
pink) from Runebender's palette. Click to filter or (when glyph selected) apply.

### Category Sidebar

```
All ──────── 312
Letter ───── 215
Number ────── 28
Punctuation ─ 34
Symbol ─────  24
Mark ────────  8
Other ───────  3
─────────────────
Colors
[×] [●] [●] [●] [●] [●] [●] [●]
```

Unicode general category from first codepoint. `.notdef`-style names → Other.

### GF Character Set Coverage (Phase 2)

Below the category sidebar:
```
GF Latin Kernel   193/194  ██████░
GF Latin Core     218/243  ████████
GF Latin Plus     312/489  ██████░░
```

Fetch `.nam` files from GitHub raw, parse, cache in `sessionStorage`. Missing glyphs
shown as ghost cells with dashed border and `+` button.

---

## Glyph Grid Info Panel (right sidebar)

When a glyph is selected:
```
A
U+0041 LATIN CAPITAL LETTER A
─────────────────────────────
Advance:  780
Contours: 2
Points:   31
Mark:     [no color]
─────────────────────────────
Glyph Groups
kern1.A (right group)
kern2.A (left group)
```

Width: 180px. Same dark panel style.

---

## Visualization & Grid Lines

**Metric guides** (in glyph editor canvas):
- Color: `#66EE88` (Runebender signature accent)
- Lines: baseline, x-height, cap-height, ascender, descender
- Clipped to advance-width rectangle (Runebender "metrics box" style)
- Advance width: `#66EE8840` (30% opacity accent)

**Unit grid** (shown at zoom ≥ 2× design units per screen pixel):
- Mid zoom (≥ 0.8× screen/unit): 8-unit subdivisions `rgba(136,136,136,0.25)`,
  32-unit grid `rgba(136,136,136,0.35)`
- Close zoom (≥ 4.0× screen/unit): 2-unit subdivisions, 8-unit grid
- Anchored to x=0, y=0

**Start point arrow:**
- Small filled triangle at first on-curve, perpendicular to curve direction
- Color: same as corner point (`#6AE756`)
- Size: 5.5px radius

**Segment hover highlight** (SelectTool hover over segment):
- `#FFAA33` orange, 3px stroke
- Indicates: click-drag will insert point here; alt+click converts line→curve

---

## Keyboard Shortcuts (full list — register in GlyphEditorTab)

```
V          SelectTool
P          PenTool
K          KnifeTool
H / Space  HandTool (Space = momentary pan)

←↑→↓       Nudge 1 unit
Shift+←    Nudge 10 units
Cmd+←      Nudge 100 units
Delete     Delete selected points
Escape     Clear selection (→ close tab if nothing selected)
A          Select all
Tab        Next contour start point
`          Toggle smooth ↔ corner (selected on-curve points)

Cmd+Z      Undo
Cmd+Shift+Z Redo
Cmd+C      Copy selection
Cmd+X      Cut selection
Cmd+V      Paste

Scroll     Zoom
Cmd+0      Zoom fit
Cmd++/-    Zoom in/out
```

---

## ComfyUI Node Integration

This is what makes ComfyFont distinct from all other font editors: **the font lives in
the ComfyUI node graph**. Editing a glyph in the editor writes back to the UFO on disk,
which is what the nodes operate on.

### Current node: ComfyFont (Load)

```
[ComfyFont: Epistle-Regular.ufo] → FONT
```

Outputs the UFO path. The editor is opened by clicking "Edit Font" on this node.

### Planned nodes

**ForkFont:**
```
FONT → [Fork Font: "kerning-experiment"] → FONT_B
```
Deep-copies the workspace UFO to a new name. Enables A/B comparison workflows.

**AIKerning:**
```
FONT → [AI Kerning: quiver-cloud | local:mistral] → FONT
         ↑ model: combo widget
         ↑ pairs: LIST (optional whitelist)
```
Writes kern pairs back to the UFO via the change protocol.

**AISpacing:**
```
FONT → [AI Spacing] → FONT
```
Computes sidebearings for selected glyph ranges.

**AIGlyphSynth:**
```
FONT + glyph_name: STRING → [AI Glyph Synth: mode=extend|restyle] → FONT
```
Synthesizes new glyph outlines. AI model receives glyph as list of bezier contours
(the `PackedPath` format is directly model-readable).

**DrawBot:**
```
FONT → [DrawBot: script] → IMAGE
```
Already exists. Used for specimen previews to compare AI results.

### The Mark Color ↔ AI Workflow

The key: mark colors are semantic labels that AI nodes can read. Workflow:
1. User marks "glyphs I'm happy with" in green
2. Marks "glyphs that need work" in red
3. `[AI: Fix Red Glyphs, reference=green]` node reads the mark colors, uses green glyphs
   as style reference, outputs modified FONT

This is the core product loop: human-in-the-loop AI-assisted type design.

---

## Implementation Order

### Phase 0 — Icon System (design task + pipeline setup)

- [ ] **0a. Draw icons in `assets/icons.ufo`** *(design task — Eli draws these)*
      - 1000 UPM, Y-up, advance = 1000, PUA U+E010–U+E016 for tools
      - Tool icons: select (E010), pen (E011), knife (E012), ruler (E013),
        hand (E014), rotate (E015), text (E016)
      - UI icons: save (E000), undo (E001), redo (E002), fork (E003), ai-spark (E004)
- [ ] **0b. Compilation pipeline** — `maybe_compile_icons()` in `__init__.py`,
      static route `/comfyfont/assets`, pre-compiled `assets/icons.woff2` in repo
- [ ] **0c. CSS wiring** — `@font-face` + `.cf-icon` class in `theme.js`
- [ ] **0d. Replace emoji** in `glyph-editor-tab.js` with icon font codepoints

### Phase 1 — Editor Backbone (makes the editor actually editable)

- [x] **1. Port `js/changes.js`** from Fontra — `applyChange(subject, change)` and
      change object format (`"="`, `"=xy"`, `"insertPoint"`, etc.)
- [x] **2. Port `js/change-recorder.js`** from Fontra — proxy-based recorder that
      simultaneously builds forward + rollback changes. Foundation for all editing.
- [x] **3. `UndoStack` + edit lifecycle** in `glyph-editor-tab.js`
      - `UndoStack` class (128-entry FIFO), `_doUndo()`, `_doRedo()`
      - `_recordDragUndo()` — builds =xy change set on pointerup, pushes to stack
      - `Cmd+Z / Cmd+Shift+Z` wired in `_onKey`
      - VarPackedPath mutation methods added to `packed-path.js`
      - `layerNameForMaster()` added to `VariableGlyphController`
- [x] **4. Tool class system** — refactor `glyph-editor-tab.js`
      - `BaseTool` base class, async event stream generator
      - `SelectTool` fully implemented using the new backbone
      - All other tools as stubs (activate, setCursor, correct identifier)
- [x] **5. Smooth point constraints** — `js/edit-behavior.js`
      - Port `EditBehaviorFactory` from Fontra (simplified: 5 essential rules)
      - Wire into `SelectTool` drag loop
      - This is what makes dragging points feel like a real font editor
- [x] **6. Arrow key nudge + Delete** — wired to `editAndRecord()`
- [x] **7. Double-click toggle smooth** — flip `ON_CURVE_SMOOTH` bit on selected points

### Phase 2 — Missing Features (real glyph editing)

- [x] **8. Component rendering** — resolve components recursively, draw in blue-gray
      (`#6699CC`), LRU cache
- [x] **9. Component selection + drag** — click fills area to select, drag moves
      `transformation.translateX/Y` via change protocol
- [x] **10. Segment hover + hit testing** — orange highlight on hovered segment,
       click inserts point via de Casteljau subdivision
- [x] **11. PenTool** — add/close contours; smooth drag with handle mirroring;
       close-path zone (20 design units from start); Escape finishes open path
- [x] **12. Copy / paste / cut** — serialize selected contours to clipboard as JSON

### Phase 3 — Glyph Grid Overhaul

- [x] **13. SVG cells** — replace canvas cells; `packedPathToSVGD()`, viewBox scaling
- [x] **14. Font info cache** — fetch `upm`, `ascender`, `descender` once on load
- [x] **15. Cell dimensions** — 128×192px, 56px label zone, Runebender colors
- [x] **16. Span-aware bento layout** — `computeColSpan()`, `packRows()`, flex rows,
       `ResizeObserver` recompute
- [x] **17. Category sidebar** — filter by Unicode general category
- [x] **18. Mark color rendering** — cell border + glyph fill from `public.markColor`
- [x] **19. Click selection + glyph info panel** — right sidebar, 180px wide
- [x] **20. Mark color sidebar** — 7 swatches, filter + apply to selected glyph

### Phase 4 — AI Nodes

- [ ] **21. ForkFont node** — deep-copy workspace entry to new name
- [ ] **22. AIKerning node** — stub + cloud API skeleton
- [ ] **23. AISpacing node** — stub
- [ ] **24. AIGlyphSynth node** — stub
- [ ] **25. Mark color ↔ AI workflow** — nodes read `customData.markColor`

### Phase 5 — Variable Font Support

- [ ] **26. DesignspaceBackend** — port from Fontra
- [ ] **27. Axis sliders** on ComfyFont node and glyph editor
- [ ] **28. Source selector** in glyph editor (edit Master A vs Master B)

---

**Dogfood milestone (Definition of Done):** When items 0–12 are complete and you can
open `assets/icons.ufo` in ComfyFont, draw or edit a glyph outline, and save it back,
the editor is real.

---

## Files to Create or Rewrite

| File | Status | Action |
|------|--------|--------|
| `assets/icons.ufo` | missing | create: draw 15 icons at PUA U+E000–U+E022 |
| `assets/icons.woff2` | missing | create: pre-compiled from icons.ufo, commit to repo |
| `js/change-recorder.js` | missing | create (port from Fontra) |
| `js/changes.js` | missing | create (port from Fontra) |
| `js/edit-behavior.js` | missing | create (port from Fontra, simplified) |
| `js/glyph-editor-tab.js` | exists (basic) | major rewrite with tool system + undo |
| `js/glyph-grid.js` | exists (broken) | major rewrite with SVG + bento layout |
| `js/editor-overlay.js` | exists (good) | extend: info panel, master selector |
| `js/canvas-controller.js` | exists (fixed) | extend: unit grid, start arrow |
| `core/backends/ufo.py` | exists | add: `customData.markColor` read/write |
| `nodes/fork.py` | missing | create: ForkFontNode |
| `nodes/ai.py` | missing | create: AIKerning, AISpacing, AIGlyphSynth stubs |

---

## Visual Design Reference (Runebender — use these exact values)

### Colors
```
App background:          #101010
Panel background:        #1C1C1C
Accent / metric guides:  #66EE88
Outline stroke:          #C0C0C0
Glyph fill (grid):       #A0A0A0
Handle line:             #909090

Corner on-curve fill:    #6AE756    stroke: #208E56    shape: square
Smooth on-curve fill:    #579AFF    stroke: #4428EC    shape: circle
Off-curve handle fill:   #CC99FF    stroke: #9900FF    shape: small circle
Selected (any):          #FFEE55    stroke: #FFAA33    overrides type
Component fill:          #6699CC    selected: #88BBFF

Segment hover:           #FFAA33    (orange, 3px)
Selection marquee fill:  rgba(255,170,51,0.12)
Selection marquee stroke:#FFAA33

Grid fine lines:         rgba(136,136,136,0.25)
Grid coarse lines:       rgba(136,136,136,0.35)

Cell normal border:      #606060
Cell selected border:    #66EE88
Cell selected bg:        #146414
Cell label text:         #808080
Cell label selected:     #66EE88
```

### Point Radii (physical px)
```
Smooth on-curve:   4.5px  (selected: 5.5px)
Corner on-curve:   3.5px  (selected: 4.5px)   shape: square
Off-curve handle:  3.0px  (selected: 4.0px)
Start arrow:       5.5px half-size
```

### Dimensions
```
Toolbar button: 48×48px, radius 6px, border 1.5px
Toolbar padding: 8px outer, 6px between buttons
Cell: 128×192px, label zone 56px, preview pad 8px
Gap (all): 6px
Panel radius: 8px
Drag threshold: 3px screen
Nudge: 1 / 10 / 100 units (plain / Shift / Cmd)
Undo depth: 128
Close-path zone: 20 design units
```

### Mark Color Palette
```
Red:    #FF4040   UFO: "1,0.251,0.251,1"
Orange: #FF9933   UFO: "1,0.6,0.2,1"
Yellow: #FFDD33   UFO: "1,0.867,0.2,1"
Green:  #22BB77   UFO: "0.133,0.733,0.467,1"
Teal:   #00CCBB   UFO: "0,0.8,0.733,1"
Purple: #9955DD   UFO: "0.6,0.333,0.867,1"
Pink:   #DD55AA   UFO: "0.867,0.333,0.667,1"
```
