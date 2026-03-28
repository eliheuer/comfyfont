"""
WebSocket RPC engine.

Mirrors Fontra's core/remote.py.

Wire protocol (bidirectional JSON-RPC):

  Client → Server call:
    {"client-call-id": 42, "method-name": "getGlyph", "arguments": ["A"]}

  Server → Client response:
    {"client-call-id": 42, "return-value": { ... }}

  Server → Client push:
    {"server-call-id": 7, "method-name": "externalChange", "arguments": [...]}

  Client → Server response to push:
    {"server-call-id": 7, "return-value": null}

  Error response:
    {"client-call-id": 42, "exception": "Glyph not found"}
"""

from __future__ import annotations

import asyncio
import json
import logging
from itertools import count
from typing import Any

import aiohttp
import aiohttp.web as web

from .classes import unstructure

log = logging.getLogger(__name__)


class RemoteObjectConnection:
    """
    Manages one WebSocket connection to one FontHandler.

    The *subject* must be an object whose methods are decorated with
    @remoteMethod — those are the only methods callable from the client.
    """

    def __init__(self, ws: web.WebSocketResponse, subject: Any) -> None:
        self.ws = ws
        self.subject = subject
        self.clientUUID: str | None = None
        self._serverCallId = count()
        self._pendingServerCalls: dict[int, asyncio.Future] = {}

    async def run(self) -> None:
        """Read messages until the connection closes."""
        try:
            async for msg in self.ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    await self._handleMessage(json.loads(msg.data))
                elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                    break
        except Exception:
            log.exception("Error in WebSocket connection")
        finally:
            await self.subject.removeConnection(self)

    async def _handleMessage(self, message: dict) -> None:
        if "client-uuid" in message:
            # Handshake
            self.clientUUID = message["client-uuid"]
            await self.subject.addConnection(self)
            return

        if "client-call-id" in message:
            await self._handleClientCall(message)
            return

        if "server-call-id" in message:
            self._handleServerResponse(message)

    async def _handleClientCall(self, message: dict) -> None:
        call_id = message["client-call-id"]
        method_name = message["method-name"]
        args = message.get("arguments", [])

        try:
            method = getattr(self.subject, method_name, None)
            if method is None or not getattr(method, "_isRemoteMethod", False):
                raise AttributeError(f"No remote method {method_name!r}")
            result = await method(*args, connection=self)
            payload = {"client-call-id": call_id, "return-value": unstructure(result)}
        except Exception as exc:
            log.exception("Error handling client call %r", method_name)
            payload = {"client-call-id": call_id, "exception": str(exc)}

        await self.ws.send_str(json.dumps(payload))

    def _handleServerResponse(self, message: dict) -> None:
        call_id = message["server-call-id"]
        future = self._pendingServerCalls.pop(call_id, None)
        if future is None:
            return
        if "exception" in message:
            future.set_exception(RuntimeError(message["exception"]))
        else:
            future.set_result(message.get("return-value"))

    async def callRemote(self, methodName: str, *args: Any) -> Any:
        """Call a method on the remote (JS) client and await the response."""
        call_id = next(self._serverCallId)
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pendingServerCalls[call_id] = future
        payload = {
            "server-call-id": call_id,
            "method-name": methodName,
            "arguments": list(args),
        }
        await self.ws.send_str(json.dumps(payload))
        return await future
