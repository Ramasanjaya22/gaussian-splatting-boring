/**
 * Egress audit.
 *
 * The claim is "the camera is used for the effect and nothing else". Promising
 * that in a privacy policy is worthless, so instead we instrument every channel
 * a page could leak through, keep a live count, and let the user sever all of
 * them at runtime to see whether the effect still works.
 */

const SELF_HOSTS = new Set(["", location.host]);
const isSelf = (url) => {
  try {
    const u = new URL(String(url), location.href);
    return u.protocol === "data:" || u.protocol === "blob:" || SELF_HOSTS.has(u.host);
  } catch {
    return false;
  }
};

const host = (url) => {
  try {
    return new URL(String(url), location.href).host;
  } catch {
    return "?";
  }
};

export class Audit {
  constructor() {
    this.entries = [];
    this.armedAt = null;      // performance.now() when the camera was switched on
    this.cut = false;
    this.frameAttempts = 0;   // bodies that look like camera/canvas pixels
    this.storageBytes = 0;
    this.ready = false;       // UI attached yet; suppress rendering until then
    this.onChange = null;
    this._patchNetwork();
    this._patchStorage();
    this._observeResources();
  }

  // ---- recording -----------------------------------------------------------
  _record(kind, url, detail = "") {
    this.entries.push({
      kind,
      url: String(url).slice(0, 300),
      host: host(url),
      self: isSelf(url),
      afterArmed: this.armedAt !== null,
      detail,
      t: Math.round(performance.now() - this.t0),
    });
    this.onChange?.();
  }

  _isPixelPayload(body) {
    if (body == null) return false;
    if (typeof HTMLCanvasElement !== "undefined" && body instanceof HTMLCanvasElement) return true;
    if (typeof ImageData !== "undefined" && body instanceof ImageData) return true;
    if (typeof Blob !== "undefined" && body instanceof Blob) return true;
    if (typeof MediaStream !== "undefined" && body instanceof MediaStream) return true;
    if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) return body.byteLength > 8192;
    if (typeof ArrayBuffer.isView && ArrayBuffer.isView(body)) return body.byteLength > 8192;
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      for (const v of body.values()) if (v && typeof v === "object") return true;
    }
    return false;
  }

  // ---- network -------------------------------------------------------------
  _patchNetwork() {
    this.t0 = performance.now();

    // Wrappers are re-entered as methods on other objects, so `this` is wrong
    // inside them. Close over the audit instance explicitly - and don't call it
    // `self`: in a browser that's the window.
    const audit = this;

    // Guard: patching some of these can throw on odd builds.
    const safeWrap = (obj, key, apply) => {
      if (!obj) return;
      try {
        apply(obj, key);
      } catch (err) {
        console.warn("[audit] could not instrument", key, err);
      }
    };

    const origFetch = window.fetch?.bind(window);
    window.fetch = (...args) => {
      const url = args[0] instanceof Request ? args[0].url : args[0];
      const pixels = this._isPixelPayload(args[1]?.body);
      if (pixels) this.frameAttempts++;
      if (this.cut) {
        this._record("fetch", url, pixels ? "BLOCKED · PIXEL PAYLOAD" : "BLOCKED");
        return Promise.reject(new Error("[audit] network cut"));
      }
      this._record("fetch", url, pixels ? "PIXEL PAYLOAD" : "");
      return origFetch(...args);
    };

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      if (audit.cut) {
        audit._record("xhr", url, "BLOCKED");
        throw new Error("[audit] network cut");
      }
      audit._record("xhr", url);
      return origOpen.call(this, method, url, ...rest);
    };

    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      if (audit._isPixelPayload(body)) audit.frameAttempts++;
      if (audit.cut) throw new Error("[audit] network cut");
      return origSend.call(this, body);
    };

    const origBeacon = navigator.sendBeacon?.bind(navigator);
    if (origBeacon) {
      safeWrap(navigator, "sendBeacon", (o, k) => {
        o[k] = (url, data) => {
          const pixels = this._isPixelPayload(data);
          if (pixels) this.frameAttempts++;
          if (this.cut) {
            this._record("beacon", url, pixels ? "BLOCKED · PIXEL PAYLOAD" : "BLOCKED");
            return false;
          }
          this._record("beacon", url, pixels ? "PIXEL PAYLOAD" : "");
          return origBeacon(url, data);
        };
      });
    }

    // Constructors rebind `this` to the new instance, so they must close over the
    // audit instance rather than rely on `this`.
    for (const name of ["WebSocket", "EventSource"]) {
      const Orig = window[name];
      if (!Orig) continue;
      safeWrap(window, name, (o, k) => {
        o[k] = function (url, ...rest) {
          if (audit.cut) {
            audit._record(name.toLowerCase(), url, "BLOCKED");
            throw new Error("[audit] network cut");
          }
          audit._record(name.toLowerCase(), url);
          return new Orig(url, ...rest);
        };
      });
    }

    if (window.RTCPeerConnection) {
      const Orig = window.RTCPeerConnection;
      safeWrap(window, "RTCPeerConnection", (o, k) => {
        o[k] = function (...args) {
          if (audit.cut) {
            audit._record("webrtc", "RTCPeerConnection", "BLOCKED");
            throw new Error("[audit] network cut");
          }
          audit._record("webrtc", "RTCPeerConnection");
          return new Orig(...args);
        };
      });
    }
  }

  // Independent witness: the browser's own resource timing, which we do not control.
  _observeResources() {
    if (typeof PerformanceObserver === "undefined") return;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) this._record("resource", e.name, "timing");
      }).observe({ type: "resource", buffered: true });
    } catch { /* not fatal */ }
  }

  // ---- storage -------------------------------------------------------------
  _patchStorage() {
    const self = this;
    for (const store of [window.localStorage, window.sessionStorage]) {
      if (!store) continue;
      for (const op of ["setItem", "removeItem", "clear"]) {
        const orig = store[op].bind(store);
        store[op] = (k, v) => {
          self.storageBytes += op === "setItem" ? String(v ?? "").length : 0;
          self._record("storage", `${store === localStorage ? "local" : "session"}:${k}`);
          return orig(k, v);
        };
      }
    }
    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    if (cookie?.set) {
      Object.defineProperty(document, "cookie", {
        ...cookie,
        set(v) {
          self._record("cookie", String(v).split("=")[0]);
          return cookie.set.call(this, v);
        },
      });
    }
  }

  // ---- controls ------------------------------------------------------------
  arm() {
    this.armedAt = performance.now();
    this.onChange?.();
  }

  setCut(v) {
    this.cut = v;
    this.onChange?.();
  }

  stats() {
    const after = this.entries.filter((e) => e.afterArmed);
    // Same-origin asset loads (the JS/wasm we ship) aren't exfiltration.
    // Neither are attempts the cut already blocked - those are the point.
    const exfil = after.filter(
      (e) => !e.self && !e.detail.includes("BLOCKED") &&
             e.kind !== "storage" && e.kind !== "cookie"
    );
    return {
      total: this.entries.length,
      sinceArmed: after.length,
      substantiveSinceArmed: exfil.length,
      thirdParty: exfil.length,
      frameAttempts: this.frameAttempts,
      storageBytes: this.storageBytes,
      cut: this.cut,
      armed: this.armedAt !== null,
    };
  }
}