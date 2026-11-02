"""Color palette (sRGB hex). Use `lin()` to get Blender's linear RGBA."""

INDIGO = "#2A3F8E"          # happi, noren
INDIGO_DARK = "#1C2A63"
CREAM = "#F5EEDC"           # happi checker, mon
CHICK = "#FFD13C"
CHICK_BELLY = "#FFE79A"
BEAK = "#F3A13A"
CHEEK = "#F49C98"
EYE = "#251A16"
OWL = "#8C5D3B"
OWL_DARK = "#6E4529"
OWL_FACE = "#F1E1C2"
HEN = "#F8F3EA"
COMB = "#D8423A"
PENGUIN = "#2E3446"
SPARROW = "#9A6440"
SPARROW_DARK = "#5E3A24"
SPARROW_BELLY = "#F3E4C8"
PENGUIN_BELLY = "#F3EAD6"
CAP = "#23315C"
GOLD = "#D9A93E"

WOOD = "#A9693A"
WOOD_LIGHT = "#C8904F"
WOOD_DARK = "#6A3D21"
WOOD_FLOOR = "#B27340"
PLASTER = "#EAD5B0"
PAPER = "#F6E9CC"
LANTERN = "#FFD9A0"
CORK = "#B98A57"
RUG = "#7A4E6E"
STONE = "#9C8F86"
LEAF = "#5E8F48"
SKY_TOP = "#4B3F86"
SKY_LOW = "#F29B6B"


def lin(hexstr, alpha=1.0):
    h = hexstr.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (*out, alpha)


def mix(a, b, t):
    """Mix two hex colors in sRGB space and return hex."""
    ha, hb = a.lstrip("#"), b.lstrip("#")
    out = "#"
    for i in (0, 2, 4):
        ca, cb = int(ha[i:i + 2], 16), int(hb[i:i + 2], 16)
        out += "%02X" % round(ca + (cb - ca) * t)
    return out
