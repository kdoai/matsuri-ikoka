"""Looping motion clips for the shared staff rig.

Each motion is a periodic function of the loop phase t in [0, 1) that
returns per-bone poses (rotation in degrees in armature axes, location
offset in meters, optional scale). Sampling a periodic function makes every
clip loop seamlessly. Clips stay in place: the app moves the character's
top node, never the bones.

Rotation axes (see rig.pose): X tips forward (+) / back (-), Y rolls toward
the character's right (+), Z turns toward the character's left (+).
Wings: X -90 raises a wing straight forward; Y -90 lifts wing.L sideways
(mirror for wing.R).
"""

import math

import bpy
from mathutils import Euler

from . import rig

FPS = 30


def _s(x):
    return math.sin(2 * math.pi * x)


def _c(x):
    return math.cos(2 * math.pi * x)


def _ease(x):
    """Smoothstep on [0, 1]."""
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def _pulse(t, start, rise, hold, fall):
    """0 -> 1 -> 0 envelope over the loop phase, eased."""
    if t < start:
        return 0.0
    t -= start
    if t < rise:
        return _ease(t / rise)
    t -= rise
    if t < hold:
        return 1.0
    t -= hold
    if t < fall:
        return 1.0 - _ease(t / fall)
    return 0.0


def _mix(a, b, k):
    return tuple(x + (y - x) * k for x, y in zip(a, b))


def _wing(side, rot):
    return rot if side == "L" else rig.mirror(rot)


def _hold(arm, tilt=(0, 0, 0)):
    """Hand rotation that keeps a held pole at `tilt` from vertical whatever the arm's rotation is."""
    a = Euler([math.radians(v) for v in arm], "XYZ").to_quaternion()
    want = Euler([math.radians(v) for v in tilt], "XYZ").to_quaternion()
    return tuple(math.degrees(v) for v in (a.inverted() @ want).to_euler("XYZ"))


# --------------------------------------------------------------------------
# Motions: name -> (duration seconds, pose function, preview character)


def idle(t):
    b = _s(t)
    return {
        "body": {"rot": (0, 1.5 * _s(t + 0.25), 0), "scale": (1 + 0.012 * b, 1 + 0.012 * b, 1 - 0.018 * b)},
        "head": {"rot": (2 * _s(t * 2) * 0.3 - 1, 0, 3 * _s(t + 0.1)), "loc": (0, 0, 0.006 * b)},
        "wing.L": {"rot": _wing("L", (0, -6 - 4 * b, 0))},
        "wing.R": {"rot": _wing("R", (0, -6 - 4 * _s(t + 0.1), 0))},
    }


def _gait(t, cycles=3, stride=0.09, lift=0.07):
    ph = cycles * t
    p = {}
    for side, off in (("L", 0.0), ("R", 0.5)):
        sw = _s(ph + off)
        up = max(0.0, sw)
        p[f"foot.{side}"] = {"loc": (0, -stride * _c(ph + off) * 0.6, lift * up), "rot": (-25 * up, 0, 0)}
    tilt = _s(ph)
    p["body"] = {"rot": (4, -10 * tilt, 3 * _s(ph + 0.25)), "loc": (0, 0, 0.035 * (1 - _c(2 * ph)) / 2)}
    p["head"] = {"rot": (-3, 4 * tilt, 5 * _s(ph + 0.1)), "loc": (0, 0, 0.012 * _s(2 * ph))}
    return p


def walk(t):
    p = _gait(t)
    ph = 3 * t
    p["wing.L"] = {"rot": _wing("L", (-28 * _s(ph), -20, 0))}
    p["wing.R"] = {"rot": _wing("R", (28 * _s(ph), -20, 0))}
    return p


def carry(t):
    p = _gait(t, stride=0.06, lift=0.045)
    ph = 3 * t
    hold = (-78 + 4 * _s(2 * ph), -6, -34)
    p["wing.L"] = {"rot": _wing("L", hold)}
    p["wing.R"] = {"rot": _wing("R", hold)}
    p["head"]["rot"] = (4, p["head"]["rot"][1], p["head"]["rot"][2] * 0.5)
    return p


