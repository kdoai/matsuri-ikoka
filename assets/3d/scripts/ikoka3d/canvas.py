"""A small anti-aliased 2D drawing canvas (numpy) for every painted texture.

Signs, posters, the map, the timetable, book spines, happi crests and the
staff's faces are all drawn here from shapes and text, so no image comes
from outside the build. Coordinates are pixels with the origin at the top
left; colors are sRGB hex strings (optionally with alpha 0..1).
Text glyphs come from Blender's bundled Noto Sans CJK font (SIL OFL).
"""

import math
import os

import bpy
import numpy as np

FONT_PATH = os.path.join(os.path.dirname(bpy.app.binary_path), f"{bpy.app.version[0]}.{bpy.app.version[1]}",
                         "datafiles", "fonts", "Noto Sans CJK Regular.woff2")

_font = None
_glyph_cache = {}


def rgba(color, alpha=1.0):
    if isinstance(color, (tuple, list)):
        return np.array(color if len(color) == 4 else (*color, alpha), dtype=np.float32)
    h = color.lstrip("#")
    if len(h) == 8:
        alpha *= int(h[6:8], 16) / 255.0
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)] + [alpha], dtype=np.float32)


def _smooth(d, feather):
    """Coverage from signed distance (negative inside)."""
    return np.clip(0.5 - d / max(feather, 1e-3), 0.0, 1.0)


