"""The guide: the concierge chick with the cap and the flag.

The cap and the flag ride in staff_hiyoko.glb as `prop.guide_cap` (on the head
bone) and `prop.guide_flag` (in the right hand), hidden like every other prop
until the app shows them. This module renders the outfit and follows it through
every motion to confirm neither part comes off.
"""

import json
import math
import os

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from . import canvas
from . import characters
from . import motions
from . import stage
from . import util as U

OUTFIT = ("prop.guide_cap", "prop.guide_flag")
GUIDE_MOTIONS = ("lead", "wave_flag", "run")
# Motions the app plays while the flag is out. The pole may not cut through the head, body or happi during these.
WITH_FLAG = ("idle", "talk", "nod", "lead", "wave_flag", "run")
# Sample the pole this often, and keep it at least this far from the happi: a pole that crossed the happi would
# always have a sample within half the spacing of the crossing, so it can't slip through unseen.
POLE_SAMPLE_STEP = 0.01
POLE_HAPPI_MIN_M = 0.01


def dressed(coll, loc=(0, 0, 0), yaw=0.0):
    """The chick with only the cap and the flag showing."""
    arm = characters.build("hiyoko", coll, with_props=True)
    for obj in arm.children_recursive:
        if obj.name.startswith("prop.") and not obj.name.startswith(OUTFIT):
            obj.hide_render = True
    arm.location = loc
    arm.rotation_euler = (0, 0, yaw)
    return arm


def _part(arm, name):
    return next(o for o in arm.children_recursive if o.name == name)


def _ellipsoid_clearance(point, center_world_inv, radii):
    p = center_world_inv @ point
    return (p.x / radii[0]) ** 2 + (p.y / radii[1]) ** 2 + (p.z / radii[2]) ** 2


def _surface(obj):
    """The part's mesh where it stands this frame. In world coordinates, because the body squashes and stretches."""
    world = obj.matrix_world
    return BVHTree.FromPolygons([world @ v.co for v in obj.data.vertices], [tuple(p.vertices) for p in obj.data.polygons])


def _pole_heights():
    """Heights along the pole from its foot to its top, measured from the grip."""
    length = characters.FLAG_ABOVE + characters.FLAG_BELOW
    steps = math.ceil(length / POLE_SAMPLE_STEP)
    return [-characters.FLAG_BELOW + length * i / steps for i in range(steps + 1)]


