"""Font format conversion utilities: UFO → TTF and TTF → UFO."""

from __future__ import annotations

import logging
import os
import shutil

log = logging.getLogger(__name__)


def compile_ufo_to_ttf(ufo_path: str) -> str:
    """Compile a UFO to a TrueType-flavored TTF. Returns the TTF path."""
    import ufo2ft
    import ufoLib2

    ttf_path = os.path.splitext(ufo_path)[0] + ".ttf"
    font = ufoLib2.Font.open(ufo_path)
    tt = ufo2ft.compileTTF(font)
    tt.save(ttf_path)
    log.info("Compiled %s → %s", ufo_path, ttf_path)
    return ttf_path


def ttf_to_ufo(tt, dest_ufo: str) -> None:
    """Convert a loaded TTFont to a UFO and save it to dest_ufo."""
    import ufoLib2

    font = ufoLib2.Font()

    name_table = tt["name"]
    def n(nid):
        r = name_table.getName(nid, 3, 1, 0x0409) or name_table.getName(nid, 1, 0, 0)
        try:
            return r.toUnicode().strip() if r else ""
        except Exception:
            return ""

    head = tt.get("head")
    os2  = tt.get("OS/2")
    post = tt.get("post")
    hhea = tt.get("hhea")

    font.info.familyName = n(1)
    font.info.styleName  = n(2)
    font.info.copyright  = n(0)
    font.info.trademark  = n(7)
    font.info.unitsPerEm = head.unitsPerEm if head else 1000

    if os2:
        font.info.ascender                = os2.sTypoAscender
        font.info.descender               = os2.sTypoDescender
        font.info.openTypeOS2TypoLineGap  = os2.sTypoLineGap
        font.info.xHeight                 = getattr(os2, "sxHeight",   None)
        font.info.capHeight               = getattr(os2, "sCapHeight", None)
        font.info.openTypeOS2WeightClass  = os2.usWeightClass
    if post:
        font.info.italicAngle = post.italicAngle
    if hhea:
        font.info.openTypeHheaAscender  = hhea.ascent
        font.info.openTypeHheaDescender = hhea.descent

    cmap = tt.getBestCmap() or {}
    reverse: dict[str, list[int]] = {}
    for cp, gname in cmap.items():
        reverse.setdefault(gname, []).append(cp)

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
    try:
        font.save(dest_ufo)
    except Exception:
        log.warning("ufoLib2 save failed for %s", dest_ufo, exc_info=True)
        raise
