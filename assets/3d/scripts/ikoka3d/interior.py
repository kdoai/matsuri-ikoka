"""The shop interior: structure, the four work stations, lanterns, anchors."""

import math
import random

from mathutils import Matrix

from . import gimmicks as G
from . import layout as L
from . import materials as M
from . import navigation
from . import palette as P
from . import props
from . import util as U

# Filled while building: (name, (x, y, z), yaw)
_SEATS = []
_INTERACT = []


def build(parent=None):
    """Build the interior. Returns (collection, lantern light points)."""
    root = U.collection("interior", parent)
    lights = []
    _SEATS.clear()
    _INTERACT.clear()
    _structure(U.collection("interior.structure", root))
    _entrance(U.collection("interior.entrance", root), lights)
    _counter(U.collection("interior.counter", root), lights)
    _archive(U.collection("interior.archive", root), lights)
    _map_station(U.collection("interior.map", root), lights)
    _timetable(U.collection("interior.timetable", root), lights)
    _right_wall(U.collection("interior.right_wall", root))
    _lounge(U.collection("interior.lounge", root), lights)
    _lanterns(U.collection("interior.lanterns", root), lights)
    _zones(U.collection("interior.zones", root))
    _front(U.collection("interior.front", root))
    _nook(U.collection("interior.nook", root), lights)
    _decor(U.collection("interior.decor", root))
    _anchors(U.collection("interior.anchors", root))
    _nav(root, U.collection("interior.nav", root))
    return root, lights


# Rotations that stand a local XY surface up against each wall (normal into the room).
FACE_MINUS_Y = Matrix.Rotation(math.pi / 2, 4, "X")
FACE_MINUS_X = Matrix.Rotation(-math.pi / 2, 4, "Z") @ FACE_MINUS_Y
FACE_PLUS_X = Matrix.Rotation(math.pi / 2, 4, "Z") @ FACE_MINUS_Y
FACE_PLUS_Y = Matrix.Rotation(math.pi, 4, "Z") @ FACE_MINUS_Y


def _wainscot(name, c, width, face, center, seed):
    """Vertical board paneling on the lower wall."""
    props.plank_surface(name, c, (width, L.WAINSCOT_H), plank_w=0.13, length=(9, 9), chamfer=0.006, seed=seed,
                        mat=M.planks("wainscot", P.mix(P.WOOD, P.WOOD_DARK, 0.35), grain_axis="Y"), along="Y",
                        matrix=Matrix.Translation(center) @ face, stagger=False)


def _dark():
    return M.wood("wood_dark", P.WOOD_DARK)


# --------------------------------------------------------------------------
# Structure: floor, walls, timber frame


def _structure(c):
    T, H = L.WALL_T, L.WALL_H
    frame = M.wood("wood_frame", P.WOOD_DARK)
    wall = M.plaster("plaster")
    cx, cy = (L.X0 + L.X1) / 2, (L.Y0 + L.Y1) / 2
    w, d = L.X1 - L.X0, L.Y1 - L.Y0

    props.plank_surface("floor", c, (w, d), plank_w=0.15, length=(0.8, 1.9), seed=3,
                        mat=M.planks("floor_planks", P.WOOD_FLOOR), matrix=Matrix.Translation((cx, cy, 0)))
    U.box("floor_slab", (w + 2 * T, d + T, L.FLOOR_Z - L.STREET_Z + 0.05), c,
          base=(cx, cy + T / 2, L.STREET_Z - 0.05 - 0.006), mat=frame)
    U.box("sill_front", (w + 2 * T + 0.04, 0.16, 0.13), c, base=(cx, L.Y0 - 0.02, -0.125), mat=frame, bev=0.012)

    U.box("wall_back", (w + 2 * T, T, H), c, base=(cx, L.Y1 + T / 2, 0), mat=wall)
    U.box("wall_right", (T, d, H), c, base=(L.X1 + T / 2, cy, 0), mat=wall)
    xl = L.X0 - T / 2
    wy0, wy1 = L.WINDOW_Y
    wz0, wz1 = L.WINDOW_Z
    for y0, y1, z0, z1 in [(L.Y0, wy0, 0, H), (wy1, L.Y1, 0, H), (wy0, wy1, 0, wz0), (wy0, wy1, wz1, H)]:
        U.box("wall_left", (T, y1 - y0, z1 - z0), c, base=(xl, (y0 + y1) / 2, z0), mat=wall)

    hw = L.WAINSCOT_H / 2
    _wainscot("wainscot_back", c, w, FACE_MINUS_Y, (cx, L.Y1 - 0.012, hw), 11)
    _wainscot("wainscot_right", c, d, FACE_MINUS_X, (L.X1 - 0.012, cy, hw), 12)
    _wainscot("wainscot_left", c, d, FACE_PLUS_X, (L.X0 + 0.012, cy, hw), 13)
    for name, size, base in [("rail_back", (w, 0.05, 0.05), (cx, L.Y1 - 0.03, L.WAINSCOT_H)),
                             ("rail_right", (0.05, d, 0.05), (L.X1 - 0.03, cy, L.WAINSCOT_H)),
                             ("rail_left", (0.05, d, 0.05), (L.X0 + 0.03, cy, L.WAINSCOT_H))]:
        U.box(name, size, c, base=base, mat=frame, bev=0.008)

    post = 0.2
    back_posts = [L.SHELF_X[1] + 0.2, L.MAP_X[1] + 0.2]
    posts = [(L.X0 - T / 2, L.Y1 + T / 2), (L.X1 + T / 2, L.Y1 + T / 2), (L.X1 + T / 2, L.Y0 + 0.08),
             (L.X0 - T / 2, wy0 - 0.05), (L.X0 - T / 2, wy1 + 0.05), (L.X1 + T / 2, 1.35), (L.X1 + T / 2, -1.15)]
    posts += [(x, L.Y1 + T / 2) for x in back_posts]
    for x, y in posts:
        U.box("post", (post, post, H + 0.14), c, base=(x, y, 0), mat=frame, bev=0.015)
    for name, size, base in [
        ("beam_back", (w + 2 * T + 0.24, post * 1.1, 0.22), (cx, L.Y1 + T / 2, H - 0.08)),
        ("beam_right", (post * 1.1, d + 0.24, 0.22), (L.X1 + T / 2, cy, H - 0.08)),
        ("beam_left", (post * 1.1, d + 0.24, 0.22), (L.X0 - T / 2, cy, H - 0.08)),
        ("nageshi_back", (w, 0.06, 0.1), (cx, L.Y1 - 0.03, 2.6)),
        ("nageshi_right", (0.06, d, 0.1), (L.X1 - 0.03, cy, 2.6)),
        ("nageshi_left", (0.06, d, 0.1), (L.X0 + 0.03, cy, 2.6)),
    ]:
        U.box(name, size, c, base=base, mat=frame, bev=0.01)

    # Ranma: slatted transoms above the nageshi on the back wall.
    for x0, x1 in [(L.X0 + 0.1, back_posts[0] - 0.12), (back_posts[0] + 0.12, back_posts[1] - 0.12)]:
        U.box("ranma.frame", (x1 - x0, 0.04, 0.03), c, base=((x0 + x1) / 2, L.Y1 - 0.03, 2.98), mat=frame)
        n = int((x1 - x0) / 0.09)
        for i in range(n + 1):
            U.box("ranma.slat", (0.022, 0.03, 0.28), c, base=(x0 + (x1 - x0) * i / n, L.Y1 - 0.025, 2.7), mat=frame)

    # Window: painted dusk town behind a lattice.
    props.textured_panel("window_view", c, (wy1 - wy0 + 0.1, wz1 - wz0 + 0.1), "window_view",
                         loc=(L.X0 - T - 0.04, (wy0 + wy1) / 2, (wz0 + wz1) / 2), facing="+X", emission=1.3)
    for z in (wz0 - 0.06, wz1):
        U.box("window_frame", (T + 0.08, wy1 - wy0 + 0.1, 0.06), c, base=(xl, (wy0 + wy1) / 2, z), mat=frame,
              bev=0.008)
    for i in range(1, 6):
        U.box("window_bar", (0.035, 0.025, wz1 - wz0), c, base=(xl, wy0 + (wy1 - wy0) * i / 6, wz0), mat=frame)
    for i in range(1, 3):
        U.box("window_bar", (0.035, wy1 - wy0, 0.025), c, base=(xl, (wy0 + wy1) / 2, wz0 + (wz1 - wz0) * i / 3),
              mat=frame)
    U.box("window_sill", (0.2, wy1 - wy0 + 0.16, 0.04), c, base=(L.X0 + 0.05, (wy0 + wy1) / 2, wz0 - 0.1), mat=frame,
          bev=0.008)


