#!/usr/bin/env python3 -I
"""Decode Kismet (Sequence) graphs from UE3 v868 maps: nodes, their wiring and their variables."""
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ue3 import Package  # noqa: E402

# Structs serialized as raw bytes instead of tagged properties.
ATOMIC = {"Vector": "<3f", "Rotator": "<3i", "Color": "<4B", "LinearColor": "<4f", "Vector2D": "<2f",
          "IntPoint": "<2i", "Guid": "<4I", "Plane": "<4f", "Quat": "<4f", "Box": None}


def decode(pkg, start, end):
    """Tagged properties between start and end as {name: value}; nested structs/arrays decoded best-effort."""
    props, p = {}, start
    while p < end:
        name = fname(pkg, p)
        p += 8
        if name == "None":
            break
        ptype = fname(pkg, p)
        size, index = struct.unpack_from("<ii", pkg.data, p + 8)
        p += 16
        extra = None
        if ptype == "StructProperty":
            extra = fname(pkg, p)
            p += 8
        elif ptype == "ByteProperty":
            extra = fname(pkg, p)
            p += 8
        elif ptype == "BoolProperty":
            props[name] = bool(pkg.data[p])
            p += 1
            continue
        value = read_value(pkg, ptype, extra, p, size)
        props[name if index == 0 else f"{name}[{index}]"] = value
        p += size
    return props, p


def read_value(pkg, ptype, extra, p, size):
    d = pkg.data
    if ptype in ("IntProperty",):
        return struct.unpack_from("<i", d, p)[0]
    if ptype == "FloatProperty":
        return struct.unpack_from("<f", d, p)[0]
    if ptype in ("ObjectProperty", "ClassProperty", "ComponentProperty", "InterfaceProperty"):
        return Ref(pkg, struct.unpack_from("<i", d, p)[0])
    if ptype == "NameProperty":
        return fname(pkg, p)
    if ptype == "StrProperty":
        n = struct.unpack_from("<i", d, p)[0]
        return d[p + 4:p + 4 + n].decode("latin-1").rstrip("\0") if n >= 0 else d[p + 4:p + 4 - 2 * n].decode("utf-16-le").rstrip("\0")
    if ptype == "ByteProperty":
        return fname(pkg, p) if size == 8 else d[p]
    if ptype == "StructProperty":
        if extra in ATOMIC and ATOMIC[extra] and size == struct.calcsize(ATOMIC[extra]):
            return struct.unpack_from(ATOMIC[extra], d, p)
        return decode(pkg, p, p + size)[0]
    if ptype == "ArrayProperty":
        n = struct.unpack_from("<i", d, p)[0]
        body = p + 4
        if n == 0:
            return []
        if size == 4 + 4 * n and not looks_tagged(pkg, body):
            return [Ref(pkg, r) for r in struct.unpack_from(f"<{n}i", d, body)]
        items = []
        for _ in range(n):
            if not looks_tagged(pkg, body):
                return f"<{n} items, {size} bytes>"
            item, body = decode(pkg, body, p + size)
            items.append(item)
        return items
    return f"<{ptype} {size}B>"


def looks_tagged(pkg, p):
    """True when bytes at p start a property tag (valid name followed by a property type name or None)."""
    try:
        idx, num = struct.unpack_from("<ii", pkg.data, p)
        if not (0 <= idx < len(pkg.names)) or num < 0 or num > 100000:
            return False
        if pkg.names[idx] == "None":
            return True
        tidx = struct.unpack_from("<i", pkg.data, p + 8)[0]
        return 0 <= tidx < len(pkg.names) and pkg.names[tidx].endswith("Property")
    except struct.error:
        return False


