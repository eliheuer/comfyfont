"""
ComfyFont — font editing and rendering for ComfyUI.

Nodes:
  ComfyFontLoad       — load a font from the library (primary node)
  ComfyFontTextRender — FONT + text → IMAGE + MASK
  ComfyFontGlyphRender — FONT + glyph name → IMAGE + MASK
  ComfyFontComposite  — composite text over image

Routes:
  POST /comfyfont/import            — import TTF/OTF/UFO into library
  GET  /comfyfont/library           — list fonts in library
  GET  /comfyfont/glyph_map         — list glyphs in a font
  GET  /comfyfont/ws                — WebSocket RPC (glyph editor)
"""

from __future__ import annotations

import asyncio
import logging
import os

import aiohttp.web as web
from server import PromptServer

from .core import library as _lib
from .nodes.load import ComfyFontLoadNode
from .nodes.render import FontCompositeNode, GlyphRenderNode, TextRenderNode

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Initialise library

NODE_DIR = os.path.dirname(os.path.abspath(__file__))
LIBRARY_DIR = os.path.join(NODE_DIR, "library")
_lib.init(LIBRARY_DIR)

# Auto-import any TTF/OTF sitting in the fonts/ drop folder
FONTS_DIR = os.path.join(NODE_DIR, "fonts")
os.makedirs(FONTS_DIR, exist_ok=True)

def _auto_import_drop_folder():
    for fname in os.listdir(FONTS_DIR):
        ext = os.path.splitext(fname)[1].lower()
        if ext not in (".ttf", ".otf", ".woff", ".woff2"):
            continue
        try:
            record = _lib.importFont(os.path.join(FONTS_DIR, fname))
            log.info("Auto-imported %s → %s", fname, record["name"])
        except Exception:
            log.exception("Failed to auto-import %s", fname)

_auto_import_drop_folder()

# ---------------------------------------------------------------------------
# Routes

routes = PromptServer.instance.routes


@routes.post("/comfyfont/import")
async def _import_font(request: web.Request) -> web.Response:
    """Receive a font file upload and import it into the library."""
    try:
        reader = await request.multipart()
        field = await reader.next()
        if field is None:
            return web.json_response({"error": "no file"}, status=400)

        filename = field.filename or "upload.ttf"
        ext = os.path.splitext(filename)[1].lower()
        tmp_path = os.path.join(FONTS_DIR, "_upload" + ext)

        with open(tmp_path, "wb") as f:
            while True:
                chunk = await field.read_chunk()
                if not chunk:
                    break
                f.write(chunk)

        loop = asyncio.get_event_loop()
        record = await loop.run_in_executor(None, _lib.importFont, tmp_path)
        os.remove(tmp_path)

        return web.json_response({"ok": True, "name": record["name"]})
    except Exception as exc:
        log.exception("import error")
        return web.json_response({"error": str(exc)}, status=500)


@routes.get("/comfyfont/library")
async def _library(request: web.Request) -> web.Response:
    return web.json_response(_lib.listFonts())


@routes.get("/comfyfont/glyph_map")
async def _glyph_map(request: web.Request) -> web.Response:
    font = request.query.get("font", "")
    if not font:
        return web.json_response({"error": "font required"}, status=400)
    try:
        ufo_p = _lib.ufo_path(font)
        ttf_p = _lib.ttf_path(font)
        font_path = ufo_p if os.path.isdir(ufo_p) else ttf_p
        from .core.server import getFontHandler
        handler = getFontHandler(font_path)
        return web.json_response(await handler.getGlyphMap())
    except Exception as exc:
        log.exception("glyph_map error")
        return web.json_response({"error": str(exc)}, status=500)


@routes.get("/comfyfont/ws")
async def _ws_handler(request: web.Request) -> web.WebSocketResponse:
    font = request.query.get("font", "")
    if not font:
        raise web.HTTPBadRequest(reason="font required")

    ufo_p = _lib.ufo_path(font)
    ttf_p = _lib.ttf_path(font)
    font_path = ufo_p if os.path.isdir(ufo_p) else ttf_p
    if not os.path.exists(font_path):
        raise web.HTTPNotFound(reason=f"Font {font!r} not in library")

    ws = web.WebSocketResponse()
    await ws.prepare(request)

    from .core.server import getFontHandler
    from .core.remote import RemoteObjectConnection

    handler = getFontHandler(font_path)
    conn = RemoteObjectConnection(ws, handler)
    await conn.run()
    return ws


# ---------------------------------------------------------------------------
# Node registration

NODE_CLASS_MAPPINGS = {
    "ComfyFontLoad":        ComfyFontLoadNode,
    "ComfyFontTextRender":  TextRenderNode,
    "ComfyFontGlyphRender": GlyphRenderNode,
    "ComfyFontComposite":   FontCompositeNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ComfyFontLoad":        "Load Font (ComfyFont)",
    "ComfyFontTextRender":  "Text Render (ComfyFont)",
    "ComfyFontGlyphRender": "Glyph Render (ComfyFont)",
    "ComfyFontComposite":   "Font Composite (ComfyFont)",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
