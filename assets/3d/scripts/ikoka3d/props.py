"""Reusable furniture and small props.

Every function builds its prop around a local origin (bottom center unless
noted), parents the pieces to one empty and returns that empty, so callers
only position and rotate the root.
"""

import math
import random

import bmesh
import bpy
from mathutils import Vector

from . import materials as M
from . import palette as P
from . import util as U


def _root(name, coll, loc=(0, 0, 0), yaw=0.0):
    return U.empty(name, coll, loc=loc, rot=(0, 0, yaw), size=0.15)


def plank_surface(name, coll, size, plank_w=0.15, length=(0.7, 1.7), chamfer=0.007, seed=1, mat=None,
                  along="X", matrix=None, stagger=True):
    """Boards with chamfered edges in the local XY plane, centered on the origin.

    Each board gets a random `plank_rand` value for `materials.planks`.
    `along` is the board direction; `matrix` transforms the result.
    """
    rng = random.Random(seed)
    bm = bmesh.new()
    attr = bm.verts.layers.float.new("plank_rand")
    long_size, cross_size = (size[0], size[1]) if along == "X" else (size[1], size[0])
    rows = max(1, round(cross_size / plank_w))
    pw = cross_size / rows
    drop = chamfer * 0.8

    def v(a, b, z, r):
        co = (a, b, z) if along == "X" else (b, a, z)
        vert = bm.verts.new(co)
        vert[attr] = r
        return vert

    for row in range(rows):
        b0 = -cross_size / 2 + row * pw
        b1 = b0 + pw
        a = -long_size / 2
        first = True
        while a < long_size / 2 - 1e-4:
            seg = rng.uniform(*length)
            if first and stagger:
                seg = rng.uniform(length[0] * 0.3, length[1])
            first = False
            a1 = min(a + seg, long_size / 2)
            if long_size / 2 - a1 < length[0] * 0.25:
                a1 = long_size / 2
            r = rng.random()
            outer = [v(a, b0, -drop, r), v(a1, b0, -drop, r), v(a1, b1, -drop, r), v(a, b1, -drop, r)]
            c = min(chamfer, (a1 - a) / 4, pw / 4)
            inner = [v(a + c, b0 + c, 0, r), v(a1 - c, b0 + c, 0, r), v(a1 - c, b1 - c, 0, r), v(a + c, b1 - c, 0, r)]
            bm.faces.new(inner)
            for i in range(4):
                j = (i + 1) % 4
                bm.faces.new((outer[i], outer[j], inner[j], inner[i]))
            a = a1
    if along != "X":
        # Swapping the axes mirrored the winding; turn the faces back up.
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    if matrix is not None:
        bmesh.ops.transform(bm, matrix=matrix, verts=bm.verts)
    return U.mesh_object(name, bm, coll, mat)


def table(name, coll, size=(1.2, 0.6, 0.55), loc=(0, 0, 0), yaw=0.0, top_t=0.05, leg=0.06, mat=None):
    mat = mat or M.wood("wood_furniture")
    root = _root(name, coll, loc, yaw)
    w, d, h = size
    U.box(f"{name}.top", (w, d, top_t), coll, base=(0, 0, h - top_t), mat=mat, bev=0.012, parent=root)
    for sx in (-1, 1):
        for sy in (-1, 1):
            U.box(f"{name}.leg", (leg, leg, h - top_t), coll,
                  base=(sx * (w / 2 - leg), sy * (d / 2 - leg), 0), mat=mat, bev=0.006, parent=root)
    U.box(f"{name}.apron", (w - 2 * leg, 0.02, 0.08), coll, base=(0, d / 2 - leg, h - top_t - 0.08), mat=mat,
          parent=root)
    return root


def stool(name, coll, loc=(0, 0, 0), yaw=0.0, h=0.36, r=0.16, mat=None):
    mat = mat or M.wood("wood_furniture")
    root = _root(name, coll, loc, yaw)
    U.cylinder(f"{name}.seat", r, 0.05, coll, base=(0, 0, h - 0.05), mat=mat, verts=20, bev=0.01, parent=root)
    for i in range(3):
        a = 2 * math.pi * i / 3
        U.box(f"{name}.leg", (0.035, 0.035, h - 0.05), coll,
              base=(math.cos(a) * r * 0.65, math.sin(a) * r * 0.65, 0), mat=mat, parent=root)
    return root


def chair(name, coll, loc=(0, 0, 0), yaw=0.0, seat_h=0.36, w=0.42, mat=None):
    """Chair whose back is toward +Y (sitter faces -Y)."""
    mat = mat or M.wood("wood_furniture")
    root = _root(name, coll, loc, yaw)
    d = w * 0.95
    U.box(f"{name}.seat", (w, d, 0.04), coll, base=(0, 0, seat_h - 0.04), mat=mat, bev=0.01, parent=root)
    for sx in (-1, 1):
        for sy in (-1, 1):
            h = seat_h - 0.04 if sy < 0 else seat_h + 0.38
            U.box(f"{name}.leg", (0.04, 0.04, h), coll, base=(sx * (w / 2 - 0.03), sy * (d / 2 - 0.03), 0),
                  mat=mat, parent=root)
    for z in (seat_h + 0.18, seat_h + 0.34):
        U.box(f"{name}.rail", (w - 0.04, 0.03, 0.06), coll, base=(0, d / 2 - 0.03, z), mat=mat, bev=0.006,
              parent=root)
    return root


