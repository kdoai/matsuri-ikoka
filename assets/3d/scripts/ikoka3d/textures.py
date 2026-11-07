"""Painted textures: crest, noren, signs, posters, map, timetable, books,
brochures, quest cards, happi and the staff's face expressions.

Everything is drawn with `canvas.Canvas` from shapes and text. Each painter
returns a packed bpy image; `export_all()` also writes the PNGs for review.
Place names and festivals here are fictional.
"""

import math
import random

from . import canvas
from . import palette as P

INK = "#2B2220"
INDIGO = P.INDIGO
CREAM = P.CREAM
PAPER = "#F4E7C9"
RED = "#C8473C"
SUN = "#E2553F"
GOLD_LINE = "#E9B44C"

_images = {}


def get(name):
    """Cached painter call: get('noren') -> bpy image."""
    if name not in _images or _images[name].name not in __import__("bpy").data.images:
        _images[name] = globals()[f"paint_{name}"]().image(f"tex.{name}")
    return _images[name]


def reset():
    _images.clear()


# --------------------------------------------------------------------------
# Motifs


def mon(c, cx, cy, r, fg=INDIGO, bg=CREAM, ring=True):
    """Shop crest: a mountain over two waves inside a circle."""
    if ring:
        c.circle(cx, cy, r, bg)
    s = r / 100.0
    c.polygon([(cx - 62 * s, cy + 18 * s), (cx - 18 * s, cy - 44 * s), (cx + 4 * s, cy - 20 * s),
               (cx + 22 * s, cy - 40 * s), (cx + 64 * s, cy + 18 * s)], fg)
    c.polygon([(cx - 28 * s, cy - 30 * s), (cx - 18 * s, cy - 44 * s), (cx - 6 * s, cy - 28 * s),
               (cx - 12 * s, cy - 24 * s), (cx - 18 * s, cy - 30 * s)], bg)
    for i, y in enumerate((cy + 34 * s, cy + 56 * s)):
        c.wave(cx - 66 * s + i * 8 * s, cx + 66 * s - i * 8 * s, y, 7 * s, 44 * s, 9 * s, fg, phase=i * 1.5)
    c.circle(cx + 40 * s, cy - 52 * s, 9 * s, fg)


def seigaiha(c, x0, y0, x1, y1, r, fg, bg, width=None):
    """Overlapping wave scales."""
    width = width or r * 0.12
    c.rect(x0, y0, x1, y1, bg)
    rows = int((y1 - y0) / (r * 0.5)) + 2
    for j in range(rows):
        y = y0 + j * r * 0.5
        off = (j % 2) * r
        x = x0 - r + off
        while x < x1 + r:
            for k in range(3):
                c.arc(x, y + r, r * (1 - 0.3 * k), math.pi, 2 * math.pi, width, fg, segs=24)
            x += 2 * r


def checker(c, x0, y0, x1, y1, n_rows, fg, bg):
    c.rect(x0, y0, x1, y1, bg)
    size = (y1 - y0) / n_rows
    cols = int(math.ceil((x1 - x0) / size))
    for j in range(n_rows):
        for i in range(cols):
            if (i + j) % 2 == 0:
                c.rect(x0 + i * size, y0 + j * size, min(x0 + (i + 1) * size, x1), y0 + (j + 1) * size, fg,
                       feather=0.6)


def lantern_icon(c, cx, cy, h, fg, bg=None):
    w = h * 0.62
    c.rect(cx - w * 0.3, cy - h / 2, cx + w * 0.3, cy - h / 2 + h * 0.1, fg, radius=2)
    c.rect(cx - w * 0.3, cy + h / 2 - h * 0.1, cx + w * 0.3, cy + h / 2, fg, radius=2)
    c.ellipse(cx, cy, w / 2, h * 0.36, fg)
    if bg:
        for k in (-2, -1, 0, 1, 2):
            c.rect(cx - w * 0.45, cy + k * h * 0.12 - h * 0.012, cx + w * 0.45, cy + k * h * 0.12 + h * 0.012, bg)


def firework(c, cx, cy, r, color, rays=18, seed=0):
    rng = random.Random(seed)
    for i in range(rays):
        a = 2 * math.pi * i / rays + rng.uniform(-0.05, 0.05)
        rr = r * rng.uniform(0.75, 1.0)
        c.stroke([(cx + math.cos(a) * r * 0.2, cy + math.sin(a) * r * 0.2),
                  (cx + math.cos(a) * rr, cy + math.sin(a) * rr)], max(1.5, r * 0.04), color, alpha=0.9)
        c.circle(cx + math.cos(a) * rr, cy + math.sin(a) * rr, max(1.5, r * 0.05), color)
    c.glow(cx, cy, r * 0.5, color, 0.5)


def torii(c, cx, base, h, color):
    w = h * 1.1
    c.rect(cx - w * 0.36, base - h, cx - w * 0.28, base, color)
    c.rect(cx + w * 0.28, base - h, cx + w * 0.36, base, color)
    c.rect(cx - w / 2, base - h, cx + w / 2, base - h + h * 0.1, color, radius=3)
    c.rect(cx - w * 0.42, base - h * 0.74, cx + w * 0.42, base - h * 0.67, color)


def bowl(c, cx, cy, r, color="#B8453A"):
    c.ellipse(cx, cy - r * 0.15, r * 0.95, r * 0.28, "#F3E3C2")
    c.polygon([(cx - r, cy - r * 0.15), (cx + r, cy - r * 0.15), (cx + r * 0.6, cy + r * 0.55),
               (cx - r * 0.6, cy + r * 0.55)], color)
    for k in range(3):
        c.stroke([(cx - r * 0.3 + k * r * 0.3, cy - r * 0.45), (cx - r * 0.2 + k * r * 0.3, cy - r * 0.9)],
                 r * 0.06, "#FFFFFF", alpha=0.7)


def crab(c, cx, cy, r, color="#D9573F"):
    c.ellipse(cx, cy, r, r * 0.62, color)
    for sx in (-1, 1):
        for k in range(3):
            c.stroke([(cx + sx * r * 0.7, cy + r * 0.1 * k), (cx + sx * r * 1.35, cy + r * (0.25 + 0.25 * k))],
                     r * 0.12, color)
        c.circle(cx + sx * r * 1.05, cy - r * 0.75, r * 0.32, color)
        c.circle(cx + sx * r * 0.3, cy - r * 0.55, r * 0.12, INK)


def mountain_scene(c, x0, y0, x1, y1, sky=("#9FC6E6", "#F4E2C4"), sea="#4E86B8", seed=0):
    rng = random.Random(seed)
    c.vgradient(y0, y1, sky[0], sky[1], x0, x1)
    h = y1 - y0
    w = x1 - x0
    mx = x0 + w * rng.uniform(0.3, 0.7)
    c.polygon([(x0, y0 + h * 0.7), (mx - w * 0.35, y0 + h * 0.62), (mx, y0 + h * 0.22), (mx + w * 0.38, y0 + h * 0.62),
               (x1, y0 + h * 0.68), (x1, y1), (x0, y1)], "#5C7FA6")
    c.polygon([(mx - w * 0.1, y0 + h * 0.33), (mx, y0 + h * 0.22), (mx + w * 0.11, y0 + h * 0.34),
               (mx + w * 0.04, y0 + h * 0.37), (mx - w * 0.03, y0 + h * 0.35)], "#FFFFFF")
    c.polygon([(x0, y0 + h * 0.72), (x0 + w * 0.3, y0 + h * 0.62), (x0 + w * 0.6, y0 + h * 0.74), (x1, y0 + h * 0.66),
               (x1, y1), (x0, y1)], "#6FA35A")
    c.rect(x0, y0 + h * 0.82, x1, y1, sea)
    for k in range(3):
        c.wave(x0, x1, y0 + h * (0.86 + 0.05 * k), h * 0.012, w * 0.18, max(1.5, h * 0.012), "#DCEBF5", phase=k)


# --------------------------------------------------------------------------
# Shop signage


def paint_noren():
    """Three-panel noren; UV spans all panels left to right."""
    c = canvas.Canvas(1024, 512, INDIGO)
    c.grain(0.05, seed=1, scale=2)
    mon(c, 512, 230, 150, fg=INDIGO, bg=CREAM)
    c.vtext("たびや", 885, 120, 92, CREAM, weight=0.03)
    c.vtext("旅の相談所", 150, 70, 62, CREAM, weight=0.02)
    for x in (341, 683):
        c.rect(x - 4, 0, x + 4, 512, P.INDIGO_DARK)
    return c


def paint_counter_sign():
    c = canvas.Canvas(1024, 288, "#F2E2BE")
    c.grain(0.03, seed=2)
    c.frame(10, 10, 1014, 278, 14, P.WOOD_DARK, radius=18)
    c.circle(150, 112, 52, SUN)
    for i in range(3):
        c.wave(40, 300, 170 + i * 28, 10, 90, 12, INDIGO, phase=i * 1.2)
    c.text("たびや", 610, 140, 150, INK, weight=0.035)
    c.text("旅の相談所", 860, 245, 34, P.WOOD_DARK, weight=0.02)
    return c


