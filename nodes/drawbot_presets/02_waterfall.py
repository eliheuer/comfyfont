from helpers import *

GRID = False

newPage(WIDTH, HEIGHT)

fill(0.1)
rect(0, 0, WIDTH, HEIGHT)

sample = input_text or "The quick brown fox jumps over the lazy dog"
margin = WIDTH * 0.04
y = HEIGHT - margin
fill(1)
for size in [96, 72, 60, 48, 36, 28, 24, 18, 14, 12]:
    if y < margin:
        break
    font(font_path, size)
    text(sample, (margin, y))
    y -= size * 1.4

if GRID:
    grid(WIDTH * 0.04)