def shelf_unit(name, coll, size=(1.2, 0.38, 2.1), shelves=5, loc=(0, 0, 0), yaw=0.0, mat=None, back_mat=None):
    """Open shelf, opening toward -Y. Returns (root, list of shelf top z)."""
    mat = mat or M.wood("wood_dark", P.WOOD_DARK)
    back_mat = back_mat or M.wood("wood_shelf_back", P.mix(P.WOOD_DARK, "#000000", 0.15))
    root = _root(name, coll, loc, yaw)
    w, d, h = size
    t = 0.045
    for sx in (-1, 1):
        U.box(f"{name}.side", (t, d, h), coll, base=(sx * (w / 2 - t / 2), 0, 0), mat=mat, bev=0.008, parent=root)
    U.box(f"{name}.top", (w + 0.04, d + 0.03, t), coll, base=(0, -0.015, h - t), mat=mat, bev=0.008, parent=root)
    U.box(f"{name}.base", (w, d, 0.09), coll, base=(0, 0, 0), mat=mat, parent=root)
    U.box(f"{name}.back", (w - 2 * t, 0.02, h - t), coll, base=(0, d / 2 - 0.01, 0), mat=back_mat, parent=root)
    tops = []
    gap = (h - 0.09 - t) / shelves
    for i in range(1, shelves):
        z = 0.09 + gap * i
        U.box(f"{name}.board", (w - 2 * t, d - 0.02, 0.03), coll, base=(0, -0.01, z - 0.03), mat=mat, parent=root)
        tops.append(z)
    tops.insert(0, 0.09)
    return root, tops, gap


def chochin(name, coll, loc=(0, 0, 0), radius=0.16, height=0.36, tex="lantern", strength=2.2, ribs=True):
    """Paper lantern hanging from `loc` (its top). Returns root."""
    mat = M.textured(f"lantern_{tex}", tex, rough=0.9, emission=strength, glow_tint="#FFB868")
    cap_mat = M.flat("lantern_cap", "#2B1B14", 0.5)
    root = _root(name, coll, loc)
    n = 12
    prof = [(radius * (0.55 + 0.45 * math.sin(math.pi * i / n)), -height + height * i / n) for i in range(n + 1)]
    U.lathe(f"{name}.paper", prof, coll, segs=20, mat=mat, parent=root, close=False)
    cap_r = radius * 0.6
    U.cylinder(f"{name}.cap_top", cap_r, 0.04, coll, base=(0, 0, -0.03), mat=cap_mat, verts=16, parent=root)
    U.cylinder(f"{name}.cap_bot", cap_r, 0.04, coll, base=(0, 0, -height - 0.01), mat=cap_mat, verts=16, parent=root)
    U.cylinder(f"{name}.cord", 0.006, 0.12, coll, base=(0, 0, 0.0), mat=cap_mat, verts=6, parent=root)
    if ribs:
        for i in range(2, 11, 2):
            t = i / n
            r = radius * (0.55 + 0.45 * math.sin(math.pi * t)) + 0.0015
            U.torus(f"{name}.rib", r, 0.0028, coll, loc=(0, 0, -height + height * t), mat=cap_mat, major_segs=20,
                    minor_segs=4, parent=root)
    return root


def wall_lantern(name, coll, loc, yaw=0.0, tex="lantern"):
    """Chochin on an L-shaped bracket; `loc` is the wall point, yaw 0 sticks out toward -Y."""
    wood = M.wood("wood_dark", P.WOOD_DARK)
    root = _root(name, coll, loc, yaw)
    U.box(f"{name}.plate", (0.08, 0.03, 0.22), coll, base=(0, 0.0, 0.0), mat=wood, bev=0.006, parent=root)
    U.box(f"{name}.arm", (0.035, 0.32, 0.035), coll, base=(0, -0.16, 0.16), mat=wood, bev=0.005, parent=root)
    lantern = chochin(f"{name}.lamp", coll, loc=(0, -0.3, 0.16), radius=0.12, height=0.28, tex=tex)
    lantern.parent = root
    return root


def andon(name, coll, loc=(0, 0, 0), yaw=0.0, w=0.2, h=0.32, frame=None, strength=2.5):
    """Table lantern (square paper shade on a wooden frame)."""
    shade = M.emissive("andon_paper", "#FFC27A", strength, base="#FBE9C8")
    frame = frame or M.wood("wood_dark", P.WOOD_DARK)
    root = _root(name, coll, loc, yaw)
    U.box(f"{name}.shade", (w, w, h), coll, base=(0, 0, 0.04), mat=shade, parent=root)
    for sx in (-1, 1):
        for sy in (-1, 1):
            U.box(f"{name}.post", (0.022, 0.022, h + 0.06), coll, base=(sx * w / 2, sy * w / 2, 0), mat=frame,
                  parent=root)
    z = h * 0.5 + 0.04
    for sy in (-1, 1):
        U.box(f"{name}.bar", (w, 0.012, 0.012), coll, base=(0, sy * (w / 2 + 0.002), z), mat=frame, parent=root)
        U.box(f"{name}.bar", (0.012, w, 0.012), coll, base=(sy * (w / 2 + 0.002), 0, z), mat=frame, parent=root)
    U.box(f"{name}.base", (w + 0.04, w + 0.04, 0.04), coll, base=(0, 0, 0), mat=frame, bev=0.005, parent=root)
    U.box(f"{name}.cap", (w + 0.05, w + 0.05, 0.025), coll, base=(0, 0, h + 0.04), mat=frame, bev=0.005, parent=root)
    return root


def floor_andon(name, coll, loc=(0, 0, 0), yaw=0.0):
    root = andon(name, coll, loc=(loc[0], loc[1], loc[2] + 0.3), yaw=yaw, w=0.28, h=0.5)
    wood = M.wood("wood_dark", P.WOOD_DARK)
    for sx in (-1, 1):
        for sy in (-1, 1):
            U.box(f"{name}.foot", (0.03, 0.03, 0.32), coll, base=(sx * 0.15, sy * 0.15, -0.3), mat=wood, parent=root)
    return root


