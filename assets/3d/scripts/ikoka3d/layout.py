"""Shop floor plan shared by the interior, exterior, characters and cameras.

Blender coordinates: meters, Z up. The shop's front (-Y) is cut away so the
fixed camera can look in; only the entrance bay at the front-left is built.
The street runs along the front. A character at yaw 0 faces -Y.
Staff are about 1 m tall; furniture is sized for them.
"""

import math

X0, X1 = -4.0, 4.0          # inner face of left / right wall
Y0, Y1 = -3.0, 3.0          # front edge / inner face of back wall
WALL_H = 3.1
WALL_T = 0.16
FLOOR_Z = 0.0               # shop floor; the street is lower
STREET_Z = -0.22
WAINSCOT_H = 0.85

# Entrance bay at the front-left.
ENTRY_X = (X0, -1.75)       # extent of the built front wall
DOOR_X = (-3.3, -2.05)
DOOR_H = 2.0
ENTRY_TOP = 2.45

WINDOW_Y = (-0.2, 1.8)      # window in the left wall
WINDOW_Z = (1.05, 2.3)

COUNTER_C = (0.35, -1.0)
COUNTER_S = (2.6, 0.72, 0.6)
COUNTER_STEP = 0.14         # raised step behind the counter for the concierge

SHELF_X = (-3.85, -1.55)    # archive shelves along the back wall
MAP_X = (-1.15, 1.75)       # map wall
MAP_Z = (1.05, 2.5)
TIMETABLE_X = (2.15, 3.85)
TIMETABLE_Z = (1.2, 2.5)
QUEST_Y = (-0.85, 0.95)     # quest board on the right wall
QUEST_Z = (1.05, 2.15)

# Each role (the app's StaffId): post (work spot) and home (idle spot). (x, y, yaw); see post_z().
STAFF = {
    "concierge": {"character": "hiyoko", "post": (0.35, -0.36, 0.0), "home": (0.35, -0.36, 0.0)},
    "researcher": {"character": "owl", "post": (-2.65, 2.0, math.pi - 0.45), "home": (-1.3, 0.3, -0.3)},
    "scout": {"character": "hen", "post": (0.2, 1.55, math.pi - 0.3), "home": (1.9, 0.35, 0.3)},
    "planner": {"character": "sparrow", "post": (3.0, 2.05, math.pi + 0.35), "home": (1.75, 1.05, 0.5)},
}

# The traveler penguin the user plays. (x, y, yaw)
PLAYER_START = (-2.65, -2.45, math.pi)      # just inside the noren, facing into the shop
PLAYER_COUNTER = (0.35, -1.78, math.pi)     # in front of the counter, facing the concierge

# Customers stay on the front side of a low fence; staff work behind it.
FENCE_Y = -0.85
GATE_X = (-1.75, -1.15)                     # staff gate in the left fence (hinge at the right end)
NOOK_X = 2.25                               # the customer nook by the quest board ends here...
NOOK_Y = 1.25                               # ...and here
CUSTOMER_ZONE = [(X0 + 0.08, Y0 + 0.12), (X1 - 0.08, Y0 + 0.12), (X1 - 0.08, NOOK_Y - 0.08),
                 (NOOK_X + 0.08, NOOK_Y - 0.08), (NOOK_X + 0.08, FENCE_Y - 0.08), (X0 + 0.08, FENCE_Y - 0.08)]
STAFF_ZONE = [(X0 + 0.08, FENCE_Y + 0.08), (NOOK_X - 0.08, FENCE_Y + 0.08), (NOOK_X - 0.08, NOOK_Y + 0.08),
              (X1 - 0.08, NOOK_Y + 0.08), (X1 - 0.08, Y1 - 0.08), (X0 + 0.08, Y1 - 0.08)]

# Front of the shop, customer side.
BENCH = (1.1, -2.62)                        # waiting bench facing the counter
STAMP_TABLE = (-1.2, -2.45)
OMIKUJI = (X1 - 0.95, NOOK_Y - 0.28)     # in the nook, between the plant and the gachapon
SOUVENIR = (X1 - 0.2, 0.05)                 # shelf against the right wall, under the quest board
GACHA = (X1 - 0.3, 1.0)

# Where the itinerary staff drops documents on the counter.
COUNTER_DROP = (1.25, -0.95, COUNTER_S[2])


def post_z(role, kind="post"):
    """Floor height under a staff spot (the concierge stands on the step)."""
    return COUNTER_STEP if role == "concierge" else 0.0
