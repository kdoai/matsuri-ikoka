"""Cameras, preview lighting and EEVEE preview rendering.

The preview lights only exist for the PNG previews and for baking; the app
gets their effect through baked textures plus emissive lanterns.
"""

import math
import os

import bpy
from mathutils import Vector

from . import palette as P
from . import util as U

# Fixed oblique camera over the shop (see README for the numbers in glTF space).
MAIN_TARGET = (0.15, 0.1, 0.75)
MAIN_AZIMUTH = 18.0       # degrees, rotated from the -Y axis toward -X
MAIN_ELEVATION = 34.0     # degrees above the floor plane
MAIN_DISTANCE = 16.0
MAIN_LENS = 50.0


def orbit_position(target, azimuth, elevation, distance):
    az, el = math.radians(azimuth), math.radians(elevation)
    t = Vector(target)
    return t + distance * Vector((-math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))


def camera(name, coll, loc, target, lens=MAIN_LENS):
    cam = bpy.data.cameras.new(name)
    cam.lens = lens
    cam.sensor_width = 36
    cam.clip_start = 0.1
    cam.clip_end = 200
    obj = bpy.data.objects.new(name, cam)
    coll.objects.link(obj)
    obj.location = loc
    obj.rotation_euler = U.look_at_rotation(loc, target)
    return obj


def main_camera(coll):
    loc = orbit_position(MAIN_TARGET, MAIN_AZIMUTH, MAIN_ELEVATION, MAIN_DISTANCE)
    return camera("cam.main", coll, loc, MAIN_TARGET)


# Closer pose on the counter for the moment the travel booklet is finished.
SHIORI_TARGET = (0.35, -0.75, 0.8)


def shiori_camera(coll):
    loc = orbit_position(SHIORI_TARGET, 10.0, 24.0, 7.2)
    return camera("cam.shiori", coll, loc, SHIORI_TARGET)


# --------------------------------------------------------------------------
# Lighting


