"""Shared materials.

Interior and exterior materials are procedural node trees; the export step
bakes them (with lighting) into textures, so nothing procedural reaches the
GLB. Character materials stay simple (color, sheen, painted textures) so
they survive glTF export as-is.
"""

import bpy

from . import palette as P

_cache = {}


def _new(name):
    if name in _cache:
        return _cache[name], False
    mat = bpy.data.materials.new(name)
    _cache[name] = mat
    return mat, True


def reset_cache():
    _cache.clear()


def _bsdf(mat):
    return mat.node_tree.nodes["Principled BSDF"]


def _node(nt, kind, loc=(0, 0), **props):
    n = nt.nodes.new(kind)
    n.location = loc
    for k, v in props.items():
        setattr(n, k, v)
    return n


def _link(nt, a, b):
    nt.links.new(a, b)


def _coords(nt, kind="Object", scale=(1, 1, 1), loc=(-900, 0)):
    tc = _node(nt, "ShaderNodeTexCoord", loc)
    mp = _node(nt, "ShaderNodeMapping", (loc[0] + 200, loc[1]))
    mp.inputs["Scale"].default_value = scale
    _link(nt, tc.outputs[kind], mp.inputs["Vector"])
    return mp.outputs["Vector"]


def _ramp(nt, fac, stops, loc=(-300, 0)):
    r = _node(nt, "ShaderNodeValToRGB", loc)
    els = r.color_ramp.elements
    els[0].position, els[0].color = stops[0][0], P.lin(stops[0][1])
    els[1].position, els[1].color = stops[-1][0], P.lin(stops[-1][1])
    for pos, col in stops[1:-1]:
        e = els.new(pos)
        e.color = P.lin(col)
    _link(nt, fac, r.inputs["Fac"])
    return r.outputs["Color"]


def _mix_rgb(nt, fac, a, b, loc=(-150, 0), blend="MIX"):
    m = _node(nt, "ShaderNodeMix", loc, data_type="RGBA", blend_type=blend)
    if isinstance(fac, (int, float)):
        m.inputs[0].default_value = fac
    else:
        _link(nt, fac, m.inputs[0])
    for idx, v in ((6, a), (7, b)):
        if isinstance(v, str):
            m.inputs[idx].default_value = P.lin(v)
        else:
            _link(nt, v, m.inputs[idx])
    return m.outputs[2]


def _bump(nt, height, strength=0.2, distance=0.01, loc=(-150, -300)):
    b = _node(nt, "ShaderNodeBump", loc)
    b.inputs["Strength"].default_value = strength
    b.inputs["Distance"].default_value = distance
    _link(nt, height, b.inputs["Height"])
    return b.outputs["Normal"]


# --------------------------------------------------------------------------
# Basic


def flat(name, color, rough=0.75, metal=0.0, sheen=0.0):
    mat, fresh = _new(name)
    if fresh:
        b = _bsdf(mat)
        b.inputs["Base Color"].default_value = P.lin(color)
        b.inputs["Roughness"].default_value = rough
        b.inputs["Metallic"].default_value = metal
        if sheen:
            b.inputs["Sheen Weight"].default_value = sheen
            b.inputs["Sheen Roughness"].default_value = 0.5
        mat.diffuse_color = P.lin(color)
    return mat


def felt(name, color, sheen=0.6):
    """Soft plush look for characters and fabric."""
    mat, fresh = _new(name)
    if fresh:
        b = _bsdf(mat)
        b.inputs["Base Color"].default_value = P.lin(color)
        b.inputs["Roughness"].default_value = 0.9
        b.inputs["Specular IOR Level"].default_value = 0.2
        b.inputs["Sheen Weight"].default_value = sheen
        b.inputs["Sheen Roughness"].default_value = 0.45
        b.inputs["Sheen Tint"].default_value = P.lin(P.mix(color, "#FFFFFF", 0.25))
        mat.diffuse_color = P.lin(color)
    return mat


def emissive(name, color, strength=4.0, base=None):
    mat, fresh = _new(name)
    if fresh:
        b = _bsdf(mat)
        b.inputs["Base Color"].default_value = P.lin(base or color)
        b.inputs["Roughness"].default_value = 0.8
        b.inputs["Emission Color"].default_value = P.lin(color)
        b.inputs["Emission Strength"].default_value = strength
        mat.diffuse_color = P.lin(color)
    return mat


# --------------------------------------------------------------------------
# Procedural surfaces (baked at export)


