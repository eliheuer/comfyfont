/**
 * remote.js — Bidirectional JSON-RPC over WebSocket.
 *
 * Mirrors Fontra's src-js/fontra-core/src/remote.js.
 *
 * Usage:
 *   const backend = getRemoteProxy(new RemoteObject("/comfyfont/ws?font=MyFont.ttf"));
 *   await backend.connect();
 *   const glyphMap = await backend.getGlyphMap();
 */

export class RemoteObject {
  constructor(wsURL) {
    this.wsURL = wsURL;
    this.clientUUID = crypto.randomUUID();
    this._callIdCounter = 0;
    this._callReturnCallbacks = {}; // callId → { resolve, reject }
    this._serverMethodHandlers = {}; // methodName → async fn
    this.websocket = null;
    this._connectPromise = null;
  }

  /** Register a handler for server-initiated calls (push messages). */
  registerServerMethod(name, fn) {
    this._serverMethodHandlers[name] = fn;
  }

  async connect() {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._doConnect();
    return this._connectPromise;
  }

  _doConnect() {
    return new Promise((resolve, reject) => {
      const wsURL = this.wsURL.startsWith("ws")
        ? this.wsURL
        : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${this.wsURL}`;
      this.websocket = new WebSocket(wsURL);

      this.websocket.onopen = () => {
        // Send handshake
        this.websocket.send(JSON.stringify({ "client-uuid": this.clientUUID }));
        resolve();
      };

      this.websocket.onerror = (err) => reject(err);

      this.websocket.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        this._handleMessage(message);
      };

      this.websocket.onclose = () => {
        // Reject all pending calls
        for (const { reject } of Object.values(this._callReturnCallbacks)) {
          reject(new Error("WebSocket closed"));
        }
        this._callReturnCallbacks = {};
        this._connectPromise = null;
      };
    });
  }

  _handleMessage(message) {
    if ("client-call-id" in message) {
      // Response to a call we made
      const cb = this._callReturnCallbacks[message["client-call-id"]];
      if (!cb) return;
      delete this._callReturnCallbacks[message["client-call-id"]];
      if ("exception" in message) {
        cb.reject(new Error(message.exception));
      } else {
        cb.resolve(message["return-value"]);
      }
      return;
    }

    if ("server-call-id" in message) {
      // Server-initiated call
      const callId = message["server-call-id"];
      const methodName = message["method-name"];
      const args = message.arguments ?? [];
      const handler = this._serverMethodHandlers[methodName];

      const respond = (returnValue) => {
        this.websocket?.send(
          JSON.stringify({ "server-call-id": callId, "return-value": returnValue ?? null })
        );
      };

      if (handler) {
        Promise.resolve(handler(...args)).then(respond).catch((err) => {
          console.error(`Error handling server call "${methodName}":`, err);
          respond(null);
        });
      } else {
        respond(null);
      }
    }
  }

  async _doCall(methodName, args) {
    await this.connect();
    const callId = this._callIdCounter++;
    return new Promise((resolve, reject) => {
      this._callReturnCallbacks[callId] = { resolve, reject };
      this.websocket.send(
        JSON.stringify({
          "client-call-id": callId,
          "method-name": methodName,
          "arguments": args,
        })
      );
    });
  }

  close() {
    this.websocket?.close();
  }
}

/**
 * Wrap a RemoteObject in a Proxy so any property access becomes a remote call.
 *
 *   const backend = getRemoteProxy(new RemoteObject(url));
 *   const map = await backend.getGlyphMap(); // calls getGlyphMap on the server
 */
export function getRemoteProxy(remoteObject) {
  return new Proxy(remoteObject, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (...args) => target._doCall(prop, args);
    },
  });
}
