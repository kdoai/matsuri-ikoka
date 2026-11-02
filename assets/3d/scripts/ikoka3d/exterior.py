"""The storefront seen from the street, its neighbors, and the entry camera path.

The exterior shares coordinates with the interior: the shop's front is the
interior's cut-away side (y = layout.Y0) and the noren bay at the front-left
belongs to interior.glb. exterior.glb adds the rest of the facade, the second
floor and roofs, two neighboring townhouses, the plaza, street lamps and a
painted dusk backdrop.

`cam.entry` (animation "entry") starts on the street, pushes toward the
noren, then cranes up to the fixed interior camera (`cam.main`, whose pose
it ends on exactly). The app fades exterior.glb out while the camera rises
(see README for the timing).
"""

import math
import os

import bpy
from mathutils import Matrix, Vector

from . import layout as L
from . import materials as M
from . import palette as P
from . import props
from . import stage
from . import util as U

ENTRY_SECONDS = 4.5
FADE = (0.5, 0.66)          # fraction of the entry path over which the app fades the exterior out
SHOP_X = (L.X0 - L.WALL_T / 2 - 0.04, L.X1 + L.WALL_T / 2 + 0.04)
FRONT = L.Y0                # facade plane
FLOOR2 = 2.95               # second floor line
EAVE2 = 5.15                # second-floor eave height


def _dark():
    return M.wood("wood_dark", P.WOOD_DARK)


def build(parent=None):
    """Build the exterior. Returns (collection, light points)."""
    root = U.collection("exterior", parent)
    lights = []
    _facade(U.collection("exterior.facade", root), lights)
    _upper(U.collection("exterior.upper", root), lights)
    _neighbors(U.collection("exterior.neighbors", root), lights)
    _plaza(U.collection("exterior.plaza", root), lights)
    return root, lights


# --------------------------------------------------------------------------
# Ground floor facade right of the noren bay


def _facade(c, lights):
    frame = _dark()
    wall = M.plaster("plaster")
    siding = M.planks("siding", P.mix(P.WOOD, P.WOOD_DARK, 0.45), grain_axis="Y")
    x0, x1 = L.ENTRY_X[1], SHOP_X[1]
    yf = FRONT + L.WALL_T / 2
    top = L.ENTRY_TOP
    U.box("facade.wall", (x1 - x0, L.WALL_T, top - L.STREET_Z), c, base=((x0 + x1) / 2, yf, L.STREET_Z), mat=wall)
    U.box("facade.base", (x1 - x0, 0.06, 0.28), c, base=((x0 + x1) / 2, FRONT - 0.03, L.STREET_Z),
          mat=M.flat("stone_base", "#7E7470", 0.9), bev=0.01)
    for x in (0.05, 2.0, x1 - 0.1):
        U.box("facade.post", (0.18, 0.2, top + 0.34), c, base=(x, yf - 0.02, L.STREET_Z), mat=frame, bev=0.015)
    U.box("facade.beam", (x1 - x0 + 0.2, 0.24, 0.2), c, base=((x0 + x1) / 2, yf - 0.02, top), mat=frame, bev=0.012)

    # Bay 1: lattice window with warm light behind.
    _lattice_window(c, "facade.win1", (x0 + 0.15, -0.05), (0.55, 2.0), lights)
    # Bay 2: posters and a bench.
    props.picture("facade.poster1", c, (0.6, 0.84), "poster_fireworks", loc=(0.62, FRONT - 0.02, 1.45), frame_w=0.025)
    props.picture("facade.poster2", c, (0.6, 0.84), "poster_mountain", loc=(1.42, FRONT - 0.02, 1.45), frame_w=0.025)
    bench = props._root("facade.bench", c, (1.02, FRONT - 0.45, L.STREET_Z))
    U.box("facade.bench.seat", (1.4, 0.38, 0.05), c, base=(0, 0, 0.4), mat=M.wood("wood_furniture", P.WOOD), bev=0.01,
          parent=bench)
    for sx in (-0.6, 0.6):
        U.box("facade.bench.leg", (0.06, 0.32, 0.4), c, base=(sx, 0, 0), mat=frame, parent=bench)
    U.box("facade.bench.cloth", (0.9, 0.39, 0.012), c, base=(0, 0, 0.45), mat=M.fabric("bench_cloth", "#B8453A", 0.4),
          parent=bench)
    # Bay 3: lattice window and a vertical banner.
    _lattice_window(c, "facade.win2", (2.25, 3.35), (0.55, 2.0), lights)
    props.textured_panel("facade.banner", c, (0.36, 1.08), "vertical_banner", loc=(3.75, FRONT - 0.03, 1.35))
    # Lower siding under the windows.
    for a, b in ((x0 + 0.1, -0.03), (2.1, 3.5)):
        m = Matrix.Translation(((a + b) / 2, FRONT - 0.012, (L.STREET_Z + 0.55) / 2)) @ Matrix.Rotation(
            math.pi, 4, "Z") @ Matrix.Rotation(math.pi / 2, 4, "X")
        props.plank_surface("facade.siding", c, (b - a, 0.55 - L.STREET_Z), plank_w=0.11, length=(9, 9),
                            seed=int(a * 10) + 70, mat=siding, along="Y", matrix=m, stagger=False)
    # First-floor eave across the whole front, above the interior's small one.
    props.kawara_eave("facade.eave", c, SHOP_X[1] - SHOP_X[0] + 0.6, 0.8, loc=(0, FRONT - 0.08, top + 0.5))
    for x in (0.9, 3.0):
        props.chochin("facade.lantern", c, loc=(x, FRONT - 0.55, top + 0.12), radius=0.15, height=0.36)
        lights.append(((x, FRONT - 0.75, top - 0.15), 40, P.LANTERN))
    # Wind chime by the door.
    fx = L.DOOR_X[1] + 0.05
    U.sphere("facade.furin", 0.05, c, loc=(fx, FRONT - 0.6, top + 0.02), scale=(1, 1, 0.9),
             mat=M.flat("glass_tint", "#BFE2F0", 0.1))
    U.box("facade.furin.strip", (0.05, 0.004, 0.16), c, base=(fx, FRONT - 0.6, top - 0.2),
          mat=M.flat("furin_paper", "#F2D7A0", 0.8))


