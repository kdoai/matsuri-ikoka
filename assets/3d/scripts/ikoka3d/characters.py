"""The four staff (hiyoko: concierge, owl: researcher, hen: scout,
sparrow: planner) and the traveler penguin the user plays.

All five share one body plan (about 1 m tall: a big round head on a small
round body in an indigo happi) and the rig in `rig.py`. Parts are rigid
meshes parented to bones. The face (eyes, cheeks) is a texture decal: its
mesh is named `<kind>.face` and shows cell 0 of `textures.paint_faces`; the
app switches expression by offsetting that texture. Props are named
`prop.<name>`, parented to a hand bone, and are meant to start hidden.
"""

import math

import bmesh
import bpy
from mathutils import Matrix, Vector

from . import materials as M
from . import palette as P
from . import props
from . import rig
from . import textures as T
from . import util as U

HEAD_C = Vector((0, 0, 0.68))
HEAD_R = (0.335, 0.31, 0.305)
BODY_C = Vector((0, 0, 0.29))
BODY_R = (0.285, 0.255, 0.28)
HAPPI_Z = (0.13, 0.53)
OPEN_DEG = 22.0

SPECIES = {
    "hiyoko": {"color": P.CHICK, "beak": "#F59A28", "feet": "#F59A28", "role": "concierge"},
    "owl": {"color": P.OWL, "beak": "#F0A630", "feet": "#F0A630", "role": "researcher"},
    "hen": {"color": P.HEN, "beak": "#F5A62A", "feet": "#F59A28", "role": "scout"},
    "sparrow": {"color": P.SPARROW, "beak": "#F2A93B", "feet": "#E89A3A", "role": "planner"},
    "penguin": {"color": P.PENGUIN, "beak": "#F59A28", "feet": "#F59A28", "role": "player", "happi": False},
}


# --------------------------------------------------------------------------
# Geometry helpers


def _ellipsoid_bm(radii, segs=32, rings=18):
    bm = bmesh.new()
    bm.loops.layers.uv.new("UVMap")
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=1.0, calc_uvs=True)
    bmesh.ops.scale(bm, vec=Vector(radii), verts=bm.verts)
    return bm


def _ellipsoid(name, coll, center, radii, mat, segs=32, rings=18, rot=(0, 0, 0)):
    obj = U.mesh_object(name, _ellipsoid_bm(radii, segs, rings), coll, mat, smooth=True)
    obj.location = center
    obj.rotation_euler = rot
    return obj


def _along(name, coll, bm, start, direction, mat, roll=0.0):
    """Mesh built along +Z, placed at `start` with +Z turned to `direction`."""
    obj = U.mesh_object(name, bm, coll, mat, smooth=True)
    q = Vector(direction).normalized().to_track_quat("Z", "Y")
    obj.matrix_world = Matrix.Translation(start) @ q.to_matrix().to_4x4() @ Matrix.Rotation(roll, 4, "Z")
    return obj


def _lathe_bm(profile, segs=16, uv_v=None):
    """Revolve (radius, z) around Z with cylindrical UVs (u around, v = z or uv_v(z))."""
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    rings = []
    for r, z in profile:
        if r <= 1e-6:
            rings.append([bm.verts.new((0, 0, z))])
        else:
            rings.append([bm.verts.new((r * math.cos(2 * math.pi * i / segs), r * math.sin(2 * math.pi * i / segs), z))
                          for i in range(segs)])
    for a, b in zip(rings, rings[1:]):
        if len(a) == 1 and len(b) == 1:
            continue
        for i in range(segs):
            j = (i + 1) % segs
            if len(a) == 1:
                corners = [(a[0], i + 0.5), (b[i], i), (b[j], i + 1)]
            elif len(b) == 1:
                corners = [(a[i], i), (b[0], i + 0.5), (a[j], i + 1)]
            else:
                corners = [(a[i], i), (b[i], i), (b[j], i + 1), (a[j], i + 1)]
            f = bm.faces.new([v for v, _ in corners])
            for loop, (v, k) in zip(f.loops, corners):
                loop[uv].uv = (k / segs, uv_v(v.co.z) if uv_v else v.co.z)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def _teardrop_bm(length, radius, segs=12):
    prof = [(0.0, 0.0)]
    for i in range(1, 9):
        t = i / 8
        prof.append((radius * math.sin(math.pi * t ** 0.8) * (1 - t * 0.35), length * t))
    prof.append((0.0, length))
    return _lathe_bm(prof, segs)


