#!/usr/bin/env python3 -I
"""Build a clean test map from Need Boost (tower.udk): ground, sky, lights and spawn only, its Kismet emptied,
plus a short course with three checkpoints. Removed objects stay in the file as copy templates."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kismet  # noqa: E402
from ue3 import Additions, Package  # noqa: E402

KEEP_CLASSES = ("PlayerStart_TA", "DirectionalLight", "Pylon_Soccar_TA", "SceneCaptureCubeMapActor")
KEEP_MESHES = ("Ground", "skydome")
FLOOR = -101                     # top of the Ground mesh
PITCH_15 = round(15 / 360 * 65536)


def build(source, out):
    pkg = Package(source)
    actors = pkg.level_actors()
    def template(mesh):
        return next(a for a in actors if a["mesh"] == mesh)
    platform, pillar = template("models_Platform"), template("models_Pilar")
    zone = min((a for a in actors if a["cls"] == "TriggerVolume" and a["bounds"]),
               key=lambda a: abs(max(a["bounds"][3:6]) - 500))

    add = Additions(pkg)
    for a in actors:
        if a["cls"] not in KEEP_CLASSES and a["mesh"] not in KEEP_MESHES:
            add.remove(a["i"])
    add.clear_refs(kismet.main_sequence(pkg), "SequenceObjects")

    def place(template, loc, rot=(0, 0, 0), scale=(1, 1, 1)):
        add.duplicate(template["i"], values={"Location": ("<3f", list(loc)), "Rotation": ("<3i", list(rot)),
                                             "DrawScale3D": ("<3f", list(scale))})

    zone_half_height = zone["bounds"][5]
    ramp_rise = 2816 * 0.2588                                     # 2x platform length * sin(15 deg)
    deck = FLOOR + ramp_rise                                      # top of the raised platform
    place(platform, (4600, 0, FLOOR + ramp_rise / 2), rot=(PITCH_15, 0, 0), scale=(2, 1, 1))
    place(platform, (7368, 0, deck - 37), scale=(2, 2, 1))

    checkpoints = [(3000, FLOOR), (7300, deck), (12000, FLOOR)]
    locations = [(x, 0, floor + zone_half_height - 50) for x, floor in checkpoints]
    kismet.add_checkpoints(add, zone["i"], [{"Location": ("<3f", list(loc))} for loc in locations])
    for x, floor in checkpoints:                                  # a pillar each side marks the gate
        for y in (-750, 750):
            place(pillar, (x, y, floor + 316 * 1.5), scale=(1, 1, 1.5))
    add.save(out)
    return locations


if __name__ == "__main__":
    print(build(sys.argv[1], sys.argv[2]))