# --------------------------------------------------------------------------
# Entrance bay (front-left) and the street in front of the shop


def _entrance(c, lights):
    frame = M.wood("wood_frame", P.WOOD_DARK)
    wall = M.plaster("plaster")
    siding = M.planks("siding", P.mix(P.WOOD, P.WOOD_DARK, 0.45), grain_axis="Y")
    T = L.WALL_T
    x0, x1 = L.ENTRY_X
    dx0, dx1 = L.DOOR_X
    top = L.ENTRY_TOP
    yf = L.Y0 + T / 2

    stone = M.cobblestone("cobblestone")
    U.box("street", (L.X1 - L.X0 + 6.0, 3.0, 0.1), c, base=(0.0, L.Y0 - 1.5, L.STREET_Z - 0.1), mat=stone)
    U.box("street_side", (3.0, L.Y1 - L.Y0 + 0.4, 0.1), c, base=(L.X0 - T - 1.5, 0.2, L.STREET_Z - 0.1), mat=stone)
    U.box("gutter", (L.X1 - L.X0 + 6.0, 0.16, 0.03), c, base=(0.0, L.Y0 - 0.28, L.STREET_Z - 0.02),
          mat=M.flat("gutter_stone", "#7C716C", 0.9), bev=0.01)
    U.box("step_stone", (dx1 - dx0 + 0.2, 0.42, 0.11), c, base=((dx0 + dx1) / 2, L.Y0 - 0.21, L.STREET_Z),
          mat=M.flat("stone_step", "#8D8279", 0.9), bev=0.02)

    for a, b, z0, z1 in [(x0, dx0, 0, top), (dx1, x1, 0, top), (dx0, dx1, L.DOOR_H, top)]:
        U.box("entry_wall", (b - a, T, z1 - z0), c, base=((a + b) / 2, yf, z0), mat=wall)
        if z0 == 0:
            m = Matrix.Translation(((a + b) / 2, L.Y0 - 0.01, top / 2)) @ FACE_PLUS_Y
            props.plank_surface("entry_siding", c, (b - a, top), plank_w=0.12, length=(9, 9), seed=int(a * 10) + 40,
                                mat=siding, along="Y", matrix=m, stagger=False)
    for x in (x0 - T / 2, dx0, dx1, x1):
        U.box("entry_post", (0.18, 0.2, top + 0.12), c, base=(x, yf, L.STREET_Z), mat=frame, bev=0.015)
    U.box("entry_beam", (x1 - x0 + 0.5, 0.22, 0.2), c, base=((x0 + x1) / 2 - 0.1, yf, top), mat=frame, bev=0.012)
    U.box("door_lintel", (dx1 - dx0, 0.24, 0.12), c, base=((dx0 + dx1) / 2, yf, L.DOOR_H), mat=frame, bev=0.01)
    U.box("door_threshold", (dx1 - dx0, T + 0.04, 0.04), c, base=((dx0 + dx1) / 2, yf, -0.03), mat=frame)
    props.kawara_eave("entry_eave", c, x1 - x0 + 0.55, 0.62, loc=((x0 + x1) / 2 - 0.1, L.Y0 - 0.06, top + 0.3))

    nr = props.noren("gimmick.noren", c, dx1 - dx0 - 0.04, 0.85, loc=((dx0 + dx1) / 2, L.Y0 - 0.06, L.DOOR_H - 0.02))
    nr["ikoka_dynamic"] = True
    nr["ikoka_bake_group"] = "gimmick_noren"
    panels = sorted((o for o in nr.children if ".panel" in o.name), key=lambda o: o.name)
    for k, panel in enumerate(panels):
        G.clip(panel, "gimmick.noren.sway", 2.2,
               lambda t, k=k: {"rot": (-16 * G._decay(t, 0.05 * k, 1.1, 2.0), 0, 2 * G._decay(t, 0.1, 1.5, 3))})
    G.furin(c, ((dx0 + dx1) / 2 + 0.4, L.Y0 + 0.28, L.DOOR_H - 0.06))
    for x in (dx0 - 0.3, dx1 + 0.3):
        props.chochin("chochin_door", c, loc=(x, L.Y0 - 0.34, top + 0.08), radius=0.14, height=0.34)
        lights.append(((x, L.Y0 - 0.55, top - 0.15), 45, P.LANTERN))

    # Standing sign, planters and doormat.
    sign = props._root("signboard", c, (x1 + 0.4, L.Y0 - 0.55, L.STREET_Z), yaw=0.18)
    U.box("signboard.board", (0.46, 0.05, 1.26), c, base=(0, 0.01, 0.12), mat=frame, bev=0.01, parent=sign)
    props.textured_panel("signboard.face", c, (0.4, 1.12), "standing_sign", loc=(0, -0.018, 0.75), parent=sign)
    for sx in (-1, 1):
        U.box("signboard.leg", (0.05, 0.08, 1.4), c, base=(sx * 0.25, 0.02, 0), mat=frame, bev=0.006, parent=sign)
    mat_obj = props.textured_panel("doormat", c, (dx1 - dx0 - 0.3, 0.55), "doormat",
                                   loc=((dx0 + dx1) / 2, L.Y0 + 0.5, 0.008), facing="+Z")
    mat_obj.rotation_euler = (0, 0, math.pi)
    props.hydrangea("hydrangea_l", c, loc=(dx0 - 0.45, L.Y0 - 0.5, L.STREET_Z), size=1.2, seed=3)
    props.hydrangea("hydrangea_r", c, loc=(x1 + 1.05, L.Y0 - 0.48, L.STREET_Z), size=1.0, seed=4,
                    colors=("#E9A6C4", "#C9A6E4", "#F3C6D8"))
    props.leafy_plant("plant_street", c, loc=(L.X0 - 0.45, L.Y0 - 0.5, L.STREET_Z), size=1.5, seed=5)

    # The cat sleeps outside the noren on its own cushion, beside the door, so it never hangs off a seat
    # and does not block the way in. The player pets it from just inside the door, by the left jamb.
    kx, ky, kyaw = L.CAT
    U.box("cat_cushion", (L.CAT_CUSHION, L.CAT_CUSHION, 0.07), c, base=(kx, ky, L.STREET_Z), rot=(0, 0, kyaw),
          mat=M.fabric("cushion_cat", "#B0473C", 0.6), bev=0.03, seg=3)
    G.cat(c, (kx - 0.05, ky + 0.02, L.STREET_Z + 0.07), yaw=kyaw)
    _INTERACT.append(("cat", (L.DOOR_X[0] + 0.25, L.Y0 + 0.25, 0), 0.0))


