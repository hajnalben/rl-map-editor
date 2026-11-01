#!/usr/bin/env python3 -I
"""Read and patch Rocket League workshop maps (UDK 2015 / UE3 package version 868)."""
import math
import struct
import sys
from collections import Counter


class Package:
    def __init__(self, path):
        self.path = path
        with open(path, "rb") as f:
            self.data = bytearray(f.read())
        self.pos = 0
        tag, self.ver, self.lic, _ = self.unpack("<IHHi")
        if tag != 0x9E2A83C1 or self.ver != 868:
            raise ValueError(f"{path}: not a UE3 v868 package")
        self.fstring()
        self.summary_at = self.pos               # PackageFlags, then name/export/import counts+offsets, DependsOffset
        self.flags, ncount, noff, ecount, eoff, icount, ioff = self.unpack("<I6i")
        self.depends_off = self.unpack("<i")[0]
        self.unpack("<3i")                       # import/export guids
        self.unpack("<i")                        # thumbnail table
        self.pos += 16                           # package guid
        generations = self.unpack("<i")[0]
        self.last_generation_at = self.pos + 12 * (generations - 1)   # ExportCount, NameCount, NetObjectCount
        self.pos += 12 * generations
        self.unpack("<ii")                       # engine, cooker version
        self.compression, chunks = self.unpack("<Ii")
        if self.compression or chunks:
            raise ValueError(f"{path}: compressed packages are not supported")

        self.pos = noff
        self.names = []
        for _ in range(ncount):
            self.names.append(self.fstring())
            self.pos += 8                        # name flags
        self.name_table = bytes(self.data[noff:self.pos])
        self.pos = ioff
        self.imports = []
        for _ in range(icount):
            self.fname()                         # class package
            cls = self.fname()
            outer = self.unpack("<i")[0]
            self.imports.append(dict(cls=cls, outer=outer, name=self.fname()))
        self.import_table = bytes(self.data[ioff:self.pos])
        self.pos = eoff
        self.exports = []
        for _ in range(ecount):
            start = self.pos
            cls, sup, outer = self.unpack("<3i")
            name_raw = struct.unpack_from("<ii", self.data, self.pos)
            name = self.fname()
            arch, oflags, size, off, eflags, nnet = self.unpack("<iQiiIi")
            self.pos += 4 * nnet + 16 + 4
            self.exports.append(dict(cls=cls, outer=outer, name=name, name_raw=name_raw, flags=oflags,
                                     size=size, off=off, entry=bytes(self.data[start:self.pos])))

    def unpack(self, fmt):
        values = struct.unpack_from(fmt, self.data, self.pos)
        self.pos += struct.calcsize(fmt)
        return values

    def fstring(self):
        n = self.unpack("<i")[0]
        if n >= 0:
            s = self.data[self.pos:self.pos + n].decode("latin-1").rstrip("\0")
            self.pos += n
        else:
            s = self.data[self.pos:self.pos - 2 * n].decode("utf-16-le").rstrip("\0")
            self.pos -= 2 * n
        return s

    def fname(self):
        index, number = self.unpack("<ii")
        base = self.names[index]
        return f"{base}_{number - 1}" if number else base

    def ref(self, index):
        if index > 0:
            return self.exports[index - 1]["name"]
        if index < 0:
            return self.imports[-index - 1]["name"]
        return None

    def class_of(self, export):
        return self.ref(export["cls"]) or "Class"

    def net_index_at(self, export):
        """File offset of an object's NetIndex, which precedes its tagged properties."""
        p = export["off"]
        if export["flags"] & 0x0200000000000000:  # RF_HasStack: actors carry a script state frame
            node = struct.unpack_from("<i", self.data, p)[0]
            p += 4 + 4 + 8 + 2 + (4 if node else 0)   # node, state node, probe mask, latent action, code offset
        # ponytail: name-based component check; real UE3 asks the class hierarchy
        if self.class_of(export).endswith("Component"):
            p += 4                               # template owner class
        return p

    def properties(self, export):
        """Yield (name, type, struct_name, value_offset, size) for an export's tagged properties."""
        self.pos = self.net_index_at(export) + 4
        end = export["off"] + export["size"]
        while self.pos < end:
            name = self.fname()
            if name == "None":
                return
            ptype = self.fname()
            size, _ = self.unpack("<ii")
            struct_name = None
            if ptype == "StructProperty":
                struct_name = self.fname()
            elif ptype == "ByteProperty":
                self.fname()
            elif ptype == "BoolProperty":
                size = 1
            yield name, ptype, struct_name, self.pos, size
            self.pos += size

    def prop(self, export, wanted):
        for name, ptype, struct_name, off, size in self.properties(export):
            if name == wanted:
                return ptype, struct_name, off, size
        return None

    def get(self, export, name, fmt):
        p = self.prop(export, name)
        return struct.unpack_from(fmt, self.data, p[2]) if p else None

    def set(self, export, name, fmt, *values):
        """Overwrite an existing property in place; sizes never change, so offsets stay valid."""
        p = self.prop(export, name)
        if not p or p[3] != struct.calcsize(fmt):
            raise KeyError(f"{export['name']} has no {name} of size {struct.calcsize(fmt)}")
        struct.pack_into(fmt, self.data, p[2], *values)

    def mesh_of(self, actor):
        comp = self.get(actor, "StaticMeshComponent", "<i")
        if not comp or comp[0] <= 0:
            return None
        mesh = self.get(self.exports[comp[0] - 1], "StaticMesh", "<i")
        return self.ref(mesh[0]) if mesh else None

    def save(self, path):
        with open(path, "wb") as f:
            f.write(self.data)

    def native_bounds(self, export):
        """Origin + extent of the FBoxSphereBounds that StaticMesh and Model store right after their properties."""
        for _ in self.properties(export):
            pass
        return struct.unpack_from("<6f", self.data, self.pos)

    def shape(self, actor, cache):
        """(export index, local bounds) of an actor's mesh or brush; (None, None) when it lives in another package."""
        comp = self.get(actor, "StaticMeshComponent", "<i") or self.get(actor, "CollisionComponent", "<i")
        if not comp or comp[0] <= 0:
            return None, None
        comp = self.exports[comp[0] - 1]
        shape = self.get(comp, "StaticMesh", "<i") or self.get(comp, "Brush", "<i")
        if not shape or shape[0] <= 0:
            return None, None
        if shape[0] not in cache:
            cache[shape[0]] = self.native_bounds(self.exports[shape[0] - 1])
        return shape[0] - 1, cache[shape[0]]

    def mesh_triangles(self, index):
        """Raw triangle corners of a StaticMesh as packed float32 (9 per triangle, Unreal axes)."""
        export = self.exports[index]
        if self.class_of(export) != "StaticMesh":
            raise ValueError(f"{export['name']} is not a StaticMesh")
        for _ in self.properties(export):
            pass
        p = self.pos + 28 + 4 + 24                    # bounds, body setup, kDOP root bound
        for _ in range(2):                            # kDOP nodes and triangles (bulk-serialized arrays)
            elem, count = struct.unpack_from("<ii", self.data, p)
            p += 8 + elem * count
        # ponytail: finds the first inline bulk block near the kDOP end (24 bytes on all maps seen); a full
        # FStaticMeshRenderData parser would remove the window scan
        for q in range(p, p + 64):
            flags, count, size, offset = struct.unpack_from("<Iiii", self.data, q)
            if offset == q + 16 and count > 0 and size % count == 0 and size // count >= 36:
                stride = size // count
                return b"".join(self.data[q + 16 + t * stride: q + 16 + t * stride + 36] for t in range(count))
        raise ValueError(f"no raw triangle block in {export['name']}")

    def level_list(self):
        """Export indices of the actors the level spawns (its TTransArray: owner ref, count, refs)."""
        level = self.exports[self.level_index()]
        for _ in self.properties(level):
            pass
        count = struct.unpack_from("<i", self.data, self.pos + 4)[0]
        return [r - 1 for r in struct.unpack_from(f"<{count}i", self.data, self.pos + 8) if r > 0]

    def level_actors(self):
        cache, actors = {}, []
        for i in sorted(self.level_list()):
            e = self.exports[i]
            if self.class_of(e) in ("WorldInfo", "ReachSpec"):
                continue
            loc = self.get(e, "Location", "<3f")
            rot = self.get(e, "Rotation", "<3i")
            scale3d = self.get(e, "DrawScale3D", "<3f")
            scale = self.get(e, "DrawScale", "<f")
            shape, bounds = self.shape(e, cache)
            actors.append(dict(
                i=i, name=e["name"], cls=self.class_of(e), mesh=self.mesh_of(e),
                loc=loc or (0, 0, 0), rot=rot or (0, 0, 0), scale3d=scale3d or (1, 1, 1),
                scale=scale[0] if scale else 1, bounds=bounds,
                meshIndex=shape if shape is not None and self.class_of(self.exports[shape]) == "StaticMesh" else None))
        return actors

    def zone_template(self):
        """A trigger zone to copy for checkpoints (also ones taken out of the level): about 1000 units wide."""
        best, cache = None, {}
        for i, e in enumerate(self.exports):
            if self.class_of(e) != "TriggerVolume":
                continue
            _, bounds = self.shape(e, cache)
            if bounds and (best is None or abs(max(bounds[3:6]) - 500) < abs(max(best["bounds"][3:6]) - 500)):
                best = dict(i=i, bounds=bounds)
        return best

    def palette(self, actors=None):
        """One placeable entry per mesh with an existing actor to copy. Copying a user of the same mesh keeps
        its baked per-vertex lighting consistent."""
        best = {}
        for a in actors or self.level_actors():
            if a["meshIndex"] is None:
                continue
            entry = best.setdefault(a["meshIndex"], dict(mesh=a["mesh"], meshIndex=a["meshIndex"], count=0, template=a["i"]))
            entry["count"] += 1
        return sorted(best.values(), key=lambda e: e["mesh"].lower())

    def materials(self):
        """Materials that the map's mesh components use, most used first: [{ref, name}]."""
        used = Counter()
        for e in self.exports:
            p = self.prop(e, "Materials") if self.class_of(e) == "StaticMeshComponent" else None
            if p:
                n = struct.unpack_from("<i", self.data, p[2])[0]
                used.update(r for r in struct.unpack_from(f"<{n}i", self.data, p[2] + 4) if r)
        return [dict(ref=r, name=self.ref(r)) for r, _ in used.most_common()]

    def apply(self, edits):
        """Apply [{i, loc?, rot?, scale3d?, scale?}] in place; returns {export index: values} for the properties
        an object doesn't store yet (Additions.set_values inserts those)."""
        missing = {}
        for edit in edits:
            export = self.exports[edit["i"]]
            for name, (fmt, value) in edit_values(edit).items():
                try:
                    self.set(export, name, fmt, *value)
                except KeyError:
                    missing.setdefault(edit["i"], {})[name] = (fmt, value)
        return missing

    def object_bytes(self, i):
        e = self.exports[i]
        return self.data[e["off"]:e["off"] + e["size"]]

    def level_index(self):
        return next(i for i, e in enumerate(self.exports) if self.class_of(e) == "Level")

    def depends_blob(self):
        p = self.depends_off
        for _ in self.exports:
            p += 4 + 4 * struct.unpack_from("<i", self.data, p)[0]
        return bytes(self.data[self.depends_off:p])


