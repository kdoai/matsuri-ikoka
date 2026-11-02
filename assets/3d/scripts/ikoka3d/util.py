"""Scene, collection and mesh helpers shared by every builder.

All geometry is created from bmesh primitives so the build never depends on
operator context. Units are meters, Z is up, and the front of every
character faces -Y (it becomes +Z in the exported glTF).
"""

import math

import bmesh
import bpy
from mathutils import Matrix, Vector


# --------------------------------------------------------------------------
# Scene and collections


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.render.fps = 30
    return scene


def collection(name, parent=None):
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
        (parent or bpy.context.scene.collection).children.link(coll)
    return coll


def empty(name, coll, loc=(0, 0, 0), rot=(0, 0, 0), parent=None, size=0.2, kind="PLAIN_AXES"):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = kind
    obj.empty_display_size = size
    obj.location = loc
    obj.rotation_euler = rot
    coll.objects.link(obj)
    if parent is not None:
        obj.parent = parent
    return obj


# --------------------------------------------------------------------------
# Mesh objects


def _bm():
    """New bmesh with a UV layer (bmesh primitives only fill UVs if one exists)."""
    bm = bmesh.new()
    bm.loops.layers.uv.new("UVMap")
    return bm


def mesh_object(name, bm, coll, mat=None, smooth=False, parent=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    coll.objects.link(obj)
    if mat is not None:
        for m in mat if isinstance(mat, (list, tuple)) else [mat]:
            me.materials.append(m)
    if smooth:
        me.shade_smooth()
    if parent is not None:
        obj.parent = parent
    return obj


def place(obj, loc=(0, 0, 0), rot=(0, 0, 0), scale=None):
    obj.location = loc
    obj.rotation_euler = rot
    if scale is not None:
        obj.scale = scale if hasattr(scale, "__len__") else (scale,) * 3
    return obj


def bevel(obj, width=0.01, segments=2, angle=40.0, harden=True):
    mod = obj.modifiers.new("Bevel", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(angle)
    mod.harden_normals = harden
    obj.data.shade_smooth()
    return obj


def subsurf(obj, levels=2):
    mod = obj.modifiers.new("Subsurf", "SUBSURF")
    mod.levels = levels
    mod.render_levels = levels
    obj.data.shade_smooth()
    return obj


def box(name, size, coll, base=None, loc=None, rot=(0, 0, 0), mat=None, bev=0.0, seg=2, parent=None):
    """Axis-aligned box. `base` puts the bottom face center at that point."""
    bm = _bm()
    bmesh.ops.create_cube(bm, size=1.0, calc_uvs=True)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    if base is not None:
        bmesh.ops.translate(bm, vec=Vector((0, 0, size[2] / 2)), verts=bm.verts)
        loc = base
    obj = mesh_object(name, bm, coll, mat, parent=parent)
    place(obj, loc or (0, 0, 0), rot)
    if bev > 0:
        bevel(obj, bev, seg)
    return obj


def cylinder(name, radius, depth, coll, base=None, loc=None, rot=(0, 0, 0), mat=None, verts=24,
             radius2=None, bev=0.0, seg=2, smooth=True, cap=True, parent=None):
    """Z-aligned cylinder (or cone when radius2 is given)."""
    bm = _bm()
    bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=verts, radius1=radius,
                          radius2=radius if radius2 is None else radius2, depth=depth, calc_uvs=True)
    if base is not None:
        bmesh.ops.translate(bm, vec=Vector((0, 0, depth / 2)), verts=bm.verts)
        loc = base
    obj = mesh_object(name, bm, coll, mat, smooth=smooth, parent=parent)
    place(obj, loc or (0, 0, 0), rot)
    if bev > 0:
        bevel(obj, bev, seg, angle=60)
    return obj


def sphere(name, radius, coll, loc=(0, 0, 0), rot=(0, 0, 0), scale=None, mat=None, segs=24, rings=14,
           parent=None):
    bm = _bm()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=radius, calc_uvs=True)
    obj = mesh_object(name, bm, coll, mat, smooth=True, parent=parent)
    return place(obj, loc, rot, scale)


def plane(name, size, coll, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, cuts=0, parent=None):
    """XY plane of `size` (w, h); rotate it to stand it up."""
    bm = _bm()
    bmesh.ops.create_grid(bm, x_segments=cuts + 1, y_segments=cuts + 1, size=0.5, calc_uvs=True)
    bmesh.ops.scale(bm, vec=Vector((size[0], size[1], 1)), verts=bm.verts)
    obj = mesh_object(name, bm, coll, mat, parent=parent)
    return place(obj, loc, rot)


def wall_plane(name, width, height, coll, base, facing, mat=None, cuts=0, parent=None):
    """Upright plane whose bottom edge center sits at `base`, normal along `facing` (+X, -X, +Y, -Y)."""
    rot = {
        "-Y": (math.pi / 2, 0, 0),
        "+Y": (math.pi / 2, 0, math.pi),
        "+X": (math.pi / 2, 0, math.pi / 2),
        "-X": (math.pi / 2, 0, -math.pi / 2),
    }[facing]
    obj = plane(name, (width, height), coll, mat=mat, cuts=cuts, parent=parent)
    obj.rotation_euler = rot
    obj.location = Vector(base) + Vector((0, 0, height / 2))
    return obj