def world_dusk(strength=0.28):
    """Dim lavender ambient; camera rays see a dusk gradient backdrop instead."""
    world = bpy.data.worlds.new("dusk")
    bpy.context.scene.world = world
    nt = world.node_tree
    out = nt.nodes["World Output"]
    bg = nt.nodes["Background"]
    bg.inputs["Color"].default_value = P.lin("#6A5E9E")
    bg.inputs["Strength"].default_value = strength
    sky = nt.nodes.new("ShaderNodeBackground")
    coord = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    nt.links.new(coord.outputs["Window"], sep.inputs["Vector"])
    nt.links.new(sep.outputs["Y"], ramp.inputs["Fac"])
    e = ramp.color_ramp.elements
    e[0].position, e[0].color = 0.0, P.lin("#E39A86")
    e[1].position, e[1].color = 1.0, P.lin("#3E3576")
    mid = e.new(0.45)
    mid.color = P.lin("#9A6E9E")
    nt.links.new(ramp.outputs["Color"], sky.inputs["Color"])
    sky.inputs["Strength"].default_value = 1.0
    path = nt.nodes.new("ShaderNodeLightPath")
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(path.outputs["Is Camera Ray"], mix.inputs["Fac"])
    nt.links.new(bg.outputs["Background"], mix.inputs[1])
    nt.links.new(sky.outputs["Background"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    return world


def point(name, coll, loc, power, color, radius=0.08):
    light = bpy.data.lights.new(name, "POINT")
    light.energy = power
    light.color = P.lin(color)[:3]
    light.shadow_soft_size = radius
    obj = bpy.data.objects.new(name, light)
    coll.objects.link(obj)
    obj.location = loc
    return obj


def area(name, coll, loc, target, power, color, size=2.0, size_y=None, shape="RECTANGLE"):
    light = bpy.data.lights.new(name, "AREA")
    light.energy = power
    light.color = P.lin(color)[:3]
    light.shape = shape
    light.size = size
    light.size_y = size_y or size
    obj = bpy.data.objects.new(name, light)
    coll.objects.link(obj)
    obj.location = loc
    obj.rotation_euler = U.look_at_rotation(loc, target)
    return obj


def interior_lights(coll, lantern_points):
    """Dusk interior: cool sky from above, warm lantern pools, pink window light."""
    world_dusk()
    area("light.sky", coll, (-3, -7, 8), (0.3, 0.0, 0), 320, "#9A90E0", size=9)
    area("light.room_warm", coll, (0.3, 0.6, 4.0), (0.3, 0.6, 0), 460, "#FFAE62", size=6, size_y=4.5)
    area("light.window", coll, (-4.3, 0.8, 1.7), (-2.0, 0.8, 0.6), 260, "#F59AA0", size=1.2, size_y=2.0)
    for i, (loc, power, color) in enumerate(lantern_points):
        point(f"light.lantern.{i:02d}", coll, loc, power * 1.3, color)


def studio(coll, target=(0, 0, 0.55), width=4.0):
    """Soft warm studio for character previews."""
    world = bpy.data.worlds.new("studio")
    bpy.context.scene.world = world
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = P.lin("#F3E6D6")
    bg.inputs["Strength"].default_value = 0.35
    t = Vector(target)
    area("light.key", coll, t + Vector((-2.5, -3.5, 3.0)), t, 260 * width / 4, "#FFF1DE", size=3)
    area("light.fill", coll, t + Vector((3.0, -2.5, 1.2)), t, 90 * width / 4, "#E8E4FF", size=3)
    area("light.rim", coll, t + Vector((0.5, 3.5, 2.5)), t, 220 * width / 4, "#FFE2B0", size=2.5)
    floor = U.plane("studio_floor", (40, 40), coll, mat=_studio_floor())
    _ = floor


def _studio_floor():
    mat = bpy.data.materials.new("studio_floor")
    b = mat.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = P.lin("#EADBC8")
    b.inputs["Roughness"].default_value = 0.9
    return mat


# --------------------------------------------------------------------------
# Render


def setup_render(res=(1920, 1080), samples=64):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    ee = scene.eevee
    ee.taa_render_samples = samples
    ee.use_raytracing = True
    ee.use_shadows = True
    ee.shadow_ray_count = 2
    ee.shadow_step_count = 8
    ee.shadow_pool_size = "1024"
    ee.use_fast_gi = True
    ee.fast_gi_method = "GLOBAL_ILLUMINATION"
    scene.view_settings.view_transform = "AgX"
    try:
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass
    scene.view_settings.exposure = 0.4
    _bloom(scene)


def _bloom(scene, strength=0.6):
    ng = bpy.data.node_groups.new("preview_comp", "CompositorNodeTree")
    ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    rl = ng.nodes.new("CompositorNodeRLayers")
    glare = ng.nodes.new("CompositorNodeGlare")
    glare.inputs["Type"].default_value = "Bloom"
    glare.inputs["Threshold"].default_value = 1.2
    glare.inputs["Strength"].default_value = strength
    glare.inputs["Size"].default_value = 0.6
    out = ng.nodes.new("NodeGroupOutput")
    ng.links.new(rl.outputs["Image"], glare.inputs["Image"])
    ng.links.new(glare.outputs["Image"], out.inputs[0])
    scene.compositing_node_group = ng
    scene.render.use_compositing = True


def render(path, camera_obj):
    scene = bpy.context.scene
    scene.camera = camera_obj
    os.makedirs(os.path.dirname(path), exist_ok=True)
    scene.render.filepath = path
    scene.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)
    print(f"[ikoka3d] preview: {path}")


def render_baked_preview(path, camera_obj, res):
    """Render the baked scene the way the app shows it: textures as-is, no tone mapping."""
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.eevee.taa_render_samples = 16
    if scene.compositing_node_group is None:
        _bloom(scene)
    render(path, camera_obj)