def _lattice_window(c, name, xr, zr, lights):
    frame = _dark()
    a, b = xr
    z0, z1 = zr
    props.textured_panel(f"{name}.glow", c, (b - a, z1 - z0), "window_glow", loc=((a + b) / 2, FRONT + 0.02,
                                                                                   (z0 + z1) / 2), emission=2.0)
    U.box(f"{name}.sill", (b - a + 0.1, 0.12, 0.05), c, base=((a + b) / 2, FRONT - 0.04, z0 - 0.05), mat=frame,
          bev=0.006)
    U.box(f"{name}.head", (b - a + 0.1, 0.1, 0.05), c, base=((a + b) / 2, FRONT - 0.03, z1), mat=frame)
    n = int((b - a) / 0.07)
    for i in range(n + 1):
        U.box(f"{name}.slat", (0.025, 0.04, z1 - z0), c, base=(a + (b - a) * i / n, FRONT - 0.03, z0), mat=frame)
    for z in (z0 + (z1 - z0) * 0.33, z0 + (z1 - z0) * 0.66):
        U.box(f"{name}.rail", (b - a, 0.04, 0.02), c, base=((a + b) / 2, FRONT - 0.035, z), mat=frame)
    lights.append((((a + b) / 2, FRONT - 0.6, (z0 + z1) / 2), 25, "#FFB868"))


# --------------------------------------------------------------------------
# Second floor, big signboard, roofs, side walls


