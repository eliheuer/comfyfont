# Glyph Editor — Demo Readiness Checklist

Reference: Runebender Xilem (images #13–15), Fontra
Current file: `js/glyph-editor-tab.js`

---

## Critical for Demo (do these first)

- [x] Canvas and root background match theme (`T.bg = #101010`, `T.panel = #1c1c1c`)
- [x] Metric guide lines use real font metrics (ascender, descender, xHeight, capHeight)
      read from `fontController.getFontInfo()` — currently hardcoded to 800/-200/700/500
- [x] Metric line colors: use `T.accent` (#66ee88) like Runebender, not the current dark grays
- [x] Point colors: Runebender vocabulary
      - Corner on-curve (square):  fill `#6AE756`, stroke `#208E56`
      - Smooth on-curve (circle):  fill `#579AFF`, stroke `#4428EC`
      - Off-curve handle (circle): fill `#CC99FF`, stroke `#9900FF`
- [x] Handle lines: lighter gray, not near-black `#334466`
- [x] Outline stroke: neutral gray (e.g. `T.glyphFill` #a0a0a0), not blue `#8899cc`
- [x] Outline fill: very faint, 8–12% opacity, neutral white
- [x] Advance-width vertical guide: `T.accent` at low opacity (~30%), not green `#2e3a2e`
- [x] Remove zoom slider from toolbar — use scroll-wheel zoom only (already works)
- [x] Toolbar styling: match bento panel style (T.panel bg, T.border outline, PANEL_R radius,
      GAP padding) — currently uses stale `#222`/`#333` hardcoded colors
- [x] Add placeholder toolbar tool buttons (7 icon pills like Runebender, grayscale at rest)
      Tools: Select ▶, Pen ✏, Knife ✂, Ruler 📏, Hand ✋, Rotate ↺, Text T
      Only Select needs any behavior for demo; others are visual stubs
- [x] `zoomFit` uses actual glyph bounding box, not `(0, -200, advance, upm)`
- [x] Keyboard: ← → navigate between glyphs (already wired, verify works)

## Nice-to-have (if time allows)

- [x] Glyph name + metrics info bar at top toolbar: glyph name, advance, point count, sel count
- [ ] Start-point arrow (small filled triangle at first on-curve, perpendicular to curve dir)
- [ ] Grid lines at zoom > 4× (subtle 1-unit grid anchored to origin)
- [x] Escape key: deselect all (falls through to close overlay when nothing selected)

## Out of scope for demo

- Point selection / drag editing
- Undo/redo
- Pen tool drawing
- Kerning display
- Variable font axis sliders

---

## Current Bugs to Fix

1. **UPM hardcoded**: `const upm = 1000` in `_draw()` — must read from `fontInfo`
2. **Metric positions hardcoded**: 800, -200, 700, 500 — must use real fontInfo values
3. **Wrong draw space**: `_draw()` does `ctx.setTransform(1,0,0,1,0,0)` (pixel space),
   then manually calls `cc.sceneToCanvas()` everywhere — inconsistent, should use
   CanvasController's y-flip transform and draw in scene coords
4. **`zoomFit` args wrong**: passes `(0, -200, advance, upm, 32)` which is
   `(xMin, yMin, width, height, padding)` — should pass the actual glyph bbox
5. **Toolbar color leak**: uses `#1a1a1a`/`#222`/`#333` — not from theme

---

## Color Reference (Runebender vocabulary — already in theme.js MARK_COLORS)

| Element              | Fill      | Stroke   |
|----------------------|-----------|----------|
| Corner on-curve      | #6AE756   | #208E56  |
| Smooth on-curve      | #579AFF   | #4428EC  |
| Off-curve handle     | #CC99FF   | #9900FF  |
| Selected (any)       | #FFEE55   | #FFAA33  |
| Metric guides        | #66EE88   | —        |
| Outline stroke       | #a0a0a0   | —        |
| Handle line          | #505050   | —        |
| Advance width guide  | #66EE8840 | —        |
