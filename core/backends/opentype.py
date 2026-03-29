"""
Read-only backend for compiled fonts: TTF, OTF, WOFF, WOFF2.

Converts fonttools glyph outlines to PackedPath via PackedPathPointPen,
applying GuessSmoothPointPen to infer smooth flags from handle collinearity.
"""

from __future__ import annotations

import math
from pathlib import Path

from fontTools.pens.pointPen import AbstractPointPen
from fontTools.ttLib import TTFont

from ..classes import (
    FontInfo,
    FontSource,
    GlobalAxis,
    GlyphSource,
    Layer,
    StaticGlyph,
    VariableGlyph,
)
from ..path import ContourInfo, PackedPath, PackedPathPointPen, PointType


# ---------------------------------------------------------------------------
# Smooth-flag inference (mirrors Fontra's GuessSmoothPointPen)

class GuessSmoothPointPen(AbstractPointPen):
    """
    Wraps another PointPen and replaces smooth=False with smooth=True on
    on-curve points whose two adjacent handles are collinear (angle diff < 0.1°).
    """

    _ANGLE_THRESHOLD = math.radians(0.1)

    def __init__(self, outPen: AbstractPointPen) -> None:
        self._outPen = outPen
        self._points: list[tuple] = []
        self._kwargs: dict = {}

    def beginPath(self, **kwargs) -> None:
        self._points = []
        self._kwargs = kwargs

    def addPoint(self, pt, segmentType=None, smooth=False, **kwargs) -> None:
        self._points.append((pt, segmentType, smooth, kwargs))

    def endPath(self) -> None:
        pts = self._points
        n = len(pts)
        self._outPen.beginPath(**self._kwargs)
        for i, (pt, segType, smooth, kw) in enumerate(pts):
            if segType is not None and segType != "move" and not smooth:
                prev_pt, prev_seg, _, _ = pts[(i - 1) % n]
                next_pt, next_seg, _, _ = pts[(i + 1) % n]
                if prev_seg is None and next_seg is None:
                    dx1 = pt[0] - prev_pt[0]
                    dy1 = pt[1] - prev_pt[1]
                    dx2 = next_pt[0] - pt[0]
                    dy2 = next_pt[1] - pt[1]
                    a1 = math.atan2(dy1, dx1)
                    a2 = math.atan2(dy2, dx2)
                    if abs(a1 - a2) < self._ANGLE_THRESHOLD:
                        smooth = True
            self._outPen.addPoint(pt, segmentType=segType, smooth=smooth, **kw)
        self._outPen.endPath()

    def addComponent(self, glyphName, transformation, **kwargs) -> None:
        self._outPen.addComponent(glyphName, transformation, **kwargs)


# ---------------------------------------------------------------------------
# OTF backend

class OTFBackend:
    """Read-only backend for compiled TTF/OTF/WOFF/WOFF2 fonts."""

    def __init__(self, font: TTFont, path: Path) -> None:
        self._font = font
        self._path = path
        self._glyphSet = font.getGlyphSet()
        self._cmap: dict[str, list[int]] = {}
        self._reverseGlyphMap: dict[str, list[int]] = {}
        self._buildGlyphMap()

    @classmethod
    def fromPath(cls, path: Path | str) -> "OTFBackend":
        path = Path(path)
        font = TTFont(str(path), lazy=True)
        return cls(font, path)

    def _buildGlyphMap(self) -> None:
        cmap = self._font.getBestCmap() or {}
        reverse: dict[str, list[int]] = {}
        for codepoint, glyphName in cmap.items():
            reverse.setdefault(glyphName, []).append(codepoint)
        self._reverseGlyphMap = reverse

    # ------------------------------------------------------------------
    # ReadableFontBackend

    async def getGlyphMap(self) -> dict[str, list[int]]:
        result = {}
        for name in self._font.getGlyphOrder():
            result[name] = self._reverseGlyphMap.get(name, [])
        return result

    async def getGlyph(self, glyphName: str) -> VariableGlyph | None:
        if glyphName not in self._glyphSet:
            return None

        ttGlyph = self._glyphSet[glyphName]
        pen = PackedPathPointPen()
        ttGlyph.drawPoints(GuessSmoothPointPen(pen))
        path = pen.getPath()

        xAdvance = ttGlyph.width

        staticGlyph = StaticGlyph(path=path, xAdvance=float(xAdvance))
        layer = Layer(glyph=staticGlyph)
        source = GlyphSource(name="default", layerName="default", location={})

        return VariableGlyph(
            name=glyphName,
            axes=[],
            sources=[source],
            layers={"default": layer},
        )

    async def getAxes(self) -> list[GlobalAxis]:
        axes = []
        if "fvar" not in self._font:
            return axes
        from ..classes import GlobalAxis
        for ax in self._font["fvar"].axes:
            axes.append(
                GlobalAxis(
                    name=ax.axisNameID,  # resolved below if possible
                    tag=ax.axisTag,
                    minimum=ax.minValue,
                    default=ax.defaultValue,
                    maximum=ax.maxValue,
                )
            )
        return axes

    async def getSources(self) -> dict[str, FontSource]:
        return {"default": FontSource(name="default", identifier="default")}

    async def getFontInfo(self) -> FontInfo:
        name = self._font["name"]
        def getName(nameID: int) -> str:
            rec = name.getName(nameID, 3, 1, 0x0409)
            if rec is None:
                rec = name.getName(nameID, 1, 0, 0)
            return rec.toUnicode() if rec else ""

        head = self._font.get("head")
        os2 = self._font.get("OS/2")

        return FontInfo(
            familyName=getName(1),
            versionMajor=0,
            versionMinor=0,
            copyright=getName(0),
            unitsPerEm=head.unitsPerEm if head else 1000,
            xHeight=float(os2.sxHeight) if os2 and hasattr(os2, "sxHeight") else None,
            capHeight=float(os2.sCapHeight) if os2 and hasattr(os2, "sCapHeight") else None,
            ascender=float(os2.sTypoAscender) if os2 else None,
            descender=float(os2.sTypoDescender) if os2 else None,
        )

    async def getUnitsPerEm(self) -> int:
        head = self._font.get("head")
        return int(head.unitsPerEm) if head else 1000

    async def aclose(self) -> None:
        self._font.close()
