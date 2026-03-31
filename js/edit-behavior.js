/**
 * edit-behavior.js — Smooth point constraint system for the glyph editor.
 *
 * Simplified port of Fontra's EditBehaviorFactory (edit-behavior.js).
 *
 * Rules implemented:
 *   1. Move            — selected point moves by (dx, dy)
 *   2. HandleFollow    — unselected off-curve adjacent to a selected smooth
 *                        on-curve translates by the same delta (rigid body)
 *   3. MirrorHandle    — unselected off-curve opposite to a selected off-curve
 *                        through a smooth on-curve mirrors to maintain tangency
 *                        (keeps its original length, rotates direction)
 *
 * Usage:
 *   applyEditBehavior(path, selectedPoints, dx, dy, origCoords)
 *   — Call AFTER applying dx/dy to all selected points.
 *   — Mutates path.coordinates in place.
 *   — origCoords: Float64Array snapshot before the drag started.
 */

/**
 * Apply smooth-point constraints during a drag.
 *
 * @param {import('./packed-path.js').VarPackedPath} path
 * @param {Set<number>} selectedPoints  — absolute point indices
 * @param {number} dx
 * @param {number} dy
 * @param {Float64Array} origCoords     — pre-drag coordinates snapshot
 */
export function applyEditBehavior(path, selectedPoints, dx, dy, origCoords) {
  const coords = path.coordinates;
  const types  = path.pointTypes;

  let start = 0;
  for (const { endPoint } of path.contourInfo) {
    const n = endPoint - start + 1;
    if (n < 3) { start = endPoint + 1; continue; }

    for (let k = 0; k < n; k++) {
      const i = start + k;

      // Only smooth on-curve points generate constraints
      if ((types[i] & 0x03) !== 0) continue; // skip off-curves
      if ((types[i] & 0x08) === 0) continue; // skip corner on-curves

      const prevIdx = start + (k - 1 + n) % n;
      const nextIdx = start + (k + 1    ) % n;

      const prevIsOff = (types[prevIdx] & 0x03) !== 0;
      const nextIsOff = (types[nextIdx] & 0x03) !== 0;
      if (!prevIsOff || !nextIsOff) continue; // need handles on both sides

      const selfSel = selectedPoints.has(i);
      const prevSel = selectedPoints.has(prevIdx);
      const nextSel = selectedPoints.has(nextIdx);

      if (selfSel) {
        // Rule: HandleFollow — smooth on-curve is moving; carry unselected adjacent
        // off-curves with it (they maintain their relative position).
        if (!prevSel) {
          coords[prevIdx * 2]     = origCoords[prevIdx * 2]     + dx;
          coords[prevIdx * 2 + 1] = origCoords[prevIdx * 2 + 1] + dy;
        }
        if (!nextSel) {
          coords[nextIdx * 2]     = origCoords[nextIdx * 2]     + dx;
          coords[nextIdx * 2 + 1] = origCoords[nextIdx * 2 + 1] + dy;
        }
      } else if (prevSel !== nextSel) {
        // Rule: MirrorHandle — one handle is selected and moved; smooth on-curve is
        // NOT moving; mirror the opposite handle to maintain C1 continuity.
        const selOff    = prevSel ? prevIdx : nextIdx;
        const mirrorOff = prevSel ? nextIdx : prevIdx;
        if (selectedPoints.has(mirrorOff)) continue; // mirror off-curve is also selected

        // On-curve is fixed at its orig position
        const ox = origCoords[i * 2],      oy = origCoords[i * 2 + 1];
        // Selected handle is at its new position after delta was applied
        const sx = coords[selOff * 2],     sy = coords[selOff * 2 + 1];

        // Vector from selected handle to on-curve (the "pull" direction)
        const ax = ox - sx, ay = oy - sy;
        const aLen = Math.hypot(ax, ay);
        if (aLen < 1e-6) continue;

        // Preserve the mirror handle's original length from on-curve
        const mx = origCoords[mirrorOff * 2]     - ox;
        const my = origCoords[mirrorOff * 2 + 1] - oy;
        const mLen = Math.hypot(mx, my);

        // Set mirror handle: same direction as pull, original length
        coords[mirrorOff * 2]     = ox + (ax / aLen) * mLen;
        coords[mirrorOff * 2 + 1] = oy + (ay / aLen) * mLen;
      }
    }

    start = endPoint + 1;
  }
}

/**
 * Nudge selected points by (dx, dy) and apply smooth constraints.
 * Returns {fwdChanges, rbkChanges} for undo/redo (checks all points for constraint moves).
 *
 * @param {import('./packed-path.js').VarPackedPath} path
 * @param {Set<number>} selectedPoints
 * @param {number} dx
 * @param {number} dy
 * @returns {{ fwdChanges: object[], rbkChanges: object[] }}
 */
export function nudgePoints(path, selectedPoints, dx, dy) {
  const coords = path.coordinates;
  const origCoords = Float64Array.from(coords);

  // Move selected points
  for (const i of selectedPoints) {
    coords[i * 2]     += dx;
    coords[i * 2 + 1] += dy;
  }

  // Apply smooth constraints
  applyEditBehavior(path, selectedPoints, dx, dy, origCoords);
  path.invalidate();

  // Build change records for all moved points
  const fwdChanges = [];
  const rbkChanges = [];
  for (let i = 0; i < origCoords.length / 2; i++) {
    const x  = coords[i * 2],      y  = coords[i * 2 + 1];
    const ox = origCoords[i * 2],  oy = origCoords[i * 2 + 1];
    if (x !== ox || y !== oy) {
      fwdChanges.push({ f: "=xy", a: [i, x,  y ] });
      rbkChanges.unshift({ f: "=xy", a: [i, ox, oy] });
    }
  }

  return { fwdChanges, rbkChanges };
}

/**
 * Toggle the smooth flag on a single on-curve point.
 * Returns {fwdChanges, rbkChanges}.
 *
 * @param {import('./packed-path.js').VarPackedPath} path
 * @param {number} pointIndex
 */
export function toggleSmooth(path, pointIndex) {
  const types = path.pointTypes;
  const oldType = types[pointIndex];
  const isOnCurve = (oldType & 0x03) === 0;
  if (!isOnCurve) return { fwdChanges: [], rbkChanges: [] };

  const newType = oldType ^ 0x08; // toggle smooth bit
  types[pointIndex] = newType;

  // Change must walk into pointTypes array before calling "="
  return {
    fwdChanges: [{ p: ["pointTypes"], f: "=", a: [pointIndex, newType] }],
    rbkChanges: [{ p: ["pointTypes"], f: "=", a: [pointIndex, oldType] }],
  };
}