def paint_standing_sign():
    c = canvas.Canvas(320, 896, "#F4E6C6")
    c.grain(0.03, seed=3)
    c.frame(8, 8, 312, 888, 10, P.WOOD_DARK, radius=8)
    mon(c, 160, 120, 70)
    c.vtext("たびや", 160, 205, 80, INK, weight=0.035)
    c.vtext("旅の相談所", 160, 480, 50, P.WOOD_DARK, weight=0.02)
    seigaiha(c, 20, 800, 300, 880, 30, CREAM, INDIGO)
    return c


def paint_facade_sign():
    """Big signboard over the storefront."""
    c = canvas.Canvas(1024, 448, "#EBD3A6")
    c.grain(0.04, seed=4)
    c.frame(10, 10, 1014, 438, 18, P.WOOD_DARK, radius=40)
    c.circle(220, 110, 56, SUN)
    c.polygon([(560, 180), (690, 60), (760, 120), (820, 80), (960, 180)], "#5E86A8")
    c.polygon([(660, 88), (690, 60), (720, 90), (700, 98)], "#FFFFFF")
    for i in range(3):
        c.wave(40, 330, 300 + i * 34, 14, 110, 14, INDIGO, phase=i)
        c.wave(700, 990, 300 + i * 34, 14, 110, 14, INDIGO, phase=i + 2)
    c.text("たびや", 512, 225, 165, INK, weight=0.035)
    c.text("旅の相談所", 512, 370, 56, P.WOOD_DARK, weight=0.025)
    return c


def paint_tapestry():
    c = canvas.Canvas(256, 768, P.INDIGO_DARK)
    c.grain(0.05, seed=5, scale=2)
    c.vtext("まつり旅", 128, 70, 120, CREAM, weight=0.03)
    mon(c, 128, 660, 72)
    return c


# --------------------------------------------------------------------------
# Posters (fictional festivals)


def paint_poster_fireworks():
    c = canvas.Canvas(512, 720, "#1E2453")
    c.vgradient(0, 720, "#1A1F4E", "#5A3D78")
    for (x, y, r, col, s) in [(140, 170, 110, "#F7C54E", 1), (370, 120, 90, "#F08AA6", 2), (330, 300, 70, "#8FD3F4", 3),
                              (120, 360, 60, "#F7E39A", 4)]:
        firework(c, x, y, r, col, seed=s)
    c.polygon([(0, 560), (120, 520), (260, 545), (380, 505), (512, 535), (512, 720), (0, 720)], "#14183A")
    for i in range(9):
        c.circle(30 + i * 55, 590 + (i % 2) * 10, 9, "#FFC46B")
        c.glow(30 + i * 55, 590 + (i % 2) * 10, 26, "#FFB050", 0.6)
    c.vtext("夏まつり", 452, 60, 78, "#FFFFFF", weight=0.03)
    c.text("花火の夕べ", 160, 660, 44, "#FFE7B0", weight=0.02)
    return c


def paint_poster_lanterns():
    c = canvas.Canvas(512, 720, "#3A2A55")
    c.vgradient(0, 720, "#2E2350", "#E07A5F")
    for row, y in enumerate((150, 250)):
        c.stroke([(0, y - 30), (512, y + 10)], 3, "#2A1A12")
        for i in range(7):
            x = 40 + i * 72
            yy = y - 30 + (x / 512) * 40 + 30
            c.glow(x, yy, 44, "#FFB050", 0.55)
            lantern_icon(c, x, yy, 54, "#F6A23E", "#D9572F")
    c.polygon([(60, 720), (60, 470), (256, 380), (452, 470), (452, 720)], "#2A1C18")
    c.rect(110, 500, 400, 720, "#3D2A20")
    for i in range(4):
        c.rect(130 + i * 70, 530, 180 + i * 70, 620, "#FFC879")
    c.text("灯りまつり", 256, 70, 70, "#FFFFFF", weight=0.03)
    c.text("十月の三夜", 256, 670, 36, "#FFE7B0", weight=0.02)
    return c


def paint_poster_mountain():
    c = canvas.Canvas(512, 720, "#9FC6E6")
    mountain_scene(c, 0, 0, 512, 720, sky=("#F2B880", "#F7E2C2"), seed=7)
    torii(c, 380, 560, 120, RED)
    c.vtext("山の祭", 70, 60, 74, INK, weight=0.03)
    c.text("ゆっくり歩く旅", 300, 670, 38, INK, weight=0.02)
    return c


def paint_poster_snow():
    c = canvas.Canvas(512, 720, "#2C3E6E")
    c.vgradient(0, 720, "#203260", "#7FA2CF")
    rng = random.Random(9)
    for _ in range(80):
        c.circle(rng.uniform(0, 512), rng.uniform(0, 520), rng.uniform(2, 5), "#FFFFFF", 0.8)
    c.polygon([(0, 520), (200, 470), (512, 500), (512, 720), (0, 720)], "#EEF3F8")
    for i in range(5):
        x = 70 + i * 95
        c.polygon([(x - 34, 560), (x, 500), (x + 34, 560)], "#DCE6F0")
        c.rect(x - 14, 535, x + 14, 560, "#FFB760")
        c.glow(x, 548, 30, "#FFB050", 0.5)
    c.text("雪あかり", 256, 120, 86, "#FFFFFF", weight=0.03)
    return c


# --------------------------------------------------------------------------
# Work stations


JAPAN = {
    # Stylized archipelago outlines in a 1000 x 1000 box (not to scale).
    "hokkaido": [(705, 70), (760, 52), (815, 85), (880, 70), (905, 110), (860, 150), (830, 200), (790, 185),
                 (760, 215), (730, 190), (742, 140)],
    "honshu": [(735, 240), (770, 255), (780, 320), (770, 390), (752, 450), (720, 500), (680, 545), (630, 560),
               (575, 575), (520, 600), (470, 615), (420, 640), (370, 660), (330, 655), (318, 625), (360, 600),
               (410, 585), (450, 560), (500, 540), (545, 510), (590, 490), (625, 450), (655, 410), (690, 360),
               (705, 305), (712, 260)],
    "shikoku": [(400, 680), (450, 672), (500, 688), (490, 725), (440, 735), (405, 718)],
    "kyushu": [(270, 665), (315, 672), (330, 720), (318, 780), (285, 820), (250, 800), (240, 745), (250, 700)],
    "okinawa": [(140, 900), (152, 892), (160, 905), (148, 915)],
}


def paint_map():
    c = canvas.Canvas(1024, 512, "#F3E6C8")
    c.grain(0.04, seed=11)
    seigaiha(c, 0, 0, 1024, 512, 26, "#E4D2AE", "#EEDFC0", 2.0)
    c.frame(6, 6, 1018, 506, 10, "#9A6A3E", radius=6)
    c.rect(20, 18, 330, 86, INDIGO, radius=10)
    c.text("ご当地グルメ", 175, 52, 44, CREAM, weight=0.03)
    ox, oy, s = 300, 20, 0.53
    for name, pts in JAPAN.items():
        poly = [(ox + x * s, oy + y * s) for x, y in pts]
        c.polygon([(x + 4, y + 5) for x, y in poly], "#C7B48E")
        c.polygon(poly, "#A9C98E")
        c.stroke(poly, 2.5, "#6F8F57", closed=True)
    route = [(ox + x * s, oy + y * s) for x, y in [(820, 120), (740, 300), (700, 420), (600, 520), (470, 590), (300, 720)]]
    for a, b in zip(route[:-1], route[1:]):
        n = 8
        for k in range(n):
            if k % 2 == 0:
                p0 = (a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n)
                p1 = (a[0] + (b[0] - a[0]) * (k + 1) / n, a[1] + (b[1] - a[1]) * (k + 1) / n)
                c.stroke([p0, p1], 3, RED)
    for x, y in route:
        c.circle(x, y + 2, 9, "#7A2A22")
        c.circle(x, y, 8, RED)
        c.circle(x, y, 3, "#FFFFFF")
    # Food cards around the map.
    for (x, y, kind) in [(90, 180, "bowl"), (90, 360, "crab"), (900, 180, "crab"), (900, 360, "bowl"),
                         (230, 440, "bowl")]:
        c.rect(x - 62, y - 56, x + 62, y + 56, "#FFFFFF", radius=8)
        c.frame(x - 62, y - 56, x + 62, y + 56, 3, "#D8C29A", radius=8)
        (bowl if kind == "bowl" else crab)(c, x, y - 4, 34)
    return c


TIMETABLE_ROWS = [("06:42", "山野", "普通"), ("07:15", "川辺", "快速"), ("08:03", "港町", "普通"),
                  ("09:30", "温泉郷", "特急"), ("10:48", "海岸", "普通"), ("12:10", "城下", "快速"),
                  ("13:55", "山野", "普通"), ("15:20", "花の里", "特急"), ("17:05", "港町", "快速"),
                  ("18:40", "温泉郷", "普通")]