def _felt(kind, part):
    tex = f"{part}_{kind}"
    name = f"staff_{tex}"
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = M.textured(name, tex, rough=0.85, sheen=0.25)
    return mat


# --------------------------------------------------------------------------
# Parts


def _head(kind, c):
    head = _ellipsoid(f"{kind}.head", c, HEAD_C, HEAD_R, _felt(kind, "head"), segs=36, rings=20)
    props.sphere_uv(head)
    return head


def _body(kind, c):
    body = _ellipsoid(f"{kind}.body", c, BODY_C, BODY_R, _felt(kind, "body"), segs=32, rings=16)
    props.sphere_uv(body)
    return body


def _face(kind, c):
    """Decal patch over the front of the head, mapped onto face-atlas cell 0."""
    mat = bpy.data.materials.get("staff_face") or M.textured("staff_face", "faces", rough=0.4, alpha=True,
                                                             offset_uv=True)
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    nu, nv = 18, 16
    lat0, lat1 = T.FACE_LAT
    grid = []
    for j in range(nv + 1):
        lat = math.radians(lat0 + (lat1 - lat0) * j / nv)
        row = []
        for i in range(nu + 1):
            lon = math.radians(-T.FACE_LON + 2 * T.FACE_LON * i / nu)
            d = Vector((HEAD_R[0] * math.cos(lat) * math.sin(lon), -HEAD_R[1] * math.cos(lat) * math.cos(lon),
                        HEAD_R[2] * math.sin(lat)))
            row.append(bm.verts.new(d * 1.012))
        grid.append(row)
    for j in range(nv):
        for i in range(nu):
            f = bm.faces.new((grid[j][i], grid[j + 1][i], grid[j + 1][i + 1], grid[j][i + 1]))
            for loop, (di, dj) in zip(f.loops, ((0, 0), (0, 1), (1, 1), (1, 0))):
                loop[uv].uv = ((i + di) / nu * 0.25, 0.5 + (j + dj) / nv * 0.5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        if f.normal.y > 0:
            f.normal_flip()
    face = U.mesh_object(f"{kind}.face", bm, c, mat, smooth=True)
    face.location = HEAD_C
    return face


def _beak_bm(width, height, length, droop=0.0, segs=16, rings=7):
    """Rounded wedge pointing along +Z: elliptical section (width x height) tapering to a soft tip."""
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    loops = []
    for j in range(rings + 1):
        t = j / rings
        k = (1 - t ** 1.6) ** 0.85
        z = length * t
        loops.append([bm.verts.new((width * k * math.cos(2 * math.pi * i / segs),
                                    height * k * math.sin(2 * math.pi * i / segs) - droop * t * t, z))
                      for i in range(segs)])
    tip = bm.verts.new((0, -droop, length * 1.02))
    for a, b in zip(loops, loops[1:]):
        for i in range(segs):
            bm.faces.new((a[i], a[(i + 1) % segs], b[(i + 1) % segs], b[i]))
    for i in range(segs):
        bm.faces.new((loops[-1][i], loops[-1][(i + 1) % segs], tip))
    bm.faces.new(loops[0][::-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        for loop in f.loops:
            loop[uv].uv = (0.5, 0.5)
    return bm


def _beak(kind, c, color):
    mat = M.felt(f"staff_beak_{kind}", color, 0.15)
    mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.5
    upper = _along(f"{kind}.beak", c, _beak_bm(0.072, 0.042, 0.105, droop=0.012), Vector((0, -0.272, 0.66)),
                   (0, -1, -0.22), mat)
    lower = _along(f"{kind}.beak_lower", c, _beak_bm(0.056, 0.026, 0.075, droop=-0.004),
                   Vector((0, -0.268, 0.622)), (0, -1, -0.75), mat)
    mouth = _ellipsoid(f"{kind}.mouth", c, Vector((0, -0.284, 0.632)), (0.05, 0.03, 0.032),
                       M.flat("staff_mouth", "#A8343A", 0.6), segs=14, rings=8)
    tongue = _ellipsoid(f"{kind}.tongue", c, Vector((0, -0.3, 0.618)), (0.03, 0.025, 0.012),
                        M.flat("staff_tongue", "#E8747A", 0.6), segs=12, rings=6)
    return upper, lower, U.join([mouth, tongue], f"{kind}.mouth")


def _happi(kind, c):
    mat = bpy.data.materials.get("staff_happi") or M.textured("staff_happi", "happi", rough=0.9, sheen=0.2)
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    z0, z1 = HAPPI_Z
    nz, nth = 10, 40
    th0, th1 = math.radians(180 + OPEN_DEG), math.radians(540 - OPEN_DEG)
    grid = []
    for j in range(nz + 1):
        z = z1 - (z1 - z0) * j / nz
        k = math.sqrt(max(0.0, 1 - ((z - BODY_C.z) / BODY_R[2]) ** 2))
        flare = 0.026 * max(0.0, 1 - (z - z0) / 0.16)
        rx, ry = BODY_R[0] * k + 0.024 + flare, BODY_R[1] * k + 0.024 + flare
        row = []
        for i in range(nth + 1):
            th = th0 + (th1 - th0) * i / nth
            row.append((bm.verts.new((rx * math.sin(th), ry * math.cos(th), z)), th / (2 * math.pi),
                        0.45 * (z - z0) / (z1 - z0)))
        grid.append(row)
    for j in range(nz):
        for i in range(nth):
            quad = (grid[j][i], grid[j + 1][i], grid[j + 1][i + 1], grid[j][i + 1])
            f = bm.faces.new([q[0] for q in quad])
            for loop, q in zip(f.loops, quad):
                loop[uv].uv = (q[1], q[2])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    happi = U.mesh_object(f"{kind}.happi", bm, c, mat, smooth=True)
    sol = happi.modifiers.new("Solidify", "SOLIDIFY")
    sol.thickness = 0.014
    sol.offset = 1.0
    U.apply_modifiers(happi)
    return happi


def _wing(kind, c, side, color_mat, sleeve=True):
    head, tail, _ = rig.BONES[f"wing.{side}"]
    start, end = Vector(head), Vector(tail)
    d = (end - start).normalized()
    wing_bm = _ellipsoid_bm((0.085, 0.048, 0.15), 20, 12)
    bmesh.ops.translate(wing_bm, vec=(0, 0, 0.13), verts=wing_bm.verts)
    wing = _along(f"{kind}.wing.{side}", c, wing_bm, start + Vector((0, 0, 0)), d, color_mat)
    if not sleeve:
        return wing, None
    mat = bpy.data.materials.get("staff_happi")
    prof = [(0.07, -0.02), (0.075, 0.03), (0.08, 0.08), (0.088, 0.13)]
    sleeve_bm = _lathe_bm(prof, 20, uv_v=lambda z: 1.0 - 0.55 * max(0.0, min(1.0, (z + 0.02) / 0.15)))
    sleeve = _along(f"{kind}.sleeve.{side}", c, sleeve_bm, start, d, mat)
    sol = sleeve.modifiers.new("Solidify", "SOLIDIFY")
    sol.thickness = 0.012
    U.apply_modifiers(sleeve)
    return wing, sleeve


def _foot(kind, c, side, color):
    mat = M.felt(f"staff_feet_{kind}", color, 0.3)
    sx = 1 if side == "L" else -1
    root = []
    root.append(_ellipsoid(f"{kind}.foot.{side}", c, Vector((sx * 0.108, -0.045, 0.028)), (0.062, 0.07, 0.03), mat,
                           16, 10))
    for k in (-1, 0, 1):
        root.append(_ellipsoid(f"{kind}.toe.{side}", c, Vector((sx * 0.108 + k * 0.038, -0.105, 0.026)),
                               (0.024, 0.04, 0.024), mat, 12, 8, rot=(0, 0, -k * 0.35)))
    root.append(U.cylinder(f"{kind}.leg.{side}", 0.028, 0.08, c, base=(sx * 0.1, -0.02, 0.04), mat=mat, verts=10))
    return U.join(root, f"{kind}.foot.{side}")


def _tail(kind, c, color_mat):
    parts = []
    spec = {"hiyoko": [(0, 0.12, 0.45)], "owl": [(-0.3, 0.13, 0.4), (0, 0.15, 0.45), (0.3, 0.13, 0.4)],
            "hen": [(-0.35, 0.18, 0.75), (0, 0.21, 0.85), (0.35, 0.18, 0.75)], "penguin": [(0, 0.09, 0.2)],
            "sparrow": [(-0.25, 0.14, 0.3), (0, 0.16, 0.35), (0.25, 0.14, 0.3)]}[kind]
    for tilt, length, up in spec:
        bm = _teardrop_bm(length, 0.045 if kind != "hen" else 0.05)
        d = Vector((math.sin(tilt) * 0.5, 1.0, up))
        parts.append(_along(f"{kind}.tail", c, bm, Vector((0, 0.2, 0.14)), d, color_mat))
    return U.join(parts, f"{kind}.tail")


def _accessories(kind, c):
    """Species features on the head. Returns meshes to attach to the head bone."""
    out = []
    sp = SPECIES[kind]
    if kind == "hiyoko":
        mat = M.felt("staff_tuft_hiyoko", P.mix(P.CHICK, "#F2B53A", 0.35), 0.5)
        for a in (-0.45, 0.0, 0.45):
            bm = _teardrop_bm(0.16 if a == 0 else 0.125, 0.042)
            out.append(_along(f"{kind}.tuft", c, bm, Vector((math.sin(a) * 0.04, 0.02, 0.965)),
                              (math.sin(a) * 0.8, 0.15, 1.0), mat))
        out = [U.join(out, f"{kind}.tuft")]
    elif kind == "hen":
        red = M.felt("staff_comb", P.COMB, 0.4)
        lobes = [_ellipsoid(f"{kind}.comb", c, Vector((0, y, z)), (0.045, r, r * 1.1), red, 16, 10)
                 for y, z, r in ((-0.1, 0.98, 0.06), (-0.02, 1.02, 0.075), (0.065, 0.995, 0.065))]
        out.append(U.join(lobes, f"{kind}.comb"))
        out.append(_along(f"{kind}.wattle", c, _teardrop_bm(0.08, 0.034), Vector((0, -0.285, 0.6)), (0, -0.2, -1), red))
    elif kind == "owl":
        dark = M.felt("staff_owl_tuft", P.OWL_DARK, 0.4)
        for sx in (-1, 1):
            out.append(_along(f"{kind}.ear", c, _teardrop_bm(0.13, 0.055), Vector((sx * 0.2, 0.0, 0.9)),
                              (sx * 0.65, 0.1, 1.0), dark))
        frame = M.flat("staff_glasses", "#5A3B26", 0.35)
        parts = []
        for sx in (-1, 1):
            ex = sx * 0.125
            parts.append(U.torus(f"{kind}.rim", 0.066, 0.008, c, loc=(ex, -0.302, 0.716), rot=(math.pi / 2 - 0.12, 0, 0),
                                 mat=frame, major_segs=24, minor_segs=6))
            parts.append(U.cylinder(f"{kind}.temple", 0.006, 0.22, c, loc=(sx * 0.215, -0.19, 0.73),
                                    rot=(math.pi / 2, 0, sx * -0.35), mat=frame, verts=6))
        parts.append(U.cylinder(f"{kind}.bridge", 0.007, 0.07, c, loc=(0, -0.318, 0.728), rot=(0, math.pi / 2, 0),
                                mat=frame, verts=6))
        out.append(U.join(parts, f"{kind}.glasses"))
    elif kind == "sparrow":
        cap = M.felt("staff_cap", P.CAP, 0.2)
        visor_mat = M.flat("staff_visor", "#141A30", 0.3)
        gold = M.flat("brass", P.GOLD, 0.25, metal=1.0)
        crown = U.lathe(f"{kind}.cap", [(0.0, 0.0), (0.235, 0.0), (0.245, 0.06), (0.28, 0.15), (0.27, 0.175),
                                        (0.0, 0.18)], c, segs=32, mat=cap)
        band = U.cylinder(f"{kind}.cap_band", 0.242, 0.045, c, base=(0, 0, 0.005), mat=visor_mat, verts=32)
        stripe = U.cylinder(f"{kind}.cap_stripe", 0.244, 0.012, c, base=(0, 0, 0.022), mat=M.flat("staff_cap_red",
                                                                                                  "#C8473C", 0.5), verts=32)
        visor = _ellipsoid(f"{kind}.visor", c, Vector((0, -0.2, 0.0)), (0.19, 0.13, 0.018), visor_mat, 24, 8)
        badge = U.cylinder(f"{kind}.badge", 0.032, 0.01, c, loc=(0, -0.262, 0.1), rot=(math.pi / 2 - 0.12, 0, 0),
                           mat=gold, verts=16)
        hat = U.join([crown, band, stripe, visor, badge], f"{kind}.cap")
        hat.matrix_world = Matrix.Translation((0, 0.03, 0.885)) @ Matrix.Rotation(-0.18, 4, "X") @ hat.matrix_world
        out.append(hat)
    elif kind == "penguin":
        out += _traveler_gear(kind, c)
    _ = sp
    return out


def _tube(name, c, points, radius, mat, verts=10):
    """Rounded tube through `points` (cylinders joined by spheres)."""
    parts = []
    pts = [Vector(p) for p in points]
    for a, b in zip(pts, pts[1:]):
        d = b - a
        bm = _lathe_bm([(radius, 0.0), (radius, d.length)], verts)
        parts.append(_along(f"{name}.seg", c, bm, a, d, mat))
    for p_ in pts[1:-1]:
        parts.append(_ellipsoid(f"{name}.joint", c, p_, (radius,) * 3, mat, verts, 6))
    return U.join(parts, name)


def _traveler_gear(kind, c):
    """Straw hat, knitted scarf (on the head) for the traveler. Backpack goes on the body."""
    straw = bpy.data.materials.get("player_straw") or M.textured("player_straw", "straw", rough=0.85)
    band = M.flat("player_hat_band", "#6A3E22", 0.6)
    crown = U.lathe(f"{kind}.hat", [(0.0, 0.0), (0.2, 0.0), (0.205, 0.08), (0.185, 0.14), (0.12, 0.17), (0.0, 0.175)],
                    c, segs=28, mat=straw)
    brim_prof = [(0.19, 0.01), (0.27, 0.0), (0.34, -0.025), (0.37, -0.045), (0.36, -0.055), (0.27, -0.015),
                 (0.19, -0.005)]
    brim = U.lathe(f"{kind}.brim", brim_prof, c, segs=32, mat=straw, close=False)
    ribbon = U.cylinder(f"{kind}.hat_band", 0.207, 0.04, c, base=(0, 0, 0.012), mat=band, verts=28)
    hat = U.join([crown, brim, ribbon], f"{kind}.hat")
    hat.matrix_world = Matrix.Translation((0, 0.02, 0.9)) @ Matrix.Rotation(-0.12, 4, "X") @ Matrix.Rotation(0.15, 4, "Y")
    return [hat]


def _scarf_and_pack(kind, c):
    """Scarf around the neck and a backpack with a bedroll (both ride on the body bone)."""
    scarf_mat = bpy.data.materials.get("player_scarf") or M.textured("player_scarf", "scarf", rough=0.95, sheen=0.4)
    ring = U.torus(f"{kind}.scarf", 1.0, 0.23, c, loc=(0, 0, 0.45), mat=scarf_mat, major_segs=32, minor_segs=10)
    U.apply_scale(ring, (0.255, 0.23, 0.25))
    tail = _along(f"{kind}.scarf_end", c, _ellipsoid_bm((0.05, 0.02, 0.12), 12, 8), Vector((0.1, -0.24, 0.4)),
                  (0.15, -0.25, -1), scarf_mat)
    fringe = _along(f"{kind}.scarf_fringe", c, _ellipsoid_bm((0.045, 0.015, 0.03), 10, 6),
                    Vector((0.12, -0.285, 0.29)), (0.15, -0.25, -1), M.flat("player_fringe", P.CREAM, 0.9))
    scarf = U.join([ring, tail, fringe], f"{kind}.scarf")
    leather = bpy.data.materials.get("player_pack") or M.textured("player_pack", "backpack", rough=0.7)
    strap = M.flat("player_strap", "#5A3420", 0.6)
    bedroll = M.flat("player_bedroll", "#D8B47A", 0.85)
    pack = U.box(f"{kind}.backpack", (0.34, 0.16, 0.3), c, base=(0, 0.3, 0.16), mat=leather, bev=0.04, seg=3)
    flap = U.box(f"{kind}.backpack_flap", (0.3, 0.04, 0.14), c, base=(0, 0.39, 0.33), mat=leather, bev=0.02)
    roll = U.cylinder(f"{kind}.bedroll", 0.065, 0.38, c, loc=(0, 0.3, 0.52), rot=(0, math.pi / 2, 0), mat=bedroll,
                      verts=16)
    straps = []
    for sx in (-1, 1):
        x = sx * 0.12
        straps.append(_tube(f"{kind}.strap", c, [(x, 0.24, 0.44), (x * 1.15, 0.05, 0.53), (x * 1.1, -0.2, 0.45),
                                                 (x, -0.255, 0.3), (x * 0.95, -0.23, 0.16)], 0.016, strap))
    pack = U.join([pack, flap, roll] + straps, f"{kind}.backpack")
    return [scarf, pack]


# --------------------------------------------------------------------------
# Props (start hidden in the app)


def _props(kind, c):
    """Role props as (object, hand bone)."""
    out = []
    if kind == "hiyoko":
        wood = M.wood("wood_dark", P.WOOD_DARK)
        parts = [U.sphere("stamp.knob", 0.026, c, loc=(0, 0, 0.1), mat=wood, segs=12, rings=8),
                 U.cylinder("stamp.neck", 0.014, 0.06, c, base=(0, 0, 0.045), mat=wood, verts=10),
                 U.cylinder("stamp.body", 0.032, 0.045, c, base=(0, 0, 0.0), mat=M.wood("wood_counter_top", P.WOOD_LIGHT),
                            verts=16, bev=0.004),
                 U.cylinder("stamp.face", 0.03, 0.006, c, base=(0, 0, -0.004), mat=M.flat("ink_red", "#B8302A", 0.5),
                            verts=16)]
        stamp = U.join(parts, "prop.stamp")
        stamp.matrix_world = Matrix.Translation((-0.35, -0.06, 0.12))
        out.append((stamp, "hand.R"))
        out.append((_guide_cap(c), "head"))
        out.append((_guide_flag(c), "hand.R"))
    elif kind == "owl":
        bk = U.flatten(props.open_book("prop.book_parts", c, w=0.26, d=0.18), "prop.book")
        bk.matrix_world = Matrix.Translation((0.3, -0.16, 0.3)) @ Matrix.Rotation(0.9, 4, "X") @ Matrix.Rotation(0.5, 4, "Z")
        out.append((bk, "hand.L"))
        scroll = U.flatten(props.scroll("prop.scroll_parts", c, length=0.28, radius=0.026), "prop.scroll")
        scroll.matrix_world = Matrix.Translation((-0.36, -0.06, 0.2)) @ Matrix.Rotation(1.2, 4, "Y")
        out.append((scroll, "hand.R"))
    elif kind == "hen":
        sheet = U.box("prop.map", (0.3, 0.2, 0.008), c, base=(0, 0, 0), mat=M.textured("tex_map", "map", 0.85))
        sheet.matrix_world = Matrix.Translation((0.33, -0.15, 0.26)) @ Matrix.Rotation(1.0, 4, "X")
        out.append((sheet, "hand.L"))
    elif kind == "sparrow":
        binder = U.join([
            U.box("binder.cover", (0.22, 0.03, 0.28), c, base=(0, 0, 0), mat=M.flat("binder_#2A3F8E", "#2A3F8E", 0.55),
                  bev=0.004),
            U.box("binder.label", (0.12, 0.005, 0.05), c, base=(0, -0.016, 0.17), mat=M.flat("archive_label", "#F7F1E3", 0.8)),
        ], "prop.binder")
        binder.matrix_world = Matrix.Translation((0.34, -0.12, 0.12)) @ Matrix.Rotation(0.5, 4, "X")
        out.append((binder, "hand.L"))
        doc = U.join([
            U.box("doc.sheets", (0.24, 0.32, 0.03), c, base=(0, 0, 0), mat=M.flat("paper_#F7F1E3", "#F7F1E3", 0.85),
                  bev=0.003),
            U.box("doc.clip", (0.08, 0.03, 0.012), c, base=(0, 0.15, 0.03), mat=M.flat("brass", P.GOLD, 0.25, 1.0)),
            U.box("doc.band", (0.245, 0.06, 0.032), c, base=(0, -0.05, 0.0), mat=M.flat("doc_band", "#B8453A", 0.6)),
        ], "prop.document")
        doc.matrix_world = Matrix.Translation((-0.18, -0.3, 0.3)) @ Matrix.Rotation(-0.25, 4, "X")
        out.append((doc, "hand.R"))
    elif kind == "penguin":
        book = U.join([
            U.box("stampbook.cover", (0.16, 0.22, 0.025), c, base=(0, 0, 0), mat=M.flat("stampbook", "#C8473C", 0.6),
                  bev=0.004),
            U.box("stampbook.label", (0.1, 0.06, 0.004), c, base=(0, 0.04, 0.025), mat=M.flat("archive_label", "#F7F1E3", 0.8)),
        ], "prop.stampbook")
        book.matrix_world = Matrix.Translation((-0.35, -0.08, 0.16)) @ Matrix.Rotation(1.2, 4, "X")
        out.append((book, "hand.R"))
    return out


def _guide_cap(c):
    """Guide's cap: vermilion with a cream band, the shop's crest and a visor. The chick's tuft pokes out on top."""
    red = M.felt("guide_cap", "#D2402E", 0.25)
    cream = M.flat("guide_cap_band", P.CREAM, 0.7)
    visor_mat = M.flat("guide_visor", "#8E2A1E", 0.35)
    crown = U.lathe("cap.crown", [(0.0, 0.0), (0.238, 0.0), (0.246, 0.055), (0.266, 0.12), (0.244, 0.16), (0.13, 0.185),
                                  (0.0, 0.19)], c, segs=28, mat=red)
    band = U.cylinder("cap.band", 0.244, 0.042, c, base=(0, 0, 0.006), mat=cream, verts=28)
    visor = _ellipsoid("cap.visor", c, Vector((0, -0.205, 0.002)), (0.185, 0.14, 0.016), visor_mat, 22, 8)
    crest = props.shape_panel("cap.crest", c, props._circle(16), (0.13, 0.13), "crest", loc=(0, -0.262, 0.1),
                              facing=(math.pi / 2 - 0.26, 0, 0), thickness=0.004)
    hat = U.join([crown, band, visor, crest], "prop.guide_cap")
    hat.matrix_world = Matrix.Translation((0, 0.03, 0.885)) @ Matrix.Rotation(-0.18, 4, "X") @ hat.matrix_world
    return hat


# Where the wing tip closes on the pole, at rest (the pole runs straight up through this point).
GUIDE_GRIP = (-0.3475, -0.012, 0.233)
GUIDE_CAP_CENTER = (0.0, 0.03, 0.98)
FLAG_ABOVE = 1.12                       # pole length above the grip
FLAG_BELOW = 0.08                       # and below it: any longer and the foot comes out through the sleeve in wave_flag
FLAG_POLE_R = 0.013
FLAG_SIZE = (0.56, 0.34)
FLAG_LEAN = 0.13                        # radians away from the head, at rest


def _guide_flag(c):
    """Guide's flag: a light pole held in the right wing tip, with a swallowtail cloth at the top, on the outer side."""
    gx, gy, gz = GUIDE_GRIP
    lacquer = M.flat("flag_pole", "#6A3D21", 0.4)
    gold = M.flat("brass", P.GOLD, 0.25, metal=1.0)
    pole = U.cylinder("flag.pole", FLAG_POLE_R, FLAG_ABOVE + FLAG_BELOW, c, base=(gx, gy, gz - FLAG_BELOW), mat=lacquer, verts=8)
    tip = U.sphere("flag.tip", 0.03, c, loc=(gx, gy, gz + FLAG_ABOVE + 0.015), mat=gold, segs=10, rings=6)
    grip = U.cylinder("flag.grip", 0.02, 0.1, c, base=(gx, gy, gz - 0.05), mat=M.flat("flag_grip", "#2B2220", 0.6), verts=8)
    length, height = FLAG_SIZE
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    nu, nv = 8, 4
    top = gz + FLAG_ABOVE - 0.02
    grid = []
    for j in range(nv + 1):
        v = j / nv
        end = length * (1.0 - 0.2 * (1.0 - abs(2 * v - 1)))     # swallowtail
        row = []
        for i in range(nu + 1):
            u = i / nu
            x = u * end
            sway = 0.028 * math.sin(u * 2 * math.pi + 0.5) * u
            vert = bm.verts.new((gx - x, gy + sway, top - height + v * height - 0.018 * u))
            row.append((vert, x / length, v))
        grid.append(row)
    for j in range(nv):
        for i in range(nu):
            quad = (grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i])
            f = bm.faces.new([q[0] for q in quad])
            for loop, q in zip(f.loops, quad):
                loop[uv].uv = (q[1], q[2])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    cloth = U.mesh_object("flag.cloth", bm, c, M.textured("guide_flag", "guide_flag", rough=0.85, sheen=0.2), smooth=True)
    flag = U.join([pole, tip, grip, cloth], "prop.guide_flag")
    # Lean the pole away from the head, about the grip; the hand keeps it there through the motions.
    # The mesh is in the coordinates of the pole's foot, where the joined object's origin is.
    pivot = Vector(GUIDE_GRIP) - flag.location
    flag.data.transform(Matrix.Translation(pivot) @ Matrix.Rotation(-FLAG_LEAN, 4, "Y") @ Matrix.Translation(-pivot))
    flag.matrix_world = Matrix.Translation(flag.location)
    return flag


def _shadow(kind, c):
    mat = bpy.data.materials.get("staff_shadow") or M.textured("staff_shadow", "shadow", rough=1.0, alpha=True)
    obj = U.plane(f"{kind}.shadow", (0.9, 0.9), c, loc=(0, -0.02, 0.004), mat=mat)
    return obj


# --------------------------------------------------------------------------


def node_name(kind):
    """Top node name: `staff.<kind>`, or `player.penguin` for the traveler."""
    return f"player.{kind}" if SPECIES[kind]["role"] == "player" else f"staff.{kind}"


def build(kind, coll, with_props=True):
    """Build one character. Returns the armature object (see node_name)."""
    sp = SPECIES[kind]
    happi = sp.get("happi", True)
    c = U.collection(f"staff.{kind}", coll)
    arm = rig.build(node_name(kind), c)
    color = M.felt(f"staff_color_{kind}", sp["color"], 0.25)
    bones = {}
    bones["head"] = [_head(kind, c), _face(kind, c)] + _accessories(kind, c)
    upper, lower, mouth = _beak(kind, c, sp["beak"])
    bones["head"] += [upper, mouth]
    bones["jaw"] = [lower]
    bones["body"] = [_body(kind, c), _tail(kind, c, color)]
    bones["body"] += [_happi(kind, c)] if happi else _scarf_and_pack(kind, c)
    for side in ("L", "R"):
        wing, sleeve = _wing(kind, c, side, color, sleeve=happi)
        bones[f"wing.{side}"] = [o for o in (wing, sleeve) if o is not None]
        bones[f"foot.{side}"] = [_foot(kind, c, side, sp["feet"])]
    bones["root"] = [_shadow(kind, c)]
    bpy.context.view_layer.update()
    for bone, objs in bones.items():
        for o in objs:
            U.apply_modifiers(o)
            rig.attach(o, arm, bone)
    if with_props:
        for obj, bone in _props(kind, c):
            U.apply_modifiers(obj)
            rig.attach(obj, arm, bone)
    return arm


def meshes(arm):
    return [o for o in arm.children_recursive if o.type == "MESH"]


def placeholder(kind, coll, loc=(0, 0, 0), yaw=0.0):
    """Full character placed in a scene (used by the interior previews)."""
    arm = build(kind, coll, with_props=False)
    arm.location = loc
    arm.rotation_euler = (0, 0, yaw)
    return arm


def set_expression(name):
    """Preview helper: show expression `name` on every staff face (Blender only)."""
    k = T.EXPRESSIONS.index(name)
    mat = bpy.data.materials.get("staff_face")
    mat.node_tree.nodes["uv_offset"].inputs["Location"].default_value = ((k % 4) * 0.25, -(k // 4) * 0.5, 0)
