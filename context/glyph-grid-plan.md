# Glyph Grid Overhaul Plan

## Architecture Review: ComfyFont vs Fontra vs Runebender-Xilem

### Technology Comparison

| Concern | Fontra | Runebender-Xilem | ComfyFont (current) | ComfyFont (target) |
|---|---|---|---|---|
| Grid rendering | SVG + viewBox | Vello GPU (Masonry) | Canvas 2D (fixed-size square) | **SVG + viewBox** |
| Editor canvas | Canvas 2D | Vello GPU | Canvas 2D | Canvas 2D (keep) |
| Component model | Web Components | Xilem reactive views | Plain ES modules + DOM | Plain ES modules + DOM |
| Layout | CSS inline-block + magnification | Bento-box flex rows, span-aware | CSS auto-fill grid | **Bento-box flex rows** |
| Lazy loading | IntersectionObserver | Virtualized rows | IntersectionObserver | IntersectionObserver |
| Theming | CSS custom properties | Rust constants | Hardcoded hex | CSS variables from Runebender palette |
| Data | fontController.requestGlyphInstance() | Workspace bezpath | fc.getGlyph() → VariableGlyph | Same, + font info cached |

### Why SVG for grid cells (not canvas)

Fontra's SVG choice is correct for grid cells. The key reason is the `viewBox`:

> SVG's `viewBox` is a declarative coordinate-space mapping: "my content lives in font coordinates, scale to fill whatever CSS size I'm given." Canvas has a fixed pixel size baked in at creation time.

Concretely, this matters because:

1. **Span-aware cells have variable widths.** A 2-column cell is `2 * CELL_W + GAP` pixels wide. With canvas you'd need to recreate the canvas at the correct pixel size (which you don't know until layout). With SVG `viewBox="0 -ascender advanceWidth (ascender-descender)"` + `width: 100%`, it just works.

2. **No DPR math.** Canvas requires `canvas.width = logical * devicePixelRatio`, CSS scale-back, and redraw on display change. SVG renders at compositor resolution for free.

3. **Magnification is CSS-only.** Fontra's zoom control sets one CSS custom property — the browser reflows. With canvas the whole visible grid repaints.

4. **Labels are real DOM.** Glyph name + unicode are `<div>` children, styled by CSS — accessible, selectable, respond to theme variables automatically.

**Rule:** SVG for read-only display cells. Canvas for the interactive glyph editor (keeps HiDPI control, hit testing, imperative drawing).

**Code change:** Replace `<canvas>` + `_buildPath2D()` with `<svg viewBox="..."><path d="..."/>`. The path-building logic is the same — string concatenation instead of Path2D calls. ~30 lines of new code, remove ~80 lines of canvas setup + DPR handling.

**Verdict:**
- Switch grid cells from canvas to SVG (correct tool for the job — variable widths, free scaling)
- Fontra's web components are overkill — plain DOM is easier
- Runebender's visual design (colors, layout, label structure) is what we copy
- The bento-box span-aware layout is the most important structural feature to adopt

### Root cause of the current sizing bug

`glyph-grid.js` line 176: `const upm = advance > 0 ? advance : 1000;`

This uses the glyph's **advance width** as a proxy for UPM. For wide glyphs (em-dash, W, etc.) the advance is much larger than UPM → glyph is rendered tiny. For narrow glyphs (i, period) it's much smaller → glyph renders huge. The fix: fetch `fontInfo.unitsPerEm` + `ascender`/`descender` once at load time and use those for every cell.

---

## Checklist

### 1 — Switch cells from canvas to SVG (fixes scaling + unlocks span layout)
- [ ] In `GlyphGrid.load()`, fetch font info once: `const info = await this._fc.getFontInfo()`
- [ ] Store `this._upm`, `this._ascender`, `this._descender` on the grid instance
- [ ] Write `packedPathToSVGD(packedPath)` — same contour logic as `_buildPath2D` but returns a `d` string
- [ ] Replace `<canvas>` element with `<svg viewBox="0 {-ascender} {advance} {ascender-descender}">` per cell
  - The viewBox IS the scaling — no transform math needed for sizing
  - Y-flip: `<path transform="scale(1,-1)" d="..."/>` (font coords have Y up, SVG has Y down)
  - Width: `width="100%" height="auto"` — SVG fills the cell width whatever it is
- [ ] Remove all DPR handling, canvas width/height setup, and the `_paintCell` transform math
- [ ] Labels become `<div>` children below the SVG (not drawn on canvas)