class Canvas:
    def __init__(self, w, h, bg="#FFFFFF", alpha=1.0):
        self.w, self.h = w, h
        self.px = np.zeros((h, w, 4), dtype=np.float32)
        self.px[:] = rgba(bg, alpha)

    # -- core ---------------------------------------------------------------

    def _grid(self, x0, y0, x1, y1):
        x0, y0 = max(0, int(math.floor(x0)) - 2), max(0, int(math.floor(y0)) - 2)
        x1, y1 = min(self.w, int(math.ceil(x1)) + 2), min(self.h, int(math.ceil(y1)) + 2)
        if x1 <= x0 or y1 <= y0:
            return None
        ys, xs = np.mgrid[y0:y1, x0:x1].astype(np.float32)
        return (slice(y0, y1), slice(x0, x1)), xs + 0.5, ys + 0.5

    def blend(self, sl, cover, color, alpha=1.0):
        c = rgba(color) if isinstance(color, str) else np.asarray(color, dtype=np.float32)
        a = (cover * c[3] * alpha)[..., None]
        dst = self.px[sl]
        out_a = a + dst[..., 3:4] * (1 - a)
        rgb = (c[:3] * a + dst[..., :3] * dst[..., 3:4] * (1 - a)) / np.maximum(out_a, 1e-6)
        dst[..., :3] = rgb
        dst[..., 3:4] = out_a

    def sdf(self, bbox, fn, color, feather=1.0, alpha=1.0):
        g = self._grid(*bbox)
        if g is None:
            return
        sl, xs, ys = g
        self.blend(sl, _smooth(fn(xs, ys), feather), color, alpha)

    # -- shapes -------------------------------------------------------------

    def fill(self, color, alpha=1.0):
        self.blend((slice(0, self.h), slice(0, self.w)), np.ones((self.h, self.w), np.float32), color, alpha)

    def rect(self, x0, y0, x1, y1, color, radius=0.0, alpha=1.0, feather=1.0):
        cx, cy, hx, hy = (x0 + x1) / 2, (y0 + y1) / 2, abs(x1 - x0) / 2, abs(y1 - y0) / 2
        r = min(radius, hx, hy)

        def f(xs, ys):
            qx = np.abs(xs - cx) - (hx - r)
            qy = np.abs(ys - cy) - (hy - r)
            return np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r
        self.sdf((x0, y0, x1, y1), f, color, feather, alpha)

    def frame(self, x0, y0, x1, y1, width, color, radius=0.0, alpha=1.0):
        cx, cy, hx, hy = (x0 + x1) / 2, (y0 + y1) / 2, abs(x1 - x0) / 2, abs(y1 - y0) / 2
        r = min(radius, hx, hy)

        def f(xs, ys):
            qx = np.abs(xs - cx) - (hx - r)
            qy = np.abs(ys - cy) - (hy - r)
            d = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r
            return np.abs(d + width / 2) - width / 2
        self.sdf((x0, y0, x1, y1), f, color, 1.0, alpha)

    def ellipse(self, cx, cy, rx, ry, color, rot=0.0, alpha=1.0, feather=1.0):
        c, s = math.cos(rot), math.sin(rot)
        m = max(rx, ry)

        def f(xs, ys):
            dx, dy = xs - cx, ys - cy
            u, v = dx * c + dy * s, -dx * s + dy * c
            k = np.hypot(u / rx, v / ry)
            return (k - 1) * min(rx, ry)
        self.sdf((cx - m, cy - m, cx + m, cy + m), f, color, feather, alpha)

    def circle(self, cx, cy, r, color, alpha=1.0, feather=1.0):
        self.sdf((cx - r, cy - r, cx + r, cy + r), lambda xs, ys: np.hypot(xs - cx, ys - cy) - r, color, feather, alpha)

    def ring(self, cx, cy, r, width, color, alpha=1.0):
        self.sdf((cx - r - width, cy - r - width, cx + r + width, cy + r + width),
                 lambda xs, ys: np.abs(np.hypot(xs - cx, ys - cy) - r) - width / 2, color, 1.0, alpha)

    def glow(self, cx, cy, r, color, alpha=1.0):
        """Soft radial falloff (blush, light spots)."""
        g = self._grid(cx - r, cy - r, cx + r, cy + r)
        if g is None:
            return
        sl, xs, ys = g
        d = np.hypot(xs - cx, ys - cy) / r
        self.blend(sl, np.clip(1 - d, 0, 1) ** 1.6, color, alpha)

    def glow_ellipse(self, cx, cy, rx, ry, color, alpha=1.0, power=1.6):
        g = self._grid(cx - rx, cy - ry, cx + rx, cy + ry)
        if g is None:
            return
        sl, xs, ys = g
        d = np.hypot((xs - cx) / rx, (ys - cy) / ry)
        self.blend(sl, np.clip(1 - d, 0, 1) ** power, color, alpha)

    def polygon(self, pts, color, alpha=1.0, feather=1.0):
        pts = np.asarray(pts, dtype=np.float32)
        x0, y0 = pts.min(axis=0)
        x1, y1 = pts.max(axis=0)
        a = pts
        b = np.roll(pts, -1, axis=0)

        def f(xs, ys):
            d2 = np.full(xs.shape, np.inf, np.float32)
            inside = np.zeros(xs.shape, bool)
            for (ax, ay), (bx, by) in zip(a, b):
                ex, ey = bx - ax, by - ay
                wx, wy = xs - ax, ys - ay
                t = np.clip((wx * ex + wy * ey) / max(ex * ex + ey * ey, 1e-9), 0, 1)
                d2 = np.minimum(d2, (wx - ex * t) ** 2 + (wy - ey * t) ** 2)
                cond = (ay > ys) != (by > ys)
                xint = ax + (ys - ay) * ex / np.where(ey == 0, 1e-9, ey)
                inside ^= cond & (xs < xint)
            d = np.sqrt(d2)
            return np.where(inside, -d, d)
        self.sdf((x0, y0, x1, y1), f, color, feather, alpha)

    def stroke(self, pts, width, color, closed=False, alpha=1.0):
        pts = np.asarray(pts, dtype=np.float32)
        if closed:
            pts = np.vstack([pts, pts[:1]])
        x0, y0 = pts.min(axis=0) - width
        x1, y1 = pts.max(axis=0) + width

        def f(xs, ys):
            d2 = np.full(xs.shape, np.inf, np.float32)
            for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
                ex, ey = bx - ax, by - ay
                wx, wy = xs - ax, ys - ay
                t = np.clip((wx * ex + wy * ey) / max(ex * ex + ey * ey, 1e-9), 0, 1)
                d2 = np.minimum(d2, (wx - ex * t) ** 2 + (wy - ey * t) ** 2)
            return np.sqrt(d2) - width / 2
        self.sdf((x0, y0, x1, y1), f, color, 1.0, alpha)

    def arc(self, cx, cy, r, a0, a1, width, color, alpha=1.0, segs=48):
        pts = [(cx + r * math.cos(a0 + (a1 - a0) * i / segs), cy + r * math.sin(a0 + (a1 - a0) * i / segs))
               for i in range(segs + 1)]
        self.stroke(pts, width, color, alpha=alpha)

    def wave(self, x0, x1, y, amp, period, width, color, phase=0.0, alpha=1.0):
        n = max(8, int((x1 - x0) / 3))
        pts = [(x0 + (x1 - x0) * i / n, y + amp * math.sin(phase + 2 * math.pi * (x0 + (x1 - x0) * i / n) / period))
               for i in range(n + 1)]
        self.stroke(pts, width, color, alpha=alpha)

    def vgradient(self, y0, y1, top, bottom, x0=0, x1=None):
        x1 = self.w if x1 is None else x1
        g = self._grid(x0, y0, x1, y1)
        if g is None:
            return
        sl, xs, ys = g
        t = np.clip((ys - y0) / max(y1 - y0, 1), 0, 1)[..., None]
        ct, cb = rgba(top), rgba(bottom)
        col = ct * (1 - t) + cb * t
        dst = self.px[sl]
        a = col[..., 3:4]
        dst[..., :3] = col[..., :3] * a + dst[..., :3] * (1 - a)
        dst[..., 3:4] = a + dst[..., 3:4] * (1 - a)

    def grain(self, amount=0.04, seed=0, scale=1):
        """Paper / fabric speckle."""
        rng = np.random.default_rng(seed)
        n = rng.standard_normal((self.h // scale + 1, self.w // scale + 1)).astype(np.float32)
        n = np.repeat(np.repeat(n, scale, 0), scale, 1)[:self.h, :self.w]
        self.px[..., :3] = np.clip(self.px[..., :3] * (1 + amount * n[..., None]), 0, 1)

    # -- text ---------------------------------------------------------------

    def text(self, s, x, y, size, color, anchor="mm", weight=0.0, alpha=1.0, spacing=1.0, rot=0.0):
        """Draw a line of text. `size` is the height in pixels of a full
        kanji (the ink box of 国).

        `anchor` is two letters: horizontal l/m/r and vertical t/m/b (of the
        glyph ink box). `weight` thickens strokes, as a fraction of `size`
        (0.02 is a bold sign face).
        """
        ref = _ref_height()
        tris, (bx0, by0, bx1, by1) = _glyph_tris(s, weight * ref, spacing)
        if not len(tris):
            return
        size = size / ref
        w, h = (bx1 - bx0) * size, (by1 - by0) * size
        ox = {"l": 0, "m": -w / 2, "r": -w}[anchor[0]]
        oy = {"t": 0, "m": -h / 2, "b": -h}[anchor[1]]
        pts = tris.copy()
        pts[..., 0] = (pts[..., 0] - bx0) * size + ox
        pts[..., 1] = (by1 - pts[..., 1]) * size + oy
        if rot:
            c, s_ = math.cos(rot), math.sin(rot)
            px, py = pts[..., 0].copy(), pts[..., 1].copy()
            pts[..., 0], pts[..., 1] = px * c - py * s_, px * s_ + py * c
        pts[..., 0] += x
        pts[..., 1] += y
        self._raster_tris(pts, color, alpha)

    def vtext(self, s, x, y, size, color, weight=0.0, alpha=1.0, gap=0.08):
        """Vertical text (top to bottom), centered on x, starting at y."""
        for ch in s:
            if ch == " ":
                y += size * 0.6
                continue
            self.text(ch, x, y + size / 2, size, color, "mm", weight, alpha)
            y += size * (1 + gap)

    def _raster_tris(self, pts, color, alpha, ss=3):
        x0, y0 = pts[..., 0].min(), pts[..., 1].min()
        x1, y1 = pts[..., 0].max(), pts[..., 1].max()
        g = self._grid(x0, y0, x1, y1)
        if g is None:
            return
        sl, xs, ys = g
        gx0, gy0 = sl[1].start, sl[0].start
        H, W = xs.shape
        cov = np.zeros((H * ss, W * ss), np.float32)
        for tri in pts:
            tx0 = max(int((tri[:, 0].min() - gx0) * ss), 0)
            tx1 = min(int((tri[:, 0].max() - gx0) * ss) + 2, W * ss)
            ty0 = max(int((tri[:, 1].min() - gy0) * ss), 0)
            ty1 = min(int((tri[:, 1].max() - gy0) * ss) + 2, H * ss)
            if tx1 <= tx0 or ty1 <= ty0:
                continue
            yy, xx = np.mgrid[ty0:ty1, tx0:tx1].astype(np.float32)
            px = (xx + 0.5) / ss + gx0
            py = (yy + 0.5) / ss + gy0
            (ax, ay), (bx, by), (cx, cy) = tri
            d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
            d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
            d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
            neg = (d1 < 0) | (d2 < 0) | (d3 < 0)
            pos = (d1 > 0) | (d2 > 0) | (d3 > 0)
            cov[ty0:ty1, tx0:tx1] = np.maximum(cov[ty0:ty1, tx0:tx1], (~(neg & pos)).astype(np.float32))
        cov = cov.reshape(H, ss, W, ss).mean(axis=(1, 3))
        self.blend(sl, cov, color, alpha)

    # -- output -------------------------------------------------------------

    def image(self, name, colorspace="sRGB"):
        img = bpy.data.images.get(name)
        if img is not None:
            bpy.data.images.remove(img)
        img = bpy.data.images.new(name, self.w, self.h, alpha=True)
        img.colorspace_settings.name = colorspace
        img.alpha_mode = "STRAIGHT"
        img.pixels.foreach_set(np.ascontiguousarray(self.px[::-1]).ravel())
        img.pack()
        return img

    def save(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        img = self.image("__canvas_tmp")
        img.filepath_raw = path
        img.file_format = "PNG"
        img.save()
        bpy.data.images.remove(img)


def _ref_height():
    _, (_, y0, _, y1) = _glyph_tris("国", 0.0, 1.0)
    return y1 - y0


def _get_font():
    """The bundled CJK font; reloaded when a scene reset has freed it."""
    global _font
    try:
        if _font is not None and _font.name:
            return _font
    except ReferenceError:
        pass
    _font = bpy.data.fonts.load(FONT_PATH, check_existing=True)
    return _font


def _glyph_tris(s, weight, spacing):
    """Triangles of the filled text outline in em units (y up)."""
    key = (s, round(weight, 4), spacing)
    if key in _glyph_cache:
        return _glyph_cache[key]
    cu = bpy.data.curves.new("__glyph", "FONT")
    cu.body = s
    cu.font = _get_font()
    cu.offset = weight
    cu.space_character = spacing
    cu.resolution_u = 6
    ob = bpy.data.objects.new("__glyph", cu)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    me.calc_loop_triangles()
    co = np.array([v.co[:2] for v in me.vertices], np.float32)
    if len(me.loop_triangles):
        idx = np.array([t.vertices[:] for t in me.loop_triangles], np.int32)
        tris = co[idx]
        bounds = (co[:, 0].min(), co[:, 1].min(), co[:, 0].max(), co[:, 1].max())
    else:
        tris, bounds = np.zeros((0, 3, 2), np.float32), (0, 0, 0, 0)
    ev.to_mesh_clear()
    bpy.data.objects.remove(ob)
    bpy.data.curves.remove(cu)
    _glyph_cache[key] = (tris, bounds)
    return tris, bounds
