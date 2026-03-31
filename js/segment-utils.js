/**
 * segment-utils.js — Segment iteration, hover hit-testing, and insertion for PackedPath.
 *
 * A "segment" is the region between two consecutive on-curve points in a contour.
 * Types: "line" (2 pts), "cubic" (4 pts: on, off, off, on), "quad" (3 pts: on, off, on).
 *
 * Point-type encoding (matches packed-path.js):
 *   0x00  ON_CURVE
 *   0x01  OFF_CURVE_QUAD
 *   0x02  OFF_CURVE_CUBIC
 *   0x08  ON_CURVE_SMOOTH (flag, OR'd with 0x00)
 */

// ---------------------------------------------------------------------------
// Segment iteration

/**
 * Yield segment descriptors for every drawable segment in path.
 * Each descriptor: { ci, segIdx, type, pts, contourStart }
 *   pts — array of {x, y, t (type & 0x03), abs, local} in SCENE space
 */
export function* iterSegments(path) {
  const coords = path.coordinates;
  const types  = path.pointTypes;
  let absStart = 0;

  for (let ci = 0; ci < path.contourInfo.length; ci++) {
    const { endPoint, isClosed } = path.contourInfo[ci];
    const n = endPoint - absStart + 1;
    if (n < 2) { absStart = endPoint + 1; continue; }

    const pt = (local) => {
      const abs = absStart + local;
      return { x: coords[abs*2], y: coords[abs*2+1], t: types[abs] & 0x03, abs, local };
    };

    // Find first on-curve
    let firstOn = -1;
    for (let k = 0; k < n; k++) {
      if (pt(k).t === 0) { firstOn = k; break; }
    }
    if (firstOn < 0) { absStart = endPoint + 1; continue; }

    const limit = isClosed ? n : n - 1;  // number of points to traverse
    let segIdx = 0;
    let i = firstOn;  // current local index (starting on-curve of each segment)

    while (segIdx < limit) {
      const segPts = [pt(i % n)];
      let j = 1;
      while (j <= n) {
        const p = pt((i + j) % n);
        segPts.push(p);
        if (p.t === 0) break;  // found end on-curve
        j++;
      }

      // Only emit if we ended on an on-curve
      if (segPts.length >= 2 && segPts[segPts.length - 1].t === 0) {
        const type = segPts.length === 2 ? 'line'
                   : (segPts.length === 4 && segPts[1].t === 2) ? 'cubic'
                   : (segPts.length === 3 && segPts[1].t === 1) ? 'quad'
                   : 'unknown';
        if (type !== 'unknown') {
          yield { ci, segIdx, type, pts: segPts, contourStart: absStart };
        }
      }

      i = (i + j) % n;
      segIdx++;
      // Stop when we've processed 'limit' segments (for open contours)
      if (!isClosed && i >= n - 1) break;
      if (segIdx >= n) break;  // safety
    }

    absStart = endPoint + 1;
  }
}

// ---------------------------------------------------------------------------
// Evaluation

function lerp(a, b, t) { return a + (b - a) * t; }
function lerp2(p0, p1, t) { return { x: lerp(p0.x, p1.x, t), y: lerp(p0.y, p1.y, t) }; }

/** Evaluate a segment at parameter t → {x, y}. pts are in any coordinate space. */
export function evalSegment(pts, t) {
  if (pts.length === 2) {
    return lerp2(pts[0], pts[1], t);
  } else if (pts.length === 4) {
    const [p0, p1, p2, p3] = pts;
    const u = 1 - t;
    return {
      x: u*u*u*p0.x + 3*u*u*t*p1.x + 3*u*t*t*p2.x + t*t*t*p3.x,
      y: u*u*u*p0.y + 3*u*u*t*p1.y + 3*u*t*t*p2.y + t*t*t*p3.y,
    };
  } else if (pts.length === 3) {
    const [p0, p1, p2] = pts;
    const u = 1 - t;
    return {
      x: u*u*p0.x + 2*u*t*p1.x + t*t*p2.x,
      y: u*u*p0.y + 2*u*t*p1.y + t*t*p2.y,
    };
  }
  return { x: pts[0].x, y: pts[0].y };
}

