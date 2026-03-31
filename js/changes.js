/**
 * changes.js — Change protocol for ComfyFont.
 *
 * Ported from Fontra's src-js/fontra-core/src/changes.js.
 * Simplified: no subjectClassDef / itemCast (we use plain JS objects).
 *
 * A "change" is a plain JSON-serializable object:
 *   { p: ["path", "to", "subject"],   // optional path array
 *     f: "functionName",              // optional function to call
 *     a: [arg1, arg2, ...],           // optional arguments (default [])
 *     c: [childChange, ...] }         // optional child changes
 *
 * Registered function names:
 *   "="  — set property/index
 *   "d"  — delete property
 *   "-"  — splice (delete only)
 *   "+"  — splice (insert only)
 *   ":"  — splice (delete + insert)
 *   "=xy"                — VarPackedPath.setPointPosition(i, x, y)
 *   "appendPath"         — VarPackedPath.appendPath(path)
 *   "deleteNTrailingContours" — VarPackedPath.deleteNTrailingContours(n)
 *   "insertContour"      — VarPackedPath.insertContour(i, contour)
 *   "deleteContour"      — VarPackedPath.deleteContour(i)
 *   "insertPoint"        — VarPackedPath.insertPoint(ci, cpi, point)
 *   "deletePoint"        — VarPackedPath.deletePoint(ci, cpi)
 *   "moveAllWithFirstPoint" — VarPackedPath.moveAllWithFirstPoint(x, y)
 */

// ---------------------------------------------------------------------------
// ChangeCollector

export class ChangeCollector {
  constructor(parentCollector, path) {
    this._parentCollector = parentCollector;
    this._path = path;
    this._forwardChanges = undefined;
    this._rollbackChanges = undefined;
  }

  static fromChanges(forwardChanges, rollbackChanges) {
    if (!Array.isArray(forwardChanges)) {
      forwardChanges = hasChange(forwardChanges) ? [forwardChanges] : [];
    }
    if (!Array.isArray(rollbackChanges)) {
      rollbackChanges = hasChange(rollbackChanges) ? [rollbackChanges] : [];
    }
    const collector = new ChangeCollector();
    collector._forwardChanges = forwardChanges;
    collector._rollbackChanges = rollbackChanges;
    return collector;
  }

  _ensureForwardChanges() {
    if (this._forwardChanges) return;
    this._forwardChanges = [];
    if (this._parentCollector) {
      this._parentCollector._ensureForwardChanges();
      if (equalPath(this._path, lastItem(this._parentCollector._forwardChanges)?.p)) {
        this._forwardChanges = lastItem(this._parentCollector._forwardChanges).c;
      } else {
        this._parentCollector._forwardChanges.push({ p: this._path, c: this._forwardChanges });
      }
    }
  }

  _ensureRollbackChanges() {
    if (this._rollbackChanges) return;
    this._rollbackChanges = [];
    if (this._parentCollector) {
      this._parentCollector._ensureRollbackChanges();
      if (equalPath(this._path, this._parentCollector._rollbackChanges[0]?.p)) {
        this._rollbackChanges = this._parentCollector._rollbackChanges[0].c;
      } else {
        this._parentCollector._rollbackChanges.splice(0, 0, { p: this._path, c: this._rollbackChanges });
      }
    }
  }

  get hasChange() { return !!this._forwardChanges?.length; }
  get change() { return consolidateChanges(this._forwardChanges || {}); }
  get hasRollbackChange() { return !!this._rollbackChanges?.length; }
  get rollbackChange() { return consolidateChanges(this._rollbackChanges || {}); }

  addChange(func, ...args) {
    this._ensureForwardChanges();
    this._forwardChanges.push({ f: func, a: structuredClone(args) });
  }

  addRollbackChange(func, ...args) {
    this._ensureRollbackChanges();
    this._rollbackChanges.splice(0, 0, { f: func, a: structuredClone(args) });
  }

  subCollector(...path) {
    return new ChangeCollector(this, path);
  }

  concat(...others) {
    const forwardChanges = this.hasChange ? [...this._forwardChanges] : [];
    const rollbackChanges = this.hasRollbackChange ? [...this._rollbackChanges] : [];
    for (const other of others) {
      if (other.hasChange) forwardChanges.push(...other._forwardChanges);
      if (other.hasRollbackChange) rollbackChanges.splice(0, 0, ...other._rollbackChanges);
    }
    return ChangeCollector.fromChanges(forwardChanges, rollbackChanges);
  }

  prefixed(pathPrefix) {
    return ChangeCollector.fromChanges(
      consolidateChanges(this.change, pathPrefix),
      consolidateChanges(this.rollbackChange, pathPrefix)
    );
  }
}

export function joinChanges(...changes) {
  return new ChangeCollector().concat(...changes);
}

// ---------------------------------------------------------------------------
// consolidateChanges — flatten a change list into a single canonical change

export function consolidateChanges(changes, prefixPath) {
  let change;
  let path;
  if (!Array.isArray(changes)) changes = [changes];

  if (changes.length === 1) {
    change = { ...changes[0] };
    path = change.p;
  } else {
    const commonPrefix = findCommonPrefix(changes);
    const numCommon = commonPrefix.length;
    if (numCommon) {
      changes = changes.map((c) => {
        const nc = { ...c };
        nc.p = c.p.slice(numCommon);
        if (!nc.p.length) delete nc.p;
        return nc;
      });
      path = commonPrefix;
    } else {
      changes = changes.map((c) => {
        const nc = { ...c };
        if (nc.p && !nc.p.length) delete nc.p;
        return nc;
      });
    }
    change = { c: changes };
  }

  if (path?.length) change["p"] = path;
  else delete change["p"];

  change = unnestSingleChildren(change);

  if (prefixPath?.length) change = addPathPrefix(change, prefixPath);
  return change;
}

