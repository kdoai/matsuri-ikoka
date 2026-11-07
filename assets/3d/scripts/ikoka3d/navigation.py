"""Walkable floor meshes for the app.

`nav.customer` is where the player may walk (the customer side of the
fence, minus furniture); `nav.staff` is the staff side. Both are flat meshes
at floor height made from a 5 cm grid, so the app can test a position by
point-in-triangle or a downward raycast. Furniture footprints are found from
the meshes that stand on the floor, grown by the character's radius.
"""

import bmesh
import bpy
from mathutils import Matrix, Vector

from . import util as U

CELL = 0.05
RADIUS = 0.2


def _inside(poly, x, y):
    inside = False
    n = len(poly)
    for i in range(n):
        (ax, ay), (bx, by) = poly[i], poly[(i + 1) % n]
        if (ay > y) != (by > y) and x < ax + (y - ay) * (bx - ax) / (by - ay):
            inside = not inside
    return inside


def floor_blockers(objs, skip=(), floor=0.0, frame=None):
    """Footprints (xmin, ymin, xmax, ymax) of meshes standing on the floor at height `floor`.

    Measured along the world axes, or along `frame`'s axes (a world matrix, with `floor` in
    its coordinates) for things built at an angle.
    """
    deps = bpy.context.evaluated_depsgraph_get()
    to_frame = frame.inverted() if frame is not None else Matrix.Identity(4)
    out = []
    for o in objs:
        if o.type != "MESH" or o.name.startswith(skip):
            continue
        ev = o.evaluated_get(deps)
        pts = [to_frame @ ev.matrix_world @ Vector(c) for c in ev.bound_box]
        zmin, zmax = min(p.z for p in pts), max(p.z for p in pts)
        if zmin > floor + 0.3 or zmax < floor + 0.06:
            continue
        xs, ys = [p.x for p in pts], [p.y for p in pts]
        if (max(xs) - min(xs)) * (max(ys) - min(ys)) > 8.0:
            continue
        out.append((min(xs), min(ys), max(xs), max(ys)))
    return out


def _grown(boxes):
    return [(a - RADIUS, b - RADIUS, c + RADIUS, d + RADIUS) for a, b, c, d in boxes]


def _in_any(boxes, x, y):
    return any(a <= x <= c and b <= y <= d for a, b, c, d in boxes)


def build(name, coll, polygon, blockers, z=0.002, cell=CELL, framed=(), whole_cells=False):
    """The walkable mesh. `framed` holds (world matrix, footprints) pairs for things built at an angle.

    The grid drops whatever part of a cell doesn't fit, which can lose a whole row to floating point
    (8.2 / 0.2 < 41). `whole_cells` rounds to the nearest cell count instead.
    """
    xs = [p[0] for p in polygon]
    ys = [p[1] for p in polygon]
    x0, y0 = min(xs), min(ys)
    cells = round if whole_cells else int
    nx = cells((max(xs) - x0) / cell)
    ny = cells((max(ys) - y0) / cell)
    grown = _grown(blockers)
    turned = [(frame.inverted(), _grown(boxes)) for frame, boxes in framed]

    def free(x, y):
        if _in_any(grown, x, y):
            return False
        for to_frame, boxes in turned:
            p = to_frame @ Vector((x, y, 0.0))
            if _in_any(boxes, p.x, p.y):
                return False
        return True

    walk = [[False] * nx for _ in range(ny)]
    for j in range(ny):
        cy = y0 + (j + 0.5) * cell
        for i in range(nx):
            cx = x0 + (i + 0.5) * cell
            if _inside(polygon, cx, cy) and free(cx, cy):
                walk[j][i] = True
    bm = bmesh.new()
    verts = {}

    def v(i, j):
        if (i, j) not in verts:
            verts[(i, j)] = bm.verts.new((x0 + i * cell, y0 + j * cell, z))
        return verts[(i, j)]

    for j in range(ny):
        for i in range(nx):
            if walk[j][i]:
                bm.faces.new((v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1)))
    bmesh.ops.dissolve_limit(bm, angle_limit=0.01, verts=bm.verts, edges=bm.edges)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    obj = U.mesh_object(name, bm, coll)
    obj["ikoka_nav"] = True
    obj.hide_render = True          # data for the app, never drawn
    obj.display_type = "WIRE"
    return obj


def _polygon_at(me, x, y):
    for poly in me.polygons:
        if _inside([me.vertices[i].co.to_2d() for i in poly.vertices], x, y):
            return poly.index
    return None


def _connected(me, first):
    """Indices of the faces that can be walked to from face `first`, crossing shared edges."""
    by_edge = {}
    for poly in me.polygons:
        for key in poly.edge_keys:
            by_edge.setdefault(key, []).append(poly.index)
    seen, todo = {first}, [first]
    while todo:
        for key in me.polygons[todo.pop()].edge_keys:
            for other in by_edge[key]:
                if other not in seen:
                    seen.add(other)
                    todo.append(other)
    return seen


def keep_reachable(nav, start):
    """Remove the floor that a character walking from `start` (x, y) cannot get to."""
    me = nav.data
    first = _polygon_at(me, *start)
    if first is None:
        return
    keep = _connected(me, first)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index not in keep], context="FACES")
    bm.to_mesh(me)
    bm.free()


def pieces(nav):
    """How many separate pieces the floor is in."""
    me = nav.data
    left = {poly.index for poly in me.polygons}
    count = 0
    while left:
        left -= _connected(me, next(iter(left)))
        count += 1
    return count


def missing_spots(nav, start, spots):
    """Names in `spots` {name: (x, y)} that a character walking from `start` (x, y) cannot reach."""
    me = nav.data
    first = _polygon_at(me, *start)
    if first is None:
        return sorted(spots)
    seen = _connected(me, first)
    return sorted(name for name, (x, y) in spots.items() if _polygon_at(me, x, y) not in seen)
