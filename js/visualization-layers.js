/**
 * visualization-layers.js — Registered canvas draw layers.
 *
 * Mirrors Fontra's visualization-layer-definitions.js.
 *
 * Each layer has a zIndex and a draw(ctx, glyph, params, controller) callback.
 * The editor calls drawAll() to render them in z-order.
 *
 * All drawing is done in scene (font) coordinates — the CanvasController has
 * already applied the y-flip transform before these callbacks run.
 */

import { isOffCurve, isOnCurve, isSmooth, PointType } from "./packed-path.js";

// ---------------------------------------------------------------------------
// Layer registry

const _layers = [];

function registerLayer(def) {
  _layers.push(def);
  _layers.sort((a, b) => a.zIndex - b.zIndex);
}

export function drawAllLayers(ctx, glyph, selectedPoints, controller) {
  if (!glyph) return;
  const layer = glyph.defaultLayer;
  if (!layer) return;

  for (const def of _layers) {
    ctx.save();
    try {
      def.draw(ctx, layer, selectedPoints, controller);
    } catch (err) {
      console.error(`Layer "${def.id}" draw error:`, err);
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Layer: glyph fill

registerLayer({
  id: "comfyfont.outline.fill",
  zIndex: 100,
  draw(ctx, layer, _sel, ctrl) {
    ctx.fillStyle = ctrl?.darkMode ? "#ffffff22" : "#00000022";
    ctx.fill(layer.flattenedPath2d);
  },
});

// Layer: glyph outline stroke

registerLayer({
  id: "comfyfont.outline.stroke",
  zIndex: 200,
  draw(ctx, layer, _sel, ctrl) {
    const dpr = window.devicePixelRatio || 1;
    const mag = ctrl?.canvasController?.magnification ?? 1;
    ctx.strokeStyle = ctrl?.darkMode ? "#ffffffcc" : "#000000cc";
    ctx.lineWidth = 1 / mag;
    ctx.stroke(layer.flattenedPath2d);
  },
});

// Layer: metrics (advance width line, baseline)

registerLayer({
  id: "comfyfont.metrics",
  zIndex: 300,
  draw(ctx, layer, _sel, ctrl) {
    const mag = ctrl?.canvasController?.magnification ?? 1;
    const unitsPerEm = ctrl?.unitsPerEm ?? 1000;
    const xAdvance = layer.xAdvance;

    ctx.strokeStyle = "#0088ff88";
    ctx.lineWidth = 1 / mag;

    // Baseline
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(xAdvance ?? unitsPerEm, 0);
    ctx.stroke();

    // Advance width
    if (xAdvance != null) {
      ctx.strokeStyle = "#0088ff44";
      ctx.beginPath();
      ctx.moveTo(xAdvance, -unitsPerEm * 0.2);
      ctx.lineTo(xAdvance, unitsPerEm * 1.2);
      ctx.stroke();
    }
  },
});

// Layer: handles (off-curve → on-curve lines)

registerLayer({
  id: "comfyfont.nodes.handles",
  zIndex: 500,
  draw(ctx, layer, _sel, ctrl) {
    const mag = ctrl?.canvasController?.magnification ?? 1;
    ctx.strokeStyle = "#888888bb";
    ctx.lineWidth = 1 / mag;
    ctx.setLineDash([]);

    for (const { x1, y1, x2, y2 } of layer.path.iterHandles()) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  },
});

// Layer: nodes (point markers)

const NODE_SIZE = 5;  // half-size in screen pixels

registerLayer({
  id: "comfyfont.nodes.points",
  zIndex: 600,
  draw(ctx, layer, selectedPoints, ctrl) {
    const mag = ctrl?.canvasController?.magnification ?? 1;
    const halfPx = NODE_SIZE / mag;

    for (const pt of layer.path.iterPoints()) {
      const isSelected = selectedPoints?.has(pt.pointIndex);

      if (pt.isOnCurve) {
        // On-curve: circle (smooth) or square (corner)
        if (pt.smooth) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, halfPx, 0, Math.PI * 2);
          ctx.fillStyle = isSelected ? "#0088ff" : "#ffffff";
          ctx.strokeStyle = isSelected ? "#0066cc" : "#000000";
          ctx.lineWidth = 1 / mag;
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillStyle = isSelected ? "#0088ff" : "#ffffff";
          ctx.strokeStyle = isSelected ? "#0066cc" : "#000000";
          ctx.lineWidth = 1 / mag;
          ctx.fillRect(pt.x - halfPx, pt.y - halfPx, halfPx * 2, halfPx * 2);
          ctx.strokeRect(pt.x - halfPx, pt.y - halfPx, halfPx * 2, halfPx * 2);
        }
      } else {
        // Off-curve: small diamond
        ctx.fillStyle = isSelected ? "#0088ff" : "#aaaaaa";
        ctx.strokeStyle = isSelected ? "#0066cc" : "#666666";
        ctx.lineWidth = 1 / mag;
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y - halfPx);
        ctx.lineTo(pt.x + halfPx, pt.y);
        ctx.lineTo(pt.x, pt.y + halfPx);
        ctx.lineTo(pt.x - halfPx, pt.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
  },
});
