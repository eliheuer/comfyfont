# Sidebar Features Plan: Mark Colors + GF Character Sets

## Feature 1: Mark Color System

### What it is
Mark colors are semantic labels stored directly in the UFO source as `public.markColor` in each glyph's `lib.plist`. They're RGBA strings like `"1,0.5,0,1"`. Runebender has 7 colors + clear. This is the primary mechanism for AI-assisted workflows: "make all red glyphs more like the green glyphs."

### How UFO stores it
```xml
<!-- glyphs/A_.glif lib.plist -->
<dict>
  <key>public.markColor</key>
  <string>1,0.5,0,1</string>   <!-- normalized R,G,B,A 0–1 -->
</dict>
```

### Color palette (from Runebender theme.rs + visual match)
| Index | Hex | RGBA string |
|-------|-----|-------------|
| 0 | `#FF5533` | `1,0.333,0.2,1` |
| 1 | `#FF9911` | `1,0.6,0.067,1` |
| 2 | `#CCDD00` | `0.8,0.867,0,1` |
| 3 | `#44DD44` | `0.267,0.867,0.267,1` |
| 4 | `#00CCBB` | `0,0.8,0.733,1` |
| 5 | `#9944CC` | `0.6,0.267,0.8,1` |
| 6 | `#CC44AA` | `0.8,0.267,0.667,1` |

### Backend changes required

**`core/backends/ufo.py` — `_glyphToVariableGlyph()`:**
Add `customData` to the `VariableGlyph`:
```python
customData = {}
mark = ufoGlyph.lib.get("public.markColor")
if mark:
    customData["markColor"] = mark

return VariableGlyph(
    name=glyphName,
    axes=[],
    sources=[source],
    layers={"default": layer},
    customData=customData,   # ← add this
)
```

**`core/classes.py` — `VariableGlyph`:**
Add `customData: dict = field(default_factory=dict)` if not already present.

**`core/server.py` — write support:**
Add a `putMarkColor(glyphName, markColor)` RPC method (or reuse `editFinal` with a change object targeting `glyphs/{name}/customData/markColor`).

**`core/backends/ufo.py` — write back:**
When `markColor` changes via `putGlyph`, write `ufoGlyph.lib["public.markColor"] = value` (or delete the key if None).

### Frontend changes

**`glyph-grid.js`:**
- Read `glyph.customData?.markColor` from `VariableGlyphController`
- Parse RGBA string → hex color
- Apply to cell: border color + SVG path fill (replaces default `#a0a0a0` / `#606060`)
- Cache mark colors in a `Map<glyphName, hexColor>` so cells reuse the value without refetching

**Sidebar — Colors section (below Categories):**
```
Colors
[X]  [●]  [●]  [●]  [●]  [●]  [●]  [●]
     red  org  ylw  grn  tel  pur  pnk
```
- `[X]` = clear color filter / clear color on selected glyph
- Click a swatch = filter grid to show only glyphs of that color (OR if a glyph is selected, apply that color to it)
- Active filter: swatch gets `#66ee88` ring

**Cell rendering with mark color:**
- Border: mark color (replaces `#606060`)
- SVG path fill: mark color (replaces `#a0a0a0`)
- Labels: mark color (replaces `#808080` / `#505050`)
- On hover/select: brighten slightly

### AI workflow note
The mark color being stored in the UFO means it persists through compile/export cycles. AI nodes can read it via `getGlyph().customData.markColor`, filter glyphs by color group, and use that grouping as semantic input. Example prompt: "Glyphs tagged red are too narrow compared to the green ones — adjust spacing."

---

## Feature 2: Google Fonts Character Set Coverage

### What it is
GF publishes character set definitions for different language/script targets. A font needs GF Latin Core to be accepted into Google Fonts. Glyphs.app shows "Mac Roman 213/243" style coverage counts in its sidebar, letting you see at a glance what's missing.

### Data source
Pre-compiled `.nam` files in the `googlefonts/glyphsets` repo. Format:
```
0x0024 # DOLLAR SIGN
0x0025 # PERCENT SIGN
...
```
Available sets: Latin Kernel, Latin Core, Latin Plus, Latin African, Latin Vietnamese, Cyrillic Core/Plus/Pro, Greek Core/Plus/Pro, and more.

