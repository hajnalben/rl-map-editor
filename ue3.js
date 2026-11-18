// Read and patch Rocket League workshop maps (UDK 2015 / UE3 package version 868).
import { calcsize, concat, latin1, latin1Bytes, pack, packInto, pyRound, unpackFrom, utf16 } from './bytes.js';

const HAS_STACK = 0x0200000000000000n;           // RF_HasStack: actors carry a script state frame
const PROBE = (0x0dn << 32n) | 0xffffffffn;       // a new actor's state frame probe mask, as most workshop maps' lights and movers have
// structs saved as raw bytes instead of tagged properties, by their format (Box: two vectors and a byte)
export const ATOMIC = new Map(Object.entries({ Vector: '<3f', Rotator: '<3i', Color: '<4B', LinearColor: '<4f', Vector2D: '<2f',
                                               IntPoint: '<2i', Guid: '<4I', Plane: '<4f', Quat: '<4f', Box: null }));
export const REFERENCES = new Set(['ObjectProperty', 'ComponentProperty', 'ClassProperty', 'InterfaceProperty']);

export const startsTag = (d, names, q, end) => {  // q starts a property tag or a None (an array item that is a struct)
  const k = unpackFrom('<i', d, q)[0];
  return q + 8 <= end && k >= 0 && k < names.length && (names[k] === 'None' || (names[unpackFrom('<i', d, q + 8)[0]] ?? '').endsWith('Property'));
};

// The tagged property list at [p, end) of `d`, its FNames read with fname(q) (which may also re-point them; a null
// one stops the walk with null): visit({name, type, struct, index, at, size, end}) per property, `at` where its value
// starts (a BoolProperty's byte), `end` the list's. Unless visit returns false, structs not in ATOMIC and arrays whose
// first item passes tagged(t) are walked into, and other arrays of 4-byte items visited item by item as object
// references. Returns where the list stops: after its None, or at `end`.
export function walkTags(d, p, end, fname, visit, tagged) {
  while (p + 8 <= end) {
    const name = fname(p);
    if (name === null) return null;
    if (name === 'None') return p + 8;
    const [size] = unpackFrom('<i', d, p + 16), type = fname(p + 8), [index] = unpackFrom('<i', d, p + 20);
    let struct = null;
    p += 24;
    if (type === 'StructProperty' || type === 'ByteProperty') { struct = fname(p); p += 8; }
    const t = { name, type, struct, index, at: p, size, end };
    if (visit(t) !== false && type !== 'BoolProperty') {
      if (type === 'StructProperty' && !ATOMIC.has(struct)) walkTags(d, p, p + size, fname, visit, tagged);
      else if (type === 'ArrayProperty' && size >= 4) {
        const n = unpackFrom('<i', d, p)[0];
        if (n > 0 && tagged(t)) for (let k = 0, q = p + 4; k < n && q !== null; k++) q = walkTags(d, q, p + size, fname, visit, tagged);
        else if (size === 4 + 4 * n) for (let k = 0; k < n; k++) visit({ ...t, type: 'ObjectProperty', at: p + 4 + 4 * k, size: 4 });
      }
    }
    p += type === 'BoolProperty' ? 1 : size;
  }
  return p;
}

export const bulkAt = (pkg, q) => {               // an inline bulk header at q: its data starts right after it
  const [flags, count, size, off] = unpackFrom('<Iiii', pkg.data, q);
  return off === q + 16 && flags < 0x1000 && count >= 0 && size >= 0 ? size : null;
};
export function bulkHeaders(pkg, e) {             // positions of inline bulk headers in an object (fast path of bulkAt)
  const dv = new DataView(pkg.data.buffer, pkg.data.byteOffset, pkg.data.byteLength), out = [];
  for (let q = 0; q + 16 <= e.size; q++) {
    if (dv.getInt32(e.off + q + 12, true) === e.off + q + 16 && bulkAt(pkg, e.off + q) !== null) out.push(q);
  }
  return out;
}

