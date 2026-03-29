"""
ComfyFontNode — font selector and editor node.

Outputs a FONT wire that downstream nodes consume.
The Import Font… and Edit Font buttons live here.
The node canvas shows a live vector specimen preview.
"""

from __future__ import annotations

import os
import xml.etree.ElementTree as ET

_FONTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fonts")

_FONT_EXTS = {".ttf", ".otf", ".woff", ".woff2", ".designspace"}


def _ufo_masters_in_designspace(ds_path: str) -> set[str]:
    """
    Return the set of UFO basenames that are masters of the given .designspace file.
    Uses a lightweight stdlib XML parse — no fontTools import at list time.
    """
    try:
        root = ET.parse(ds_path).getroot()
        return {
            os.path.basename(src.get("filename", ""))
            for src in root.findall(".//sources/source")
            if src.get("filename", "").endswith(".ufo")
        }
    except Exception:
        return set()


def get_font_list() -> list[str]:
    """
    Return the sorted list of font names available in the workspace.

    - Compiled fonts (.ttf/.otf/.woff/.woff2) always appear.
    - .designspace files always appear.
    - A bare .ufo directory appears only when it has no sibling .ttf AND is not
      a master of any .designspace in the workspace (those are internal sources,
      not top-level fonts).
    """
    try:
        entries = os.listdir(_FONTS_DIR)
    except OSError:
        return []

    names = set(entries)

    # Collect UFO basenames that belong to a designspace project.
    masked_ufos: set[str] = set()
    for e in entries:
        if e.endswith(".designspace"):
            masked_ufos |= _ufo_masters_in_designspace(
                os.path.join(_FONTS_DIR, e)
            )

    fonts = []
    for e in entries:
        ext = os.path.splitext(e)[1].lower()
        if ext in _FONT_EXTS:
            fonts.append(e)
        elif e.endswith(".ufo") and os.path.isdir(os.path.join(_FONTS_DIR, e)):
            if (
                e not in masked_ufos
                and os.path.splitext(e)[0] + ".ttf" not in names
            ):
                fonts.append(e)

    return [""] + sorted(fonts)


class ComfyFontNode:
    """
    Load a font from the workspace.

    Use Import Font… to bring a font into the workspace (copies it and
    creates the TTF/UFO pair). Select it from the dropdown to use it
    downstream. Click Edit Font to open the full-screen glyph editor.
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
    FUNCTION = "execute"
    CATEGORY = "ComfyFont"

    @classmethod
    def IS_CHANGED(cls, font: str = ""):
        path = os.path.join(_FONTS_DIR, font)
        try:
            return os.path.getmtime(path)
        except OSError:
            return ""

    def execute(self, font: str):
        if not font:
            raise ValueError("No font selected. Use Import Font… to add one.")
        path = os.path.join(_FONTS_DIR, font)
        if not os.path.exists(path):
            raise FileNotFoundError(f"Font not found in workspace: {font!r}")
        return (path,)