# --------------------------------------------------------------------------
# Concierge counter


def _counter(c, lights):
    cx, cy = L.COUNTER_C
    w, d, h = L.COUNTER_S
    dark = _dark()
    root = props._root("counter", c, (cx, cy, 0))
    U.box("counter.body", (w - 0.1, d - 0.12, h - 0.05), c, base=(0, 0.02, 0.06), mat=M.wood("wood_counter", P.WOOD),
          bev=0.01, parent=root)
    U.box("counter.plinth", (w - 0.16, d - 0.2, 0.08), c, base=(0, 0.04, 0), mat=dark, parent=root)
    U.box("counter.top", (w + 0.08, d + 0.06, 0.06), c, base=(0, 0, h - 0.04),
          mat=M.wood("wood_counter_top", P.WOOD_LIGHT), bev=0.015, parent=root)
    for sx in (-1, 1):
        U.box("counter.pillar", (0.1, d - 0.06, h - 0.06), c, base=(sx * (w / 2 - 0.07), 0, 0.02), mat=dark,
              bev=0.01, parent=root)
    U.box("counter.sign_board", (1.42, 0.03, 0.44), c, base=(0, -d / 2 + 0.035, 0.12), mat=dark, bev=0.008,
          parent=root)
    props.textured_panel("counter.sign", c, (1.34, 0.377), "counter_sign", loc=(0, -d / 2 + 0.018, 0.34), parent=root)

    top = h + 0.02
    G.bell(c, (cx - 0.9, cy - 0.14, top))
    _INTERACT.append(("bell", (cx - 0.9, L.PLAYER_COUNTER[1], 0), math.pi))
    props.leafy_plant("counter_flowers", c, loc=(cx + 0.78, cy + 0.2, top), size=0.45, seed=19, pot="#EFE6D2",
                      flowers="#F2A6C0", leaves=10)
    props.brochure_stand("counter_brochures", c, loc=(cx - 0.42, cy - 0.06, top), yaw=0.12, cols=2, rows=2, w=0.14,
                         h=0.19, seed=2)
    props.open_book("guidebook", c, loc=(cx + 0.1, cy - 0.1, top), yaw=0.08, w=0.32, d=0.22)
    U.box("ink_pad", (0.1, 0.07, 0.025), c, base=(cx + 0.52, cy - 0.12, top), mat=M.flat("ink_pad", "#B8453A", 0.6),
          bev=0.004)
    U.cylinder("pen_cup", 0.035, 0.1, c, base=(cx + 0.68, cy + 0.12, top), mat=M.flat("glaze_indigo", "#3A4F8F", 0.35),
               verts=14)
    for i, col in enumerate(("#B8453A", "#2A3F8E", "#D9A441")):
        U.cylinder("pen", 0.006, 0.16, c, base=(cx + 0.68 + (i - 1) * 0.012, cy + 0.12, top + 0.02),
                   rot=((i - 1) * 0.15, 0.1, 0), mat=M.flat(f"pen_{col}", col, 0.5), verts=6)
    props.andon("counter_andon", c, loc=(cx + 1.02, cy - 0.04, top))
    lights.append(((cx + 1.02, cy - 0.04, top + 0.2), 18, P.LANTERN))
    U.lathe("vase", [(0.0, 0.0), (0.045, 0.0), (0.06, 0.06), (0.035, 0.15), (0.03, 0.18), (0.0, 0.18)], c,
            segs=16, loc=(cx - 1.12, cy + 0.12, top), mat=M.flat("glaze_cream", "#EFE6D2", 0.35))
    props.leafy_plant("vase_flowers", c, loc=(cx - 1.12, cy + 0.12, top + 0.05), size=0.7, pot=None, leaves=8,
                      flowers="#FFF6EA", seed=8, pot_h=0.15, tall=0.3)
    props.leafy_plant("plant_counter", c, loc=(-3.68, -1.2, 0), size=1.5, seed=9, leaves=18)
    # Raised step the concierge stands on behind the counter.
    U.box("counter.step", (w - 0.3, 0.62, L.COUNTER_STEP), c, base=(cx, cy + d / 2 + 0.3, 0),
          mat=M.wood("wood_counter_top", P.WOOD_LIGHT), bev=0.01)


