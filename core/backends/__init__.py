from .base import ReadableFontBackend, WritableFontBackend
from .opentype import OTFBackend
from .ufo import UFOBackend

EXTENSION_MAP: dict[str, type] = {
    ".ttf": OTFBackend,
    ".otf": OTFBackend,
    ".woff": OTFBackend,
    ".woff2": OTFBackend,
    ".ufo": UFOBackend,
}


def backendForPath(path: str) -> ReadableFontBackend:
    from pathlib import Path as _Path
    suffix = _Path(path).suffix.lower()
    cls = EXTENSION_MAP.get(suffix)
    if cls is None:
        raise ValueError(f"Unsupported font format: {suffix!r}")
    return cls.fromPath(path)
