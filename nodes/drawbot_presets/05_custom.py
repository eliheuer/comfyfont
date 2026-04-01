from helpers import *

GRID = False

# Write your DrawBot script here.
#
# Available variables:
#   font_path   — absolute path to the loaded font
#   WIDTH       — canvas width in pixels
#   HEIGHT      — canvas height in pixels
#   input_text  — value from the node's input_text field (string, may be empty)
#
# All DrawBot functions are available as globals:
#   font(), text(), textBox(), rect(), oval(), fill(), stroke(),
#   newPage(), image(), size(), etc.
#
# Helpers (imported above):
#   remap(value, inputMin, inputMax, outputMin, outputMax)
#   grid(margin, step=None, color=(1,0,0), weight=2)  — set GRID = True to enable

newPage(WIDTH, HEIGHT)

fill(0.1)
rect(0, 0, WIDTH, HEIGHT)

font(font_path, 80)
fill(1)
text(input_text or "Aa", (WIDTH / 2, HEIGHT / 2 - 40), align="center")

if GRID:
    grid(WIDTH * 0.05)
