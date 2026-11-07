"""Command line entry: parse options and run the requested targets.

Targets (run in this order by `--target all`):
  textures    painted textures -> out/textures (review only)
  characters  four staff and the player penguin: lineup preview, staff_<kind>.glb, player_penguin.glb
  motions     motion clips: contact-sheet preview, motion_<name>.glb
  interior    shop interior: preview, Cycles bake, interior.glb
  exterior    storefront + entry camera path: preview, bake, exterior.glb
  ennichi     festival street with its six stalls: previews, bake, ennichi.glb
  optimize    gltf-transform (meshopt, WebP <= 1024) out/glb -> models/, manifest.json

Extra target (not part of `all`):
  guide       the guide's cap and flag: previews, and a check that they stay on through every motion
  stills      staff and traveler stills for the travel booklet, and the faces -> ../shiori/staff/*.webp
  faces       only the square face close-ups (dialogue window, booklet) -> ../shiori/staff/face_*.webp
"""

import argparse
import os
import time

import bpy

from . import characters
from . import interior
from . import layout as L
from . import materials as M
from . import stage
from . import textures
from . import util as U

ASSETS_3D = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

TARGETS = ("textures", "characters", "motions", "interior", "exterior", "ennichi", "optimize")
EXTRA_TARGETS = ("guide", "stills", "faces")


def parse(argv):
    ap = argparse.ArgumentParser(prog="build.py")
    ap.add_argument("--target", default="all",
                    help="all, or one or more of: " + ", ".join(TARGETS + EXTRA_TARGETS) + " (comma-separated)")
    ap.add_argument("--out", default=os.path.join(ASSETS_3D, "out"),
                    help="previews, .blend files and raw GLBs (git-ignored)")
    ap.add_argument("--dist", default=os.path.join(ASSETS_3D, "models"), help="optimized GLBs for the app")
    ap.add_argument("--stills", default=os.path.join(ASSETS_3D, "..", "shiori", "staff"),
                    help="staff stills for the travel booklet (target stills)")
    ap.add_argument("--res", default="1920x1080", help="preview resolution WxH")
    ap.add_argument("--samples", type=int, default=64, help="EEVEE preview samples")
    ap.add_argument("--bake-samples", type=int, default=64, help="Cycles samples for the lighting bake")
    ap.add_argument("--bake-res", type=int, default=1024, help="bake texture size")
    ap.add_argument("--only", default="", help="optimize only these models (comma-separated names, no extension); "
                                               "the rest of models/ stays as it is")
    ap.add_argument("--no-render", action="store_true", help="skip preview PNGs")
    ap.add_argument("--no-export", action="store_true", help="skip bakes and GLB export")
    ap.add_argument("--save-blend", action="store_true", help="also save the working .blend")
    return ap.parse_args(argv)


def main(argv):
    args = parse(argv)
    args.res = tuple(int(v) for v in args.res.lower().split("x"))
    targets = TARGETS if args.target == "all" else tuple(t.strip() for t in args.target.split(","))
    unknown = [t for t in targets if t not in TARGETS + EXTRA_TARGETS]
    if unknown:
        raise SystemExit(f"unknown target(s): {', '.join(unknown)}")
    for t in targets:
        start = time.time()
        globals()[f"target_{t}"](args)
        print(f"[ikoka3d] {t} done in {time.time() - start:.1f}s")
    return 0


def _fresh():
    U.reset_scene()
    M.reset_cache()
    textures.reset()


def _save(args, name):
    if args.save_blend:
        path = os.path.join(args.out, "blend", f"{name}.blend")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=path)


def _glb(args, name):
    return os.path.join(args.out, "glb", f"{name}.glb")


# --------------------------------------------------------------------------


def target_textures(args):
    """Write every painted texture to out/textures for review."""
    _fresh()
    textures.export_all(os.path.join(args.out, "textures"))


