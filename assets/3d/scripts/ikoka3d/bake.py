"""Bake the static scenes (interior, exterior) into unlit textures.

For each bake group the meshes are joined, given a fresh UV map and baked
with Cycles in three passes:

  albedo  DIFFUSE color only (few samples, keeps text and pattern crisp)
  light   DIFFUSE direct + indirect, no color (many samples, then blurred)
  gloss   GLOSSY seen from the fixed camera (soft lantern reflections)

final = albedo * light + gloss, written through the scene's view transform
(AgX), so the PNG is display-referred. The group gets an unlit material
(glTF KHR_materials_unlit); the app must render these with tone mapping
off. Objects whose material glows (lanterns, the window view) are left out
of the bake and keep their emissive material for bloom in the app.
"""

import math
import os
import time

import bpy
import numpy as np

from . import util as U


def is_glow(obj):
    for slot in obj.material_slots:
        m = slot.material
        if m is None or not m.node_tree:
            continue
        b = m.node_tree.nodes.get("Principled BSDF")
        if b and b.inputs["Emission Strength"].default_value > 0 and (
                b.inputs["Emission Color"].is_linked or any(b.inputs["Emission Color"].default_value[:3])):
            return True
    return False


def is_alpha(obj):
    return any(s.material and s.material.surface_render_method == "BLENDED" for s in obj.material_slots)


def keeps_material(obj):
    """Glowing or see-through surfaces are not baked; they keep their own material."""
    return is_glow(obj) or is_alpha(obj)


def dynamic_root(obj):
    """The gimmick root (marked `ikoka_dynamic`) above `obj`, or None."""
    o = obj
    while o is not None:
        if o.get("ikoka_dynamic"):
            return o
        o = o.parent
    return None


def dynamic_groups(objs):
    """Meshes under gimmick roots, grouped by the root's `ikoka_bake_group` (baked but never joined)."""
    groups = {}
    for o in objs:
        if o.type != "MESH" or keeps_material(o):
            continue
        r = dynamic_root(o)
        if r is not None:
            groups.setdefault(r.get("ikoka_bake_group", "gimmicks"), []).append(o)
    return groups


def setup_cycles(samples=64):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    cy = scene.cycles
    cy.device = "CPU"
    cy.samples = samples
    cy.use_denoising = False
    cy.max_bounces = 6
    cy.diffuse_bounces = 3
    cy.glossy_bounces = 2
    cy.sample_clamp_indirect = 4.0
    scene.render.bake.margin = 6
    scene.render.bake.margin_type = "EXTEND"
    scene.render.bake.use_clear = True


def _gauss(img, sigma):
    if sigma <= 0:
        return img
    r = int(math.ceil(sigma * 2.5))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2).astype(np.float32)
    k /= k.sum()
    out = img
    for axis in (0, 1):
        pad = [(0, 0)] * img.ndim
        pad[axis] = (r, r)
        p = np.pad(out, pad, mode="edge")
        acc = np.zeros_like(out)
        for i, w in enumerate(k):
            sl = [slice(None)] * img.ndim
            sl[axis] = slice(i, i + out.shape[axis])
            acc += w * p[tuple(sl)]
        out = acc
    return out


def _new_image(name, res, float_buffer=True):
    img = bpy.data.images.get(name)
    if img is not None:
        bpy.data.images.remove(img)
    return bpy.data.images.new(name, res, res, alpha=False, float_buffer=float_buffer)


def _pixels(img):
    a = np.empty(img.size[0] * img.size[1] * 4, np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4)


def prepare_group(name, objs, join=True):
    """Give `objs` a packed 'bake' UV map, joined into one mesh (or kept apart, sharing one atlas).

    Returns the list of objects to bake.
    """
    objs = [o for o in objs if o.type == "MESH"]
    bpy.context.view_layer.update()
    if not join:
        objs = _merge_rigid_siblings(objs)
    for o in objs:
        if join:
            m = o.matrix_world.copy()
            o.parent = None
            o.matrix_world = m
        if o.data.users > 1:
            o.data = o.data.copy()
        U.apply_modifiers(o)
    if join:
        objs = [U.join(objs, f"baked.{name}")]
    for o in objs:
        me = o.data
        if not me.uv_layers:
            me.uv_layers.new(name="UVMap")
        src = me.uv_layers[0]
        src.name = "UVMap"
        me.uv_layers.active = me.uv_layers.new(name="bake")
        src.active_render = True
    vl = bpy.context.view_layer
    vl.objects.active = objs[0]
    for o in vl.objects:
        o.select_set(o in objs)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.006, area_weight=0.0,
                             scale_to_bounds=False)
    bpy.ops.uv.pack_islands(margin=0.006, rotate=True)
    bpy.ops.object.mode_set(mode="OBJECT")
    return objs


