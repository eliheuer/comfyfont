"""
ForkFontNode — deep-copy a font workspace entry under a new name.

Forking is the core ComfyFont operation: load a font once, fork it N times,
run different AI transformations on each fork in parallel, compare results.
The original is never modified.
"""

from __future__ import annotations

import os
import shutil

_FONTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fonts")


class ForkFontNode:
    """
    Fork a font into a new workspace entry.

    Creates an independent copy of the font (TTF + UFO if present) under a
    new name. Downstream nodes that modify the fork leave the original intact.

    fork_name: base name for the copy, e.g. "MyFont-Fork".
    The node appends the appropriate extension automatically.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "font":      ("FONT",),
                "fork_name": ("STRING", {"default": "fork"}),
            }
        }

    RETURN_TYPES  = ("FONT",)
    RETURN_NAMES  = ("font",)
    FUNCTION      = "execute"
    CATEGORY      = "ComfyFont"

    @classmethod
    def IS_CHANGED(cls, font: str = "", fork_name: str = "fork"):
        # Re-execute whenever the source font changes.
        try:
            return os.path.getmtime(font)
        except OSError:
            return ""

    def execute(self, font: str, fork_name: str):
        if not font or not os.path.exists(font):
            raise FileNotFoundError(f"Source font not found: {font!r}")

        fork_name = fork_name.strip() or "fork"
        ext       = os.path.splitext(font)[1] or (".ufo" if os.path.isdir(font) else "")
        dest_name = fork_name if fork_name.endswith(ext) else fork_name + ext
        dest_path = os.path.join(_FONTS_DIR, dest_name)

        if os.path.isdir(font):
            if os.path.exists(dest_path):
                shutil.rmtree(dest_path)
            shutil.copytree(font, dest_path)
        else:
            shutil.copy2(font, dest_path)

        # Copy sibling UFO if present (TTF + UFO pair)
        ufo_src = os.path.splitext(font)[0] + ".ufo"
        if os.path.isdir(ufo_src):
            ufo_dest = os.path.join(_FONTS_DIR, fork_name + ".ufo")
            if os.path.exists(ufo_dest):
                shutil.rmtree(ufo_dest)
            shutil.copytree(ufo_src, ufo_dest)

        return (dest_path,)