def target_characters(args):
    """Lineup of the staff and the player, expression close-ups, and one GLB per character."""
    from . import export
    _fresh()
    coll = U.collection("staff")
    kinds = ["owl", "hiyoko", "hen", "sparrow", "penguin"]
    arms = {}
    for i, kind in enumerate(kinds):
        x = (i - 2) * 0.95
        arms[kind] = characters.placeholder(kind, coll, loc=(x, 0, 0), yaw=-x * 0.12)
        print(f"[ikoka3d] {kind} triangles: {U.triangle_count(characters.meshes(arms[kind]))}")
    if not args.no_render:
        st = U.collection("stage")
        stage.studio(st, target=(0, 0, 0.55))
        cam = stage.camera("cam.lineup", st, (0, -6.6, 1.4), (0, 0, 0.5), lens=50)
        stage.setup_render((args.res[0], args.res[1] * 3 // 4), args.samples)
        stage.render(os.path.join(args.out, "preview", "characters.png"), cam)
        close = stage.camera("cam.close", st, (0.0, -1.9, 0.85), (0.0, 0, 0.62), lens=60)
        for name in ("happy", "surprised", "wink", "sleepy"):
            characters.set_expression(name)
            stage.render(os.path.join(args.out, "preview", f"face_{name}.png"), close)
        characters.set_expression("normal")
    _save(args, "characters")
    if args.no_export:
        return
    for kind in kinds:
        _fresh()
        arm = characters.build(kind, U.collection("staff"))
        file = characters.node_name(kind).replace(".", "_")
        export.export_glb(_glb(args, file), [arm] + list(arm.children_recursive))


def target_motions(args):
    """Bake every motion; preview each as a strip of frames; one GLB per motion."""
    from . import canvas, export, motions, rig
    import numpy as np
    _fresh()
    coll = U.collection("staff")
    arms = {}
    for i, kind in enumerate(characters.SPECIES):
        arms[kind] = characters.placeholder(kind, coll, loc=(i * 3.0, 0, 0))
    acts = {name: motions.bake(arms["hiyoko"], name) for name in motions.MOTIONS}
    if not args.no_render:
        st = U.collection("stage")
        stage.studio(st, target=(6.0, 0, 0.55), width=15)
        size = 300
        stage.setup_render((size, size), 16)
        bpy.context.scene.render.use_compositing = False
        cols = 6
        names = list(motions.MOTIONS)
        sheet = canvas.Canvas(cols * size, len(names) * size, "#FFFFFF")
        tmp = os.path.join(args.out, "preview", "_frame.png")
        for row, name in enumerate(names):
            duration, _, kind = motions.MOTIONS[name]
            arm = arms[kind]
            for k in arms:
                bpy.data.collections[f"staff.{k}"].hide_render = k != kind
            motions.assign(arm, acts[name])
            x = arm.location.x
            cam = stage.camera(f"cam.{name}", st, (x - 1.15, -1.95, 1.05), (x, 0, 0.5), lens=50)
            frames = int(round(duration * motions.FPS))
            for col in range(cols):
                bpy.context.scene.frame_set(1 + col * frames // cols)
                stage.render(tmp, cam)
                img = bpy.data.images.load(tmp)
                px = np.array(img.pixels[:], dtype=np.float32).reshape(size, size, 4)[::-1]
                bpy.data.images.remove(img)
                sheet.px[row * size:(row + 1) * size, col * size:(col + 1) * size] = px
            sheet.text(name, 10, row * size + 20, 22, "#2B2220", anchor="lt")
        sheet.save(os.path.join(args.out, "preview", "motions.png"))
        os.remove(tmp)
    if args.no_export:
        return
    for name in motions.MOTIONS:
        # One clean scene per clip so the file holds exactly one animation, named after the motion.
        _fresh()
        arm = rig.build("staff.rig", U.collection("rig"))
        motions.assign(arm, motions.bake(arm, name))
        export.export_glb(_glb(args, f"motion_{name}"), [arm], animations=True, action_mode="ACTIONS")


def _interior_scene(with_staff=True):
    root, lantern_points = interior.build()
    if with_staff:
        staff = U.collection("staff")
        for role, s in L.STAFF.items():
            x, y, yaw = s["post"]
            characters.placeholder(s["character"], staff, loc=(x, y, L.post_z(role)), yaw=yaw)
        x, y, yaw = L.PLAYER_COUNTER
        characters.placeholder("penguin", staff, loc=(x, y, 0), yaw=yaw)
    rig_coll = U.collection("stage")
    cam = stage.main_camera(rig_coll)
    stage.interior_lights(rig_coll, lantern_points)
    return root, cam


def target_interior(args):
    """Interior with the staff at their posts from the fixed camera; then bake and export the room."""
    from . import bake, export
    _fresh()
    root, cam = _interior_scene()
    meshes = [o for o in root.all_objects if o.type == "MESH"]
    print(f"[ikoka3d] interior triangles: {U.triangle_count(meshes)}")
    _save(args, "interior")
    if not args.no_render:
        stage.setup_render(args.res, args.samples)
        stage.render(os.path.join(args.out, "preview", "interior.png"), cam)
    if args.no_export:
        return
    _fresh()
    root, cam = _interior_scene(with_staff=False)
    stage.setup_render(args.res, args.samples)
    bpy.context.scene.camera = cam
    everything = list(root.all_objects)
    roots = {bake.dynamic_root(o) for o in everything} - {None}
    groups = interior.bake_groups(root)
    dynamic = bake.dynamic_groups(everything)
    baked = bake.bake_all(groups, os.path.join(args.out, "bake", "interior"), args.bake_res, args.bake_samples,
                          dynamic=dynamic)
    everything = list(root.all_objects)     # joining replaced many objects
    moving = set(roots) | {d for r in roots for d in r.children_recursive}
    kept_mat = [o for o in everything if o.type == "MESH" and bake.keeps_material(o)]
    markers = [o for o in everything if o.name.startswith(("anchor.", "seat.", "interact.")) or o.get("ikoka_nav")]
    keep = set(baked) | set(kept_mat) | set(markers) | moving | {cam, stage.shiori_camera(U.collection("stage"))}
    _detach([o for o in kept_mat if o not in moving] + list(roots))
    for o in list(bpy.data.objects):
        if o not in keep:
            bpy.data.objects.remove(o)
    meshes = [o for o in keep if o.type == "MESH" and not o.get("ikoka_nav")]
    print(f"[ikoka3d] interior export triangles: {U.triangle_count(meshes)}")
    _save(args, "interior_baked")
    export.export_glb(_glb(args, "interior"), list(keep), cameras=True, animations=True, action_mode="NLA_TRACKS")
    if not args.no_render:
        stage.render_baked_preview(os.path.join(args.out, "preview", "interior_baked.png"), cam, args.res)


def _detach(objs):
    """Clear parents but keep world placement (the empties they hang from are removed)."""
    bpy.context.view_layer.update()
    for o in objs:
        m = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = m


def target_exterior(args):
    from . import exterior
    exterior.target(args, _fresh, _save, _glb)


def target_ennichi(args):
    from . import ennichi
    ennichi.target(args, _fresh, _save, _glb)


def target_guide(args):
    from . import guide
    guide.target(args, _fresh)


def target_stills(args):
    from . import stills
    stills.target(args, _fresh)


def target_faces(args):
    from . import stills
    stills.faces(args, _fresh)


def target_optimize(args):
    from . import export
    raw_dir = os.path.join(args.out, "glb")
    raw = set(n for n in os.listdir(raw_dir) if n.endswith(".glb"))
    only = {f"{n.strip()}.glb" for n in args.only.split(",") if n.strip()}
    missing = only - raw
    if missing:
        raise SystemExit(f"--only: not built yet: {', '.join(sorted(missing))}")
    # Only a full rebuild has made every model, so only then does a missing raw file mean the model is gone.
    if os.path.isdir(args.dist) and args.target == "all" and not args.no_export and not only:
        for name in os.listdir(args.dist):
            if name.endswith(".glb") and name not in raw:
                os.remove(os.path.join(args.dist, name))      # files from characters that no longer exist
    for name in sorted(only or raw):
        export.optimize(os.path.join(raw_dir, name), os.path.join(args.dist, name))
        print(f"[ikoka3d] optimized {name}")
    export.write_manifest(args.dist)