# --------------------------------------------------------------------------
# Researcher: archive shelves, reading desk, globe


def _archive(c, lights):
    x0, x1 = L.SHELF_X
    n = 2
    w = (x1 - x0) / n
    layouts = [["books", "books", "scrolls", "books", "boxes"], ["boxes", "books", "books", "scrolls", "books"]]
    box_mat = M.flat("archive_box", "#D8C29A", 0.8)
    label = M.flat("archive_label", "#F7F1E3", 0.8)
    for i in range(n):
        x = x0 + w * (i + 0.5)
        _, tops, gap = props.shelf_unit(f"shelf_{i}", c, size=(w - 0.04, 0.4, 2.25), shelves=5,
                                        loc=(x, L.Y1 - 0.21, 0))
        inner0, inner1 = x - w / 2 + 0.08, x + w / 2 - 0.08
        for k, z in enumerate(tops):
            kind = layouts[i][k]
            if kind == "books" and i == 0 and k == 1:
                xs = inner0 + 0.45
                props.book_row(f"shelf_{i}.books{k}", c, inner0, xs - 0.04, z + 0.002, L.Y1 - 0.03, depth=0.27,
                               max_h=gap * 0.82, seed=i * 10 + k)
                props.book_row(f"shelf_{i}.books{k}b", c, xs + 0.035, inner1, z + 0.002, L.Y1 - 0.03, depth=0.27,
                               max_h=gap * 0.82, seed=i * 10 + k + 50)
                secret = (xs, L.Y1 - 0.30, z + 0.002, gap * 0.8)
            elif kind == "books":
                props.book_row(f"shelf_{i}.books{k}", c, inner0, inner1, z + 0.002, L.Y1 - 0.03, depth=0.27,
                               max_h=gap * 0.82, seed=i * 10 + k)
            elif kind == "scrolls":
                props.scroll_pile(f"shelf_{i}.scrolls{k}", c, loc=(x - 0.18, L.Y1 - 0.2, z), n=6, seed=k, length=0.42)
                props.book_row(f"shelf_{i}.books{k}", c, x + 0.12, inner1, z + 0.002, L.Y1 - 0.03, depth=0.27,
                               max_h=gap * 0.8, seed=i * 10 + k + 5, stack_chance=0)
            else:
                for j in range(3):
                    bx = inner0 + 0.17 + j * 0.31
                    U.box("archive_box", (0.28, 0.3, gap * 0.55), c, base=(bx, L.Y1 - 0.2, z), mat=box_mat, bev=0.006)
                    U.box("archive_label", (0.12, 0.005, 0.06), c, base=(bx, L.Y1 - 0.352, z + gap * 0.22), mat=label)
        top = 2.25
        if i == 1:
            G.secret_book(c, secret[:3], (x, L.Y1 - 0.413, 0.012), book_h=secret[3])
        if i == 0:
            props.leafy_plant("shelf_plant", c, loc=(x - 0.3, L.Y1 - 0.2, top), size=0.9, seed=31, leaves=12)
            props.scroll_pile("shelf_top_scrolls", c, loc=(x + 0.22, L.Y1 - 0.2, top), n=3, seed=4, length=0.4)
        else:
            for j in range(2):
                U.box("top_box", (0.34, 0.3, 0.2), c, base=(x + 0.2 - j * 0.04, L.Y1 - 0.2, top + j * 0.2),
                      rot=(0, 0, j * 0.08), mat=M.wood("wood_crate", P.WOOD_LIGHT), bev=0.008)

    # Basket of rolled maps by the shelves and a step stool.
    U.cylinder("map_basket", 0.17, 0.32, c, base=(-1.25, 2.55, 0), radius2=0.2, mat=M.wood("wood_crate", P.WOOD_LIGHT),
               verts=18, bev=0.008)
    for k, (dx, dy, tilt) in enumerate([(-0.06, 0.03, 0.12), (0.05, -0.05, -0.15), (0.0, 0.07, 0.05),
                                        (0.08, 0.06, 0.2), (-0.07, -0.06, -0.08)]):
        props.scroll("map_roll", c, length=0.6, radius=0.03, loc=(-1.25 + dx, 2.55 + dy, 0.45),
                     rot=(tilt, math.pi / 2 - 0.1 + tilt * 0.5, k), paper=["#EFE0BD", "#E6D2A8", "#F4E8CF"][k % 3])
    props.stool("step_stool", c, loc=(-1.85, 2.3, 0), h=0.32)

    # Reading desk under the window.
    desk_y = (L.WINDOW_Y[0] + L.WINDOW_Y[1]) / 2
    dx = L.X0 + 0.32
    props.table("reading_desk", c, size=(1.3, 0.52, 0.56), loc=(dx, desk_y, 0), yaw=math.pi / 2)
    G.globe(c, (dx, desk_y + 0.42, 0.56))
    props.open_book("reading_book", c, loc=(dx + 0.02, desk_y - 0.02, 0.56), yaw=math.pi / 2 - 0.15)
    props.andon("archive_andon", c, loc=(dx - 0.05, desk_y - 0.45, 0.56), w=0.15, h=0.24)
    lights.append(((dx, desk_y - 0.45, 0.75), 10, P.LANTERN))
    books = props.book_row("desk_books", c, -0.12, 0.14, 0.0, 0.12, depth=0.2, max_h=0.24, seed=77, stack_chance=0)
    books.location = (dx + 0.02, desk_y + 0.1, 0.56)
    books.rotation_euler = (0, 0, math.pi / 2)
    props.chair("reading_chair", c, loc=(dx + 0.55, desk_y + 0.05, 0), yaw=-math.pi / 2 + 0.2)
    _SEATS.append(("staff.reading_chair", (dx + 0.55, desk_y + 0.05, 0.36), -math.pi / 2 + 0.2))
    _SEATS.append(("staff.step_stool", (-1.85, 2.3, 0.32), math.pi))

    # Left wall: tapestry and a framed print.
    props.textured_panel("tapestry", c, (0.46, 1.38), "tapestry", loc=(L.X0 + 0.03, 2.42, 1.65), facing="+X",
                         rough=0.95)
    U.cylinder("tapestry.rod", 0.015, 0.6, c, loc=(L.X0 + 0.05, 2.42, 2.36), rot=(math.pi / 2, 0, 0), mat=_dark(),
               verts=8)
    props.picture("print_left", c, (0.5, 0.66), "poster_mountain", loc=(L.X0 + 0.02, -1.2, 1.65), facing="+X")