// Compressed packages. UE3 stores a package's tables and objects as chunks; each chunk is a tag, a block size, its
// totals, then (compressed, uncompressed) sizes per block and the blocks. Zlib blocks (RL's own packages, game.js)
// inflate with the platform's DecompressionStream; LZO1X blocks (UE3's other compression on PC) with lzo1x below.
export async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** @param {(block: Uint8Array, size: number) => Uint8Array | Promise<Uint8Array>} [unpack] */
export async function unchunk(bytes, unpack = inflate) {
  const [, , , total] = unpackFrom('<iiii', bytes, 0), sizes = [];
  let r = 16;
  for (let got = 0; got < total; r += 8) { const [cs, us] = unpackFrom('<ii', bytes, r); sizes.push([cs, us]); got += us; }
  const parts = [];
  for (const [cs, us] of sizes) { parts.push(await unpack(bytes.subarray(r, r + cs), us)); r += cs; }
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  parts.reduce((at, x) => (out.set(x, at), at + x.length), 0);
  return out;
}
// LZO1X decompression (as liblzo2's lzo1x_decompress) of `src` into `size` bytes
export function lzo1x(src, size) {
  const out = new Uint8Array(size);
  let ip = 0, op = 0, t = src[ip], state = 'loop';
  const copy = (from, n) => { for (let k = 0; k < n; k++) out[op++] = out[from + k]; };   // byte by byte: a match may overlap what it writes
  const literals = n => { out.set(src.subarray(ip, ip + n), op); ip += n; op += n; };
  const long = base => { let n = 0; while (src[ip] === 0) { n += 255; ip++; } return n + base + src[ip++]; };   // a length that went on in extra bytes
  if (t > 17) { ip++; t -= 17; if (t < 4) state = 'next'; else { literals(t); state = 'first'; } }
  for (;;) {
    if (state === 'loop') {
      t = src[ip++];
      if (t < 16) { literals((t || long(15)) + 3); state = 'first'; } else state = 'match';
    }
    if (state === 'first') {
      t = src[ip++];
      if (t < 16) { const from = op - 0x801 - (t >> 2) - (src[ip++] << 2); copy(from, 3); state = 'done'; } else state = 'match';
    }
    if (state === 'next') { literals(t); t = src[ip++]; state = 'match'; }
    if (state === 'match') {
      if (t >= 64) { const from = op - 1 - ((t >> 2) & 7) - (src[ip++] << 3); copy(from, (t >> 5) + 1); }
      else if (t >= 32) {
        const n = (t & 31) || long(31), from = op - 1 - (src[ip] >> 2) - (src[ip + 1] << 6);
        ip += 2; copy(from, n + 2);
      } else if (t >= 16) {
        const n = (t & 7) || long(7);
        let from = op - ((t & 8) << 11) - (src[ip] >> 2) - (src[ip + 1] << 6);
        ip += 2;
        if (from === op) return out;              // the end marker
        from -= 0x4000;
        copy(from, n + 2);
      } else { const from = op - 1 - (t >> 2) - (src[ip++] << 2); copy(from, 2); }
      state = 'done';
    }
    t = src[ip - 2] & 3;                          // literals after a match: the low bits of its last-but-one byte
    state = t ? 'next' : 'loop';
  }
}

// A package UDK saved compressed, as it is uncompressed: its chunks unpacked where they belong and the chunk table
// dropped from the summary (the chunks' offsets count a summary without it). Uncompressed bytes come back as they are.
export async function unpackage(bytes) {
  const n = unpackFrom('<i', bytes, 12)[0], flagsAt = 16 + (n < 0 ? -2 * n : n);
  const at = flagsAt + 76 + 12 * unpackFrom('<i', bytes, flagsAt + 64)[0];   // past the counts, offsets, guid and generations
  const [compression, count] = unpackFrom('<Ii', bytes, at);
  if (!count) return bytes;
  const unpack = compression & 1 ? inflate : compression & 2 ? lzo1x : null;
  if (!unpack) throw new Error(`this map is compressed with LZX (compression ${compression}), which only the Xbox uses`);
  const chunks = Array.from({ length: count }, (_, k) => unpackFrom('<4i', bytes, at + 8 + 16 * k));
  const start = Math.min(...chunks.map(c => c[0])), rest = at + 8 + 16 * count;
  const out = new Uint8Array(Math.max(...chunks.map(([u, s]) => u + s)));
  out.set(bytes.subarray(0, at));                 // compression flags and chunk count stay 0
  out.set(bytes.subarray(rest, rest + start - at - 8), at + 8);
  for (const [uOff, , cOff, cSize] of chunks) out.set(await unchunk(bytes.subarray(cOff, cOff + cSize), unpack), uOff);
  packInto('<I', out, flagsAt, unpackFrom('<I', out, flagsAt)[0] & ~0x02000000);   // PKG_StoreCompressed
  return out;
}

export class Package {
  constructor(buffer) {
    this.data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.pos = 0;
    const [tag, ver, licensee] = this.unpack('<IHHi');
    this.wideOffsets = licensee >= 22;            // the game's own packages (game.js): 64-bit export offsets
    // 867 (an older UDK) reads and writes back as 868 does, checked on LethDribbleChallenge1
    if (tag !== 0x9E2A83C1 || (ver !== 868 && ver !== 867)) throw new Error('not a Rocket League workshop map (UE3 package version 867 or 868)');
    this.fstring();
    this.summaryAt = this.pos;                    // PackageFlags, then name/export/import counts+offsets, DependsOffset
    const [, ncount, noff, ecount, eoff, icount, ioff] = this.unpack('<I6i');
    this.dependsOff = this.unpack('<i')[0];
    this.unpack('<3i');                           // import/export guids
    this.unpack('<i');                            // thumbnail table
    this.pos += 16;                               // package guid
    const generations = this.unpack('<i')[0];
    this.lastGenerationAt = this.pos + 12 * (generations - 1);   // ExportCount, NameCount, NetObjectCount
    this.pos += 12 * generations;
    this.unpack('<ii');                           // engine, cooker version
    const [compression, chunks] = this.unpack('<Ii');
    if (compression || chunks) throw new Error('compressed: unpackage() it first');

    this.pos = noff;
    this.names = [];
    for (let k = 0; k < ncount; k++) {
      this.names.push(this.fstring());
      this.pos += 8;                              // name flags
    }
    this.nameTable = this.data.slice(noff, this.pos);
    this.pos = this.importsAt = ioff;
    this.imports = [];
    for (let k = 0; k < icount; k++) {
      const classPackage = this.fname(), cls = this.fname(), outer = this.unpack('<i')[0];
      this.imports.push({ classPackage, cls, outer, name: this.fname() });
    }
    this.importTable = this.data.slice(ioff, this.pos);
    this.pos = eoff;
    this.exports = [];
    for (let k = 0; k < ecount; k++) {
      const start = this.pos;
      const [cls, , outer] = this.unpack('<3i');
      const nameRaw = unpackFrom('<ii', this.data, this.pos);
      const name = this.fname();
      const [, flags, size] = this.unpack('<iQi');
      const off = this.wideOffsets ? Number(this.unpack('<q')[0]) : this.unpack('<i')[0];
      const [, nnet] = this.unpack('<Ii');
      this.pos += 4 * nnet + 16 + 4;
      this.exports.push({ cls, outer, name, nameRaw, flags, size, off, entry: this.data.slice(start, this.pos) });
    }
  }