def paint_timetable():
    c = canvas.Canvas(1024, 768, "#F5F0E4")
    c.rect(0, 0, 1024, 120, P.INDIGO_DARK)
    c.rect(40, 30, 120, 90, CREAM, radius=10)
    c.rect(52, 42, 108, 66, P.INDIGO_DARK, radius=4)
    c.circle(62, 80, 6, P.INDIGO_DARK)
    c.circle(98, 80, 6, P.INDIGO_DARK)
    c.text("電車時刻表", 420, 62, 70, CREAM, weight=0.03)
    c.text("のぼり", 820, 62, 40, "#F6D56A", weight=0.02)
    for col, x in enumerate((60, 560)):
        for i, (t, dest, kind) in enumerate(TIMETABLE_ROWS[col * 5: col * 5 + 5]):
            y = 175 + i * 112
            c.rect(x - 20, y - 46, x + 440, y + 46, "#FFFFFF" if i % 2 == 0 else "#ECE5D4", radius=6)
            c.text(t, x + 70, y, 52, INK, weight=0.01)
            c.text(dest, x + 250, y, 48, INK, weight=0.02)
            col_k = {"普通": "#3E7A5C", "快速": "#D07A2E", "特急": RED}[kind]
            c.rect(x + 340, y - 24, x + 420, y + 24, col_k, radius=12)
            c.text(kind, x + 380, y, 30, "#FFFFFF", weight=0.02)
    c.stroke([(512, 140), (512, 740)], 4, "#C9BFA8")
    return c


def paint_quest_cards():
    """4 x 2 atlas of pinned quest cards."""
    c = canvas.Canvas(1024, 640, "#FFFFFF")
    tints = ["#FBF4E2", "#FCE7A8", "#F7D3CC", "#D9E8F2", "#E3EFD3", "#FBF4E2", "#F7D3CC", "#FCE7A8"]
    titles = ["祭りを探す", "宿をとる", "郷土の味", "列車で行く", "地図を見る", "灯りを見る", "花火の夜", "朝市へ"]
    for k in range(8):
        col, row = k % 4, k // 4
        x0, y0 = col * 256, row * 320
        c.rect(x0 + 8, y0 + 8, x0 + 248, y0 + 312, tints[k], radius=6)
        cx = x0 + 128
        icon = k % 4
        if icon == 0:
            torii(c, cx, y0 + 170, 90, RED)
        elif icon == 1:
            lantern_icon(c, cx, y0 + 120, 100, "#E7963A", "#C8573A")
        elif icon == 2:
            bowl(c, cx, y0 + 130, 50)
        else:
            firework(c, cx, y0 + 120, 60, "#E0703A", seed=k)
        c.text(titles[k], cx, y0 + 225, 34, INK, weight=0.02)
        for j in range(2):
            c.rect(x0 + 40, y0 + 258 + j * 20, x0 + 216 - j * 50, y0 + 266 + j * 20, "#B9AE98", radius=3)
        c.circle(cx, y0 + 26, 13, RED)
        c.circle(cx - 4, y0 + 22, 4, "#FFFFFF", 0.7)
    return c


BOOK_COLORS = ["#2A3F8E", "#B8453A", "#D9A441", "#3E7A5C", "#E8DCC2", "#6C4A86", "#8A5A33", "#2F5F7A",
               "#C46A3A", "#4E6B3A", "#A23B4F", "#D8C29A", "#3B3B5C", "#7A8C4A", "#B07A4A", "#5A3A2A"]


def paint_book_spines():
    """15 spine designs in one row; each book's UV picks one column.
    The last column is page edges (for the tops of books)."""
    c = canvas.Canvas(1024, 256, "#000000")
    rng = random.Random(13)
    c.rect(960, 0, 1024, 256, "#F1E6CC")
    for y in range(4, 256, 7):
        c.rect(960, y, 1024, y + 1.5, "#D6C7A6")
    for k, col in enumerate(BOOK_COLORS[:15]):
        x0, x1 = k * 64, (k + 1) * 64
        c.rect(x0, 0, x1, 256, col)
        light = P.mix(col, "#FFFFFF", 0.55)
        dark = P.mix(col, "#000000", 0.35)
        style = k % 4
        if style == 0:
            for y in (22, 232):
                c.rect(x0 + 4, y, x1 - 4, y + 6, "#D9B45A")
            c.rect(x0 + 18, 60, x1 - 18, 180, light, radius=3)
        elif style == 1:
            c.rect(x0, 0, x1, 40, dark)
            c.rect(x0, 216, x1, 256, dark)
            for j in range(4):
                c.rect(x0 + 24, 70 + j * 30, x1 - 24, 84 + j * 30, light)
        elif style == 2:
            c.rect(x0 + 10, 40, x1 - 10, 110, CREAM, radius=4)
            c.rect(x0 + 22, 60, x1 - 22, 70, dark)
            c.rect(x0 + 22, 80, x1 - 22, 90, dark)
        else:
            for y in (30, 46, 210, 226):
                c.rect(x0 + 2, y, x1 - 2, y + 4, "#D9B45A")
            c.circle((x0 + x1) / 2, 128, 14, light)
        c.rect(x0, 0, x0 + 2, 256, dark)
        c.rect(x1 - 2, 0, x1, 256, dark)
        _ = rng
    c.grain(0.05, seed=14)
    return c


def paint_brochures():
    """4 x 2 atlas of pamphlet covers."""
    c = canvas.Canvas(1024, 768, "#FFFFFF")
    titles = ["海辺の町", "山あいの湯", "古い町並み", "秋のまつり", "島めぐり", "花の里", "港の朝市", "星の夜"]
    skies = [("#9FC6E6", "#F4E2C4"), ("#F2B880", "#F7E2C2"), ("#C9B7E6", "#F4E2C4"), ("#E9A27B", "#F7DDB5")]
    for k in range(8):
        col, row = k % 4, k // 4
        x0, y0 = col * 256, row * 384
        c.rect(x0 + 6, y0 + 6, x0 + 250, y0 + 378, "#FBF6EA")
        mountain_scene(c, x0 + 18, y0 + 70, x0 + 238, y0 + 300, sky=skies[k % 4], seed=k + 20)
        if k % 3 == 0:
            torii(c, x0 + 190, y0 + 270, 60, RED)
        c.rect(x0 + 18, y0 + 18, x0 + 238, y0 + 62, INDIGO if k % 2 == 0 else "#B8453A", radius=4)
        c.text(titles[k], x0 + 128, y0 + 40, 30, "#FFFFFF", weight=0.02)
        c.text("たびや", x0 + 128, y0 + 340, 30, INK, weight=0.02)
    return c


def paint_window_view():
    """Dusk town seen through the left window."""
    c = canvas.Canvas(1024, 640, "#4B3F86")
    c.vgradient(0, 640, "#3E3576", "#F2A27A")
    c.vgradient(300, 640, "#00000000", "#E88A6A55")
    rng = random.Random(15)
    c.polygon([(0, 380), (180, 300), (360, 350), (560, 280), (760, 340), (1024, 300), (1024, 640), (0, 640)], "#6A5A8E")
    for i in range(14):
        x = i * 80 + rng.uniform(-10, 10)
        top = 430 + rng.uniform(-30, 30)
        c.rect(x, top, x + 74, 640, "#3E3458")
        c.polygon([(x - 10, top), (x + 37, top - 32), (x + 84, top)], "#2E2846")
        for j in range(2):
            if rng.random() < 0.7:
                wx = x + 12 + j * 30
                c.rect(wx, top + 30, wx + 18, top + 52, "#FFC879")
                c.glow(wx + 9, top + 41, 26, "#FFB050", 0.4)
    for i in range(12):
        x = 40 + i * 85
        c.circle(x, 600, 7, "#FFD08A")
        c.glow(x, 600, 30, "#FFB050", 0.6)
    return c


def paint_backdrop():
    """Dusk sky with layered hills and far town lights, seen above the roofs."""
    c = canvas.Canvas(1024, 512, "#3E3576")
    c.vgradient(0, 512, "#3A3274", "#F0A07C")
    c.vgradient(200, 512, "#00000000", "#F6B48855")
    rng = random.Random(51)
    for _ in range(40):
        c.circle(rng.uniform(0, 1024), rng.uniform(0, 160), rng.uniform(0.8, 1.8), "#FFFFFF", rng.uniform(0.3, 0.8))
    for k, (base, col, amp) in enumerate([(330, "#8A6A9E", 60), (370, "#6E5A8C", 50), (410, "#55487A", 40)]):
        pts = [(0, 512)]
        for i in range(33):
            x = i * 32
            pts.append((x, base - amp * (0.5 + 0.5 * math.sin(i * 0.55 + k * 2.1)) - rng.uniform(0, 12)))
        pts.append((1024, 512))
        c.polygon(pts, col)
    for i in range(60):
        x, y = rng.uniform(0, 1024), rng.uniform(400, 500)
        c.circle(x, y, rng.uniform(1.2, 2.4), "#FFD08A")
        c.glow(x, y, 8, "#FFB050", 0.35)
    torii(c, 760, 300, 26, "#E0663E")
    c.glow(760, 290, 30, "#FFB050", 0.4)
    return c


def paint_window_glow():
    """Warm room glow behind shoji / lattice windows."""
    c = canvas.Canvas(256, 256, "#FFC676")
    c.vgradient(0, 256, "#FFD9A0", "#F5A250")
    for x in range(0, 256, 64):
        c.rect(x, 0, x + 4, 256, "#B5733A", alpha=0.6)
    for y in range(0, 256, 64):
        c.rect(0, y, 256, y + 4, "#B5733A", alpha=0.6)
    return c


