/**
 * packed-path.js — JavaScript mirror of core/path.py PackedPath.
 *
 * Mirrors Fontra's src-js/fontra-core/src/var-path.js.
 *
 * PointType encoding (same as Python):
 *   0x00  ON_CURVE
 *   0x01  OFF_CURVE_QUAD
 *   0x02  OFF_CURVE_CUBIC
 *   0x08  ON_CURVE_SMOOTH
 */

export const PointType = Object.freeze({
  ON_CURVE: 0x00,
  OFF_CURVE_QUAD: 0x01,
  OFF_CURVE_CUBIC: 0x02,
  ON_CURVE_SMOOTH: 0x08,
});

export function isOffCurve(type) {
  return (type & 0x03) !== 0;
}

export function isOnCurve(type) {
  return (type & 0x03) === 0;
}

export function isSmooth(type) {
  return (type & PointType.ON_CURVE_SMOOTH) !== 0;
}

export class VarPackedPath {
  /**
   * @param {number[]} coordinates  – flat [x0,y0, x1,y1, …]
   * @param {number[]} pointTypes   – one PointType per point
   * @param {Array<{endPoint:number, isClosed:boolean}>} contourInfo
   */
  constructor(coordinates = [], pointTypes = [], contourInfo = []) {
    this.coordinates = coordinates;
    this.pointTypes = pointTypes;
    this.contourInfo = contourInfo;
    this._path2d = null; // lazily computed
  }

  static fromObject(obj) {
    return new VarPackedPath(
      obj.coordinates ?? [],
      obj.pointTypes ?? [],
      (obj.contourInfo ?? []).map((ci) => ({
        endPoint: ci.endPoint,
        isClosed: ci.isClosed ?? true,
      }))
    );
  }

  get numPoints() {
    return this.pointTypes.length;
  }

  get numContours() {
    return this.contourInfo.length;
  }

  // -----------------------------------------------------------------------
  // Iteration

  /** Yield {x, y, type, smooth, isOnCurve, pointIndex, contourIndex} for every point. */
  *iterPoints() {
    let pointIndex = 0;
    for (let ci = 0; ci < this.contourInfo.length; ci++) {
      const { endPoint } = this.contourInfo[ci];
      while (pointIndex <= endPoint) {
        const x = this.coordinates[pointIndex * 2];
        const y = this.coordinates[pointIndex * 2 + 1];
        const type = this.pointTypes[pointIndex];
        yield {
          x,
          y,
          type,
          smooth: isSmooth(type),
          isOnCurve: isOnCurve(type),
          pointIndex,
          contourIndex: ci,
        };
        pointIndex++;
      }
    }
  }

  /**
   * Yield { x1, y1, x2, y2 } pairs connecting each off-curve point to its
   * nearest on-curve neighbour (for drawing handles).
   */
  *iterHandles() {
    let start = 0;
    for (const { endPoint } of this.contourInfo) {
      const n = endPoint - start + 1;
      for (let i = 0; i < n; i++) {
        const abs = start + i;
        if (!isOffCurve(this.pointTypes[abs])) continue;

        const x1 = this.coordinates[abs * 2];
        const y1 = this.coordinates[abs * 2 + 1];

        // Find nearest on-curve going forward (wrapping within contour)
        for (let di = 1; di <= n; di++) {
          const j = start + ((i + di) % n);
          if (isOnCurve(this.pointTypes[j])) {
            yield {
              x1, y1,
              x2: this.coordinates[j * 2],
              y2: this.coordinates[j * 2 + 1],
            };
            break;
          }
        }
      }
      start = endPoint + 1;
    }
  }

  // -----------------------------------------------------------------------
  // Path2D rendering

