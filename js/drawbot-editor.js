/**
 * drawbot-editor.js
 *
 * Attaches a CodeMirror 5 Python editor to the `script_override` widget on
 * every ComfyFontDrawBot node. Files are served locally — no CDN required.
 *
 * Position strategy: use position:fixed + getBoundingClientRect() on the
 * underlying textarea. This correctly handles ComfyUI's canvas pan/zoom
 * transforms without needing to understand its internal coordinate system.
 * A requestAnimationFrame loop keeps the overlay in sync.
 */

import { app } from "/scripts/app.js";

const CM_BASE = "/extensions/comfyfont/vendor/codemirror";

let cmReady = null;

function loadCodeMirror() {
  if (cmReady) return cmReady;
  cmReady = new Promise(resolve => {
    for (const href of [`${CM_BASE}/codemirror.css`, `${CM_BASE}/theme-preschool.css`]) {
      if (!document.querySelector(`link[href="${href}"]`)) {
        const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href });
        document.head.appendChild(link);
      }
    }
    function loadScript(src, cb) {
      if (document.querySelector(`script[src="${src}"]`)) { cb(); return; }
      const s = document.createElement("script");
      s.src = src;
      s.onload = cb;
      s.onerror = () => { console.error("[ComfyFont] failed to load", src); resolve(); };
      document.head.appendChild(s);
    }
    loadScript(`${CM_BASE}/codemirror.js`, () => loadScript(`${CM_BASE}/python.js`, resolve));
  });
  return cmReady;
}

// ---------------------------------------------------------------------------

async function fetchPreset(name) {
  try {
    const res = await fetch(`/comfyfont/drawbot_preset?name=${encodeURIComponent(name)}`);
    return res.ok ? res.text() : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------

function attachEditor(node) {
  const presetWidget   = node.widgets?.find(w => w.name === "preset");
  const overrideWidget = node.widgets?.find(w => w.name === "script_override");
  if (!presetWidget || !overrideWidget) return;

  // Fix case mismatches from old saved workflows ("waterfall" → "Waterfall").
  // Must run both at nodeCreated AND onConfigure, because ComfyUI restores
  // saved widget values in onConfigure, which fires after nodeCreated.
  const validValues = presetWidget.options?.values ?? [];
  function normalizePreset() {
    if (!validValues.length) return;
    if (!validValues.includes(presetWidget.value)) {
      const match = validValues.find(v => v.toLowerCase() === presetWidget.value?.toLowerCase());
      if (match) presetWidget.value = match;
    }
  }
  normalizePreset();
  const origConfigure = node.onConfigure;
  node.onConfigure = function(info) {
    origConfigure?.call(this, info);
    normalizePreset();
  };

  const poll = setInterval(async () => {
    const textarea = overrideWidget.inputEl;
    if (!textarea) return;
    clearInterval(poll);

    await loadCodeMirror();
    if (!window.CodeMirror) {
      console.error("[ComfyFont] CodeMirror unavailable");
      return;
    }

    // -----------------------------------------------------------------------
    // The wrapper is position:fixed so its top/left are viewport coordinates,
    // matching getBoundingClientRect() exactly — no coordinate system guessing.
    // -----------------------------------------------------------------------
    const wrapper = document.createElement("div");
    Object.assign(wrapper.style, {
      position:  "fixed",
      zIndex:    "1000",
      overflow:  "hidden",
      boxSizing: "border-box",
    });
    document.body.appendChild(wrapper);

    // Keep textarea in layout (so getBoundingClientRect works) but invisible.
    textarea.style.opacity       = "0";
    textarea.style.pointerEvents = "none";

    // Populate with preset source if widget is empty
    if (!overrideWidget.value || !overrideWidget.value.trim()) {
      const src = await fetchPreset(presetWidget.value);
      if (src) { overrideWidget.value = src; textarea.value = src; }
    }

    const editor = window.CodeMirror(wrapper, {
      value:          overrideWidget.value || "",
      mode:           "python",
      theme:          "preschool",
      lineNumbers:    true,
      fixedGutter:    true,
      indentUnit:     4,
      tabSize:        4,
      indentWithTabs: false,
      extraKeys: {
        Tab:         cm => cm.execCommand("indentMore"),
        "Shift-Tab": cm => cm.execCommand("indentLess"),
      },
      lineWrapping:   false,
      scrollbarStyle: "null",  // hide bars, keep wheel/keyboard scrolling
    });

    // rAF loop: sync wrapper position/size to the textarea's viewport rect.
    // This correctly follows canvas pan, zoom, and node resize.
    let lastW = 0, lastH = 0;
    function syncLoop() {
      if (!textarea.isConnected) {
        wrapper.remove();
        return;
      }
      const rect = textarea.getBoundingClientRect();
      Object.assign(wrapper.style, {
        top:    rect.top  + "px",
        left:   rect.left + "px",
        width:  rect.width  + "px",
        height: rect.height + "px",
      });
      if (rect.width > 0 && (rect.width !== lastW || rect.height !== lastH)) {
        lastW = rect.width;
        lastH = rect.height;
        editor.setSize(rect.width, rect.height);
        editor.refresh();
      }
      requestAnimationFrame(syncLoop);
    }
    requestAnimationFrame(syncLoop);

    // Sync edits back to the widget so Python receives the script on next run.
    editor.on("change", () => {
      const src = editor.getValue();
      overrideWidget.value = src;
      textarea.value       = src;
    });

    // Reload content when the preset dropdown changes.
    function setContent(src) {
      editor.setValue(src);
      overrideWidget.value = src;
      textarea.value       = src;
    }

    const origCallback = presetWidget.callback;
    presetWidget.callback = async function (value, ...args) {
      origCallback?.call(this, value, ...args);
      const src = await fetchPreset(value);
      if (src) setContent(src);
    };

  }, 100);
}

// ---------------------------------------------------------------------------

app.registerExtension({
  name: "ComfyFont.DrawBotEditor",
  nodeCreated(node) {
    if (node.comfyClass !== "ComfyFontDrawBot") return;
    attachEditor(node);
  },
});
