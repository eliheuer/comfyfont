"""
DrawBot preset helpers — shared utility functions.

Import in any preset script with:
    from helpers import *

Functions
---------
remap(value, inputMin, inputMax, outputMin, outputMax)
    Map a value from one range to another.

grid(margin, step=None, color=(1, 0, 0), strokeWidth=2)
    Draw a debug grid over the current page.
"""


def remap(value, inputMin, inputMax, outputMin, outputMax):
    """Map value from [inputMin, inputMax] to [outputMin, outputMax]."""
    inputSpan  = inputMax - inputMin
    outputSpan = outputMax - outputMin
    valueScaled = float(value - inputMin) / float(inputSpan)
    return outputMin + (valueScaled * outputSpan)


def grid(margin, step=None, color=(1, 0, 0), weight=2):
    """
    Draw a debug grid over the current page.
    Call after newPage(); set GRID_VIEW = True to toggle on/off.

    margin  — inset from page edge for the outer rect
    step    — spacing between grid lines; defaults to margin / 2
    color   — RGB tuple for grid lines
    weight  — stroke width in points
    """
    # These DrawBot functions are injected into the exec namespace,
    # so they're available here when called from a preset script.
    import drawbot_skia.drawbot as _db

    if step is None:
        step = margin / 2

    # Determine page size from drawbot
    w = _db.width()
    h = _db.height()

    _db.save()
    _db.stroke(*color)
    _db.strokeWidth(weight)
    _db.fill(None)

    # Outer margin rect
    _db.rect(margin, margin, w - margin * 2, h - margin * 2)

    # Vertical lines
    x = margin
    while x <= w - margin:
        _db.line((x, margin), (x, h - margin))
        x += step

    # Horizontal lines
    y = margin
    while y <= h - margin:
        _db.line((margin, y), (w - margin, y))
        y += step

    # Bold centre lines
    _db.strokeWidth(weight * 2)
    _db.line((w / 2, margin), (w / 2, h - margin))
    _db.line((margin, h / 2), (w - margin, h / 2))

    _db.restore()