  unpack(fmt) {
    const values = unpackFrom(fmt, this.data, this.pos);
    this.pos += calcsize(fmt);
    return values;
  }

  fstring() {
    const n = this.unpack('<i')[0];
    const bytes = n >= 0 ? this.data.subarray(this.pos, this.pos + n) : this.data.subarray(this.pos, this.pos - 2 * n);
    this.pos += n >= 0 ? n : -2 * n;
    return (n >= 0 ? latin1(bytes) : utf16(bytes)).replace(/\0+$/, '');
  }

  fname() {
    const [index, number] = this.unpack('<ii');
    const base = this.names[index];
    return number ? `${base}_${number - 1}` : base;
  }

  ref(index) {
    if (index > 0) return this.exports[index - 1].name;
    if (index < 0) return this.imports[-index - 1].name;
    return null;
  }

  classOf(e) { return this.ref(e.cls) || 'Class'; }

  netIndexAt(e) {                                 // file offset of an object's NetIndex, which precedes its properties
    let p = e.off;
    if (e.flags & HAS_STACK) {
      const node = unpackFrom('<i', this.data, p)[0];
      p += 4 + 4 + 8 + 2 + (node ? 4 : 0);        // node, state node, probe mask, latent action, code offset
    }
    // ponytail: name-based component check; real UE3 asks the class hierarchy
    if (this.classOf(e).endsWith('Component')) p += 4;   // template owner class
    return p;
  }

  * properties(e) {                               // [name, type, struct name, value offset, size] per tagged property
    this.pos = this.netIndexAt(e) + 4;
    const end = e.off + e.size;
    while (this.pos < end) {
      const name = this.fname();
      if (name === 'None') return;
      const ptype = this.fname();
      let [size] = this.unpack('<ii');
      let structName = null;
      if (ptype === 'StructProperty') structName = this.fname();
      else if (ptype === 'ByteProperty') this.fname();
      else if (ptype === 'BoolProperty') size = 1;
      yield [name, ptype, structName, this.pos, size];
      this.pos += size;
    }
  }

  skipProperties(e) {                             // leaves pos just after the property list
    for (const _ of this.properties(e));
    return this.pos;
  }

  prop(e, wanted) {
    for (const [name, ptype, structName, off, size] of this.properties(e)) {
      if (name === wanted) return [ptype, structName, off, size];
    }
    return null;
  }

  setImportOuter(k, outer) {                      // in place: import k (28 bytes each) moves to another package
    packInto('<i', this.data, this.importsAt + 28 * k + 16, outer);
    packInto('<i', this.importTable, 28 * k + 16, outer);
    this.imports[k].outer = outer;
  }

  get(e, name, fmt) {
    const p = this.prop(e, name);
    return p ? unpackFrom(fmt, this.data, p[2]) : null;
  }

  set(e, name, fmt, ...values) {                  // in place; sizes never change, so offsets stay valid
    const p = this.prop(e, name);
    if (!p || p[3] !== calcsize(fmt)) throw new MissingProperty(`${e.name} has no ${name} of size ${calcsize(fmt)}`);
    packInto(fmt, this.data, p[2], ...values);
  }

  meshOf(actor) {
    const comp = this.get(actor, 'StaticMeshComponent', '<i');
    if (!comp || comp[0] <= 0) return null;
    const mesh = this.get(this.exports[comp[0] - 1], 'StaticMesh', '<i');
    return mesh ? this.ref(mesh[0]) : null;
  }

  nativeBounds(e) {                               // origin + extent of the FBoxSphereBounds StaticMesh and Model store
    return unpackFrom('<6f', this.data, this.skipProperties(e));
  }

  shape(actor, cache) {                           // [export index, local bounds] of an actor's mesh or brush
    const ref = this.get(actor, 'StaticMeshComponent', '<i') || this.get(actor, 'CollisionComponent', '<i');
    if (!ref || ref[0] <= 0) return [null, null];
    const comp = this.exports[ref[0] - 1];
    const shape = this.get(comp, 'StaticMesh', '<i') || this.get(comp, 'Brush', '<i');
    if (!shape || shape[0] <= 0) return [null, null];
    if (!cache.has(shape[0])) cache.set(shape[0], this.nativeBounds(this.exports[shape[0] - 1]));
    return [shape[0] - 1, cache.get(shape[0])];
  }

