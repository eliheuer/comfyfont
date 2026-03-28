# ComfyFont — Build Plan (v2)

A self-contained font editor embedded in a ComfyUI node.
Architecture closely follows Fontra's Python/JS split.

---

## Vision

One primary **ComfyFont Load** node — like Load Image but for fonts:
- Shows a live specimen preview ("AaBbCc 123") inside the node
- "Edit Font" button opens a full-screen overlay editor
- Outputs a `FONT` type consumed by rendering nodes

Separate lightweight rendering nodes:
- **TextRender** — FONT + text string → IMAGE + MASK
- **GlyphRender** — FONT + glyph name → IMAGE + MASK
- **FontComposite** — composite text over image using mask

---

## Editor UI (modeled on Glyphs.app / Runebender)

```
┌──────────────────────────────────────────────────────────────┐
│ ComfyFont — MyFont.ufo                          [✕ close]    │
├──────────────────────────────────────────────────────────────┤
│ [Font ×]  [A ×]  [g ×]  [ampersand ×]         [+]          │  ← tab bar
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Font tab (glyph grid):                                      │
│  ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐            │
│  │ A│ │ B│ │ C│ │ D│ │ E│ │ F│ │ G│ │ H│ │ I│            │
│  └──┘ └──┘ └──┘ └──┘ └──┘ └──┘ └──┘ └──┘ └──┘            │
│  Double-click a glyph → opens it in a new editor tab         │
│                                                              │
│  Glyph edit tab:                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │         bezier canvas (pan, zoom, Y-flip)            │   │
│  │    handles + on/off-curve points, drag to edit       │   │
│  └──────────────────────────────────────────────────────┘   │
│  xAdvance: 600    UPM: 1000    [← prev] [next →]            │
└──────────────────────────────────────────────────────────────┘
```

Interactions:
- First tab is always **Font** (glyph grid), cannot be closed
- Double-click glyph cell → opens glyph in new editor tab
- Tabs are closeable with ×
- Multiple glyphs can be open simultaneously
- Tab bar scrolls if many open
- Escape or ✕ button closes the overlay and returns to ComfyUI

---

## Font Library

All fonts are stored as **UFO source files** in `comfyfont/library/`.

When a TTF/OTF is loaded:
1. Outlines + metrics extracted via fonttools
2. Written to `comfyfont/library/<FamilyName>.ufo`
3. Node references the UFO path from then on

At render time: UFO compiled to TTF in-memory via fonttools for rasterisation.

---

## Tech Stack

| Layer | Tool |
|-------|------|
| Font I/O (TTF→UFO import) | `fonttools` + `cu2qu` + `ufoLib2` |
| Font I/O (UFO source) | `ufoLib2` |
| Glyph rendering → PIL | `fontTools.pens.FreeTypePen` |
| Text rendering | `Pillow` ImageFont |
| Specimen preview | Python renders PNG → base64 → JS draws on node |
| WebSocket RPC | `aiohttp` via `PromptServer` |
| JS canvas | ES modules, no build step |

---

## File Structure

```
comfyfont/
├── __init__.py                  # node registration + all routes
├── requirements.txt
├── library/                     # managed UFO font library
│   └── MyFont.ufo/
├── fonts/                       # drop TTF/OTF here to import
├── core/
│   ├── path.py                  # PackedPath, PointType (unchanged)
│   ├── classes.py               # VariableGlyph, StaticGlyph (unchanged)
│   ├── changes.py               # applyChange (unchanged)
│   ├── remote.py                # WS RPC engine (unchanged)
│   ├── server.py                # FontHandler (unchanged)
│   ├── library.py               # NEW: font import, TTF→UFO, library mgmt
│   └── backends/                # OTFBackend, UFOBackend (unchanged)
├── nodes/
│   ├── load.py                  # NEW: ComfyFontLoadNode (primary node)
│   └── render.py                # TextRenderNode, GlyphRenderNode, FontCompositeNode
└── js/
    ├── remote.js                # WS RPC client (unchanged)
    ├── packed-path.js           # VarPackedPath → Path2D (unchanged)
    ├── font-controller.js       # FontController + LRU cache (unchanged)
    ├── canvas-controller.js     # HiDPI canvas, pan/zoom (unchanged)
    ├── visualization-layers.js  # draw layers (unchanged)
    ├── load-node-widget.js      # NEW: node widget + specimen preview
    ├── editor-overlay.js        # NEW: full-screen overlay shell + tab bar
    ├── glyph-grid.js            # NEW: font overview / glyph grid tab
    └── glyph-editor-tab.js      # NEW: per-glyph bezier editor tab
```

