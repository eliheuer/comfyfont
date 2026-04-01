"""
AI font nodes — stubs with cloud API skeleton.

These nodes are placeholders for cloud AI services (kerning, spacing,
glyph synthesis). Each accepts a FONT wire and returns a modified FONT.
The execute() methods raise NotImplementedError until the services are
implemented; the node structure, I/O types, and category are final.

Mark color integration: nodes read customData.markColor from the font's
glyphs so AI services can operate on a subset (e.g. "only red-marked
glyphs need new spacing").
"""

from __future__ import annotations

import os

_FONTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fonts")

# ---------------------------------------------------------------------------
# Shared cloud API skeleton (used by all AI nodes)
# ---------------------------------------------------------------------------

def _call_cloud_api(endpoint: str, font_path: str, params: dict) -> dict:
    """
    Placeholder for ComfyFont cloud API calls.

    When implemented this will POST the font (or a diff) to the cloud
    service and return the modified font data. For now it raises to make
    the stub state obvious.
    """
    raise NotImplementedError(
        f"Cloud AI service '{endpoint}' is not yet implemented. "
        "This node is a stub — local model support coming in a future release."
    )


def _mark_color_filter(font_path: str, color_label: str | None) -> list[str]:
    """
    Return glyph names whose customData.markColor matches color_label.
    Returns all glyph names if color_label is None or empty.
    This is used to let AI nodes operate on a marked subset of glyphs.
    """
    if not color_label:
        return []  # empty = no filter = all glyphs
    try:
        import ufoLib2
        ufo_path = os.path.splitext(font_path)[0] + ".ufo"
        if not os.path.isdir(ufo_path):
            return []
        font = ufoLib2.Font.open(ufo_path)
        return [
            g.name for g in font
            if g.lib.get("public.markColor") == color_label
        ]
    except Exception:
        return []


# ---------------------------------------------------------------------------
# AIKerning
# ---------------------------------------------------------------------------

class AIKerningNode:
    """
    Generate kerning pairs using AI.

    Analyzes glyph shapes and produces kerning values for the font.
    Operates on a copy of the input font — the original is never modified.

    mark_color_filter: if set, only glyphs with this mark color are
    considered as kern candidates (useful for targeted re-kerning).
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "font":   ("FONT",),
                "model":  (["cloud/comfyfont-kern-v1", "local/placeholder"], {}),
            },
            "optional": {
                "mark_color_filter": ("STRING", {"default": ""}),
                "strength":          ("FLOAT",  {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.1}),
            },
        }

    RETURN_TYPES  = ("FONT",)
    RETURN_NAMES  = ("font",)
    FUNCTION      = "execute"
    CATEGORY      = "ComfyFont/AI"

    def execute(self, font: str, model: str,
                mark_color_filter: str = "", strength: float = 1.0):
        _call_cloud_api("kerning", font, {
            "model":    model,
            "strength": strength,
            "glyphs":   _mark_color_filter(font, mark_color_filter),
        })


# ---------------------------------------------------------------------------
# AISpacing
# ---------------------------------------------------------------------------

class AISpacingNode:
    """
    Adjust sidebearings (left/right spacing) using AI.

    Analyzes glyph shapes and sets optimal sidebearing values.
    Operates on a copy of the input font.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "font":  ("FONT",),
                "model": (["cloud/comfyfont-spacing-v1", "local/placeholder"], {}),
            },
            "optional": {
                "mark_color_filter": ("STRING", {"default": ""}),
                "strength":          ("FLOAT",  {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.1}),
            },
        }

    RETURN_TYPES  = ("FONT",)
    RETURN_NAMES  = ("font",)
    FUNCTION      = "execute"
    CATEGORY      = "ComfyFont/AI"

    def execute(self, font: str, model: str,
                mark_color_filter: str = "", strength: float = 1.0):
        _call_cloud_api("spacing", font, {
            "model":    model,
            "strength": strength,
            "glyphs":   _mark_color_filter(font, mark_color_filter),
        })


# ---------------------------------------------------------------------------
# AIGlyphSynth
# ---------------------------------------------------------------------------

class AIGlyphSynthNode:
    """
    Synthesize missing glyphs using AI.

    Given a font with partial coverage, generates new glyphs to fill gaps.
    Typical use: extend a Latin font with Greek, Cyrillic, or Arabic glyphs,
    or add missing diacritics.

    target_script: Unicode script name (e.g. "Greek", "Arabic", "Cyrillic").
    gf_set: alternatively, name a Google Fonts character set to target.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "font":  ("FONT",),
                "model": (["cloud/comfyfont-synth-v1", "local/placeholder"], {}),
            },
            "optional": {
                "target_script": ("STRING", {"default": ""}),
                "gf_set":        ("STRING", {"default": ""}),
                "strength":      ("FLOAT",  {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.1}),
            },
        }

    RETURN_TYPES  = ("FONT",)
    RETURN_NAMES  = ("font",)
    FUNCTION      = "execute"
    CATEGORY      = "ComfyFont/AI"

    def execute(self, font: str, model: str, target_script: str = "",
                gf_set: str = "", strength: float = 1.0):
        _call_cloud_api("synth", font, {
            "model":         model,
            "target_script": target_script,
            "gf_set":        gf_set,
            "strength":      strength,
        })
