from helpers import *

GRID = False

newPage(WIDTH, HEIGHT)

fill(0.1)
rect(0, 0, WIDTH, HEIGHT)

margin = WIDTH * 0.06
font(font_path, HEIGHT * 0.075)
fill(1)
textBox(
    input_text or "The quick brown fox jumps over the lazy dog.",
    (margin, margin, WIDTH - margin * 2, HEIGHT - margin * 2),
)

if GRID:
    grid(margin)
