"""
Read/write backend for .designspace font projects.

Following Fontra's DesignspaceBackend design:
  - Each source has a stable opaque identifier stored in the designspace lib.
  - All axis values are surfaced in USER SPACE throughout the API.
    (fontTools stores source locations in design space internally;
    we convert via axis.map_backward() on the way out.)
  - Layer names encode both the source and the UFO layer:
      default layer of a master  →  sourceIdentifier
      non-default UFO layer      →  "sourceIdentifier^ufoLayerName"
  - GlyphSource.locationBase = sourceIdentifier
    GlyphSource.location      = per-glyph offset from that master (usually {})
"""

from __future__ import annotations

import logging
import uuid
from pathlib import Path

import ufoLib2
from fontTools.designspaceLib import DesignSpaceDocument

log = logging.getLogger(__name__)

from ..classes import (
    FontInfo,
    FontSource,
    GlobalAxis,
    GlyphSource,
    Layer,
    StaticGlyph,
    VariableGlyph,
)
from ..path import PackedPath, PackedPathPointPen

# Stored in the .designspace lib to give each source a stable identifier.
_SOURCE_ID_LIB_KEY = "xyz.fontra.source-names"

# Separator between sourceId and ufoLayerName in the Fontra layer name.
_LAYER_SEP = "^"


# ---------------------------------------------------------------------------
# Internal source wrapper

class _DSSource:
    """Binds a fontTools SourceDescriptor to a stable identifier and layer info."""

    def __init__(
        self,
        identifier: str,
        descriptor,          # fontTools SourceDescriptor
        ufo_path: Path,
        ufo_layer_name: str, # "" means the default (foreground) UFO layer
    ) -> None:
        self.identifier    = identifier
        self.descriptor    = descriptor
        self.ufo_path      = ufo_path
        self.ufo_layer_name = ufo_layer_name

    @property
    def fontra_layer_name(self) -> str:
        if not self.ufo_layer_name:
            return self.identifier
        return f"{self.identifier}{_LAYER_SEP}{self.ufo_layer_name}"


# ---------------------------------------------------------------------------
# Backend