def paint_shop_sign_tea():
    c = canvas.Canvas(256, 512, "#EADBC0")
    c.frame(6, 6, 250, 506, 8, P.WOOD_DARK, radius=6)
    c.vtext("甘味", 128, 60, 120, INK, weight=0.03)
    c.circle(128, 420, 50, RED)
    c.text("茶", 128, 420, 60, "#FFFFFF", weight=0.03)
    return c


def paint_shop_sign_inn():
    c = canvas.Canvas(256, 512, "#2E2A3A")
    c.frame(6, 6, 250, 506, 8, P.WOOD_DARK, radius=6)
    c.vtext("宿", 128, 70, 150, CREAM, weight=0.03)
    c.vtext("ひだまり", 128, 260, 52, "#F6D56A", weight=0.02)
    return c


def paint_noren_tea():
    c = canvas.Canvas(512, 256, "#9A3B32")
    c.grain(0.05, seed=52, scale=2)
    c.circle(256, 110, 62, CREAM)
    c.text("茶", 256, 110, 74, "#9A3B32", weight=0.04)
    for x in (170, 342):
        c.rect(x - 3, 0, x + 3, 256, "#7A2C25")
    return c


def paint_vertical_banner():
    c = canvas.Canvas(256, 768, "#F4E6C6")
    c.grain(0.03, seed=53)
    c.frame(8, 8, 248, 760, 10, P.WOOD_DARK, radius=8)
    c.vtext("まつり旅", 128, 60, 110, INK, weight=0.035)
    mon(c, 128, 660, 70)
    return c


def paint_rug():
    c = canvas.Canvas(1024, 768, "#7A4E6E")
    c.frame(20, 20, 1004, 748, 40, "#5A3552", radius=10)
    c.frame(70, 70, 954, 698, 8, "#E8C9A0", radius=6)
    for j in range(7):
        for i in range(9):
            x, y = 150 + i * 92, 140 + j * 82
            c.polygon([(x, y - 22), (x + 22, y), (x, y + 22), (x - 22, y)], "#9A6A8A")
            c.circle(x, y, 6, "#E8C9A0")
    c.grain(0.06, seed=16, scale=2)
    return c


def paint_scroll():
    c = canvas.Canvas(512, 256, "#F1E2C0")
    c.grain(0.05, seed=17)
    for i in range(9):
        x = 470 - i * 50
        for j in range(5):
            c.rect(x - 4, 30 + j * 40, x + 4, 58 + j * 40, INK, radius=3, alpha=0.75)
    c.circle(80, 190, 26, RED, 0.85)
    return c


def paint_lantern():
    """Chochin paper: u wraps around, v runs bottom (0) to top (1)."""
    c = canvas.Canvas(512, 256, "#FBE3B0")
    c.grain(0.03, seed=31)
    c.rect(0, 0, 512, 34, RED)
    c.rect(0, 222, 512, 256, RED)
    for x in (128, 384):
        c.circle(x, 128, 62, "#FBE3B0")
        mon(c, x, 128, 58, fg="#7A2E22", bg="#FBE3B0", ring=False)
    return c


def paint_lantern_matsuri():
    c = canvas.Canvas(512, 256, "#FBE3B0")
    c.grain(0.03, seed=32)
    c.rect(0, 0, 512, 30, INK)
    c.rect(0, 226, 512, 256, INK)
    for x in (128, 384):
        c.text("祭", x, 128, 120, RED, weight=0.04)
    return c


def paint_lantern_red():
    """Red festival chochin with cream lettering."""
    c = canvas.Canvas(512, 256, "#D8402F")
    c.grain(0.04, seed=33)
    c.rect(0, 0, 512, 30, INK)
    c.rect(0, 226, 512, 256, INK)
    c.rect(0, 30, 512, 38, GOLD_LINE)
    c.rect(0, 218, 512, 226, GOLD_LINE)
    for x in (128, 384):
        c.text("祭", x, 128, 124, "#FFF4DC", weight=0.045)
    return c



# --------------------------------------------------------------------------
# Festival decorations: kohaku cloth, fans, masks, taiko


def paint_kohaku():
    """Red-and-white striped festival cloth (stripes run along v) with an indigo hem on top."""
    c = canvas.Canvas(1024, 256, "#F7F0E2")
    n = 16
    w = 1024 / n
    for i in range(n):
        x0 = i * w
        if i % 2 == 0:
            c.rect(x0, 0, x0 + w, 256, "#D23A30")
        # A soft fold shadow at each stripe edge so it reads as hanging cloth.
        c.rect(x0, 0, x0 + w * 0.12, 256, "#000000", alpha=0.10)
        c.rect(x0 + w * 0.88, 0, x0 + w, 256, "#FFFFFF", alpha=0.08)
    c.rect(0, 0, 1024, 26, P.INDIGO_DARK)
    for i in range(16):
        c.circle(32 + i * 64, 13, 5, CREAM)
    c.grain(0.035, seed=61, scale=2)
    return c


def paint_uchiwa():
    """4 x 1 atlas of round fan faces (each cell maps onto a disc)."""
    c = canvas.Canvas(1024, 256, "#00000000", alpha=0.0)
    for k in range(4):
        cx, cy, r = k * 256 + 128, 128, 124
        if k == 0:
            c.circle(cx, cy, r, "#1F2A5C")
            firework(c, cx - 20, cy - 25, 60, "#F7C54E", seed=21)
            firework(c, cx + 45, cy + 30, 38, "#F08AA6", seed=22)
        elif k == 1:
            c.circle(cx, cy, r, "#FBF6EC")
            for j in range(3):
                c.arc(cx, cy + 40, 30 + j * 26, math.pi * 1.1, math.pi * 1.9, 4, "#8FC3E6", segs=24)
            for fx, fy, a in ((cx - 30, cy - 20, 0.4), (cx + 35, cy + 10, -0.5)):
                c.ellipse(fx, fy, 26, 14, "#E5532F", rot=a)
                c.polygon([(fx + 22 * math.cos(a), fy + 22 * math.sin(a)),
                           (fx + 44 * math.cos(a) - 12 * math.sin(a), fy + 44 * math.sin(a) + 12 * math.cos(a)),
                           (fx + 44 * math.cos(a) + 12 * math.sin(a), fy + 44 * math.sin(a) - 12 * math.cos(a))],
                          "#E5532F")
        elif k == 2:
            c.circle(cx, cy, r, "#D8402F")
            c.ring(cx, cy, r - 14, 5, "#FFF4DC")
            c.text("祭", cx, cy, 130, "#FFF4DC", weight=0.05)
        else:
            c.circle(cx, cy, r, CREAM)
            seigaiha(c, cx - r, cy, cx + r, cy + r, 30, INDIGO, CREAM)
            c.circle(cx - 20, cy - 45, 34, SUN)
        c.ring(cx, cy, r - 2, 6, P.WOOD_DARK)
        for j in range(12):
            a = math.pi * 2 * j / 12
            c.stroke([(cx, cy), (cx + math.cos(a) * (r - 4), cy + math.sin(a) * (r - 4))], 1.2, "#000000", alpha=0.08)
    return c


def paint_fox_mask():
    """2 x 1 atlas of fox masks seen from the front (white and red); the mesh outline matches props.FOX_OUTLINE."""
    c = canvas.Canvas(512, 256, "#00000000", alpha=0.0)
    for k, (face, mark) in enumerate((("#FBF6EC", "#D8402F"), ("#D8402F", "#FFF4DC"))):
        ox = k * 256

        def p(x, y, ox=ox):
            return (ox + 128 + x * 256, 128 - y * 256)

        c.polygon([p(x, y) for x, y in _FOX_POLY], face)
        for s in (-1, 1):
            c.polygon([p(s * 0.27, 0.36), p(s * 0.36, 0.44), p(s * 0.36, 0.22)], mark)
            c.polygon([p(s * 0.06, 0.08), p(s * 0.22, 0.14), p(s * 0.2, 0.06)], INK)
            c.stroke([p(s * 0.09, -0.05), p(s * 0.24, 0.0)], 5, mark)
            c.stroke([p(s * 0.08, -0.12), p(s * 0.22, -0.1)], 4, mark)
        c.polygon([p(-0.05, 0.28), p(0.05, 0.28), p(0.0, 0.18)], mark)
        c.ellipse(*p(0, -0.36), 14, 9, INK)
        c.arc(*p(0, -0.3), 30, 0.25 * math.pi, 0.75 * math.pi, 4, INK, segs=16)
    return c


# Fox mask outline in a unit square centered on 0 (x right, y up): ears up, chin down.
_FOX_POLY = [(0.0, -0.46), (0.14, -0.38), (0.26, -0.18), (0.34, 0.1), (0.4, 0.48), (0.18, 0.3), (0.0, 0.32),
             (-0.18, 0.3), (-0.4, 0.48), (-0.34, 0.1), (-0.26, -0.18), (-0.14, -0.38)]
FOX_OUTLINE = _FOX_POLY


