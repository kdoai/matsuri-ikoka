"""Still images of the staff and the traveler for the travel booklet.

Each still is one character in one pose of a motion, with one expression and
its role props, rendered on a transparent background with the same
orthographic camera, so every character keeps the same scale on the page.
The render is cropped to the character and saved as WebP with alpha.
"""

import os

import bpy
import numpy as np

from . import characters
from . import motions
from . import stage
from . import util as U

# name: (character, motion, time in the loop 0..1, expression, props to show, camera x)
STILLS = {
    "hiyoko_wave": ("hiyoko", "wave", 0.08, "happy", (), 1.1),
    "hiyoko_stamp": ("hiyoko", "stamp", 0.2, "determined", ("prop.stamp",), -1.1),
    "owl_book": ("owl", "flip", 0.05, "normal", ("prop.book",), 1.6),
    "hen_point": ("hen", "point", 0.0, "happy", ("prop.map",), 0.2),
    "sparrow_binder": ("sparrow", "look_up", 0.75, "determined", ("prop.binder",), 1.1),
    "penguin_cheer": ("penguin", "cheer", 0.32, "sparkle", (), 0.4),
    "penguin_stampbook": ("penguin", "idle", 0.0, "happy", ("prop.stampbook",), 1.1),
}

SIZE = 640          # square render, before cropping
ORTHO_SCALE = 1.7   # metres across the frame (characters are about 1 m tall)
PAD = 8             # transparent pixels kept around the crop
QUALITY = 90        # WebP quality


def target(args, fresh):
    os.makedirs(args.stills, exist_ok=True)
    for name, (kind, motion, t, expression, shown, cam_x) in STILLS.items():
        fresh()
        arm = characters.build(kind, U.collection("staff"), with_props=True)
        for obj in arm.children_recursive:
            if obj.name.startswith("prop.") and obj.name not in shown:
                obj.hide_render = True
        act = motions.bake(arm, motion)
        duration = motions.MOTIONS[motion][0]
        motions.assign(arm, act, frame=1 + int(round(t * duration * motions.FPS)))
        characters.set_expression(expression)
        _render(name, args, cam_x)


def _render(name, args, cam_x):
    st = U.collection("stage")
    stage.studio(st, target=(0, 0, 0.55))
    bpy.data.objects["studio_floor"].hide_render = True
    cam = stage.camera("cam.still", st, (cam_x, -3.6, 1.45), (0, 0, 0.55))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = ORTHO_SCALE
    stage.setup_render((SIZE, SIZE), args.samples)
    scene = bpy.context.scene
    scene.render.film_transparent = True
    scene.render.image_settings.color_mode = "RGBA"
    tmp = os.path.join(args.out, "stills", f"{name}.png")
    stage.render(tmp, cam)
    _crop_to_webp(tmp, os.path.join(args.stills, f"{name}.webp"))


def _crop_to_webp(src, dst):
    img = bpy.data.images.load(src)
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    bpy.data.images.remove(img)
    ys, xs = np.nonzero(px[:, :, 3] > 0.02)
    y0, y1 = max(0, ys.min() - PAD), min(h, ys.max() + PAD + 1)
    x0, x1 = max(0, xs.min() - PAD), min(w, xs.max() + PAD + 1)
    crop = np.ascontiguousarray(px[y0:y1, x0:x1])
    out = bpy.data.images.new("__still", x1 - x0, y1 - y0, alpha=True)
    out.pixels.foreach_set(crop.ravel())
    out.filepath_raw = dst
    out.file_format = "WEBP"
    out.save(quality=QUALITY)
    bpy.data.images.remove(out)
    print(f"[ikoka3d] still: {dst} ({x1 - x0}x{y1 - y0})")
