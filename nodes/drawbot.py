"""
DrawBot rendering node — uses drawbot-skia to render type specimens.

Each preset is a standalone DrawBot script. The following variables are
injected into every script's execution context:

    font_path   — absolute path to the loaded font file
    WIDTH       — canvas width in pixels
    HEIGHT      — canvas height in pixels
    input_text  — value from the optional text input

All drawbot-skia functions (font, text, textBox, rect, fill, etc.) are
also available as globals, matching the DrawBot scripting API.
"""

from __future__ import annotations

import os
import tempfile

from PIL import Image

from .render import _pil_to_tensor, _resolve_font

# ---------------------------------------------------------------------------
# Built-in preset scripts

PRESETS: dict[str, str] = {}

PRESETS["specimen"] = """\
newPage(WIDTH, HEIGHT)

# Dark background
fill(0.1)
rect(0, 0, WIDTH, HEIGHT)

# Alphabet rows, auto-fitted to fill the canvas
lines = [
    "ABCDEFGHIJKLM",
    "NOPQRSTUVWXYZ",
    "abcdefghijklm",
    "nopqrstuvwxyz",
    "0123456789",
]
padding = HEIGHT * 0.05
size = (HEIGHT - padding * 2) / (len(lines) * 1.25)
font(font_path, size)
fill(1)
for i, line in enumerate(lines):
    text(line, (WIDTH / 2, HEIGHT - padding - size * (i + 1)), align="center")
"""

PRESETS["waterfall"] = """\
newPage(WIDTH, HEIGHT)

fill(0.1)
rect(0, 0, WIDTH, HEIGHT)

sample = input_text or "The quick brown fox"
margin = WIDTH * 0.04
y = HEIGHT - margin
fill(1)
for size in [96, 72, 60, 48, 36, 28, 24, 18, 14, 12]:
    if y < margin:
        break
    font(font_path, size)
    text(sample, (margin, y))
    y -= size * 1.4
"""

PRESETS["glyph"] = """\
newPage(WIDTH, HEIGHT)

fill(0.1)
rect(0, 0, WIDTH, HEIGHT)

# Set input_text to the character or glyph name you want to display
font(font_path, HEIGHT * 0.75)
fill(1)
text(input_text or "A", (WIDTH / 2, HEIGHT * 0.15), align="center")
"""

PRESETS["pangram"] = """\
newPage(WIDTH, HEIGHT)

fill(0.1)
rect(0, 0, WIDTH, HEIGHT)

margin = WIDTH * 0.06
font(font_path, HEIGHT * 0.075)
fill(1)
textBox(
    input_text or "The quick brown fox jumps over the lazy dog.",
    (margin, margin, WIDTH - margin * 2, HEIGHT - margin * 2),
)
"""

PRESETS["custom"] = """\
# Write any DrawBot script here, or wire a Text node to the custom_script input.
#
# Available variables:
#   font_path   — absolute path to the loaded font
#   WIDTH       — canvas width
#   HEIGHT      — canvas height
#   input_text  — value from the text input field
#
# All DrawBot functions are available as globals: font(), text(), fill(), etc.

newPage(WIDTH, HEIGHT)

fill(0.1)
rect(0, 0, WIDTH, HEIGHT)

font(font_path, 80)
fill(1)
text(input_text or "Aa", (WIDTH / 2, HEIGHT / 2 - 40), align="center")
"""

# ---------------------------------------------------------------------------


class DrawBotNode:
    """
    Render a type specimen using DrawBot (drawbot-skia).

    Pick a preset from the dropdown for common specimen types, or select
    "custom" and write your own DrawBot script in the custom_script field.
    You can also wire a Text node to custom_script for external script files.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "font":          ("FONT",),
                "preset":        (list(PRESETS.keys()), {}),
                "canvas_width":  ("INT", {"default": 1200, "min": 64, "max": 4096, "step": 8}),
                "canvas_height": ("INT", {"default": 800,  "min": 64, "max": 4096, "step": 8}),
            },
            "optional": {
                # input_text feeds into scripts as the `input_text` variable.
                # Used by: waterfall (sample string), glyph (character), pangram (body text).
                "input_text": ("STRING", {"default": ""}),
                # custom_script is only used when preset == "custom".
                # Shows as an editable text area; right-click → "Convert to input"
                # to wire a Text node instead.
                "custom_script": ("STRING", {
                    "multiline": True,
                    "default":   PRESETS["custom"],
                }),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "render"
    CATEGORY = "ComfyFont"

    def render(
        self,
        font: str,
        preset: str,
        canvas_width: int,
        canvas_height: int,
        input_text: str = "",
        custom_script: str = "",
    ):
        try:
            import drawbot_skia.drawbot as db
        except ImportError:
            raise RuntimeError(
                "drawbot-skia is not installed. "
                "Run: pip install drawbot-skia"
            )

        font_path = _resolve_font(font)
        script = custom_script if preset == "custom" else PRESETS[preset]

        # Build the execution namespace: context variables + all drawbot functions
        namespace: dict = {
            "font_path":  font_path,
            "WIDTH":      canvas_width,
            "HEIGHT":     canvas_height,
            "input_text": input_text,
        }
        for name in dir(db):
            if not name.startswith("_"):
                namespace[name] = getattr(db, name)

        db.newDrawing()
        try:
            exec(script, namespace)  # noqa: S102
        except Exception as exc:
            db.endDrawing()
            raise RuntimeError(f"DrawBot script error: {exc}") from exc

        # Save to a temp file (saveImage only accepts file paths, not BytesIO)
        tmp = tempfile.mktemp(suffix=".png")
        try:
            db.saveImage(tmp)
            # drawbot-skia may suffix the filename for multi-page output
            path = tmp if os.path.exists(tmp) else tmp.replace(".png", "_1.png")
            img = Image.open(path).convert("RGB")
        finally:
            for candidate in (tmp, tmp.replace(".png", "_1.png")):
                if os.path.exists(candidate):
                    os.unlink(candidate)

        db.endDrawing()

        return (_pil_to_tensor(img),)