def _upper(c, lights):
    frame = _dark()
    wall = M.plaster("plaster")
    tile = M.flat("roof_tile", "#4A4C58", 0.45)
    x0, x1 = SHOP_X
    w = x1 - x0
    y2 = FRONT + 0.25
    U.box("upper.wall", (w, 0.16, EAVE2 - FLOOR2 + 0.1), c, base=(0, y2 + 0.08, FLOOR2 - 0.1), mat=wall)
    U.box("upper.beam", (w + 0.2, 0.24, 0.2), c, base=(0, y2, FLOOR2 - 0.15), mat=frame, bev=0.012)
    U.box("upper.top_beam", (w + 0.2, 0.24, 0.18), c, base=(0, y2, EAVE2 - 0.12), mat=frame, bev=0.012)
    for x in (x0 + 0.08, -0.6, 2.2, x1 - 0.08):
        U.box("upper.post", (0.18, 0.2, EAVE2 - FLOOR2), c, base=(x, y2 - 0.02, FLOOR2), mat=frame, bev=0.012)
    # Two shoji windows with warm light.
    for xa, xb in ((0.0, 1.6), (2.6, 3.7)):
        props.textured_panel("upper.window.glow", c, (xb - xa, 1.0), "window_glow",
                             loc=((xa + xb) / 2, y2 - 0.01, 3.95), emission=1.8)
        n = int((xb - xa) / 0.12)
        for i in range(n + 1):
            U.box("upper.window.slat", (0.025, 0.04, 1.0), c, base=(xa + (xb - xa) * i / n, y2 - 0.04, 3.45), mat=frame)
        U.box("upper.window.rail", (xb - xa + 0.1, 0.12, 0.06), c, base=((xa + xb) / 2, y2 - 0.06, 3.4), mat=frame)
        U.box("upper.window.rail", (xb - xa + 0.1, 0.1, 0.05), c, base=((xa + xb) / 2, y2 - 0.05, 4.45), mat=frame)
        lights.append((((xa + xb) / 2, y2 - 0.8, 3.9), 30, "#FFB868"))
    # Big signboard over the noren.
    sx = (L.DOOR_X[0] + L.DOOR_X[1]) / 2 + 0.05
    sign = props._root("upper.sign", c, (sx, y2 - 0.22, 3.6), yaw=0.0)
    sign.rotation_euler = (0.12, 0, 0)
    U.box("upper.sign.board", (2.4, 0.08, 1.06), c, loc=(0, 0.04, 0), mat=frame, bev=0.03, seg=3, parent=sign)
    props.textured_panel("upper.sign.face", c, (2.28, 0.998), "facade_sign", loc=(0, -0.002, 0), parent=sign)
    for dx in (-0.9, 0.9):
        U.box("upper.sign.bracket", (0.06, 0.3, 0.06), c, loc=(dx, 0.2, 0.42), mat=frame, parent=sign)
    # Main roof: front and back slopes with a ridge.
    depth = (L.Y1 - FRONT) / 2 + 0.7
    pitch = 0.38
    props.kawara_eave("roof.front", c, w + 0.9, depth, loc=(0, 0.1, EAVE2 + depth * math.sin(pitch) - 0.05),
                      pitch=pitch)
    back = props.kawara_eave("roof.back", c, w + 0.9, depth, loc=(0, 0.1, EAVE2 + depth * math.sin(pitch) - 0.05),
                             pitch=pitch)
    back.rotation_euler = (0, 0, math.pi)
    ridge_z = EAVE2 + depth * math.sin(pitch) + 0.02
    U.box("roof.ridge", (w + 1.0, 0.3, 0.22), c, base=(0, 0.1, ridge_z - 0.05), mat=tile, bev=0.04, seg=2)
    for sx in (-1, 1):
        U.box("roof.onigawara", (0.18, 0.34, 0.34), c, base=(sx * (w / 2 + 0.5), 0.1, ridge_z - 0.06), mat=tile,
              bev=0.05, seg=2)
    # Side walls (gable ends) above the interior walls.
    for sx in (-1, 1):
        U.box("upper.side", (0.16, L.Y1 - FRONT + 0.3, EAVE2 - L.WALL_H + 0.1), c,
              base=(sx * (w / 2 - 0.08), (L.Y1 + FRONT) / 2 + 0.1, L.WALL_H - 0.1), mat=wall)


# --------------------------------------------------------------------------
# Neighboring townhouses