  meshTriangles(index) {                          // raw triangle corners of a StaticMesh, 9 floats per triangle
    const e = this.exports[index];
    if (this.classOf(e) !== 'StaticMesh') throw new Error(`${e.name} is not a StaticMesh`);
    let p = this.skipProperties(e) + 28 + 4 + 24;   // bounds, body setup, kDOP root bound
    for (let k = 0; k < 2; k++) {                 // kDOP nodes and triangles (bulk-serialized arrays)
      const [elem, count] = unpackFrom('<ii', this.data, p);
      p += 8 + elem * count;
    }
    // ponytail: finds the first inline bulk block near the kDOP end (24 bytes on all maps seen); a full
    // FStaticMeshRenderData parser would remove the window scan
    for (let q = p; q < p + 64; q++) {
      const [, count, size, offset] = unpackFrom('<Iiii', this.data, q);
      if (offset === q + 16 && count > 0 && size % count === 0 && size / count >= 36) {
        const stride = size / count, out = new Float32Array(9 * count);
        for (let t = 0; t < count; t++) out.set(unpackFrom('<9f', this.data, q + 16 + t * stride), 9 * t);
        return out;
      }
    }
    throw new Error(`no raw triangle block in ${e.name}`);
  }

  levelList() {                                   // export indices of the actors the level spawns
    const at = this.skipProperties(this.exports[this.levelIndex()]);
    const count = unpackFrom('<i', this.data, at + 4)[0];
    return unpackFrom(`<${count}i`, this.data, at + 8).filter(r => r > 0).map(r => r - 1);
  }

  levelActors() {
    const cache = new Map(), actors = [];
    for (const i of this.levelList().sort((a, b) => a - b)) {
      const e = this.exports[i], cls = this.classOf(e);
      if (cls === 'WorldInfo' || cls === 'ReachSpec') continue;
      const scale = this.get(e, 'DrawScale', '<f');
      const [shape, bounds] = this.shape(e, cache);
      // the mesh component's own Scale3D and Scale, which multiply the actor's (Leth sizes road pieces this way)
      const comp = this.get(e, 'StaticMeshComponent', '<i')?.[0], c = comp > 0 ? this.exports[comp - 1] : null;
      const inner = c ? (this.get(c, 'Scale3D', '<3f') || [1, 1, 1]).map(v => v * (this.get(c, 'Scale', '<f')?.[0] ?? 1)) : [1, 1, 1];
      actors.push({
        i, name: e.name, cls, mesh: this.meshOf(e),
        loc: this.get(e, 'Location', '<3f') || [0, 0, 0], rot: this.get(e, 'Rotation', '<3i') || [0, 0, 0],
        scale3d: this.get(e, 'DrawScale3D', '<3f') || [1, 1, 1], scale: scale ? scale[0] : 1, inner, bounds,
        meshIndex: shape !== null && this.classOf(this.exports[shape]) === 'StaticMesh' ? shape : null,
      });
    }
    return actors;
  }

  zoneTemplate() {                                // a trigger zone about 1000 units wide to copy for checkpoints
    let best = null;
    const cache = new Map();
    this.exports.forEach((e, i) => {
      if (this.classOf(e) !== 'TriggerVolume') return;
      const [, bounds] = this.shape(e, cache);
      const off = b => Math.abs(Math.max(...b.slice(3, 6)) - 500);
      if (bounds && (best === null || off(bounds) < off(best.bounds))) best = { i, bounds };
    });
    return best;
  }

  palette(actors) {                               // one placeable entry per mesh, copying an existing user of it
    const best = new Map();
    for (const a of actors) {
      if (a.meshIndex === null) continue;
      if (!best.has(a.meshIndex)) best.set(a.meshIndex, { mesh: a.mesh, meshIndex: a.meshIndex, count: 0, template: a.i });
      best.get(a.meshIndex).count += 1;
    }
    const key = e => e.mesh.toLowerCase();
    return [...best.values()].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  }

  // Surfaces to offer: the materials the map's mesh components use, most used first, then the map's other
  // material instances and the game materials it refers to (but not skies and engine stand-ins)
  materials() {
    const used = new Map();
    for (const e of this.exports) {
      const p = this.classOf(e) === 'StaticMeshComponent' ? this.prop(e, 'Materials') : null;
      if (!p) continue;
      const n = unpackFrom('<i', this.data, p[2])[0];
      for (const r of unpackFrom(`<${n}i`, this.data, p[2] + 4)) if (r) used.set(r, (used.get(r) || 0) + 1);
    }
    const surface = /^(Material|MaterialInstanceConstant)$/, skip = /sky|^DefaultMaterial$|LevelColoration|TexturePaint/i;
    const more = [...this.exports.map((e, i) => e.outer === 0 && this.classOf(e) === 'MaterialInstanceConstant' ? i + 1 : 0),
                  ...this.imports.map((im, i) => surface.test(im.cls) && !skip.test(im.name) ? -(i + 1) : 0)].filter(r => r && !used.has(r));
    return [...[...used].sort((a, b) => b[1] - a[1]).map(([ref]) => ref), ...more].map(ref => ({ ref, name: this.ref(ref) }));
  }

  // A material instance that only tints its parent (one vector setting, "Color"): [export index, offset of the
  // colour's 4 floats from the object's start], or null
  tintable() {
    for (const [i, e] of this.exports.entries()) {
      const p = this.classOf(e) === 'MaterialInstanceConstant' ? this.prop(e, 'VectorParameterValues') : null;
      if (!p || unpackFrom('<i', this.data, p[2])[0] !== 1) continue;
      let color = false, at = null;
      for (this.pos = p[2] + 4; this.pos < p[2] + p[3];) {
        const name = this.fname();
        if (name === 'None') break;
        const ptype = this.fname(), [size] = this.unpack('<ii'), struct = ptype === 'StructProperty' ? this.fname() : null;
        if (name === 'ParameterName') color = this.names[unpackFrom('<i', this.data, this.pos)[0]] === 'Color';
        if (name === 'ParameterValue' && struct === 'LinearColor' && size === 16) at = this.pos - e.off;
        this.pos += size;
      }
      if (color && at !== null) return [i, at];
    }
    return null;
  }

