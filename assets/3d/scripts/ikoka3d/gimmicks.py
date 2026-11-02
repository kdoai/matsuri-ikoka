"""Things in the shop that move when used, and a few hidden surprises.

Every gimmick is a small node tree under a root empty marked `ikoka_dynamic`.
Its meshes are baked but never joined, so the app can find them by name,
and each motion is stored as an NLA track that exports as a glTF animation
named `gimmick.<name>.<action>` (see README for the list and how to play
them). Clocks, hidden chicks and seats have no clip: the app moves or
detects them itself.
"""

import math

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

from . import materials as M
from . import palette as P
from . import props
from . import textures as T
from . import util as U

FPS = 30


def root(name, coll, loc, yaw=0.0, group="gimmicks"):
    e = U.empty(name, coll, loc=loc, rot=(0, 0, yaw), size=0.08)
    e["ikoka_dynamic"] = True
    e["ikoka_bake_group"] = group
    return e


def pivot(name, coll, parent, loc=(0, 0, 0), rot=(0, 0, 0)):
    e = U.empty(name, coll, loc=loc, rot=rot, size=0.04)
    e.parent = parent
    return e


def _ease(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def _env(t, a, b):
    """0 before a, eased 0->1 between a and b, 1 after."""
    return _ease((t - a) / max(b - a, 1e-6))


def _decay(t, start, freq, damp):
    if t < start:
        return 0.0
    x = t - start
    return math.sin(2 * math.pi * freq * x) * math.exp(-damp * x)


def clip(obj, track, duration, fn):
    """Key `obj` from fn(t) -> {loc, rot (deg), scale} offsets over `duration` s; store as NLA track `track`."""
    loc0, rot0, scl0 = obj.location.copy(), obj.rotation_euler.copy(), obj.scale.copy()
    act = bpy.data.actions.new(f"{track}|{obj.name}")
    obj.animation_data_create()
    obj.animation_data.action = act
    frames = max(1, round(duration * FPS))
    for f in range(frames + 1):
        d = fn(f / frames)
        obj.location = loc0 + Vector(d.get("loc", (0, 0, 0)))
        r = d.get("rot", (0, 0, 0))
        obj.rotation_euler = Euler([rot0[i] + math.radians(r[i]) for i in range(3)], obj.rotation_euler.order)
        s = d.get("scale", (1, 1, 1))
        s = s if hasattr(s, "__len__") else (s,) * 3
        obj.scale = Vector([scl0[i] * s[i] for i in range(3)])
        for path in ("location", "rotation_euler", "scale"):
            obj.keyframe_insert(path, frame=f + 1)
    obj.location, obj.rotation_euler, obj.scale = loc0, rot0, scl0
    tr = obj.animation_data.nla_tracks.new()
    tr.name = track
    strip = tr.strips.new(track, 1, act)
    if act.slots:
        strip.action_slot = act.slots[0]
    obj.animation_data.action = None
    return act


def _wood():
    return M.wood("wood_dark", P.WOOD_DARK)


# --------------------------------------------------------------------------
# Counter: call bell


def bell(c, loc):
    r = root("gimmick.bell", c, loc)
    a = pivot("gimmick.bell.anim", c, r)
    b = props.call_bell("gimmick.bell.parts", c)
    b.parent = a
    clip(a, "gimmick.bell.ring", 0.9, lambda t: {
        "rot": (7 * _decay(t, 0.08, 6, 5), 5 * _decay(t, 0.1, 5, 5), 0),
        "scale": (1, 1, 1 - 0.12 * math.exp(-((t - 0.05) / 0.04) ** 2))})
    return r


# --------------------------------------------------------------------------
# Commemorative stamp table


def stamp_table(c, loc, yaw=0.0):
    r = U.empty("stamp_table", c, loc=loc, rot=(0, 0, yaw), size=0.1)
    props.table("stamp_table.table", c, size=(0.62, 0.42, 0.62), loc=(0, 0, 0)).parent = r
    props.textured_panel("stamp_table.sign", c, (0.18, 0.36), "stamp_sign", loc=(0.22, 0.12, 0.82),
                         parent=r).rotation_euler = (math.pi / 2 - 0.15, 0, 0)
    U.box("stamp_table.sign_back", (0.2, 0.02, 0.38), c, base=(0.22, 0.14, 0.62), rot=(-0.15, 0, 0), mat=_wood(),
          parent=r)
    U.box("stamp_table.pad", (0.11, 0.08, 0.025), c, base=(-0.2, 0.05, 0.62), mat=M.flat("ink_pad", "#B8453A", 0.6),
          bev=0.004, parent=r)
    U.box("stamp_table.sheet", (0.2, 0.26, 0.004), c, base=(0.0, -0.06, 0.62),
          mat=M.flat("paper_#F7F1E3", "#F7F1E3", 0.85), parent=r)
    g = root("gimmick.stamp", c, (0, 0, 0))
    g.parent = r
    g.location = (-0.2, 0.05, 0.645)
    wood = _wood()
    stamp = U.join([U.sphere("stamp.knob", 0.026, c, loc=(0, 0, 0.1), mat=wood, segs=12, rings=8),
                    U.cylinder("stamp.neck", 0.014, 0.06, c, base=(0, 0, 0.045), mat=wood, verts=10),
                    U.cylinder("stamp.body", 0.034, 0.045, c, base=(0, 0, 0.0),
                               mat=M.wood("wood_counter_top", P.WOOD_LIGHT), verts=16, bev=0.004)], "gimmick.stamp.stamp")
    stamp.parent = g
    mark = U.plane("gimmick.stamp.mark", (0.12, 0.12), c, loc=(0.2, -0.11, -0.016),
                   mat=M.textured("tex_stamp_mark", "stamp_mark", 0.8, alpha=True), parent=g)
    mark.scale = (0.001, 0.001, 1)
    # Lift, move over the sheet, press, return.
    def move(t):
        lift = 0.14 * (_env(t, 0.0, 0.18) - _env(t, 0.42, 0.5) + _env(t, 0.62, 0.72) - _env(t, 0.86, 1.0))
        over = _env(t, 0.15, 0.38) - _env(t, 0.68, 0.9)
        return {"loc": (0.2 * over, -0.11 * over, lift), "rot": (0, 0, 20 * over)}
    clip(stamp, "gimmick.stamp.press", 2.2, move)
    clip(mark, "gimmick.stamp.press", 2.2, lambda t: {"scale": (1000 * _env(t, 0.5, 0.52) + 1 - _env(t, 0.5, 0.52),) * 2 + (1,)})
    return r


# --------------------------------------------------------------------------
# Omikuji (fortune) box on a stand


def omikuji(c, loc, yaw=0.0):
    stand = U.empty("omikuji", c, loc=loc, rot=(0, 0, yaw), size=0.1)
    U.box("omikuji.stand", (0.32, 0.32, 0.72), c, base=(0, 0, 0), mat=M.wood("wood_counter", P.WOOD), bev=0.01,
          parent=stand)
    U.box("omikuji.top", (0.38, 0.38, 0.04), c, base=(0, 0, 0.72), mat=_wood(), bev=0.008, parent=stand)
    r0 = root("gimmick.omikuji", c, (0, 0, 0))
    r0.parent = stand
    r0.location = (0, 0, 0.76)
    r = pivot("gimmick.omikuji.anim", c, r0)
    box = U.lathe("gimmick.omikuji.box", [(0.0, 0.0), (0.075, 0.0), (0.075, 0.26), (0.0, 0.26)], c, segs=6,
                  mat=M.textured("tex_omikuji", "omikuji", 0.7), parent=r)
    U.cylinder("gimmick.omikuji.hole", 0.012, 0.004, c, base=(0, 0, 0.26), mat=M.flat("hole", "#1A1210", 0.9),
               verts=10, parent=r)
    stick = U.join([U.box("stick", (0.012, 0.012, 0.14), c, base=(0, 0, 0), mat=M.flat("stick_wood", "#D9B77A", 0.8)),
                    U.box("stick_tip", (0.013, 0.013, 0.025), c, base=(0, 0, 0.115), mat=M.flat("stick_red", "#C8473C", 0.6))],
                   "gimmick.omikuji.stick")
    stick.parent = r
    stick.location = (0, 0, 0.12)
    _ = box
    clip(r, "gimmick.omikuji.shake", 2.0, lambda t: {"rot": (22 * math.sin(2 * math.pi * 3 * t) * (1 - _env(t, 0.55, 0.7)),
                                                             10 * math.sin(2 * math.pi * 2 * t) * (1 - _env(t, 0.5, 0.7)), 0)})
    clip(stick, "gimmick.omikuji.shake", 2.0, lambda t: {"loc": (0, 0, 0.11 * _env(t, 0.65, 0.85))})
    return stand


# --------------------------------------------------------------------------
# Capsule toy machine


def gachapon(c, loc, yaw=0.0):
    r = root("gimmick.gacha", c, loc, yaw)
    red = M.flat("gacha_red", "#D9473C", 0.4)
    U.box("gimmick.gacha.base", (0.36, 0.34, 0.55), c, base=(0, 0, 0), mat=red, bev=0.03, seg=3, parent=r)
    props.textured_panel("gimmick.gacha.label", c, (0.26, 0.26), "gachapon", loc=(0, -0.172, 0.36), parent=r)
    U.box("gimmick.gacha.chute", (0.12, 0.06, 0.09), c, base=(0, -0.18, 0.06), mat=M.flat("gacha_dark", "#3A2A28", 0.6),
          bev=0.01, parent=r)
    glass = M.flat("gacha_glass", "#DDEEFF", 0.05)
    glass.node_tree.nodes["Principled BSDF"].inputs["Alpha"].default_value = 0.35
    glass.surface_render_method = "BLENDED"
    U.sphere("gimmick.gacha.dome", 0.19, c, loc=(0, 0, 0.72), mat=glass, segs=24, rings=14, parent=r)
    U.cylinder("gimmick.gacha.cap", 0.06, 0.04, c, base=(0, 0, 0.89), mat=red, verts=16, parent=r)
    cols = ["#E8574F", "#4E86B8", "#6FA35A", "#F2A33A", "#E9A6C4", "#F6D56A"]
    k = 0
    for layer, z in enumerate((0.6, 0.67, 0.74)):
        for i in range(6 - layer):
            a = 2 * math.pi * i / (6 - layer) + layer
            rr = 0.11 - layer * 0.02
            U.sphere("gimmick.gacha.capsule", 0.045, c, loc=(math.cos(a) * rr, math.sin(a) * rr, z),
                     mat=M.flat(f"capsule_{cols[k % 6]}", cols[k % 6], 0.3), segs=12, rings=8, parent=r)
            k += 1
    handle = pivot("gimmick.gacha.handle", c, r, loc=(0, -0.175, 0.2), rot=(math.pi / 2, 0, 0))
    U.cylinder("gimmick.gacha.knob", 0.05, 0.03, c, base=(0, 0, 0), mat=M.flat("gacha_metal", "#D8D4CC", 0.3, 0.8),
               verts=16, parent=handle)
    U.box("gimmick.gacha.bar", (0.09, 0.02, 0.02), c, base=(0, 0, 0.03), mat=M.flat("gacha_metal", "#D8D4CC", 0.3, 0.8),
          parent=handle)
    capsule = U.sphere("gimmick.gacha.prize", 0.04, c, loc=(0, -0.17, 0.1), mat=M.flat("capsule_#F6D56A", "#F6D56A", 0.3),
                       segs=12, rings=8, parent=r)
    capsule.scale = (0.001,) * 3
    clip(handle, "gimmick.gacha.turn", 2.4, lambda t: {"rot": (0, 0, -360 * _env(t, 0.05, 0.5))})
    clip(capsule, "gimmick.gacha.turn", 2.4, lambda t: {
        "scale": (1 + 999 * _env(t, 0.5, 0.52),) * 3,
        "loc": (0, -0.22 * _env(t, 0.52, 0.8), -0.06 * _env(t, 0.52, 0.62) + 0.02 * abs(_decay(t, 0.62, 3, 6)))})
    return r


# --------------------------------------------------------------------------
# Daruma that wobbles


def daruma(c, loc, yaw=0.0, size=1.0):
    r0 = root("gimmick.daruma", c, loc, yaw)
    r = pivot("gimmick.daruma.anim", c, r0)
    s = size
    U.lathe("gimmick.daruma.body", [(0.0, 0.0), (0.05 * s, 0.003), (0.085 * s, 0.03 * s), (0.095 * s, 0.07 * s),
                                    (0.085 * s, 0.115 * s), (0.06 * s, 0.15 * s), (0.0, 0.165 * s)], c, segs=20,
            mat=M.textured("tex_daruma", "daruma", 0.5), parent=r)
    clip(r, "gimmick.daruma.wobble", 2.2, lambda t: {"rot": (18 * _decay(t, 0.0, 1.6, 2.2), 9 * _decay(t, 0.05, 1.3, 2.5), 0)})
    return r0


# --------------------------------------------------------------------------
# Sleeping calico cat


def cat(c, loc, yaw=0.0):
    r0 = root("gimmick.cat", c, loc, yaw)
    r = pivot("gimmick.cat.anim", c, r0)
    body_mat = M.textured("tex_cat", "cat", 0.9, sheen=0.4)
    body = U.sphere("gimmick.cat.body", 1.0, c, loc=(0, 0.02, 0.11), mat=body_mat, segs=24, rings=14, parent=r)
    U.apply_scale(body, (0.16, 0.24, 0.11))
    props.sphere_uv(body)
    head_p = pivot("gimmick.cat.head", c, r, loc=(0.02, -0.17, 0.1))
    head = U.sphere("gimmick.cat.face", 0.095, c, loc=(0, -0.04, 0.03), mat=M.textured("tex_cat_head", "cat_head", 0.9),
                    segs=20, rings=12, parent=head_p)
    props.sphere_uv(head)
    ear_mat = M.felt("cat_ear", "#E39A4F", 0.3)
    ears = []
    for sx in (-1, 1):
        bm = bmesh.new()
        bm.loops.layers.uv.new("UVMap")
        bmesh.ops.create_cone(bm, cap_ends=True, segments=8, radius1=0.035, radius2=0.004, depth=0.06, calc_uvs=True)
        ear = U.mesh_object("gimmick.cat.ear", bm, c, ear_mat if sx < 0 else M.felt("cat_ear_white", "#F7F1E6", 0.3),
                            smooth=True, parent=head_p)
        ear.location = (sx * 0.05, -0.03, 0.115)
        ear.rotation_euler = (0.2, sx * 0.35, 0)
        ears.append(ear)
    tail_p = pivot("gimmick.cat.tail", c, r, loc=(0.1, 0.2, 0.05))
    pts = [(0, 0, 0)]
    for i in range(1, 9):
        a = i / 8 * 2.2
        pts.append((0.1 - 0.12 * math.cos(a), -0.1 * math.sin(a) * 1.4, 0.01 * i))
    tube = _tube_mesh("gimmick.cat.tail_mesh", c, pts, 0.028, M.felt("cat_tail", "#3A302C", 0.3))
    tube.parent = tail_p
    clip(r, "gimmick.cat.sleep", 3.0, lambda t: {"scale": (1 + 0.025 * math.sin(2 * math.pi * t), 1, 1 + 0.035 * math.sin(2 * math.pi * t))})
    clip(tail_p, "gimmick.cat.sleep", 3.0, lambda t: {"rot": (0, 0, 8 * math.sin(2 * math.pi * t + 1))})
    clip(head_p, "gimmick.cat.pet", 2.4, lambda t: {"rot": (-24 * (_env(t, 0.05, 0.3) - _env(t, 0.75, 1.0)), 0,
                                                            10 * math.sin(2 * math.pi * 2 * t) * (_env(t, 0.3, 0.4) - _env(t, 0.7, 0.8))),
                                                    "loc": (0, 0, 0.03 * (_env(t, 0.05, 0.3) - _env(t, 0.75, 1.0)))})
    for k, ear in enumerate(ears):
        clip(ear, "gimmick.cat.pet", 2.4, lambda t, k=k: {"rot": (14 * abs(_decay(t, 0.3 + 0.08 * k, 4, 6)), 0, 0)})
    clip(tail_p, "gimmick.cat.pet", 2.4, lambda t: {"rot": (-30 * (_env(t, 0.2, 0.45) - _env(t, 0.8, 1.0)), 0,
                                                            15 * math.sin(2 * math.pi * 1.5 * t))})
    return r0


def _tube_mesh(name, c, pts, radius, mat, verts=8):
    bm = bmesh.new()
    bm.loops.layers.uv.new("UVMap")
    rings = []
    pts = [Vector(p) for p in pts]
    for i, p in enumerate(pts):
        d = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        q = d.to_track_quat("Z", "Y")
        rr = radius * (1 - 0.5 * i / (len(pts) - 1))
        rings.append([bm.verts.new(p + q @ Vector((rr * math.cos(2 * math.pi * k / verts),
                                                     rr * math.sin(2 * math.pi * k / verts), 0))) for k in range(verts)])
    for a, b in zip(rings, rings[1:]):
        for k in range(verts):
            bm.faces.new((a[k], a[(k + 1) % verts], b[(k + 1) % verts], b[k]))
    bm.faces.new(rings[-1])
    bm.faces.new(rings[0][::-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return U.mesh_object(name, bm, c, mat, smooth=True)


# --------------------------------------------------------------------------
# Spinning globe


def globe(c, loc, r_=0.12):
    r = root("gimmick.globe", c, loc)
    brass = M.flat("brass", P.GOLD, 0.25, metal=1.0)
    U.cylinder("gimmick.globe.base", 0.08, 0.03, c, base=(0, 0, 0), mat=_wood(), verts=20, bev=0.005, parent=r)
    U.cylinder("gimmick.globe.stem", 0.012, 0.08, c, base=(0, 0, 0.03), mat=brass, verts=8, parent=r)
    U.torus("gimmick.globe.ring", r_ + 0.012, 0.005, c, loc=(0, 0, 0.11 + r_), rot=(math.pi / 2, 0.4, 0), mat=brass,
            major_segs=28, minor_segs=4, parent=r)
    spin = pivot("gimmick.globe.ball", c, r, loc=(0, 0, 0.11 + r_), rot=(0.4, 0, 0))
    spin.rotation_mode = "ZXY"
    ball = U.sphere("gimmick.globe.ball_mesh", r_, c, mat=M.textured("tex_globe", "globe", 0.4), segs=24, rings=14,
                    parent=spin)
    props.sphere_uv(ball)
    clip(spin, "gimmick.globe.spin", 2.5, lambda t: {"rot": (0, 0, 360 * (1 - (1 - t) ** 2.2))})
    return r


# --------------------------------------------------------------------------
# Secret book that opens a hidden drawer with a golden ticket


def secret_book(c, book_loc, drawer_loc, book_h=0.3):
    r = root("gimmick.secret", c, (0, 0, 0))
    bp = pivot("gimmick.secret.book", c, r, loc=book_loc)
    U.box("gimmick.secret.book_mesh", (0.05, 0.27, book_h), c, base=(0, 0.135, 0), mat=M.flat("secret_red", "#B8302A", 0.6),
          parent=bp)
    for z in (0.04, book_h - 0.06):
        U.box("gimmick.secret.band", (0.052, 0.005, 0.012), c, base=(0, -0.001, z), mat=M.flat("brass", P.GOLD, 0.25, 1.0),
              parent=bp)
    dp = pivot("gimmick.secret.drawer", c, r, loc=drawer_loc)
    wood = M.wood("wood_dark", P.WOOD_DARK)
    U.box("gimmick.secret.drawer_front", (0.5, 0.02, 0.07), c, base=(0, -0.01, 0.0), mat=wood, bev=0.004, parent=dp)
    U.box("gimmick.secret.drawer_bottom", (0.46, 0.28, 0.01), c, base=(0, 0.14, 0.005), mat=wood, parent=dp)
    U.cylinder("gimmick.secret.knob", 0.012, 0.015, c, loc=(0, -0.025, 0.035), rot=(math.pi / 2, 0, 0),
               mat=M.flat("brass", P.GOLD, 0.25, 1.0), verts=10, parent=dp)
    ticket = props.textured_panel("gimmick.secret.ticket", c, (0.2, 0.1), "golden_ticket", loc=(0, 0.12, 0.012),
                                  facing="+Z", parent=dp, emission=0.0)
    ticket.rotation_euler = (0, 0, 0.15)
    clip(bp, "gimmick.secret.open", 2.4, lambda t: {"rot": (28 * _env(t, 0.0, 0.2) - 28 * _env(t, 0.55, 0.75), 0, 0)})
    clip(dp, "gimmick.secret.open", 2.4, lambda t: {"loc": (0, -0.26 * _env(t, 0.3, 0.6), 0)})
    return r


# --------------------------------------------------------------------------
# Staff gate (swings open for staff)


def staff_gate(c, hinge, width, yaw=0.0):
    r0 = root("gimmick.gate", c, hinge, yaw)
    r = pivot("gimmick.gate.anim", c, r0)
    wood = M.wood("wood_counter", P.WOOD)
    dark = _wood()
    U.box("gimmick.gate.top", (width, 0.04, 0.05), c, base=(-width / 2, 0, 0.68), mat=dark, bev=0.006, parent=r)
    U.box("gimmick.gate.bottom", (width, 0.04, 0.05), c, base=(-width / 2, 0, 0.1), mat=dark, bev=0.006, parent=r)
    n = int(width / 0.075)
    for i in range(n + 1):
        U.box("gimmick.gate.slat", (0.025, 0.03, 0.58), c, base=(-width * i / n, 0, 0.1), mat=wood, parent=r)
    props.textured_panel("gimmick.gate.sign", c, (0.4, 0.15), "staff_only", loc=(-width / 2, -0.03, 0.5), parent=r)
    clip(r, "gimmick.gate.swing", 2.0, lambda t: {"rot": (0, 0, -85 * (_env(t, 0.0, 0.25) - _env(t, 0.65, 0.85))
                                                         - 6 * _decay(t, 0.85, 2.5, 6))})
    return r0


# --------------------------------------------------------------------------
# Wind chime, clock hands, hidden chicks


def furin(c, loc):
    r0 = root("gimmick.furin", c, loc)
    r = pivot("gimmick.furin.anim", c, r0)
    U.cylinder("gimmick.furin.string", 0.002, 0.12, c, base=(0, 0, -0.12), mat=M.flat("cord", "#3A2A20", 0.8), verts=4,
               parent=r)
    U.lathe("gimmick.furin.bell", [(0.0, -0.12), (0.035, -0.125), (0.05, -0.16), (0.052, -0.19), (0.0, -0.19)], c,
            segs=16, mat=M.flat("furin_glass", "#BFE2F0", 0.1), parent=r)
    U.box("gimmick.furin.strip", (0.05, 0.003, 0.14), c, base=(0, 0, -0.36), mat=M.flat("furin_paper", "#F2D7A0", 0.8),
          parent=r)
    clip(r, "gimmick.furin.ring", 2.0, lambda t: {"rot": (16 * _decay(t, 0.0, 1.8, 2.5), 8 * _decay(t, 0.1, 1.4, 2.5), 0)})
    return r0


def clock_hands(c, center):
    """Hour and minute hands; rotate them about the wall normal to show the real time."""
    r = root("clock", c, center)
    ink = M.flat("clock_ink", "#2B2220", 0.5)
    for name, length, width in (("hour", 0.075, 0.016), ("minute", 0.11, 0.01)):
        h = pivot(f"clock.hand.{name}", c, r, loc=(0, -0.006 if name == "minute" else -0.003, 0))
        U.box(f"clock.hand.{name}.mesh", (width, 0.004, length), c, base=(0, 0, -0.015), mat=ink, parent=h)
    U.cylinder("clock.pin", 0.012, 0.012, c, loc=(0, -0.008, 0), rot=(math.pi / 2, 0, 0), mat=M.flat("clock_red", "#C8473C", 0.5),
               verts=12, parent=r)
    return r


def hidden_chick(c, name, loc, yaw=0.0):
    r = root(f"secret.chick.{name}", c, loc, yaw)
    yellow = M.felt("mini_chick", P.CHICK, 0.3)
    U.sphere(f"secret.chick.{name}.body", 0.03, c, loc=(0, 0, 0.028), scale=(1, 0.9, 0.95), mat=yellow, segs=12, rings=8,
             parent=r)
    U.sphere(f"secret.chick.{name}.head", 0.026, c, loc=(0, -0.005, 0.07), mat=yellow, segs=12, rings=8, parent=r)
    U.cylinder(f"secret.chick.{name}.beak", 0.008, 0.016, c, loc=(0, -0.034, 0.066), rot=(math.pi / 2, 0, 0),
               radius2=0.0, mat=M.flat("mini_beak", "#F59A28", 0.5), verts=8, parent=r)
    for sx in (-1, 1):
        U.sphere(f"secret.chick.{name}.eye", 0.0045, c, loc=(sx * 0.011, -0.023, 0.077), mat=M.flat("mini_eye", P.EYE, 0.3),
                 segs=6, rings=4, parent=r)
    return r