def _townhouse(c, name, x0, x1, stories, lights, sign=None, noren_tex=None, wall_col="#E6D2B0", seed=1):
    frame = _dark()
    wall = M.plaster(f"plaster_{wall_col}", wall_col)
    w = x1 - x0
    cx = (x0 + x1) / 2
    h1 = 2.6
    U.box(f"{name}.body", (w, 7.0, h1 - L.STREET_Z), c, base=(cx, FRONT + 3.5 + 0.2, L.STREET_Z), mat=wall)
    lattice = M.wood("wood_lattice", P.mix(P.WOOD_DARK, "#000000", 0.2))
    n = int((w - 0.8) / 0.08)
    U.box(f"{name}.lattice_back", (w - 0.6, 0.04, 1.9), c, base=(cx, FRONT + 0.18, 0.1),
          mat=M.textured("tex_window_glow_dim", "window_glow", rough=0.9))
    for i in range(n + 1):
        U.box(f"{name}.slat", (0.03, 0.05, 1.9), c, base=(x0 + 0.3 + (w - 0.6) * i / n, FRONT + 0.15, 0.1), mat=lattice)
    for x in (x0 + 0.1, x1 - 0.1):
        U.box(f"{name}.post", (0.18, 0.2, h1 - L.STREET_Z + 0.3), c, base=(x, FRONT + 0.15, L.STREET_Z), mat=frame)
    U.box(f"{name}.beam", (w, 0.22, 0.2), c, base=(cx, FRONT + 0.15, h1 - 0.15), mat=frame)
    props.kawara_eave(f"{name}.eave", c, w + 0.3, 0.75, loc=(cx, FRONT + 0.05, h1 + 0.45))
    if stories > 1:
        top = h1 + 2.3
        U.box(f"{name}.upper", (w, 6.6, top - h1), c, base=(cx, FRONT + 3.9 + 0.2, h1), mat=wall)
        for k in range(2):
            wx = x0 + w * (0.3 + 0.4 * k)
            props.textured_panel(f"{name}.upper_win", c, (1.0, 0.8), "window_glow", loc=(wx, FRONT + 0.55, h1 + 1.1),
                                 emission=1.2 if k == 0 else 0.0)
            for i in range(7):
                U.box(f"{name}.upper_slat", (0.025, 0.04, 0.8), c, base=(wx - 0.5 + i / 6, FRONT + 0.52, h1 + 0.7),
                      mat=lattice)
        props.kawara_eave(f"{name}.roof", c, w + 0.4, 3.6, loc=(cx, FRONT + 0.35, top + 3.6 * math.sin(0.4) - 0.05),
                          pitch=0.4)
    else:
        props.kawara_eave(f"{name}.roof", c, w + 0.3, 3.9, loc=(cx, FRONT + 0.6, h1 + 0.3 + 3.9 * math.sin(0.35)),
                          pitch=0.35)
    if sign:
        props.textured_panel(f"{name}.sign", c, (0.42, 0.84), sign, loc=(x1 - 0.55, FRONT - 0.05, 1.5))
        U.box(f"{name}.sign.back", (0.48, 0.04, 0.9), c, base=(x1 - 0.55, FRONT - 0.01, 1.05), mat=frame)
    if noren_tex:
        props.noren(f"{name}.noren", c, 1.5, 0.7, loc=(cx - 0.3, FRONT - 0.05, 2.2), tex=noren_tex)
    props.chochin(f"{name}.lantern", c, loc=(x0 + 0.6, FRONT - 0.45, h1 + 0.05), radius=0.13, height=0.3,
                  tex="lantern_matsuri")
    lights.append(((x0 + 0.6, FRONT - 0.65, h1 - 0.25), 30, P.LANTERN))
    _ = seed


def _neighbors(c, lights):
    _townhouse(c, "left", -10.6, SHOP_X[0] - 0.05, 2, lights, sign="shop_sign_tea", noren_tex="noren_tea",
               wall_col="#E8D8BC")
    _townhouse(c, "right", SHOP_X[1] + 0.05, 10.6, 1, lights, sign="shop_sign_inn", wall_col="#DCC7A6", seed=2)
    props.hydrangea("right.planter", c, loc=(6.2, FRONT - 0.45, L.STREET_Z), size=1.1, seed=7)
    props.leafy_plant("left.plant", c, loc=(-6.0, FRONT - 0.4, L.STREET_Z), size=1.6, seed=21, pot="#7E6A5A")


# --------------------------------------------------------------------------
# Plaza, street lamps, backdrop


