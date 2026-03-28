"""
Font inspection nodes: extract metadata and glyph lists.
"""

from __future__ import annotations

import json
import os

import folder_paths


def _resolve_font(font_file: str) -> str:
    full = folder_paths.get_full_path("comfyfont_fonts", font_file)
    if full:
        return full
    if os.path.isabs(font_file) and os.path.exists(font_file):
        return font_file
    raise FileNotFoundError(f"Font not found: {font_file!r}")


class FontInfoNode:
    """Return font metadata as a JSON STRING."""

    @classmethod
    def INPUT_TYPES(cls):
        font_list = folder_paths.get_filename_list("comfyfont_fonts")
        return {
            "required": {
                "font_file": (font_list if font_list else ["(no fonts found)"],),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("info_json",)
    FUNCTION = "inspect"
    CATEGORY = "ComfyFont/Inspect"

    def inspect(self, font_file: str):
        font_path = _resolve_font(font_file)
        ext = os.path.splitext(font_file)[1].lower()

        if ext == ".ufo":
            import ufoLib2
            font = ufoLib2.Font.open(font_path)
            info = font.info
            data = {
                "familyName": info.familyName,
                "unitsPerEm": info.unitsPerEm,
                "ascender": info.ascender,
                "descender": info.descender,
                "xHeight": info.xHeight,
                "capHeight": info.capHeight,
                "italicAngle": info.italicAngle,
                "glyphCount": len(font),
                "format": "UFO",
            }
        else:
            from fontTools.ttLib import TTFont
            tt = TTFont(font_path, lazy=True)
            name = tt["name"]
            def n(nid):
                r = name.getName(nid, 3, 1, 0x0409) or name.getName(nid, 1, 0, 0)
                return r.toUnicode() if r else ""
            head = tt.get("head")
            os2 = tt.get("OS/2")
            data = {
                "familyName": n(1),
                "fullName": n(4),
                "version": n(5),
                "unitsPerEm": head.unitsPerEm if head else None,
                "ascender": os2.sTypoAscender if os2 else None,
                "descender": os2.sTypoDescender if os2 else None,
                "xHeight": os2.sxHeight if os2 else None,
                "capHeight": os2.sCapHeight if os2 else None,
                "glyphCount": len(tt.getGlyphOrder()),
                "isVariable": "fvar" in tt,
                "format": ext.lstrip(".").upper(),
            }
            tt.close()

        return (json.dumps(data, indent=2),)


class GlyphListNode:
    """Return the list of glyph names in a font as a JSON STRING."""

    @classmethod
    def INPUT_TYPES(cls):
        font_list = folder_paths.get_filename_list("comfyfont_fonts")
        return {
            "required": {
                "font_file": (font_list if font_list else ["(no fonts found)"],),
                "include_unicode": ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("glyphs_json",)
    FUNCTION = "list_glyphs"
    CATEGORY = "ComfyFont/Inspect"

    def list_glyphs(self, font_file: str, include_unicode: bool):
        font_path = _resolve_font(font_file)
        ext = os.path.splitext(font_file)[1].lower()

        if ext == ".ufo":
            import ufoLib2
            font = ufoLib2.Font.open(font_path)
            glyphs = [
                {"name": g.name, "unicodes": list(g.unicodes)}
                for g in font
            ]
        else:
            from fontTools.ttLib import TTFont
            tt = TTFont(font_path, lazy=True)
            cmap = tt.getBestCmap() or {}
            reverse: dict[str, list[int]] = {}
            for cp, name in cmap.items():
                reverse.setdefault(name, []).append(cp)
            glyphs = [
                {"name": n, "unicodes": reverse.get(n, [])}
                for n in tt.getGlyphOrder()
            ]
            tt.close()

        if not include_unicode:
            glyphs = [g["name"] for g in glyphs]

        return (json.dumps(glyphs, indent=2),)