def wood(name, base=P.WOOD, dark=None, light=None, grain_axis="X", scale=1.0, rough=0.6):
    mat, fresh = _new(name)
    if not fresh:
        return mat
    nt = mat.node_tree
    dark = dark or P.mix(base, "#3A1E0E", 0.35)
    light = light or P.mix(base, "#FFE2B8", 0.18)
    stretch = {"X": (0.6, 14, 14), "Y": (14, 0.6, 14), "Z": (14, 14, 0.6)}[grain_axis]
    co = _coords(nt, scale=tuple(s * scale for s in stretch))
    noise = _node(nt, "ShaderNodeTexNoise", (-500, 0))
    noise.inputs["Scale"].default_value = 2.5
    noise.inputs["Detail"].default_value = 6.0
    noise.inputs["Distortion"].default_value = 0.6
    _link(nt, co, noise.inputs["Vector"])
    col = _ramp(nt, noise.outputs["Fac"], [(0.3, dark), (0.5, base), (0.72, light)])
    b = _bsdf(mat)
    _link(nt, col, b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = rough
    b.inputs["Specular IOR Level"].default_value = 0.35
    _link(nt, _bump(nt, noise.outputs["Fac"], 0.08), b.inputs["Normal"])
    mat.diffuse_color = P.lin(base)
    return mat


def planks(name, base=P.WOOD_FLOOR, grain_axis="X", attr="plank_rand"):
    """Wood for plank geometry: each plank carries a random `attr` (0..1)
    that shifts its tone and its grain so neighbouring boards differ."""
    mat, fresh = _new(name)
    if not fresh:
        return mat
    nt = mat.node_tree
    rnd = _node(nt, "ShaderNodeAttribute", (-1100, -200), attribute_name=attr)
    tc = _node(nt, "ShaderNodeTexCoord", (-1100, 100))
    shift = _node(nt, "ShaderNodeVectorMath", (-900, -200), operation="SCALE")
    _link(nt, rnd.outputs["Vector"], shift.inputs[0])
    shift.inputs["Scale"].default_value = 37.0
    add = _node(nt, "ShaderNodeVectorMath", (-700, 0), operation="ADD")
    _link(nt, tc.outputs["Object"], add.inputs[0])
    _link(nt, shift.outputs[0], add.inputs[1])
    stretch = {"X": (0.7, 16, 16), "Y": (16, 0.7, 16)}[grain_axis]
    mp = _node(nt, "ShaderNodeMapping", (-500, 0))
    mp.inputs["Scale"].default_value = stretch
    _link(nt, add.outputs[0], mp.inputs["Vector"])
    noise = _node(nt, "ShaderNodeTexNoise", (-300, 0))
    noise.inputs["Scale"].default_value = 1.6
    noise.inputs["Detail"].default_value = 6.0
    noise.inputs["Distortion"].default_value = 0.4
    _link(nt, mp.outputs["Vector"], noise.inputs["Vector"])
    grain = _ramp(nt, noise.outputs["Fac"], [(0.3, "#CDBDB0"), (0.7, "#FFFFFF")], loc=(-100, 0))
    tone = _ramp(nt, rnd.outputs["Fac"], [(0.0, P.mix(base, "#4A2410", 0.28)), (0.55, base),
                                          (1.0, P.mix(base, "#F4C895", 0.16))], loc=(-100, -250))
    col = _mix_rgb(nt, 1.0, tone, grain, loc=(150, 0), blend="MULTIPLY")
    b = _bsdf(mat)
    _link(nt, col, b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.45
    b.inputs["Specular IOR Level"].default_value = 0.4
    _link(nt, _bump(nt, noise.outputs["Fac"], 0.06), b.inputs["Normal"])
    mat.diffuse_color = P.lin(base)
    return mat


def plaster(name, color=P.PLASTER):
    mat, fresh = _new(name)
    if not fresh:
        return mat
    nt = mat.node_tree
    co = _coords(nt, scale=(3, 3, 3))
    noise = _node(nt, "ShaderNodeTexNoise", (-500, 0))
    noise.inputs["Scale"].default_value = 4.0
    noise.inputs["Detail"].default_value = 8.0
    _link(nt, co, noise.inputs["Vector"])
    col = _ramp(nt, noise.outputs["Fac"], [(0.35, P.mix(color, "#B08A60", 0.2)), (0.7, P.mix(color, "#FFFFFF", 0.1))])
    b = _bsdf(mat)
    _link(nt, col, b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.95
    _link(nt, _bump(nt, noise.outputs["Fac"], 0.05), b.inputs["Normal"])
    mat.diffuse_color = P.lin(color)
    return mat


def cobblestone(name, color=P.STONE, scale=4.0):
    mat, fresh = _new(name)
    if not fresh:
        return mat
    nt = mat.node_tree
    co = _coords(nt, scale=(scale, scale, scale))
    vor = _node(nt, "ShaderNodeTexVoronoi", (-500, 0), feature="DISTANCE_TO_EDGE")
    _link(nt, co, vor.inputs["Vector"])
    vor_c = _node(nt, "ShaderNodeTexVoronoi", (-500, -250))
    _link(nt, co, vor_c.inputs["Vector"])
    stone = _ramp(nt, vor_c.outputs["Color"], [(0.0, P.mix(color, "#5D5068", 0.3)), (1.0, P.mix(color, "#E8D6C0", 0.3))],
                  loc=(-300, -250))
    edge = _ramp(nt, vor.outputs["Distance"], [(0.02, "#000000"), (0.09, "#FFFFFF")])
    mortar = P.mix(color, "#3B3340", 0.55)
    col = _mix_rgb(nt, edge, mortar, stone)
    b = _bsdf(mat)
    _link(nt, col, b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.85
    _link(nt, _bump(nt, vor.outputs["Distance"], 0.5, 0.02), b.inputs["Normal"])
    mat.diffuse_color = P.lin(color)
    return mat


def paper_lantern(name, color=P.LANTERN, strength=6.0):
    """Glowing washi paper with faint ribs (ribs come from geometry)."""
    mat, fresh = _new(name)
    if fresh:
        b = _bsdf(mat)
        b.inputs["Base Color"].default_value = P.lin(color)
        b.inputs["Roughness"].default_value = 0.9
        b.inputs["Emission Color"].default_value = P.lin(color)
        b.inputs["Emission Strength"].default_value = strength
        mat.diffuse_color = P.lin(color)
    return mat


def dusk_window(name, strength=1.6):
    """Window glass showing a dusk sky gradient (emissive backdrop)."""
    mat, fresh = _new(name)
    if not fresh:
        return mat
    nt = mat.node_tree
    tc = _node(nt, "ShaderNodeTexCoord", (-700, 0))
    sep = _node(nt, "ShaderNodeSeparateXYZ", (-500, 0))
    _link(nt, tc.outputs["Generated"], sep.inputs["Vector"])
    col = _ramp(nt, sep.outputs["Z"], [(0.0, P.SKY_LOW), (0.45, "#C77A8E"), (1.0, P.SKY_TOP)])
    b = _bsdf(mat)
    b.inputs["Base Color"].default_value = (0, 0, 0, 1)
    _link(nt, col, b.inputs["Emission Color"])
    b.inputs["Emission Strength"].default_value = strength
    b.inputs["Roughness"].default_value = 0.2
    mat.diffuse_color = P.lin(P.SKY_TOP)
    return mat


def fabric(name, color, sheen=0.5):
    return felt(name, color, sheen)


def textured(name, tex, rough=0.8, emission=0.0, alpha=False, sheen=0.0, tint=None, glow_tint=None, offset_uv=False):
    """Painted texture from `textures.get(tex)`; optional glow and alpha."""
    from . import textures as T
    mat, fresh = _new(name)
    if not fresh:
        return mat
    nt = mat.node_tree
    img = _node(nt, "ShaderNodeTexImage", (-500, 0))
    img.image = T.get(tex)
    if offset_uv:
        uvn = _node(nt, "ShaderNodeUVMap", (-900, 0))
        mp = _node(nt, "ShaderNodeMapping", (-700, 0), name="uv_offset")
        _link(nt, uvn.outputs["UV"], mp.inputs["Vector"])
        _link(nt, mp.outputs["Vector"], img.inputs["Vector"])
    color = img.outputs["Color"]
    if tint:
        color = _mix_rgb(nt, 1.0, color, tint, loc=(-250, 0), blend="MULTIPLY")
    b = _bsdf(mat)
    _link(nt, color, b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = rough
    b.inputs["Specular IOR Level"].default_value = 0.3
    if sheen:
        b.inputs["Sheen Weight"].default_value = sheen
        b.inputs["Sheen Roughness"].default_value = 0.5
        _link(nt, color, b.inputs["Sheen Tint"])
    if emission:
        glow = _mix_rgb(nt, 1.0, color, glow_tint, loc=(-250, -200), blend="MULTIPLY") if glow_tint else color
        _link(nt, glow, b.inputs["Emission Color"])
        b.inputs["Emission Strength"].default_value = emission
    if alpha:
        _link(nt, img.outputs["Alpha"], b.inputs["Alpha"])
        mat.surface_render_method = "BLENDED"
    return mat