def _plaza(c, lights):
    stone = M.cobblestone("cobblestone")
    U.box("plaza.ground", (40, 24, 0.2), c, base=(0, FRONT - 12.0, L.STREET_Z - 0.225), mat=stone)
    for x, y in ((-6.2, -8.0), (6.4, -7.6), (-7.5, -15.0)):
        _street_lamp(c, f"plaza.lamp", (x, y), lights)
    props.textured_panel("backdrop", c, (140, 36), "backdrop", loc=(0, 42, 13), facing="-Y")
    bd = c.objects["backdrop"]
    _unlit(bd, "backdrop")


def _street_lamp(c, name, xy, lights):
    x, y = xy
    frame = _dark()
    U.box(f"{name}.base", (0.36, 0.36, 0.3), c, base=(x, y, L.STREET_Z), mat=M.flat("stone_step", "#8D8279", 0.9),
          bev=0.03)
    U.box(f"{name}.pole", (0.12, 0.12, 2.2), c, base=(x, y, L.STREET_Z + 0.3), mat=frame, bev=0.01)
    U.box(f"{name}.box", (0.4, 0.4, 0.46), c, base=(x, y, L.STREET_Z + 2.5),
          mat=M.emissive("street_lamp_paper", "#FFC27A", 3.0, base="#FBE9C8"))
    U.box(f"{name}.cap", (0.56, 0.56, 0.08), c, base=(x, y, L.STREET_Z + 2.96), mat=frame, bev=0.02)
    U.cylinder(f"{name}.knob", 0.05, 0.1, c, base=(x, y, L.STREET_Z + 3.04), mat=frame, verts=10)
    lights.append(((x, y, L.STREET_Z + 2.7), 120, P.LANTERN))


def _unlit(obj, tex):
    """Give `obj` an unlit (glTF KHR_materials_unlit) material showing `tex` as painted."""
    from . import textures as T
    mat = bpy.data.materials.new(f"unlit_{tex}")
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    img = nt.nodes.new("ShaderNodeTexImage")
    img.image = T.get(tex)
    bg = nt.nodes.new("ShaderNodeBackground")
    nt.links.new(img.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def is_unlit(obj):
    return any(s.material and s.material.node_tree and "Background" in s.material.node_tree.nodes
               for s in obj.material_slots)


# --------------------------------------------------------------------------
# Lighting and the entry camera


def lights_dusk(coll, points):
    stage.world_dusk(0.35)
    sun = bpy.data.lights.new("light.sunset", "SUN")
    sun.energy = 1.1
    sun.color = P.lin("#FF9C78")[:3]
    sun.angle = math.radians(6)
    so = bpy.data.objects.new("light.sunset", sun)
    coll.objects.link(so)
    so.rotation_euler = U.look_at_rotation((-6, -8, 3.5), (0, 0, 0))
    stage.area("light.sky", coll, (2, -14, 12), (0, -3, 2), 380, "#8C84D8", size=14)
    for i, (loc, power, color) in enumerate(points):
        stage.point(f"light.ext.{i:02d}", coll, loc, power, color)


def _catmull(p0, p1, p2, p3, t):
    t2, t3 = t * t, t * t * t
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)


def _spline(points, u):
    """Catmull-Rom through `points` (Vectors), u in [0, 1]."""
    n = len(points) - 1
    seg = min(int(u * n), n - 1)
    t = u * n - seg
    p = [points[max(0, min(n, seg + k))] for k in (-1, 0, 1, 2)]
    return _catmull(p[0], p[1], p[2], p[3], t)


def entry_keys():
    main_loc = stage.orbit_position(stage.MAIN_TARGET, stage.MAIN_AZIMUTH, stage.MAIN_ELEVATION, stage.MAIN_DISTANCE)
    locs = [Vector((0.6, -20.5, 2.0)), Vector((-1.4, -12.0, 1.6)), Vector((-2.5, -7.4, 1.4)),
            Vector((-3.9, -10.2, 5.2)), main_loc]
    targets = [Vector((-0.2, FRONT, 3.0)), Vector((-2.0, FRONT, 2.0)), Vector((-2.65, FRONT, 1.35)),
               Vector((-0.8, -0.6, 1.0)), Vector(stage.MAIN_TARGET)]
    return locs, targets


