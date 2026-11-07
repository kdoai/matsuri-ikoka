"""The festival street outside the shop.

Same coordinates as the interior and the exterior: the noren is at the far +Y
end, the street runs toward -Y with stalls left and right and the headquarters
tent closing the far end. `cam.ennichi` looks down the street from the shop's
side; the exterior is behind it and need not be drawn.

Each stall's lantern has an unlit state (baked with the stall) and a lit state
(`lantern.<role>.on`, an emissive mesh with its glow). See stalls.py.
"""

import math
import os

import bmesh
import bpy
from mathutils import Vector

from . import canvas
from . import characters
from . import exterior
from . import layout as L
from . import materials as M
from . import motions
from . import navigation
from . import palette as P
from . import props
from . import stage
from . import stalls
from . import textures as T
from . import util as U

Z = L.STREET_Z
ROW_X = 4.3
FAN = math.radians(40)      # the rows turn this much toward the shop's end of the street
LEFT, RIGHT = math.pi / 2 + FAN, -(math.pi / 2 + FAN)
SLOTS = {
    "access": (-ROW_X, -7.3, LEFT),
    "lodging": (-ROW_X, -11.4, LEFT),
    "etiquette": (-ROW_X, -15.5, LEFT),
    "weather": (ROW_X, -7.3, RIGHT),
    "food": (ROW_X, -11.4, RIGHT),
    "headquarters": (0.0, -20.6, math.pi),
}
REST_SPOT = (ROW_X, -15.5, RIGHT)   # benches, a drum and goldfish: nothing to read, just a place to pause
WALK = [(-4.1, -3.05), (4.1, -3.05), (4.1, -18.9), (-4.1, -18.9)]
# How far the camera stands from each stall, and its lens.
STALL_VIEW = {"headquarters": (9.0, 36)}
DEFAULT_VIEW = (6.0, 32)


def _dark():
    return M.wood("wood_dark", P.WOOD_DARK)


def _world(root, local):
    return root.matrix_basis @ Vector(local)


# --------------------------------------------------------------------------
# Street, poles, lights, trees


def _road(c):
    """The road fills the view, so it gets its own bake. Near-square lengths pack that texture best."""
    stone = M.cobblestone("road_stone", "#B8A594", scale=2.2)
    start, length, parts = -0.3, 22.6, 4
    for i in range(parts):
        y = start - (i + 0.5) * length / parts
        U.box("street.road", (5.2, length / parts, 0.2), c, base=(0, y, Z - 0.2), mat=stone)
    curb = M.flat("stone_step", "#8D8279", 0.9)
    for s in (-1, 1):
        for i in range(19):
            U.box("street.curb", (0.16, 1.1, 0.05), c, base=(s * 2.66, -3.1 - i * 1.18, Z - 0.02), mat=curb, bev=0.012, parent=None)


def _street(c):
    earth = M.plaster("ground_earth", "#A68C70")
    U.box("street.earth", (26, 34, 0.2), c, base=(0, -14.0, Z - 0.205), mat=earth)
    far = U.box("street.far", (120, 90, 0.2), c, base=(0, -35.0, Z - 0.4), mat=None)
    exterior._unlit(far, "far_ground")
    back = props.textured_panel("backdrop", c, (64, 16), "ennichi_backdrop", loc=(0, -52, 7), facing="+Y")
    exterior._unlit(back, "ennichi_backdrop")


def _bulb_string(c, p0, p1, n, sag, bulbs, step=2):
    """A wire with bare bulbs, sagging between two points."""
    a, b = Vector(p0), Vector(p1)
    pts = [a.lerp(b, i / n) + Vector((0, 0, -sag * 4 * (i / n) * (1 - i / n))) for i in range(n + 1)]
    wire = M.flat("cord", "#3A2A20", 0.8)
    for q, r in zip(pts[:-1], pts[1:]):
        d = r - q
        U.cylinder("street.wire", 0.008, d.length, c, loc=(q + r) / 2, rot=d.to_track_quat("Z", "Y").to_euler(), mat=wire, verts=4)
    for i in range(1, n, step):
        bulbs.append(pts[i] + Vector((0, 0, -0.06)))