FIELDS = dict(loc=("Location", "<3f"), rot=("Rotation", "<3i"), scale3d=("DrawScale3D", "<3f"), scale=("DrawScale", "<f"))
STRUCTS = dict(Location="Vector", Rotation="Rotator", DrawScale3D="Vector")


def edit_values(edit):
    """{property: (fmt, values)} for the transform keys present in an editor edit."""
    values = {}
    for key, (name, fmt) in FIELDS.items():
        if key in edit:
            v = edit[key] if isinstance(edit[key], (list, tuple)) else [edit[key]]
            values[name] = (fmt, [round(x) for x in v] if "i" in fmt else list(v))
    return values


class Additions:
    """New and replaced objects, written after everything else on save.

    Existing bytes never move, so the absolute offsets stored inside meshes and textures stay valid; only the
    export and depends tables, the level's actor list and the new objects are appended at the end of the file.
    """

    def __init__(self, pkg):
        self.pkg = pkg
        self.replaced = {}                       # export index -> new object bytes
        self.added = []                          # (export table entry, object bytes)
        self.next_number = {}                    # name index -> next free FName number
        self.new_names = []
        self.new_imports = []                    # raw import table entries
        self.bulk_at = {}                        # added object position -> inline bulk headers that store a file offset

    def name(self, text):
        """(name index, number) for an FName, adding the base string to the name table when missing."""
        base, number = text, 0
        head, _, tail = text.rpartition("_")
        if head and tail.isdigit() and not tail.startswith("0") and text not in self.pkg.names:
            base, number = head, int(tail) + 1
        names = self.pkg.names + self.new_names
        if base not in names:
            self.new_names.append(base)
            names.append(base)
        return names.index(base), number

    def fname(self, text):
        return struct.pack("<ii", *self.name(text))

    def find_import(self, name, cls):
        for k, imp in enumerate(self.pkg.imports):          # Unreal names are case-insensitive ("tagame")
            if imp["name"].lower() == name.lower() and imp["cls"] == cls:
                return -(k + 1)
        return None

    def class_ref(self, class_name, package):
        """Object reference to a script class, importing it (and its package) when the map never used it."""
        ref = self.find_import(class_name, "Class")
        if ref is None:
            outer = self.find_import(package, "Package")
            if outer is None:
                outer = self._add_import("Core", "Package", 0, package)
            ref = self._add_import("Core", "Class", outer, class_name)
        return ref

    def _add_import(self, class_package, class_name, outer, name):
        self.new_imports.append(self.fname(class_package) + self.fname(class_name) + struct.pack("<i", outer) + self.fname(name))
        return -(len(self.pkg.imports) + len(self.new_imports))

    def add_object(self, class_ref, outer_ref, base_name, blob, flags=0x0007000100000000, bulk_at=()):
        """Append a brand-new plain object (no state frame or component header, e.g. a Kismet node) whose
        `blob` starts with a NetIndex placeholder; returns its export index. `bulk_at` lists offsets of inline
        bulk data headers in `blob`, whose absolute file offset gets filled in on save."""
        index, _ = self.name(base_name)
        entry = struct.pack("<3i", class_ref, 0, outer_ref) + struct.pack("<ii", index, self._unique_number(index)) + \
            struct.pack("<iQiiIi", 0, flags, 0, 0, 0, 0) + bytes(16) + struct.pack("<I", 0)
        new = len(self.pkg.exports) + len(self.added)
        blob = bytearray(blob)
        struct.pack_into("<i", blob, 0, new)
        if bulk_at:
            self.bulk_at[len(self.added)] = list(bulk_at)
        self.added.append((bytearray(entry), blob))
        return new

    def tag(self, name, ptype, body, struct_name=None):
        """One tagged property: name, type, size, array index, struct name, value."""
        size = 0 if ptype == "BoolProperty" else len(body)
        return self.fname(name) + self.fname(ptype) + struct.pack("<ii", size, 0) + \
            (self.fname(struct_name) if struct_name else b"") + body

    def transform_tags(self, values):
        """{name: tag bytes} for transform values ({prop: (fmt, values)}, as edit_values returns)."""
        return {name: self.tag(name, "StructProperty" if name in STRUCTS else "FloatProperty",
                               struct.pack(fmt, *v), STRUCTS.get(name)) for name, (fmt, v) in values.items()}

    def with_props(self, export, blob, tags, tail=None):
        """`blob` (export's bytes, or a copy with the same layout) with whole property tags replaced or appended,
        and optionally the native data after the properties replaced too."""
        start = self.pkg.net_index_at(export) + 4 - export["off"]
        out, end, seen = bytearray(blob[:start]), start, set()
        for name, _, _, off, size in self.pkg.properties(export):
            stop = off - export["off"] + size
            out += tags[name] if name in tags else blob[end:stop]
            seen.add(name)
            end = stop
        none_end = self.pkg.pos - export["off"]
        out += b"".join(t for name, t in tags.items() if name not in seen)
        return out + blob[end:none_end] + (blob[none_end:] if tail is None else tail)

    def set_props(self, i, tags):
        """Replace or add whole property tags ({name: tag bytes}) on an existing object."""
        if i in self.replaced:
            raise ValueError(f"{self.pkg.exports[i]['name']} was already rewritten")
        self.replaced[i] = self.with_props(self.pkg.exports[i], self.pkg.object_bytes(i), tags)

    def set_values(self, i, values):
        """Store transform values on an existing object, adding the properties it lacks."""
        self.set_props(i, self.transform_tags(values))

    def clear_refs(self, i, prop):
        """Empty an existing object's object-reference array property."""
        self.append_refs(i, prop, [], keep=False)

    def append_refs(self, i, prop, refs, keep=True):
        """Add object references to an existing object's array property (e.g. Sequence.SequenceObjects)."""
        export = self.pkg.exports[i]
        if i not in self.replaced:
            self.replaced[i] = bytearray(self.pkg.object_bytes(i))
        blob = self.replaced[i]
        for name, ptype, _, off, size in self.pkg.properties(export):
            if name == prop and ptype == "ArrayProperty":
                break
        else:
            raise KeyError(f"{export['name']} has no array {prop}")
        rel = off - export["off"]                # earlier changes only ever touch bytes after this array's start
        count = struct.unpack_from("<i", blob, rel)[0]
        old = list(struct.unpack_from(f"<{count}i", blob, rel + 4)) if keep else []
        new = old + list(refs)
        blob[rel:rel + 4 + 4 * count] = struct.pack(f"<i{len(new)}i", len(new), *new)
        struct.pack_into("<i", blob, rel - 8, 4 + 4 * len(new))         # tag: name, type, size, array index

    def _unique_number(self, name_index):
        if not self.next_number:
            for e in self.pkg.exports:
                index, number = e["name_raw"]
                self.next_number[index] = max(self.next_number.get(index, 0), number + 1)
        number = self.next_number.get(name_index, 1)
        self.next_number[name_index] = number + 1
        return number

    def _remap(self, export, blob, remap, offset=None, values=None):
        for name, ptype, _, off, size in self.pkg.properties(export):
            rel = off - export["off"]
            if values and name in values and size == struct.calcsize(values[name][0]):
                struct.pack_into(values[name][0], blob, rel, *values[name][1])
            elif ptype == "ObjectProperty":
                ref = struct.unpack_from("<i", blob, rel)[0]
                struct.pack_into("<i", blob, rel, remap.get(ref, ref))
            elif ptype == "ArrayProperty":
                n = struct.unpack_from("<i", blob, rel)[0]
                if size == 4 + 4 * n:            # object-ref arrays such as Components; other values never match remap
                    refs = struct.unpack_from(f"<{n}i", blob, rel + 4)
                    struct.pack_into(f"<{n}i", blob, rel + 4, *(remap.get(r, r) for r in refs))
            elif name == "Location" and offset:
                x, y, z = struct.unpack_from("<3f", blob, rel)
                struct.pack_into("<3f", blob, rel, x + offset[0], y + offset[1], z + offset[2])

    def duplicate(self, i, offset=(0, 0, 0), values=None, kid_props=None):
        """Copy a placed actor and its components; `values` ({prop: (fmt, values)}) sets the copy's transform,
        adding properties the original lacks. `kid_props` ({component export index: (tags, tail)}) rewrites
        a copied component (see with_props). Returns the copy's export index."""
        pkg = self.pkg
        src = pkg.exports[i]
        new_ref = len(pkg.exports) + len(self.added) + 1          # object references are 1-based
        kids = [k for k, e in enumerate(pkg.exports) if e["outer"] == i + 1]
        remap = {i + 1: new_ref, **{k + 1: new_ref + 1 + n for n, k in enumerate(kids)}}
        present = {name for name, *_ in pkg.properties(src)}
        for k, ref in [(i, new_ref)] + [(k, remap[k + 1]) for k in kids]:
            export = pkg.exports[k]
            blob = bytearray(pkg.data[export["off"]:export["off"] + export["size"]])
            self._remap(export, blob, remap, *((offset, values) if export is src else (None, None)))
            struct.pack_into("<i", blob, pkg.net_index_at(export) - export["off"], ref - 1)
            if export is src and values:
                blob = self.with_props(export, blob, self.transform_tags(
                    {n: v for n, v in values.items() if n not in present}))
            if k in (kid_props or {}):
                blob = self.with_props(export, blob, *kid_props[k])
            entry = bytearray(export["entry"])
            if export is src:
                struct.pack_into("<i", entry, 16, self._unique_number(src["name_raw"][0]))
            else:
                struct.pack_into("<i", entry, 8, new_ref)          # outer: the copied actor
            self.added.append((entry, blob))
        self._level_list(lambda refs: refs + [new_ref])
        return new_ref - 1

    def remove(self, i):
        """Take an actor out of the level; its object stays in the file but is never spawned."""
        self._level_list(lambda refs: [0 if r == i + 1 else r for r in refs])

    def _level_list(self, change):
        pkg = self.pkg
        li = pkg.level_index()
        level = pkg.exports[li]
        if li not in self.replaced:
            for _ in pkg.properties(level):
                pass
            self.level_list_at = pkg.pos - level["off"] + 4          # after the TTransArray owner ref
            self.replaced[li] = bytearray(pkg.object_bytes(li))
        blob, at = self.replaced[li], self.level_list_at
        count = struct.unpack_from("<i", blob, at)[0]
        refs = change(list(struct.unpack_from(f"<{count}i", blob, at + 4)))
        blob[at:at + 4 + 4 * count] = struct.pack(f"<i{len(refs)}i", len(refs), *refs)

    def save(self, path):
        pkg = self.pkg
        out = bytearray(pkg.data)
        entries = [bytearray(e["entry"]) for e in pkg.exports]

        def place(blob):
            out.extend(blob)
            return len(out) - len(blob)

        for i, blob in self.replaced.items():
            struct.pack_into("<ii", entries[i], 32, len(blob), place(blob))    # SerialSize, SerialOffset
        for n, (entry, blob) in enumerate(self.added):
            for at in self.bulk_at.get(n, ()):
                struct.pack_into("<i", blob, at + 12, len(out) + at + 16)
            struct.pack_into("<ii", entry, 32, len(blob), place(blob))
            entries.append(entry)
        export_off = place(b"".join(entries))
        depends_off = place(pkg.depends_blob() + b"\0\0\0\0" * len(self.added))
        s = pkg.summary_at
        if self.new_names:
            table = b"".join(struct.pack("<i", len(n) + 1) + n.encode("latin-1") + b"\0" + struct.pack("<Q", 0x0007001000000000)
                             for n in self.new_names)
            struct.pack_into("<ii", out, s + 4, len(pkg.names) + len(self.new_names), place(pkg.name_table + table))
            struct.pack_into("<i", out, pkg.last_generation_at + 4, len(pkg.names) + len(self.new_names))
        if self.new_imports:
            struct.pack_into("<ii", out, s + 20, len(pkg.imports) + len(self.new_imports),
                             place(pkg.import_table + b"".join(self.new_imports)))
        struct.pack_into("<i", out, s + 12, len(entries))         # ExportCount
        struct.pack_into("<i", out, s + 16, export_off)
        struct.pack_into("<i", out, s + 28, depends_off)
        struct.pack_into("<i", out, pkg.last_generation_at, len(entries))
        struct.pack_into("<i", out, pkg.last_generation_at + 8, len(entries))   # NetObjectCount
        with open(path, "wb") as f:
            f.write(out)


