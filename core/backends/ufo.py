"""
Read/write backend for UFO font packages (and .designspace files).

Uses ufoLib2 for the data model and fonttools pens for outline conversion.
"""

from __future__ import annotations

from pathlib import Path

import ufoLib2

from ..classes import (
    FontInfo,
    FontSource,
    GlobalAxis,
    GlyphSource,
    Layer,
    StaticGlyph,
    VariableGlyph,
)
from ..path import ContourInfo, PackedPath, PackedPathPointPen


class UFOBackend:
    """Read/write backend for a single UFO directory."""

    def __init__(self, font: ufoLib2.Font, path: Path) -> None:
        self._font = font
        self._path = path

    @classmethod
    def fromPath(cls, path: Path | str) -> "UFOBackend":
        path = Path(path)
        font = ufoLib2.Font.open(str(path))
        return cls(font, path)

    # ------------------------------------------------------------------
    # Conversion helpers

    def _glyphToVariableGlyph(self, glyphName: str) -> VariableGlyph | None:
        if glyphName not in self._font:
            return None

        ufoGlyph = self._font[glyphName]
        pen = PackedPathPointPen()
        ufoGlyph.drawPoints(pen)
        path = pen.getPath()

        staticGlyph = StaticGlyph(
            path=path,
            xAdvance=float(ufoGlyph.width),
        )

        layer = Layer(glyph=staticGlyph)
        source = GlyphSource(name="default", layerName="default", location={})

        customData = {}
        mark = ufoGlyph.lib.get("public.markColor")
        if mark:
            customData["markColor"] = mark

        return VariableGlyph(
            name=glyphName,
            axes=[],
            sources=[source],
            layers={"default": layer},
            customData=customData,
        )

    def _variableGlyphToUFO(self, glyphName: str, glyph: VariableGlyph) -> None:
        """Write the default layer of a VariableGlyph back into the UFO."""
        if not glyph.sources:
            return

        defaultSource = glyph.sources[0]
        defaultLayer = glyph.layers.get(defaultSource.layerName)
        if defaultLayer is None:
            return

        staticGlyph = defaultLayer.glyph

        # Get or create the UFO glyph
        if glyphName not in self._font:
            self._font.newGlyph(glyphName)
        ufoGlyph = self._font[glyphName]

        if staticGlyph.xAdvance is not None:
            ufoGlyph.width = int(staticGlyph.xAdvance)

        # Draw path back via PointPen
        ufoGlyph.clearContours()
        ufoGlyph.clearComponents()
        pointPen = ufoGlyph.getPointPen()
        staticGlyph.path.drawPoints(pointPen)

        for comp in staticGlyph.components:
            pointPen.addComponent(
                comp.name, comp.transformation.to_tuple()
            )

        # Write mark color
        mark = glyph.customData.get("markColor") if glyph.customData else None
        if mark:
            ufoGlyph.lib["public.markColor"] = mark
        elif "public.markColor" in ufoGlyph.lib:
            del ufoGlyph.lib["public.markColor"]

    # ------------------------------------------------------------------
    # ReadableFontBackend

    async def getGlyphMap(self) -> dict[str, list[int]]:
        result = {}
        for glyphName in self._font.keys():
            glyph = self._font[glyphName]
            result[glyphName] = list(glyph.unicodes)
        return result

    async def getGlyph(self, glyphName: str) -> VariableGlyph | None:
        return self._glyphToVariableGlyph(glyphName)

    async def getGlyphAtLocation(
        self, glyphName: str, location: dict[str, float]
    ) -> StaticGlyph | None:
        # Single master — location is irrelevant.
        g = self._glyphToVariableGlyph(glyphName)
        if g is None:
            return None
        layer = g.layers.get(g.sources[0].layerName) if g.sources else None
        return layer.glyph if layer else None

    async def getAxes(self) -> list[GlobalAxis]:
        return []

    async def getSources(self) -> dict[str, FontSource]:
        return {"default": FontSource(name="default", identifier="default")}

    async def getFontInfo(self) -> FontInfo:
        info = self._font.info
        return FontInfo(
            familyName=info.familyName or "",
            versionMajor=info.versionMajor or 0,
            versionMinor=info.versionMinor or 0,
            copyright=info.copyright or "",
            unitsPerEm=info.unitsPerEm or 1000,
            xHeight=float(info.xHeight) if info.xHeight is not None else None,
            capHeight=float(info.capHeight) if info.capHeight is not None else None,
            ascender=float(info.ascender) if info.ascender is not None else None,
            descender=float(info.descender) if info.descender is not None else None,
            italicAngle=float(info.italicAngle) if info.italicAngle is not None else 0.0,
        )

    async def getUnitsPerEm(self) -> int:
        return int(self._font.info.unitsPerEm or 1000)

    async def aclose(self) -> None:
        pass  # ufoLib2 doesn't hold file handles

    # ------------------------------------------------------------------
    # WritableFontBackend

    async def putGlyph(
        self, glyphName: str, glyph: VariableGlyph, codePoints: list[int]
    ) -> None:
        self._variableGlyphToUFO(glyphName, glyph)
        if glyphName in self._font:
            self._font[glyphName].unicodes = codePoints
        self._font.save(str(self._path))

    async def putFontInfo(self, fontInfo: FontInfo) -> None:
        info = self._font.info
        info.familyName = fontInfo.familyName
        info.unitsPerEm = fontInfo.unitsPerEm
        info.copyright = fontInfo.copyright
        self._font.save(str(self._path))

    async def deleteGlyph(self, glyphName: str) -> None:
        if glyphName in self._font:
            del self._font[glyphName]
            self._font.save(str(self._path))