# --------------------------------------------------------------------------
# Area guide: map wall and gourmet desk


def _map_station(c, lights):
    x0, x1 = L.MAP_X
    z0, z1 = L.MAP_Z
    cx = (x0 + x1) / 2
    U.box("map.frame", (x1 - x0 + 0.12, 0.04, z1 - z0 + 0.12), c, base=(cx, L.Y1 - 0.02, z0 - 0.06), mat=_dark(),
          bev=0.008)
    props.textured_panel("map.paper", c, (x1 - x0, z1 - z0), "map", loc=(cx, L.Y1 - 0.045, (z0 + z1) / 2))

    dy = L.Y1 - 0.6
    props.table("map_desk", c, size=(1.9, 0.72, 0.56), loc=(cx, dy, 0))
    spread = props.textured_panel("map_desk.spread", c, (0.62, 0.44), "picture", loc=(cx - 0.15, dy - 0.05, 0.565),
                                  facing="+Z")
    spread.rotation_euler = (0, 0, 0.06)
    props.paper_stack("map_desk.notes", c, loc=(cx + 0.35, dy + 0.05, 0.56), yaw=-0.2, w=0.18, d=0.25, n=4, seed=3)
    U.cylinder("map_desk.pens", 0.035, 0.1, c, base=(cx + 0.62, dy + 0.2, 0.56),
               mat=M.flat("glaze_cream", "#EFE6D2", 0.35), verts=14)
    props.leafy_plant("map_desk.plant", c, loc=(cx - 0.75, dy + 0.18, 0.56), size=0.55, seed=12, pot="#3A4F8F")
    props.andon("map_andon", c, loc=(cx + 0.72, dy + 0.12, 0.56), w=0.15, h=0.24)
    lights.append(((cx + 0.72, dy + 0.12, 0.75), 10, P.LANTERN))
    props.chair("map_chair", c, loc=(cx - 0.8, dy - 0.75, 0), yaw=math.pi + 0.6)
    _SEATS.append(("staff.map_chair", (cx - 0.8, dy - 0.75, 0.42), math.pi + 0.6))
    props.cushion("map_chair.cushion", c, loc=(cx - 0.8, dy - 0.75, 0.38), size=(0.36, 0.34, 0.06), color="#B8453A")
    props.textured_panel("rug", c, (2.5, 1.75), "rug", loc=(cx, dy - 0.75, 0.006), facing="+Z", rough=0.95)
    props.brochure_stand("map_rack", c, loc=(x1 + 0.05, dy - 0.75, 0), yaw=-math.pi / 2 + 0.3, cols=2, rows=2, w=0.16,
                         h=0.22, seed=7)


# --------------------------------------------------------------------------
# Itinerary: timetable board, clock and binder desk


def _timetable(c, lights):
    x0, x1 = L.TIMETABLE_X
    z0, z1 = L.TIMETABLE_Z
    cx = (x0 + x1) / 2
    U.box("timetable.frame", (x1 - x0 + 0.12, 0.05, z1 - z0 + 0.12), c, base=(cx, L.Y1 - 0.025, z0 - 0.06),
          mat=_dark(), bev=0.008)
    props.textured_panel("timetable.board", c, (x1 - x0, z1 - z0), "timetable", loc=(cx, L.Y1 - 0.055, (z0 + z1) / 2))
    props.textured_panel("clock.face", c, (0.34, 0.34), "clock", loc=(cx, L.Y1 - 0.06, 2.85), alpha=True)
    G.clock_hands(c, (cx, L.Y1 - 0.065, 2.85))
    G.hidden_chick(c, "1", (x1 - 0.12, L.Y1 - 0.03, z1 + 0.06), yaw=0.3)

    dy = L.Y1 - 0.4
    props.table("binder_desk", c, size=(1.3, 0.5, 0.62), loc=(cx, dy, 0))
    for i in range(6):
        col = ["#2A3F8E", "#B8453A", "#3E7A5C", "#D9A441"][i % 4]
        U.box("binder", (0.055, 0.26, 0.3), c, base=(cx - 0.56 + i * 0.062, dy + 0.06, 0.62),
              rot=(0, -0.08 if i == 5 else 0, 0), mat=M.flat(f"binder_{col}", col, 0.55), bev=0.004)
        U.box("binder.label", (0.035, 0.004, 0.1), c, base=(cx - 0.56 + i * 0.062, dy - 0.072, 0.72),
              mat=M.flat("archive_label", "#F7F1E3", 0.8))
    props.paper_stack("binder_desk.tickets", c, loc=(cx + 0.05, dy - 0.05, 0.62), yaw=0.15, w=0.16, d=0.1, n=6,
                      seed=5, color="#F6D56A")
    U.box("ticket_box", (0.24, 0.16, 0.12), c, base=(cx + 0.36, dy + 0.06, 0.62),
          mat=M.wood("wood_crate", P.WOOD_LIGHT), bev=0.006)
    props.andon("timetable_andon", c, loc=(cx + 0.55, dy - 0.05, 0.62), w=0.13, h=0.2)
    lights.append(((cx + 0.55, dy - 0.05, 0.8), 8, P.LANTERN))
    props.scroll_pile("timetable_rolls", c, loc=(cx - 0.2, dy, 0.0), n=6, seed=9, length=0.5)
    props.suitcase("trunk_big", c, size=(0.62, 0.36, 0.26), loc=(L.X1 - 0.4, 1.9, 0), rot=(0, 0, math.pi / 2 + 0.1))
    props.suitcase("trunk_small", c, size=(0.46, 0.28, 0.2), loc=(L.X1 - 0.42, 1.88, 0.27),
                   rot=(0, 0, math.pi / 2 - 0.15), color="#3E6A7A")


# --------------------------------------------------------------------------
# Right wall: quest board and posters