def _decor(c, bulb_coll, lights):
    """Poles stand in the pockets between stalls, so they never block a stall's front."""
    wood = _dark()
    bulbs = []
    top = Z + 3.6
    ys = (-9.35, -13.45, -17.55)
    for s in (-1, 1):
        chain = [(s * 5.5, -4.5)] + [(s * 3.0, y) for y in ys]
        for x, y in chain:
            U.cylinder("street.pole", 0.055, 3.72, c, base=(x, y, Z), mat=wood, verts=8)
        for (x0, y0), (x1, y1) in zip(chain, chain[1:]):
            _bulb_string(c, (x0, y0, top), (x1, y1, top), 12, 0.26, bulbs)
    for y in ys:
        _bulb_string(c, (-3.0, y, top), (3.0, y, top), 14, 0.42, bulbs)
    bm = bmesh.new()
    for p in bulbs:
        bmesh.ops.create_icosphere(bm, subdivisions=2, radius=0.042, matrix=U.mat_trs(p))
    U.mesh_object("street.bulbs", bm, bulb_coll, M.emissive("street_bulb", "#FFB45E", 2.6, base="#FBE9C8"), smooth=True)
    for y in ys:
        for s in (-1, 1):
            lights.append(((s * 2.4, y + 0.1, top - 0.4), 42, "#FFC88C"))
        lights.append(((0, y, top - 0.6), 34, "#FFC88C"))
    lights.append(((0, -5.4, top - 0.6), 46, "#FFC88C"))
    # Bunting across the street.
    for y in (-13.45, -17.55):
        flags = props.bunting("street.bunting", c, (-3.0, y, top + 0.02), (3.0, y, top + 0.02), n=15, sag=0.36)
        flags.modifiers.new("Solidify", "SOLIDIFY").thickness = 0.004
    # Banners in the same pockets, and a pair where the street begins.
    spots = [(s * 3.5, y - 0.2) for y in ys for s in (-1, 1)] + [(-5.9, -4.8), (5.9, -4.8)]
    for k, (x, y) in enumerate(spots):
        yaw = LEFT if x < 0 else RIGHT
        loc = (x, y, Z + 1.34)
        banner = props.textured_panel(f"street.nobori{k}", c, (0.42, 1.6), "nobori", loc=loc, facing=(math.pi / 2, 0, yaw), cell=(k % 2, 2, 1), rough=0.95)
        banner.modifiers.new("Solidify", "SOLIDIFY").thickness = 0.006
        U.cylinder("street.nobori_pole", 0.016, 2.3, c, base=(loc[0] + math.cos(yaw) * 0.22, loc[1] + math.sin(yaw) * 0.22, Z), mat=wood, verts=6)
        d = Vector((math.cos(yaw), math.sin(yaw), 0))
        U.cylinder("street.nobori_rod", 0.012, 0.46, c, loc=Vector(loc) + Vector((0, 0, 0.82)), rot=d.to_track_quat("Z", "Y").to_euler(), mat=wood, verts=6)


def _rest(c):
    """Pause by the road: a drum on a low stage, a bench, a goldfish tub. Returns (root, lights, seats)."""
    x, y, yaw = REST_SPOT
    root = props._root("rest", c, (x, y, Z), yaw)
    wood = M.wood("wood_furniture", P.WOOD)
    U.box("rest.stage", (1.7, 1.5, 0.34), c, base=(0.5, 0.4, 0), mat=wood, bev=0.012, parent=root)
    cloth = props.textured_panel("rest.skirt", c, (1.7, 0.3), "kohaku", loc=(0.5, -0.36, 0.17), parent=root)
    cloth.modifiers.new("Solidify", "SOLIDIFY").thickness = 0.006
    props.taiko("rest.taiko", c, (0.5, 0.45, 0.34), yaw=0.0, r=0.34, length=0.56).parent = root
    props.bench("rest.bench", c, loc=(-1.05, 0.1, 0), yaw=0.0, length=1.3).parent = root
    props.kingyo_tub("rest.tub", c, (0.5, -1.0, 0), r=0.42, seed=5).parent = root
    props.leafy_plant("rest.plant", c, (-2.0, 0.3, 0), size=1.6, seed=31, pot="#7E6A5A").parent = root
    seats = [(f"seat.street.{i}", root.matrix_basis @ Vector((-1.05 + (i - 0.5) * 0.6, -0.02, 0.42)), yaw) for i in range(2)]
    return root, [((0.4, -0.6, 2.2), 26, "#FFCF9A")], seats