def paint_nobori():
    """2 x 1 atlas of tall festival banners: red with cream lettering, indigo with a red sun."""
    c = canvas.Canvas(512, 768, "#D8402F")
    c.rect(256, 0, 512, 768, P.INDIGO)
    for k, (bg, fg) in enumerate((("#D8402F", "#FFF4DC"), (P.INDIGO, CREAM))):
        x0 = k * 256
        c.rect(x0, 0, x0 + 256, 768, bg)
        c.rect(x0, 0, x0 + 34, 768, fg if k == 0 else "#D8402F")
        for j in range(12):
            c.rect(x0 + 34, 30 + j * 62, x0 + 60, 44 + j * 62, fg if k == 0 else "#D8402F")
        if k == 0:
            c.vtext("まつり旅", x0 + 150, 70, 120, fg, weight=0.04)
        else:
            c.circle(x0 + 150, 150, 70, SUN)
            c.vtext("祭", x0 + 150, 300, 200, fg, weight=0.05)
            seigaiha(c, x0 + 34, 600, x0 + 256, 768, 30, CREAM, P.INDIGO)
    c.grain(0.035, seed=73, scale=2)
    return c


def paint_taiko_head():
    c = canvas.Canvas(256, 256, "#E9D9B6")
    c.glow(128, 128, 120, "#FFF6E0", 0.5)
    c.ring(128, 128, 120, 14, "#C9B48A")
    c.text("祭", 128, 132, 140, INK, weight=0.05)
    c.grain(0.05, seed=71, scale=2)
    return c


def paint_clock():
    c = canvas.Canvas(256, 256, "#00000000", alpha=0.0)
    c.circle(128, 128, 124, P.WOOD_DARK)
    c.circle(128, 128, 108, "#F7F1E3")
    for i in range(12):
        a = i * math.pi / 6
        r0 = 84 if i % 3 else 74
        c.stroke([(128 + math.sin(a) * r0, 128 - math.cos(a) * r0), (128 + math.sin(a) * 98, 128 - math.cos(a) * 98)],
                 6 if i % 3 == 0 else 3, INK)
    # The hands are separate meshes so the app can show the real time.
    return c


def paint_quest_header():
    c = canvas.Canvas(512, 128, P.WOOD_DARK)
    c.rect(8, 8, 504, 120, "#EBD3A6", radius=10)
    c.text("祭りのたより", 256, 64, 60, INK, weight=0.03)
    return c


def paint_globe():
    """Equirectangular globe: sea with stylized land blobs."""
    c = canvas.Canvas(512, 256, "#3E78B5")
    rng = random.Random(33)
    for _ in range(26):
        x, y = rng.uniform(0, 512), rng.uniform(40, 216)
        c.ellipse(x, y, rng.uniform(14, 46), rng.uniform(10, 30), "#8DBE6E", rot=rng.uniform(0, 3))
    for x in range(0, 512, 32):
        c.stroke([(x, 0), (x, 256)], 1.2, "#FFFFFF", alpha=0.25)
    for y in range(0, 256, 32):
        c.stroke([(0, y), (512, y)], 1.2, "#FFFFFF", alpha=0.25)
    return c


def paint_doormat():
    c = canvas.Canvas(512, 256, P.INDIGO_DARK)
    c.grain(0.08, seed=34, scale=2)
    c.frame(10, 10, 502, 246, 10, "#3A4C8E", radius=12)
    mon(c, 256, 128, 80, fg=P.INDIGO_DARK, bg="#C9C2B0")
    return c


def paint_picture():
    c = canvas.Canvas(512, 384, "#F4E7C9")
    mountain_scene(c, 24, 24, 488, 360, sky=("#C9B7E6", "#F7E2C2"), seed=35)
    return c


# --------------------------------------------------------------------------
# Staff


def paint_happi():
    """Happi, laid out for characters.happi():

    rows 282..512 (v 0..0.45): body tube, u 0 = back center, 0.5 = front;
    top of the band is the shoulders, bottom is the hem.
    rows 0..282 (v 0.45..1): sleeve tube, cuff at the bottom of the band.
    About 580 px per meter both ways, so circles stay round on the model.
    """
    c = canvas.Canvas(1024, 512, INDIGO)
    c.grain(0.05, seed=21, scale=2)
    # Body tube.
    checker(c, 0, 470, 1024, 512, 2, CREAM, INDIGO)
    c.rect(0, 465, 1024, 470, CREAM)
    for x in (0, 1024):
        c.circle(x, 372, 54, CREAM)
        lantern_icon(c, x, 372, 74, INDIGO, CREAM)
    open_half = 22 / 360 * 1024
    band = 10 / 360 * 1024
    for sgn in (-1, 1):
        x_in = 512 + sgn * open_half
        x_out = x_in + sgn * band
        c.rect(min(x_in, x_out), 282, max(x_in, x_out), 470, P.INDIGO_DARK)
        c.rect((x_in + x_out) / 2 - 2, 282, (x_in + x_out) / 2 + 2, 470, CREAM, alpha=0.7)
        mon(c, 512 + sgn * 0.105 * 1024, 336, 22, fg=INDIGO, bg=CREAM)
    # Sleeve tube.
    c.rect(0, 0, 1024, 282, INDIGO)
    c.grain(0.03, seed=22, scale=2)
    checker(c, 0, 230, 1024, 282, 2, CREAM, INDIGO)
    c.rect(0, 224, 1024, 230, CREAM)
    return c


# Face decal cells span longitude -40..40 and latitude -32..38 degrees of the head.
FACE_LON, FACE_LAT = 40.0, (-32.0, 38.0)
FACE_ASPECT = 0.79   # x-scale so painted circles stay round on the head


def face_px(lon, lat, cell=256):
    return ((lon + FACE_LON) / (2 * FACE_LON) * cell, (FACE_LAT[1] - lat) / (FACE_LAT[1] - FACE_LAT[0]) * cell)


EXPRESSIONS = ["normal", "blink", "happy", "surprised", "wink", "sleepy", "sparkle", "determined"]


def _eye(c, cx, cy, kind, side):
    a = FACE_ASPECT
    if kind == "blink" or (kind == "wink" and side > 0):
        c.arc(cx, cy - 10, 17, 0.22 * math.pi, 0.78 * math.pi, 6, INK)
        return
    if kind == "happy":
        c.arc(cx, cy + 12, 18, 1.15 * math.pi, 1.85 * math.pi, 7, INK)
        return
    if kind == "sleepy":
        c.arc(cx, cy - 6, 17, 0.25 * math.pi, 0.75 * math.pi, 6, INK)
        return
    ry = 30 if kind == "surprised" else 26
    rx = (23 if kind == "surprised" else 19) * a
    c.ellipse(cx, cy, rx, ry, INK)
    c.ellipse(cx, cy + ry * 0.45, rx * 0.62, ry * 0.3, "#6A4034", alpha=0.65)
    c.ellipse(cx - rx * 0.3, cy - ry * 0.38, rx * 0.36, ry * 0.3, "#FFFFFF")
    c.circle(cx + rx * 0.35, cy + ry * 0.25, rx * 0.15, "#FFFFFF", 0.85)
    if kind == "sparkle":
        for k in range(4):
            ang = k * math.pi / 2 + math.pi / 4
            c.stroke([(cx, cy), (cx + math.cos(ang) * rx * 0.7, cy + math.sin(ang) * ry * 0.7)], 2.5, "#FFFFFF",
                     alpha=0.9)
    if kind == "determined":
        c.stroke([(cx - 18, cy - 38 + side * 6), (cx + 18, cy - 38 - side * 6)], 6, INK)


