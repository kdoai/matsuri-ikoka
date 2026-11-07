"""The six stalls of the festival street.

Each stall tells its role by shape first, so it reads from far away and without
letters. The sign and the lantern paper repeat it as a pictogram and a word:

  access        a small rural station: train on the ridge, signpost, signal, rails
  lodging       a tiny inn: tiled roof, moon on the ridge, futons on tatami, shoji
  etiquette     a torii in front of a shrine roof with crossed ridge boards, rope, basin
  food          the classic stall: striped awning, giant bowl and dango, griddle
  weather       a round counter under one huge parasol, wind gauge and rain charms
  headquarters  the wide white event tent with curtains, a long table and loudspeakers

Local axes of a stall: bottom center at the origin, front toward -Y.

Every lantern exists twice on purpose: the paper is part of the baked stall and
is the unlit state; a slightly larger emissive shell (plus a soft glow) is
collected into one `lantern.<role>.on` mesh that the app shows when it lights up.
"""

import math
import random

import bmesh
from mathutils import Vector

from . import materials as M
from . import palette as P
from . import props
from . import textures as T
from . import util as U

WARM = "#FFCF9A"


def _dark():
    return M.wood("wood_dark", P.WOOD_DARK)


def _wood():
    return M.wood("wood_furniture", P.WOOD)


def _top():
    return M.wood("wood_counter_top", P.WOOD_LIGHT)


def _child(prop, root):
    prop.parent = root
    return prop


def _posts(name, c, root, xs, ys, h, mat, w=0.1, z=0.0):
    for x in xs:
        for y in ys:
            U.box(f"{name}.post", (w, w, h), c, base=(x, y, z), mat=mat, bev=0.008, parent=root)


def _counter(name, c, root, w, d, h, y, mat, top=None, x=0.0):
    U.box(f"{name}.counter", (w, d, h - 0.04), c, base=(x, y, 0), mat=mat, bev=0.008, parent=root)
    U.box(f"{name}.counter_top", (w + 0.1, d + 0.1, 0.04), c, base=(x, y, h - 0.04), mat=top or _top(), bev=0.008,
          parent=root)


def _slab(name, c, root, width, length, ridge, pitch, mat, t=0.06, back=False):
    """Roof plate hanging from `ridge` (x, y, z), sloping down toward -Y (or +Y when `back`)."""
    s = 1 if back else -1
    x, y, z = ridge
    return U.box(name, (width, length, t), c,
                 loc=(x, y + s * length / 2 * math.cos(pitch), z - length / 2 * math.sin(pitch)),
                 rot=(-s * pitch, 0, 0), mat=mat, parent=root)


def _gable(name, c, root, width, length, ridge, pitch, mat, t=0.06):
    _slab(f"{name}.roof_front", c, root, width, length, ridge, pitch, mat, t)
    _slab(f"{name}.roof_back", c, root, width, length, ridge, pitch, mat, t, back=True)


def _plate(name, c, root, points, thickness, loc, rot=(0, 0, 0), mat=None):
    """Flat cutout from (x, z) points in its local XZ plane, given some thickness."""
    bm = bmesh.new()
    bm.faces.new([bm.verts.new((x, 0, z)) for x, z in points])
    obj = U.mesh_object(name, bm, c, mat, parent=root)
    obj.modifiers.new("Solidify", "SOLIDIFY").thickness = thickness
    return U.place(obj, loc, rot)