  apply(edits) {                                  // in place; returns {i: values} for properties an object lacks
    const missing = new Map();
    for (const edit of edits) {
      const e = this.exports[edit.i];
      for (const [name, [fmt, value]] of Object.entries(editValues(edit))) {
        try {
          this.set(e, name, fmt, ...value);
        } catch (err) {
          if (!(err instanceof MissingProperty)) throw err;
          if (!missing.has(edit.i)) missing.set(edit.i, {});
          missing.get(edit.i)[name] = [fmt, value];
        }
      }
    }
    return missing;
  }

  objectBytes(i) {
    const e = this.exports[i];
    return this.data.subarray(e.off, e.off + e.size);
  }

  levelIndex() { return this.exports.findIndex(e => this.classOf(e) === 'Level'); }

  dependsBlob() {
    let p = this.dependsOff;
    for (let k = 0; k < this.exports.length; k++) p += 4 + 4 * unpackFrom('<i', this.data, p)[0];
    return this.data.subarray(this.dependsOff, p);
  }
}

class MissingProperty extends Error {}

const FIELDS = { loc: ['Location', '<3f'], rot: ['Rotation', '<3i'], scale3d: ['DrawScale3D', '<3f'], scale: ['DrawScale', '<f'] };
const STRUCTS = { Location: 'Vector', Rotation: 'Rotator', DrawScale3D: 'Vector' };

export function editValues(edit) {                // {property: [fmt, values]} for the transform keys of an editor edit
  const values = {};
  for (const [key, [name, fmt]] of Object.entries(FIELDS)) {
    if (!(key in edit)) continue;
    const v = Array.isArray(edit[key]) ? edit[key] : [edit[key]];
    values[name] = [fmt, fmt.includes('i') ? v.map(x => pyRound(x)) : [...v]];
  }
  return values;
}

// New and replaced objects, written after everything else on save. Existing bytes never move, so the absolute
// offsets stored inside meshes and textures stay valid; only the export and depends tables, the level's actor
// list and the new objects are appended at the end of the file.
export class Additions {
  constructor(pkg) {
    this.pkg = pkg;
    this.replaced = new Map();                    // export index -> new object bytes
    this.added = [];                              // [export table entry, object bytes]
    this.nextNumber = new Map();                  // name index -> next free FName number
    this.newNames = [];
    this.levelListAt = undefined;                 // where the Level's actor list starts in its data, once known
    this.newImports = [];                         // raw import table entries
    this.importInfo = [];                         // and what each one is: {cls, outer, name}
    this.bulkAt = new Map();                      // added object position -> inline bulk headers storing a file offset
  }

  name(text) {                                    // [name index, number], adding the base string when missing
    let base = text, number = 0;
    const cut = text.lastIndexOf('_'), head = cut >= 0 ? text.slice(0, cut) : '', tail = cut >= 0 ? text.slice(cut + 1) : '';
    if (head && /^\d+$/.test(tail) && !tail.startsWith('0') && !this.pkg.names.includes(text)) [base, number] = [head, +tail + 1];
    const names = [...this.pkg.names, ...this.newNames];
    if (!names.includes(base)) {
      this.newNames.push(base);
      names.push(base);
    }
    return [names.indexOf(base), number];
  }

  fname(text) { return pack('<ii', ...this.name(text)); }

  findImport(name, cls, outer = null) {           // Unreal names are case-insensitive ("tagame"); `outer` null: in anything
    const match = imp => imp.name.toLowerCase() === name.toLowerCase() && imp.cls === cls && (outer === null || imp.outer === outer);
    const k = this.pkg.imports.findIndex(match), n = this.importInfo.findIndex(match);
    return k >= 0 ? -(k + 1) : n >= 0 ? -(this.pkg.imports.length + n + 1) : null;
  }

  // reference to a script class of `packageName`, importing it when the map never used it (an import of the same
  // name in another package, as older saves made for TAGame's Kismet classes, doesn't count: the game can't find it)
  classRef(className, packageName) {
    let outer = this.findImport(packageName, 'Package');
    let ref = outer === null ? null : this.findImport(className, 'Class', outer);
    if (ref === null) {
      if (outer === null) outer = this.addImport('Core', 'Package', 0, packageName);
      ref = this.addImport('Core', 'Class', outer, className);
    }
    return ref;
  }

  addImport(classPackage, className, outer, name) {
    this.newImports.push(concat(this.fname(classPackage), this.fname(className), pack('<i', outer), this.fname(name)));
    this.importInfo.push({ cls: className, outer, name });
    return -(this.pkg.imports.length + this.newImports.length);
  }

