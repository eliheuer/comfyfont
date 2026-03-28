"""
ComfyFontLoadNode — the primary font node.

Outputs a FONT type (font name string) that rendering nodes consume.
"""

from __future__ import annotations

from ..core import library


class ComfyFontLoadNode:
    """
    Load a font from the ComfyFont library.

    Drop a TTF/OTF into comfyfont/fonts/ and click "Import" in the node,
    or use the /comfyfont/import API. The font is stored as an editable
    UFO source file in comfyfont/library/ alongside a compiled TTF for rendering.
    """

    @classmethod
    def INPUT_TYPES(cls):
        fonts = library.fontNames()
        return {
            "required": {
                "font": (fonts if fonts else ["(no fonts — import one)"],),
                "specimen_text": (
                    "STRING",
                    {"default": "AaBbCc 123", "multiline": False},
                ),
            }
        }

    RETURN_TYPES = ("FONT",)
    RETURN_NAMES = ("font",)
    FUNCTION = "load"
    CATEGORY = "ComfyFont"

    # Always re-execute so the output reflects any library changes.
    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def load(self, font: str, specimen_text: str):
        # Validate the font exists
        import os
        if not (os.path.isdir(library.ufo_path(font)) or
                os.path.isfile(library.ttf_path(font))):
            raise FileNotFoundError(
                f"Font {font!r} not found in library. "
                "Import it via the node's Import button."
            )
        return (font,)