### 2 — Update visual design to match Runebender theme
Use these exact colors from `theme.rs`:
- Cell background: `#1c1c1c` (`PANEL_BACKGROUND` = `BASE_B`)
- Cell border (normal): `#606060` (`GRID_CELL_OUTLINE` = `BASE_F`)
- Cell border (selected/hover): `#66ee88` (`GRID_CELL_SELECTED_OUTLINE`)
- Glyph fill (normal): `#a0a0a0` (`GRID_GLYPH_COLOR` = `BASE_J`)
- Glyph fill (selected): `#66ee88` (accent)
- Label text: `#808080` (`GRID_CELL_TEXT` = `BASE_H`)
- Label text (selected/hover): `#66ee88`
- App background: `#101010` (`BASE_A`)
- Gap between cells: `6px` (`BENTO_GAP`)

- [ ] Update CSS variables / hardcoded values to match above
- [ ] Draw cell as rounded rect with 8px radius (`PANEL_RADIUS`)
- [ ] Draw border stroke separately (not CSS `border`) so canvas cells match
- [ ] Labels inside the cell (not below): name line + `U+XXXX` line, anchored to bottom of cell

### 3 — Increase cell size
Current 80px cells are too small. Runebender uses taller cells with a fixed label area.
- [ ] Set cell width: `128px` base unit
- [ ] Set cell height: `192px` (= preview area + `56px` label zone, matching CLAUDE.md spec)
- [ ] Label zone height: `56px` at bottom of cell
- [ ] Preview zone: cell height minus label zone, inset by `8px` padding on all sides

### 4 — Span-aware bento-box layout
Replace `grid-template-columns: repeat(auto-fill, minmax(...))` with explicit row building.

Runebender's `compute_col_span` logic (port to JS):
```
name_span = name.length <= 14 ? 1 : name.length <= 26 ? 2 : 3
width_span = advance/upm <= 1.5 ? 1 : <= 2.8 ? 2 : <= 4.0 ? 3 : 4
span = max(name_span, width_span), capped at 4
```

Layout rules:
- Pack glyphs into rows of N columns (N = `floor(containerWidth / (CELL_W + GAP))`)
- Last cell in each row expands to fill remaining columns (no ragged right edge)
- Use `flex-row` + explicit `width` per cell: `cell_unit * span + gap * (span-1)`
- Gap = `6px` between all cells in both axes

- [ ] Implement `computeColSpan(glyphName, advanceWidth, upm)`
- [ ] Implement `packRows(glyphs, columns)` → array of rows, each row an array of `{glyph, span}`
- [ ] Implement `cellPixelWidth(span, cellUnit)`
- [ ] Replace CSS grid with explicit flex-row rendering
- [ ] Recompute layout on container resize (ResizeObserver)

### 5 — Category filter sidebar
Left panel, plain text list, same categories as Runebender:
- All / Letter / Number / Punctuation / Symbol / Mark / Separator / Other

Category assignment: use Unicode general category of the first codepoint:
- Letter: `L*` (Lu, Ll, Lt, Lm, Lo)
- Number: `N*`
- Punctuation: `P*`
- Symbol: `S*`
- Mark: `M*`
- Separator: `Z*`
- Other / No codepoint: everything else + `.notdef`-style names

- [ ] Add `<div class="cf-category-sidebar">` to the left of the grid
- [ ] Active category highlighted with `#66ee88` border (matching Runebender's green outline)
- [ ] Filtering re-runs `packRows` on the filtered glyph list
- [ ] Selected category stored as `this._category` on GlyphGrid instance

### 6 — Click selection
- [ ] Single-click selects a glyph (highlights cell with green border + accent fill color)
- [ ] Selected glyph name stored in `this._selected`
- [ ] Emit `onGlyphSelect(glyphName)` callback for the info panel
- [ ] Double-click opens editor tab (existing behavior)

### 7 — Glyph info panel (right sidebar)
When a glyph is selected, show:
- Glyph name
- Unicode (U+XXXX or "no unicode")
- Advance width
- Contour count
- (future: kerning groups)

- [ ] Add `<div class="cf-glyph-info-panel">` to the right of the grid in editor-overlay
- [ ] Populated by `onGlyphSelect` callback from the grid
- [ ] Width: ~180px, same dark panel style

### 8 — Wire up to editor-overlay.js
The category sidebar and info panel need to be added at the overlay level (3-column layout).

Current overlay layout:
```
[header]
[tabs]
[content pane]  ← GlyphGrid fills this entirely
```

New layout for the Font tab:
```
[header]
[tabs]
[category sidebar | grid | glyph info panel]
```

- [ ] In `_addFontTab()`, wrap the GlyphGrid in a 3-column layout
- [ ] Pass `onGlyphSelect` callback from overlay to grid → updates info panel
- [ ] Info panel updates reactively when selection changes

---

## Implementation Order

Do these in order — each step makes the grid visually better immediately:

1. **Fix scaling bug** (step 1) — single biggest improvement
2. **Bigger cells + Runebender colors** (steps 2 + 3)
3. **Labels inside cell** (part of step 2)
4. **Span-aware layout** (step 4)
5. **Category sidebar** (step 5)
6. **Click selection** (step 6)
7. **Info panel** (step 7 + 8)