class DesignspaceBackend:
    """
    Read/write backend for a .designspace project (multiple UFO masters).

    Implements the same duck-typed protocol as UFOBackend so FontHandler
    can use either without knowing the difference.
    """

    def __init__(self, ds: DesignSpaceDocument, path: Path) -> None:
        self._ds      = ds
        self._path    = path
        self._sources: list[_DSSource]      = []
        self._by_id:  dict[str, _DSSource]  = {}
        self._ufos:   dict[str, ufoLib2.Font] = {}  # keyed by str(ufo_path)
        self._build_source_map()

    @classmethod
    def fromPath(cls, path: Path | str) -> "DesignspaceBackend":
        path = Path(path)
        ds = DesignSpaceDocument.fromfile(str(path))
        try:
            ds.findDefault()
        except Exception:
            pass
        return cls(ds, path)

    # ------------------------------------------------------------------
    # Initialisation helpers

    def _build_source_map(self) -> None:
        id_map: dict[str, str] = dict(self._ds.lib.get(_SOURCE_ID_LIB_KEY) or {})
        changed = False

        for descriptor in self._ds.sources:
            src_name = descriptor.name or ""
            identifier = id_map.get(src_name)
            if not identifier:
                identifier = uuid.uuid4().hex[:8]
                id_map[src_name] = identifier
                changed = True

            ufo_path = Path(descriptor.path) if descriptor.path else None
            if ufo_path is None or not ufo_path.exists():
                continue

            ufo_layer = descriptor.layerName or ""
            self._sources.append(_DSSource(identifier, descriptor, ufo_path, ufo_layer))
            self._by_id[identifier] = self._sources[-1]

        if changed:
            self._ds.lib[_SOURCE_ID_LIB_KEY] = id_map
            # Persist the new identifiers back to disk so they survive a reload.
            try:
                self._ds.write(self._ds.path or str(self._path))
            except Exception:
                pass

        log.info("DesignspaceBackend: loaded %d sources from %s", len(self._sources), self._path)
        for src in self._sources:
            log.info("  source %r → %s (exists=%s)", src.identifier, src.ufo_path, src.ufo_path.exists())

    def _ufo(self, path: Path) -> ufoLib2.Font:
        key = str(path)
        if key not in self._ufos:
            self._ufos[key] = ufoLib2.Font.open(key)
        return self._ufos[key]

    def _default_source(self) -> _DSSource | None:
        if not self._sources:
            return None
        for src in self._sources:
            if getattr(src.descriptor, "isDefault", False):
                return src
        return self._sources[0]

    def _user_location(self, descriptor) -> dict[str, float]:
        """Convert a source's design-space location to user space."""
        design_loc = dict(descriptor.location or {})
        result: dict[str, float] = {}
        for axis in self._ds.axes:
            design_val = design_loc.get(axis.name, axis.default)
            # map_backward converts design space → user space.
            # For axes with no <map> element this is an identity.
            try:
                result[axis.name] = axis.map_backward(design_val)
            except Exception:
                result[axis.name] = design_val
        return result

    def _read_static_glyph(
        self, ufo: ufoLib2.Font, ufo_layer_name: str, glyph_name: str
    ) -> StaticGlyph | None:
        if ufo_layer_name:
            if ufo_layer_name not in ufo.layers:
                return None
            ufo_layer = ufo.layers[ufo_layer_name]
        else:
            ufo_layer = ufo.layers.defaultLayer

        if glyph_name not in ufo_layer:
            return None

        ufo_glyph = ufo_layer[glyph_name]
        pen = PackedPathPointPen()
        ufo_glyph.drawPoints(pen)

        return StaticGlyph(
            path=pen.getPath(),
            xAdvance=float(ufo_glyph.width),
        )

    # ------------------------------------------------------------------
    # ReadableFontBackend

    async def getGlyphMap(self) -> dict[str, list[int]]:
        src = self._default_source()
        if src is None:
            return {}
        ufo = self._ufo(src.ufo_path)
        return {name: list(ufo[name].unicodes) for name in ufo.keys()}

    async def getGlyph(self, glyph_name: str) -> VariableGlyph | None:
        sources: list[GlyphSource] = []
        layers:  dict[str, Layer]  = {}

        for src in self._sources:
            ufo    = self._ufo(src.ufo_path)
            static = self._read_static_glyph(ufo, src.ufo_layer_name, glyph_name)
            if static is None:
                continue

            layer_name = src.fontra_layer_name
            layers[layer_name] = Layer(glyph=static)
            sources.append(GlyphSource(
                name=src.descriptor.name or src.identifier,
                locationBase=src.identifier,
                location={},        # per-glyph offset from the master; usually empty
                layerName=layer_name,
            ))

        if not sources:
            return None

        return VariableGlyph(name=glyph_name, sources=sources, layers=layers)

    async def getAxes(self) -> list[GlobalAxis]:
        axes = []
        for axis in self._ds.axes:
            label = axis.name
            if axis.labelNames:
                label = axis.labelNames.get("en", axis.name)
            axes.append(GlobalAxis(
                name=axis.name,
                tag=axis.tag,
                minimum=axis.minimum,
                default=axis.default,
                maximum=axis.maximum,
                label=label,
            ))
        return axes

    async def getSources(self) -> dict[str, FontSource]:
        return {
            src.identifier: FontSource(
                name=src.descriptor.name or src.identifier,
                identifier=src.identifier,
                location=self._user_location(src.descriptor),
            )
            for src in self._sources
        }

    async def getFontInfo(self) -> FontInfo:
        src = self._default_source()
        if src is None:
            return FontInfo()
        info = self._ufo(src.ufo_path).info
        return FontInfo(
            familyName=info.familyName or "",
            versionMajor=info.versionMajor or 0,
            versionMinor=info.versionMinor or 0,
            copyright=info.copyright or "",
            unitsPerEm=info.unitsPerEm or 1000,
            xHeight=float(info.xHeight)      if info.xHeight      is not None else None,
            capHeight=float(info.capHeight)  if info.capHeight    is not None else None,
            ascender=float(info.ascender)    if info.ascender     is not None else None,
            descender=float(info.descender)  if info.descender    is not None else None,
            italicAngle=float(info.italicAngle) if info.italicAngle is not None else 0.0,
        )

    async def getUnitsPerEm(self) -> int:
        src = self._default_source()
        if src is None:
            return 1000
        return int(self._ufo(src.ufo_path).info.unitsPerEm or 1000)

    async def getGlyphAtLocation(
        self, glyph_name: str, location: dict[str, float]
    ) -> StaticGlyph | None:
        """
        Return an interpolated StaticGlyph at the given user-space axis location.

        Uses fontTools VariationModel for correct multi-master interpolation.
        Falls back to the nearest master if outlines are not compatible.
        """
        source_data: list[tuple[dict[str, float], StaticGlyph]] = []
        for src in self._sources:
            ufo    = self._ufo(src.ufo_path)
            static = self._read_static_glyph(ufo, src.ufo_layer_name, glyph_name)
            if static is None:
                continue
            source_data.append((self._user_location(src.descriptor), static))

        if not source_data:
            return None
        if len(source_data) == 1:
            return source_data[0][1]

        return self._interpolate(source_data, location)

    def _interpolate(
        self,
        source_data: list[tuple[dict[str, float], StaticGlyph]],
        location: dict[str, float],
    ) -> StaticGlyph:
        import numpy as np
        from fontTools.varLib.models import VariationModel, normalizeLocation

        axis_dict = {
            ax.name: (ax.minimum, ax.default, ax.maximum)
            for ax in self._ds.axes
        }
        locs    = [sd[0] for sd in source_data]
        statics = [sd[1] for sd in source_data]

        norm_locs   = [normalizeLocation(loc, axis_dict) for loc in locs]
        norm_target = normalizeLocation(location, axis_dict)

        # Verify contour compatibility — same number of coordinates across all masters.
        n_coords = len(statics[0].path.coordinates)
        if any(len(s.path.coordinates) != n_coords for s in statics[1:]):
            return self._nearest(source_data, location)

        try:
            model = VariationModel(norm_locs)

            # Interpolate coordinates as a numpy array (one call, fully vectorised).
            coord_matrix = np.array(
                [s.path.coordinates for s in statics], dtype=float
            )  # shape: (n_masters, n_coords)
            deltas = model.getDeltas(list(coord_matrix))
            interp_coords = model.interpolateFromDeltas(norm_target, deltas)

            # Interpolate xAdvance.
            advances    = [float(s.xAdvance or 0) for s in statics]
            adv_deltas  = model.getDeltas(advances)
            interp_adv  = model.interpolateFromDeltas(norm_target, adv_deltas)

            ref = statics[0].path
            return StaticGlyph(
                path=PackedPath(
                    coordinates=[float(v) for v in interp_coords],
                    pointTypes=list(ref.pointTypes),
                    contourInfo=list(ref.contourInfo),
                ),
                xAdvance=float(interp_adv),
            )
        except Exception:
            return self._nearest(source_data, location)

    def _nearest(
        self,
        source_data: list[tuple[dict[str, float], StaticGlyph]],
        location: dict[str, float],
    ) -> StaticGlyph:
        best, best_dist = source_data[0][1], float("inf")
        for loc, static in source_data:
            dist = sum((location.get(k, 0) - v) ** 2 for k, v in loc.items())
            if dist < best_dist:
                best_dist, best = dist, static
        return best

    async def aclose(self) -> None:
        self._ufos.clear()

    # ------------------------------------------------------------------
    # WritableFontBackend

    async def putGlyph(
        self, glyph_name: str, glyph: VariableGlyph, code_points: list[int]
    ) -> None:
        for gs in glyph.sources:
            if not gs.locationBase or gs.locationBase not in self._by_id:
                continue
            src   = self._by_id[gs.locationBase]
            layer = glyph.layers.get(gs.layerName)
            if layer is None:
                continue

            ufo = self._ufo(src.ufo_path)

            # Resolve the target UFO layer.
            if src.ufo_layer_name:
                if src.ufo_layer_name not in ufo.layers:
                    ufo.layers.newLayer(src.ufo_layer_name)
                ufo_layer = ufo.layers[src.ufo_layer_name]
            else:
                ufo_layer = ufo.layers.defaultLayer

            if glyph_name not in ufo_layer:
                ufo_layer.newGlyph(glyph_name)
            ufo_glyph = ufo_layer[glyph_name]

            static = layer.glyph
            if static.xAdvance is not None:
                ufo_glyph.width = int(static.xAdvance)

            ufo_glyph.clearContours()
            ufo_glyph.clearComponents()
            pp = ufo_glyph.getPointPen()
            static.path.drawPoints(pp)
            for comp in static.components:
                pp.addComponent(comp.name, comp.transformation.to_tuple())

            # Codepoints live on the default-layer glyph only.
            if not src.ufo_layer_name and glyph_name in ufo:
                ufo[glyph_name].unicodes = code_points

            ufo.save(str(src.ufo_path))

    async def putFontInfo(self, font_info: FontInfo) -> None:
        src = self._default_source()
        if src is None:
            return
        ufo = self._ufo(src.ufo_path)
        ufo.info.familyName = font_info.familyName
        ufo.info.unitsPerEm = font_info.unitsPerEm
        ufo.info.copyright  = font_info.copyright
        ufo.save(str(src.ufo_path))

    async def deleteGlyph(self, glyph_name: str) -> None:
        for src in self._sources:
            ufo = self._ufo(src.ufo_path)
            target_layer = (
                ufo.layers[src.ufo_layer_name]
                if src.ufo_layer_name and src.ufo_layer_name in ufo.layers
                else ufo.layers.defaultLayer
            )
            if glyph_name in target_layer:
                del target_layer[glyph_name]
            ufo.save(str(src.ufo_path))
