"""
ComfyFont — font editing and rendering for ComfyUI.

Nodes:
  ComfyFontLoad       — pick a font from the workspace (COMBO dropdown)
  ComfyFontTextRender — FONT + text → IMAGE + MASK
  ComfyFontGlyphRender — FONT + glyph name → IMAGE + MASK
  ComfyFontComposite  — composite text over image

Routes:
  POST /comfyfont/import    — upload a font; copies to workspace, converts TTF↔UFO
  GET  /comfyfont/fonts     — JSON list of font names in the workspace
  GET  /comfyfont/glyph_map — list glyphs in a font (?name= or ?path=)
  GET  /comfyfont/ws        — WebSocket RPC for the glyph editor (?name= or ?path=)

Font workspace (comfyfont/fonts/):
  MyFont.ttf   — compiled font, used by rendering nodes
  MyFont.ufo/  — editable source, used by the glyph editor
"""

from __future__ import annotations

import asyncio
import logging
import os

import aiohttp.web as web
from server import PromptServer

from .nodes.drawbot import DrawBotNode
from .nodes.comfyfont import ComfyFontNode
from .nodes.load import get_font_list  # noqa: F401 — used by /comfyfont/fonts route

log = logging.getLogger(__name__)

NODE_DIR  = os.path.dirname(os.path.abspath(__file__))
FONTS_DIR = os.path.join(NODE_DIR, "fonts")
os.makedirs(FONTS_DIR, exist_ok=True)

# Register the workspace with ComfyUI's folder_paths so other nodes and tools
# can discover ComfyFont's managed files through the standard API.
try:
    import folder_paths
    folder_paths.add_search_path("comfyfont", FONTS_DIR)
except Exception:
    pass  # older ComfyUI versions may not support add_search_path

# ---------------------------------------------------------------------------
# Helpers

def _sibling_ufo(font_path: str) -> str | None:
    """Return the .ufo folder next to a TTF/OTF if it exists, else None."""
    ext = os.path.splitext(font_path)[1].lower()
    if ext in (".ttf", ".otf", ".woff", ".woff2"):
        ufo = os.path.splitext(font_path)[0] + ".ufo"
        if os.path.isdir(ufo):
            return ufo
    return None


def _resolve_edit_path(font_path: str) -> str:
    """For editing, prefer the sibling UFO over a compiled font."""
    return _sibling_ufo(font_path) or font_path


def _convert_ttf_to_ufo(ttf_path: str, ufo_path: str) -> None:
    from fontTools.ttLib import TTFont
    from .core.library import _ttf_to_ufo
    tt = TTFont(ttf_path, lazy=False)
    _ttf_to_ufo(tt, ufo_path)
    tt.close()
    log.info("Converted %s → %s", ttf_path, ufo_path)


def _resolve_font_param(request: web.Request) -> str:
    """
    Resolve a font from request query params.

    Accepts ?name=<filename> (relative to FONTS_DIR) or ?path=<absolute path>.
    Returns the absolute path, or empty string if neither is provided.
    """
    name = request.query.get("name", "")
    if name:
        return os.path.join(FONTS_DIR, name)
    return request.query.get("path", "")


# ---------------------------------------------------------------------------
# Routes

routes = PromptServer.instance.routes


@routes.post("/comfyfont/import")
async def _import_font(request: web.Request) -> web.Response:
    """
    Receive a font file upload.

    - Copies the file into comfyfont/fonts/.
    - If it is a compiled font (TTF/OTF/WOFF), also converts it to a UFO
      alongside it so the glyph editor can make edits.
    - Returns {"ok": true, "name": "<filename>", "path": "<absolute path>"}.
    """
    try:
        reader = await request.multipart()
        field  = await reader.next()
        if field is None:
            return web.json_response({"error": "no file"}, status=400)

        filename  = field.filename or "upload.ttf"
        ext       = os.path.splitext(filename)[1].lower()
        dest_path = os.path.join(FONTS_DIR, filename)

        with open(dest_path, "wb") as f:
            while True:
                chunk = await field.read_chunk()
                if not chunk:
                    break
                f.write(chunk)

        loop = asyncio.get_running_loop()

        if ext in (".ttf", ".otf", ".woff", ".woff2"):
            ufo_path = os.path.splitext(dest_path)[0] + ".ufo"
            await loop.run_in_executor(None, _convert_ttf_to_ufo, dest_path, ufo_path)

        elif ext == ".ufo" or os.path.isdir(dest_path):
            from .core.compile import compile_ufo_to_ttf
            await loop.run_in_executor(None, compile_ufo_to_ttf, dest_path)

        return web.json_response({"ok": True, "name": filename, "path": dest_path})

    except Exception as exc:
        log.exception("import error")
        return web.json_response({"error": str(exc)}, status=500)


@routes.get("/comfyfont/fonts")
async def _list_fonts(request: web.Request) -> web.Response:
    """Return the list of font names currently in the workspace."""
    from .nodes.load import get_font_list
    return web.json_response(get_font_list())


@routes.get("/comfyfont/glyph_map")
async def _glyph_map(request: web.Request) -> web.Response:
    font_path = _resolve_font_param(request)
    if not font_path:
        return web.json_response({"error": "name or path required"}, status=400)
    if not os.path.exists(font_path):
        return web.json_response({"error": f"Font not found: {font_path!r}"}, status=404)
    try:
        from .core.server import getFontHandler
        handler = getFontHandler(_resolve_edit_path(font_path))
        return web.json_response(await handler.getGlyphMap())
    except Exception as exc:
        log.exception("glyph_map error")
        return web.json_response({"error": str(exc)}, status=500)


@routes.get("/comfyfont/ws")
async def _ws_handler(request: web.Request) -> web.WebSocketResponse:
    font_path = _resolve_font_param(request)
    if not font_path:
        raise web.HTTPBadRequest(reason="name or path required")
    if not os.path.exists(font_path):
        raise web.HTTPNotFound(reason=f"Font not found: {font_path!r}")

    # Use UFO sibling for editing when available
    edit_path = _resolve_edit_path(font_path)

    ws = web.WebSocketResponse()
    await ws.prepare(request)

    from .core.server import getFontHandler
    from .core.remote import RemoteObjectConnection

    handler = getFontHandler(edit_path)
    conn    = RemoteObjectConnection(ws, handler)
    await conn.run()
    return ws


# ---------------------------------------------------------------------------
# Node registration

NODE_CLASS_MAPPINGS = {
    "ComfyFont":        ComfyFontNode,
    "ComfyFontDrawBot": DrawBotNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ComfyFont":        "ComfyFont",
    "ComfyFontDrawBot": "DrawBot",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
