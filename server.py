#!/usr/bin/env python3 -I
"""Local backend for the map editor: serves the page, reads maps, saves edited copies."""
import json
import os
import re
import struct
import subprocess
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

EDITOR = os.path.dirname(os.path.abspath(__file__))
MAPS = os.path.expanduser("~/Games/Heroic/workshop-maps")      # the .udk maps and the rlmap loader
GAME_LOG = os.path.expanduser("~/Documents/My Games/Rocket League/TAGame/Logs/Launch.log")
sys.path.insert(0, EDITOR)
import kismet  # noqa: E402
import mesh  # noqa: E402
from ue3 import Additions, Package, edit_values  # noqa: E402


def map_path(name):
    name = os.path.basename(name)
    if not re.fullmatch(r"[\w .()+-]+\.(udk|upk)", name, re.IGNORECASE):
        raise ValueError(f"bad map name: {name}")
    return os.path.join(MAPS, name)


def game_on_underpass():
    if subprocess.run(["pgrep", "-f", "RocketLeague.exe"], capture_output=True).returncode:
        return False
    try:
        with open(GAME_LOG, "rb") as f:
            loads = [line for line in f.read().splitlines() if b"LoadMap: " in line]
    except OSError:
        return False
    return bool(loads) and b"Labs_Underpass_P" in loads[-1]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=EDITOR, **kwargs)

    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")          # editor updates show up on a plain reload
        super().end_headers()

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        try:
            if url.path == "/api/maps":
                return self.send_json(sorted(f for f in os.listdir(MAPS) if re.search(r"\.(udk|upk)$", f, re.I)))
            if url.path == "/api/map":
                pkg = Package(map_path(parse_qs(url.query)["name"][0]))
                actors = pkg.level_actors()
                ground = mesh.terrain(pkg, actors)
                tile_actors = {i for i, _ in ground["tiles"].values()}
                actors = [a for a in actors if a["i"] not in tile_actors]     # the editor draws the terrain itself
                terrain = dict(tile=mesh.TILE, cell=mesh.CELL, sink=mesh.SINK, base=ground["base"], material=ground["material"],
                               tiles=[dict(tx=tx, ty=ty, heights=h) for (tx, ty), (_, h) in ground["tiles"].items()])
                return self.send_json(dict(actors=actors, palette=pkg.palette(actors), zone=pkg.zone_template(), terrain=terrain,
                                           checkpoints=kismet.checkpoint_zones(pkg), materials=pkg.materials()))
            if url.path == "/api/meshes":
                q = parse_qs(url.query)
                pkg = Package(map_path(q["name"][0]))
                parts = []
                for i in sorted({int(i) for i in q["i"][0].split(",") if i}):
                    try:
                        tris = pkg.mesh_triangles(i)
                    except (ValueError, struct.error):
                        tris = b""
                    parts.append(struct.pack("<ii", i, len(tris) // 4) + tris)
                return self.send_bytes(b"".join(parts))
        except (ValueError, KeyError, OSError) as e:
            return self.send_json(dict(error=str(e)), 400)
        return super().do_GET()

    def send_bytes(self, body):
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        url = urlparse(self.path)
        try:
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if url.path == "/api/save":
                src, out = map_path(body["source"]), map_path(body["out"])
                if out == src:
                    raise ValueError("save under a new name; the source map stays untouched")
                pkg = Package(src)
                before = len(pkg.level_list())
                edits, duplicates, removes = body.get("edits", []), body.get("duplicates", []), body.get("removes", [])
                checkpoints, terrain = body.get("checkpoints", []), body.get("terrain")
                tiles_added = tiles_removed = 0
                missing = pkg.apply(edits)
                if missing or duplicates or removes or checkpoints or terrain:
                    add = Additions(pkg)
                    for i, values in missing.items():
                        add.set_values(i, values)
                    for dup in duplicates:
                        add.duplicate(dup["src"], values=edit_values(dup))
                    for i in removes:
                        add.remove(i)
                    if checkpoints:
                        zone = pkg.zone_template()
                        if not zone:
                            raise ValueError("this map has no trigger zone to copy for checkpoints")
                        kismet.add_checkpoints(add, zone["i"], [edit_values(c) for c in checkpoints])
                    if terrain:
                        tiles_added, tiles_removed = mesh.save_terrain(add, float(terrain["base"]), terrain["material"],
                                                                       terrain["tiles"])
                    add.save(out)
                else:
                    pkg.save(out)
                saved = Package(out)
                check = {a["i"]: a for a in saved.level_actors()}
                expected = before + len(duplicates) + len(checkpoints) + tiles_added - len(removes) - tiles_removed
                assert len(saved.level_list()) == expected, "level actor count"
                if terrain:
                    tiles = mesh.terrain(saved, list(check.values()))["tiles"]
                    w = mesh.TILE + 3
                    for t in terrain["tiles"]:
                        inner = [t["heights"][(j + 1) * w + i + 1] for j in range(w - 2) for i in range(w - 2)]
                        got = tiles.get((t["tx"], t["ty"]))
                        assert (got is None) == (max(inner) <= 0), f"terrain tile {t['tx']},{t['ty']} placement"
                        assert got is None or all(abs(a - b) < 0.01 for a, b in zip(got[1], inner)), "terrain tile shape"
                for edit in edits:
                    want = edit_values(edit)
                    for key, prop in (("loc", "Location"), ("rot", "Rotation"), ("scale3d", "DrawScale3D")):
                        if prop in want and edit["i"] in check:
                            assert all(abs(a - b) < 0.01 for a, b in zip(check[edit["i"]][key], want[prop][1])), (edit, key)
                return self.send_json(dict(saved=os.path.basename(out)))
            if url.path == "/api/play":
                if game_on_underpass():
                    return self.send_json(dict(error="You're on Underpass in the game. Go back to the main menu first."), 409)
                name = os.path.basename(map_path(body["name"]))
                run = subprocess.run([os.path.join(MAPS, "rlmap"), name], capture_output=True, text=True)
                return self.send_json(dict(output=run.stdout.strip(), error=run.stderr.strip() or None),
                                      200 if run.returncode == 0 else 500)
        except (ValueError, KeyError, OSError, AssertionError) as e:
            return self.send_json(dict(error=str(e)), 400)
        self.send_json(dict(error="unknown endpoint"), 404)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    print(f"Map editor on http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
