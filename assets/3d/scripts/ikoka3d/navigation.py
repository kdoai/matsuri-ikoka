"""Walkable floor meshes for the app.

`nav.customer` is where the player may walk (the customer side of the
fence, minus furniture); `nav.staff` is the staff side. Both are flat meshes
at floor height made from a 5 cm grid, so the app can test a position by
point-in-triangle or a downward raycast. Furniture footprints are found from
the meshes that stand on the floor, grown by the character's radius.
"""

import bmesh
import bpy
from mathutils import Vector

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


def floor_blockers(objs, skip=()):
    """Footprints (xmin, ymin, xmax, ymax) of meshes standing on the floor."""
    deps = bpy.context.evaluated_depsgraph_get()
    out = []
    for o in objs:
        if o.type != "MESH" or o.name.startswith(skip):
            continue
        ev = o.evaluated_get(deps)
        pts = [ev.matrix_world @ Vector(c) for c in ev.bound_box]
        zmin, zmax = min(p.z for p in pts), max(p.z for p in pts)
        if zmin > 0.3 or zmax < 0.06:
            continue
        xs, ys = [p.x for p in pts], [p.y for p in pts]
        if (max(xs) - min(xs)) * (max(ys) - min(ys)) > 8.0:
            continue
        out.append((min(xs), min(ys), max(xs), max(ys)))
    return out


def build(name, coll, polygon, blockers, z=0.002):
    xs = [p[0] for p in polygon]
    ys = [p[1] for p in polygon]
    x0, y0 = min(xs), min(ys)
    nx = int((max(xs) - x0) / CELL)
    ny = int((max(ys) - y0) / CELL)
    grown = [(a - RADIUS, b - RADIUS, c + RADIUS, d + RADIUS) for a, b, c, d in blockers]
    walk = [[False] * nx for _ in range(ny)]
    for j in range(ny):
        cy = y0 + (j + 0.5) * CELL
        for i in range(nx):
            cx = x0 + (i + 0.5) * CELL
            if _inside(polygon, cx, cy) and not any(a <= cx <= c and b <= cy <= d for a, b, c, d in grown):
                walk[j][i] = True
    bm = bmesh.new()
    verts = {}

    def v(i, j):
        if (i, j) not in verts:
            verts[(i, j)] = bm.verts.new((x0 + i * CELL, y0 + j * CELL, z))
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