def flip(t):
    """Researcher flips through a book held in the left wing."""
    k = (t * 2) % 1.0
    sweep = _ease(min(1.0, k / 0.45))
    lift = math.sin(math.pi * min(1.0, k / 0.45))
    return {
        "body": {"rot": (5, 0, 4 * (sweep - 0.5))},
        "head": {"rot": (16 + 2 * _s(t * 2), 0, 12 * (sweep - 0.5))},
        "wing.L": {"rot": _wing("L", (-62, -6, -18))},
        "hand.L": {"rot": _wing("L", (0, 0, -15))},
        "wing.R": {"rot": _wing("R", (-52 - 10 * lift, -6 - 8 * lift, -10 - 45 * sweep))},
        "jaw": {"rot": (4, 0, 0)},
    }


def point(t):
    """Area guide points up at the map, tapping twice."""
    tap = abs(_s(t * 2)) ** 3
    return {
        "body": {"rot": (-6, -4, -8), "loc": (0, 0, 0.01 * tap)},
        "head": {"rot": (-18 + 3 * tap, -5, -10 + 4 * _s(t))},
        "wing.R": {"rot": _wing("R", (-120 + 10 * tap, -45, 0))},
        "hand.R": {"rot": _wing("R", (-12 * tap, 0, 0))},
        "wing.L": {"rot": _wing("L", (8, -14 + 3 * _s(t), 10))},
    }


def look_up(t):
    """Itinerary reads the timetable: head up, scanning left to right."""
    scan = _s(t)
    nodk = abs(_s(t * 2)) ** 2
    return {
        "body": {"rot": (-6, 0, 3 * scan)},
        "head": {"rot": (-26 + 4 * nodk, 0, 16 * scan)},
        "wing.L": {"rot": _wing("L", (12, -10, 0))},
        "wing.R": {"rot": _wing("R", (-40 - 6 * nodk, -10, -20))},
    }


def nod(t):
    """Two quick nods, then a beat."""
    n = _pulse(t, 0.05, 0.12, 0.04, 0.14) + _pulse(t, 0.38, 0.12, 0.04, 0.14)
    return {
        "head": {"rot": (20 * n, 0, 3 * n)},
        "body": {"rot": (4 * n, 0, 0), "scale": (1 + 0.02 * n, 1 + 0.02 * n, 1 - 0.03 * n)},
        "jaw": {"rot": (6 * n, 0, 0)},
        "wing.L": {"rot": _wing("L", (0, -8 - 6 * n, 0))},
        "wing.R": {"rot": _wing("R", (0, -8 - 6 * n, 0))},
    }


def talk(t):
    """Concierge talks: beak chatter, open gestures."""
    chatter = max(0.0, _s(t * 6)) * (0.6 + 0.4 * max(0.0, _s(t * 2 + 0.1)))
    gesture = _pulse(t, 0.1, 0.18, 0.2, 0.2)
    return {
        "jaw": {"rot": (22 * chatter, 0, 0)},
        "head": {"rot": (-4 + 4 * chatter, 0, 6 * _s(t)), "loc": (0, 0, 0.006 * chatter)},
        "body": {"rot": (0, 2 * _s(t), 0), "scale": (1, 1, 1 + 0.015 * chatter)},
        "wing.L": {"rot": _wing("L", (-35 * gesture, -20 - 60 * gesture, 0))},
        "wing.R": {"rot": _wing("R", (-20 - 10 * _s(t * 2), -14, -10))},
    }


def stamp(t):
    """Concierge raises the stamp and presses it on the counter."""
    up = _pulse(t, 0.0, 0.28, 0.08, 0.12)
    hit = _pulse(t, 0.46, 0.03, 0.1, 0.14)
    after = _pulse(t, 0.6, 0.12, 0.1, 0.18)
    arm_x = -60 - 85 * up + 20 * hit
    return {
        "wing.R": {"rot": _wing("R", (arm_x, -10, -18))},
        "hand.R": {"rot": _wing("R", (40 * up - 10 * hit, 0, 0))},
        "wing.L": {"rot": _wing("L", (-10 - 10 * up, -20 - 20 * after, 0))},
        "body": {"rot": (6 * hit - 3 * up, 0, -4 * up),
                 "scale": (1 + 0.07 * hit, 1 + 0.07 * hit, 1 - 0.11 * hit + 0.04 * after)},
        "head": {"rot": (12 * hit - 6 * up - 4 * after, 0, -6 * up + 5 * after)},
        "jaw": {"rot": (14 * after, 0, 0)},
    }


