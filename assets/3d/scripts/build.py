"""Build every MATSURI IKOKA 3D asset from scratch.

Run with Blender 5.2 in background mode:

    blender -b --factory-startup --python-exit-code 1 -P assets/3d/scripts/build.py -- --target all

See assets/3d/README.md for targets and options.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from ikoka3d import cli  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
sys.exit(cli.main(argv))