def typed(pkg, start, end):
    """Tagged properties as [(name, type, struct/enum name, array index, value)], keeping order and types."""
    out, p = [], start
    while p < end:
        name = fname(pkg, p)
        p += 8
        if name == "None":
            break
        ptype = fname(pkg, p)
        size, index = struct.unpack_from("<ii", pkg.data, p + 8)
        p += 16
        extra = None
        if ptype in ("StructProperty", "ByteProperty"):
            extra = fname(pkg, p)
            p += 8
        if ptype == "BoolProperty":
            out.append((name, ptype, None, index, bool(pkg.data[p])))
            p += 1
            continue
        if ptype == "StructProperty" and not (extra in ATOMIC and ATOMIC[extra]):
            value = typed(pkg, p, p + size)
        elif ptype == "ArrayProperty":
            n, body = struct.unpack_from("<i", pkg.data, p)[0], p + 4
            if n and looks_tagged(pkg, body):
                value = []
                for _ in range(n):
                    item = typed(pkg, body, p + size)
                    value.append(item)
                    body = skip_tagged(pkg, body)
            else:
                value = read_value(pkg, ptype, extra, p, size)
        else:
            value = read_value(pkg, ptype, extra, p, size)
        out.append((name, ptype, extra, index, value))
        p += size
    return out


def skip_tagged(pkg, p):
    """Offset just past a tagged property list (after its None)."""
    while True:
        name = fname(pkg, p)
        p += 8
        if name == "None":
            return p
        ptype = fname(pkg, p)
        size = struct.unpack_from("<i", pkg.data, p + 8)[0]
        p += 16 + (8 if ptype in ("StructProperty", "ByteProperty") else 0) + (1 if ptype == "BoolProperty" else size)


def fname(pkg, p):
    index, number = struct.unpack_from("<ii", pkg.data, p)
    base = pkg.names[index]
    return f"{base}_{number - 1}" if number else base


class Ref(int):
    def __new__(cls, pkg, value):
        ref = super().__new__(cls, value)
        ref.label = pkg.ref(value) if value else "null"
        return ref

    def __repr__(self):
        return self.label


def node_props(pkg, export):
    for _ in pkg.properties(export):
        pass
    return decode(pkg, pkg.net_index_at(export) + 4, export["off"] + export["size"])[0]


I, F, B, O, N, S, A = "IntProperty", "FloatProperty", "BoolProperty", "ObjectProperty", "NameProperty", "StrProperty", "ArrayProperty"


class Encoder:
    """Tagged-property writer; names go through the Additions so missing ones get added to the package."""

    def __init__(self, add):
        self.add = add

    def props(self, props):
        return b"".join(self.prop(*p) for p in props) + self.add.fname("None")

    def prop(self, name, ptype, value):
        head = self.add.fname(name) + self.add.fname(ptype)
        if ptype == B:
            return head + struct.pack("<ii", 0, 0) + bytes([bool(value)])
        body = self.value(ptype, value)
        return head + struct.pack("<ii", len(body), 0) + body

    def value(self, ptype, value):
        if ptype in (I, O):
            return struct.pack("<i", value)
        if ptype == F:
            return struct.pack("<f", value)
        if ptype == N:
            return self.add.fname(value)
        if ptype == S:
            text = value.encode("latin-1") + b"\0"
            return struct.pack("<i", len(text)) + text
        if ptype == A:
            if value and isinstance(value[0], list):                  # array of structs: tagged lists
                return struct.pack("<i", len(value)) + b"".join(self.props(v) for v in value)
            return struct.pack(f"<i{len(value)}i", len(value), *value)  # array of object refs
        raise ValueError(ptype)


# Link records exactly as UDK 2015 saves them (every field, in this order).
def input_link(y):
    return [("LinkDesc", S, "In"), ("bHasImpulse", B, False), ("QueuedActivations", I, 0), ("bDisabled", B, False),
            ("bDisabledPIE", B, False), ("LinkedOp", O, 0), ("DrawY", I, y), ("bHidden", B, False),
            ("ActivateDelay", F, 0.0), ("bClampedMax", B, False), ("bClampedMin", B, False), ("OverrideDelta", I, 11)]


def output_link(desc, targets, y, delta=11):
    return [("Links", A, [[("LinkedOp", O, t), ("InputLinkIdx", I, 0)] for t in targets]), ("LinkDesc", S, desc),
            ("bHasImpulse", B, False), ("bDisabled", B, False), ("bDisabledPIE", B, False), ("LinkedOp", O, 0),
            ("ActivateDelay", F, 0.0), ("DrawY", I, y), ("bHidden", B, False), ("bClampedMax", B, False),
            ("bClampedMin", B, False), ("OverrideDelta", I, delta)]