def wave(t):
    """Greeting wave with the right wing."""
    w = _s(t * 3)
    return {
        "wing.R": {"rot": _wing("R", (-10, -120 + 18 * w, 8 * w))},
        "hand.R": {"rot": _wing("R", (0, 20 * w, 0))},
        "wing.L": {"rot": _wing("L", (0, -18, 0))},
        "head": {"rot": (-4, -6 * w * 0.3, -6)},
        "body": {"rot": (0, -3, 0), "loc": (0, 0, 0.01 * abs(_s(t * 1.5)))},
        "jaw": {"rot": (14, 0, 0)},
    }


def sit(t):
    """Sitting: put the character's top node on a `seat.*` anchor. Feet dangle over the edge."""
    b = _s(t)
    swing = 10 * _s(t * 2)
    return {
        "body": {"rot": (-6, 0, 2 * _s(t + 0.2)), "scale": (1 + 0.01 * b, 1 + 0.01 * b, 1 - 0.015 * b)},
        "head": {"rot": (-3 + 2 * _s(t * 2), 0, 4 * _s(t + 0.1))},
        "foot.L": {"loc": (0, -0.12, -0.07), "rot": (-40 + swing, 0, 0)},
        "foot.R": {"loc": (0, -0.12, -0.07), "rot": (-40 - swing, 0, 0)},
        "wing.L": {"rot": _wing("L", (-30, -4, -18))},
        "wing.R": {"rot": _wing("R", (-30, -4, -18))},
    }


def reach(t):
    """Reach out and tap something in front (bell, stamp, gachapon handle, the cat)."""
    tap = _pulse(t, 0.15, 0.15, 0.05, 0.15) + _pulse(t, 0.5, 0.12, 0.05, 0.15)
    up = _pulse(t, 0.0, 0.15, 0.7, 0.15)
    return {
        "body": {"rot": (8 * up, 0, -3 * up)},
        "head": {"rot": (14 * up, 0, -5 * up)},
        "wing.R": {"rot": _wing("R", (-70 * up + 12 * tap, -8, -10))},
        "hand.R": {"rot": _wing("R", (20 * tap, 0, 0))},
        "wing.L": {"rot": _wing("L", (0, -10 - 6 * up, 0))},
        "jaw": {"rot": (8 * up, 0, 0)},
    }


def cheer(t):
    """Happy hop with both wings up."""
    hop = math.sin(math.pi * min(1.0, max(0.0, (t - 0.15) / 0.4)))
    land = _pulse(t, 0.55, 0.05, 0.03, 0.15)
    crouch = _pulse(t, 0.02, 0.1, 0.0, 0.05)
    wings = _pulse(t, 0.1, 0.12, 0.45, 0.25)
    return {
        "root": {"loc": (0, 0, 0.12 * hop)},
        "body": {"scale": (1 + 0.08 * (land + crouch), 1 + 0.08 * (land + crouch), 1 - 0.12 * (land + crouch) + 0.06 * hop)},
        "head": {"rot": (-10 * wings, 0, 6 * _s(t * 2) * wings)},
        "wing.L": {"rot": _wing("L", (-20 * wings, -130 * wings + 15 * _s(t * 4) * wings, 0))},
        "wing.R": {"rot": _wing("R", (-20 * wings, -130 * wings + 15 * _s(t * 4 + 0.5) * wings, 0))},
        "foot.L": {"rot": (-20 * hop, 0, 0)},
        "foot.R": {"rot": (-20 * hop, 0, 0)},
        "jaw": {"rot": (20 * wings, 0, 0)},
    }


