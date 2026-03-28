"""
Font library manager.

All fonts are stored as UFO source files + a compiled TTF for rendering.

Library layout:
  comfyfont/library/
    FontName.ufo/    ← editable UFO source
    FontName.ttf     ← compiled/copied TTF for fast rendering

FONT type (passed between nodes) = font name string, e.g. "VirtuaGrotesk-Regular".
Use ufo_path(name) / ttf_path(name) to resolve to file paths.
"""

from __future__ import annotations

import io
import logging
import os
import shutil
from pathlib import Path

log = logging.getLogger(__name__)

_library_dir: str | None = None


def init(library_dir: str) -> None:
    global _library_dir
    _library_dir = library_dir
    os.makedirs(library_dir, exist_ok=True)


def get_library_dir() -> str:
    if _library_dir is None:
        raise RuntimeError("library.init() not called")
    return _library_dir


# ---------------------------------------------------------------------------
# Path helpers

def ufo_path(font_name: str) -> str:
    return os.path.join(get_library_dir(), font_name + ".ufo")


def ttf_path(font_name: str) -> str:
    return os.path.join(get_library_dir(), font_name + ".ttf")


# ---------------------------------------------------------------------------
# List fonts

def listFonts() -> list[dict]:
    """Return list of {name, ufo_path, ttf_path, has_ufo, has_ttf}."""
    lib = get_library_dir()
    names: set[str] = set()
    for entry in os.scandir(lib):
        if entry.name.endswith(".ufo") and entry.is_dir():
            names.add(entry.name[:-4])
        elif entry.name.endswith(".ttf") and entry.is_file():
            names.add(entry.name[:-4])
    result = []
    for name in sorted(names):
        up = ufo_path(name)
        tp = ttf_path(name)
        result.append({
            "name": name,
            "ufo_path": up,
            "ttf_path": tp,
            "has_ufo": os.path.isdir(up),
            "has_ttf": os.path.isfile(tp),
        })
    return result


def fontNames() -> list[str]:
    return [f["name"] for f in listFonts()]


# ---------------------------------------------------------------------------
# Import

def importFont(src_path: str) -> dict:
    """
    Import a TTF/OTF/UFO into the library.

    - TTF/OTF: copies the compiled file and converts outlines to UFO.
    - UFO: copies directly; no TTF will be present until recompiled.

    Returns the font record dict.
    """
    src = Path(src_path)
    ext = src.suffix.lower()

    if ext == ".ufo" or src.is_dir():
        return _import_ufo(src)
    elif ext in (".ttf", ".otf", ".woff", ".woff2"):
        return _import_compiled(src)
    else:
        raise ValueError(f"Unsupported font format: {ext!r}")


def _font_name_from_ttf(src: Path) -> str:
    from fontTools.ttLib import TTFont
    tt = TTFont(str(src), lazy=True)
    name_table = tt["name"]
    def n(nid):
        r = name_table.getName(nid, 3, 1, 0x0409) or name_table.getName(nid, 1, 0, 0)
        return r.toUnicode().strip() if r else ""
    family = n(1) or src.stem
    style = n(2) or ""
    tt.close()
    # sanitise for use as directory name
    full = (family + ("-" + style if style and style.lower() != "regular" else ""))
    return full.replace(" ", "-").replace("/", "-")


def _import_compiled(src: Path) -> dict:
    from fontTools.ttLib import TTFont
    import ufoLib2

    font_name = _font_name_from_ttf(src)
    lib = get_library_dir()
    dest_ttf = ttf_path(font_name)
    dest_ufo = ufo_path(font_name)

    # Copy TTF
    shutil.copy2(str(src), dest_ttf)
    log.info("Copied TTF → %s", dest_ttf)

    # Convert to UFO
    tt = TTFont(str(src), lazy=False)
    _ttf_to_ufo(tt, dest_ufo)
    tt.close()
    log.info("Converted → %s", dest_ufo)

    return {"name": font_name, "ufo_path": dest_ufo, "ttf_path": dest_ttf,
            "has_ufo": True, "has_ttf": True}


def _import_ufo(src: Path) -> dict:
    import ufoLib2
    font = ufoLib2.Font.open(str(src))
    family = (font.info.familyName or src.stem).replace(" ", "-")
    style = (font.info.styleName or "").replace(" ", "-")
    font_name = family + ("-" + style if style and style.lower() != "regular" else "")

    dest_ufo = ufo_path(font_name)
    if os.path.exists(dest_ufo):
        shutil.rmtree(dest_ufo)
    shutil.copytree(str(src), dest_ufo)
    log.info("Copied UFO → %s", dest_ufo)

    return {"name": font_name, "ufo_path": dest_ufo, "ttf_path": ttf_path(font_name),
            "has_ufo": True, "has_ttf": False}


def _ttf_to_ufo(tt, dest_ufo: str) -> None:
    """Convert a loaded TTFont to a UFO and save it to dest_ufo."""
    import ufoLib2

    font = ufoLib2.Font()

    # --- Font info ---
    name_table = tt["name"]
    def n(nid):
        r = name_table.getName(nid, 3, 1, 0x0409) or name_table.getName(nid, 1, 0, 0)
        return r.toUnicode().strip() if r else ""

    head = tt.get("head")
    os2  = tt.get("OS/2")
    post = tt.get("post")
    hhea = tt.get("hhea")

    font.info.familyName    = n(1)
    font.info.styleName     = n(2)
    font.info.copyright     = n(0)
    font.info.trademark     = n(7)
    font.info.unitsPerEm    = head.unitsPerEm if head else 1000

    if os2:
        font.info.ascender                  = os2.sTypoAscender
        font.info.descender                 = os2.sTypoDescender
        font.info.openTypeOS2TypoLineGap    = os2.sTypoLineGap
        font.info.xHeight           = getattr(os2, "sxHeight",  None)
        font.info.capHeight         = getattr(os2, "sCapHeight", None)
        font.info.openTypeOS2WeightClass = os2.usWeightClass
    if post:
        font.info.italicAngle = post.italicAngle
    if hhea:
        font.info.openTypeHheaAscender  = hhea.ascent
        font.info.openTypeHheaDescender = hhea.descent

    # --- Unicode map ---
    cmap = tt.getBestCmap() or {}
    reverse: dict[str, list[int]] = {}
    for cp, gname in cmap.items():
        reverse.setdefault(gname, []).append(cp)

    # --- Glyphs ---
    glyph_set = tt.getGlyphSet()
    for glyph_name in tt.getGlyphOrder():
        if glyph_name not in glyph_set:
            continue
        try:
            ufo_glyph = font.newGlyph(glyph_name)
            ufo_glyph.unicodes = reverse.get(glyph_name, [])
            ufo_glyph.width    = glyph_set[glyph_name].width
            glyph_set[glyph_name].drawPoints(ufo_glyph.getPointPen())
        except Exception:
            log.debug("Skipped glyph %r during UFO conversion", glyph_name)

    if os.path.exists(dest_ufo):
        shutil.rmtree(dest_ufo)
    font.save(dest_ufo)
