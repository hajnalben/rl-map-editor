#!/usr/bin/env python3 -I
"""StaticMesh native data for UE3 v868 maps: read, write, collision tree, and sculpted terrain tiles."""
import math
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ue3 import Package  # noqa: E402

LEAF_TRIS = 5                 # most triangles per kDOP leaf
RAW_TRI = 372                 # FStaticMeshTriangle: corners, 3x8 UVs, colors, ids, 3x3 tangents, 2 flags
UNIT = 127                    # kDOP node bytes shrink a child by multiples of parent extent / 127


class Reader:
    def __init__(self, data, p):
        self.data, self.p = data, p

    def take(self, fmt):
        v = struct.unpack_from(fmt, self.data, self.p)
        self.p += struct.calcsize(fmt)
        return v

    def bulk(self):
        """Bulk-serialized array: element size, count, raw elements."""
        size, count = self.take("<ii")
        raw = bytes(self.data[self.p:self.p + size * count])
        self.p += size * count
        return size, count, raw


def bulk(size, raw):
    return struct.pack("<ii", size, len(raw) // size if size else 0) + raw


def read(pkg, i):
    """Every field of a StaticMesh export, enough to write it back byte for byte."""
    e = pkg.exports[i]
    for _ in pkg.properties(e):
        pass
    r = Reader(pkg.data, pkg.pos)
    m = dict(head=bytes(pkg.data[e["off"]:pkg.pos]))         # NetIndex + tagged properties
    m["bounds"] = r.take("<7f")
    m["body_setup"] = r.take("<i")[0]
    m["root"] = r.take("<6f")
    m["nodes"] = r.bulk()[2]
    m["kdop_tris"] = r.bulk()[2]
    m["version"] = r.take("<i")[0]
    m["pre_lod"] = r.take("<16s")[0]
    if r.take("<i")[0] != 1:
        raise ValueError(f"{e['name']}: only single-LOD meshes are supported")
    flags, count, size, _ = r.take("<Iiii")
    m["raw_flags"], m["raw"] = flags, bytes(pkg.data[r.p:r.p + size])
    r.p += size
    m["sections"] = []
    for _ in range(r.take("<i")[0]):
        fields = r.take("<9i")
        frags = [r.take("<ii") for _ in range(r.take("<i")[0])]
        m["sections"].append(dict(fields=fields, frags=frags, ps3=r.take("<B")[0]))
    m["vertex_size"], _ = r.take("<ii")
    m["positions"] = r.bulk()[2]
    m["uv_channels"], m["uv_stride"], _, m["uv_full"] = r.take("<4i")
    m["uvs"] = r.bulk()[2]
    m["color_stride"], colors = r.take("<ii")
    m["colors"] = r.bulk()[2] if colors else None
    m["num_verts"] = r.take("<i")[0]
    m["indices"], m["wire"], m["adjacency"] = r.bulk()[2], r.bulk()[2], r.bulk()[2]
    m["tail"] = bytes(pkg.data[r.p:e["off"] + e["size"]])     # thumbnail, lighting guid, streaming factors...
    return m


def write(m):
    """(object bytes, offset of the raw-triangle bulk header, whose file offset field needs patching)."""
    out = bytearray(m["head"])
    out += struct.pack("<7fi6f", *m["bounds"], m["body_setup"], *m["root"])
    out += bulk(6, m["nodes"]) + bulk(8, m["kdop_tris"])
    out += struct.pack("<i", m["version"]) + m["pre_lod"] + struct.pack("<i", 1)
    raw_at = len(out)
    out += struct.pack("<Iiii", m["raw_flags"], len(m["raw"]) // RAW_TRI, len(m["raw"]), 0) + m["raw"]
    out += struct.pack("<i", len(m["sections"]))
    for s in m["sections"]:
        out += struct.pack("<9ii", *s["fields"], len(s["frags"])) + b"".join(struct.pack("<ii", *f) for f in s["frags"])
        out += struct.pack("<B", s["ps3"])
    verts = len(m["positions"]) // 12
    out += struct.pack("<ii", m["vertex_size"], verts) + bulk(12, m["positions"])
    out += struct.pack("<4i", m["uv_channels"], m["uv_stride"], verts, m["uv_full"]) + bulk(m["uv_stride"], m["uvs"])
    colors = m["colors"]
    out += struct.pack("<ii", m["color_stride"], len(colors) // m["color_stride"] if colors else 0)
    if colors:
        out += bulk(m["color_stride"], colors)
    out += struct.pack("<i", m["num_verts"])
    out += bulk(2, m["indices"]) + bulk(2, m["wire"]) + bulk(2, m["adjacency"])
    return bytes(out + m["tail"]), raw_at


def leaf_count(n):
    leaves = 1
    while leaves * LEAF_TRIS < n:
        leaves *= 2
    return leaves


def spans(n, leaves):
    """Triangle range of every heap node (children 2h+1, 2h+2); the left child takes the larger half."""
    out = {}

    def split(h, a, b, k):
        out[h] = (a, b)
        if k > 1:
            mid = a + (b - a + 1) // 2
            split(2 * h + 1, a, mid, k // 2)
            split(2 * h + 2, mid, b, k // 2)
    split(0, 0, n, leaves)
    return out


def box(points):
    return [min(p[k] for p in points) for k in range(3)], [max(p[k] for p in points) for k in range(3)]


def kdop(positions, tris):
    """UE3 compact kDOP tree: (root bound, node bytes, triangles reordered into leaf order).

    Leaves are implicit (a complete binary tree over the triangle list); each internal node stores one byte per
    axis side saying which child shrinks there and by how much: 128+q shrinks the first child, 127-q the second.
    """
    leaves = leaf_count(len(tris))
    centers = [[sum(positions[v][k] for v in t[:3]) / 3 for k in range(3)] for t in tris]
    order = []

    def arrange(ids, k):
        if k == 1:
            order.extend(ids)
            return
        lo, hi = box([centers[t] for t in ids])
        axis = max(range(3), key=lambda a: hi[a] - lo[a])
        ids = sorted(ids, key=lambda t: centers[t][axis])
        mid = (len(ids) + 1) // 2
        arrange(ids[:mid], k // 2)
        arrange(ids[mid:], k // 2)
    arrange(list(range(len(tris))), leaves)
    tris = [tris[t] for t in order]
    rng = spans(len(tris), leaves)
    exact = {h: box([positions[v] for t in tris[a:b] for v in t[:3]]) for h, (a, b) in rng.items()}
    root = exact[0]
    decoded, nodes = {0: root}, bytearray()

    def quant(s):
        return max(0, min(127, math.floor(s * UNIT) - 1))           # always shrink a little less than possible

    for h in range(leaves - 1):
        (pmin, pmax), (c0, c1) = decoded[h], (exact[2 * h + 1], exact[2 * h + 2])
        kids = [[list(pmin), list(pmax)], [list(pmin), list(pmax)]]
        mins, maxs = [], []
        for k in range(3):
            ext = pmax[k] - pmin[k]
            for side, out in ((0, mins), (1, maxs)):
                if ext <= 0:
                    out.append(128)
                    continue
                s = [(c[0][k] - pmin[k]) / ext if side == 0 else (pmax[k] - c[1][k]) / ext for c in (c0, c1)]
                q0, q1 = quant(s[0]), quant(s[1])
                child, q = (0, q0) if q0 >= q1 else (1, q1)
                out.append(128 + q if child == 0 else 127 - q)
                shift = q * ext / UNIT
                kids[child][side][k] += shift if side == 0 else -shift
        nodes += bytes(mins + maxs)
        decoded[2 * h + 1], decoded[2 * h + 2] = kids
    nodes += bytes(6)                                              # the tree always has one spare node
    return root, bytes(nodes), tris


def packed(v, w=1.0):
    """FPackedNormal: each component mapped from [-1, 1] to a byte."""
    return bytes(max(0, min(255, round((c + 1) * 127.5))) for c in (*v, w))


def normalize(v):
    n = math.sqrt(sum(c * c for c in v)) or 1.0
    return [c / n for c in v]


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def geometry_mesh(template, positions, uv0, uv1, normals, tangents, tris):
    """A StaticMesh record (as `read` returns) for new geometry, keeping the template's properties and tail.
    `tris` are vertex index triples in Unreal's winding (corners clockwise seen from the front)."""
    m = dict(template)
    lo, hi = box(positions)
    origin = [(lo[k] + hi[k]) / 2 for k in range(3)]
    extent = [(hi[k] - lo[k]) / 2 for k in range(3)]
    radius = max(math.dist(p, origin) for p in positions)
    root, nodes, ordered = kdop(positions, [(*t, 0) for t in tris])
    m.update(bounds=(*origin, *extent, radius), body_setup=0, root=(*root[0], *root[1]), nodes=nodes,
             kdop_tris=b"".join(struct.pack("<4H", *t) for t in ordered))
    raw = bytearray()
    for t in tris:
        corners = b"".join(struct.pack("<3f", *positions[v]) for v in t)
        uvs = b"".join(struct.pack("<4f", *uv0[v], *uv1[v]) + bytes(48) for v in t)
        raw += corners + uvs + b"\xff" * 12 + struct.pack("<4i", 0, 0, 1, 2) + bytes(116)
    m["raw"], m["raw_flags"] = bytes(raw), 0
    sec = template["sections"][0]
    m["sections"] = [dict(fields=(sec["fields"][0], 1, 1, 1, 0, len(tris), 0, len(positions) - 1, 0),
                          frags=[(0, len(tris))], ps3=0)]
    m["vertex_size"] = 12
    m["positions"] = b"".join(struct.pack("<3f", *p) for p in positions)
    m.update(uv_channels=2, uv_stride=16, uv_full=0, color_stride=0, colors=None, num_verts=len(positions))
    items = bytearray()
    for v in range(len(positions)):
        tx, ty = tangents[v]
        sign = 1.0 if sum(a * b for a, b in zip(cross(normals[v], tx), ty)) > 0 else -1.0
        items += packed(tx, 0) + packed(normals[v], sign) + struct.pack("<4e", *uv0[v], *uv1[v])
    m["uvs"] = bytes(items)
    m["indices"] = struct.pack(f"<{3 * len(tris)}H", *(v for t in tris for v in t))
    edges = {}
    for a, b, c in tris:
        for e in ((a, b), (b, c), (c, a)):
            edges.setdefault(tuple(sorted(e)), e)
    m["wire"] = struct.pack(f"<{2 * len(edges)}H", *(v for e in edges.values() for v in e))
    m["adjacency"] = b"".join(struct.pack("<12H", a, b, c, a, b, b, c, c, a, a, b, c) for a, b, c in tris)
    m["tail"] = template["tail"][:28] + os.urandom(16) + template["tail"][44:]   # fresh lighting guid
    return m


TILE = 32                     # terrain tiles are TILE x TILE grid cells
CELL = 100.0                  # terrain grid spacing
SPAN = TILE * CELL
SINK = 30.0                   # flat terrain sits this far under the floor, out of sight


def tile_geometry(apron, tx, ty):
    """(positions, uv0, uv1, normals, tangents, tris) of terrain tile (tx, ty), relative to its -X,-Y corner.
    `apron` holds the heights of the tile's (TILE + 1)^2 vertices plus a one-vertex border from the neighbouring
    tiles, (TILE + 3)^2 values in rows of increasing Y, so normals agree across tile edges."""
    w = TILE + 3

    def h(i, j):
        return apron[(j + 1) * w + i + 1]
    u0, v0 = tx * SPAN / 1000 % 1, ty * SPAN / 1000 % 1         # texture repeats every 1000 units, seamless across tiles
    positions, uv0, uv1, normals, tangents = [], [], [], [], []
    for j in range(TILE + 1):
        for i in range(TILE + 1):
            dx = (h(i + 1, j) - h(i - 1, j)) / (2 * CELL)
            dy = (h(i, j + 1) - h(i, j - 1)) / (2 * CELL)
            positions.append((i * CELL, j * CELL, h(i, j)))
            uv0.append((u0 + i * CELL / 1000, v0 + j * CELL / 1000))
            uv1.append((i / TILE, j / TILE))
            normals.append(normalize([-dx, -dy, 1]))
            tangents.append((normalize([1, 0, dx]), normalize([0, 1, dy])))
    tris = []
    for j in range(TILE):
        for i in range(TILE):
            a, b = j * (TILE + 1) + i, j * (TILE + 1) + i + 1
            c, d = a + TILE + 1, b + TILE + 1
            tris += [(a, d, b), (a, c, d)]                         # clockwise seen from above
    return positions, uv0, uv1, normals, tangents, tris


def grid_heights(positions):
    """Vertex heights when packed `positions` lie on a terrain tile's grid (as tile_geometry lays it out), else None."""
    pts = list(struct.iter_unpack("<3f", positions))
    if len(pts) != (TILE + 1) ** 2:
        return None
    for k, (x, y, _) in enumerate(pts):
        if abs(x - k % (TILE + 1) * CELL) > 0.01 or abs(y - k // (TILE + 1) * CELL) > 0.01:
            return None
    return [z for _, _, z in pts]


def mesh_component(pkg, i):
    """Export index of a StaticMeshActor's own mesh component, or None."""
    e = pkg.exports[i]
    comp = pkg.get(e, "StaticMeshComponent", "<i") if pkg.class_of(e) == "StaticMeshActor" else None
    return comp[0] - 1 if comp and comp[0] > 0 and pkg.exports[comp[0] - 1]["outer"] == i + 1 else None


def mesh_actor_template(pkg):
    """(actor, its mesh component, that component's mesh) to copy for new mesh actors: a placed StaticMeshActor
    whose component blocks rigid bodies (the car collides with it) and whose mesh lives in the map."""
    for i in sorted(pkg.level_list()):
        comp = mesh_component(pkg, i)
        if comp is None:
            continue
        c = pkg.exports[comp]
        mesh, block = pkg.get(c, "StaticMesh", "<i"), pkg.prop(c, "BlockRigidBody")
        if mesh and mesh[0] > 0 and block and pkg.data[block[2]]:
            return i, comp, mesh[0] - 1
    raise ValueError("this map has no solid mesh actor to copy")


def terrain(pkg, actors):
    """The map's terrain: {base, material, tiles: {(tx, ty): (actor index, heights)}}; base is None without one."""
    found = dict(base=None, material=None, tiles={})
    for a in actors:
        if not (a["mesh"] or "").startswith("Terrain") or a["meshIndex"] is None or any(a["rot"]):
            continue
        heights = grid_heights(read(pkg, a["meshIndex"])["positions"])
        if heights is None:
            continue
        found["tiles"][(round(a["loc"][0] / SPAN), round(a["loc"][1] / SPAN))] = (a["i"], heights)
        found["base"] = a["loc"][2]
        p = pkg.prop(pkg.exports[mesh_component(pkg, a["i"])], "Materials")
        if found["material"] is None and p:
            count, first = struct.unpack_from("<ii", pkg.data, p[2])
            found["material"] = first if count else None
    return found


def save_terrain(add, base, material, tiles):
    """Write sculpted terrain tiles ([{tx, ty, heights}], heights with the one-vertex border tile_geometry takes):
    new tiles become mesh actors, placed ones get the new shape, flat ones leave the level.
    Returns (tiles added, tiles removed)."""
    pkg = add.pkg
    placed = {k: i for k, (i, _) in terrain(pkg, pkg.level_actors())["tiles"].items()}
    actor, comp, template_mesh = mesh_actor_template(pkg)
    template, mesh_export = read(pkg, template_mesh), pkg.exports[template_mesh]
    # the car collides with the triangles themselves, never a simplified hull
    per_poly = {n: add.tag(n, "BoolProperty", b"\0") for n in ("UseSimpleRigidBodyCollision", "UseSimpleBoxCollision", "UseSimpleLineCollision")}
    template["head"] = bytes(add.with_props(mesh_export, pkg.object_bytes(template_mesh), per_poly, tail=b""))
    w, added, removed = TILE + 3, 0, 0
    for t in tiles:
        key, heights = (int(t["tx"]), int(t["ty"])), [float(h) for h in t["heights"]]
        if len(heights) != w * w or not all(math.isfinite(h) for h in heights):
            raise ValueError(f"terrain tile {key} needs {w * w} heights")
        if all(heights[(j + 1) * w + i + 1] <= 0 for j in range(TILE + 1) for i in range(TILE + 1)):
            if key in placed:
                add.remove(placed[key])
                removed += 1
            continue
        blob, raw_at = write(geometry_mesh(template, *tile_geometry(heights, *key)))
        mesh = add.add_object(mesh_export["cls"], mesh_export["outer"], "Terrain", blob,
                              flags=mesh_export["flags"], bulk_at=[raw_at]) + 1
        tags = {"StaticMesh": add.tag("StaticMesh", "ObjectProperty", struct.pack("<i", mesh))}
        if key in placed:
            add.set_props(mesh_component(pkg, placed[key]), tags)
            continue
        tags["Materials"] = add.tag("Materials", "ArrayProperty", struct.pack("<ii", 1, int(material)))
        values = {"Location": ("<3f", [key[0] * SPAN, key[1] * SPAN, base]), "Rotation": ("<3i", [0, 0, 0]),
                  "DrawScale3D": ("<3f", [1, 1, 1]), "DrawScale": ("<f", [1])}
        # no baked lighting (LODData): the engine lights the new mesh dynamically
        add.duplicate(actor, values=values, kid_props={comp: (tags, struct.pack("<i", 0))})
        added += 1
    return added, removed


def roundtrip(path):
    """Write every StaticMesh of a map back and compare with the original bytes."""
    pkg = Package(path)
    meshes = [i for i, e in enumerate(pkg.exports) if pkg.class_of(e) == "StaticMesh"]
    for i in meshes:
        e = pkg.exports[i]
        blob, raw_at = write(read(pkg, i))
        blob = bytearray(blob)
        struct.pack_into("<i", blob, raw_at + 12, e["off"] + raw_at + 16)
        assert blob == pkg.object_bytes(i), e["name"]
    return len(meshes)


def selfcheck():
    w = TILE + 3
    apron = [max(0.0, 900 - 70 * math.dist((i, j), (w / 3, w / 2))) for j in range(w) for i in range(w)]
    geo = tile_geometry(apron, -3, 2)
    positions, tris = geo[0], geo[-1]
    back = grid_heights(b"".join(struct.pack("<3f", *p) for p in positions))
    assert back and all(abs(b - p[2]) < 1e-3 for b, p in zip(back, positions))
    root, nodes, ordered = kdop(positions, [(*t, 0) for t in tris])
    leaves = leaf_count(len(ordered))
    assert len(nodes) == 6 * leaves and nodes[-6:] == bytes(6)
    # decode the tree the way the engine does and check every leaf box holds its triangles
    boxes = {0: (list(root[0]), list(root[1]))}
    for h in range(leaves - 1):
        pmin, pmax = boxes[h]
        b = nodes[6 * h:6 * h + 6]
        kids = [[list(pmin), list(pmax)], [list(pmin), list(pmax)]]
        for k in range(3):
            u = (pmax[k] - pmin[k]) / UNIT
            lo, hi = b[k], b[3 + k]
            kids[0 if lo >= 128 else 1][0][k] += (lo - 128 if lo >= 128 else 127 - lo) * u
            kids[0 if hi >= 128 else 1][1][k] -= (hi - 128 if hi >= 128 else 127 - hi) * u
        boxes[2 * h + 1], boxes[2 * h + 2] = kids
    for h, (a, b) in spans(len(ordered), leaves).items():
        lo, hi = boxes[h]
        for t in ordered[a:b]:
            for v in t[:3]:
                assert all(lo[k] - 1e-3 <= positions[v][k] <= hi[k] + 1e-3 for k in range(3)), (h, t)
    assert all(cross([positions[b][k] - positions[a][k] for k in range(3)],
                     [positions[c][k] - positions[a][k] for k in range(3)])[2] < 0 for a, b, c in tris)


if __name__ == "__main__":
    selfcheck()
    print("terrain tile: kDOP tree decodes around every triangle, heights read back from the grid")
    for path in sys.argv[1:]:
        print(f"{path}: {roundtrip(path)} meshes written back byte for byte")
