"""
DrawBot rendering node — uses drawbot-skia to render type specimens.

Preset scripts live in nodes/drawbot_presets/*.py. Each file is a plain
DrawBot script; drop any .py file there and it appears in the dropdown after
restarting ComfyUI. See drawbot_presets/README.md for details.

The following variables are injected into every script's execution context:

    font_path   — absolute path to the loaded font file
    WIDTH       — canvas width in pixels
    HEIGHT      — canvas height in pixels
    input_text  — value from the optional text input (string, may be empty)

All drawbot-skia functions are also available as globals.
"""

from __future__ import annotations

import os
import re
import sys
import tempfile

from PIL import Image

from .render import _pil_to_tensor, _resolve_font

# ---------------------------------------------------------------------------
# Preset loader

_PRESETS_DIR = os.path.join(os.path.dirname(__file__), "drawbot_presets")


def _name_from_filename(filename: str) -> str:
    """'02_waterfall.py' → 'Waterfall',  'my_kern_pairs.py' → 'My Kern Pairs'"""
    stem = os.path.splitext(filename)[0]
    stem = re.sub(r"^\d+_", "", stem)   # strip leading numeric prefix
    return stem.replace("_", " ").title()


def load_presets() -> dict[str, str]:
    """
    Scan drawbot_presets/ and return {display_name: script_source} in
    alphabetical filename order.
    """
    presets: dict[str, str] = {}
    if not os.path.isdir(_PRESETS_DIR):
        return presets
    for filename in sorted(os.listdir(_PRESETS_DIR)):
        if not filename.endswith(".py") or filename == "helpers.py":
            continue
        path = os.path.join(_PRESETS_DIR, filename)
        try:
            with open(path, encoding="utf-8") as f:
                source = f.read()
            name = _name_from_filename(filename)
            presets[name] = source
        except OSError:
            pass
    return presets


# ---------------------------------------------------------------------------


class DrawBotNode:
    """
    Render a type specimen using DrawBot (drawbot-skia).

    Pick a preset from the dropdown, or add your own script to
    nodes/drawbot_presets/ — any .py file there appears as a preset.
    """

    @classmethod
    def INPUT_TYPES(cls):
        presets = load_presets()
        preset_names = list(presets.keys()) or ["(no presets found)"]
        return {
            "required": {
                "font":          ("FONT",),
                "preset":        (preset_names, {}),
                "canvas_width":  ("INT", {"default": 2048, "min": 64, "max": 8192, "step": 8}),
                "canvas_height": ("INT", {"default": 2048, "min": 64, "max": 8192, "step": 8}),
            },
            "optional": {
                "input_text":      ("STRING", {"default": ""}),
                # Holds the in-editor script. Populated by the JS CodeMirror
                # editor; if non-empty, takes precedence over the preset file.
                "script_override": ("STRING", {"multiline": True, "default": ""}),
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
        script_override: str = "",
    ):
        try:
            import drawbot_skia.drawbot as db
        except ImportError:
            raise RuntimeError(
                "drawbot-skia is not installed. "
                "Run: pip install drawbot-skia"
            )

        presets = load_presets()

        # Use the in-editor script when the user has edited it; fall back to
        # the preset file on disk.
        override = script_override.strip() if script_override else ""
        if override:
            script = override
        else:
            # Case-insensitive fallback so saved workflows survive renames.
            if preset not in presets:
                _lower = {k.lower(): k for k in presets}
                preset = _lower.get(preset.lower(), preset)
            if preset not in presets:
                raise ValueError(
                    f"Preset {preset!r} not found. "
                    f"Available: {list(presets)}"
                )
            script = presets[preset]

        font_path = _resolve_font(font)

        namespace: dict = {
            "font_path":  font_path,
            "WIDTH":      canvas_width,
            "HEIGHT":     canvas_height,
            "input_text": input_text,
        }
        for name in dir(db):
            if not name.startswith("_"):
                namespace[name] = getattr(db, name)

        # Add presets dir to sys.path so scripts can use `from helpers import *`
        if _PRESETS_DIR not in sys.path:
            sys.path.insert(0, _PRESETS_DIR)

        db.newDrawing()
        try:
            exec(script, namespace)  # noqa: S102
        except Exception as exc:
            db.endDrawing()
            raise RuntimeError(f"DrawBot script error: {exc}") from exc

        tmp = tempfile.mktemp(suffix=".png")
        try:
            db.saveImage(tmp)
            path = tmp if os.path.exists(tmp) else tmp.replace(".png", "_1.png")
            img = Image.open(path).convert("RGB")
        finally:
            for candidate in (tmp, tmp.replace(".png", "_1.png")):
                if os.path.exists(candidate):
                    os.unlink(candidate)

        db.endDrawing()

        return (_pil_to_tensor(img),)