def _trees(c):
    """Dark trees behind the rows and past the far end, so the stalls stand out against them."""
    trunk = M.wood("wood_dark", P.WOOD_DARK)
    bm = bmesh.new()
    spots = [(-8.6, -5.5, 0.72), (-9.8, -10.0, 0.8), (-8.8, -14.5, 0.72), (-9.2, -19.5, 0.74), (-7.0, -25.2, 0.72), (-2.8, -27.2, 0.66),
             (2.6, -27.0, 0.7), (7.4, -25.0, 0.72), (9.4, -19.0, 0.74), (8.8, -14.0, 0.72), (9.8, -9.5, 0.8), (8.6, -5.0, 0.72),
             (-12.5, -16.5, 0.9), (12.5, -15.0, 0.9), (-11.5, -8.0, 0.9), (11.5, -6.5, 0.9), (-12.0, -23.0, 0.85), (12.0, -22.5, 0.85)]
    for i, (x, y, s) in enumerate(spots):
        U.cylinder("trees.trunk", 0.2 * s, 2.4 * s, c, base=(x, y, Z), mat=trunk, verts=6)
        for dx, dy, dz, r in ((0, 0, 3.3, 1.5), (0.9, 0.3, 2.7, 1.05), (-0.85, -0.2, 2.75, 1.1), (0.1, -0.4, 4.1, 1.0)):
            m = U.mat_trs((x + dx * s, y + dy * s, Z + dz * s), (0, 0, i * 0.7))
            bmesh.ops.create_icosphere(bm, subdivisions=2, radius=r * s, matrix=m)
    U.mesh_object("trees.crowns", bm, c, M.felt("tree_dusk", "#5E8A6C", 0.15), smooth=True)
    return spots


# --------------------------------------------------------------------------
# Anchors, nav, cameras


def _facing(root, local_from, local_to):
    return U.yaw_to(_world(root, local_from), _world(root, local_to))


def _anchors(c, roots):
    for role, root in roots.items():
        yaw = SLOTS[role][2]
        spot = (0, -1.65, 0) if role != "headquarters" else (0, -2.35, 0)
        road_side = -1.0 if SLOTS[role][0] < 0 else 1.0     # the guide stands toward the road, clear of the poles
        guide = (road_side * 1.05, -1.75, 0) if role != "headquarters" else (1.2, -2.45, 0)
        U.empty(f"anchor.stall.{role}", c, loc=_world(root, spot), rot=(0, 0, yaw + math.pi), size=0.3, kind="SINGLE_ARROW")
        U.empty(f"anchor.guide.{role}", c, loc=_world(root, guide), rot=(0, 0, _facing(root, guide, spot)), size=0.3, kind="SINGLE_ARROW")
    door = (L.DOOR_X[0] + L.DOOR_X[1]) / 2
    U.empty("anchor.shop.door", c, loc=(door, L.Y0 - 0.25, Z), rot=(0, 0, math.pi), size=0.3, kind="SINGLE_ARROW")
    U.empty("anchor.player.start", c, loc=(door, L.Y0 - 0.7, Z), rot=(0, 0, 0), size=0.3, kind="SINGLE_ARROW")
    U.empty("anchor.guide.start", c, loc=(door + 0.75, L.Y0 - 1.2, Z), rot=(0, 0, 0), size=0.3, kind="SINGLE_ARROW")
    U.empty("anchor.guide.home", c, loc=(0.55, -5.2, Z), rot=(0, 0, U.yaw_to((0.55, -5.2, 0), (door, L.Y0 - 0.7, 0))), size=0.3, kind="SINGLE_ARROW")