---

## Build Phases

### Phase 1 — Font Library + Load Node (current)

**Python:**
- [ ] `core/library.py` — font library manager
  - `importFont(path)` → converts TTF/OTF to UFO, saves to `library/`
  - `listFonts()` → list of UFO names in library
  - `getSpecimen(ufoPath, text, width, height)` → PIL PNG of specimen text
- [ ] `nodes/load.py` — `ComfyFontLoadNode`
  - Inputs: `font` (COMBO from library), `specimen_text` (STRING)
  - Output: `FONT` (UFO path string)
- [ ] Routes:
  - `POST /comfyfont/import` — import TTF/OTF into library
  - `GET  /comfyfont/library` — list available fonts
  - `GET  /comfyfont/specimen?font=<name>&text=...` — returns PNG

**JS:**
- [ ] `load-node-widget.js`
  - Draws specimen image inside node via `onDrawBackground`
  - "Edit Font" button → opens overlay
  - Refreshes when font changes

### Phase 2 — Editor Overlay Shell + Glyph Grid

- [ ] `editor-overlay.js`
  - Full-page fixed overlay (z-index 9999)
  - Header bar: font name + close
  - Tab bar: permanent "Font" tab + closeable glyph tabs
- [ ] `glyph-grid.js`
  - Grid of all glyphs rendered as small canvas cells
  - Double-click → open glyph in editor tab
  - Search/filter

### Phase 3 — Glyph Editor Tab

- [ ] `glyph-editor-tab.js`
  - `CanvasController` + `drawAllLayers` (existing code)
  - Point select + drag edit
  - xAdvance display
  - Prev/next glyph navigation

### Phase 4 — Tools + Polish

- [ ] Pen tool (add points)
- [ ] Undo/redo
- [ ] Export UFO → TTF
- [ ] Variable font axis sliders

---

## Key Implementation Notes

### Specimen preview inside node (mirrors Load Image)

```javascript
nodeType.prototype.onDrawBackground = function(ctx) {
  if (this._specimenImg?.complete) {
    const [w, h] = this.size;
    const imgH = 80;
    ctx.drawImage(this._specimenImg, 4, h - imgH - 4, w - 8, imgH);
  }
};

async function refreshSpecimen(node, fontName) {
  const img = new Image();
  img.src = `/comfyfont/specimen?font=${encodeURIComponent(fontName)}`;
  img.onload = () => { node._specimenImg = img; node.setDirtyCanvas(true, false); };
}
```

### TTF → UFO import

```python
# core/library.py
from fontTools.ttLib import TTFont
import ufoLib2, os

def importFont(src_path, library_dir):
    tt = TTFont(src_path)
    ufo = ufoLib2.Font()
    # copy info, metrics, cmap, outlines
    ufo_path = os.path.join(library_dir, familyName + ".ufo")
    ufo.save(ufo_path, overwrite=True)
    return ufo_path
```

### Tab bar pattern

```javascript
class TabBar {
  constructor() {
    this.tabs = [{ id: "font", label: "Font", closeable: false }];
    this.active = "font";
  }
  openGlyphTab(glyphName) {
    if (!this.tabs.find(t => t.id === glyphName)) {
      this.tabs.push({ id: glyphName, label: glyphName, closeable: true });
    }
    this.activate(glyphName);
  }
}
```