def torus(name, major, minor, coll, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, major_segs=32, minor_segs=10,
          parent=None):
    bm = bmesh.new()
    for i in range(major_segs):
        a = 2 * math.pi * i / major_segs
        for j in range(minor_segs):
            b = 2 * math.pi * j / minor_segs
            r = major + minor * math.cos(b)
            bm.verts.new((r * math.cos(a), r * math.sin(a), minor * math.sin(b)))
    bm.verts.ensure_lookup_table()
    for i in range(major_segs):
        for j in range(minor_segs):
            a = i * minor_segs + j
            b = ((i + 1) % major_segs) * minor_segs + j
            c = ((i + 1) % major_segs) * minor_segs + (j + 1) % minor_segs
            d = i * minor_segs + (j + 1) % minor_segs
            bm.faces.new((bm.verts[a], bm.verts[b], bm.verts[c], bm.verts[d]))
    obj = mesh_object(name, bm, coll, mat, smooth=True, parent=parent)
    return place(obj, loc, rot)


def lathe(name, profile, coll, segs=24, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, parent=None, close=True):
    """Revolve a (radius, z) profile around Z. Endpoints with radius 0 become poles."""
    bm = bmesh.new()
    rings = []
    for r, z in profile:
        if r <= 1e-6:
            rings.append([bm.verts.new((0, 0, z))])
            continue
        rings.append([bm.verts.new((r * math.cos(2 * math.pi * i / segs), r * math.sin(2 * math.pi * i / segs), z))
                      for i in range(segs)])
    for a, b in zip(rings, rings[1:]):
        if len(a) == 1 and len(b) == 1:
            continue
        for i in range(segs):
            j = (i + 1) % segs
            if len(a) == 1:
                bm.faces.new((a[0], b[i], b[j]))
            elif len(b) == 1:
                bm.faces.new((a[i], b[0], a[j]))
            else:
                bm.faces.new((a[i], b[i], b[j], a[j]))
    if close:
        for ring in (rings[0], rings[-1]):
            if len(ring) > 2:
                bm.faces.new(ring)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # Cylindrical UVs: u around (seam at angle 0), v from the first to the last profile point.
    uv = bm.loops.layers.uv.new("UVMap")
    zs = [z for _, z in profile]
    z0, z1 = min(zs), max(zs)
    for f in bm.faces:
        us = []
        for loop in f.loops:
            co = loop.vert.co
            us.append((math.atan2(co.y, co.x) / (2 * math.pi)) % 1.0)
        if max(us) - min(us) > 0.5:
            us = [u + 1.0 if u < 0.5 else u for u in us]
        for loop, u in zip(f.loops, us):
            loop[uv].uv = (u, (loop.vert.co.z - z0) / max(z1 - z0, 1e-6))
    obj = mesh_object(name, bm, coll, mat, smooth=True, parent=parent)
    return place(obj, loc, rot)


def uv_rect(obj, u0, v0, u1, v1):
    """Remap an object's 0..1 UVs into the rectangle (u0, v0)-(u1, v1)."""
    for d in obj.data.uv_layers.active.data:
        u, v = d.uv
        d.uv = (u0 + (u1 - u0) * u, v0 + (v1 - v0) * v)
    return obj


def atlas_cell(obj, index, cols, rows):
    """Map 0..1 UVs onto cell `index` of a cols x rows atlas (row 0 at the top)."""
    col, row = index % cols, index // cols
    return uv_rect(obj, col / cols, 1 - (row + 1) / rows, (col + 1) / cols, 1 - row / rows)


def join(objs, name=None):
    """Join mesh objects into the first one (modifiers are applied first)."""
    objs = [o for o in objs if o is not None]
    if not objs:
        return None
    for o in objs:
        apply_modifiers(o)
    target = objs[0]
    with bpy.context.temp_override(active_object=target, selected_editable_objects=objs, object=target):
        bpy.ops.object.join()
    if name:
        target.name = name
        target.data.name = name
    return target


def apply_modifiers(obj):
    if obj.type != "MESH" or not obj.modifiers:
        return obj
    deps = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(deps)
    me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=deps)
    old = obj.data
    obj.modifiers.clear()
    obj.data = me
    if old.users == 0:
        bpy.data.meshes.remove(old)
    return obj


def look_at_rotation(src, dst, up=Vector((0, 0, 1))):
    direction = Vector(dst) - Vector(src)
    return direction.to_track_quat("-Z", "Y").to_euler()


def yaw_to(src, dst):
    """Z rotation that turns a -Y facing object at `src` toward `dst`."""
    d = Vector(dst) - Vector(src)
    return math.atan2(d.x, -d.y)


def triangle_count(objs):
    deps = bpy.context.evaluated_depsgraph_get()
    total = 0
    for o in objs:
        if o.type != "MESH":
            continue
        ev = o.evaluated_get(deps)
        me = ev.to_mesh()
        total += sum(len(p.vertices) - 2 for p in me.polygons)
        ev.to_mesh_clear()
    return total


def transform_bm(bm, matrix):
    bmesh.ops.transform(bm, matrix=matrix, verts=bm.verts)


def mat_trs(loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    from mathutils import Euler
    return Matrix.LocRotScale(Vector(loc), Euler(rot).to_quaternion(), Vector(scale))


def apply_scale(obj, scale):
    """Scale the mesh data in the object's local axes (keeps object scale at 1)."""
    obj.data.transform(Matrix.Diagonal((*scale, 1.0)))
    return obj


def flatten(root, name):
    """Join every mesh under an empty hierarchy into one object at the root's place; delete the empties."""
    bpy.context.view_layer.update()
    kids = [o for o in root.children_recursive]
    meshes = [o for o in kids if o.type == "MESH"]
    for o in meshes:
        apply_modifiers(o)
    mats = {o: o.matrix_world.copy() for o in meshes}
    base = root.matrix_world.copy()
    for o in meshes:
        o.parent = None
        o.matrix_world = base.inverted() @ mats[o]
    for o in kids:
        if o.type != "MESH":
            bpy.data.objects.remove(o)
    bpy.data.objects.remove(root)
    obj = join(meshes, name)
    return obj