def _nav(c, loose, stalls_by_root):
    """The walkable ground. The stalls stand at an angle, so their parts are measured in each stall's own axes."""
    blockers = navigation.floor_blockers(loose, floor=Z)
    framed = [(root.matrix_basis, navigation.floor_blockers(objs, frame=root.matrix_basis)) for root, objs in stalls_by_root]
    nav = navigation.build("nav.street", c, WALK, blockers, z=Z + 0.002, cell=0.2, framed=framed, whole_cells=True)
    navigation.keep_reachable(nav, c.objects["anchor.player.start"].location.to_tuple()[:2])
    return nav


def _check_spots(nav, markers):
    """Every place a character is sent to has to be on the ground it can walk from the shop's door."""
    spots = {o.name: o.location.to_tuple()[:2] for o in markers.objects if o.name.startswith("anchor.")}
    missing = navigation.missing_spots(nav, spots["anchor.player.start"], spots)
    if missing:
        raise RuntimeError(f"not reachable on nav.street: {', '.join(missing)}")
    pieces = navigation.pieces(nav)
    if pieces != 1:
        raise RuntimeError(f"nav.street is in {pieces} pieces, with no way to walk between them")


def _cameras(coll, roots):
    main = stage.camera("cam.ennichi", coll, (0.0, 9.0, 8.2), (0.0, -11.0, 1.6), lens=35)
    cams = {}
    for role, root in roots.items():
        dist, lens = STALL_VIEW.get(role, DEFAULT_VIEW)
        pos = _world(root, (0.45, -dist, 2.6))
        target = _world(root, (0, -0.2, 1.62))
        cams[role] = stage.camera(f"cam.stall.{role}", coll, pos, target, lens=lens)
    return main, cams


# --------------------------------------------------------------------------
# Build


def build(parent=None):
    """Build the street. Returns (collection, {role: stall root}, {role: lit mesh}, light points)."""
    root = U.collection("ennichi", parent)
    lit = U.collection("ennichi.lit", root)
    street = U.collection("ennichi.street", root)
    road = U.collection("ennichi.road", root)
    decor = U.collection("ennichi.decor", root)
    lights = []
    _street(street)
    _road(road)
    _decor(decor, lit, lights)
    _trees(U.collection("ennichi.trees", root))
    roots, shells, by_root = {}, {}, []
    for role, (x, y, yaw) in SLOTS.items():
        c = U.collection(f"ennichi.stall_{role}", root)
        rt = props._root(f"stall.{role}", c, (x, y, Z), yaw)
        roots[role] = rt
        shells[role] = []
        for loc, power, color in stalls.build(role, rt, c, shells[role]):
            lights.append(((rt.matrix_basis @ Vector(loc)).to_tuple(), power, color))
        by_root.append((rt, c))
    rest_coll = U.collection("ennichi.rest", root)
    _rest_root, rest_lights, seats = _rest(rest_coll)
    for loc, power, color in rest_lights:
        lights.append(((_rest_root.matrix_basis @ Vector(loc)).to_tuple(), power, color))
    by_root.append((_rest_root, rest_coll))
    markers = U.collection("ennichi.markers", root)
    for name, loc, yaw in seats:
        U.empty(name, markers, loc=loc, rot=(0, 0, yaw), size=0.2, kind="SINGLE_ARROW")
    _anchors(markers, roots)
    bpy.context.view_layer.update()
    lanterns = {}
    for role, parts in shells.items():
        for o in parts:
            lit.objects.link(o)
            for coll in list(o.users_collection):
                if coll is not lit:
                    coll.objects.unlink(o)
        lanterns[role] = U.join(parts, f"lantern.{role}.on")
    _check_spots(_nav(markers, list(decor.all_objects), [(rt, list(c.all_objects)) for rt, c in by_root]), markers)
    return root, roots, lanterns, lights