def var_link(desc, expected, linked, x, prop="None", writeable=False, hidden=False, delta=16):
    return [("ExpectedType", O, expected), ("LinkedVariables", A, linked), ("LinkDesc", S, desc), ("LinkVar", N, "None"),
            ("PropertyName", N, prop), ("bWriteable", B, writeable), ("bSequenceNeverReadsOnlyWritesToThisVar", B, False),
            ("bModifiesLinkedObject", B, False), ("bHidden", B, hidden), ("MinVars", I, 1), ("MaxVars", I, 255),
            ("DrawX", I, x), ("bAllowAnyType", B, False), ("bClampedMax", B, False), ("bClampedMin", B, False),
            ("OverrideDelta", I, delta)]


def layout(version, parent, x, y, w, h, name=None):
    props = [("ObjInstanceVersion", I, version), ("ParentSequence", O, parent), ("ObjPosX", I, x), ("ObjPosY", I, y)]
    return props + ([("ObjName", S, name)] if name else []) + [("DrawWidth", I, w), ("DrawHeight", I, h)]


def main_sequence(pkg):
    level = pkg.level_index() + 1
    return next(i for i, e in enumerate(pkg.exports) if pkg.class_of(e) == "Sequence" and e["outer"] == level)


def last_checkpoint_var(pkg):
    for i, e in enumerate(pkg.exports):
        if pkg.class_of(e) == "SeqVar_Object" and node_props(pkg, e).get("VarName") == "LastCheckpoint":
            return i
    return None


def checkpoint_zones(pkg):
    """Export indices of zones wired as checkpoints (SetObject: LastCheckpoint = zone)."""
    last = last_checkpoint_var(pkg)
    if last is None:
        return []
    zones = []
    for e in pkg.exports:
        if pkg.class_of(e) != "SeqAct_SetObject":
            continue
        links = {link.get("LinkDesc"): link.get("LinkedVariables", []) for link in node_props(pkg, e).get("VariableLinks", [])}
        if last + 1 in links.get("Target", []):
            for var in links.get("Value", []):
                zone = node_props(pkg, pkg.exports[var - 1]).get("ObjValue") if var > 0 else None
                if zone:
                    zones.append(zone - 1)
    return zones