def _tube(name, c, root, points, radius, mat, segs=8):
    """Smooth tube through local points."""
    pts = [Vector(p) for p in points]
    bm = bmesh.new()
    rings = []
    for i, p in enumerate(pts):
        d = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        side = d.cross(Vector((0, 0, 1)))
        side = side.normalized() if side.length > 1e-4 else Vector((1, 0, 0))
        up = side.cross(d).normalized()
        rings.append([bm.verts.new(p + radius * (math.cos(2 * math.pi * k / segs) * side +
                                                  math.sin(2 * math.pi * k / segs) * up)) for k in range(segs)])
    for a, b in zip(rings, rings[1:]):
        for k in range(segs):
            j = (k + 1) % segs
            bm.faces.new((a[k], a[j], b[j], b[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return U.mesh_object(name, bm, c, mat, smooth=True, parent=root)


def _sag(a, b, n, sag):
    a, b = Vector(a), Vector(b)
    return [a.lerp(b, i / n) + Vector((0, 0, -sag * 4 * (i / n) * (1 - i / n))) for i in range(n + 1)]


def _sign(role, c, root, loc, size=0.82, tilt=0.14):
    """Framed signboard (center at `loc`, facing -Y, leaning back a little so it reads from above)."""
    k = T.STALL_ROLES.index(role)
    frame = _dark()
    board = props._root(f"{role}.sign", c, loc)
    board.parent = root
    board.rotation_euler = (tilt, 0, 0)
    U.box(f"{role}.sign.board", (size + 0.08, 0.05, size + 0.08), c, loc=(0, 0.03, 0), mat=frame, bev=0.012, parent=board)
    props.textured_panel(f"{role}.sign.face", c, (size, size), "stall_signs", loc=(0, 0.002, 0), cell=(k, 3, 2),
                         parent=board)
    return board


def _lamp(role, c, root, shells, loc, radius=0.21, height=0.48, cord=0.1, big=True):
    """One stall lantern hanging from `loc`: baked paper for the unlit state, an emissive shell for the lit one."""
    k = T.STALL_ROLES.index(role)
    n, segs = (8, 16) if big else (6, 12)
    prof = [(radius * (0.55 + 0.45 * math.sin(math.pi * i / n)), -height + height * i / n) for i in range(n + 1)]
    base = props._root(f"{role}.lamp", c, loc)
    base.parent = root
    cap = M.flat("lantern_cap", "#2B1B14", 0.5)
    paper = U.lathe(f"{role}.lamp.paper", prof, c, segs=segs, mat=M.textured("lantern_roles_off", "lantern_roles", 0.9),
                    parent=base, close=False)
    rows = len(T.STALL_ROLES)
    U.uv_rect(paper, 0, 1 - (k + 1) / rows, 1, 1 - k / rows)
    r = radius * 0.6
    U.cylinder(f"{role}.lamp.cap_top", r, 0.04, c, base=(0, 0, -0.03), mat=cap, verts=segs, parent=base)
    U.cylinder(f"{role}.lamp.cap_bot", r, 0.04, c, base=(0, 0, -height - 0.01), mat=cap, verts=segs, parent=base)
    U.cylinder(f"{role}.lamp.cord", 0.006, cord, c, base=(0, 0, 0.0), mat=cap, verts=5, parent=base)
    on = M.textured("lantern_roles_on", "lantern_roles", 0.9, emission=1.7, glow_tint="#FFA850")
    shell = U.lathe(f"{role}.lamp.shell", [(a * 1.02, b) for a, b in prof], c, segs=segs, mat=on, parent=base, close=False)
    U.uv_rect(shell, 0, 1 - (k + 1) / rows, 1, 1 - k / rows)
    shells.append(shell)
    glow = M.textured("lantern_glow", "lantern_glow", 1.0, emission=1.0, alpha=True)
    halo_size = radius * 5.5
    shells.append(U.plane(f"{role}.lamp.halo", (halo_size, halo_size), c, loc=(0, -radius * 1.1, -height / 2),
                          rot=(math.pi / 2, 0, 0), mat=glow, parent=base))
    return base


def _lantern_pole(role, c, root, shells, x, y):
    """The stall's big lantern on its own pole at the roadside, out in front of the eaves: seen from anywhere on the street."""
    wood = _dark()
    U.cylinder(f"{role}.lamp_pole", 0.04, 3.0, c, base=(x, y, 0), mat=wood, verts=8, parent=root)
    U.box(f"{role}.lamp_foot", (0.3, 0.3, 0.06), c, base=(x, y, 0), mat=wood, bev=0.012, parent=root)
    U.box(f"{role}.lamp_arm", (0.5, 0.05, 0.05), c, base=(x, y, 2.92), mat=wood, parent=root)
    arm_x = x + (0.22 if x < 0 else -0.22)
    _lamp(role, c, root, shells, (arm_x, y, 2.9), radius=0.3, height=0.68, cord=0.04)


def _pool(c, root, shells, loc=(0, -1.25), size=(3.0, 1.9)):
    """Warm pool on the ground in front of the stall, shown with the lit lanterns."""
    glow = M.textured("lantern_glow", "lantern_glow", 1.0, emission=1.0, alpha=True)
    shells.append(U.plane(f"{root.name}.pool", size, c, loc=(loc[0], loc[1], 0.02), mat=glow, parent=root))


# --------------------------------------------------------------------------
# access: a little station


def _toy_train(c, root, x0, y, z):
    """Local train the size of a shop sign, running along the ridge."""
    cream = M.flat("train_cream", "#F2E6C8", 0.5)
    red = M.flat("train_red", "#C8473C", 0.45)
    dark = M.flat("train_dark", "#27303C", 0.4)
    glass = M.flat("train_glass", "#FFD79A", 0.3)
    length = 1.6
    train = props._root("access.train", c, (x0, y, z))
    train.parent = root
    U.box("access.train.lower", (length, 0.58, 0.24), c, base=(0, 0, 0.1), mat=red, bev=0.03, parent=train)
    U.box("access.train.upper", (length, 0.56, 0.3), c, base=(0, 0, 0.34), mat=cream, bev=0.03, parent=train)
    U.box("access.train.roof", (length + 0.04, 0.5, 0.07), c, base=(0, 0, 0.64), mat=dark, bev=0.03, parent=train)
    for i in range(4):
        wx = -length / 2 + 0.27 + i * 0.355
        for s in (-1, 1):
            U.box("access.train.window", (0.24, 0.012, 0.17), c, loc=(wx, s * 0.285, 0.5), mat=glass, parent=train)
    U.sphere("access.train.head", 0.055, c, loc=(length / 2 + 0.01, 0, 0.24), mat=glass, segs=10, rings=6, parent=train)
    for wx in (-0.5, 0.5):
        for s in (-1, 1):
            U.cylinder("access.train.wheel", 0.1, 0.05, c, loc=(wx, s * 0.22, 0.1), rot=(math.pi / 2, 0, 0), mat=dark,
                       verts=12, parent=train)


def access(root, c, shells):
    green = M.wood("wood_station", "#3F7F72", dark="#2C5C53", light="#5A9C8E")
    cream = M.flat("station_cream", "#F0E4C8", 0.7)
    tin = M.flat("station_tin", "#3A6E6A", 0.5)
    U.box("access.platform", (3.3, 2.1, 0.12), c, base=(0, 0.05, 0), mat=M.flat("concrete", "#A8A095", 0.9), bev=0.012,
          parent=root)
    U.box("access.edge", (3.3, 0.16, 0.006), c, base=(0, -0.84, 0.12), mat=M.flat("tactile", "#E3B83B", 0.7), parent=root)
    _posts("access", c, root, (-1.42, 1.42), (-0.72, 0.84), 2.08, green, z=0.12)
    ridge = (0, 0.05, 2.72)
    _gable("access", c, root, 3.6, 1.35, ridge, 0.3, tin)
    # Sawtooth valance along the front eave, as on an old station canopy.
    teeth = []
    for i in range(25):
        teeth += [(-1.74 + i * 0.145, 0.0), (-1.74 + (i + 0.5) * 0.145, -0.13)]
    teeth += [(1.74, 0.0), (1.74, 0.1), (-1.74, 0.1)]
    _plate("access.valance", c, root, teeth, 0.03, (0, -1.19, 2.27), mat=cream)
    U.box("access.beam", (2.96, 0.1, 0.14), c, base=(0, -0.72, 2.14), mat=green, parent=root)
    U.box("access.back", (2.94, 0.06, 2.02), c, base=(0, 0.86, 0.12), mat=cream, parent=root)
    props.textured_panel("access.timetable", c, (0.92, 0.74), "timetable", loc=(-0.72, 0.82, 1.5), parent=root)
    props.textured_panel("access.map", c, (1.04, 0.74), "map", loc=(0.68, 0.82, 1.5), parent=root)
    _counter("access", c, root, 2.5, 0.44, 0.62, -0.2, green)
    # Tickets on the counter, in a little rack.
    U.box("access.tickets", (0.36, 0.14, 0.14), c, base=(-0.72, -0.2, 0.62), mat=_top(), bev=0.006, parent=root)
    for i in range(5):
        U.box("access.ticket", (0.05, 0.1, 0.05), c, base=(-0.86 + i * 0.07, -0.2, 0.75),
              mat=M.flat("ticket", "#F2D98A" if i % 2 else "#E89A7A", 0.7), parent=root)
    # Station clock under the canopy.
    U.cylinder("access.clock_case", 0.2, 0.05, c, loc=(-1.05, -0.74, 1.86), rot=(math.pi / 2, 0, 0), mat=_dark(), verts=20,
               parent=root)
    props.shape_panel("access.clock", c, props._circle(20), (0.34, 0.34), "clock", loc=(-1.05, -0.77, 1.86), thickness=0.0,
                      parent=root)
    U.box("access.clock_arm", (0.03, 0.03, 0.2), c, base=(-1.05, -0.74, 2.05), mat=_dark(), parent=root)
    # Rails on the ground in front of the platform.
    steel = M.flat("rail_steel", "#6E6A68", 0.35, metal=0.7)
    for y in (-1.14, -1.42):
        U.box("access.rail", (3.9, 0.035, 0.035), c, base=(0, y, 0.012), mat=steel, parent=root)
    for i in range(9):
        U.box("access.sleeper", (0.13, 0.5, 0.018), c, base=(-1.76 + i * 0.44, -1.28, 0), mat=_dark(), parent=root)
    # Signpost with arrows, standing taller than the roof.
    U.cylinder("access.signpost", 0.05, 3.4, c, base=(-1.86, -0.42, 0), mat=_dark(), verts=10, parent=root)
    arrow = [(0, -0.12), (0.78, -0.12), (1.0, 0), (0.78, 0.12), (0, 0.12)]
    arrows = (("#C8473C", 3.16, 0.0), ("#E9B44C", 2.84, math.pi), ("#2F7F7A", 2.52, 0.0))
    for color, z, yaw in arrows:
        _plate("access.arrow", c, root, arrow, 0.035, (-1.86, -0.47, z), rot=(0, 0, yaw),
               mat=M.flat(f"arrow_{color}", color, 0.55))
    U.sphere("access.signpost_cap", 0.07, c, loc=(-1.86, -0.42, 3.42), mat=M.flat("brass", P.GOLD, 0.25, 1.0), segs=10,
             rings=6, parent=root)
    # Semaphore signal on the other side.
    U.cylinder("access.signal_mast", 0.045, 2.95, c, base=(1.86, -0.42, 0), mat=M.flat("signal_mast", "#39404A", 0.5),
               verts=10, parent=root)
    _plate("access.signal_arm", c, root, [(0, -0.09), (0.78, -0.09), (0.86, 0), (0.78, 0.09), (0, 0.09)], 0.03,
           (1.86, -0.47, 2.72), rot=(0, 0.45, math.pi), mat=M.flat("signal_red", "#C8392B", 0.5))
    U.box("access.signal_stripe", (0.08, 0.035, 0.19), c, loc=(1.48, -0.47, 2.92), rot=(0, 0.45, 0),
          mat=M.flat("signal_white", "#F5EEDC", 0.5), parent=root)
    U.sphere("access.signal_lamp", 0.085, c, loc=(1.86, -0.5, 2.5), mat=M.flat("signal_green", "#3FBF7F", 0.25), segs=12,
             rings=8, parent=root)
    _toy_train(c, root, 0.42, 0.05, 2.7)
    _sign("access", c, root, (-0.82, -1.34, 2.72), size=0.78)
    # Lanterns.
    _lamp("access", c, root, shells, (0.28, -0.8, 2.14), radius=0.17, height=0.4)
    _lantern_pole("access", c, root, shells, 1.5, -1.62)
    _pool(c, root, shells)
    return [((0, -0.6, 1.95), 34, WARM)]


# --------------------------------------------------------------------------
# lodging: a tiny inn


def _crescent(c, root, loc, r, mat):
    pts = []
    for i in range(15):
        a = math.radians(50 + i * (260 / 14))
        pts.append((r * math.cos(a), r * math.sin(a)))
    for i in range(15):
        a = math.radians(310 - i * (260 / 14))
        pts.append((0.32 * r + 0.74 * r * math.cos(a), 0.74 * r * math.sin(a)))
    return _plate("lodging.moon", c, root, pts, 0.05, loc, mat=mat)


def _star(c, root, loc, r, mat):
    pts = []
    for i in range(10):
        a = math.pi / 2 + i * math.pi / 5
        rr = r if i % 2 == 0 else r * 0.42
        pts.append((rr * math.cos(a), rr * math.sin(a)))
    return _plate("lodging.star", c, root, pts, 0.03, loc, mat=mat)


def lodging(root, c, shells):
    frame = _dark()
    U.box("lodging.floor", (3.0, 1.9, 0.26), c, base=(0, 0.02, 0), mat=_wood(), bev=0.01, parent=root)
    U.box("lodging.tatami", (2.76, 1.66, 0.02), c, base=(0, 0.02, 0.26), mat=M.flat("tatami", "#BDB27A", 0.9), parent=root)
    _posts("lodging", c, root, (-1.42, 1.42), (-0.86, 0.86), 2.1, frame)
    # Shoji at the back, warm from inside.
    for i, x in enumerate((-0.95, 0, 0.95)):
        props.textured_panel(f"lodging.shoji{i}", c, (0.9, 1.62), "window_glow", loc=(x, 0.86, 1.08), parent=root)
    U.box("lodging.back", (2.94, 0.04, 1.82), c, base=(0, 0.9, 0.26), mat=frame, parent=root)
    for x in (-0.48, 0.48):
        U.box("lodging.mullion", (0.05, 0.04, 1.66), c, base=(x, 0.84, 0.28), mat=frame, parent=root)
    U.box("lodging.frieze", (2.94, 0.06, 0.48), c, base=(0, -0.86, 2.02), mat=M.plaster("plaster"), parent=root)
    U.box("lodging.beam", (3.0, 0.1, 0.12), c, base=(0, -0.86, 1.96), mat=frame, bev=0.008, parent=root)
    # Tiled gable roof with a ridge.
    ridge_z = 3.02
    for name, yaw in (("lodging.roof_front", 0.0), ("lodging.roof_back", math.pi)):
        _child(props.kawara_eave(name, c, 3.8, 1.72, loc=(0, 0, ridge_z), pitch=0.52, spacing=0.24, yaw=yaw), root)
    tile = M.flat("roof_tile", "#4A4C58", 0.45)
    U.box("lodging.ridge", (3.9, 0.24, 0.16), c, base=(0, 0, ridge_z - 0.04), mat=tile, bev=0.03, parent=root)
    for s in (-1, 1):
        U.box("lodging.onigawara", (0.16, 0.3, 0.3), c, base=(s * 1.98, 0, ridge_z - 0.06), mat=tile, bev=0.04, parent=root)
    # Moon and stars above the ridge.
    gold = M.flat("moon_gold", "#F2C04E", 0.45)
    U.cylinder("lodging.moon_post", 0.018, 0.34, c, base=(0.98, 0, ridge_z + 0.08), mat=_dark(), verts=6, parent=root)
    _crescent(c, root, (0.98, 0, ridge_z + 0.72), 0.42, gold)
    _star(c, root, (0.26, 0, ridge_z + 0.5), 0.14, gold)
    U.cylinder("lodging.star_post", 0.012, 0.3, c, base=(0.26, 0, ridge_z + 0.08), mat=_dark(), verts=6, parent=root)
    _child(props.noren("lodging.noren", c, 2.7, 0.5, loc=(0, -0.92, 2.0), tex="noren_lodging"), root)
    # Futons piled on the tatami, with a pillow on top.
    fy = 0.05
    for i, (color, w) in enumerate((("#2F3E7A", 1.02), ("#F0E7D2", 0.98), ("#B8453A", 1.0))):
        U.box("lodging.futon", (w, 0.72, 0.15), c, base=(-0.72, fy, 0.28 + i * 0.15),
              mat=M.fabric(f"futon_{color}", color, 0.5), bev=0.05, seg=3, parent=root)
    U.box("lodging.pillow", (0.46, 0.28, 0.12), c, base=(-0.72, fy - 0.1, 0.73), mat=M.fabric("pillow", "#F7F1E3", 0.5),
          bev=0.05, seg=3, parent=root)
    # A low table with tea, room keys on the wall.
    U.box("lodging.tray_table", (0.84, 0.54, 0.05), c, base=(0.68, 0.0, 0.5), mat=_wood(), bev=0.008, parent=root)
    for sx in (-1, 1):
        U.box("lodging.tray_leg", (0.05, 0.42, 0.22), c, base=(0.68 + sx * 0.34, 0.0, 0.28), mat=frame, parent=root)
    _child(props.tea_set("lodging.tea", c, loc=(0.68, 0.0, 0.55)), root)
    for i in range(4):
        U.box("lodging.key", (0.07, 0.015, 0.14), c, base=(0.32 + i * 0.22, 0.82, 1.5),
              mat=M.flat(f"key_{i % 2}", "#D9A93E" if i % 2 else "#C8473C", 0.5), parent=root)
    # Travel trunk and wooden sandals by the step.
    _child(props.suitcase("lodging.trunk", c, loc=(1.7, -0.5, 0), rot=(0, 0, 0.3)), root)
    for x in (-0.25, -0.05):
        U.box("lodging.geta", (0.13, 0.28, 0.035), c, base=(x, -1.1, 0.02), mat=_top(), bev=0.006, parent=root)
    _sign("lodging", c, root, (-0.05, -1.62, 2.62), size=0.76)
    _lamp("lodging", c, root, shells, (0, -1.08, 2.02), radius=0.17, height=0.4)
    _lamp("lodging", c, root, shells, (-1.32, -1.0, 2.14), radius=0.13, height=0.3, big=False)
    _lantern_pole("lodging", c, root, shells, 1.62, -1.62)
    _pool(c, root, shells)
    return [((0, -0.5, 1.8), 34, WARM)]


# --------------------------------------------------------------------------
# etiquette: torii and a shrine roof


def _torii_3d(c, root, y, w, h, mat, cap):
    for s in (-1, 1):
        U.cylinder("etiquette.torii_post", 0.085, h - 0.1, c, base=(s * w * 0.4, y, 0), radius2=0.07, mat=mat, verts=14,
                   parent=root)
        U.cylinder("etiquette.torii_foot", 0.11, 0.16, c, base=(s * w * 0.4, y, 0), mat=cap, verts=14, parent=root)
    U.box("etiquette.nuki", (w * 0.95, 0.09, 0.13), c, base=(0, y, h * 0.7), mat=mat, parent=root)
    curve = []
    n = 12
    for i in range(n + 1):
        x = -w / 2 - 0.1 + (w + 0.2) * i / n
        curve.append((x, 0.1 * (2 * i / n - 1) ** 2))
    lower = [(x, z - 0.12) for x, z in reversed(curve)]
    _plate("etiquette.shimagi", c, root, curve + lower, 0.17, (0, y + 0.085, h - 0.12), mat=mat)
    upper = [(x, z + 0.09) for x, z in curve]
    _plate("etiquette.kasagi", c, root, upper + [(x, z) for x, z in reversed(curve)], 0.2, (0, y + 0.1, h - 0.12), mat=cap)


def _shide(c, root, loc, mat, h=0.34):
    w = 0.09
    pts = [(-w / 2, 0), (w / 2, 0), (w / 2, -h * 0.3), (w, -h * 0.3), (w, -h * 0.62), (w * 1.5, -h * 0.62), (w * 1.5, -h),
           (w, -h), (w, -h * 0.72), (w / 2, -h * 0.72), (w / 2, -h * 0.4), (0, -h * 0.4), (0, -h * 0.1), (-w / 2, -h * 0.1)]
    return _plate("etiquette.shide", c, root, pts, 0.004, loc, mat=mat)


def etiquette(root, c, shells):
    pale = M.wood("wood_shrine", "#D8C19A", dark="#B59B6E", light="#EBDAB8")
    bark = M.wood("wood_bark", "#6E4A30", dark="#4A2F1E", light="#8A6240", rough=0.85)
    vermilion = M.flat("vermilion", "#D0402B", 0.55)
    black = M.flat("torii_black", "#2B2220", 0.6)
    white = M.flat("shide_white", "#FBF7EC", 0.8)
    U.box("etiquette.base", (3.2, 2.0, 0.1), c, base=(0, 0.1, 0), mat=M.flat("stone_step", "#8D8279", 0.9), bev=0.01,
          parent=root)
    _posts("etiquette", c, root, (-1.34, 1.34), (-0.5, 0.92), 2.0, pale, w=0.12, z=0.1)
    # Thick bark roof with crossed boards and logs on the ridge.
    ridge = (0, 0.2, 3.02)
    _gable("etiquette", c, root, 3.1, 1.5, ridge, 0.62, bark, t=0.16)
    U.box("etiquette.ridge", (3.2, 0.2, 0.14), c, base=(0, 0.2, 3.0), mat=bark, bev=0.03, parent=root)
    for x in (-0.95, -0.32, 0.32, 0.95):
        U.cylinder("etiquette.katsuogi", 0.07, 0.42, c, loc=(x, 0.2, 3.22), rot=(math.pi / 2, 0, 0), mat=pale, verts=10,
                   parent=root)
    for sx in (-1, 1):
        for sy in (-1, 1):
            U.box("etiquette.chigi", (0.07, 0.1, 0.9), c, loc=(sx * 1.52, 0.2 + sy * 0.2, 3.2),
                  rot=(sy * 0.62, 0, 0), mat=pale, parent=root)
    U.box("etiquette.beam", (2.86, 0.12, 0.16), c, base=(0, -0.5, 2.02), mat=pale, parent=root)
    U.box("etiquette.gable_wall", (2.86, 0.06, 0.6), c, base=(0, 0.92, 2.1), mat=pale, parent=root)
    U.box("etiquette.back", (2.86, 0.06, 1.94), c, base=(0, 0.94, 0.1), mat=M.fabric("shrine_curtain", "#EFE8D6", 0.3),
          parent=root)
    props.textured_panel("etiquette.board", c, (1.4, 0.7), "etiquette_board", loc=(-0.45, 0.9, 1.48), parent=root)
    # Rack of votive plaques.
    U.box("etiquette.ema_rail", (1.04, 0.05, 0.05), c, base=(0.85, 0.88, 1.68), mat=_dark(), parent=root)
    pent = [(-0.09, -0.08), (0.09, -0.08), (0.09, 0.04), (0, 0.1), (-0.09, 0.04)]
    for i in range(4):
        _plate("etiquette.ema", c, root, pent, 0.012, (0.46 + i * 0.26, 0.85, 1.54), mat=_top())
    # Counter, then the stone basin with its ladles on the right.
    _counter("etiquette", c, root, 1.5, 0.44, 0.62, -0.05, pale, x=-0.62)
    U.box("etiquette.cloth", (1.5, 0.012, 0.26), c, base=(-0.62, -0.28, 0.32),
          mat=M.fabric("etiquette_cloth", "#C8392B", 0.3), parent=root)
    stone = M.flat("basin_stone", "#8A8A84", 0.85)
    U.box("etiquette.basin_stand", (0.72, 0.42, 0.36), c, base=(0.9, -0.3, 0.1), mat=stone, bev=0.02, parent=root)
    U.box("etiquette.basin", (0.86, 0.52, 0.18), c, base=(0.9, -0.3, 0.46), mat=stone, bev=0.03, parent=root)
    U.box("etiquette.water", (0.72, 0.38, 0.01), c, base=(0.9, -0.3, 0.635), mat=M.flat("water", "#7CC3E8", 0.08), parent=root)
    bamboo = M.flat("bamboo", "#C9A46A", 0.55)
    for i in range(2):
        U.cylinder("etiquette.ladle_cup", 0.045, 0.07, c, base=(0.68 + i * 0.3, -0.42, 0.65), mat=bamboo, verts=10, parent=root)
        U.cylinder("etiquette.ladle", 0.009, 0.46, c, loc=(0.74 + i * 0.3, -0.26, 0.7), rot=(1.45, 0, 0.3), mat=bamboo,
                   verts=6, parent=root)
    _torii_3d(c, root, -1.1, 3.5, 3.42, vermilion, black)
    U.box("etiquette.gakuzuka", (0.08, 0.06, 0.92), c, base=(0, -1.1, 2.34), mat=vermilion, parent=root)
    # Sacred rope with paper streamers under the crossbeam.
    rope = M.flat("shimenawa", "#D9C07A", 0.85)
    _tube("etiquette.rope", c, root, _sag((-1.3, -1.1, 2.3), (1.3, -1.1, 2.3), 10, 0.14), 0.04, rope)
    for x in (-0.9, -0.34, 0.34, 0.9):
        _shide(c, root, (x, -1.1, 2.2), white)
    _sign("etiquette", c, root, (0, -1.16, 2.8), size=0.66, tilt=0.06)
    _lamp("etiquette", c, root, shells, (-0.96, -0.56, 1.98), radius=0.15, height=0.36)
    _lamp("etiquette", c, root, shells, (0, -1.16, 2.28), radius=0.17, height=0.4, cord=0.12)
    _lantern_pole("etiquette", c, root, shells, 1.86, -1.5)
    _pool(c, root, shells)
    return [((0, -0.35, 1.8), 30, WARM)]


# --------------------------------------------------------------------------
# food: the classic stall


def _giant_bowl(c, root, loc):
    bowl = props._root("food.bowl", c, loc)
    bowl.parent = root
    U.lathe("food.bowl.body", [(0.0, 0.0), (0.2, 0.0), (0.22, 0.05), (0.5, 0.34), (0.58, 0.46), (0.53, 0.47), (0.0, 0.44)],
            c, segs=20, mat=M.flat("bowl_red", "#B8302A", 0.35), parent=bowl)
    U.torus("food.bowl.rim", 0.56, 0.018, c, loc=(0, 0, 0.46), mat=M.flat("bowl_gold", "#E9B44C", 0.35), major_segs=20,
            minor_segs=5, parent=bowl)
    U.sphere("food.bowl.noodles", 0.46, c, loc=(0, 0, 0.47), scale=(1, 1, 0.3), mat=M.flat("noodles", "#EBC45C", 0.6), segs=16,
             rings=8, parent=bowl)
    U.cylinder("food.bowl.naruto", 0.12, 0.02, c, loc=(-0.18, -0.12, 0.6), rot=(0.18, -0.15, 0), mat=M.flat("naruto", "#F7EEE2", 0.6),
               verts=12, parent=bowl)
    U.cylinder("food.bowl.egg", 0.13, 0.02, c, loc=(0.16, -0.16, 0.59), rot=(0.2, 0.1, 0), mat=M.flat("bowl_egg", "#F2A33A", 0.5),
               verts=12, parent=bowl)
    stick = M.flat("chopstick", "#8A4E2E", 0.5)
    for x in (0.1, 0.2):
        U.cylinder("food.bowl.chopstick", 0.018, 1.08, c, loc=(x + 0.18, 0.06, 0.92), rot=(0.1, 0.5, 0), radius2=0.012,
                   mat=stick, verts=6, parent=bowl)
    return bowl


def _dango(c, root, loc, r=0.17, tilt=-0.28):
    d = props._root("food.dango", c, loc)
    d.parent = root
    d.rotation_euler = (0, tilt, 0)
    U.cylinder("food.dango.stick", 0.018, 1.1, c, base=(0, 0, -0.22), mat=M.flat("bamboo", "#C9A46A", 0.55), verts=6, parent=d)
    for i, color in enumerate(("#8ABF6A", "#F7F1E3", "#F2A6B8")):
        U.sphere("food.dango.ball", r, c, loc=(0, 0, 0.1 + i * (r * 1.85)), mat=M.flat(f"dango_{color}", color, 0.55), segs=12,
                 rings=8, parent=d)


def food(root, c, shells):
    wood = _wood()
    _posts("food", c, root, (-1.46, 1.46), (-0.82,), 2.12, wood)
    _posts("food", c, root, (-1.46, 1.46), (0.72,), 2.66, wood)
    _child(props.striped_awning("food.awning", c, 3.3, 1.78, 0.62, loc=(0, 0.8, 2.78)), root)
    U.box("food.back", (2.98, 0.05, 2.6), c, base=(0, 0.78, 0), mat=M.wood("wood_shelf_back", P.mix(P.WOOD_DARK, "#000000", 0.15)),
          parent=root)
    for x, color in ((-0.9, "#C8473C"), (0, "#E9B44C"), (0.9, "#2A3F8E")):
        U.box("food.menu", (0.56, 0.02, 0.86), c, base=(x, 0.74, 1.3), mat=M.fabric(f"menu_{color}", color, 0.3), parent=root)
    _counter("food", c, root, 2.86, 0.66, 0.62, -0.28, M.fabric("food_cloth", "#C8392B", 0.3), top=_top())
    U.box("food.cloth_stripe", (2.88, 0.012, 0.12), c, base=(0, -0.615, 0.34), mat=M.fabric("cloth_cream", "#F5EEDC", 0.3),
          parent=root)
    # Griddle with noodles.
    U.box("food.griddle", (1.14, 0.5, 0.04), c, base=(-0.68, -0.28, 0.62), mat=M.flat("griddle", "#26221F", 0.35, metal=0.6),
          parent=root)
    rng = random.Random(12)
    for i in range(7):
        U.sphere("food.yakisoba", 0.13, c, loc=(-1.0 + i * 0.1 + rng.uniform(-0.03, 0.03), -0.28 + rng.uniform(-0.14, 0.14), 0.68),
                 scale=(1, 0.8, 0.34), mat=M.flat("yakisoba", "#A8682A", 0.6), segs=10, rings=6, parent=root)
    # Tray of octopus balls.
    U.box("food.takoyaki_plate", (0.62, 0.44, 0.05), c, base=(0.42, -0.28, 0.62), mat=M.flat("griddle", "#26221F", 0.35, metal=0.6),
          parent=root)
    for i in range(4):
        for j in range(3):
            U.sphere("food.takoyaki", 0.055, c, loc=(0.24 + i * 0.12, -0.4 + j * 0.12, 0.69), mat=M.flat("takoyaki", "#B9713A", 0.55),
                     segs=8, rings=6, parent=root)
    # Stack of bowls and sauce bottles.
    for i in range(4):
        U.lathe("food.stack", [(0.0, 0.0), (0.06, 0.0), (0.11, 0.07), (0.0, 0.05)], c, segs=12,
                loc=(1.12, -0.32, 0.62 + i * 0.035), mat=M.flat("bowl_small", "#EFE6D2", 0.35), parent=root)
    for x, color in ((0.92, "#6A2E1E"), (0.84, "#E9B44C")):
        U.cylinder("food.bottle", 0.03, 0.16, c, base=(x, -0.05, 0.62), mat=M.flat(f"bottle_{color}", color, 0.35), verts=8, parent=root)
    # Barrel to the side.
    U.lathe("food.barrel", [(0.0, 0.0), (0.2, 0.0), (0.25, 0.25), (0.2, 0.5), (0.0, 0.5)], c, segs=14, loc=(1.76, -0.5, 0), mat=wood,
            parent=root)
    _giant_bowl(c, root, (0.62, 0.05, 2.5))
    _dango(c, root, (-1.34, 0.45, 2.72))
    _child(props.noren("food.noren", c, 2.72, 0.36, loc=(0, -0.86, 2.06), tex="noren_food", panels=5), root)
    _sign("food", c, root, (-0.56, -1.12, 2.62), size=0.74)
    _lamp("food", c, root, shells, (0.42, -1.0, 2.14), radius=0.17, height=0.4)
    _lamp("food", c, root, shells, (1.36, -1.0, 2.1), radius=0.13, height=0.3, big=False)
    _lantern_pole("food", c, root, shells, -1.72, -1.42)
    _pool(c, root, shells)
    return [((0, -0.55, 1.85), 36, WARM)]


# --------------------------------------------------------------------------
# weather: one huge parasol over a round counter


def _teru(c, root, loc):
    """Rain charm: a little white cloth doll hanging by a thread."""
    cloth = M.fabric("teru_cloth", "#F7F3E8", 0.3)
    eye = M.flat("teru_eye", P.EYE, 0.4)
    x, y, z = loc
    U.cylinder("weather.teru_thread", 0.004, 0.14, c, base=(x, y, z), mat=eye, verts=4, parent=root)
    U.sphere("weather.teru_head", 0.075, c, loc=(x, y, z - 0.07), mat=cloth, segs=10, rings=6, parent=root)
    U.cylinder("weather.teru_body", 0.1, 0.13, c, base=(x, y, z - 0.25), radius2=0.03, mat=cloth, verts=10, parent=root)
    n = Vector((x, y, 0)).normalized()
    side = Vector((-n.y, n.x, 0))
    for s in (-1, 1):
        p = Vector((x, y, z - 0.065)) + n * 0.068 + side * (s * 0.028)
        U.sphere("weather.teru_eye", 0.011, c, loc=p, mat=eye, segs=6, rings=4, parent=root)


def weather(root, c, shells):
    bamboo = M.flat("bamboo_dark", "#7C5A34", 0.55)
    U.cylinder("weather.pole", 0.07, 3.2, c, base=(0, 0, 0), mat=bamboo, verts=12, parent=root)
    # Round counter around the pole.
    wood = _wood()
    U.lathe("weather.ring", [(0.84, 0.0), (1.2, 0.0), (1.2, 0.56), (0.84, 0.56)], c, segs=28, mat=wood, parent=root, close=True)
    U.lathe("weather.ring_top", [(0.8, 0.56), (1.26, 0.56), (1.26, 0.6), (0.8, 0.6)], c, segs=28, mat=_top(), parent=root, close=True)
    U.cylinder("weather.floor", 0.84, 0.05, c, base=(0, 0, 0), mat=M.flat("stone_step", "#8D8279", 0.9), verts=24, parent=root)
    # The parasol.
    rim_z = 2.28
    prof = [(1.95, rim_z), (1.5, rim_z + 0.34), (1.0, rim_z + 0.6), (0.5, rim_z + 0.78), (0.1, rim_z + 0.86)]
    canopy = U.lathe("weather.parasol", prof, c, segs=32, mat=M.textured("tex_wagasa", "wagasa", 0.75), parent=root, close=False)
    canopy.modifiers.new("Solidify", "SOLIDIFY").thickness = 0.03
    U.cylinder("weather.parasol_cap", 0.13, 0.08, c, base=(0, 0, rim_z + 0.84), mat=M.flat("umbrella_cap", "#2B2220", 0.5), verts=14,
               parent=root)
    ribs = M.flat("umbrella_rib", "#D8C19A", 0.7)
    for i in range(16):
        a = 2 * math.pi * i / 16
        p0 = Vector((math.cos(a) * 0.1, math.sin(a) * 0.1, 2.24))
        p1 = Vector((math.cos(a) * 1.1, math.sin(a) * 1.1, rim_z + 0.5))
        d = p1 - p0
        U.cylinder("weather.rib", 0.009, d.length, c, loc=(p0 + p1) / 2, rot=d.to_track_quat("Z", "Y").to_euler(), mat=ribs, verts=4, parent=root)
    # Rain charms along the rim; the front stays clear for the sign and the lanterns.
    for i in range(12):
        a = 2 * math.pi * (i + 0.5) / 12
        if abs(math.sin(a) + 1) < 0.15:
            continue
        _teru(c, root, (math.cos(a) * 1.72, math.sin(a) * 1.72, rim_z + 0.06))
    # Wind gauge on top: spinning cups and a vane.
    metal = M.flat("gauge_metal", "#C9CDD2", 0.35, metal=0.7)
    U.cylinder("weather.gauge_mast", 0.022, 0.72, c, base=(0, 0, rim_z + 0.9), mat=metal, verts=8, parent=root)
    for i in range(3):
        a = 2 * math.pi * i / 3 + 0.4
        ax, ay = math.cos(a), math.sin(a)
        U.cylinder("weather.gauge_arm", 0.009, 0.3, c, loc=(ax * 0.15, ay * 0.15, rim_z + 1.6), rot=(0, math.pi / 2, a), mat=metal, verts=6, parent=root)
        U.sphere("weather.gauge_cup", 0.075, c, loc=(ax * 0.32, ay * 0.32, rim_z + 1.6), mat=M.flat("gauge_cup", "#F2A33A", 0.4), segs=10, rings=6, parent=root)
    vane = [(-0.42, -0.09), (-0.28, 0), (-0.42, 0.09), (0.0, 0.03), (0.3, 0.03), (0.3, 0.09), (0.46, 0), (0.3, -0.09), (0.3, -0.03), (0.0, -0.03)]
    _plate("weather.vane", c, root, vane, 0.02, (0, 0, rim_z + 1.3), rot=(0, 0, 0.5), mat=M.flat("vane_red", "#C8473C", 0.5))
    # Instruments on the counter.
    U.cylinder("weather.dial_case", 0.17, 0.05, c, loc=(-0.72, -0.6, 0.86), rot=(1.3, 0, 0.5), mat=_dark(), verts=16, parent=root)
    props.shape_panel("weather.dial", c, props._circle(16), (0.28, 0.28), "clock", loc=(-0.735, -0.633, 0.855),
                      facing=(1.3, 0, 0.5), thickness=0.0, parent=root)
    U.cylinder("weather.gauge_tube", 0.05, 0.26, c, base=(0.7, -0.62, 0.6), mat=M.flat("glass_tint", "#BFE2F0", 0.1), verts=10, parent=root)
    # Louvered instrument shelter and forecast board beside the counter.
    white = M.flat("shelter_white", "#F4F0E4", 0.6)
    sx, sy = 1.62, 0.5
    for dx in (-0.2, 0.2):
        for dy in (-0.2, 0.2):
            U.box("weather.shelter_leg", (0.04, 0.04, 0.8), c, base=(sx + dx, sy + dy, 0), mat=white, parent=root)
    for i in range(6):
        U.box("weather.louver", (0.54, 0.54, 0.04), c, base=(sx, sy, 0.8 + i * 0.075), rot=(0.14, 0, 0), mat=white, parent=root)
    U.box("weather.shelter_roof", (0.66, 0.66, 0.05), c, base=(sx, sy, 1.27), mat=white, bev=0.012, parent=root)
    props.textured_panel("weather.board", c, (0.66, 0.88), "weather_board", loc=(-1.62, -0.4, 0.98), parent=root)
    U.box("weather.board_back", (0.74, 0.04, 0.96), c, base=(-1.62, -0.37, 0.5), mat=_dark(), parent=root)
    for dx in (-0.3, 0.3):
        U.box("weather.board_leg", (0.05, 0.05, 0.5), c, base=(-1.62 + dx, -0.37, 0), mat=_dark(), parent=root)
    _sign("weather", c, root, (0, -2.02, 2.66), size=0.72, tilt=0.3)
    _lamp("weather", c, root, shells, (0, -1.5, 2.06), radius=0.17, height=0.4)
    _lamp("weather", c, root, shells, (1.16, -1.16, 2.16), radius=0.13, height=0.3, big=False)
    _lantern_pole("weather", c, root, shells, -1.5, -1.6)
    _pool(c, root, shells, loc=(0, -1.35), size=(3.2, 2.0))
    return [((0, -0.6, 1.95), 36, WARM)]


# --------------------------------------------------------------------------
# headquarters: the white event tent


def _canopy_roof(c, root, w, d, eave_z, ridge_z, mat):
    """Hipped canvas: four slopes up to a short ridge, with a little thickness."""
    bm = bmesh.new()
    a, b = w / 2, d / 2
    ridge_a = a - d / 2
    base = [bm.verts.new((-a, -b, eave_z)), bm.verts.new((a, -b, eave_z)), bm.verts.new((a, b, eave_z)), bm.verts.new((-a, b, eave_z))]
    r0, r1 = bm.verts.new((-ridge_a, 0, ridge_z)), bm.verts.new((ridge_a, 0, ridge_z))
    bm.faces.new((base[0], base[1], r1, r0))
    bm.faces.new((base[1], base[2], r1))
    bm.faces.new((base[2], base[3], r0, r1))
    bm.faces.new((base[3], base[0], r0))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = U.mesh_object("headquarters.canvas", bm, c, mat, parent=root)
    obj.modifiers.new("Solidify", "SOLIDIFY").thickness = 0.02
    return obj


def _megaphone(c, root, loc, rot=(0, 0, 0)):
    m = props._root("headquarters.megaphone", c, loc)
    m.parent = root
    m.rotation_euler = rot
    U.lathe("headquarters.megaphone.cone", [(0.03, 0.0), (0.04, 0.04), (0.14, 0.28), (0.13, 0.28), (0.0, 0.05)], c, segs=14,
            loc=(0, 0, 0), rot=(math.pi / 2, 0, 0), mat=M.flat("megaphone", "#F4F0E4", 0.4), parent=m)
    U.box("headquarters.megaphone.grip", (0.04, 0.06, 0.1), c, base=(0, 0.1, -0.11), mat=M.flat("megaphone_grip", "#C8473C", 0.5), parent=m)


def _folding_chair(c, root, loc, yaw):
    ch = props._root("headquarters.chair", c, loc, yaw)
    ch.parent = root
    frame = M.flat("pipe_white", "#D9DBDD", 0.35, metal=0.5)
    U.box("headquarters.chair.seat", (0.36, 0.34, 0.03), c, base=(0, 0, 0.36), mat=M.flat("chair_seat", "#3C4256", 0.6), parent=ch)
    U.box("headquarters.chair.back", (0.36, 0.03, 0.18), c, base=(0, 0.17, 0.56), mat=M.flat("chair_seat", "#3C4256", 0.6), parent=ch)
    for sx in (-1, 1):
        U.box("headquarters.chair.leg_f", (0.025, 0.025, 0.36), c, base=(sx * 0.16, -0.14, 0), mat=frame, parent=ch)
        U.box("headquarters.chair.leg_b", (0.025, 0.025, 0.74), c, base=(sx * 0.16, 0.17, 0), mat=frame, parent=ch)


def headquarters(root, c, shells):
    pipe = M.flat("pipe_white", "#D9DBDD", 0.35, metal=0.5)
    canvas = M.fabric("tent_canvas", "#F4F1E8", 0.2)
    w, d, h = 5.4, 2.9, 2.2
    for x in (-w / 2 + 0.1, 0.0, w / 2 - 0.1):
        for y in (-d / 2 + 0.1, d / 2 - 0.1):
            U.cylinder("headquarters.pole", 0.04, h, c, base=(x, y, 0), mat=pipe, verts=8, parent=root)
    for y in (-d / 2 + 0.1, d / 2 - 0.1):
        U.cylinder("headquarters.bar", 0.03, w, c, loc=(0, y, h), rot=(0, math.pi / 2, 0), mat=pipe, verts=8, parent=root)
    _canopy_roof(c, root, w + 0.3, d + 0.3, h + 0.04, h + 0.76, canvas)
    # Red valance around the eave.
    red = M.fabric("tent_red", "#C8392B", 0.3)
    U.box("headquarters.valance", (w + 0.32, 0.02, 0.22), c, base=(0, -(d + 0.3) / 2, h - 0.16), mat=red, parent=root)
    U.box("headquarters.valance", (w + 0.32, 0.02, 0.22), c, base=(0, (d + 0.3) / 2, h - 0.16), mat=red, parent=root)
    for s in (-1, 1):
        U.box("headquarters.valance", (0.02, d + 0.32, 0.22), c, base=(s * (w + 0.3) / 2, 0, h - 0.16), mat=red, parent=root)
    # Red-and-white curtain on three sides.
    drop = 1.42
    back = props.textured_panel("headquarters.curtain_back", c, (w - 0.1, drop), "kohaku", loc=(0, d / 2 - 0.1, drop / 2 + 0.02), parent=root)
    back.modifiers.new("Solidify", "SOLIDIFY").thickness = 0.012
    for s, facing in ((-1, "+X"), (1, "-X")):
        side = props.textured_panel("headquarters.curtain_side", c, (d - 0.2, drop), "kohaku", loc=(s * (w / 2 - 0.1), 0, drop / 2 + 0.02),
                                    facing=facing, parent=root)
        side.modifiers.new("Solidify", "SOLIDIFY").thickness = 0.012
    # Long table with a white cloth.
    U.box("headquarters.table", (3.7, 0.74, 0.03), c, base=(0, -0.55, 0.62), mat=M.fabric("table_cloth", "#F7F3E8", 0.2), parent=root)
    U.box("headquarters.table_skirt", (3.7, 0.015, 0.5), c, base=(0, -0.925, 0.13), mat=M.fabric("table_cloth", "#F7F3E8", 0.2), parent=root)
    for sx in (-1, 1):
        for sy in (-1, 1):
            U.box("headquarters.table_leg", (0.04, 0.04, 0.62), c, base=(sx * 1.75, -0.55 + sy * 0.3, 0), mat=pipe, parent=root)
    # On the table: megaphone, clipboards, a radio, a first-aid box, and a hand bell.
    _megaphone(c, root, (-0.62, -0.62, 0.74), rot=(0.1, 0, 0.5))
    for x in (-1.32, 0.2):
        U.box("headquarters.clipboard", (0.26, 0.34, 0.012), c, base=(x, -0.58, 0.65), mat=_top(), parent=root)
        U.box("headquarters.paper", (0.22, 0.28, 0.004), c, base=(x, -0.6, 0.662), mat=M.flat("paper_#F7F1E3", "#F7F1E3", 0.85), parent=root)
    U.box("headquarters.radio", (0.09, 0.05, 0.2), c, base=(0.68, -0.68, 0.65), mat=M.flat("radio", "#2B2F38", 0.4), bev=0.008, parent=root)
    U.cylinder("headquarters.radio_antenna", 0.006, 0.16, c, base=(0.71, -0.68, 0.85), mat=M.flat("radio", "#2B2F38", 0.4), verts=5, parent=root)
    U.box("headquarters.aid_box", (0.42, 0.28, 0.22), c, base=(1.3, -0.6, 0.65), mat=M.flat("aid_white", "#F7F4EA", 0.5), bev=0.012, parent=root)
    green = M.flat("aid_green", "#2F8A5A", 0.5)
    U.box("headquarters.aid_cross", (0.05, 0.006, 0.16), c, base=(1.3, -0.742, 0.68), mat=green, parent=root)
    U.box("headquarters.aid_cross", (0.16, 0.006, 0.05), c, base=(1.3, -0.742, 0.735), mat=green, parent=root)
    for x in (-1.1, 0.0, 1.1):
        _folding_chair(c, root, (x, 0.3, 0), 0.0)
    # Water jug at the side.
    U.cylinder("headquarters.jug", 0.14, 0.34, c, base=(2.15, -0.2, 0.02), mat=M.flat("jug", "#3F87C8", 0.4), verts=12, bev=0.01, parent=root)
    # Loudspeaker mast behind the tent, flag on top.
    mast_x, mast_y = w / 2 + 0.34, d / 2 - 0.2
    U.cylinder("headquarters.mast", 0.05, 4.2, c, base=(mast_x, mast_y, 0), mat=pipe, verts=8, parent=root)
    horn = M.flat("horn_grey", "#AEB2B8", 0.4)
    for a, z in ((-2.2, 3.56), (-1.0, 3.56), (-1.6, 3.24)):
        U.lathe("headquarters.horn", [(0.03, 0.0), (0.05, 0.06), (0.22, 0.34), (0.2, 0.34), (0.0, 0.08)], c, segs=12,
                loc=(mast_x, mast_y, z), rot=(math.pi / 2 + 0.2, 0, a), mat=horn, parent=root)
    U.cylinder("headquarters.flagpole", 0.012, 0.7, c, base=(mast_x, mast_y, 4.2), mat=_dark(), verts=6, parent=root)
    _plate("headquarters.flag", c, root, [(0, 0), (0.7, 0.14), (0, 0.32)], 0.006, (mast_x, mast_y, 4.56), rot=(0, 0, math.pi),
           mat=M.fabric("tent_red", "#C8392B", 0.3))
    # Guy ropes out to pegs.
    rope = M.flat("cord", "#3A2A20", 0.8)
    for sx in (-1, 1):
        for sy in (-1, 1):
            p0 = Vector((sx * (w / 2 - 0.02), sy * (d / 2 - 0.02), h))
            p1 = Vector((sx * (w / 2 + 0.8), sy * (d / 2 + 0.75), 0.02))
            dd = p1 - p0
            U.cylinder("headquarters.guy", 0.007, dd.length, c, loc=(p0 + p1) / 2, rot=dd.to_track_quat("Z", "Y").to_euler(), mat=rope, verts=4, parent=root)
            U.cylinder("headquarters.peg", 0.02, 0.12, c, base=(p1.x, p1.y, 0), mat=_dark(), verts=6, parent=root)
    _sign("headquarters", c, root, (0, -(d + 0.3) / 2 - 0.14, h + 0.56), size=0.8, tilt=0.2)
    _lamp("headquarters", c, root, shells, (-1.42, -1.72, h + 0.42), radius=0.3, height=0.68, cord=0.28)
    _lamp("headquarters", c, root, shells, (1.42, -1.72, h + 0.42), radius=0.3, height=0.68, cord=0.28)
    for x in (-1.42, 1.42):
        U.box("headquarters.lamp_arm", (0.05, 0.3, 0.05), c, base=(x, -1.6, h + 0.42), mat=_dark(), parent=root)
    _pool(c, root, shells, loc=(0, -1.75), size=(4.6, 2.0))
    return [((-1.2, -0.7, 1.95), 30, WARM), ((1.2, -0.7, 1.95), 30, WARM)]


BUILDERS = {"access": access, "lodging": lodging, "etiquette": etiquette, "food": food, "weather": weather,
            "headquarters": headquarters}


def build(role, root, coll, shells):
    """Build stall `role` under `root`. Returns light specs in its local axes: (point, power, color)."""
    return BUILDERS[role](root, coll, shells)
