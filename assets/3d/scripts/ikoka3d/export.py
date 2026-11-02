"""GLB export, optimization (gltf-transform) and the size/triangle manifest."""

import json
import os
import shutil
import struct
import subprocess

import bpy

GLTF_TRANSFORM = "@gltf-transform/cli@4.5.1"


def select_only(objs):
    vl = bpy.context.view_layer
    keep = set(objs)
    for o in vl.objects:
        o.select_set(o in keep)
    if objs:
        vl.objects.active = objs[0]


def export_glb(path, objs, animations=False, cameras=False, action_mode="ACTIVE_ACTIONS"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    select_only(objs)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_cameras=cameras,
        export_lights=False,
        export_extras=False,
        export_animations=animations,
        export_animation_mode=action_mode,
        export_force_sampling=True,
        export_frame_range=True,
        export_optimize_animation_size=False,
        export_morph=False,
        export_skins=True,
    )
    print(f"[ikoka3d] wrote {path} ({os.path.getsize(path) / 1024:.0f} KB)")
    return path


def glb_json(path):
    with open(path, "rb") as f:
        data = f.read()
    length = struct.unpack("<I", data[12:16])[0]
    return json.loads(data[20:20 + length])


def glb_triangles(path):
    j = glb_json(path)
    acc = j.get("accessors", [])
    total = 0
    counted = {}
    for node in j.get("nodes", []):
        if "mesh" in node:
            counted[node["mesh"]] = counted.get(node["mesh"], 0) + 1
    for mi, uses in counted.items():
        for prim in j["meshes"][mi]["primitives"]:
            if prim.get("mode", 4) != 4:
                continue
            n = acc[prim["indices"]]["count"] if "indices" in prim else acc[prim["attributes"]["POSITION"]]["count"]
            total += n // 3 * uses
    return total


def _gltf_transform(*args):
    npx = shutil.which("npx") or shutil.which("npx.cmd") or "npx"
    res = subprocess.run([npx, "--yes", GLTF_TRANSFORM, *args], capture_output=True, text=True,
                         shell=os.name == "nt" and npx.lower().endswith(".cmd"))
    if res.returncode != 0:
        print(res.stdout[-2000:], res.stderr[-2000:])
        raise RuntimeError(f"gltf-transform {args[0]} failed for {args[1]}")


def optimize(raw, out, texture_size=1024):
    """Meshopt + WebP (<= texture_size) while keeping the node tree and names intact.

    Pruning runs on its own first with --keep-leaves, because `optimize`'s
    built-in prune drops empty nodes such as the anchor.* placement markers.
    """
    os.makedirs(os.path.dirname(out), exist_ok=True)
    pruned = out + ".pruned.glb"
    _gltf_transform("prune", raw, pruned, "--keep-leaves", "true", "--keep-solid-textures", "true")
    _gltf_transform("optimize", pruned, out,
                    "--compress", "meshopt", "--texture-compress", "webp", "--texture-size", str(texture_size),
                    "--prune", "false", "--flatten", "false", "--join", "false", "--instance", "false",
                    "--palette", "false", "--simplify", "false")
    os.remove(pruned)
    return out


def write_manifest(dist_dir):
    rows = []
    for name in sorted(os.listdir(dist_dir)):
        if not name.endswith(".glb"):
            continue
        p = os.path.join(dist_dir, name)
        j = glb_json(p)
        rows.append({
            "file": name,
            "kilobytes": round(os.path.getsize(p) / 1024, 1),
            "triangles": glb_triangles(p),
            "animations": [a.get("name") for a in j.get("animations", [])],
            "textures": len(j.get("images", [])),
        })
    with open(os.path.join(dist_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"files": rows, "total_kilobytes": round(sum(r["kilobytes"] for r in rows), 1)}, f, indent=2)
    for r in rows:
        print(f"[ikoka3d] {r['file']:28s} {r['kilobytes']:8.1f} KB {r['triangles']:7d} tris")
    print(f"[ikoka3d] total {sum(r['kilobytes'] for r in rows) / 1024:.2f} MB")
    _readme_stats(os.path.join(os.path.dirname(dist_dir), "README.md"), rows)
    return rows


def _readme_stats(readme, rows):
    """Rewrite the table between <!-- stats --> markers in the README."""
    if not os.path.exists(readme):
        return
    lines = ["<!-- stats -->", "", "| ファイル | 三角形 | サイズ |", "| --- | ---: | ---: |"]
    for r in rows:
        lines.append(f"| `{r['file']}` | {r['triangles']:,} | {r['kilobytes']:,.0f} KB |")
    total = sum(r["kilobytes"] for r in rows)
    lines += [f"| 合計 | | {total / 1024:.2f} MB |", "", "<!-- /stats -->"]
    with open(readme, encoding="utf-8") as f:
        text = f.read()
    start = text.index("<!-- stats -->")
    end = text.index("<!-- /stats -->") + len("<!-- /stats -->") if "<!-- /stats -->" in text else start + len(
        "<!-- stats -->")
    with open(readme, "w", encoding="utf-8") as f:
        f.write(text[:start] + "\n".join(lines) + text[end:])
