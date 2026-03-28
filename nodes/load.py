"""
ComfyFontLoadNode — the primary font node.

Outputs a FONT type (absolute file path) that rendering nodes consume.
"""

from __future__ import annotations

import os


class ComfyFontLoadNode:
    """
    Load a font by file path.

    Point this at any TTF, OTF, WOFF, WOFF2, or UFO on disk.
    Use the "Import Font…" button in the node to browse and copy a file
    into the local fonts/ folder, or type/paste an absolute path directly.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "font_path": ("STRING", {"default": ""}),
            }
        }

    RETURN_TYPES = ("FONT",)
    RETURN_NAMES = ("font",)
    FUNCTION = "load"
    CATEGORY = "ComfyFont"

    @classmethod
    def IS_CHANGED(cls, font_path: str = "", **kwargs):
        try:
            return os.path.getmtime(font_path.strip())
        except OSError:
            return ""

    def load(self, font_path: str):
        font_path = font_path.strip()
        if not font_path:
            raise ValueError("No font path specified.")
        if not os.path.exists(font_path):
            raise FileNotFoundError(f"Font not found: {font_path!r}")
        return (font_path,)