// ---------------------------------------------------------------------------
// Hit testing

/**
 * Find the segment closest to a point in canvas physical-pixel space.
 *
 * @param {object} path — VarPackedPath (scene coords)
 * @param {object} cc   — CanvasController
 * @param {number} cpx  — canvas physical px X (clientX * dpr - origin adjustments)
 * @param {number} cpy  — canvas physical px Y
 * @param {number} thresholdPhysPx — hit distance in physical px
 * @returns {{ ci, segIdx, type, pts, t, canvasPt: {x,y} } | null}
 */
export function findHoveredSegment(path, cc, cpx, cpy, thresholdPhysPx) {
  let best = null;
  let bestDist = thresholdPhysPx;

  for (const seg of iterSegments(path)) {
    // Convert segment scene pts to canvas pts for hit testing
    const canvasPts = seg.pts.map(p => {
      const { x, y } = cc.sceneToCanvas(p.x, p.y);
      return { x, y, t: p.t, abs: p.abs, local: p.local };
    });

    const SAMPLES = 20;
    let minDist = Infinity, bestT = 0;

    for (let s = 0; s <= SAMPLES; s++) {
      const t = s / SAMPLES;
      const p = evalSegment(canvasPts, t);
      const d = Math.hypot(p.x - cpx, p.y - cpy);
      if (d < minDist) { minDist = d; bestT = t; }
    }

    // Refine around bestT
    const step = 1 / SAMPLES;
    for (let s = 0; s <= 8; s++) {
      const t = Math.max(0, Math.min(1, bestT - step + 2 * step * s / 8));
      const p = evalSegment(canvasPts, t);
      const d = Math.hypot(p.x - cpx, p.y - cpy);
      if (d < minDist) { minDist = d; bestT = t; }
    }

    if (minDist < bestDist) {
      bestDist = minDist;
      const canvasPt = evalSegment(canvasPts, bestT);
      best = { ...seg, t: bestT, canvasPt };
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Insertion

/**
 * Build Path2D for a single segment (in canvas space) — used for drawing hover highlight.
 * canvasPts: array of {x, y} in physical canvas px.
 */
export function buildSegmentPath2D(canvasPts) {
  const p2d = new Path2D();
  p2d.moveTo(canvasPts[0].x, canvasPts[0].y);
  if (canvasPts.length === 2) {
    p2d.lineTo(canvasPts[1].x, canvasPts[1].y);
  } else if (canvasPts.length === 4) {
    p2d.bezierCurveTo(
      canvasPts[1].x, canvasPts[1].y,
      canvasPts[2].x, canvasPts[2].y,
      canvasPts[3].x, canvasPts[3].y
    );
  } else if (canvasPts.length === 3) {
    p2d.quadraticCurveTo(
      canvasPts[1].x, canvasPts[1].y,
      canvasPts[2].x, canvasPts[2].y
    );
  }
  return p2d;
}

/**
 * Insert a point on a segment at parameter t. Mutates path.
 * Returns { fwdChanges, rbkChanges, newAbsIdx } for undo/redo.
 *
 * @param {object} path    — VarPackedPath (mutated)
 * @param {object} seg     — segment descriptor from iterSegments()
 * @param {number} t       — parameter [0, 1]
 * @param {number} ci      — contour index
 */
export function insertOnSegment(path, seg, t) {
  const { ci, type, pts } = seg;
  const fwdChanges = [];
  const rbkChanges = [];

  if (type === 'line') {
    // Simple: insert an on-curve point between the two endpoints
    const p = lerp2(pts[0], pts[1], t);
    const localIdx = pts[1].local;  // insert before the end on-curve
    const pt = { x: Math.round(p.x), y: Math.round(p.y), type: 0 };

    path.insertPoint(ci, localIdx, pt);
    fwdChanges.push({ f: "insertPoint", a: [ci, localIdx, pt] });
    rbkChanges.push({ f: "deletePoint", a: [ci, localIdx] });

    return { fwdChanges, rbkChanges, newAbsIdx: pts[0].abs + localIdx - pts[0].local + 1 };

  } else if (type === 'cubic') {
    // De Casteljau split at t
    const [p0, p1, p2, p3] = pts;
    const p01  = lerp2(p0, p1, t);
    const p12  = lerp2(p1, p2, t);
    const p23  = lerp2(p2, p3, t);
    const p012 = lerp2(p01, p12, t);
    const p123 = lerp2(p12, p23, t);
    const mid  = lerp2(p012, p123, t);

    const round = (v) => Math.round(v);

    // Operations (in forward order):
    // 1. Move p1 → p01
    // 2. Move p2 → p012
    // 3. Insert mid  (on-curve) before p3 (at p3.local)
    // 4. Insert p123 (off-cubic) at p3.local + 1
    // 5. Insert p23  (off-cubic) at p3.local + 2

    const midPt  = { x: round(mid.x),  y: round(mid.y),  type: 0 };
    const p123Pt = { x: round(p123.x), y: round(p123.y), type: 2 };
    const p23Pt  = { x: round(p23.x),  y: round(p23.y),  type: 2 };
    const p3local = p3.local;

    // Apply mutations
    path.setPointPosition(p1.abs, round(p01.x), round(p01.y));
    path.setPointPosition(p2.abs, round(p012.x), round(p012.y));
    path.insertPoint(ci, p3local,     midPt);
    path.insertPoint(ci, p3local + 1, p123Pt);
    path.insertPoint(ci, p3local + 2, p23Pt);

    // Forward changes
    fwdChanges.push({ f: "=xy", a: [p1.abs, round(p01.x), round(p01.y)] });
    fwdChanges.push({ f: "=xy", a: [p2.abs, round(p012.x), round(p012.y)] });
    fwdChanges.push({ f: "insertPoint", a: [ci, p3local,     midPt ] });
    fwdChanges.push({ f: "insertPoint", a: [ci, p3local + 1, p123Pt] });
    fwdChanges.push({ f: "insertPoint", a: [ci, p3local + 2, p23Pt ] });

    // Rollback (apply in order to undo forward changes):
    // Delete from highest local index down, then restore off-curves
    rbkChanges.push({ f: "deletePoint", a: [ci, p3local + 2] });
    rbkChanges.push({ f: "deletePoint", a: [ci, p3local + 1] });
    rbkChanges.push({ f: "deletePoint", a: [ci, p3local    ] });
    rbkChanges.push({ f: "=xy", a: [p2.abs, p2.x, p2.y] });
    rbkChanges.push({ f: "=xy", a: [p1.abs, p1.x, p1.y] });

    return { fwdChanges, rbkChanges, newAbsIdx: p1.abs + (p3local - p1.local) };

  } else if (type === 'quad') {
    // Quadratic split: [p0, p1, p2] → [p0, p01, mid, p12, p2]
    const [p0, p1, p2] = pts;
    const p01 = lerp2(p0, p1, t);
    const p12 = lerp2(p1, p2, t);
    const mid = lerp2(p01, p12, t);
    const round = (v) => Math.round(v);

    const midPt = { x: round(mid.x), y: round(mid.y), type: 0 };
    const p12Pt = { x: round(p12.x), y: round(p12.y), type: 1 };
    const p2local = p2.local;

    path.setPointPosition(p1.abs, round(p01.x), round(p01.y));
    path.insertPoint(ci, p2local,     midPt);
    path.insertPoint(ci, p2local + 1, p12Pt);

    fwdChanges.push({ f: "=xy", a: [p1.abs, round(p01.x), round(p01.y)] });
    fwdChanges.push({ f: "insertPoint", a: [ci, p2local,     midPt] });
    fwdChanges.push({ f: "insertPoint", a: [ci, p2local + 1, p12Pt] });

    rbkChanges.push({ f: "deletePoint", a: [ci, p2local + 1] });
    rbkChanges.push({ f: "deletePoint", a: [ci, p2local    ] });
    rbkChanges.push({ f: "=xy", a: [p1.abs, p1.x, p1.y] });

    return { fwdChanges, rbkChanges, newAbsIdx: p1.abs + (p2local - p1.local) };
  }

  return { fwdChanges: [], rbkChanges: [], newAbsIdx: -1 };
}