RING_CENTER_Z = 1929.9      # ringobjnew pivot sits this far below the ring's center (mesh bounds)
UU_PER_TURN = 65536         # UE3 rotator units in a full turn


def spiral(pkg, center, radius, start_deg, start_z, step_deg, climb, count, scale=0.52):
    """Move `count` ringobjnew rings onto a rising spiral, holes facing along the path."""
    rings = [e for e in pkg.exports
             if pkg.class_of(e) == "StaticMeshActor" and pkg.mesh_of(e) == "ringobjnew"
             and pkg.prop(e, "Rotation") and pkg.prop(e, "DrawScale3D")]
    if len(rings) < count:
        raise ValueError(f"only {len(rings)} movable rings")
    for i, ring in enumerate(rings[-count:]):
        theta = math.radians(start_deg + i * step_deg)
        x = center[0] + radius * math.cos(theta)
        y = center[1] + radius * math.sin(theta)
        z = start_z + i * climb - RING_CENTER_Z * scale
        yaw = round(math.degrees(theta) / 360 * UU_PER_TURN)   # ring hole (local Y) follows the tangent
        pkg.set(ring, "Location", "<3f", x, y, z)
        pkg.set(ring, "Rotation", "<3i", 0, yaw, 0)
        pkg.set(ring, "DrawScale3D", "<3f", scale, scale, scale)
    return rings[-count:]


