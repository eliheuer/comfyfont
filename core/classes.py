"""
Font data model dataclasses.

Mirrors Fontra's core/classes.py. All objects serialise to/from plain
dicts via cattrs so they can be sent over the WebSocket as JSON.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

import cattrs

from .path import ContourInfo, PackedPath, PointType

# ---------------------------------------------------------------------------
# cattrs converter — shared across this module

_converter = cattrs.Converter()

# Round floats to keep JSON compact
_converter.register_unstructure_hook(float, lambda v: round(v, 6))

# PackedPath needs ContourInfo objects reconstructed from dicts
def _structure_packed_path(d: dict, _) -> PackedPath:
    contourInfo = [
        ContourInfo(endPoint=c["endPoint"], isClosed=c.get("isClosed", True))
        for c in d.get("contourInfo", [])
    ]
    return PackedPath(
        coordinates=d.get("coordinates", []),
        pointTypes=d.get("pointTypes", []),
        contourInfo=contourInfo,
        pointAttributes=d.get("pointAttributes"),
    )

_converter.register_structure_hook(PackedPath, _structure_packed_path)


def structure(data: Any, cls: type) -> Any:
    return _converter.structure(data, cls)


def unstructure(obj: Any) -> Any:
    return _converter.unstructure(obj)


# ---------------------------------------------------------------------------
# Geometry primitives

@dataclass(kw_only=True)
class Transformation:
    xx: float = 1.0
    xy: float = 0.0
    yx: float = 0.0
    yy: float = 1.0
    dx: float = 0.0
    dy: float = 0.0

    def to_tuple(self) -> tuple[float, float, float, float, float, float]:
        return (self.xx, self.xy, self.yx, self.yy, self.dx, self.dy)


@dataclass(kw_only=True)
class Anchor:
    name: str = ""
    x: float = 0.0
    y: float = 0.0
    identifier: Optional[str] = None
    customData: dict = field(default_factory=dict)


@dataclass(kw_only=True)
class Guideline:
    name: str = ""
    x: Optional[float] = None
    y: Optional[float] = None
    angle: float = 0.0
    identifier: Optional[str] = None
    customData: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Glyph structure

@dataclass(kw_only=True)
class Component:
    name: str
    transformation: Transformation = field(default_factory=Transformation)
    location: dict[str, float] = field(default_factory=dict)
    identifier: Optional[str] = None


@dataclass(kw_only=True)
class StaticGlyph:
    """A single master / layer of a glyph (one set of outlines)."""

    path: PackedPath = field(default_factory=PackedPath)
    components: list[Component] = field(default_factory=list)
    xAdvance: Optional[float] = None
    yAdvance: Optional[float] = None
    verticalOrigin: Optional[float] = None
    anchors: list[Anchor] = field(default_factory=list)
    guidelines: list[Guideline] = field(default_factory=list)
    customData: dict = field(default_factory=dict)


@dataclass(kw_only=True)
class Layer:
    glyph: StaticGlyph = field(default_factory=StaticGlyph)
    customData: dict = field(default_factory=dict)


@dataclass(kw_only=True)
class GlyphSource:
    name: str = ""
    locationBase: Optional[str] = None  # identifier of a FontSource
    location: dict[str, float] = field(default_factory=dict)
    layerName: str = ""
    inactive: bool = False
    customData: dict = field(default_factory=dict)


@dataclass(kw_only=True)
class GlyphAxis:
    name: str
    minimum: float
    default: float
    maximum: float


@dataclass(kw_only=True)
class VariableGlyph:
    """
    The unit exchanged over the wire. Holds all masters of one glyph.

    Wire format (JSON) example:
    {
      "name": "A",
      "axes": [],
      "sources": [{"name": "Regular", "layerName": "Regular", ...}],
      "layers": {
        "Regular": {
          "glyph": {
            "xAdvance": 600,
            "path": {"coordinates": [...], "pointTypes": [...], "contourInfo": [...]}
          }
        }
      }
    }
    """

    name: str
    axes: list[GlyphAxis] = field(default_factory=list)
    sources: list[GlyphSource] = field(default_factory=list)
    layers: dict[str, Layer] = field(default_factory=dict)
    customData: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Font-level structure

@dataclass(kw_only=True)
class AxisValueLabel:
    name: str
    value: float
    minValue: Optional[float] = None
    maxValue: Optional[float] = None
    linkedValue: Optional[float] = None
    elidable: bool = False


@dataclass(kw_only=True)
class GlobalAxis:
    name: str
    tag: str
    minimum: float
    default: float
    maximum: float
    label: str = ""
    valueLabels: list[AxisValueLabel] = field(default_factory=list)
    hidden: bool = False


@dataclass(kw_only=True)
class FontSource:
    """A named master / instance in the design space."""

    name: str
    identifier: str = ""
    location: dict[str, float] = field(default_factory=dict)
    italicAngle: float = 0.0
    customData: dict = field(default_factory=dict)


@dataclass(kw_only=True)
class FontInfo:
    familyName: str = ""
    versionMajor: int = 0
    versionMinor: int = 0
    copyright: str = ""
    trademark: str = ""
    description: str = ""
    unitsPerEm: int = 1000
    xHeight: Optional[float] = None
    capHeight: Optional[float] = None
    ascender: Optional[float] = None
    descender: Optional[float] = None
    lineGap: Optional[float] = None
    italicAngle: float = 0.0
    customData: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# cattrs hooks for nested types

def _structure_component(d: dict, _) -> Component:
    return Component(
        name=d["name"],
        transformation=_converter.structure(
            d.get("transformation", {}), Transformation
        ),
        location=d.get("location", {}),
        identifier=d.get("identifier"),
    )

def _structure_static_glyph(d: dict, _) -> StaticGlyph:
    return StaticGlyph(
        path=_structure_packed_path(d.get("path", {}), None),
        components=[_structure_component(c, None) for c in d.get("components", [])],
        xAdvance=d.get("xAdvance"),
        yAdvance=d.get("yAdvance"),
        verticalOrigin=d.get("verticalOrigin"),
        anchors=[_converter.structure(a, Anchor) for a in d.get("anchors", [])],
        guidelines=[_converter.structure(g, Guideline) for g in d.get("guidelines", [])],
        customData=d.get("customData", {}),
    )

def _structure_layer(d: dict, _) -> Layer:
    return Layer(
        glyph=_structure_static_glyph(d.get("glyph", {}), None),
        customData=d.get("customData", {}),
    )

def _structure_variable_glyph(d: dict, _) -> VariableGlyph:
    return VariableGlyph(
        name=d["name"],
        axes=[_converter.structure(a, GlyphAxis) for a in d.get("axes", [])],
        sources=[_converter.structure(s, GlyphSource) for s in d.get("sources", [])],
        layers={k: _structure_layer(v, None) for k, v in d.get("layers", {}).items()},
        customData=d.get("customData", {}),
    )

_converter.register_structure_hook(Component, _structure_component)
_converter.register_structure_hook(StaticGlyph, _structure_static_glyph)
_converter.register_structure_hook(Layer, _structure_layer)
_converter.register_structure_hook(VariableGlyph, _structure_variable_glyph)