def set_lanterns(lanterns, lit=()):
    """Show the lit state of the stalls in `lit`; the others stay dark (preview and bake only)."""
    for role, obj in lanterns.items():
        obj.hide_render = role not in lit


def lights_dusk(coll, points):
    """Dusk at the street: lavender sky, a low sun from the far end, warm bulbs and work lamps."""
    stage.world_dusk(0.8)
    sun = bpy.data.lights.new("light.sunset", "SUN")
    sun.energy = 1.0
    sun.color = P.lin("#FF9C78")[:3]
    sun.angle = math.radians(8)
    so = bpy.data.objects.new("light.sunset", sun)
    coll.objects.link(so)
    so.rotation_euler = U.look_at_rotation((-6, -34, 9), (0, -10, 0))
    stage.area("light.sky", coll, (0, -12, 16), (0, -12, 0), 1500, "#A8A0E4", size=30)
    stage.area("light.fill", coll, (0, 10, 10), (0, -12, 1), 900, "#FFD9B0", size=16)
    for i, (loc, power, color) in enumerate(points):
        stage.point(f"light.street.{i:02d}", coll, loc, power, color, radius=0.15)


def bake_groups(root):
    from .bake import keeps_material
    groups = {}
    for coll in root.children:
        zone = coll.name.split(".", 1)[1]
        if zone in ("lit", "markers"):
            continue
        for obj in coll.all_objects:
            if obj.type != "MESH" or keeps_material(obj) or exterior.is_unlit(obj) or obj.get("ikoka_nav"):
                continue
            groups.setdefault(zone, []).append(obj)
    return groups


# --------------------------------------------------------------------------
# Previews


def _people(coll):
    """The guide and the traveler on the street, for scale in the previews."""
    from . import guide
    arm = guide.dressed(coll, loc=(-0.5, -8.4, Z), yaw=math.radians(165))
    motions.assign(arm, motions.bake(arm, "wave_flag"), frame=12)
    penguin = characters.placeholder("penguin", coll, loc=(0.35, -6.9, Z), yaw=math.radians(175))
    characters.set_expression("happy")
    return arm, penguin


def _label(sheet, text, x, y, size=26):
    sheet.rect(x + 8, y + 8, x + 8 + size * (len(text) + 1), y + 8 + size + 14, "#2B2220", radius=6, alpha=0.78)
    sheet.text(text, x + 8 + size / 2, y + 15, size, "#FFF4DC", anchor="lt", weight=0.02)