def describe(pkg, export):
    out = [f"{export['name']}"]
    for name, ptype, struct_name, off, size in pkg.properties(export):
        if struct_name in ("Vector", "Rotator") and size == 12:
            fmt = "<3f" if struct_name == "Vector" else "<3i"
            vals = struct.unpack_from(fmt, pkg.data, off)
            out.append(f"{name}=({', '.join(f'{v:.0f}' if isinstance(v, float) else str(v) for v in vals)})")
        elif ptype == "FloatProperty":
            out.append(f"{name}={struct.unpack_from('<f', pkg.data, off)[0]:.3g}")
        elif ptype == "ObjectProperty" and name in ("StaticMesh", "StaticMeshComponent", "CollisionComponent"):
            out.append(f"{name}={pkg.ref(struct.unpack_from('<i', pkg.data, off)[0])}")
    return "  ".join(out)


if __name__ == "__main__":
    if sys.argv[1] == "spiral":
        src, out = sys.argv[2], sys.argv[3]
        pkg = Package(src)
        moved = spiral(pkg, center=(0, 0), radius=2600, start_deg=55, start_z=2400,
                       step_deg=30, climb=300, count=24)
        pkg.save(out)
        check = Package(out)
        for ring in (check.exports[pkg.exports.index(r)] for r in moved):
            loc = check.get(ring, "Location", "<3f")
            assert abs(math.hypot(loc[0], loc[1]) - 2600) < 1, loc
        print(f"wrote {out}: {len(moved)} rings on a spiral, re-read and verified")
        sys.exit()
    pkg = Package(sys.argv[1])
    if len(sys.argv) == 2:
        print(f"{len(pkg.names)} names, {len(pkg.imports)} imports, {len(pkg.exports)} exports")
        for cls, n in Counter(pkg.class_of(e) for e in pkg.exports).most_common(40):
            print(f"{n:6d}  {cls}")
    else:
        for e in pkg.exports:
            if pkg.class_of(e) == sys.argv[2]:
                print(describe(pkg, e))