  // Object `ref` of another package `src` brought into this one (a material from another map, with the textures
  // it uses): an import by its path, an export copied whole at the top of the package after everything it refers
  // to. Names are 8 bytes in any package, so re-pointing them at this package's names keeps the layout byte for
  // byte, and inline bulk data (texture mips) only needs its file offset filled in. Returns the reference here.
  // `done` maps source references to ones here, to use instead of copying them; `rename` names the copy of `ref`.
  copyFrom(src, ref, done = new Map(), rename = null) {
    if (!ref) return 0;
    if (done.has(ref)) return done.get(ref);
    if (ref < 0) {
      const im = src.imports[-ref - 1], outer = this.copyFrom(src, im.outer, done);
      const out = this.findImport(im.name, im.cls, outer) ?? this.addImport(im.classPackage, im.cls, outer, im.name);
      done.set(ref, out);
      return out;
    }
    const e = src.exports[ref - 1], blob = src.data.slice(e.off, e.off + e.size), at = q => q - e.off, names = src.names;
    const name = q => {                           // re-point the FName at blob offset q
      const [k, number] = unpackFrom('<ii', blob, q);
      packInto('<ii', blob, q, this.name(names[k])[0], number);
    };
    const object = q => packInto('<i', blob, q, this.copyFrom(src, unpackFrom('<i', blob, q)[0], done));
    const fname = q => { const k = unpackFrom('<i', blob, q)[0]; name(q); return names[k]; };
    // ponytail: what it refers to is copied first, so objects referring to each other in a loop aren't supported
    walkTags(blob, at(src.netIndexAt(e)) + 4, blob.length, fname, t => {
      if (REFERENCES.has(t.type)) object(t.at);   // int array items too: object refs (no other int arrays seen)
      else if (t.type === 'NameProperty' || (t.type === 'ByteProperty' && t.size === 8)) name(t.at);
    }, t => startsTag(blob, names, t.at + 4, t.at + t.size));
    const added = this.addObject(this.copyFrom(src, e.cls, done), 0, rename ?? src.names[e.nameRaw[0]], blob, e.flags, bulkHeaders(src, e), { netAt: at(src.netIndexAt(e)) });
    done.set(ref, added + 1);
    return added + 1;
  }

  // A brand-new object whose blob holds a NetIndex placeholder at `netAt` (0 for a plain object such as a Kismet
  // node, after the state frame or component header otherwise); returns its export index. bulkAt lists offsets of
  // inline bulk headers in the blob, whose absolute file offset gets filled in on save. `archetype`: the object
  // reference of its template, for a component the class defaults' one.
  addObject(classRef, outerRef, baseName, blob, flags = 0x0007000100000000n, bulkAt = [], { netAt = 0, archetype = 0 } = {}) {
    const [index] = this.name(baseName);
    const entry = concat(pack('<3i', classRef, 0, outerRef), pack('<ii', index, this.uniqueNumber(index)),
      pack('<iQiiIi', archetype, flags, 0, 0, 0, 0), new Uint8Array(16), pack('<I', 0));
    const added = this.pkg.exports.length + this.added.length;
    blob = blob.slice();
    packInto('<i', blob, netAt, added);
    if (bulkAt.length) this.bulkAt.set(this.added.length, [...bulkAt]);
    this.added.push([entry, blob]);
    return added;
  }

  // the template a class's defaults keep for one of its components (Engine.Default__<class>.<name>), imported
  templateRef(className, name, componentClass) {
    const engine = this.findImport('Engine', 'Package') ?? this.addImport('Core', 'Package', 0, 'Engine');
    const defaults = this.findImport(`Default__${className}`, className, engine) ?? this.addImport('Engine', className, engine, `Default__${className}`);
    return this.findImport(name, componentClass, defaults) ?? this.addImport('Engine', componentClass, defaults, name);
  }

  // A new level actor of Engine class `className` and its one component, made from the class defaults' `template`
  // (as UDK saves lights and InterpActors): `actorTags(componentRef)` and `componentTags` are lists of tags, `tail`
  // the component's native data. Returns the actor's export index.
  addActor(className, componentClass, template, actorTags, componentTags, tail = new Uint8Array(0)) {
    const actorClass = this.classRef(className, 'Engine'), componentClassRef = this.classRef(componentClass, 'Engine');
    const at = this.pkg.exports.length + this.added.length, props = list => concat(...list, this.fname('None'));
    this.addObject(actorClass, this.pkg.levelIndex() + 1, className, concat(pack('<iiQhi', actorClass, actorClass, PROBE, 0, -1), pack('<i', 0),
      props(actorTags(at + 2))), 0x0207000100000000n, [], { netAt: 22 });
    this.addObject(componentClassRef, at + 1, componentClass, concat(pack('<ii', 0, 0), props(componentTags), tail), 0x0007000100000000n, [],
                   { netAt: 4, archetype: this.templateRef(className, template, componentClass) });
    this.levelListChange(refs => [...refs, at + 1]);
    return at;
  }

  tag(name, ptype, body, structName = null) {     // one tagged property: name, type, size, array index, struct name, value
    const size = ptype === 'BoolProperty' ? 0 : body.length;
    return concat(this.fname(name), this.fname(ptype), pack('<ii', size, 0), structName ? this.fname(structName) : new Uint8Array(0), body);
  }

  transformTags(values) {                         // {name: tag bytes} for transform values ({prop: [fmt, values]})
    const tags = {};
    for (const [name, [fmt, v]] of Object.entries(values)) {
      tags[name] = this.tag(name, STRUCTS[name] ? 'StructProperty' : 'FloatProperty', pack(fmt, ...v), STRUCTS[name]);
    }
    return tags;
  }