def check_attachment(arm):
    """Run every motion and measure the cap against the head and the pole against the hand.

    Returns a report; raises if a part drifts from where it is held or the pole cuts through the character.
    """
    scene = bpy.context.scene
    flag, cap = _part(arm, "prop.guide_flag"), _part(arm, "prop.guide_cap")
    head, body, happi = _part(arm, "hiyoko.head"), _part(arm, "hiyoko.body"), _part(arm, "hiyoko.happi")
    bpy.context.view_layer.update()
    grip_rest = Vector(characters.GUIDE_GRIP)
    grip_local = flag.matrix_world.inverted() @ grip_rest
    along = Vector((-math.sin(characters.FLAG_LEAN), 0, math.cos(characters.FLAG_LEAN)))
    pole_local = [flag.matrix_world.inverted() @ (grip_rest + h * along) for h in _pole_heights()]
    cap_rest = Vector(characters.GUIDE_CAP_CENTER)
    cap_local = cap.matrix_world.inverted() @ cap_rest
    head_center = head.matrix_world.inverted() @ cap_rest
    rows = []
    worst = {"grip": 0.0, "cap": 0.0}
    bad = []
    for name in motions.MOTIONS:
        act = motions.bake(arm, name)
        motions.assign(arm, act)
        frames = int(round(motions.MOTIONS[name][0] * motions.FPS))
        row = {"motion": name, "grip_to_hand_m": 0.0, "cap_drift_m": 0.0, "pole_head": 9.9, "pole_body": 9.9, "pole_happi_m": 9.9}
        for f in range(1, frames + 1):
            scene.frame_set(f)
            bpy.context.view_layer.update()
            hand = arm.matrix_world @ arm.pose.bones["hand.R"].head
            grip = flag.matrix_world @ grip_local
            row["grip_to_hand_m"] = max(row["grip_to_hand_m"], (grip - hand).length)
            drift = ((cap.matrix_world @ cap_local) - (head.matrix_world @ head_center)).length
            row["cap_drift_m"] = max(row["cap_drift_m"], drift)
            head_inv, body_inv = head.matrix_world.inverted(), body.matrix_world.inverted()
            happi_surface = _surface(happi)
            for q in pole_local:
                w = flag.matrix_world @ q
                row["pole_head"] = min(row["pole_head"], _ellipsoid_clearance(w, head_inv, characters.HEAD_R))
                row["pole_body"] = min(row["pole_body"], _ellipsoid_clearance(w, body_inv, characters.BODY_R))
                row["pole_happi_m"] = min(row["pole_happi_m"], happi_surface.find_nearest(w)[3] - characters.FLAG_POLE_R)
        for key in ("grip_to_hand_m", "cap_drift_m", "pole_head", "pole_body", "pole_happi_m"):
            row[key] = round(row[key], 4)
        worst["grip"] = max(worst["grip"], row["grip_to_hand_m"])
        worst["cap"] = max(worst["cap"], row["cap_drift_m"])
        if row["grip_to_hand_m"] > 0.06 or row["cap_drift_m"] > 0.001:
            bad.append(f"{name}: the outfit left the character ({row})")
        if name in WITH_FLAG and (row["pole_head"] < 1.0 or row["pole_body"] < 1.0 or row["pole_happi_m"] < POLE_HAPPI_MIN_M):
            bad.append(f"{name}: the pole cuts through the character ({row})")
        rows.append(row)
    scene.frame_set(1)
    return {"rows": rows, "worst": worst, "problems": bad}


def target(args, fresh):
    """Outfit from three sides, the guide's motions frame by frame, and the attachment report."""
    out = os.path.join(args.out, "preview")
    fresh()
    coll = U.collection("staff")
    views = ((-1.25, 0.0), (0.0, 0.55), (1.25, 3.14159))
    arms = [dressed(coll, loc=(x, 0, 0), yaw=yaw) for x, yaw in views]
    characters.set_expression("happy")
    if not args.no_render:
        st = U.collection("stage")
        stage.studio(st, target=(0, 0, 0.7))
        cam = stage.camera("cam.guide", st, (0, -6.4, 1.3), (0, 0, 0.82), lens=42)
        stage.setup_render((args.res[0], args.res[1]), args.samples)
        stage.render(os.path.join(out, "guide.png"), cam)
    fresh()
    arm = dressed(U.collection("staff"))
    characters.set_expression("happy")
    report = check_attachment(arm)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "guide_attachment.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    for row in report["rows"]:
        print(f"[ikoka3d] {row}")
    print(f"[ikoka3d] guide outfit worst: {report['worst']}")
    if not args.no_render:
        st = U.collection("stage")
        stage.studio(st, target=(0, 0, 0.7))
        size = 300
        stage.setup_render((size, size), 16)
        bpy.context.scene.render.use_compositing = False
        cols = 6
        sheet = canvas.Canvas(cols * size, len(GUIDE_MOTIONS) * size, "#FFFFFF")
        tmp = os.path.join(out, "_frame.png")
        cam = stage.camera("cam.motion", st, (-1.5, -3.2, 1.4), (-0.1, 0, 0.78), lens=38)
        for row, name in enumerate(GUIDE_MOTIONS):
            motions.assign(arm, motions.bake(arm, name))
            frames = int(round(motions.MOTIONS[name][0] * motions.FPS))
            for col in range(cols):
                bpy.context.scene.frame_set(1 + col * frames // cols)
                stage.render(tmp, cam)
                sheet.paste_file(tmp, col * size, row * size)
            sheet.text(name, 10, row * size + 20, 22, "#2B2220", anchor="lt")
        sheet.save(os.path.join(out, "guide_motions.png"))
        os.remove(tmp)
    if report["problems"]:
        raise RuntimeError("guide outfit: " + "; ".join(report["problems"]))
