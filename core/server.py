"""
FontHandler — the server-side RPC subject for a single font session.

Mirrors Fontra's core/fonthandler.py.

One FontHandler instance exists per open font file. Multiple WebSocket
connections share the same handler; changes broadcast to all connections
except the one that sent them.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from .backends import ReadableFontBackend, WritableFontBackend, backendForPath
from .changes import applyChange, makeRollback
from .classes import FontInfo, FontSource, GlobalAxis, VariableGlyph, unstructure
from .path import PackedPath

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Decorator

def remoteMethod(fn):
    """Mark a method as callable from the JS client over WebSocket."""
    fn._isRemoteMethod = True
    return fn


# ---------------------------------------------------------------------------
# FontHandler

class FontHandler:
    def __init__(self, backend: ReadableFontBackend, path: str) -> None:
        self._backend = backend
        self._path = path
        self._connections: list[Any] = []  # RemoteObjectConnection instances
        self._glyphCache: dict[str, VariableGlyph] = {}
        self._glyphMap: dict[str, list[int]] | None = None
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Connection management (called by RemoteObjectConnection)

    async def addConnection(self, connection: Any) -> None:
        self._connections.append(connection)
        log.debug("Client connected (%d total)", len(self._connections))

    async def removeConnection(self, connection: Any) -> None:
        self._connections = [c for c in self._connections if c is not connection]
        log.debug("Client disconnected (%d remain)", len(self._connections))

    async def _broadcast(
        self,
        methodName: str,
        args: list,
        exclude: Any = None,
    ) -> None:
        for conn in list(self._connections):
            if conn is exclude:
                continue
            try:
                await conn.callRemote(methodName, *args)
            except Exception:
                log.exception("Broadcast error to %s", conn)

    # ------------------------------------------------------------------
    # Remote methods — callable from JS

    @remoteMethod
    async def getGlyphMap(self, *, connection=None) -> dict[str, list[int]]:
        if self._glyphMap is None:
            self._glyphMap = await self._backend.getGlyphMap()
        return self._glyphMap

    @remoteMethod
    async def getGlyph(
        self, glyphName: str, *, connection=None
    ) -> VariableGlyph | None:
        if glyphName not in self._glyphCache:
            glyph = await self._backend.getGlyph(glyphName)
            if glyph is not None:
                self._glyphCache[glyphName] = glyph
        return self._glyphCache.get(glyphName)

    @remoteMethod
    async def getAxes(self, *, connection=None) -> list[GlobalAxis]:
        return await self._backend.getAxes()

    @remoteMethod
    async def getSources(self, *, connection=None) -> dict[str, FontSource]:
        return await self._backend.getSources()

    @remoteMethod
    async def getFontInfo(self, *, connection=None) -> FontInfo:
        return await self._backend.getFontInfo()

    @remoteMethod
    async def getUnitsPerEm(self, *, connection=None) -> int:
        return await self._backend.getUnitsPerEm()

    @remoteMethod
    async def editIncremental(
        self, change: dict, *, connection=None
    ) -> None:
        """Broadcast a live (in-progress) change to all other clients. No disk write."""
        await self._broadcast("externalChange", [change, True], exclude=connection)

    @remoteMethod
    async def editFinal(
        self,
        finalChange: dict,
        rollbackChange: dict,
        editLabel: str = "",
        *,
        connection=None,
    ) -> None:
        """Apply a completed change: update cache, write to disk, broadcast."""
        async with self._lock:
            # Apply to cache
            for glyphName, glyph in self._glyphCache.items():
                try:
                    applyChange(glyph, finalChange)
                except Exception:
                    pass  # change may not touch this glyph

            # Write to backend if writable
            if isinstance(self._backend, WritableFontBackend):
                glyphName = self._extractGlyphName(finalChange)
                if glyphName and glyphName in self._glyphCache:
                    glyph = self._glyphCache[glyphName]
                    codePoints = (self._glyphMap or {}).get(glyphName, [])
                    await self._backend.putGlyph(glyphName, glyph, codePoints)

        # Broadcast to other clients
        await self._broadcast("externalChange", [finalChange, False], exclude=connection)

    @remoteMethod
    async def getSpecimenAtLocation(
        self,
        glyphNames: list[str],
        location: dict[str, float],
        *,
        connection=None,
    ) -> dict:
        """
        Bulk-interpolate multiple glyphs at the given axis location.

        Returns a dict of {glyphName: serialised StaticGlyph} for every glyph
        that exists in the font. Used by the node canvas specimen preview.
        """
        result = {}
        if not hasattr(self._backend, "getGlyphAtLocation"):
            log.warning("getSpecimenAtLocation: backend has no getGlyphAtLocation")
            return result
        for name in glyphNames:
            try:
                static = await self._backend.getGlyphAtLocation(name, location)
                if static is not None:
                    result[name] = unstructure(static)
            except Exception as exc:
                log.warning("getGlyphAtLocation failed for %r: %s", name, exc, exc_info=True)
        return result

    @remoteMethod
    async def reloadGlyph(self, glyphName: str, *, connection=None) -> VariableGlyph | None:
        """Force-reload a glyph from disk, bypassing cache."""
        self._glyphCache.pop(glyphName, None)
        return await self.getGlyph(glyphName, connection=connection)

    # ------------------------------------------------------------------
    # Helpers

    def _extractGlyphName(self, change: dict) -> str | None:
        """Try to extract the glyph name from a change path like ["glyphs", "A", ...]."""
        path = change.get("p", [])
        if len(path) >= 2 and path[0] == "glyphs":
            return path[1]
        return None


# ---------------------------------------------------------------------------
# Global handler registry (one per font path)

_handlers: dict[str, FontHandler] = {}


def getFontHandler(fontPath: str) -> FontHandler:
    if fontPath not in _handlers:
        backend = backendForPath(fontPath)
        _handlers[fontPath] = FontHandler(backend, fontPath)
    return _handlers[fontPath]


async def closeFontHandler(fontPath: str) -> None:
    handler = _handlers.pop(fontPath, None)
    if handler:
        await handler._backend.aclose()