def _merge_rigid_siblings(objs):
    """Join meshes that hang from the same parent and never move on their own (fewer bake objects)."""
    by_parent = {}
    for o in objs:
        animated = o.animation_data is not None and len(o.animation_data.nla_tracks) > 0
        if animated or o.children:
            by_parent.setdefault(("solo", o.name), []).append(o)
        else:
            by_parent.setdefault(("parent", o.parent.name if o.parent else ""), []).append(o)
    out = []
    for (kind, key), group in by_parent.items():
        if kind == "solo" or len(group) == 1:
            out += group
            continue
        parent = group[0].parent
        for o in group:
            U.apply_modifiers(o)
            if o.data.users > 1:
                o.data = o.data.copy()
        merged = U.join(group, f"{parent.name}.mesh" if parent else group[0].name)
        out.append(merged)
    return out


def _bake_pass(objs, img, kind, passes, view_from="ABOVE_SURFACE", samples=32):
    scene = bpy.context.scene
    scene.cycles.samples = samples
    scene.render.bake.view_from = view_from
    for obj in objs:
        for slot in obj.material_slots:
            nt = slot.material.node_tree
            node = nt.nodes.get("__bake_target") or nt.nodes.new("ShaderNodeTexImage")
            node.name = "__bake_target"
            node.image = img
            nt.nodes.active = node
    with bpy.context.temp_override(active_object=objs[0], object=objs[0], selected_objects=list(objs),
                                   selected_editable_objects=list(objs)):
        bpy.ops.object.bake(type=kind, pass_filter=passes, target="IMAGE_TEXTURES", use_clear=True)


def bake_group(objs, name, out_png, res=1024, light_samples=64, light_blur=1.4, gloss=True):
    t0 = time.time()
    albedo = _new_image(f"{name}.albedo", res)
    light = _new_image(f"{name}.light", res)
    _bake_pass(objs, albedo, "DIFFUSE", {"COLOR"}, samples=4)
    _bake_pass(objs, light, "DIFFUSE", {"DIRECT", "INDIRECT"}, samples=light_samples)
    a = _pixels(albedo)[..., :3]
    li = _gauss(_pixels(light)[..., :3], light_blur)
    final = a * li
    if gloss:
        gl = _new_image(f"{name}.gloss", res)
        _bake_pass(objs, gl, "GLOSSY", {"DIRECT", "INDIRECT", "COLOR"}, view_from="ACTIVE_CAMERA",
                   samples=max(8, light_samples // 3))
        final = final + _gauss(_pixels(gl)[..., :3], light_blur * 1.5)
        bpy.data.images.remove(gl)
    out = _new_image(f"{name}.final", res)
    rgba = np.concatenate([final, np.ones(final.shape[:2] + (1,), np.float32)], axis=-1)
    out.pixels.foreach_set(rgba.ravel())
    scene = bpy.context.scene
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.color_mode = "RGB"
    os.makedirs(os.path.dirname(out_png), exist_ok=True)
    out.save_render(out_png, scene=scene)
    for im in (albedo, light, out):
        bpy.data.images.remove(im)
    print(f"[ikoka3d] baked {name} ({len(objs)} objects) in {time.time() - t0:.1f}s")
    return out_png


def make_unlit(objs, png, name):
    """Give `objs` one shared unlit material showing `png` on their 'bake' UVs."""
    img = bpy.data.images.load(png, check_existing=False)
    img.colorspace_settings.name = "sRGB"
    img.pack()
    mat = bpy.data.materials.new(f"baked.{name}")
    mat.use_backface_culling = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    uvn = nt.nodes.new("ShaderNodeUVMap")
    uvn.uv_map = "bake"
    bg = nt.nodes.new("ShaderNodeBackground")
    nt.links.new(uvn.outputs["UV"], tex.inputs["Vector"])
    nt.links.new(tex.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    for obj in objs:
        me = obj.data
        me.materials.clear()
        me.materials.append(mat)
        for p in me.polygons:
            p.material_index = 0
        uv_old = me.uv_layers.get("UVMap")
        if uv_old is not None:
            me.uv_layers.remove(uv_old)
        me.uv_layers["bake"].active = True
        me.uv_layers["bake"].active_render = True
        for a in [a.name for a in me.attributes if a.name == "plank_rand"]:
            me.attributes.remove(me.attributes[a])
    return mat


def bake_all(groups, out_dir, res=1024, light_samples=64, dynamic=None):
    """Bake `groups` {name: [objects]} (each joined into one mesh) and `dynamic` {name: [objects]}
    (kept as separate objects sharing one atlas). Returns all baked objects."""
    setup_cycles(light_samples)
    jobs = []
    for name, objs in groups.items():
        if objs:
            jobs.append((name, prepare_group(name, objs, join=True)))
    for name, objs in (dynamic or {}).items():
        if objs:
            jobs.append((name, prepare_group(name, objs, join=False)))
    pngs = {}
    for name, objs in jobs:
        pngs[name] = bake_group(objs, name, os.path.join(out_dir, f"{name}.png"), res, light_samples)
    for name, objs in jobs:
        make_unlit(objs, pngs[name], name)
    return [o for _, objs in jobs for o in objs]
