from helpers import *

GRID = False

# Display a single large character.
# Set input_text to any character or string — defaults to "A".

newPage(WIDTH, HEIGHT)

fill(0.1)
rect(0, 0, WIDTH, HEIGHT)

font(font_path, HEIGHT * 0.75)
fill(1)
text(input_text or "A", (WIDTH / 2, HEIGHT * 0.15), align="center")

if GRID:
    grid(WIDTH * 0.05)