def lead(t):
    """The guide leads the way: walking with the flag held high, glancing back at the traveler once a loop."""
    p = _gait(t)
    ph = 3 * t
    arm = _wing("R", (-25, -86 + 5 * _s(ph), 0))
    p["wing.R"] = {"rot": arm}
    p["hand.R"] = {"rot": _hold(arm, (-3, 5 * _s(ph), 0))}
    p["wing.L"] = {"rot": _wing("L", (-28 * _s(ph), -20, 0))}
    look = _pulse(t, 0.32, 0.1, 0.22, 0.12)
    h = p["head"]["rot"]
    p["head"]["rot"] = (h[0], h[1], h[2] + 42 * look)
    p["jaw"] = {"rot": (12 * look, 0, 0)}
    return p


def wave_flag(t):
    """The guide swings the flag in wide arcs overhead to call the traveler over."""
    w = _s(t * 2)
    arm = _wing("R", (-18, -92 + 8 * w, 0))
    return {
        "wing.R": {"rot": arm},
        "hand.R": {"rot": _hold(arm, (-2, -14 + 26 * w, 0))},
        "wing.L": {"rot": _wing("L", (-8, -22 - 6 * abs(w), 0))},
        "body": {"rot": (-3, 3 * w, 0), "loc": (0, 0, 0.012 * abs(_s(t * 2)))},
        "head": {"rot": (-8, 3 * w, -7 * w)},
        "jaw": {"rot": (15, 0, 0)},
    }


def run(t):
    """The guide hurries over: a quick scurry leaning forward, the flag trailing behind."""
    p = _gait(t, cycles=3, stride=0.15, lift=0.11)
    ph = 3 * t
    tilt = _s(ph)
    p["body"] = {"rot": (15, -7 * tilt, 3 * _s(ph + 0.25)), "loc": (0, 0, 0.055 * (1 - _c(2 * ph)) / 2)}
    p["head"]["rot"] = (-14, 3 * tilt, 3 * _s(ph + 0.1))
    arm = _wing("R", (-30 + 10 * _s(ph), -70, 0))
    p["wing.R"] = {"rot": arm}
    p["hand.R"] = {"rot": _hold(arm, (-34 + 6 * _s(2 * ph), -6, 0))}
    p["wing.L"] = {"rot": _wing("L", (42 * _s(ph), -38, 0))}
    p["jaw"] = {"rot": (16, 0, 0)}
    return p


MOTIONS = {
    "idle": (2.4, idle, "hiyoko"),
    "walk": (2.0, walk, "hiyoko"),
    "flip": (2.4, flip, "owl"),
    "point": (2.4, point, "hen"),
    "look_up": (2.4, look_up, "sparrow"),
    "nod": (2.0, nod, "hen"),
    "talk": (2.4, talk, "hiyoko"),
    "stamp": (2.0, stamp, "hiyoko"),
    "carry": (2.0, carry, "sparrow"),
    "wave": (2.0, wave, "hiyoko"),
    "sit": (2.4, sit, "penguin"),
    "reach": (2.0, reach, "penguin"),
    "cheer": (2.0, cheer, "penguin"),
    "lead": (2.0, lead, "hiyoko"),
    "wave_flag": (2.0, wave_flag, "hiyoko"),
    "run": (1.2, run, "hiyoko"),
}


def bake(arm, name):
    """Sample motion `name` into a new action on `arm`. Returns the action."""
    duration, fn, _ = MOTIONS[name]
    frames = int(round(duration * FPS))
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data_create()
    arm.animation_data.action = act
    for f in range(frames + 1):
        poses = fn((f % frames) / frames)
        for bone in rig.BONES:
            p = poses.get(bone, {})
            rig.pose(arm, bone, p.get("rot", (0, 0, 0)), p.get("loc", (0, 0, 0)), p.get("scale"))
            rig.key(arm, bone, f + 1)
    act.frame_range = (1, frames + 1)
    act.use_frame_range = True
    rig.clear_pose(arm)
    return act


def assign(arm, act, frame=None):
    arm.animation_data_create()
    arm.animation_data.action = act
    if act.slots and arm.animation_data.action_slot is None:
        arm.animation_data.action_slot = act.slots[0]
    if frame is not None:
        bpy.context.scene.frame_set(frame)