  // `blob` (an export's bytes, or a copy with the same layout) with whole property tags replaced or appended,
  // and optionally the native data after the properties replaced too.
  withProps(e, blob, tags, tail = null) {
    const start = this.pkg.netIndexAt(e) + 4 - e.off;
    const parts = [blob.subarray(0, start)], seen = new Set();
    let end = start;
    for (const [name, , , off, size] of this.pkg.properties(e)) {
      const stop = off - e.off + size;
      parts.push(Object.hasOwn(tags, name) ? tags[name] : blob.subarray(end, stop));
      seen.add(name);
      end = stop;
    }
    const noneEnd = this.pkg.pos - e.off;
    for (const [name, t] of Object.entries(tags)) if (!seen.has(name)) parts.push(t);
    parts.push(blob.subarray(end, noneEnd), tail === null ? blob.subarray(noneEnd) : tail);
    return concat(...parts);
  }

  setProps(i, tags) {                             // replace or add whole property tags on an existing object
    if (this.replaced.has(i)) throw new Error(`${this.pkg.exports[i].name} was already rewritten`);
    this.replaced.set(i, this.withProps(this.pkg.exports[i], this.pkg.objectBytes(i), tags));
  }

  setValues(i, values) { this.setProps(i, this.transformTags(values)); }

  replaceRange(i, from, to, bytes) {               // file offsets [from, to) of object i's data become `bytes`
    if (this.replaced.has(i)) throw new Error(`${this.pkg.exports[i].name} was already rewritten`);
    const e = this.pkg.exports[i], blob = this.pkg.objectBytes(i);
    this.replaced.set(i, concat(blob.subarray(0, from - e.off), bytes, blob.subarray(to - e.off)));
  }

  clearRefs(i, prop) { this.appendRefs(i, prop, [], false); }

  // add object references to an existing object's array property; `keep` (true, false, or a test of each
  // reference) decides which of those already there stay
  appendRefs(i, prop, refs, keep = true) {
    const e = this.pkg.exports[i];
    if (!this.replaced.has(i)) this.replaced.set(i, this.pkg.objectBytes(i).slice());
    const found = [...this.pkg.properties(e)].find(([name, ptype]) => name === prop && ptype === 'ArrayProperty');
    if (!found) throw new Error(`${e.name} has no array ${prop}`);
    const rel = found[3] - e.off;                 // earlier changes only ever touch bytes after this array's start
    let blob = this.replaced.get(i);
    const count = unpackFrom('<i', blob, rel)[0];
    const all = [...unpackFrom(`<${count}i`, blob, rel + 4)];
    const old = keep === true ? all : keep === false ? [] : all.filter(keep);
    const next = [...old, ...refs];
    blob = concat(blob.subarray(0, rel), pack(`<i${next.length}i`, next.length, ...next), blob.subarray(rel + 4 + 4 * count));
    packInto('<i', blob, rel - 8, 4 + 4 * next.length);   // tag: name, type, size, array index
    this.replaced.set(i, blob);
  }

  uniqueNumber(nameIndex) {
    if (!this.nextNumber.size) {
      for (const e of this.pkg.exports) {
        const [index, number] = e.nameRaw;
        this.nextNumber.set(index, Math.max(this.nextNumber.get(index) || 0, number + 1));
      }
    }
    const number = this.nextNumber.get(nameIndex) || 1;
    this.nextNumber.set(nameIndex, number + 1);
    return number;
  }

  remap(e, blob, remap, offset = null, values = null) {
    for (const [name, ptype, , off, size] of this.pkg.properties(e)) {
      const rel = off - e.off;
      if (values && Object.hasOwn(values, name) && size === calcsize(values[name][0])) {
        packInto(values[name][0], blob, rel, ...values[name][1]);
      } else if (ptype === 'ObjectProperty') {
        const ref = unpackFrom('<i', blob, rel)[0];
        packInto('<i', blob, rel, remap.has(ref) ? remap.get(ref) : ref);
      } else if (ptype === 'ArrayProperty') {
        const n = unpackFrom('<i', blob, rel)[0];
        if (size === 4 + 4 * n) {                 // object-ref arrays such as Components; other values never match remap
          const refs = unpackFrom(`<${n}i`, blob, rel + 4);
          packInto(`<${n}i`, blob, rel + 4, ...refs.map(r => remap.has(r) ? remap.get(r) : r));
        }
      } else if (name === 'Location' && offset) {
        const [x, y, z] = unpackFrom('<3f', blob, rel);
        packInto('<3f', blob, rel, x + offset[0], y + offset[1], z + offset[2]);
      }
    }
  }