def add_checkpoints(add, template, transforms):
    """Copy trigger zone `template` once per transform ({prop: (fmt, values)}) and wire Kismet so respawning
    teleports the car to the last zone touched. The respawn logic is created once per map.
    Returns the new trigger export indices."""
    pkg, enc = add.pkg, Encoder(add)
    seq = main_sequence(pkg)
    parent = seq + 1
    cls = {c: add.class_ref(c, "Engine") for c in ("SeqVar_Object", "SeqEvent_Touch", "SeqAct_Teleport", "SeqAct_SetObject")}
    cls["SeqEvent_CarSpawned_TA"] = add.class_ref("SeqEvent_CarSpawned_TA", "TAGame")
    var_type = cls["SeqVar_Object"]
    nodes = []

    def node(class_name, props):
        i = add.add_object(cls[class_name], parent, class_name, struct.pack("<i", 0) + enc.props(props))
        nodes.append(i)
        return i

    def next_ref(k=0):
        return len(pkg.exports) + len(add.added) + 1 + k

    x0, y0 = 40000, 40000
    last = last_checkpoint_var(pkg)
    if last is None:
        car, last_ref, teleport, spawned = next_ref(), next_ref(1), next_ref(2), next_ref(3)
        node("SeqVar_Object", layout(1, parent, x0 + 100, y0 + 200, 32, 32))
        node("SeqVar_Object", [("VarName", N, "LastCheckpoint")] + layout(1, parent, x0 + 300, y0 + 200, 32, 32))
        node("SeqAct_Teleport", [
            ("InputLinks", A, [input_link(y0 + 34)]),
            ("OutputLinks", A, [output_link("Out", [], y0 + 34)]),
            ("VariableLinks", A, [var_link("Target", var_type, [car], x0 + 238, prop="Targets"),
                                  var_link("Destination", var_type, [last_ref], x0 + 313, delta=76),
                                  var_link("Teleport Volumes", var_type, [], 0, prop="TeleportVolumes", hidden=True, delta=0)]),
        ] + layout(2, parent, x0 + 200, y0, 166, 61))
        node("SeqEvent_CarSpawned_TA", [
            ("MaxWidth", I, 97),
            ("OutputLinks", A, [output_link("Out", [teleport], y0 + 66)]),
            ("VariableLinks", A, [var_link("Instigator", var_type, [car], x0 + 48, writeable=True)]),
        ] + layout(1, parent, x0, y0, 68, 128))
        assert [n + 1 for n in nodes] == [car, last_ref, teleport, spawned]
    else:
        last_ref = last + 1

    triggers = []
    for k, values in enumerate(transforms):
        trig = add.duplicate(template, values=values)
        triggers.append(trig)
        value, setobj, touch = next_ref(), next_ref(1), next_ref(2)
        x, y = x0 + 600 * (k + 1), y0 + 400
        node("SeqVar_Object", [("ObjValue", O, trig + 1)] + layout(1, parent, x + 30, y + 220, 32, 32))
        node("SeqAct_SetObject", [
            ("InputLinks", A, [input_link(y + 34)]),
            ("OutputLinks", A, [output_link("Out", [], y + 34)]),
            ("VariableLinks", A, [var_link("Value", var_type, [value], x + 234, prop="Value"),
                                  var_link("Target", var_type, [last_ref], x + 290, prop="Targets", delta=68)]),
        ] + layout(2, parent, x + 200, y, 128, 61))
        node("SeqEvent_Touch", [
            ("Originator", O, trig + 1), ("MaxTriggerCount", I, 0), ("ReTriggerDelay", F, 1.0), ("MaxWidth", I, 173),
            ("OutputLinks", A, [output_link("Touched", [setobj], y + 69, delta=14), output_link("UnTouched", [], y + 90, delta=35),
                                output_link("Empty", [], y + 111, delta=56)]),
            ("VariableLinks", A, [var_link("Instigator", var_type, [], x + 86, writeable=True, delta=54)]),
        ] + layout(2, parent, x, y, 131, 176, name=f"Checkpoint {k + 1} Touch"))
        assert [n + 1 for n in nodes[-3:]] == [value, setobj, touch]

    add.append_refs(seq, "SequenceObjects", [n + 1 for n in nodes])
    return triggers


def describe(pkg, i):
    """One line per Kismet node: class, name, outputs -> targets, variable links -> variables."""
    e = pkg.exports[i]
    props = node_props(pkg, e)
    outs = []
    for link in props.get("OutputLinks", []) if isinstance(props.get("OutputLinks"), list) else []:
        targets = [f"{t.get('LinkedOp')!r}#{t.get('InputLinkIdx', 0)}" for t in link.get("Links", []) if isinstance(t, dict)]
        if targets:
            outs.append(f"{link.get('LinkDesc', '?')}->{','.join(targets)}")
    vars_ = []
    for link in props.get("VariableLinks", []) if isinstance(props.get("VariableLinks"), list) else []:
        linked = link.get("LinkedVariables", [])
        if linked:
            vars_.append(f"{link.get('LinkDesc', '?')}={linked}")
    extra = {k: v for k, v in props.items() if k in ("ObjValue", "FindVarName", "VarName", "IntValue", "FloatValue", "VectValue",
                                                    "Originator", "bAllPlayers", "MaxTriggerCount", "bValue", "StrValue", "ObjComment")}
    return f"{pkg.class_of(e)} {e['name']} {extra or ''} | out: {'; '.join(outs) or '-'} | vars: {'; '.join(vars_) or '-'}"


if __name__ == "__main__":
    pkg = Package(sys.argv[1])
    wanted = set(sys.argv[2].split(",")) if len(sys.argv) > 2 else None
    for i, e in enumerate(pkg.exports):
        cls = pkg.class_of(e)
        if cls.startswith("Seq") and (not wanted or cls in wanted):
            print(describe(pkg, i))
