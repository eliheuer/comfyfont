"""
ComfyFont — font editing and rendering for ComfyUI.

Nodes:
  ComfyFont           — pick a font from the workspace (COMBO dropdown)
  ComfyFontDrawBot    — FONT + preset → IMAGE

Routes:
  POST /comfyfont/import    — upload a font; copies to workspace, converts TTF↔UFO
  GET  /comfyfont/fonts     — JSON list of font names in the workspace
  GET  /comfyfont/glyph_map — list glyphs in a font (?name= or ?path=)
  WS   /comfyfont/ws        — WebSocket RPC for the glyph editor (?name= or ?path=)

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
from .nodes.comfyfont import ComfyFontNode, get_font_list

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
    Import a font into the workspace.

    Accepts either:
    - JSON body {"path": "/abs/path/to/font"} — Electron path-based import.
      The server reads files directly from disk. For .designspace, all
      referenced UFO masters are copied into the workspace alongside it.
    - Multipart form with "files" fields — fallback upload for non-Electron.

    Returns {"ok": true, "name": "<filename>", "path": "<absolute path>"}.
    """
    try:
        loop = asyncio.get_running_loop()

        if request.content_type == "application/json":
            body     = await request.json()
            src_path = body.get("path", "").rstrip("/")
            orig_name = body.get("name", "")
            if not src_path or not os.path.exists(src_path):
                return web.json_response({"error": f"File not found: {src_path!r}"}, status=400)

            # Use the original filename's extension (ToDesktop copies files to
            # UUID temp paths with no extension; file.name preserves the original).
            ext     = os.path.splitext(orig_name or src_path)[1].lower()
            src_dir = os.path.dirname(src_path)

            if ext == ".designspace":
                # Copy the .designspace + all UFO masters it references.
                dest_ds = os.path.join(FONTS_DIR, os.path.basename(src_path))
                import shutil, xml.etree.ElementTree as ET
                shutil.copy2(src_path, dest_ds)
                # Parse source paths from the XML and copy each UFO.
                root = ET.parse(src_path).getroot()
                for src_el in root.findall(".//sources/source"):
                    rel = src_el.get("filename", "")
                    if not rel:
                        continue
                    ufo_src = os.path.normpath(os.path.join(src_dir, rel))
                    if not os.path.exists(ufo_src):
                        log.warning("UFO not found, skipping: %s", ufo_src)
                        continue
                    # Preserve the relative path structure so the .designspace
                    # references still resolve correctly.
                    ufo_dest = os.path.normpath(os.path.join(FONTS_DIR, rel))
                    if os.path.exists(ufo_dest):
                        shutil.rmtree(ufo_dest)
                    os.makedirs(os.path.dirname(ufo_dest), exist_ok=True)
                    shutil.copytree(ufo_src, ufo_dest)
                    log.info("Copied UFO %s → %s", ufo_src, ufo_dest)
                filename  = os.path.basename(dest_ds)
                main_path = dest_ds

            elif ext in (".ttf", ".otf", ".woff", ".woff2"):
                import shutil
                dest = os.path.join(FONTS_DIR, orig_name or os.path.basename(src_path))
                shutil.copy2(src_path, dest)
                filename, main_path = os.path.basename(dest), dest

            elif ext == ".ufo" or os.path.isdir(src_path):
                import shutil
                dest = os.path.join(FONTS_DIR, orig_name or os.path.basename(src_path))
                if os.path.exists(dest):
                    shutil.rmtree(dest)
                shutil.copytree(src_path, dest)
                filename, main_path = os.path.basename(dest), dest

            elif ext == ".zip":
                import shutil, zipfile
                dest = os.path.join(FONTS_DIR, os.path.basename(src_path))
                shutil.copy2(src_path, dest)
                ds_name = None
                ufo_name = None
                with zipfile.ZipFile(dest) as zf:
                    zf.extractall(FONTS_DIR)
                    for name in zf.namelist():
                        if name.endswith(".designspace"):
                            ds_name = os.path.basename(name)
                        if not ufo_name and (name.endswith(".ufo/") or name.endswith(".ufo")):
                            ufo_name = name.split("/")[0]
                os.remove(dest)
                if ds_name:
                    filename  = ds_name
                    main_path = os.path.join(FONTS_DIR, ds_name)
                elif ufo_name:
                    # UFO folder extracted from zip — compile to TTF
                    from .core.compile import compile_ufo_to_ttf
                    ufo_dest = os.path.join(FONTS_DIR, ufo_name)
                    await loop.run_in_executor(None, compile_ufo_to_ttf, ufo_dest)
                    filename  = ufo_name
                    main_path = ufo_dest
                else:
                    return web.json_response({"error": "zip contained no .designspace or .ufo"}, status=400)

            else:
                return web.json_response({"error": f"Unsupported format: {ext!r}"}, status=400)

        else:
            # Multipart fallback — write files preserving relative paths.
            reader  = await request.multipart()
            written = []
            async for field in reader:
                rel = field.filename
                if not rel:
                    continue
                dest = os.path.normpath(os.path.join(FONTS_DIR, rel))
                if not dest.startswith(FONTS_DIR):
                    continue
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, "wb") as f:
                    while chunk := await field.read_chunk():
                        f.write(chunk)
                written.append(dest)

            if not written:
                return web.json_response({"error": "no files received"}, status=400)

            def _pick(exts):
                return next((p for p in written if os.path.splitext(p)[1].lower() in exts), None)

            main_path = (_pick({".designspace"}) or _pick({".ttf", ".otf", ".woff", ".woff2"})
                         or next((p for p in written if p.endswith(".ufo")), written[0]))
            ext = os.path.splitext(main_path)[1].lower()

            filename = os.path.basename(main_path)

        return web.json_response({"ok": True, "name": filename, "path": main_path})

    except Exception as exc:
        log.exception("import error")
        return web.json_response({"error": str(exc)}, status=500)


@routes.get("/comfyfont/fonts")
async def _list_fonts(request: web.Request) -> web.Response:
    """Return the list of font names currently in the workspace."""
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