def _right_wall(c):
    y0, y1 = L.QUEST_Y
    z0, z1 = L.QUEST_Z
    cy = (y0 + y1) / 2
    U.box("quest.frame", (0.05, y1 - y0 + 0.14, z1 - z0 + 0.14), c, base=(L.X1 - 0.025, cy, z0 - 0.07), mat=_dark(),
          bev=0.01)
    U.box("quest.cork", (0.02, y1 - y0, z1 - z0), c, base=(L.X1 - 0.06, cy, z0),
          mat=M.cobblestone("cork_board", P.CORK, 30.0))
    props.textured_panel("quest.header", c, (0.9, 0.225), "quest_header", loc=(L.X1 - 0.03, cy, z1 + 0.2),
                         facing="-X")
    rng = random.Random(51)
    for k in range(6):
        row, col = divmod(k, 3)
        y = y0 + 0.3 + col * 0.6
        z = z0 + 0.3 + (1 - row) * 0.52
        p = props.textured_panel(f"quest.card{k}", c, (0.34, 0.425), "quest_cards", loc=(L.X1 - 0.074, y, z),
                                 facing="-X", cell=(k + (1 if k > 2 else 0), 4, 2))
        p.rotation_euler.y += rng.uniform(-0.08, 0.08)
    props.picture("poster_fireworks", c, (0.5, 0.7), "poster_fireworks", loc=(L.X1 - 0.02, -1.75, 1.62), facing="-X",
                  frame_w=0.02)
    props.picture("poster_lanterns", c, (0.5, 0.7), "poster_lanterns", loc=(L.X1 - 0.02, -2.5, 1.62), facing="-X",
                  frame_w=0.02)
    props.picture("poster_snow", c, (0.46, 0.64), "poster_snow", loc=(L.X1 - 0.02, 2.2, 1.65), facing="-X",
                  frame_w=0.02)


# --------------------------------------------------------------------------
# Lounge (front right): sofa, low table, brochure rack


def _lounge(c, lights):
    sofa = M.fabric("sofa", "#2F3E7A", 0.5)
    frame = M.wood("wood_furniture", P.WOOD)
    root = props._root("sofa", c, (L.X1 - 0.42, -2.05, 0), yaw=-math.pi / 2)
    U.box("sofa.base", (1.4, 0.66, 0.2), c, base=(0, 0, 0.06), mat=frame, bev=0.01, parent=root)
    for sx in (-1, 1):
        for sy in (-1, 1):
            U.box("sofa.foot", (0.06, 0.06, 0.07), c, base=(sx * 0.62, sy * 0.26, 0), mat=_dark(), parent=root)
    for sx in (-0.33, 0.33):
        U.box("sofa.seat", (0.64, 0.58, 0.14), c, base=(sx, -0.02, 0.24), mat=sofa, bev=0.05, seg=3, parent=root)
    U.box("sofa.back", (1.4, 0.18, 0.42), c, base=(0, 0.25, 0.26), mat=sofa, bev=0.06, seg=3, parent=root)
    for sx in (-1, 1):
        U.box("sofa.arm", (0.14, 0.66, 0.34), c, base=(sx * 0.67, 0, 0.2), mat=sofa, bev=0.05, seg=3, parent=root)
    props.cushion("sofa.pillow1", c, loc=(L.X1 - 0.55, -2.45, 0.52), rot=(0.2, 0.3, 0), size=(0.28, 0.1, 0.26),
                  color="#D9A441")
    props.cushion("sofa.pillow2", c, loc=(L.X1 - 0.55, -1.62, 0.52), rot=(-0.2, -0.3, 0), size=(0.28, 0.1, 0.26),
                  color="#C8573A")
    props.table("low_table", c, size=(0.75, 0.48, 0.32), loc=(L.X1 - 1.32, -2.05, 0), yaw=math.pi / 2)
    props.tea_set("tea_set", c, loc=(L.X1 - 1.32, -2.1, 0.32))
    leaflet = props.textured_panel("low_table.brochure", c, (0.16, 0.22), "brochures", loc=(L.X1 - 1.38, -1.8, 0.325),
                                   facing="+Z", cell=(5, 4, 2))
    leaflet.rotation_euler.z = 0.3

    rack_x, rack_y = 2.32, -2.66
    props.table("rack_table", c, size=(0.95, 0.4, 0.42), loc=(rack_x, rack_y, 0))
    props.brochure_stand("rack", c, loc=(rack_x, rack_y - 0.08, 0.42), cols=4, rows=2, w=0.17, h=0.23, seed=11)
    props.floor_andon("lounge_andon", c, loc=(L.X1 - 0.3, -1.15, 0))
    lights.append(((L.X1 - 0.3, -1.15, 0.65), 18, P.LANTERN))
    props.leafy_plant("plant_lounge", c, loc=(L.X1 - 0.35, -2.8, 0), size=1.7, seed=13, leaves=18)
    for k, y in enumerate((-2.38, -1.72)):
        _SEATS.append((f"customer.sofa.{k + 1}", (L.X1 - 0.38, y, 0.38), -math.pi / 2))


# --------------------------------------------------------------------------
# Lanterns: wall brackets and a festival garland along the back wall


def _lanterns(c, lights):
    for x, y, yaw in [(L.SHELF_X[1] + 0.2, L.Y1 - 0.1, 0.0), (L.MAP_X[1] + 0.2, L.Y1 - 0.1, 0.0),
                      (L.X1 - 0.1, 1.35, -math.pi / 2), (L.X1 - 0.1, -1.15, -math.pi / 2),
                      (L.X0 + 0.1, L.WINDOW_Y[1] + 0.05, math.pi / 2)]:
        props.wall_lantern("wall_lantern", c, loc=(x, y, 2.05), yaw=yaw)
        lx, ly = x + math.sin(yaw) * 0.3, y - math.cos(yaw) * 0.3
        lights.append(((lx, ly, 2.0), 40, P.LANTERN))
    gx0, gx1 = L.X0 + 0.25, L.X1 - 0.25
    n = 13
    pts = []
    for i in range(n + 1):
        t = i / n
        z = 3.0 - 0.16 * math.sin(math.pi * ((t * 3) % 1.0))
        pts.append((gx0 + (gx1 - gx0) * t, L.Y1 - 0.2, z))
    for a, b in zip(pts[:-1], pts[1:]):
        mid = [(a[k] + b[k]) / 2 for k in range(3)]
        dx, dz = b[0] - a[0], b[2] - a[2]
        U.cylinder("garland.cord", 0.005, math.hypot(dx, dz), c, loc=mid,
                   rot=(0, math.pi / 2 - math.atan2(dz, dx), 0), mat=M.flat("cord", "#3A2A20", 0.8), verts=5)
    for i in range(1, n):
        x, y, z = pts[i]
        props.chochin(f"garland.l{i}", c, loc=(x, y, z), radius=0.075, height=0.17,
                      tex="lantern_matsuri" if i % 2 else "lantern", strength=4.0, ribs=False)