def _tmp_mesh(bm):
    me = bpy.data.meshes.new("__tmp")
    bm.to_mesh(me)
    bm.free()
    return me


def _merge(dst, src_bm):
    """Append a temporary bmesh into `dst`."""
    me = _tmp_mesh(src_bm)
    dst.from_mesh(me)
    bpy.data.meshes.remove(me)


def _leaf_bm(length, width, droop):
    """One leaf: a bent, tapered strip along +X."""
    bm = bmesh.new()
    rows = 5
    verts = []
    for i in range(rows + 1):
        t = i / rows
        w = width * math.sin(math.pi * min(1.0, t * 1.15)) * 0.5 + 0.002
        x = length * t
        z = -droop * t * t * length
        verts.append((bm.verts.new((x, -w, z + w * 0.3)), bm.verts.new((x, 0, z + w * 0.15)),
                      bm.verts.new((x, w, z + w * 0.3))))
    for a, b in zip(verts[:-1], verts[1:]):
        bm.faces.new((a[0], b[0], b[1], a[1]))
        bm.faces.new((a[1], b[1], b[2], a[2]))
    return bm


def leafy_plant(name, coll, loc=(0, 0, 0), size=1.0, leaf=P.LEAF, pot="#B56A45", leaves=14, seed=1, flowers=None,
                pot_h=0.22, tall=0.5, pot_r=0.12):
    """Potted plant: a ring of drooping leaves on short stems."""
    rng = random.Random(seed)
    root = _root(name, coll, loc)
    s = size
    if pot:
        U.cylinder(f"{name}.pot", pot_r * s, pot_h * s, coll, base=(0, 0, 0), radius2=pot_r * 1.25 * s,
                   mat=M.flat(f"pot_{pot}", pot, 0.7), verts=18, bev=0.01, parent=root)
        U.cylinder(f"{name}.soil", pot_r * 1.12 * s, 0.01, coll, base=(0, 0, pot_h * s - 0.02),
                   mat=M.flat("soil", "#4A3326", 1.0), verts=18, parent=root)
    bm = bmesh.new()
    for i in range(leaves):
        a = 2 * math.pi * i / leaves + rng.uniform(-0.25, 0.25)
        lvl = rng.uniform(0.0, 1.0)
        length = s * rng.uniform(0.18, 0.3) * (1.2 - 0.4 * lvl)
        lb = _leaf_bm(length, length * 0.42, rng.uniform(0.3, 0.9))
        pitch = -rng.uniform(0.3, 1.0) * (1 - lvl * 0.7)
        bmesh.ops.transform(lb, matrix=U.mat_trs((0, 0, pot_h * s + tall * s * lvl * 0.6), (0, pitch, a)),
                            verts=lb.verts)
        _merge(bm, lb)
    U.mesh_object(f"{name}.leaves", bm, coll, M.felt(f"leaf_{leaf}", leaf, 0.25), smooth=True, parent=root)
    if flowers:
        fmat = M.felt(f"flower_{flowers}", flowers, 0.3)
        for k in range(5):
            a = rng.uniform(0, 2 * math.pi)
            r = rng.uniform(0.04, 0.12) * s
            U.sphere(f"{name}.flower", 0.04 * s, coll,
                     loc=(math.cos(a) * r, math.sin(a) * r, (pot_h + tall * 0.55 + rng.uniform(0, 0.1)) * s),
                     scale=(1, 1, 0.7), mat=fmat, segs=10, rings=6, parent=root)
    return root


def potted_plant(name, coll, loc=(0, 0, 0), size=1.0, leaf=P.LEAF, pot="#B56A45", flowers=None, seed=1):
    return leafy_plant(name, coll, loc, size, leaf, pot, seed=seed, flowers=flowers)


def hydrangea(name, coll, loc=(0, 0, 0), size=1.0, colors=("#8FA8E8", "#A99BE0", "#C3D0F4"), seed=1, yaw=0.0):
    """Wooden planter of hydrangea: leaf bed with clustered florets."""
    rng = random.Random(seed)
    root = _root(name, coll, loc, yaw)
    s = size
    U.box(f"{name}.box", (0.5 * s, 0.32 * s, 0.24 * s), coll, base=(0, 0, 0), mat=M.wood("wood_crate", P.WOOD_LIGHT),
          bev=0.01, parent=root)
    bed = leafy_plant(f"{name}.bed", coll, (0, 0, 0.0), size=s * 1.1, leaves=18, seed=seed, pot=None, pot_h=0.2,
                      tall=0.2)
    bed.parent = root
    for k in range(3):
        cx, cy = (k - 1) * 0.15 * s, rng.uniform(-0.04, 0.04) * s
        col = colors[k % len(colors)]
        bm = bmesh.new()
        for j in range(22):
            a, b = rng.uniform(0, 2 * math.pi), rng.uniform(0, math.pi / 2)
            r = 0.085 * s
            bmesh.ops.create_icosphere(bm, subdivisions=1, radius=0.024 * s, matrix=U.mat_trs(
                (cx + math.cos(a) * math.sin(b) * r, cy + math.sin(a) * math.sin(b) * r, 0.36 * s + math.cos(b) * r)))
        U.mesh_object(f"{name}.florets", bm, coll, M.felt(f"floret_{col}", col, 0.4), smooth=True, parent=root)
    return root


