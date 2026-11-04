// Read and patch Rocket League workshop maps (UDK 2015 / UE3 package version 868).
import { calcsize, concat, latin1, latin1Bytes, pack, packInto, pyRound, unpackFrom, utf16 } from './bytes.js';

const HAS_STACK = 0x0200000000000000n;           // RF_HasStack: actors carry a script state frame

export class Package {
  constructor(buffer) {
    this.data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.pos = 0;
    const [tag, ver] = this.unpack('<IHHi');
    if (tag !== 0x9E2A83C1 || ver !== 868) throw new Error('not a Rocket League workshop map (UE3 package version 868)');
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
    if (compression || chunks) throw new Error('compressed packages are not supported');

    this.pos = noff;
    this.names = [];
    for (let k = 0; k < ncount; k++) {
      this.names.push(this.fstring());
      this.pos += 8;                              // name flags
    }
    this.nameTable = this.data.slice(noff, this.pos);
    this.pos = ioff;
    this.imports = [];
    for (let k = 0; k < icount; k++) {
      this.fname();                               // class package
      const cls = this.fname(), outer = this.unpack('<i')[0];
      this.imports.push({ cls, outer, name: this.fname() });
    }
    this.importTable = this.data.slice(ioff, this.pos);
    this.pos = eoff;
    this.exports = [];
    for (let k = 0; k < ecount; k++) {
      const start = this.pos;
      const [cls, , outer] = this.unpack('<3i');
      const nameRaw = unpackFrom('<ii', this.data, this.pos);
      const name = this.fname();
      const [, flags, size, off, , nnet] = this.unpack('<iQiiIi');
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
    let comp = this.get(actor, 'StaticMeshComponent', '<i') || this.get(actor, 'CollisionComponent', '<i');
    if (!comp || comp[0] <= 0) return [null, null];
    comp = this.exports[comp[0] - 1];
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
      actors.push({
        i, name: e.name, cls, mesh: this.meshOf(e),
        loc: this.get(e, 'Location', '<3f') || [0, 0, 0], rot: this.get(e, 'Rotation', '<3i') || [0, 0, 0],
        scale3d: this.get(e, 'DrawScale3D', '<3f') || [1, 1, 1], scale: scale ? scale[0] : 1, bounds,
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

  classRef(className, packageName) {              // reference to a script class, importing it when the map never used it
    let ref = this.findImport(className, 'Class');
    if (ref === null) {
      let outer = this.findImport(packageName, 'Package');
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
  // properties the original lacks. `kidProps` ({component export index: [tags, tail]}) rewrites a copied
  // component (see withProps). Returns the copy's export index.
  duplicate(i, offset = [0, 0, 0], values = null, kidProps = null) {
    const pkg = this.pkg, src = pkg.exports[i];
    const newRef = pkg.exports.length + this.added.length + 1;   // object references are 1-based
    const kids = [];
    pkg.exports.forEach((e, k) => { if (e.outer === i + 1) kids.push(k); });
    const remap = new Map([[i + 1, newRef], ...kids.map((k, n) => [k + 1, newRef + 1 + n])]);
    const present = new Set([...pkg.properties(src)].map(([name]) => name));
    for (const [k, ref] of [[i, newRef], ...kids.map(k => [k, remap.get(k + 1)])]) {
      const e = pkg.exports[k];
      let blob = pkg.data.slice(e.off, e.off + e.size);
      if (e === src) this.remap(e, blob, remap, offset, values);
      else this.remap(e, blob, remap);
      packInto('<i', blob, pkg.netIndexAt(e) - e.off, ref - 1);
      if (e === src && values) {
        const absent = Object.fromEntries(Object.entries(values).filter(([n]) => !present.has(n)));
        blob = this.withProps(e, blob, this.transformTags(absent));
      }
      if (kidProps && Object.hasOwn(kidProps, k)) blob = this.withProps(e, blob, ...kidProps[k]);
      const entry = e.entry.slice();
      if (e === src) packInto('<i', entry, 16, this.uniqueNumber(src.nameRaw[0]));
      else packInto('<i', entry, 8, newRef);      // outer: the copied actor
      this.added.push([entry, blob]);
    }
    this.levelListChange(refs => [...refs, newRef]);
    return newRef - 1;
  }

  remove(i) { this.levelListChange(refs => refs.map(r => r === i + 1 ? 0 : r)); }   // the object stays, never spawned

  levelListChange(change) {
    const pkg = this.pkg, li = pkg.levelIndex();
    if (!this.replaced.has(li)) {
      const level = pkg.exports[li];
      this.levelListAt = pkg.skipProperties(level) - level.off + 4;   // after the TTransArray owner ref
      this.replaced.set(li, pkg.objectBytes(li).slice());
    }
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
    for (const [i, blob] of this.replaced) packInto('<ii', entries[i], 32, blob.length, place(blob));   // SerialSize, SerialOffset
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

