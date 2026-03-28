"""
ComfyFontLoadNode — primary font node.

Outputs a FONT type (absolute file path) consumed by rendering nodes.
"""

from __future__ import annotations

import os

# Workspace directory: comfyfont/fonts/ — managed copies, never the original.
_FONTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fonts")

_FONT_EXTS = {".ttf", ".otf", ".woff", ".woff2", ".designspace"}


def get_font_list() -> list[str]:
    """
    Return the sorted list of font names available in the workspace.

    Shows compiled fonts (.ttf/.otf/.woff/.woff2/.designspace) and bare .ufo
    directories that have no sibling compiled font yet.
    """
    try:
        entries = os.listdir(_FONTS_DIR)
    except OSError:
        return []

    names = set(entries)
    fonts = []
    for e in entries:
        ext = os.path.splitext(e)[1].lower()
        if ext in _FONT_EXTS:
            fonts.append(e)
        elif e.endswith(".ufo") and os.path.isdir(os.path.join(_FONTS_DIR, e)):
            # Show the UFO only if there is no compiled sibling
            if os.path.splitext(e)[0] + ".ttf" not in names:
                fonts.append(e)

    return sorted(fonts)


class ComfyFontLoadNode:
    """
    Select a font from the ComfyFont workspace.

    Use "Import Font…" to bring a font into the workspace (copies it and
    creates the TTF↔UFO pair). Then select it here to use it downstream.
    """

    @classmethod
    def INPUT_TYPES(cls):
        fonts = get_font_list()
        return {
            "required": {
                "font": (fonts if fonts else ["(no fonts — click Import Font)"], {}),
            }
        }

    RETURN_TYPES = ("FONT",)
    RETURN_NAMES = ("font",)
    FUNCTION = "load"
    CATEGORY = "ComfyFont"

    @classmethod
    def IS_CHANGED(cls, font: str = ""):
        path = os.path.join(_FONTS_DIR, font)
        try:
            return os.path.getmtime(path)
        except OSError:
            return ""

    def load(self, font: str):
        if not font or font.startswith("("):
            raise ValueError("No font selected. Use Import Font… to add one.")
        path = os.path.join(_FONTS_DIR, font)
        if not os.path.exists(path):
            raise FileNotFoundError(f"Font not found in workspace: {font!r}")
        return (path,)