# --------------------------------------------------------------------------
# Customer / staff zones: low lattice fence, staff gate, the front of the shop


def _zones(c):
    cx = L.COUNTER_C[0]
    left_end = cx - L.COUNTER_S[0] / 2
    right_end = cx + L.COUNTER_S[0] / 2
    g0, g1 = L.GATE_X
    props.low_fence("fence.left", c, (L.X0, L.FENCE_Y), (g0, L.FENCE_Y))
    props.low_fence("fence.left2", c, (g1, L.FENCE_Y), (left_end, L.FENCE_Y))
    props.low_fence("fence.right", c, (right_end, L.FENCE_Y), (L.NOOK_X, L.FENCE_Y))
    props.low_fence("fence.nook_side", c, (L.NOOK_X, L.FENCE_Y), (L.NOOK_X, L.NOOK_Y))
    props.low_fence("fence.nook_back", c, (L.NOOK_X, L.NOOK_Y), (L.X1, L.NOOK_Y))
    G.staff_gate(c, (g1, L.FENCE_Y, 0), g1 - g0)
    # Staff-only plaques on the fences facing the customer side.
    for name, loc, facing in (("sign.staff_only.nook", (L.NOOK_X - 0.04, 0.3, 0.55), "-X"),
                              ("sign.staff_only.right", ((right_end + L.NOOK_X) / 2, L.FENCE_Y - 0.04, 0.55), "-Y")):
        props.textured_panel(name, c, (0.36, 0.135), "staff_only", loc=loc, facing=facing)


def _front(c):
    """Customer side in front of the counter: bench, stamp table, omikuji."""
    bx, by = L.BENCH
    props.bench("bench", c, loc=(bx, by, 0), yaw=math.pi)
    for k, x in enumerate((bx + 0.35, bx - 0.1)):
        _SEATS.append((f"customer.bench.{k + 1}", (x, by, 0.42), math.pi))
    sx, sy = L.STAMP_TABLE
    G.stamp_table(c, (sx, sy, 0))
    _INTERACT.append(("stamp", (sx, sy + 0.5, 0), math.pi))
    ox, oy = L.OMIKUJI
    G.omikuji(c, (ox, oy, 0))
    _INTERACT.append(("omikuji", (ox, oy - 0.5, 0), math.pi))
    props.leafy_plant("plant_front", c, loc=(-0.5, -2.75, 0), size=1.2, seed=23, flowers="#F6D56A")


def _nook(c, lights):
    """Customer nook by the quest board: souvenir shelf, plushies, daruma, gachapon."""
    sx, sy = L.SOUVENIR
    root, tops, gap = props.shelf_unit("souvenir", c, size=(1.5, 0.34, 0.95), shelves=3, loc=(sx, sy, 0),
                                       yaw=-math.pi / 2, mat=M.wood("wood_furniture", P.WOOD))
    # Items in the shelf's own frame: x along the shelf, -y toward the room.
    for k, x in enumerate((-0.5, -0.25, 0.0, 0.25, 0.5)):
        props.omiyage(f"souvenir.box{k}", c, (x, 0.0, tops[0] + 0.002), cell=k, yaw=0.05 * (k - 2), parent=root)
        if k % 2 == 0:
            props.omiyage(f"souvenir.box{k}b", c, (x, 0.0, tops[0] + 0.074), cell=k + 1, yaw=-0.1, parent=root)
    for k, kind in enumerate(("hiyoko", "owl", "hen", "sparrow", "penguin")):
        props.mini_plush(f"souvenir.plush_{kind}", c, kind, (-0.52 + k * 0.26, -0.02, tops[1] + 0.002),
                         yaw=0.15 * (k - 2), parent=root)
    for k, x in enumerate((-0.45, 0.45)):
        props.mini_plush(f"souvenir.plush_top{k}", c, ("hiyoko", "penguin")[k], (x, 0.02, 0.952), s=1.4,
                         yaw=0.3 * (1 - 2 * k), parent=root)
    dar = G.daruma(c, (0, 0, 0))
    dar.parent = root
    dar.location = (0.0, 0.0, 0.952)
    chick = G.hidden_chick(c, "3", (0, 0, 0))
    chick.parent = root
    chick.location = (0.62, -0.05, tops[2] + 0.002)
    gx, gy = L.GACHA
    G.gachapon(c, (gx, gy, 0), yaw=-math.pi / 2)
    _INTERACT.append(("souvenir", (sx - 0.62, sy, 0), math.pi / 2))
    _INTERACT.append(("quest_board", (sx - 0.75, sy - 0.3, 0), math.pi / 2))
    _INTERACT.append(("gacha", (gx - 0.62, gy, 0), math.pi / 2))
    props.leafy_plant("plant_nook", c, loc=(L.NOOK_X + 0.32, L.NOOK_Y - 0.32, 0), size=1.5, seed=27, leaves=18,
                      pot="#3A4F8F")
    # A hanging basket in the front-right corner with trailing vines.
    hx, hy = L.X1 - 0.3, L.Y0 + 0.35
    U.cylinder("hanging.chain", 0.006, 0.45, c, base=(hx, hy, 2.2), mat=M.flat("cord", "#3A2A20", 0.8), verts=5)
    U.box("hanging.bracket", (0.32, 0.04, 0.04), c, base=(hx + 0.14, hy, 2.62), mat=_dark())
    U.lathe("hanging.basket", [(0.0, 0.0), (0.1, 0.0), (0.16, 0.08), (0.17, 0.14), (0.0, 0.14)], c, segs=16,
            loc=(hx, hy, 2.06), mat=M.wood("wood_crate", P.WOOD_LIGHT))
    props.leafy_plant("hanging.plant", c, loc=(hx, hy, 2.06), size=0.9, pot=None, pot_h=0.14, tall=0.15, seed=33,
                      leaves=14)
    for k in range(3):
        props.trailing_vine("hanging.vine", c, (hx + 0.1 * math.cos(k * 2.1), hy + 0.1 * math.sin(k * 2.1), 2.12),
                            length=0.7 + 0.2 * k, seed=40 + k)
    _ = lights