function unnestSingleChildren(change) {
  const children = change.c?.map(unnestSingleChildren).filter(hasChange);

  if (!children?.length) {
    if (children?.length === 0) {
      change = { ...change };
      delete change.c;
    }
    if (!change.f) change = {};
    return change;
  }

  if (children.length !== 1) {
    change = { ...change, c: children };
    return change;
  }

  const child = children[0];
  const childPath = child.p || [];
  const path = change.p?.length ? change.p.concat(childPath) : childPath;
  change = { ...child };
  if (path.length) change.p = path;
  else delete change.p;
  return change;
}

function addPathPrefix(change, prefixPath) {
  return { ...change, p: prefixPath.concat(change.p || []) };
}

function findCommonPrefix(changes) {
  const commonPrefix = [];
  if (!changes.length) return commonPrefix;
  for (const c of changes) {
    if (!c.p?.length) return commonPrefix;
  }
  let index = 0;
  while (true) {
    const elem = changes[0].p[index];
    if (!elem) return commonPrefix;
    for (let i = 1; i < changes.length; i++) {
      if (changes[i].p[index] !== elem) return commonPrefix;
    }
    commonPrefix.push(elem);
    index++;
  }
}

// ---------------------------------------------------------------------------
// Change functions — called by applyChange

const changeFunctions = {
  "=":  (subject, key, item)              => { subject[key] = item; },
  "d":  (subject, key)                    => { delete subject[key]; },
  "-":  (subject, index, deleteCount = 1) => { subject.splice(index, deleteCount); },
  "+":  (subject, index, ...items)        => { subject.splice(index, 0, ...items); },
  ":":  (subject, index, del, ...items)   => { subject.splice(index, del, ...items); },

  // VarPackedPath operations
  "=xy":                   (path, i, x, y)    => { path.setPointPosition(i, x, y); },
  "appendPath":            (path, other)       => { path.appendPath(other); },
  "deleteNTrailingContours": (path, n)         => { path.deleteNTrailingContours(n); },
  "insertContour":         (path, i, contour)  => { path.insertContour(i, contour); },
  "deleteContour":         (path, i)           => { path.deleteContour(i); },
  "insertPoint":           (path, ci, cpi, pt) => { path.insertPoint(ci, cpi, pt); },
  "deletePoint":           (path, ci, cpi)     => { path.deletePoint(ci, cpi); },
  "moveAllWithFirstPoint": (path, x, y)        => { path.moveAllWithFirstPoint(x, y); },
};

// ---------------------------------------------------------------------------
// applyChange — walk path, dispatch to change function, recurse into children

export function applyChange(subject, change) {
  if (!hasChange(change)) return;

  const path = change["p"] || [];
  const functionName = change["f"];
  const children = change["c"] || [];

  for (const pathElement of path) {
    subject = subject[pathElement];
    if (subject === undefined) {
      throw new Error(`applyChange: invalid path element "${pathElement}"`);
    }
  }

  if (functionName) {
    const changeFunc = changeFunctions[functionName];
    if (!changeFunc) throw new Error(`applyChange: unknown function "${functionName}"`);
    changeFunc(subject, ...structuredClone(change["a"] || []));
  }

  for (const subChange of children) {
    applyChange(subject, subChange);
  }
}

// ---------------------------------------------------------------------------
// Pattern matching utilities (for subscriptions / filtering)

export function matchChangePath(change, matchPath) {
  return matchChangePattern(change, patternFromPath(matchPath));
}

function patternFromPath(matchPath) {
  if (!matchPath.length) return {};
  const inner = matchPath.length === 1 ? null : patternFromPath(matchPath.slice(1));
  return { [matchPath[0]]: inner };
}

export function matchChangePattern(change, matchPattern) {
  let node = matchPattern;
  for (const pathElement of change.p || []) {
    let child = node[pathElement];
    if (child === undefined) child = node["__WILDCARD__"];
    if (child === undefined) return false;
    if (child === null) return true;
    node = child;
  }
  for (const childChange of change.c || []) {
    if (matchChangePattern(childChange, node)) return true;
  }
  return false;
}

export function collectChangePaths(change, depth) {
  const pathsSet = new Set();
  for (const path of iterateChangePaths(change, depth)) {
    pathsSet.add(JSON.stringify(path));
  }
  return [...pathsSet].map((s) => JSON.parse(s));
}

function* iterateChangePaths(change, depth, prefix = []) {
  const path = prefix.concat(change.p || []);
  if (path.length >= depth) {
    yield path.slice(0, depth);
    return;
  }
  for (const child of change.c || []) {
    yield* iterateChangePaths(child, depth, path);
  }
}

// ---------------------------------------------------------------------------
// Utilities

export function hasChange(obj) {
  if (!obj) return false;
  for (const _ in obj) return true;
  return false;
}

function equalPath(p1, p2) {
  if (!p1 || !p2 || p1.length !== p2.length) return false;
  for (let i = 0; i < p1.length; i++) {
    if (p1[i] !== p2[i]) return false;
  }
  return true;
}

function lastItem(array) {
  return array?.length ? array[array.length - 1] : undefined;
}

export function* iterChanges(change, prefix = []) {
  const path = prefix.concat(change.p || []);
  if (change.f) {
    yield { path, change };
    return;
  }
  for (const child of change.c || []) {
    yield* iterChanges(child, path);
  }
}
