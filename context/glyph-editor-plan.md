# ComfyFont — Build Plan

## Vision

ComfyFont is a font editor embedded in ComfyUI. The editor is free and open source; revenue comes from cloud AI services (kerning, spacing, script extension, style interpolation). The editor is the sales funnel — it needs to be good enough that working type designers choose it over Glyphs/RoboFont for AI-assisted tasks.

Reference editors:
- **Fontra** — architecture, change protocol, edit lifecycle, undo/redo
- **Runebender Xilem** — visual design: colors, dimensions, UX patterns, keyboard shortcuts

**Dogfood milestone:** Open `assets/icons.ufo` in ComfyFont, draw or edit a glyph outline, save it back, and compile it into the icon font the toolbar uses.

---

## Checklist

### Phase 0 — Icon System

- [ ] **0a. Draw icons in `assets/icons.ufo`** *(design task — Eli)*
      Copied from runebender-xilem: select (E010), pen (E011), knife (E013),
      hand (E014), ruler (E015), text (E017). Rotate has no icon yet.
      Still needed: save (E000), undo (E001), redo (E002), fork (E003), ai-spark (E004).
- [x] **0b. Compilation pipeline** — `_maybe_compile_icons()` in `__init__.py`,
      static route `/comfyfont/assets/{filename}`
- [x] **0c. CSS wiring** — `@font-face` + `.cf-icon` in `glyph-editor-tab.js`
- [x] **0d. Replace emoji** — toolbar uses `\uE010`–`\uE017` codepoints

### Phase 1 — Editor Backbone

- [x] **1.** `js/changes.js` — Fontra change protocol (`applyChange`, `consolidateChanges`)
- [x] **2.** `js/change-recorder.js` — proxy-based forward+rollback recorder
- [x] **3.** `UndoStack` (128-entry) + `Cmd+Z/Shift+Z` in `glyph-editor-tab.js`
- [x] **4.** Tool class system — `BaseTool`, `SelectTool`, `PenTool`, stubs for rest
- [x] **5.** `js/edit-behavior.js` — smooth constraints (HandleFollow, MirrorHandle)
- [x] **6.** Arrow key nudge + Delete
- [x] **7.** Double-click toggle smooth (`ON_CURVE_SMOOTH` bit)

### Phase 2 — Glyph Editing

- [x] **8.** Component rendering — blue-gray fill, recursive resolve, LRU cache
- [x] **9.** Component selection + drag
- [x] **10.** Segment hover + insert (de Casteljau subdivision) via `js/segment-utils.js`
- [x] **11.** PenTool — add/close contours, smooth drag, close-path zone
- [x] **12.** Copy / paste / cut — JSON clipboard format

### Phase 3 — Glyph Grid

- [x] **13–20.** SVG cells, font info cache, 128×192px cells, span-aware bento layout,
      category sidebar, mark color rendering, info panel, mark color swatches

### Phase 4 — AI Nodes

- [x] **21.** `ForkFontNode` — deep-copy workspace entry (`nodes/fork.py`)
- [x] **22–24.** `AIKerningNode`, `AISpacingNode`, `AIGlyphSynthNode` — stubs with
      `_call_cloud_api` skeleton (`nodes/ai_nodes.py`)
- [x] **25.** Mark color filter — AI nodes read `customData.markColor` to target subsets

### Phase 5 — Variable Font

- [x] **26.** `DesignspaceBackend` — multi-master read/write, VariationModel interpolation
- [x] **27.** Axis sliders in editor header — broadcasts `setLocation()` to all tabs;
      glyph editor shows interpolated ghost at 18% opacity
- [x] **28.** Source selector — master pills in editor header, `setMaster()` propagation

---

## What's Next

- **0a** (design task): draw the remaining icons in `assets/icons.ufo`
- **AI nodes**: implement `_call_cloud_api` for kerning/spacing when cloud service is ready
- **KnifeTool / RulerTool / RotateTool**: implement beyond stubs
- **`getSpecimenAtLocation`** on the glyph grid: show interpolated previews at axis position
- **ForkFont node**: surface in ComfyUI with a specimen comparison workflow
