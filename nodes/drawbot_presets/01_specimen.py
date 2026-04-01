from helpers import *

GRID = False

newPage(WIDTH, HEIGHT)

fill(0.1)
rect(0, 0, WIDTH, HEIGHT)

lines = [
    "ABCDEFGHIJKLM",
    "NOPQRSTUVWXYZ",
    "abcdefghijklm",
    "nopqrstuvwxyz",
    "0123456789",
]
padding = HEIGHT * 0.05
size = (HEIGHT - padding * 2) / (len(lines) * 1.25)
font(font_path, size)
fill(1)
for i, line in enumerate(lines):
    text(line, (WIDTH / 2, HEIGHT - padding - size * (i + 1)), align="center")

if GRID:
    grid(WIDTH * 0.05)
