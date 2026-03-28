"""UFO → TTF compilation via fontmake."""

from __future__ import annotations

import logging
import os
import shutil

log = logging.getLogger(__name__)


def compile_ufo_to_ttf(ufo_path: str) -> str:
    """Compile a UFO to a TrueType-flavored TTF. Returns the TTF path."""
    import tempfile
    from fontmake.font_project import FontProject

    ttf_path = os.path.splitext(ufo_path)[0] + ".ttf"
    with tempfile.TemporaryDirectory() as tmp:
        FontProject().build_ttfs([ufo_path], output_dir=tmp)
        built = [f for f in os.listdir(tmp) if f.endswith(".ttf")]
        if not built:
            raise RuntimeError(f"fontmake produced no output for {ufo_path}")
        shutil.copy(os.path.join(tmp, built[0]), ttf_path)
    log.info("Compiled %s → %s", ufo_path, ttf_path)
    return ttf_path