def noren(name, coll, width, height, loc=(0, 0, 0), yaw=0.0, panels=3, tex="noren"):
    """Shop curtain hanging from a rod at `loc` (top center), facing -Y."""
    mat = M.textured(f"noren_{tex}", tex, rough=0.95, sheen=0.4)
    rod = M.wood("wood_dark", P.WOOD_DARK)
    root = _root(name, coll, loc, yaw)
    U.cylinder(f"{name}.rod", 0.022, width + 0.16, coll, loc=(0, 0, 0.02), rot=(0, math.pi / 2, 0), mat=rod,
               verts=12, parent=root)
    gap = 0.02
    pw = (width - gap * (panels - 1)) / panels
    for i in range(panels):
        x = -width / 2 + pw / 2 + i * (pw + gap)
        bm = bmesh.new()
        uv = bm.loops.layers.uv.new("UVMap")
        nx, nz = 6, 8
        grid = []
        for iz in range(nz + 1):
            row = []
            for ix in range(nx + 1):
                u, v = ix / nx, iz / nz
                sway = 0.012 * math.sin(u * math.pi * 2 + i) * (1 - v)
                row.append(bm.verts.new((x - pw / 2 + pw * u, sway, -height + height * v)))
            grid.append(row)
        for iz in range(nz):
            for ix in range(nx):
                f = bm.faces.new((grid[iz][ix], grid[iz][ix + 1], grid[iz + 1][ix + 1], grid[iz + 1][ix]))
                for loop, (du, dv) in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
                    loop[uv].uv = ((i + (ix + du) / nx) / panels, (iz + dv) / nz)
        obj = U.mesh_object(f"{name}.panel", bm, coll, mat, smooth=True, parent=root)
        sol = obj.modifiers.new("Solidify", "SOLIDIFY")
        sol.thickness = 0.008
    return root


FACING = {"-Y": (math.pi / 2, 0, 0), "+Y": (math.pi / 2, 0, math.pi), "+X": (math.pi / 2, 0, math.pi / 2),
          "-X": (math.pi / 2, 0, -math.pi / 2), "+Z": (0, 0, 0)}


def textured_panel(name, coll, size, tex, loc=(0, 0, 0), facing="-Y", cell=None, emission=0.0, rough=0.8,
                   parent=None, alpha=False):
    """Upright textured plane centered on `loc`. `cell` = (index, cols, rows)."""
    rot = FACING[facing] if isinstance(facing, str) else facing
    obj = U.plane(name, size, coll, loc=loc, rot=rot, mat=M.textured(f"tex_{tex}", tex, rough, emission, alpha),
                  parent=parent)
    if cell is not None:
        U.atlas_cell(obj, *cell)
    return obj


# --------------------------------------------------------------------------
# Books, scrolls and paper


def book_row(name, coll, x0, x1, z, y_back, depth=0.24, max_h=0.3, seed=1, parent=None, stack_chance=0.25):
    """Books standing on a shelf between x0 and x1, spines facing -Y."""
    rng = random.Random(seed)
    bm = bmesh.new()
    x = x0 + rng.uniform(0, 0.02)
    cols = 16

    def add_book(cx, cz, w, h, d, lean, yaw, k):
        bb = bmesh.new()
        luv = bb.loops.layers.uv.new("UVMap")
        bmesh.ops.create_cube(bb, size=1.0)
        bmesh.ops.scale(bb, vec=(w, d, h), verts=bb.verts)
        u0, u1 = k / cols, (k + 1) / cols
        for f in bb.faces:
            n = f.normal
            for loop in f.loops:
                co = loop.vert.co
                if n.y < -0.5:
                    uvc = (u0 + (co.x / w + 0.5) * (u1 - u0), co.z / h + 0.5)
                elif abs(n.z) > 0.5 or n.y > 0.5:
                    uvc = (15.2 / cols + (co.x / w + 0.5) * 0.6 / cols, co.y / d + 0.5)
                else:
                    uvc = ((u0 + u1) / 2, 0.5 + co.z / h * 0.2)
                loop[luv].uv = uvc
        bmesh.ops.translate(bb, vec=(0, 0, h / 2), verts=bb.verts)
        bmesh.ops.transform(bb, matrix=U.mat_trs((cx, y_back - d / 2, cz), (0, lean, yaw)), verts=bb.verts)
        _merge(bm, bb)

    while x < x1 - 0.03:
        if rng.random() < stack_chance * 0.3 and x1 - x > 0.3:
            sw = rng.uniform(0.18, 0.24)
            zz = z
            for j in range(rng.randint(2, 4)):
                t = rng.uniform(0.03, 0.05)
                add_book(x, zz + t / 2, t, sw, depth * rng.uniform(0.75, 0.95), math.pi / 2,
                         rng.uniform(-0.1, 0.1), rng.randrange(15))
                zz += t
            x += sw + 0.02
            continue
        w = rng.uniform(0.026, 0.06)
        h = max_h * rng.uniform(0.62, 1.0)
        d = depth * rng.uniform(0.8, 1.0)
        lean = 0.0
        if rng.random() < 0.08 and x > x0 + 0.1:
            lean = -rng.uniform(0.15, 0.3)
        add_book(x + w / 2, z, w, h, d, lean, 0.0, rng.randrange(15))
        x += w + (0.002 if rng.random() > 0.15 else rng.uniform(0.02, 0.06)) + abs(lean) * h * 0.4
    return U.mesh_object(name, bm, coll, M.textured("books", "book_spines", 0.75), parent=parent)