**These files are static and rarely change.** We can fetch them at runtime from GitHub raw URLs (with caching) or embed a baked-in copy of the most important ones.

### Frontend implementation

**`glyph-grid.js` sidebar — new "Character Sets" section:**
```
Character Sets          [+]
GF Latin Kernel   193/194  ███████░
GF Latin Core     218/243  ████████
GF Latin Plus     312/489  ██████░░
```
- Each row: set name, `have/total` count, simple progress bar
- Click a row: filter grid to show only glyphs IN that set (covered + missing)
- Click again or special button: filter to MISSING ONLY (glyphs in the set but not in the font)
- Missing glyphs shown as empty placeholder cells with a `+` button to add stub

**`js/gf-character-sets.js` — new module:**
```js
// Codepoints indexed by set name
// Fetched once from GitHub raw, parsed, and cached in sessionStorage

const GF_SETS = {
  'GF Latin Kernel': [0x0020, 0x0021, ...],
  'GF Latin Core':   [0x0020, 0x0021, ...],
  // etc.
};

export async function loadGFSets() { ... }
export function coverage(setName, glyphMapCodepoints) {
  // returns {have, total, missing: [codepoint, ...]}
}
```

**Parsing `.nam` files:**
```js
function parseNam(text) {
  return text.split('\n')
    .filter(l => l.match(/^0x[0-9A-Fa-f]+/))
    .map(l => parseInt(l.split(' ')[0], 16));
}
```

**`.nam` URLs to fetch:**
```
https://raw.githubusercontent.com/googlefonts/glyphsets/main/data/results/nam/GF_Latin_Kernel.nam
https://raw.githubusercontent.com/googlefonts/glyphsets/main/data/results/nam/GF_Latin_Core.nam
https://raw.githubusercontent.com/googlefonts/glyphsets/main/data/results/nam/GF_Latin_Plus.nam
https://raw.githubusercontent.com/googlefonts/glyphsets/main/data/results/nam/GF_Cyrillic_Core.nam
https://raw.githubusercontent.com/googlefonts/glyphsets/main/data/results/nam/GF_Greek_Core.nam
```
Cache parsed results in `sessionStorage` to avoid re-fetching on every overlay open.

### "Missing glyphs" view
When filtered to a GF set + showing missing:
- Grid shows ghost cells for each missing codepoint (dark, dashed border)
- Ghost cell shows the character + codepoint, no glyph shape
- `+` button on a ghost cell: creates a stub glyph (blank path, correct advance) via `putGlyph`
- This requires a `putGlyph` backend method (UFO backend: `self._font.newGlyph(name)`, set unicodes)

---

## Implementation Order

### Phase A — Mark colors (self-contained, high value)
1. Backend: expose `customData.markColor` from UFO + OTF backends
2. Backend: `putMarkColor` RPC (or `editFinal` change path)
3. Frontend: read mark color in `_loadCellSVG`, apply to cell border + glyph fill
4. Frontend: Colors section in sidebar (filter by color + apply to selected)

### Phase B — GF character sets (frontend-only to start)
1. `gf-character-sets.js` module: fetch + parse + cache `.nam` files
2. Sidebar coverage display (read-only first)
3. Filter grid to a set (show which glyphs are present)
4. Filter to missing glyphs (ghost cells, no add yet)

### Phase C — Add missing glyphs
1. Backend: `putGlyph` / `putGlyphMap` for new glyph creation
2. Frontend: `+` button on ghost cells

---

## What needs to change in `VariableGlyph`

Check `core/classes.py` — if `VariableGlyph` already has a `customData` field, we just need the UFO backend to populate it. If not, add:
```python
@dataclass
class VariableGlyph:
    name: str
    axes: list = field(default_factory=list)
    sources: list = field(default_factory=list)
    layers: dict = field(default_factory=dict)
    customData: dict = field(default_factory=dict)   # ← add if missing
```
The JS `VariableGlyphController` already has `this.customData = data.customData ?? {}` so no JS change needed there.