def entry_camera(coll):
    """Animated camera `cam.entry` (action "entry", ENTRY_SECONDS long)."""
    cam_data = bpy.data.cameras.new("cam.entry")
    cam_data.lens = stage.MAIN_LENS
    cam_data.sensor_width = 36
    cam_data.clip_start = 0.1
    cam_data.clip_end = 200
    cam = bpy.data.objects.new("cam.entry", cam_data)
    coll.objects.link(cam)
    cam.rotation_mode = "QUATERNION"
    locs, targets = entry_keys()
    frames = int(ENTRY_SECONDS * 30)
    act = bpy.data.actions.new("entry")
    cam.animation_data_create()
    cam.animation_data.action = act
    prev = None
    for f in range(frames + 1):
        u = f / frames
        e = u * u * (3 - 2 * u)
        e = 0.5 * e + 0.5 * (u * u * u * (u * (u * 6 - 15) + 10))
        loc = _spline(locs, e)
        tgt = _spline(targets, e)
        q = (tgt - loc).to_track_quat("-Z", "Y")
        if prev is not None and prev.dot(q) < 0:
            q.negate()
        prev = q
        cam.location = loc
        cam.rotation_quaternion = q
        cam.keyframe_insert("location", frame=f + 1)
        cam.keyframe_insert("rotation_quaternion", frame=f + 1)
    act.frame_range = (1, frames + 1)
    act.use_frame_range = True
    return cam


# --------------------------------------------------------------------------
# Build target


def bake_groups(root):
    from .bake import is_glow
    groups = {}
    for coll in root.children:
        zone = coll.name.split(".", 1)[1]
        for obj in coll.all_objects:
            if obj.type != "MESH" or is_glow(obj) or is_unlit(obj):
                continue
            n = obj.name
            if n.startswith(("roof", "facade.eave", "left.eave", "right.eave", "left.roof", "right.roof")):
                g = "roofs"
            elif zone == "neighbors":
                g = "neighbor_left" if n.startswith("left") else "neighbor_right"
            else:
                g = zone
            groups.setdefault(g, []).append(obj)
    return groups


def target(args, fresh, save, glb):
    from . import bake, export, interior
    fresh()
    _, lantern_points = interior.build()
    root, ext_points = build()
    st = U.collection("stage")
    lights_dusk(st, lantern_points + ext_points)
    cam = entry_camera(st)
    main = stage.main_camera(st)
    tris = U.triangle_count([o for o in root.all_objects if o.type == "MESH"])
    print(f"[ikoka3d] exterior triangles: {tris}")
    save(args, "exterior")
    if not args.no_render:
        stage.setup_render(args.res, args.samples)
        bpy.context.scene.camera = cam
        for name, frame in (("exterior", 1), ("exterior_entry_mid", int(ENTRY_SECONDS * 30 * 0.42))):
            bpy.context.scene.frame_set(frame)
            stage.render(os.path.join(args.out, "preview", f"{name}.png"), cam)
        bpy.context.scene.frame_set(1)
    if args.no_export:
        return
    bpy.context.scene.camera = main
    stage.setup_render(args.res, args.samples)
    groups = bake_groups(root)
    baked = bake.bake_all(groups, os.path.join(args.out, "bake", "exterior"), args.bake_res, args.bake_samples)
    keep = set(baked)
    keep |= {o for o in root.all_objects if o.type == "MESH" and (bake.is_glow(o) or is_unlit(o))}
    bpy.context.view_layer.update()
    for o in keep:
        m = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = m
    keep.add(cam)
    for o in list(bpy.data.objects):
        if o not in keep:
            bpy.data.objects.remove(o)
    print(f"[ikoka3d] exterior export triangles: {U.triangle_count([o for o in keep if o.type == 'MESH'])}")
    for act in [a for a in bpy.data.actions if a.name != "entry"]:
        bpy.data.actions.remove(act)          # the interior's gimmick clips are not part of this file
    cam.animation_data.action = bpy.data.actions["entry"]
    export.export_glb(glb(args, "exterior"), list(keep), animations=True, cameras=True, action_mode="ACTIONS")
