"""The shared staff rig.

Every staff character uses this armature unchanged, so one motion clip
drives all four. Parts are rigid and parented straight to bones (no skin
weights). Props attach to `hand.L` / `hand.R`.

Bone names (glTF node names): root, body, head, jaw, wing.L, wing.R,
hand.L, hand.R, foot.L, foot.R. `.L` is the character's left (+X in Blender,
the character faces -Y).
"""

import math

import bpy
from mathutils import Euler, Matrix, Quaternion, Vector

# name: (head, tail, parent)
BONES = {
    "root": ((0, 0, 0), (0, 0, 0.12), None),
    "body": ((0, 0, 0.12), (0, 0, 0.46), "root"),
    "head": ((0, 0, 0.46), (0, 0, 0.92), "body"),
    "jaw": ((0, -0.25, 0.645), (0, -0.35, 0.625), "head"),
    "wing.L": ((0.245, 0, 0.45), (0.33, -0.01, 0.27), "body"),
    "hand.L": ((0.33, -0.01, 0.27), (0.35, -0.02, 0.19), "wing.L"),
    "wing.R": ((-0.245, 0, 0.45), (-0.33, -0.01, 0.27), "body"),
    "hand.R": ((-0.33, -0.01, 0.27), (-0.35, -0.02, 0.19), "wing.R"),
    "foot.L": ((0.11, 0.02, 0.08), (0.11, -0.1, 0.03), "root"),
    "foot.R": ((-0.11, 0.02, 0.08), (-0.11, -0.1, 0.03), "root"),
}


def build(name, coll):
    arm_data = bpy.data.armatures.new(name)
    arm = bpy.data.objects.new(name, arm_data)
    coll.objects.link(arm)
    view_layer = bpy.context.view_layer
    prev = view_layer.objects.active
    view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    for bone, (head, tail, parent) in BONES.items():
        eb = arm_data.edit_bones.new(bone)
        eb.head, eb.tail = head, tail
        eb.roll = 0.0
        if parent:
            eb.parent = arm_data.edit_bones[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    view_layer.objects.active = prev
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
    arm_data.display_type = "STICK"
    arm.show_in_front = True
    return arm


def attach(obj, arm, bone):
    """Parent `obj` rigidly to `bone`, keeping its current world placement."""
    world = obj.matrix_world.copy()
    obj.parent = arm
    obj.parent_type = "BONE"
    obj.parent_bone = bone
    bpy.context.view_layer.update()
    obj.matrix_world = world
    return obj


# --------------------------------------------------------------------------
# Posing in armature axes (X = character's left, Y = back, Z = up)


def rest_rotation(arm, bone):
    return arm.data.bones[bone].matrix_local.to_quaternion()


def pose(arm, bone, rot=(0, 0, 0), loc=(0, 0, 0), scale=None):
    """Set a pose-bone transform given in armature axes.

    rot: XYZ Euler in degrees about the bone's head (X tips the face down,
    Z turns toward the character's left). loc: offset in meters.
    """
    pb = arm.pose.bones[bone]
    rest = rest_rotation(arm, bone)
    q = Euler([math.radians(a) for a in rot], "XYZ").to_quaternion()
    pb.rotation_quaternion = rest.inverted() @ q @ rest
    pb.location = rest.inverted() @ Vector(loc)
    if scale is not None:
        pb.scale = scale if hasattr(scale, "__len__") else (scale,) * 3
    else:
        pb.scale = (1, 1, 1)


def key(arm, bone, frame):
    pb = arm.pose.bones[bone]
    pb.keyframe_insert("rotation_quaternion", frame=frame)
    pb.keyframe_insert("location", frame=frame)
    pb.keyframe_insert("scale", frame=frame)


def clear_pose(arm):
    for pb in arm.pose.bones:
        pb.rotation_quaternion = Quaternion()
        pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)


def bone_world(arm, bone, point="head"):
    b = arm.data.bones[bone]
    return arm.matrix_world @ (b.head_local if point == "head" else b.tail_local)


def mirror(rot):
    """Mirror an armature-axes Euler (degrees) from the left side to the right."""
    return (rot[0], -rot[1], -rot[2])


IDENTITY = Matrix.Identity(4)
