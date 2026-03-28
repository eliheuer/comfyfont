"""
Change application system.

Mirrors Fontra's core/changes.py.

Change dict schema:
  {
    "p": ["key", ...],        # path to navigate before applying
    "c": [                    # list of operations on the arrived-at subject
      { "f": "=", "a": ["fieldName", newValue] },   # set attribute/item
      { "f": "+", "a": [index, item] },              # list insert
      { "f": "-", "a": [index] },                    # list delete
    ],
    "children": [             # optional recursive sub-changes on arrived subject
      { "p": [...], "c": [...] }
    ]
  }
"""

from __future__ import annotations

from typing import Any


def _navigate(subject: Any, path: list) -> Any:
    for key in path:
        if isinstance(subject, dict):
            subject = subject[key]
        elif isinstance(subject, list):
            subject = subject[int(key)]
        else:
            subject = getattr(subject, key)
    return subject


def _apply_ops(subject: Any, ops: list[dict]) -> None:
    for op in ops:
        func = op["f"]
        args = op.get("a", [])

        if func == "=":
            key, value = args
            if isinstance(subject, dict):
                subject[key] = value
            elif isinstance(subject, list):
                subject[int(key)] = value
            else:
                setattr(subject, key, value)

        elif func == "+":
            index, item = args
            if isinstance(subject, dict):
                subject[key] = item
            elif isinstance(subject, list):
                subject.insert(int(index), item)
            else:
                lst = getattr(subject, args[0])
                lst.insert(int(args[1]), args[2])

        elif func == "-":
            index = args[0]
            if isinstance(subject, list):
                del subject[int(index)]
            elif isinstance(subject, dict):
                del subject[index]


def applyChange(root: Any, change: dict) -> None:
    """Apply a (possibly nested) change to *root* in place."""
    path = change.get("p", [])
    subject = _navigate(root, path)

    ops = change.get("c", [])
    if ops:
        _apply_ops(subject, ops)

    for child in change.get("children", []):
        applyChange(subject, child)


def makeSetChange(path: list, key: str, value: Any) -> dict:
    """Convenience: build a simple set-field change dict."""
    return {"p": path, "c": [{"f": "=", "a": [key, value]}]}


def makeRollback(change: dict, root: Any) -> dict:
    """
    Build a rollback change that undoes *change* on *root*.
    Only handles "=" ops for now.
    """
    path = change.get("p", [])
    subject = _navigate(root, path)
    rollback_ops = []

    for op in change.get("c", []):
        if op["f"] == "=":
            key = op["a"][0]
            if isinstance(subject, dict):
                old = subject.get(key)
            else:
                old = getattr(subject, key, None)
            rollback_ops.append({"f": "=", "a": [key, old]})

    return {"p": path, "c": rollback_ops}