def scroll(name, coll, length=0.32, radius=0.032, loc=(0, 0, 0), rot=(0, 0, 0), paper="#EFE0BD", parent=None):
    """Rolled scroll along local X with wooden knobs."""
    root = U.empty(name, coll, loc=loc, rot=rot, size=0.05)
    if parent is not None:
        root.parent = parent
    U.cylinder(f"{name}.paper", radius, length, coll, rot=(0, math.pi / 2, 0),
               mat=M.flat(f"scroll_{paper}", paper, 0.85), verts=12, parent=root)
    U.cylinder(f"{name}.band", radius + 0.002, 0.02, coll, rot=(0, math.pi / 2, 0),
               mat=M.flat("scroll_band", "#B8453A", 0.7), verts=12, parent=root)
    for sx in (-1, 1):
        U.cylinder(f"{name}.knob", radius * 0.45, 0.04, coll, loc=(sx * (length / 2 + 0.018), 0, 0),
                   rot=(0, math.pi / 2, 0), mat=M.wood("wood_dark", P.WOOD_DARK), verts=8, parent=root)
    return root


def scroll_pile(name, coll, loc=(0, 0, 0), yaw=0.0, n=6, seed=1, length=0.34):
    """Scrolls stacked in a pyramid, lying along local X."""
    rng = random.Random(seed)
    root = _root(name, coll, loc, yaw)
    r = 0.032
    k = 0
    count = max(1, (n + 1) // 2)
    row = 0
    while count > 0 and k < n:
        for i in range(count):
            y0 = (i - (count - 1) / 2) * 2 * r * 1.02
            scroll(f"{name}.s{k}", coll, length * rng.uniform(0.9, 1.05), r,
                   loc=(rng.uniform(-0.02, 0.02), y0, r + row * r * 1.72), rot=(0, 0, rng.uniform(-0.1, 0.1)),
                   paper=rng.choice(["#EFE0BD", "#F4E8CF", "#E6D2A8"]), parent=root)
            k += 1
        count -= 1
        row += 1
    return root


def open_book(name, coll, loc=(0, 0, 0), yaw=0.0, w=0.3, d=0.2):
    root = _root(name, coll, loc, yaw)
    U.box(f"{name}.cover", (w + 0.02, d + 0.02, 0.012), coll, base=(0, 0, 0),
          mat=M.flat("book_cover", "#8A3B30", 0.7), parent=root)
    for sx in (-1, 1):
        p = U.plane(f"{name}.page", (w / 2, d), coll, loc=(sx * w / 4, 0, 0.022), rot=(0, sx * 0.08, 0),
                    mat=M.textured("tex_scroll", "scroll", 0.85), parent=root)
        U.uv_rect(p, 0.0 if sx < 0 else 0.5, 0, 0.5 if sx < 0 else 1.0, 1)
    return root


def paper_stack(name, coll, loc=(0, 0, 0), yaw=0.0, w=0.21, d=0.3, n=5, seed=1, color="#F7F1E3"):
    rng = random.Random(seed)
    root = _root(name, coll, loc, yaw)
    for i in range(n):
        U.box(f"{name}.sheet", (w, d, 0.006), coll, base=(rng.uniform(-0.01, 0.01), rng.uniform(-0.01, 0.01), i * 0.006),
              rot=(0, 0, rng.uniform(-0.08, 0.08)), mat=M.flat(f"paper_{color}", color, 0.85), parent=root)
    return root


# --------------------------------------------------------------------------
# Counter and lounge details


def call_bell(name, coll, loc=(0, 0, 0)):
    root = _root(name, coll, loc)
    brass = M.flat("brass", P.GOLD, 0.25, metal=1.0)
    U.cylinder(f"{name}.base", 0.065, 0.022, coll, base=(0, 0, 0), mat=M.wood("wood_dark", P.WOOD_DARK), verts=20,
               bev=0.005, parent=root)
    U.lathe(f"{name}.dome", [(0.055, 0.022), (0.054, 0.035), (0.045, 0.06), (0.03, 0.075), (0.0, 0.08)], coll,
            segs=20, mat=brass, parent=root)
    U.cylinder(f"{name}.button", 0.008, 0.02, coll, base=(0, 0, 0.078), mat=brass, verts=8, parent=root)
    U.sphere(f"{name}.knob", 0.011, coll, loc=(0, 0, 0.1), mat=brass, segs=10, rings=6, parent=root)
    return root


def brochure_stand(name, coll, loc=(0, 0, 0), yaw=0.0, cols=3, rows=2, w=0.18, h=0.24, seed=1, tilt=0.35):
    """Stepped stand of pamphlets (cells of the brochure atlas), facing -Y."""
    rng = random.Random(seed)
    wood = M.wood("wood_furniture", P.WOOD)
    root = _root(name, coll, loc, yaw)
    total_w = cols * (w + 0.02) + 0.02
    for r in range(rows):
        y, z = r * 0.1, r * 0.12
        U.box(f"{name}.step", (total_w, 0.1, 0.03 + z), coll, base=(0, y, 0), mat=wood, bev=0.004, parent=root)
        U.box(f"{name}.lip", (total_w, 0.012, 0.035), coll, base=(0, y - 0.044, 0.03 + z), mat=wood, parent=root)
        for c_ in range(cols):
            x = -total_w / 2 + 0.02 + w / 2 + c_ * (w + 0.02)
            p = U.plane(f"{name}.b", (w, h), coll,
                        loc=(x, y + h / 2 * math.sin(tilt) - 0.03, 0.03 + z + h / 2 * math.cos(tilt)),
                        rot=(math.pi / 2 - tilt, 0, 0), mat=M.textured("tex_brochures", "brochures", 0.7),
                        parent=root)
            U.atlas_cell(p, rng.randrange(8), 4, 2)
    U.box(f"{name}.back", (total_w, 0.02, (rows - 1) * 0.12 + h * 0.8), coll, base=(0, rows * 0.1 - 0.04, 0), mat=wood,
          parent=root)
    return root


def tea_set(name, coll, loc=(0, 0, 0), yaw=0.0):
    root = _root(name, coll, loc, yaw)
    glaze = M.flat("glaze_indigo", "#3A4F8F", 0.35)
    U.cylinder(f"{name}.tray", 0.16, 0.015, coll, base=(0, 0, 0), mat=M.wood("wood_dark", P.WOOD_DARK), verts=20,
               parent=root)
    U.lathe(f"{name}.pot", [(0.0, 0.015), (0.05, 0.015), (0.07, 0.05), (0.065, 0.09), (0.035, 0.11), (0.0, 0.115)],
            coll, segs=18, loc=(-0.04, 0.02, 0), mat=glaze, parent=root)
    U.cylinder(f"{name}.spout", 0.012, 0.06, coll, loc=(0.03, 0.02, 0.07), rot=(0, 1.0, 0), mat=glaze, verts=8,
               parent=root)
    for x, y in ((0.08, -0.05), (0.1, 0.06)):
        U.lathe(f"{name}.cup", [(0.0, 0.015), (0.025, 0.015), (0.032, 0.055), (0.0, 0.05)], coll, segs=14,
                loc=(x, y, 0), mat=M.flat("glaze_cream", "#EFE6D2", 0.35), parent=root)
    return root


def cushion(name, coll, loc=(0, 0, 0), rot=(0, 0, 0), size=(0.3, 0.12, 0.3), color="#C8573A"):
    return U.sphere(name, 0.5, coll, loc=loc, rot=rot, scale=size, mat=M.fabric(f"cushion_{color}", color, 0.6),
                    segs=16, rings=10)


def picture(name, coll, size, tex, loc, facing="-Y", frame_w=0.04, cell=None):
    yaw = {"-Y": 0, "+Y": math.pi, "+X": math.pi / 2, "-X": -math.pi / 2}[facing]
    root = U.empty(name, coll, loc=loc, rot=(0, 0, yaw), size=0.1)
    U.box(f"{name}.frame", (size[0] + 2 * frame_w, 0.03, size[1] + 2 * frame_w), coll, loc=(0, 0.015, 0),
          mat=M.wood("wood_dark", P.WOOD_DARK), bev=0.006, parent=root)
    textured_panel(f"{name}.art", coll, size, tex, loc=(0, -0.002, 0), facing="-Y", parent=root, cell=cell)
    return root


def kawara_eave(name, coll, width, depth, loc=(0, 0, 0), pitch=0.42, spacing=0.11, yaw=0.0):
    """Tiled eave: corrugated round-tile roof sloping down toward -Y, with end caps."""
    tile = M.flat("roof_tile", "#4A4C58", 0.45)
    root = _root(name, coll, loc, yaw)
    bm = bmesh.new()
    nx = max(2, int(width / spacing))
    sx = width / nx
    ny, sub = 6, 4
    grid = []
    for j in range(ny + 1):
        row = []
        for i in range(nx * sub + 1):
            x = -width / 2 + i * sx / sub
            z = 0.028 * abs(math.sin(math.pi * (i % sub) / sub))
            y = -depth * j / ny
            row.append(bm.verts.new((x, y * math.cos(pitch), z + y * math.sin(pitch))))
        grid.append(row)
    for j in range(ny):
        for i in range(nx * sub):
            bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
    tiles = U.mesh_object(f"{name}.tiles", bm, coll, tile, smooth=True, parent=root)
    tiles.modifiers.new("Solidify", "SOLIDIFY").thickness = 0.03
    yb, zb = -depth * math.cos(pitch), -depth * math.sin(pitch)
    for i in range(nx):
        x = -width / 2 + (i + 0.5) * sx
        U.cylinder(f"{name}.cap", 0.04, 0.035, coll, loc=(x, yb - 0.01, zb + 0.03), rot=(math.pi / 2, 0, 0), mat=tile,
                   verts=12, parent=root)
    U.box(f"{name}.ridge", (width + 0.04, 0.1, 0.09), coll, base=(0, 0.02, -0.02), mat=tile, bev=0.02, parent=root)
    U.box(f"{name}.fascia", (width, 0.04, 0.08), coll, base=(0, yb + 0.03, zb - 0.06),
          mat=M.wood("wood_dark", P.WOOD_DARK), parent=root)
    return root


def globe(name, coll, loc=(0, 0, 0), r=0.12):
    root = _root(name, coll, loc)
    brass = M.flat("brass", P.GOLD, 0.25, metal=1.0)
    U.cylinder(f"{name}.base", 0.08, 0.03, coll, base=(0, 0, 0), mat=M.wood("wood_dark", P.WOOD_DARK), verts=20,
               bev=0.005, parent=root)
    U.cylinder(f"{name}.stem", 0.012, 0.08, coll, base=(0, 0, 0.03), mat=brass, verts=8, parent=root)
    ball = U.sphere(f"{name}.ball", r, coll, loc=(0, 0, 0.11 + r), rot=(0.4, 0, 0),
                    mat=M.textured("tex_globe", "globe", 0.4), segs=24, rings=14, parent=root)
    sphere_uv(ball)
    U.torus(f"{name}.ring", r + 0.012, 0.005, coll, loc=(0, 0, 0.11 + r), rot=(math.pi / 2, 0.4, 0), mat=brass,
            major_segs=28, minor_segs=4, parent=root)
    return root


def sphere_uv(obj):
    """Equirectangular UVs for a sphere-like mesh centered on its origin."""
    me = obj.data
    uvl = me.uv_layers.active or me.uv_layers.new()
    for poly in me.polygons:
        cos = [me.vertices[me.loops[li].vertex_index].co for li in poly.loop_indices]
        us = [(math.atan2(co.y, co.x) / (2 * math.pi)) % 1.0 for co in cos]
        if max(us) - min(us) > 0.5:
            us = [u + 1 if u < 0.5 else u for u in us]
        for li, u, co in zip(poly.loop_indices, us, cos):
            r = co.length or 1
            uvl.data[li].uv = (u, 0.5 + math.asin(max(-1, min(1, co.z / r))) / math.pi)


def suitcase(name, coll, size=(0.5, 0.2, 0.36), loc=(0, 0, 0), rot=(0, 0, 0), color="#8A4E2E"):
    """Old-fashioned travel trunk with straps and a handle; lies on its side."""
    root = U.empty(name, coll, loc=loc, rot=rot, size=0.1)
    w, d, h = size
    U.box(f"{name}.body", size, coll, base=(0, 0, 0), mat=M.flat(f"leather_{color}", color, 0.55), bev=0.02, seg=3,
          parent=root)
    strap = M.flat("strap", "#4A2E1E", 0.6)
    for sx in (-0.28, 0.28):
        U.box(f"{name}.strap", (0.04, d + 0.012, h + 0.012), coll, base=(sx * w, 0, -0.006), mat=strap, parent=root)
    U.box(f"{name}.edge", (w + 0.01, d + 0.01, 0.025), coll, base=(0, 0, h * 0.48), mat=M.flat("brass", P.GOLD, 0.25, 1.0),
          parent=root)
    U.torus(f"{name}.handle", 0.05, 0.012, coll, loc=(0, 0, h + 0.012), rot=(math.pi / 2, 0, 0), mat=strap,
            major_segs=12, minor_segs=5, parent=root)
    return root


# --------------------------------------------------------------------------
# Fence, bench, souvenirs, vines and bunting


def low_fence(name, coll, p0, p1, height=0.75, mat=None):
    """Lattice fence from p0 to p1 (x, y) on the floor."""
    mat = mat or M.wood("wood_counter", P.WOOD)
    dark = M.wood("wood_dark", P.WOOD_DARK)
    a, b = Vector((*p0, 0)), Vector((*p1, 0))
    d = b - a
    length = d.length
    yaw = math.atan2(d.y, d.x)
    root = _root(name, coll, (a + b) / 2, yaw)
    U.box(f"{name}.rail", (length + 0.04, 0.05, 0.05), coll, base=(0, 0, height - 0.05), mat=dark, bev=0.008,
          parent=root)
    U.box(f"{name}.sill", (length, 0.05, 0.06), coll, base=(0, 0, 0.0), mat=dark, parent=root)
    n = max(1, int(length / 0.075))
    for i in range(n + 1):
        U.box(f"{name}.slat", (0.024, 0.028, height - 0.11), coll, base=(-length / 2 + length * i / n, 0, 0.06),
              mat=mat, parent=root)
    for x in {-length / 2, length / 2}:
        U.box(f"{name}.post", (0.07, 0.07, height + 0.06), coll, base=(x, 0, 0), mat=dark, bev=0.008, parent=root)
    return root


def bench(name, coll, loc=(0, 0, 0), yaw=0.0, length=1.3, seat_h=0.42, cushions=("#C8473C", "#2F3E7A")):
    """Wooden bench along local X with seat cushions; sitters face -Y."""
    wood = M.wood("wood_furniture", P.WOOD)
    root = _root(name, coll, loc, yaw)
    U.box(f"{name}.seat", (length, 0.42, 0.05), coll, base=(0, 0, seat_h - 0.08), mat=wood, bev=0.01, parent=root)
    for sx in (-1, 1):
        U.box(f"{name}.leg", (0.06, 0.36, seat_h - 0.08), coll, base=(sx * (length / 2 - 0.08), 0, 0),
              mat=M.wood("wood_dark", P.WOOD_DARK), parent=root)
    U.box(f"{name}.back", (length, 0.04, 0.3), coll, base=(0, 0.2, seat_h + 0.05), mat=wood, bev=0.008, parent=root)
    for i, col in enumerate(cushions):
        x = -length / 2 + 0.3 + i * 0.45
        U.box(f"{name}.cushion", (0.4, 0.36, 0.05), coll, base=(x, -0.01, seat_h - 0.03),
              mat=M.fabric(f"cushion_{col}", col, 0.6), bev=0.02, seg=3, parent=root)
    return root


def omiyage(name, coll, loc, size=(0.18, 0.12, 0.07), cell=0, yaw=0.0, parent=None):
    """Wrapped souvenir box (cell of the omiyage atlas on top)."""
    root = U.empty(name, coll, loc=loc, rot=(0, 0, yaw), size=0.05)
    if parent is not None:
        root.parent = parent
    colors = ["#C8473C", "#2A3F8E", "#3E7A5C", "#E9A6C4"]
    U.box(f"{name}.box", size, coll, base=(0, 0, 0), mat=M.flat(f"omiyage_{cell}", colors[cell % 4], 0.6), bev=0.004,
          parent=root)
    textured_panel(f"{name}.lid", coll, (size[0] * 0.96, size[1] * 0.96), "omiyage", loc=(0, 0, size[2] + 0.001),
                   facing="+Z", cell=(cell % 4, 2, 2), parent=root)
    return root


def mini_plush(name, coll, kind, loc, yaw=0.0, s=1.0, parent=None):
    """Small plush of a staff member for the souvenir shelf (about 12 cm)."""
    look = {"hiyoko": (P.CHICK, P.CHICK_BELLY), "owl": (P.OWL, P.OWL_FACE), "hen": (P.HEN, P.HEN),
            "sparrow": (P.SPARROW, P.SPARROW_BELLY), "penguin": (P.PENGUIN, P.PENGUIN_BELLY)}[kind]
    root = U.empty(name, coll, loc=loc, rot=(0, 0, yaw), size=0.03)
    if parent is not None:
        root.parent = parent
    col = M.felt(f"mini_{kind}", look[0], 0.3)
    face = M.felt(f"mini_{kind}_face", look[1], 0.3)
    happi = M.felt("mini_happi", P.INDIGO, 0.3)
    U.sphere(f"{name}.body", 0.04 * s, coll, loc=(0, 0, 0.038 * s), mat=happi if kind != "penguin" else col, segs=12,
             rings=8, parent=root)
    U.sphere(f"{name}.head", 0.045 * s, coll, loc=(0, 0, 0.1 * s), mat=col, segs=14, rings=10, parent=root)
    U.sphere(f"{name}.face", 0.034 * s, coll, loc=(0, -0.016 * s, 0.096 * s), scale=(1, 0.7, 0.85), mat=face, segs=12,
             rings=8, parent=root)
    U.cylinder(f"{name}.beak", 0.01 * s, 0.02 * s, coll, loc=(0, -0.045 * s, 0.093 * s), rot=(math.pi / 2, 0, 0),
               radius2=0.0, mat=M.flat("mini_beak", "#F59A28", 0.5), verts=8, parent=root)
    for sx in (-1, 1):
        U.sphere(f"{name}.eye", 0.0055 * s, coll, loc=(sx * 0.016 * s, -0.038 * s, 0.107 * s),
                 mat=M.flat("mini_eye", P.EYE, 0.3), segs=6, rings=4, parent=root)
    if kind == "hen":
        U.sphere(f"{name}.comb", 0.014 * s, coll, loc=(0, 0, 0.148 * s), mat=M.felt("staff_comb", P.COMB, 0.4), segs=8,
                 rings=6, parent=root)
    elif kind == "owl":
        for sx in (-1, 1):
            U.cylinder(f"{name}.ear", 0.012 * s, 0.025 * s, coll, loc=(sx * 0.03 * s, 0, 0.145 * s), radius2=0.0,
                       mat=col, verts=6, parent=root)
    elif kind == "sparrow":
        U.cylinder(f"{name}.cap", 0.035 * s, 0.025 * s, coll, base=(0, 0.003, 0.13 * s), mat=M.felt("staff_cap", P.CAP, 0.2),
                   verts=12, parent=root)
    elif kind == "penguin":
        U.cylinder(f"{name}.hat", 0.06 * s, 0.006 * s, coll, base=(0, 0, 0.135 * s), mat=M.flat("mini_straw", "#D9B77A", 0.8),
                   verts=14, parent=root)
        U.cylinder(f"{name}.crown", 0.032 * s, 0.025 * s, coll, base=(0, 0, 0.138 * s),
                   mat=M.flat("mini_straw", "#D9B77A", 0.8), verts=12, parent=root)
    elif kind == "hiyoko":
        U.sphere(f"{name}.tuft", 0.012 * s, coll, loc=(0, 0, 0.15 * s), scale=(0.6, 0.6, 1.3), mat=col, segs=8, rings=6,
                 parent=root)
    return root


def trailing_vine(name, coll, start, length=0.8, seed=1, leaf=P.LEAF, direction=(0, 0, -1)):
    """A pothos vine hanging from `start`: leaves along a gently curving line."""
    rng = random.Random(seed)
    bm = bmesh.new()
    d = Vector(direction).normalized()
    n = int(length / 0.06)
    p = Vector(start)
    for i in range(n):
        p = p + d * 0.06 + Vector((rng.uniform(-0.015, 0.015), rng.uniform(-0.015, 0.015), 0))
        lb = _leaf_bm(rng.uniform(0.05, 0.08), 0.045, 0.4)
        bmesh.ops.transform(lb, matrix=U.mat_trs(p, (rng.uniform(-0.5, 0.5), rng.uniform(0.6, 1.4), rng.uniform(0, 6.28))),
                            verts=lb.verts)
        _merge(bm, lb)
    return U.mesh_object(name, bm, coll, M.felt(f"leaf_{leaf}", leaf, 0.25), smooth=True)


def bunting(name, coll, p0, p1, n=14, sag=0.12, colors=("#C8473C", "#F6D56A", "#2A3F8E", "#F4E6C6", "#3E7A5C")):
    """String of triangular pennants between two 3D points."""
    a, b = Vector(p0), Vector(p1)
    bm = bmesh.new()
    pts = []
    for i in range(n + 1):
        t = i / n
        pts.append(a.lerp(b, t) + Vector((0, 0, -sag * 4 * t * (1 - t))))
    objs = []
    for i in range(n):
        p, q = pts[i], pts[i + 1]
        mid = (p + q) / 2
        v0, v1 = p.lerp(q, 0.1), p.lerp(q, 0.9)
        tri = bmesh.new()
        tri.faces.new([tri.verts.new(v0), tri.verts.new(v1), tri.verts.new(mid + Vector((0, 0, -0.16)))])
        o = U.mesh_object(f"{name}.flag", tri, coll, M.fabric(f"pennant_{colors[i % len(colors)]}", colors[i % len(colors)], 0.3))
        objs.append(o)
    _ = bm
    cord = []
    for p, q in zip(pts[:-1], pts[1:]):
        d = q - p
        cord.append(U.cylinder(f"{name}.cord", 0.004, d.length, coll, loc=(p + q) / 2,
                               rot=d.to_track_quat("Z", "Y").to_euler(), mat=M.flat("cord", "#3A2A20", 0.8), verts=4))
    return U.join(objs + cord, name)