def paint_faces():
    """4 x 2 atlas of face decals (eyes, cheeks) on transparency, in EXPRESSIONS order.

    The decal mesh maps onto cell 0; the app shows another expression by
    offsetting the texture (col * 0.25, -row * 0.5).
    """
    c = canvas.Canvas(1024, 512, "#000000", alpha=0.0)
    for k, kind in enumerate(EXPRESSIONS):
        ox, oy = (k % 4) * 256, (k // 4) * 256
        for side in (-1, 1):
            chx, chy = face_px(side * 31, -12)
            c.glow_ellipse(ox + chx, oy + chy, 30 * FACE_ASPECT, 21, "#F48A8A", 1.0, power=0.8)
            ex, ey = face_px(side * 20, 4)
            _eye(c, ox + ex, oy + ey, kind, side)
    return c


# Head and body textures: equirectangular, u = atan2(y, x) / 2pi, so the
# front (-Y) is u = 0.75 and the back is u = 0.25; v = 0.5 + latitude / pi.


def _lonlat_px(lon_deg, lat_deg, w=512, h=256):
    """Pixel for a direction where lon 0 is the front and +lon toward the character's left (+X)."""
    u = (0.75 + lon_deg / 360.0) % 1.0
    return u * w, (0.5 - lat_deg / 180.0) * h


def _spot(c, lon, lat, rlon, rlat, color, alpha=1.0, w=512, h=256):
    x, y = _lonlat_px(lon, lat, w, h)
    c.ellipse(x, y, rlon / 360 * w, rlat / 180 * h, color, alpha=alpha)


def _body(color, belly, scallops=None):
    c = canvas.Canvas(512, 256, color)
    c.grain(0.035, seed=41, scale=2)
    _spot(c, 0, -5, 52, 48, belly)
    if scallops:
        for row in range(5):
            lat = 22 - row * 11
            for k in range(-3, 4):
                lon = k * 12 + (row % 2) * 6
                if abs(lon) < 44 - row * 2:
                    x, y = _lonlat_px(lon, lat)
                    c.arc(x, y - 3, 8, 0.15 * math.pi, 0.85 * math.pi, 2.2, scallops, alpha=0.7)
    return c


def _head(color, face=None, kind=None):
    c = canvas.Canvas(512, 256, color)
    c.grain(0.03, seed=42, scale=2)
    if kind == "owl":
        # Heart-shaped facial disc.
        for side in (-1, 1):
            _spot(c, side * 20, 6, 30, 34, face)
        _spot(c, 0, -14, 34, 26, face)
        x, y = _lonlat_px(0, 30)
        c.polygon([(x - 18, y - 6), (x, y + 22), (x + 18, y - 6)], color)
    elif kind == "penguin":
        for side in (-1, 1):
            _spot(c, side * 22, 2, 26, 30, face)
        _spot(c, 0, -20, 42, 28, face)
        x, y = _lonlat_px(0, 18)
        c.polygon([(x - 14, y - 10), (x, y + 18), (x + 14, y - 10)], color)
    elif face:
        _spot(c, 0, -6, 46, 36, face, alpha=0.5)
    return c


def paint_shadow():
    """Soft contact shadow under a character (black with radial alpha)."""
    c = canvas.Canvas(128, 128, "#000000", alpha=0.0)
    c.glow(64, 64, 62, "#000000", 0.55)
    return c


def paint_body_hiyoko():
    return _body(P.CHICK, P.CHICK_BELLY)


def paint_body_owl():
    return _body(P.OWL, P.OWL_FACE, scallops=P.mix(P.OWL, P.OWL_FACE, 0.45))


def paint_body_hen():
    return _body(P.HEN, "#FFFBF2")


def paint_head_hiyoko():
    return _head(P.CHICK, P.mix(P.CHICK, "#FFFFFF", 0.25))


def paint_head_owl():
    return _head(P.OWL, P.OWL_FACE, "owl")


def paint_head_hen():
    return _head(P.HEN, "#FFFFFF")


def paint_head_penguin():
    return _head(P.PENGUIN, P.PENGUIN_BELLY, "penguin")


def paint_body_sparrow():
    c = _body(P.SPARROW, P.SPARROW_BELLY)
    # Darker streaks on the back.
    for k in range(9):
        x, y = _lonlat_px(180 + (k - 4) * 14, 10 - (k % 3) * 12)
        c.ellipse(x, y, 10, 4, P.SPARROW_DARK, rot=0.4, alpha=0.6)
    return c


def paint_head_sparrow():
    c = canvas.Canvas(512, 256, P.SPARROW)
    c.grain(0.03, seed=43, scale=2)
    # Cream face below a brown crown, with the sparrow's dark cheek spots.
    _spot(c, 0, -14, 70, 34, P.SPARROW_BELLY)
    for side in (-1, 1):
        _spot(c, side * 46, -6, 36, 30, P.SPARROW_BELLY)
        _spot(c, side * 50, -12, 6.5, 7.5, P.SPARROW_DARK)
    x, y = _lonlat_px(0, 30)
    c.polygon([(x - 26, y - 4), (x, y + 18), (x + 26, y - 4)], P.SPARROW)
    return c


def paint_body_penguin():
    """Traveler penguin: dark back, cream vest front with three buttons."""
    c = _body(P.PENGUIN, P.PENGUIN_BELLY)
    for lat in (12, -2, -16):
        x, y = _lonlat_px(0, lat)
        c.circle(x, y, 5, "#C9A46A")
        c.circle(x - 1, y - 1, 2, "#E8CF9C")
    return c


def paint_scarf():
    """Knitted indigo scarf: ribs along u, a cream stripe and fringe band."""
    c = canvas.Canvas(256, 256, P.INDIGO)
    for x in range(0, 256, 8):
        c.rect(x, 0, x + 3, 256, P.INDIGO_DARK, alpha=0.55)
    for y in (40, 200):
        c.rect(0, y, 256, y + 10, P.CREAM, alpha=0.9)
    c.grain(0.06, seed=61, scale=2)
    return c


def paint_straw():
    c = canvas.Canvas(256, 256, "#D9B77A")
    for i in range(0, 256, 6):
        c.rect(0, i, 256, i + 2, "#C29A5C", alpha=0.5)
        c.rect(i, 0, i + 1.5, 256, "#E8CB92", alpha=0.35)
    c.grain(0.05, seed=62)
    return c


def paint_backpack():
    c = canvas.Canvas(256, 256, "#8A5530")
    c.grain(0.06, seed=63, scale=2)
    c.frame(10, 10, 246, 246, 6, "#6A3E22", radius=18)
    for x in range(20, 240, 12):
        c.rect(x, 12, x + 4, 16, "#C9A46A", alpha=0.7)
    mon(c, 128, 140, 56, fg="#8A5530", bg="#E8CF9C")
    return c


def paint_cat():
    """Calico cat body: white with orange and black patches (equirectangular)."""
    c = canvas.Canvas(512, 256, "#F7F1E6")
    rng = random.Random(64)
    for col, n in (("#E39A4F", 6), ("#3A302C", 4)):
        for _ in range(n):
            lon = rng.uniform(60, 300)
            lat = rng.uniform(-10, 60)
            _spot(c, lon, lat, rng.uniform(20, 40), rng.uniform(14, 26), col)
    c.grain(0.04, seed=65, scale=2)
    return c


def paint_cat_head():
    c = canvas.Canvas(512, 256, "#F7F1E6")
    _spot(c, 70, 40, 50, 40, "#E39A4F")
    _spot(c, -60, 46, 40, 30, "#3A302C")
    # Sleeping face: closed eyes, pink nose, small mouth.
    for side in (-1, 1):
        x, y = _lonlat_px(side * 22, 6)
        c.arc(x, y - 6, 9, 0.2 * math.pi, 0.8 * math.pi, 2.5, INK)
        cx, cy = _lonlat_px(side * 32, -8)
        c.glow_ellipse(cx, cy, 10, 6, "#F4A0A0", 0.8)
    x, y = _lonlat_px(0, -4)
    c.polygon([(x - 5, y - 3), (x + 5, y - 3), (x, y + 3)], "#E8838A")
    c.arc(x - 4, y + 4, 4, 0, math.pi, 1.5, INK)
    c.arc(x + 4, y + 4, 4, 0, math.pi, 1.5, INK)
    return c


def paint_staff_only():
    c = canvas.Canvas(512, 192, "#F4E6C6")
    c.grain(0.03, seed=66)
    c.frame(8, 8, 504, 184, 10, P.WOOD_DARK, radius=12)
    c.text("従業員専用", 256, 80, 70, RED, weight=0.035)
    c.text("STAFF ONLY", 256, 148, 30, INK, weight=0.02)
    return c


def paint_stamp_sign():
    c = canvas.Canvas(256, 512, "#F4E6C6")
    c.grain(0.03, seed=67)
    c.frame(8, 8, 248, 504, 8, P.WOOD_DARK, radius=10)
    c.vtext("記念スタンプ", 128, 40, 58, INK, weight=0.03)
    c.circle(128, 440, 44, RED, 0.9)
    mon(c, 128, 440, 36, fg=RED, bg="#F4E6C6")
    return c


def paint_stamp_mark():
    """The shop's commemorative stamp as it appears on paper (red on transparency)."""
    c = canvas.Canvas(256, 256, "#000000", alpha=0.0)
    c.ring(128, 128, 112, 10, RED)
    mon(c, 128, 108, 66, fg=RED, bg="#00000000")
    c.text("たびや", 128, 200, 34, RED, weight=0.03)
    return c


def paint_omikuji():
    c = canvas.Canvas(512, 256, "#C8473C")
    c.grain(0.04, seed=68, scale=2)
    for x in (64, 192, 320, 448):
        c.rect(x - 34, 30, x + 34, 226, "#F4E6C6", radius=6)
        c.vtext("おみくじ", x, 44, 40, RED, weight=0.03)
    return c


def paint_gachapon():
    c = canvas.Canvas(256, 256, "#F6D56A")
    c.rect(0, 0, 256, 70, P.INDIGO)
    c.text("たびやガチャ", 128, 36, 30, CREAM, weight=0.02)
    for i, col in enumerate(("#E8574F", "#4E86B8", "#6FA35A", "#F2A33A")):
        x = 48 + i * 54
        c.circle(x, 150, 22, col)
        c.rect(x - 22, 150, x + 22, 152, "#FFFFFF")
        c.circle(x - 7, 141, 5, "#FFFFFF", 0.7)
    c.text("1回 100円", 128, 222, 26, INK, weight=0.02)
    return c


def paint_omiyage():
    """2 x 2 atlas of souvenir box wrappers."""
    c = canvas.Canvas(512, 512, "#FFFFFF")
    designs = [("#C8473C", "#F4E6C6", "まんじゅう"), ("#2A3F8E", "#F6D56A", "せんべい"),
               ("#3E7A5C", "#F4E6C6", "ようかん"), ("#E9A6C4", "#FFFFFF", "さくら餅")]
    for k, (bg, fg, name) in enumerate(designs):
        x0, y0 = (k % 2) * 256, (k // 2) * 256
        c.rect(x0, y0, x0 + 256, y0 + 256, bg)
        seigaiha(c, x0, y0, x0 + 256, y0 + 256, 24, P.mix(bg, "#FFFFFF", 0.25), bg, 2.5)
        c.rect(x0 + 40, y0 + 70, x0 + 216, y0 + 186, fg, radius=10)
        c.text(name, x0 + 128, y0 + 128, 36, bg, weight=0.03)
    return c


def paint_daruma():
    """Red roly-poly doll, face toward the front (u = 0.75)."""
    c = canvas.Canvas(512, 256, "#D23B30")
    c.grain(0.03, seed=69)
    x, y = _lonlat_px(0, 18)
    c.ellipse(x, y, 52, 46, "#F7EBDD")
    for side in (-1, 1):
        c.circle(x + side * 20, y - 2, 13, "#FFFFFF")
        c.ring(x + side * 20, y - 2, 13, 2.5, INK)
        if side < 0:
            c.circle(x + side * 20, y - 2, 7, INK)
        c.arc(x + side * 22, y - 22, 14, 1.2 * math.pi, 1.8 * math.pi, 4, INK)
    c.arc(x, y + 10, 12, 0.15 * math.pi, 0.85 * math.pi, 3, INK)
    x2, y2 = _lonlat_px(0, -30)
    c.text("福", x2, y2, 40, "#F6D56A", weight=0.03)
    return c


def paint_golden_ticket():
    c = canvas.Canvas(256, 128, "#E8C04A")
    c.vgradient(0, 128, "#F6DA7A", "#C99A2E")
    c.frame(6, 6, 250, 122, 4, "#8A6420", radius=6)
    c.text("金の切符", 128, 50, 34, "#6A4A14", weight=0.03)
    c.text("たびや ゆき", 128, 96, 20, "#6A4A14", weight=0.02)
    return c


def paint_polaroids():
    """2 x 2 atlas of small travel snapshots with white borders."""
    c = canvas.Canvas(512, 512, "#FFFFFF")
    skies = [("#9FC6E6", "#F4E2C4"), ("#F2B880", "#F7E2C2"), ("#C9B7E6", "#F4E2C4"), ("#E9A27B", "#F7DDB5")]
    for k in range(4):
        x0, y0 = (k % 2) * 256, (k // 2) * 256
        c.rect(x0 + 6, y0 + 6, x0 + 250, y0 + 250, "#FBF8F0")
        mountain_scene(c, x0 + 20, y0 + 20, x0 + 236, y0 + 200, sky=skies[k], seed=80 + k)
        if k == 1:
            firework(c, x0 + 128, y0 + 80, 50, "#F7C54E", seed=k)
        if k == 3:
            for i in range(5):
                lantern_icon(c, x0 + 50 + i * 38, y0 + 70, 34, "#F2A33A", "#C8473C")
    return c


# --------------------------------------------------------------------------
# Festival street: stall signs, lantern paper, boards, the guide's flag

# The six stalls of the street, and the order of their cells in the atlases below.
STALL_ROLES = ("access", "lodging", "etiquette", "food", "weather", "headquarters")
STALL_LOOK = {
    "access": ("#2F7F7A", "行き方"),
    "lodging": (P.INDIGO, "宿"),
    "etiquette": ("#C8392B", "作法"),
    "food": ("#DE6F24", "食べ物"),
    "weather": ("#2E86C8", "天気"),
    "headquarters": ("#3C4256", "本部"),
}


def stall_icon(c, role, cx, cy, r, fg, bg):
    """The stall's pictogram, drawn without letters so it reads in any language."""
    if role == "access":         # a train coming down the rails
        c.rect(cx - 0.62 * r, cy - 0.85 * r, cx + 0.62 * r, cy + 0.5 * r, fg, radius=0.22 * r)
        c.rect(cx - 0.46 * r, cy - 0.66 * r, cx + 0.46 * r, cy - 0.1 * r, bg, radius=0.07 * r)
        for s in (-1, 1):
            c.circle(cx + s * 0.34 * r, cy + 0.22 * r, 0.1 * r, bg)
            c.stroke([(cx + s * 0.34 * r, cy + 0.5 * r), (cx + s * 0.62 * r, cy + 0.95 * r)], 0.1 * r, fg)
        c.rect(cx - 0.5 * r, cy + 0.68 * r, cx + 0.5 * r, cy + 0.76 * r, fg)
    elif role == "lodging":     # a futon and pillow under the moon
        c.circle(cx + 0.42 * r, cy - 0.52 * r, 0.36 * r, fg)
        c.circle(cx + 0.56 * r, cy - 0.62 * r, 0.31 * r, bg)
        c.rect(cx - 0.92 * r, cy + 0.12 * r, cx + 0.92 * r, cy + 0.62 * r, fg, radius=0.18 * r)
        c.rect(cx - 0.8 * r, cy - 0.16 * r, cx - 0.18 * r, cy + 0.2 * r, fg, radius=0.14 * r)
        c.rect(cx - 0.92 * r, cy + 0.7 * r, cx + 0.92 * r, cy + 0.82 * r, fg, radius=0.04 * r)
    elif role == "etiquette":   # a torii gate
        torii(c, cx, cy + 0.85 * r, 1.6 * r, fg)
    elif role == "food":        # a steaming bowl
        c.polygon([(cx - 0.9 * r, cy), (cx + 0.9 * r, cy), (cx + 0.5 * r, cy + 0.72 * r), (cx - 0.5 * r, cy + 0.72 * r)], fg)
        c.rect(cx - 0.3 * r, cy + 0.72 * r, cx + 0.3 * r, cy + 0.85 * r, fg)
        for k in (-1, 0, 1):
            x = cx + k * 0.38 * r
            c.stroke([(x, cy - 0.12 * r), (x + 0.1 * r, cy - 0.38 * r), (x - 0.06 * r, cy - 0.62 * r),
                      (x + 0.06 * r, cy - 0.86 * r)], 0.09 * r, fg)
    elif role == "weather":     # a sun behind a cloud
        sx, sy = cx - 0.28 * r, cy - 0.3 * r
        c.circle(sx, sy, 0.36 * r, fg)
        for i in range(8):
            a = 2 * math.pi * i / 8
            c.stroke([(sx + math.cos(a) * 0.48 * r, sy + math.sin(a) * 0.48 * r),
                      (sx + math.cos(a) * 0.68 * r, sy + math.sin(a) * 0.68 * r)], 0.09 * r, fg)
        puffs = ((-0.14, 0.34, 0.3), (0.26, 0.14, 0.4), (0.66, 0.38, 0.28))
        for grow, color in ((0.08, bg), (0.0, fg)):
            for dx, dy, rr in puffs:
                c.circle(cx + dx * r, cy + dy * r, (rr + grow) * r, color)
            c.rect(cx - (0.14 + grow) * r, cy + 0.34 * r, cx + (0.66 + grow) * r, cy + (0.66 + grow) * r, color)
    else:                       # headquarters: a megaphone
        c.polygon([(cx - 0.35 * r, cy - 0.22 * r), (cx + 0.5 * r, cy - 0.72 * r), (cx + 0.5 * r, cy + 0.62 * r),
                   (cx - 0.35 * r, cy + 0.18 * r)], fg)
        c.rect(cx - 0.76 * r, cy - 0.24 * r, cx - 0.3 * r, cy + 0.2 * r, fg, radius=0.08 * r)
        c.stroke([(cx - 0.22 * r, cy + 0.2 * r), (cx - 0.32 * r, cy + 0.74 * r)], 0.18 * r, fg)
        for k in range(2):
            c.arc(cx + 0.5 * r, cy - 0.05 * r, (0.22 + 0.2 * k) * r, -0.7, 0.7, 0.07 * r, fg)


def paint_stall_signs():
    """3 x 2 atlas of the stalls' signboards: pictogram over the stall's word."""
    c = canvas.Canvas(768, 512, PAPER)
    for k, role in enumerate(STALL_ROLES):
        x0, y0 = (k % 3) * 256, (k // 3) * 256
        col, label = STALL_LOOK[role]
        c.rect(x0, y0, x0 + 256, y0 + 256, col)
        c.frame(x0 + 14, y0 + 14, x0 + 242, y0 + 242, 6, CREAM, radius=14)
        stall_icon(c, role, x0 + 128, y0 + 100, 62, CREAM, col)
        c.text(label, x0 + 128, y0 + 202, {1: 58, 2: 50, 3: 44}[len(label)], CREAM, weight=0.05)
    c.grain(0.02, seed=91, scale=2)
    return c


LANTERN_ROW = 144


def paint_lantern_roles():
    """Lantern paper, one row per stall (top row first). u wraps around, the pictogram sits front and back."""
    w, row = 384, LANTERN_ROW
    paper = "#FBE3B0"
    c = canvas.Canvas(w, row * len(STALL_ROLES), paper)
    c.grain(0.03, seed=92)
    for k, role in enumerate(STALL_ROLES):
        y0 = k * row
        col = STALL_LOOK[role][0]
        c.rect(0, y0, w, y0 + 16, col)
        c.rect(0, y0 + row - 16, w, y0 + row, col)
        for j in range(1, 6):
            y = y0 + j * row / 6
            c.rect(0, y - 0.6, w, y + 0.6, "#B98A57", alpha=0.4)
        for x in (w / 4, 3 * w / 4):
            stall_icon(c, role, x, y0 + row / 2, 40, col, paper)
    return c


def paint_lantern_glow():
    """Soft warm glow with radial alpha: the light a lit lantern throws around itself."""
    c = canvas.Canvas(256, 256, "#FFB45A", alpha=0.0)
    c.glow(128, 128, 124, "#FFB45A", 0.6)
    return c


def paint_noren_lodging():
    c = canvas.Canvas(768, 384, P.INDIGO)
    c.grain(0.03, seed=93)
    c.rect(0, 0, 768, 22, P.INDIGO_DARK)
    c.text("宿", 384, 196, 190, CREAM, weight=0.04)
    for x in (128, 640):
        c.circle(x, 186, 62, CREAM)
        c.circle(x + 22, 170, 56, P.INDIGO)
    return c


def paint_noren_food():
    c = canvas.Canvas(768, 256, "#C8392B")
    c.grain(0.03, seed=94)
    c.rect(0, 0, 768, 18, INK)
    c.text("食", 384, 132, 150, CREAM, weight=0.04)
    for x in (128, 640):
        stall_icon(c, "food", x, 132, 62, CREAM, "#C8392B")
    return c


def paint_station_board():
    """Station name board of a fictional stop."""
    c = canvas.Canvas(512, 192, "#F7F4EA")
    c.rect(0, 110, 512, 142, "#2F7F7A")
    c.text("まつりまえ", 256, 62, 62, INK, weight=0.03)
    c.polygon([(452, 126), (424, 100), (424, 152)], "#F7F4EA")
    c.text("まつりの町", 40, 170, 22, INK, anchor="lm")
    c.text("宿場", 472, 170, 22, INK, anchor="rm")
    return c


def paint_etiquette_board():
    """Wooden board with three pictograms: bow, rinse the hands, take off the shoes."""
    c = canvas.Canvas(512, 256, "#C9A36A")
    c.grain(0.05, seed=95, scale=2)
    c.frame(8, 8, 504, 248, 8, P.WOOD_DARK, radius=6)
    for k in (1, 2):
        c.rect(k * 512 / 3 - 2, 16, k * 512 / 3 + 2, 240, P.WOOD_DARK)
    # Bow: a person bending from the hips.
    c.circle(58, 92, 20, INK)
    c.stroke([(72, 110), (114, 134), (114, 208)], 16, INK)
    c.stroke([(84, 118), (70, 160)], 11, INK)
    # Rinse: a ladle over a basin.
    c.rect(200, 168, 312, 208, INK, radius=8)
    c.stroke([(214, 90), (286, 120)], 9, INK)
    c.rect(282, 112, 318, 142, INK, radius=4)
    for x in (292, 306):
        c.stroke([(x, 150), (x - 2, 164)], 5, INK)
    # Shoes side by side.
    for x in (388, 438):
        c.rect(x - 16, 100, x + 16, 200, INK, radius=15)
        c.rect(x - 8, 118, x + 8, 158, "#C9A36A", radius=7)
    return c


def paint_weather_board():
    """Forecast board: sun, cloud and umbrella over a row of little bars."""
    c = canvas.Canvas(384, 512, "#F4F0E4")
    c.frame(8, 8, 376, 504, 8, "#2E86C8", radius=8)
    c.circle(108, 104, 46, "#F2A33A")
    for i in range(8):
        a = 2 * math.pi * i / 8
        c.stroke([(108 + math.cos(a) * 58, 104 + math.sin(a) * 58), (108 + math.cos(a) * 76, 104 + math.sin(a) * 76)],
                 8, "#F2A33A")
    for dx, dy, rr in ((238, 112, 28), (272, 88, 36), (310, 114, 26)):
        c.circle(dx, dy, rr, "#7F8FA6")
    c.rect(238, 104, 310, 140, "#7F8FA6")
    c.arc(108, 288, 62, math.pi, 2 * math.pi, 62, "#2E86C8")
    c.stroke([(108, 288), (108, 360)], 8, INK)
    for x in (238, 272, 306):
        c.stroke([(x, 240), (x - 12, 290)], 8, "#2E86C8")
        c.stroke([(x + 4, 310), (x - 8, 356)], 8, "#2E86C8")
    for k, h in enumerate((70, 40, 90, 54, 30)):
        x = 60 + k * 58
        c.rect(x, 480 - h, x + 36, 480, "#2E86C8" if k % 2 else "#F2A33A", radius=3)
    return c


def paint_wagasa():
    """Big-parasol paper with the classic ring. u wraps around, the top row is the crown."""
    c = canvas.Canvas(1024, 256, "#2466A8")
    c.rect(0, 92, 1024, 150, "#F4EEDF")
    c.rect(0, 0, 1024, 26, INK)
    c.rect(0, 238, 1024, 256, "#163F6E")
    for i in range(32):
        x = i * 32
        c.rect(x - 1.2, 0, x + 1.2, 256, "#000000", alpha=0.25)
    c.grain(0.03, seed=96, scale=2)
    return c


def paint_crest():
    """The shop's crest on a cream disc, for the guide's cap."""
    c = canvas.Canvas(128, 128, CREAM)
    mon(c, 64, 64, 60, fg=INDIGO, bg=CREAM)
    return c


def paint_guide_flag():
    """The guide's flag: vermilion with the shop's crest and a golden stripe along the pole."""
    c = canvas.Canvas(512, 320, "#D2402E")
    c.rect(0, 0, 36, 320, "#F2C04E")
    c.rect(36, 0, 44, 320, CREAM)
    c.rect(44, 0, 512, 12, CREAM)
    c.rect(44, 308, 512, 320, CREAM)
    mon(c, 210, 160, 104, fg=INDIGO, bg=CREAM)
    c.grain(0.03, seed=97, scale=2)
    return c


def paint_ennichi_backdrop():
    """Dusk seen past the far end of the street: hills, far town lights and fireworks. One pixel is 1/16 m."""
    c = canvas.Canvas(1024, 256, "#3E3576")
    c.vgradient(0, 240, "#3E3576", "#F2A67E")
    c.vgradient(120, 256, "#00000000", "#F6B48866")
    rng = random.Random(53)
    for _ in range(50):
        c.circle(rng.uniform(0, 1024), rng.uniform(0, 110), rng.uniform(0.6, 1.5), "#FFFFFF", rng.uniform(0.3, 0.8))
    firework(c, 372, 176, 38, "#F7C54E", rays=22, seed=5)
    firework(c, 546, 158, 30, "#F58A8A", rays=18, seed=6)
    firework(c, 660, 184, 24, "#9FD8F0", rays=16, seed=7)
    for k, (base, col, amp) in enumerate([(206, "#8A6A9E", 22), (222, "#6E5A8C", 18), (236, "#55487A", 14)]):
        pts = [(0, 256)]
        for i in range(33):
            pts.append((i * 32, base - amp * (0.5 + 0.5 * math.sin(i * 0.55 + k * 2.1)) - rng.uniform(0, 5)))
        pts.append((1024, 256))
        c.polygon(pts, col)
    for _ in range(50):
        x, y = rng.uniform(0, 1024), rng.uniform(236, 254)
        c.circle(x, y, rng.uniform(0.8, 1.6), "#FFD08A")
    return c


def paint_far_ground():
    """Ground beyond the lit part of the street, fading out at dusk."""
    return canvas.Canvas(16, 16, "#6B5563")


def export_all(folder, sheet_cell=300, cols=5):
    """Save every texture plus a labeled-free contact sheet (_sheet.png)."""
    import os
    import numpy as np
    names = [n[6:] for n in globals() if n.startswith("paint_")]
    rows = (len(names) + cols - 1) // cols
    sheet = canvas.Canvas(cols * sheet_cell, rows * sheet_cell, "#808080")
    for k, name in enumerate(names):
        cv = globals()[f"paint_{name}"]()
        cv.save(os.path.join(folder, f"{name}.png"))
        scale = (sheet_cell - 12) / max(cv.w, cv.h)
        w, h = max(1, int(cv.w * scale)), max(1, int(cv.h * scale))
        ys = (np.arange(h) / scale).astype(int)
        xs = (np.arange(w) / scale).astype(int)
        small = cv.px[ys][:, xs]
        x0, y0 = (k % cols) * sheet_cell + 6, (k // cols) * sheet_cell + 6
        a = small[..., 3:4]
        dst = sheet.px[y0:y0 + h, x0:x0 + w]
        dst[..., :3] = small[..., :3] * a + dst[..., :3] * (1 - a)
    sheet.save(os.path.join(folder, "_sheet.png"))