def _stall_sheet(args, cams, lanterns):
    """Each stall close up, dark above and lit below."""
    w, h = 640, 420
    stage.setup_render((w, h), max(16, args.samples // 2))
    roles = list(cams)
    rows = 2 * ((len(roles) + 2) // 3)
    sheet = canvas.Canvas(3 * w, rows * h, "#FFFFFF")
    tmp = os.path.join(args.out, "preview", "_cell.png")
    for k, role in enumerate(roles):
        cx, cy = (k % 3) * w, (k // 3) * 2 * h
        word = T.STALL_LOOK[role][1]
        for j, state in enumerate(("消灯", "点灯")):
            set_lanterns(lanterns, (role,) if j else ())
            stage.render(tmp, cams[role])
            sheet.paste_file(tmp, cx, cy + j * h)
            _label(sheet, f"{word}（{state}）", cx, cy + j * h)
    os.remove(tmp)
    sheet.save(os.path.join(args.out, "preview", "ennichi_stalls.png"))
    set_lanterns(lanterns)


def _silhouette_sheet(args, cams):
    """Stalls as flat black shapes: they have to differ with no color and no letters."""
    w, h = 480, 360
    scene = bpy.context.scene
    stage.setup_render((w, h), 8)
    scene.render.use_compositing = False
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    world = bpy.data.worlds.new("flat_white")
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (1, 1, 1, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
    keep_world = scene.world
    scene.world = world
    black = bpy.data.materials.new("silhouette")
    b = black.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (0, 0, 0, 1)
    b.inputs["Specular IOR Level"].default_value = 0.0
    b.inputs["Roughness"].default_value = 1.0
    vl = bpy.context.view_layer
    vl.material_override = black
    shown = {}
    root = bpy.data.collections["ennichi"]
    for coll in root.children:
        shown[coll.name] = coll.hide_render
        coll.hide_render = True
    people = bpy.data.collections.get("ennichi.people")
    if people is not None:
        people.hide_render = True
    for light in [o for o in scene.objects if o.type == "LIGHT"]:
        light.hide_render = True
    sheet = canvas.Canvas(3 * w, 2 * h, "#FFFFFF")
    tmp = os.path.join(args.out, "preview", "_cell.png")
    for k, role in enumerate(cams):
        coll = bpy.data.collections[f"ennichi.stall_{role}"]
        coll.hide_render = False
        stage.render(tmp, cams[role])
        sheet.paste_file(tmp, (k % 3) * w, (k // 3) * h)
        coll.hide_render = True
    os.remove(tmp)
    sheet.save(os.path.join(args.out, "preview", "ennichi_silhouettes.png"))
    vl.material_override = None
    scene.world = keep_world
    for name, value in shown.items():
        bpy.data.collections[name].hide_render = value
    if people is not None:
        people.hide_render = False
    for light in [o for o in scene.objects if o.type == "LIGHT"]:
        light.hide_render = False


def _previews(args, cam, cams, lanterns):
    out = os.path.join(args.out, "preview")
    stage.setup_render(args.res, args.samples)
    set_lanterns(lanterns)
    stage.render(os.path.join(out, "ennichi_off.png"), cam)
    set_lanterns(lanterns, ("weather", "lodging"))
    stage.render(os.path.join(out, "ennichi_on.png"), cam)
    set_lanterns(lanterns)
    _stall_sheet(args, cams, lanterns)
    _silhouette_sheet(args, cams)


# --------------------------------------------------------------------------
# Build target


def target(args, fresh, save, glb):
    from . import bake, export
    fresh()
    root, roots, lanterns, points = build()
    st = U.collection("stage")
    lights_dusk(st, points)
    cam, cams = _cameras(st, roots)
    tris = U.triangle_count([o for o in root.all_objects if o.type == "MESH" and not o.get("ikoka_nav")])
    print(f"[ikoka3d] ennichi triangles: {tris}")
    save(args, "ennichi")
    if not args.no_render:
        _people(U.collection("ennichi.people"))
        _previews(args, cam, cams, lanterns)
    if args.no_export:
        return
    fresh()
    root, roots, lanterns, points = build()
    st = U.collection("stage")
    lights_dusk(st, points)
    cam, cams = _cameras(st, roots)
    set_lanterns(lanterns)
    bpy.context.scene.camera = cam
    stage.setup_render(args.res, args.samples)
    everything = list(root.all_objects)
    kept = {o for o in everything if o.type == "MESH" and (bake.keeps_material(o) or exterior.is_unlit(o))}
    markers = {o for o in everything if o.name.startswith(("anchor.", "seat.")) or o.get("ikoka_nav")}
    baked = bake.bake_all(bake_groups(root), os.path.join(args.out, "bake", "ennichi"), args.bake_res, args.bake_samples)
    keep = set(baked) | kept | markers
    bpy.context.view_layer.update()
    for o in keep:
        m = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = m
    keep |= {cam, *cams.values()}
    for o in list(bpy.data.objects):
        if o not in keep:
            bpy.data.objects.remove(o)
    print(f"[ikoka3d] ennichi export triangles: {U.triangle_count([o for o in keep if o.type == 'MESH' and not o.get('ikoka_nav')])}")
    save(args, "ennichi_baked")
    export.export_glb(glb(args, "ennichi"), list(keep), cameras=True)
    if not args.no_render:
        for o in lanterns.values():
            o.hide_render = True
        lanterns["weather"].hide_render = False
        stage.render_baked_preview(os.path.join(args.out, "preview", "ennichi_baked.png"), cam, args.res)
