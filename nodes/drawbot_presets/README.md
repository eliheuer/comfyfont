# DrawBot Presets

Each `.py` file in this directory is a DrawBot script that appears as a preset
in the DrawBot node dropdown. Drop any DrawBot script here and it will be
available immediately after restarting ComfyUI.

## Available variables

Every script runs with these variables already defined:

| Variable     | Type   | Description                                      |
|--------------|--------|--------------------------------------------------|
| `font_path`  | `str`  | Absolute path to the loaded font file            |
| `WIDTH`      | `int`  | Canvas width in pixels                           |
| `HEIGHT`     | `int`  | Canvas height in pixels                          |
| `input_text` | `str`  | Value from the node's input_text field (or `""`) |

All DrawBot functions are available as globals: `font()`, `text()`, `textBox()`,
`rect()`, `oval()`, `fill()`, `stroke()`, `newPage()`, `image()`, etc.

## Naming and order

Files are loaded in alphabetical order. Use a numeric prefix to control the
position in the dropdown:

```
01_specimen.py   →  "Specimen"
02_waterfall.py  →  "Waterfall"
10_my_preset.py  →  "My Preset"
```

The display name is derived from the filename: the leading `digits_` prefix is
stripped, underscores become spaces, and the result is title-cased.

## Shared helpers

`helpers.py` contains utility functions available to all presets:

```python
from helpers import *

remap(value, inputMin, inputMax, outputMin, outputMax)  # range mapping
grid(margin, step=None, color=(1,0,0), weight=2)        # debug grid overlay
```

Add your own functions to `helpers.py` and they'll be available everywhere.

## Example

```python
# my_kerning_pairs.py
# Shows a list of kern pairs at a fixed size.

pairs = ["AV", "WA", "To", "Ty", "Va"]
size = HEIGHT / (len(pairs) + 1)

newPage(WIDTH, HEIGHT)
fill(0.05)
rect(0, 0, WIDTH, HEIGHT)
font(font_path, size * 0.7)
fill(1)
for i, pair in enumerate(pairs):
    y = HEIGHT - size * (i + 1)
    text(pair, (WIDTH / 2, y), align="center")
```
