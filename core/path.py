"""
PackedPath: the wire format for glyph outline data.

Mirrors Fontra's core/path.py exactly so glyph data serialises cleanly
to/from JSON and the same structure works in both Python and JavaScript.

PointType encoding (same bit layout as Fontra):
  0x00  ON_CURVE         – on-curve, not smooth
  0x01  OFF_CURVE_QUAD   – off-curve, quadratic (TrueType)
  0x02  OFF_CURVE_CUBIC  – off-curve, cubic (PostScript/CFF)
  0x08  ON_CURVE_SMOOTH  – on-curve, smooth (handles are collinear)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from fontTools.pens.pointPen import AbstractPointPen


class PointType(IntEnum):
    ON_CURVE = 0x00
    OFF_CURVE_QUAD = 0x01
    OFF_CURVE_CUBIC = 0x02
    ON_CURVE_SMOOTH = 0x08


@dataclass
class ContourInfo:
    endPoint: int
    isClosed: bool = True


@dataclass
class PackedPath:
    """
    Memory-efficient flat representation of a glyph outline.

    coordinates  – flat [x0, y0, x1, y1, …] list of floats
    pointTypes   – one PointType per point
    contourInfo  – one ContourInfo per contour; endPoint is the absolute
                   index of the last point in that contour
    """

    coordinates: list[float] = field(default_factory=list)
    pointTypes: list[int] = field(default_factory=list)
    contourInfo: list[ContourInfo] = field(default_factory=list)
    pointAttributes: list[dict | None] | None = None

    # ------------------------------------------------------------------
    # fonttools PointPen interface

    def drawPoints(self, pen: AbstractPointPen) -> None:
        """Convert this PackedPath to fonttools PointPen calls."""
        coords = self.coordinates
        types = self.pointTypes
        contourStart = 0

        for ci in self.contourInfo:
            pen.beginPath()
            end = ci.endPoint
            n = end - contourStart + 1

            for i in range(n):
                abs_i = contourStart + i
                x = coords[abs_i * 2]
                y = coords[abs_i * 2 + 1]
                pt = types[abs_i]
                base = pt & 0x03
                smooth = bool(pt & PointType.ON_CURVE_SMOOTH)

                if base == PointType.OFF_CURVE_CUBIC or base == PointType.OFF_CURVE_QUAD:
                    pen.addPoint((x, y), segmentType=None)
                else:
                    # Determine segment type from preceding off-curve (if any)
                    if not ci.isClosed and i == 0:
                        segType = "move"
                    else:
                        prev_abs = contourStart + (i - 1) % n
                        prev_base = types[prev_abs] & 0x03
                        if prev_base == PointType.OFF_CURVE_CUBIC:
                            segType = "curve"
                        elif prev_base == PointType.OFF_CURVE_QUAD:
                            segType = "qcurve"
                        else:
                            segType = "line"
                    pen.addPoint((x, y), segmentType=segType, smooth=smooth)

            pen.endPath()
            contourStart = end + 1

    # ------------------------------------------------------------------
    # Iteration helpers (used by renderer and editor)

    def iterPoints(self):
        """Yield (x, y, pointType, contourIndex) for every point."""
        contourStart = 0
        for ci_idx, ci in enumerate(self.contourInfo):
            end = ci.endPoint
            for abs_i in range(contourStart, end + 1):
                x = self.coordinates[abs_i * 2]
                y = self.coordinates[abs_i * 2 + 1]
                pt = self.pointTypes[abs_i]
                yield x, y, pt, ci_idx
            contourStart = end + 1

    def iterHandles(self):
        """
        Yield ((x1, y1), (x2, y2)) handle-line pairs for every off-curve
        point and its nearest on-curve neighbour.
        """
        coords = self.coordinates
        types = self.pointTypes
        contourStart = 0

        for ci in self.contourInfo:
            end = ci.endPoint
            n = end - contourStart + 1

            for i in range(n):
                abs_i = contourStart + i
                base = types[abs_i] & 0x03
                if base not in (PointType.OFF_CURVE_CUBIC, PointType.OFF_CURVE_QUAD):
                    continue

                x1 = coords[abs_i * 2]
                y1 = coords[abs_i * 2 + 1]

                # Find the nearest on-curve point forward (wrapping within contour)
                for di in range(1, n + 1):
                    j = contourStart + (i + di) % n
                    if (types[j] & 0x03) == 0:
                        x2 = coords[j * 2]
                        y2 = coords[j * 2 + 1]
                        yield (x1, y1), (x2, y2)
                        break

            contourStart = end + 1


# ---------------------------------------------------------------------------
# fonttools PointPen → PackedPath converter

class PackedPathPointPen:
    """
    A fonttools AbstractPointPen that accumulates pen calls into a PackedPath.

    Usage:
        pen = PackedPathPointPen()
        glyph.drawPoints(pen)
        path = pen.getPath()
    """

    def __init__(self) -> None:
        self._coordinates: list[float] = []
        self._pointTypes: list[int] = []
        self._contourInfo: list[ContourInfo] = []
        self._contourStartIndex: int = 0
        self._isClosed: bool = True
        self._currentSegTypes: list[str | None] = []

    def beginPath(self, **kwargs) -> None:
        self._isClosed = True
        self._contourStartIndex = len(self._pointTypes)
        self._currentSegTypes = []

    def addPoint(
        self,
        pt: tuple[float, float],
        segmentType: str | None = None,
        smooth: bool = False,
        name: str | None = None,
        identifier: str | None = None,
        **kwargs,
    ) -> None:
        self._coordinates.extend(pt)
        self._currentSegTypes.append(segmentType)

        if segmentType is None:
            pt_type = PointType.OFF_CURVE_CUBIC  # provisional; fixed in endPath
        elif segmentType == "move":
            self._isClosed = False
            pt_type = PointType.ON_CURVE
        else:
            pt_type = PointType.ON_CURVE_SMOOTH if smooth else PointType.ON_CURVE

        self._pointTypes.append(int(pt_type))

    def endPath(self) -> None:
        start = self._contourStartIndex
        n = len(self._currentSegTypes)

        # Fix provisional OFF_CURVE_CUBIC → OFF_CURVE_QUAD where needed.
        # For each off-curve run, find the next on-curve; if it's "qcurve"
        # all off-curves in that run are quadratic.
        for i, seg in enumerate(self._currentSegTypes):
            abs_i = start + i
            if self._pointTypes[abs_i] == int(PointType.OFF_CURVE_CUBIC):
                for di in range(1, n + 1):
                    j = (i + di) % n
                    next_seg = self._currentSegTypes[j]
                    if next_seg is not None:
                        if next_seg == "qcurve":
                            self._pointTypes[abs_i] = int(PointType.OFF_CURVE_QUAD)
                        break

        endPoint = start + n - 1
        self._contourInfo.append(
            ContourInfo(endPoint=endPoint, isClosed=self._isClosed)
        )

    def addComponent(self, glyphName, transformation, identifier=None, **kwargs) -> None:
        pass  # components are handled separately at the StaticGlyph level

    def getPath(self) -> PackedPath:
        return PackedPath(
            coordinates=list(self._coordinates),
            pointTypes=list(self._pointTypes),
            contourInfo=list(self._contourInfo),
        )