  /**
   * Build (and cache) a browser Path2D from this packed path.
   * Uses font coordinates (y-up); caller is responsible for the y-flip transform.
   */
  toPath2D() {
    if (this._path2d) return this._path2d;

    const path = new Path2D();
    const coords = this.coordinates;
    const types = this.pointTypes;

    let start = 0;
    for (const { endPoint, isClosed } of this.contourInfo) {
      const n = endPoint - start + 1;
      if (n === 0) {
        start = endPoint + 1;
        continue;
      }

      // Build segments: collect runs of off-curves between on-curves
      // We reconstruct moveTo / lineTo / bezierCurveTo / quadraticCurveTo calls.

      // Find the first on-curve to start from (for closed contours)
      let firstOnCurve = -1;
      for (let i = 0; i < n; i++) {
        if (isOnCurve(types[start + i])) {
          firstOnCurve = i;
          break;
        }
      }

      if (firstOnCurve === -1) {
        // All off-curve (implied on-curves between each pair) — rare, skip for now
        start = endPoint + 1;
        continue;
      }

      const ptX = (i) => coords[(start + ((i) % n)) * 2];
      const ptY = (i) => coords[(start + ((i) % n)) * 2 + 1];

      path.moveTo(ptX(firstOnCurve), ptY(firstOnCurve));

      let i = firstOnCurve + 1;
      const total = isClosed ? n : n - firstOnCurve;

      while (i < firstOnCurve + total) {
        const idx = i % n;
        const type = types[start + idx] & 0x03;

        if (type === 0) {
          // on-curve → line
          path.lineTo(ptX(idx), ptY(idx));
          i++;
        } else if (type === PointType.OFF_CURVE_CUBIC) {
          // collect consecutive cubic off-curves
          const offCurves = [];
          while (i < firstOnCurve + total) {
            const t = types[start + (i % n)] & 0x03;
            if (t !== PointType.OFF_CURVE_CUBIC) break;
            offCurves.push(i % n);
            i++;
          }
          const onIdx = i % n;
          if (offCurves.length === 2) {
            path.bezierCurveTo(
              ptX(offCurves[0]), ptY(offCurves[0]),
              ptX(offCurves[1]), ptY(offCurves[1]),
              ptX(onIdx), ptY(onIdx)
            );
          } else if (offCurves.length === 1) {
            // degenerate cubic → treat as quadratic
            path.quadraticCurveTo(
              ptX(offCurves[0]), ptY(offCurves[0]),
              ptX(onIdx), ptY(onIdx)
            );
          }
          i++;
        } else if (type === PointType.OFF_CURVE_QUAD) {
          // collect consecutive quadratic off-curves
          const offCurves = [];
          while (i < firstOnCurve + total) {
            const t = types[start + (i % n)] & 0x03;
            if (t !== PointType.OFF_CURVE_QUAD) break;
            offCurves.push(i % n);
            i++;
          }
          const onIdx = i % n;
          if (offCurves.length === 1) {
            path.quadraticCurveTo(
              ptX(offCurves[0]), ptY(offCurves[0]),
              ptX(onIdx), ptY(onIdx)
            );
          } else {
            // Multiple quad off-curves: insert implied on-curves
            for (let k = 0; k < offCurves.length - 1; k++) {
              const midX = (ptX(offCurves[k]) + ptX(offCurves[k + 1])) / 2;
              const midY = (ptY(offCurves[k]) + ptY(offCurves[k + 1])) / 2;
              path.quadraticCurveTo(ptX(offCurves[k]), ptY(offCurves[k]), midX, midY);
            }
            path.quadraticCurveTo(
              ptX(offCurves[offCurves.length - 1]),
              ptY(offCurves[offCurves.length - 1]),
              ptX(onIdx), ptY(onIdx)
            );
          }
          i++;
        } else {
          i++;
        }
      }

      if (isClosed) path.closePath();
      start = endPoint + 1;
    }

    this._path2d = path;
    return path;
  }

  /** Invalidate cached Path2D (call after editing coordinates). */
  invalidate() {
    this._path2d = null;
  }
}
