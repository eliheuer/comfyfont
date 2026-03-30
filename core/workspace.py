"""
Workspace slot management.

A slot is a named directory under FONTS_DIR that contains all source
files for one font project. The FONT wire carries the slot name.

Directory layout example:
    fonts/
        Epistle-001/
            epistle-regular.ufo
            epistle-regular.ttf
        InstrumentsSerif-001/
            InstrumentsSerif.designspace
            InstrumentsSerif-Regular.ufo
            InstrumentsSerif-Black.ufo
"""

from __future__ import annotations

import os
import re
import xml.etree.ElementTree as ET

FONTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fonts"
)
os.makedirs(FONTS_DIR, exist_ok=True)

# Priority order when resolving the primary font path for rendering
_RENDER_EXTS = (".designspace", ".ttf", ".otf", ".woff", ".woff2")


# ---------------------------------------------------------------------------
# Slot path helpers

def slot_dir(slot_name: str) -> str:
    """Absolute path to the slot directory."""
    return os.path.join(FONTS_DIR, slot_name)


def slot_primary_path(slot_name: str) -> str | None:
    """
    Primary font path for rendering.
    Priority: .designspace > .ttf/.otf > .ufo
    Returns None if the slot doesn't exist or contains no font files.
    """
    d = slot_dir(slot_name)
    if not os.path.isdir(d):
        return None
    files = sorted(os.listdir(d))
    for ext in _RENDER_EXTS:
        for f in files:
            if f.lower().endswith(ext):
                return os.path.join(d, f)
    for f in files:
        p = os.path.join(d, f)
        if f.endswith(".ufo") and os.path.isdir(p):
            return p
    return None


def slot_edit_path(slot_name: str) -> str | None:
    """
    Preferred path for editing.
    Priority: .designspace > .ufo > compiled font
    """
    d = slot_dir(slot_name)
    if not os.path.isdir(d):
        return None
    files = sorted(os.listdir(d))
    for f in files:
        if f.lower().endswith(".designspace"):
            return os.path.join(d, f)
    for f in files:
        p = os.path.join(d, f)
        if f.endswith(".ufo") and os.path.isdir(p):
            return p
    return slot_primary_path(slot_name)


# ---------------------------------------------------------------------------
# Slot listing

def slot_list() -> list[str]:
    """Sorted list of all valid slot names in the workspace."""
    try:
        entries = os.listdir(FONTS_DIR)
    except OSError:
        return []
    return sorted(e for e in entries if slot_primary_path(e) is not None)


# ---------------------------------------------------------------------------
# Slot creation

def make_slot_name(family_name: str) -> str:
    """
    Allocate the next available slot name.
    "Instruments Serif" → "InstrumentsSerif-001", "InstrumentsSerif-002", …
    """
    base = re.sub(r"[^A-Za-z0-9]", "", family_name) or "Font"
    i = 1
    while True:
        name = f"{base}-{i:03d}"
        if not os.path.exists(os.path.join(FONTS_DIR, name)):
            return name
        i += 1


def extract_family_name(font_path: str) -> str:
    """
    Best-effort family name extraction from a font file or directory.
    Falls back to the filename stem on any error.
    """
    ext = os.path.splitext(font_path)[1].lower()
    try:
        if ext == ".designspace":
            root = ET.parse(font_path).getroot()
            for src in root.findall(".//sources/source"):
                name = src.get("familyname", "")
                if name:
                    return name
        elif ext == ".ufo" or os.path.isdir(font_path):
            import ufoLib2
            f = ufoLib2.Font.open(font_path)
            if f.info.familyName:
                return f.info.familyName
        else:
            from fontTools.ttLib import TTFont
            tt = TTFont(font_path, lazy=True)
            r = (tt["name"].getName(1, 3, 1, 0x0409) or
                 tt["name"].getName(1, 1, 0, 0))
            tt.close()
            if r:
                return r.toUnicode().strip()
    except Exception:
        pass
    return os.path.splitext(os.path.basename(font_path))[0]
