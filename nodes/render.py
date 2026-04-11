"""
Shared rendering utilities used by DrawBot and other nodes.
"""

from __future__ import annotations

import os

import numpy as np
import torch
from PIL import Image


def _pil_to_tensor(img: Image.Image) -> torch.Tensor:
    """PIL RGB image → [1, H, W, 3] float32 tensor in [0, 1]."""
    arr = np.array(img.convert("RGB")).astype(np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


def _resolve_font(font: str) -> str:
    """Resolve a FONT value (absolute workspace path) to a renderable TTF/OTF path."""
    if os.path.isdir(font):
        # UFO directory → compile to TTF if needed
        ttf = os.path.splitext(font)[0] + ".ttf"
        if not os.path.isfile(ttf):
            from ..core.compile import compile_ufo_to_ttf
            ttf = compile_ufo_to_ttf(font)
        return ttf
    if font.endswith(".designspace") and os.path.isfile(font):
        # Designspace → compile to variable TTF if needed
        ttf = os.path.splitext(font)[0] + ".ttf"
        if not os.path.isfile(ttf):
            from ..core.compile import compile_designspace_to_ttf
            ttf = compile_designspace_to_ttf(font)
        return ttf
    if os.path.isfile(font):
        return font
    raise FileNotFoundError(f"Font not found: {font!r}")
