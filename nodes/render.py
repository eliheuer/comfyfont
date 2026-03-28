"""
Rendering nodes: produce IMAGE and MASK tensors from font data.
"""

from __future__ import annotations

import os

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont


def _pil_to_tensor(img: Image.Image) -> torch.Tensor:
    """PIL RGB image → [1, H, W, 3] float32 tensor in [0, 1]."""
    arr = np.array(img.convert("RGB")).astype(np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


def _alpha_to_mask(img: Image.Image) -> torch.Tensor:
    """PIL RGBA image → [1, H, W] float32 mask from alpha channel."""
    alpha = np.array(img.split()[3]).astype(np.float32) / 255.0
    return torch.from_numpy(alpha).unsqueeze(0)


def _resolve_font(font: str) -> str:
    """Resolve a FONT value (file path) to a TTF/OTF path usable for rendering."""
    if os.path.isdir(font):
        ttf = os.path.splitext(font)[0] + ".ttf"
        if not os.path.isfile(ttf):
            from ..core.compile import compile_ufo_to_ttf
            ttf = compile_ufo_to_ttf(font)
        return ttf
    if os.path.isfile(font):
        return font
    raise FileNotFoundError(f"Font not found: {font!r}")


# ---------------------------------------------------------------------------

class TextRenderNode:
    """
    Render a text string to an IMAGE + MASK using a loaded font file.

    The output IMAGE is the text rendered on a transparent background,
    composited over black. The MASK is the alpha channel — use it with
    SetLatentNoiseMask, MaskToImage, or any compositing node.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "font": ("FONT",),
                "text": ("STRING", {"default": "Hello", "multiline": False}),
                "font_size": ("INT", {"default": 72, "min": 6, "max": 1024, "step": 1}),
                "canvas_width": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 8}),
                "canvas_height": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 8}),
                "x": ("INT", {"default": -1, "min": -1, "max": 4096, "step": 1}),
                "y": ("INT", {"default": -1, "min": -1, "max": 4096, "step": 1}),
            },
            "optional": {
                "color": ("STRING", {"default": "#FFFFFF"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "render"
    CATEGORY = "ComfyFont/Render"

    def render(
        self,
        font: str,
        text: str,
        font_size: int,
        canvas_width: int,
        canvas_height: int,
        x: int,
        y: int,
        color: str = "#FFFFFF",
    ):
        font_path = _resolve_font(font)

        canvas = Image.new("RGBA", (canvas_width, canvas_height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(canvas)

        try:
            font = ImageFont.truetype(font_path, size=font_size)
        except Exception:
            font = ImageFont.load_default()

        # Auto-centre if x/y == -1
        bbox = draw.textbbox((0, 0), text, font=font)
        text_w = bbox[2] - bbox[0]
        text_h = bbox[3] - bbox[1]
        px = (canvas_width - text_w) // 2 if x == -1 else x
        py = (canvas_height - text_h) // 2 if y == -1 else y

        draw.text((px, py), text, font=font, fill=color)

        return (_pil_to_tensor(canvas), _alpha_to_mask(canvas))


# ---------------------------------------------------------------------------

class GlyphRenderNode:
    """
    Render a single glyph (by name or unicode codepoint) to IMAGE + MASK.

    Uses fontTools FreeTypePen for high-quality vector rasterisation.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "font": ("FONT",),
                "glyph_name": ("STRING", {"default": "A"}),
                "canvas_width": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 8}),
                "canvas_height": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 8}),
                "padding": ("INT", {"default": 32, "min": 0, "max": 512, "step": 1}),
                "even_odd": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "render"
    CATEGORY = "ComfyFont/Render"

    def render(
        self,
        font: str,
        glyph_name: str,
        canvas_width: int,
        canvas_height: int,
        padding: int,
        even_odd: bool,
    ):
        from fontTools.pens.freetypePen import FreeTypePen
        from fontTools.ttLib import TTFont

        font_path = _resolve_font(font)
        tt = TTFont(font_path, lazy=True)
        glyph_set = tt.getGlyphSet()

        # Resolve by unicode codepoint if glyph_name is a single char or "U+XXXX"
        resolved = glyph_name
        if len(glyph_name) == 1:
            cmap = tt.getBestCmap() or {}
            resolved = cmap.get(ord(glyph_name), glyph_name)
        elif glyph_name.upper().startswith("U+"):
            try:
                cp = int(glyph_name[2:], 16)
                cmap = tt.getBestCmap() or {}
                resolved = cmap.get(cp, glyph_name)
            except ValueError:
                pass

        if resolved not in glyph_set:
            # Return blank canvas
            blank = Image.new("RGBA", (canvas_width, canvas_height), (0, 0, 0, 0))
            return (_pil_to_tensor(blank), _alpha_to_mask(blank))

        pen = FreeTypePen(None)
        glyph_set[resolved].draw(pen)

        # Render with contain=True to auto-fit within (width-2*pad) × (height-2*pad)
        inner_w = canvas_width - 2 * padding
        inner_h = canvas_height - 2 * padding

        try:
            pil_glyph = pen.image(
                width=inner_w,
                height=inner_h,
                contain=True,
                evenOdd=even_odd,
            )
        except Exception:
            pil_glyph = Image.new("RGBA", (inner_w, inner_h), (0, 0, 0, 0))

        # Paste onto full canvas with padding
        canvas = Image.new("RGBA", (canvas_width, canvas_height), (0, 0, 0, 0))
        canvas.paste(pil_glyph, (padding, padding))

        tt.close()
        return (_pil_to_tensor(canvas), _alpha_to_mask(canvas))


# ---------------------------------------------------------------------------

class FontCompositeNode:
    """
    Composite a text/glyph image over a background image using its mask.

    blend_mode options:
      normal    – alpha composite (standard overlay)
      multiply  – darkens
      screen    – lightens
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "background": ("IMAGE",),
                "overlay": ("IMAGE",),
                "mask": ("MASK",),
                "opacity": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "composite"
    CATEGORY = "ComfyFont/Render"

    def composite(
        self,
        background: torch.Tensor,
        overlay: torch.Tensor,
        mask: torch.Tensor,
        opacity: float,
    ):
        def to_pil(t: torch.Tensor) -> Image.Image:
            arr = np.clip(t.cpu().numpy().squeeze(0) * 255, 0, 255).astype(np.uint8)
            return Image.fromarray(arr, "RGB")

        bg = to_pil(background)
        ov = to_pil(overlay)

        # Scale mask by opacity
        mask_arr = mask.cpu().numpy().squeeze(0)  # [H, W]
        mask_arr = np.clip(mask_arr * opacity, 0, 1)
        alpha = Image.fromarray((mask_arr * 255).astype(np.uint8), "L")

        if ov.size != bg.size:
            ov = ov.resize(bg.size, Image.LANCZOS)
            alpha = alpha.resize(bg.size, Image.LANCZOS)

        result = bg.copy()
        result.paste(ov, (0, 0), alpha)

        return (_pil_to_tensor(result),)