  // Copy a placed actor and its components; `values` ({prop: [fmt, values]}) sets the copy's transform, adding
  // properties the original lacks. `kidProps` ({export index of the actor or a component: [tags, tail]}) rewrites
  // a copied object (see withProps). `cls` makes the copy an actor of that Engine class, its components made from
  // that class's defaults (a TriggerVolume copied as a GravityVolume). Returns the copy's export index.
  duplicate(i, offset = [0, 0, 0], values = null, kidProps = null, cls = null) {
    const pkg = this.pkg, src = pkg.exports[i];
    const newRef = pkg.exports.length + this.added.length + 1;   // object references are 1-based
    const kids = [];
    pkg.exports.forEach((e, k) => { if (e.outer === i + 1) kids.push(k); });
    const remap = new Map([[i + 1, newRef], ...kids.map((k, n) => /** @type {[number, number]} */ ([k + 1, newRef + 1 + n]))]);
    const present = new Set([...pkg.properties(src)].map(([name]) => name));
    const clsRef = cls && this.classRef(cls, 'Engine');
    for (const [k, ref] of [[i, newRef], ...kids.map(k => [k, remap.get(k + 1)])]) {
      const e = pkg.exports[k];
      let blob = pkg.data.slice(e.off, e.off + e.size);
      if (e === src) this.remap(e, blob, remap, offset, values);
      else this.remap(e, blob, remap);
      packInto('<i', blob, pkg.netIndexAt(e) - e.off, ref - 1);
      const absent = e === src && values ? this.transformTags(Object.fromEntries(Object.entries(values).filter(([n]) => !present.has(n)))) : {};
      const [tags, tail] = kidProps?.[k] ?? [{}, null];
      if (Object.keys(absent).length || Object.keys(tags).length || tail !== null) blob = this.withProps(e, blob, { ...absent, ...tags }, tail);
      const entry = e.entry.slice();
      if (e === src) {
        const nameIndex = cls ? this.name(cls)[0] : src.nameRaw[0];
        packInto('<ii', entry, 12, nameIndex, this.uniqueNumber(nameIndex));
      } else packInto('<i', entry, 8, newRef);    // outer: the copied actor
      if (clsRef && e === src) {
        packInto('<i', entry, 0, clsRef);
        if (unpackFrom('<i', blob, 0)[0] === src.cls) packInto('<ii', blob, 0, clsRef, clsRef);   // the state frame's nodes: the class
      }
      const arch = unpackFrom('<i', entry, 20)[0];
      if (clsRef && e !== src && arch < 0) {
        const t = pkg.imports[-arch - 1];
        packInto('<i', entry, 20, this.templateRef(cls, t.name, t.cls));
      }
      this.added.push([entry, blob]);
    }
    this.levelListChange(refs => [...refs, newRef]);
    return newRef - 1;
  }

  remove(i) { this.levelListChange(refs => refs.map(r => r === i + 1 ? 0 : r)); }   // the object stays, never spawned

  levelListChange(change) {
    const pkg = this.pkg, li = pkg.levelIndex(), level = pkg.exports[li];
    // the list comes first in the Level's data, so a replaceRange further on leaves its place as it was
    this.levelListAt ??= pkg.skipProperties(level) - level.off + 4;   // after the TTransArray owner ref
    if (!this.replaced.has(li)) this.replaced.set(li, pkg.objectBytes(li).slice());
    const blob = this.replaced.get(li), at = this.levelListAt;
    const count = unpackFrom('<i', blob, at)[0];
    const refs = change(unpackFrom(`<${count}i`, blob, at + 4));
    this.replaced.set(li, concat(blob.subarray(0, at), pack(`<i${refs.length}i`, refs.length, ...refs), blob.subarray(at + 4 + 4 * count)));
  }

  save() {                                        // the whole new package as bytes
    const pkg = this.pkg, head = pkg.data.slice(), tail = [];
    let length = head.length;
    const place = blob => { tail.push(blob); length += blob.length; return length - blob.length; };
    const entries = pkg.exports.map(e => e.entry.slice());
    for (const [i, blob] of this.replaced) {
      const e = pkg.exports[i], at = place(blob), shift = blob.length - e.size;
      // an inline bulk data header holds its data's file offset (as compact.js finds them): re-point the ones of an
      // object whose properties grew, such as a mesh given a BodySetup
      for (let q = 0; q + 16 <= e.size; q++) {
        const was = e.off + q + 16;
        if (unpackFrom('<i', pkg.data, e.off + q + 12)[0] === was && q + shift + 16 <= blob.length && unpackFrom('<i', blob, q + shift + 12)[0] === was) {
          packInto('<i', blob, q + shift + 12, at + q + shift + 16);
        }
      }
      packInto('<ii', entries[i], 32, blob.length, at);   // SerialSize, SerialOffset
    }
    this.added.forEach(([entry, blob], n) => {
      for (const at of this.bulkAt.get(n) || []) packInto('<i', blob, at + 12, length + at + 16);
      packInto('<ii', entry, 32, blob.length, place(blob));
      entries.push(entry);
    });
    const exportOff = place(concat(...entries));
    const dependsOff = place(concat(pkg.dependsBlob(), new Uint8Array(4 * this.added.length)));
    const s = pkg.summaryAt;
    if (this.newNames.length) {
      const table = this.newNames.map(n => concat(pack('<i', n.length + 1), latin1Bytes(n), new Uint8Array(1), pack('<Q', 0x0007001000000000n)));
      packInto('<ii', head, s + 4, pkg.names.length + this.newNames.length, place(concat(pkg.nameTable, ...table)));
      packInto('<i', head, pkg.lastGenerationAt + 4, pkg.names.length + this.newNames.length);
    }
    if (this.newImports.length) {
      packInto('<ii', head, s + 20, pkg.imports.length + this.newImports.length, place(concat(pkg.importTable, ...this.newImports)));
    }
    packInto('<i', head, s + 12, entries.length);                // ExportCount
    packInto('<i', head, s + 16, exportOff);
    packInto('<i', head, s + 28, dependsOff);
    packInto('<i', head, pkg.lastGenerationAt, entries.length);
    packInto('<i', head, pkg.lastGenerationAt + 8, entries.length);   // NetObjectCount
    return concat(head, ...tail);
  }
}

