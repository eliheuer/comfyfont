/**
 * change-recorder.js — Proxy-based change recorder for ComfyFont.
 *
 * Ported from Fontra's src-js/fontra-core/src/change-recorder.js.
 *
 * Usage:
 *   const changes = recordChanges(subject, (proxy) => {
 *     proxy.someProperty = newValue;
 *     proxy.path.setPointPosition(3, 100, 200);
 *   });
 *   // changes.change      → forward change object
 *   // changes.rollbackChange → inverse (for undo)
 *
 * The proxy intercepts all property sets, deletes, and registered
 * method calls. Both the real mutation AND the change record happen
 * simultaneously, so the subject is always up to date.
 *
 * On error inside the mutator, the rollback change is automatically
 * applied to restore the subject to its pre-call state.
 */

import { ChangeCollector, applyChange } from "./changes.js";
import { VarPackedPath } from "./packed-path.js";

// ---------------------------------------------------------------------------
// recordChanges — the public API

export function recordChanges(subject, func) {
  const changes = new ChangeCollector();
  try {
    func(getProxy(subject, changes));
  } catch (error) {
    applyChange(subject, changes.rollbackChange);
    throw error;
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Proxy method overrides for specific types
// Each factory receives (subject, changes) and returns an object
// whose keys shadow the real subject's methods with recording wrappers.

function getArrayProxyMethods(subject, changes) {
  return {
    push(...items) {
      changes.addChange("+", subject.length, ...items);
      changes.addRollbackChange("-", subject.length, items.length);
      subject.push(...items);
    },
    splice(index, deleteCount, ...items) {
      changes.addChange(":", index, deleteCount, ...items);
      changes.addRollbackChange(":", index, items.length, ...subject.slice(index, index + deleteCount));
      subject.splice(index, deleteCount, ...items);
    },
  };
}

function getVarPackedPathProxyMethods(subject, changes) {
  return {
    appendPath(path) {
      changes.addChange("appendPath", path);
      changes.addRollbackChange("deleteNTrailingContours", path.numContours);
      subject.appendPath(path);
    },
    insertContour(index, contour) {
      changes.addChange("insertContour", index, contour);
      changes.addRollbackChange("deleteContour", index);
      subject.insertContour(index, contour);
    },
    deleteContour(index) {
      changes.addChange("deleteContour", index);
      changes.addRollbackChange("insertContour", index, subject.getContour(index));
      subject.deleteContour(index);
    },
    insertPoint(contourIndex, contourPointIndex, point) {
      changes.addChange("insertPoint", contourIndex, contourPointIndex, point);
      changes.addRollbackChange("deletePoint", contourIndex, contourPointIndex);
      subject.insertPoint(contourIndex, contourPointIndex, point);
    },
    deletePoint(contourIndex, contourPointIndex) {
      changes.addChange("deletePoint", contourIndex, contourPointIndex);
      changes.addRollbackChange(
        "insertPoint",
        contourIndex,
        contourPointIndex,
        subject.getContourPoint(contourIndex, contourPointIndex)
      );
      subject.deletePoint(contourIndex, contourPointIndex);
    },
    setPointPosition(pointIndex, x, y) {
      changes.addChange("=xy", pointIndex, x, y);
      changes.addRollbackChange("=xy", pointIndex, ...subject.getPointPosition(pointIndex));
      subject.setPointPosition(pointIndex, x, y);
    },
    moveAllWithFirstPoint(x, y) {
      const [rx, ry] = subject.getPointPosition(0);
      changes.addChange("moveAllWithFirstPoint", x, y);
      changes.addRollbackChange("moveAllWithFirstPoint", rx, ry);
      subject.moveAllWithFirstPoint(x, y);
    },
  };
}

// Maps constructor name → proxy method factory
export const proxyMethodsMap = {
  [Array.name]:          getArrayProxyMethods,
  [VarPackedPath.name]:  getVarPackedPathProxyMethods,
};

// ---------------------------------------------------------------------------
// Internal proxy machinery

const _getUnwrapped = Symbol("get-unwrapped-subject");

function getProxy(subject, changes) {
  if (!needsProxy(subject)) {
    throw new Error("change-recorder: subject must be an object");
  }

  const getMethods = proxyMethodsMap[subject.constructor?.name];
  const methods = getMethods ? getMethods(subject, changes) : {};
  const isArray = Array.isArray(subject);

  const handler = {
    set(subject, prop, value) {
      // Unwrap a proxy value before storing it
      if (value && typeof value === "object") {
        const unwrapped = value[_getUnwrapped];
        if (unwrapped !== undefined) value = unwrapped;
      }
      if (isArray && !isNaN(prop)) prop = parseInt(prop);
      changes.addChange("=", prop, value);
      if (!isArray && subject[prop] === undefined) {
        changes.addRollbackChange("d", prop);
      } else {
        changes.addRollbackChange("=", prop, subject[prop]);
      }
      subject[prop] = value;
      return true;
    },

    get(subject, prop) {
      if (prop === _getUnwrapped) return subject;
      const method = methods[prop];
      if (method) return method;
      if (isArray && typeof prop !== "symbol" && !isNaN(prop)) prop = parseInt(prop);
      const value = subject[prop];
      return needsProxy(value) ? getProxy(value, changes.subCollector(prop)) : value;
    },

    deleteProperty(subject, prop) {
      if (isArray) throw new Error("change-recorder: cannot delete array item");
      if (subject[prop] === undefined) throw new Error("change-recorder: cannot delete undefined property");
      changes.addChange("d", prop);
      changes.addRollbackChange("=", prop, subject[prop]);
      delete subject[prop];
      return true;
    },
  };

  return new Proxy(subject, handler);
}

function needsProxy(subject) {
  return subject !== null && typeof subject === "object";
}