def _decor(c):
    """Photos around the map, pennant bunting, vines, more plants, hidden chicks."""
    for k, (x, z, rot) in enumerate([(L.MAP_X[0] + 0.12, 2.3, 0.12), (L.MAP_X[1] - 0.12, 2.32, -0.1),
                                     (L.MAP_X[1] - 0.2, 1.2, 0.08), (L.MAP_X[0] + 0.18, 1.18, -0.14)]):
        p = props.textured_panel(f"photo{k}", c, (0.2, 0.2), "polaroids", loc=(x, L.Y1 - 0.075, z), cell=(k, 2, 2))
        p.rotation_euler.y += rot
        U.sphere(f"photo{k}.pin", 0.012, c, loc=(x, L.Y1 - 0.085, z + 0.085), mat=M.flat("pin_red", "#C8473C", 0.4),
                 segs=8, rings=5)
    props.bunting("bunting.right", c, (L.X1 - 0.06, L.Y0 + 0.1, 2.82), (L.X1 - 0.06, L.Y1 - 0.1, 2.82), n=22)
    props.bunting("bunting.left", c, (L.X0 + 0.06, L.WINDOW_Y[0] - 0.4, 2.82), (L.X0 + 0.06, L.Y1 - 0.1, 2.82), n=12)
    props.trailing_vine("shelf_vine", c, (L.SHELF_X[0] + 0.12, L.Y1 - 0.38, 2.27), length=1.1, seed=51)
    props.trailing_vine("shelf_vine2", c, (L.SHELF_X[0] + 0.3, L.Y1 - 0.4, 2.27), length=0.7, seed=52)
    props.leafy_plant("plant_archive", c, loc=(L.X0 + 0.35, -0.5, 0), size=1.6, seed=55, leaves=18, pot="#7E6A5A")
    props.leafy_plant("plant_timetable", c, loc=(L.TIMETABLE_X[0] - 0.05, L.Y1 - 0.35, 0), size=1.1, seed=56,
                      flowers="#F2A6C0")
    for k, (x, y) in enumerate([(-1.55, 2.0), (-1.45, 1.75)]):
        props.book_row(f"floor_books{k}", c, -0.12, 0.12, 0.0, 0.12, depth=0.2, max_h=0.26, seed=90 + k,
                       stack_chance=1.0).location = (x, y, 0)
    G.hidden_chick(c, "2", (L.X0 + 0.07, L.WINDOW_Y[1] - 0.25, L.WINDOW_Z[0] - 0.06), yaw=math.pi / 2)


# --------------------------------------------------------------------------
# Anchors the app uses to place and move staff


def _anchors(c):
    for role, s in L.STAFF.items():
        for kind in ("post", "home"):
            x, y, yaw = s[kind]
            U.empty(f"anchor.{role}.{kind}", c, loc=(x, y, L.post_z(role, kind)), rot=(0, 0, yaw), size=0.3,
                    kind="SINGLE_ARROW")
    U.empty("anchor.counter.drop", c, loc=L.COUNTER_DROP, size=0.2)
    for name, (x, y, yaw) in (("start", L.PLAYER_START), ("counter", L.PLAYER_COUNTER)):
        U.empty(f"anchor.player.{name}", c, loc=(x, y, 0), rot=(0, 0, yaw), size=0.3, kind="SINGLE_ARROW")
    for name, loc, yaw in _SEATS:
        U.empty(f"seat.{name}", c, loc=loc, rot=(0, 0, yaw), size=0.2, kind="SINGLE_ARROW")
    for name, loc, yaw in _INTERACT:
        U.empty(f"interact.{name}", c, loc=loc, rot=(0, 0, yaw), size=0.2, kind="SINGLE_ARROW")


def _nav(root, c):
    """Walkable floor for customers and for staff (furniture cut out)."""
    skip = ("floor", "rug", "doormat", "wall", "wainscot", "rail_", "street", "gutter", "step_stone", "sill_front",
            "post", "entry", "gimmick.noren", "window", "hydrangea", "plant_street", "signboard", "photo", "bunting",
            "hanging", "shelf_vine", "garland", "beam", "nageshi", "ranma", "counter.sign")
    objs = [o for o in root.all_objects if o.type == "MESH"]
    customer = navigation.floor_blockers(objs, skip=skip + ("gimmick.gate",))
    staff = navigation.floor_blockers(objs, skip=skip + ("counter.step",))
    navigation.build("nav.customer", c, L.CUSTOMER_ZONE, customer)
    navigation.build("nav.staff", c, L.STAFF_ZONE, staff)


# --------------------------------------------------------------------------
# Bake groups: each becomes one mesh with one baked texture.

_STRUCT_GROUPS = [
    ("floor", ("floor",)),
    ("wall_back", ("wall_back", "wainscot_back", "rail_back", "nageshi_back", "beam_back", "ranma")),
    ("wall_right", ("wall_right", "wainscot_right", "rail_right", "nageshi_right", "beam_right")),
    ("wall_left", ("wall_left", "wainscot_left", "rail_left", "nageshi_left", "beam_left", "window")),
    ("frame", ("post", "floor_slab", "sill_front")),
]


def bake_groups(root):
    """Split the interior's static meshes into bake groups {name: [objects]} (joined per group)."""
    from .bake import dynamic_root, keeps_material as is_glow
    groups = {}

    def add(name, obj):
        groups.setdefault(name, []).append(obj)

    for coll in root.children:
        zone = coll.name.split(".", 1)[1]
        for obj in coll.all_objects:
            if obj.type != "MESH" or is_glow(obj) or obj.get("ikoka_nav") or dynamic_root(obj):
                continue
            n = obj.name
            if zone == "structure":
                for g, prefixes in _STRUCT_GROUPS:
                    if n.startswith(prefixes) and not (g == "floor" and n.startswith("floor_slab")):
                        add(g, obj)
                        break
                else:
                    add("frame", obj)
            elif zone == "entrance":
                if n.startswith(("street", "gutter", "step_stone", "hydrangea", "plant_street")):
                    add("street", obj)
                elif n.startswith(("entry_", "door_")):
                    add("entrance_wall", obj)
                else:
                    add("entrance", obj)
            elif zone == "archive":
                add("archive_shelves" if n.startswith(("shelf", "archive", "top_box", "map_basket", "map_roll",
                                                       "step_stool")) else "archive_desk", obj)
            else:
                add(zone, obj)
    return groups
