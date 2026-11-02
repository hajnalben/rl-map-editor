// Compaction: rewrite a map so it carries only what it still uses. Every object keeps its place in the export
// table (references are export numbers, also inside native data we can't parse), but meshes and textures nothing
// needs any more are swapped for tiny valid stand-ins, and superseded copies left by append-only saves are dropped.
import { concat, pack, packInto, unpackFrom } from './bytes.js';
import { geometryMesh, read, write } from './mesh.js';
import { Package } from './ue3.js';

const HAS_STACK = 0x0200000000000000n;           // actors carry a script state frame
const MATERIALISH = /Material/;                   // classes that point at textures from their native data
const PAYLOAD = /Texture|Sound|Swf/;              // native data is pixels, audio or a movie: no references in it
const ATOMIC = new Set(['Vector', 'Rotator', 'Color', 'LinearColor', 'Vector2D', 'IntPoint', 'Guid', 'Plane', 'Quat', 'Box']);
const TINY_TEXTURE = { PF_DXT1: 8, PF_DXT3: 16, PF_DXT5: 16, PF_G8: 16, PF_V8U8: 32, PF_A8R8G8B8: 64 };   // bytes of a 4x4 mip

function arrayRefs(pkg, e, name) {
  const p = pkg.prop(e, name);
  if (!p) return [];
  const n = unpackFrom('<i', pkg.data, p[2])[0];
  return p[3] === 4 + 4 * n ? unpackFrom(`<${n}i`, pkg.data, p[2] + 4) : [];
}

// Object references in tagged properties: [start, end) holds a property list; structs and arrays of structs nest.
function taggedRefs(pkg, start, end, out) {
  const d = pkg.data, names = pkg.names;
  let p = start;
  const fname = q => { const [i, n] = unpackFrom('<ii', d, q); return names[i] === undefined ? null : n ? `${names[i]}_${n - 1}` : names[i]; };
  const tagged = q => q + 8 <= end && unpackFrom('<i', d, q)[0] >= 0 && unpackFrom('<i', d, q)[0] < names.length &&
    (names[unpackFrom('<i', d, q)[0]] === 'None' || (names[unpackFrom('<i', d, q + 8)[0]] || '').endsWith('Property'));
  while (p + 8 <= end) {
    const name = fname(p);
    if (name === null) return;
    p += 8;
    if (name === 'None') return p;
    const ptype = fname(p), [size] = unpackFrom('<ii', d, p + 8);
    p += 16;
    let struct = null;
    if (ptype === 'StructProperty' || ptype === 'ByteProperty') { struct = fname(p); p += 8; }
    if (ptype === 'BoolProperty') { p += 1; continue; }
    if (['ObjectProperty', 'ComponentProperty', 'ClassProperty', 'InterfaceProperty'].includes(ptype)) out.push(unpackFrom('<i', d, p)[0]);
    else if (ptype === 'StructProperty' && !ATOMIC.has(struct)) taggedRefs(pkg, p, p + size, out);
    else if (ptype === 'ArrayProperty' && size >= 4) {
      const n = unpackFrom('<i', d, p)[0];
      if (n > 0 && tagged(p + 4)) {
        let q = p + 4;
        for (let k = 0; k < n && q; k++) q = taggedRefs(pkg, q, p + size, out);
      } else if (size === 4 + 4 * n) out.push(...unpackFrom(`<${n}i`, d, p + 4));   // object refs, or ints: kept either way
    }
    p += size;
  }
  return p;
}

function nativeScan(pkg, from, to, out) {         // any int32 that could be an export reference, at every offset
  const n = pkg.exports.length, dv = new DataView(pkg.data.buffer, pkg.data.byteOffset, pkg.data.byteLength);
  for (let q = from; q + 4 <= to; q++) {
    const v = dv.getInt32(q, true);
    if (v > 0 && v <= n) out.push(v);
  }
}

// Export indices the map still needs: the level's spawned actors and everything inside them, its BSP, the
// scripts it runs, and whatever those reference.
export function needed(pkg) {
  const n = pkg.exports.length, li = pkg.levelIndex();
  const outerChain = i => { const out = []; for (let o = pkg.exports[i].outer; o > 0; o = pkg.exports[o - 1].outer) out.push(o - 1); return out; };
  const live = new Set(pkg.levelList());
  const isActor = i => (pkg.exports[i].flags & HAS_STACK) !== 0n;
  // actors placed in the level but no longer spawned; actors elsewhere are archetypes that scripts may load by name
  const deadActor = k => isActor(k) && pkg.exports[k].outer === li + 1 && !live.has(k);
  const inDeadActor = i => [i, ...outerChain(i)].some(deadActor);
  const liveScripts = new Set();
  const main = pkg.exports.findIndex(e => pkg.classOf(e) === 'Sequence' && e.outer === li + 1);
  for (const queue = main >= 0 ? [main] : []; queue.length;) {
    const s = queue.pop();
    if (liveScripts.has(s)) continue;
    liveScripts.add(s);
    for (const r of arrayRefs(pkg, pkg.exports[s], 'SequenceObjects')) if (r > 0) queue.push(r - 1);
  }
  const deadScript = i => pkg.classOf(pkg.exports[i]).startsWith('Seq') && !liveScripts.has(i);

  const marked = new Set(), queue = [];
  const mark = (i, fromNative = false, source = null) => {
    if (i < 0 || i >= n || marked.has(i) || inDeadActor(i) || deadScript(i)) return;
    const cls = pkg.classOf(pkg.exports[i]);
    if (fromNative && (cls === 'StaticMesh' || (cls === 'Texture2D' && !MATERIALISH.test(source)))) return;   // too likely a stray number
    marked.add(i);
    queue.push(i);
  };
  mark(li);
  for (const i of live) mark(i);
  for (const i of liveScripts) mark(i);
  pkg.exports.forEach((e, i) => {
    if (e.outer === li + 1 && !isActor(i) && !pkg.classOf(e).startsWith('Seq')) mark(i);   // BSP model, its components
    if (outerChain(i).some(o => live.has(o))) mark(i);                                     // components of spawned actors
    if (isActor(i) && e.outer !== li + 1) mark(i);                                         // archetypes
  });
  while (queue.length) {
    const i = queue.pop(), e = pkg.exports[i], cls = pkg.classOf(e);
    for (const o of outerChain(i)) mark(o);
    if (i === li) continue;                       // its native data lists every mesh and texture ever used (caches)
    const refs = [], tagStart = pkg.netIndexAt(e) + 4, end = e.off + e.size;
    const tagEnd = taggedRefs(pkg, tagStart, end, refs) ?? end;
    for (const r of refs) if (r > 0) mark(r - 1);
    if (PAYLOAD.test(cls)) continue;
    const native = [];
    if (cls === 'StaticMesh') {
      try {
        const m = read(pkg, i);
        native.push(m.bodySetup, ...m.sections.map(s => s.fields[0]));
        nativeScan(pkg, end - m.tail.length, end, native);
      } catch { nativeScan(pkg, tagEnd, end, native); }
    } else nativeScan(pkg, tagEnd, end, native);
    for (const r of native) if (r > 0) mark(r - 1, true, cls);
  }
  return marked;
}

function tinyMesh(pkg, i) {
  const m = read(pkg, i);
  const tangents = [[[1, 0, 0], [0, 1, 0]], [[1, 0, 0], [0, 1, 0]], [[1, 0, 0], [0, 1, 0]]];
  const [blob, rawAt] = write(geometryMesh(m, [[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 0], [0, 0], [0, 0]], [[0, 0], [0, 0], [0, 0]],
                                           [[0, 0, 1], [0, 0, 1], [0, 0, 1]], tangents, [[0, 2, 1]]));
  return [blob, [rawAt]];
}

export const bulkAt = (pkg, q) => {                      // an inline bulk header at q: its data starts right after it
  const [flags, count, size, off] = unpackFrom('<Iiii', pkg.data, q);
  return off === q + 16 && flags < 0x1000 && count >= 0 && size >= 0 ? size : null;
};

function tinyTexture(pkg, i) {                    // one blank 4x4 mip; the source art and big mips go
  const e = pkg.exports[i], format = pkg.get(e, 'Format', '<i');
  const block = format && TINY_TEXTURE[pkg.names[format[0]]];
  if (!block) return null;
  const head = pkg.data.slice(e.off, pkg.skipProperties(e)), end = e.off + e.size;
  for (const [name, , , off] of pkg.properties(e)) {
    if (name === 'SizeX' || name === 'SizeY') packInto('<i', head, off - e.off, 4);
    if (name === 'MipTailBaseIdx') packInto('<i', head, off - e.off, 0);
  }
  let p = e.off + head.length;
  const source = bulkAt(pkg, p);
  if (source === null) return null;
  p += 16 + source;
  const mips = unpackFrom('<i', pkg.data, p)[0];
  p += 4;
  for (let k = 0; k < mips; k++) {
    const size = bulkAt(pkg, p);
    if (size === null) return null;
    p += 16 + size + 8;
  }
  if (p > end) return null;
  const tail = pkg.data.slice(p, end), headers = [head.length, head.length + 20];
  for (let q = 0; q + 16 <= tail.length; q++) if (bulkAt(pkg, p + q) !== null) headers.push(head.length + 20 + 16 + block + 8 + q);
  const blob = concat(head, pack('<Iiii', 0, 0, 0, 0), pack('<i', 1), pack('<Iiii', 0, block, block, 0), new Uint8Array(block), pack('<ii', 4, 4), tail);
  return [blob, headers];
}

function bulkHeaders(pkg, e) {                   // positions of inline bulk headers in an object (fast path of bulkAt)
  const dv = new DataView(pkg.data.buffer, pkg.data.byteOffset, pkg.data.byteLength), out = [];
  for (let q = 0; q + 16 <= e.size; q++) {
    if (dv.getInt32(e.off + q + 12, true) === e.off + q + 16 && bulkAt(pkg, e.off + q) !== null) out.push(q);
  }
  return out;
}

// The compacted package and what it saved: {bytes, before, shrunk: {meshes, textures}}.
export function compact(bytes) {
  const pkg = new Package(bytes), keep = needed(pkg);
  const first = Math.min(...pkg.exports.map(e => e.off));
  const parts = [bytes.slice(0, first)], entries = pkg.exports.map(e => e.entry.slice()), shrunk = { meshes: 0, textures: 0 };
  let length = first;
  pkg.exports.forEach((e, i) => {
    const cls = pkg.classOf(e);
    let made = null;
    if (!keep.has(i) && e.size > 4096) {
      try { made = cls === 'StaticMesh' ? tinyMesh(pkg, i) : cls === 'Texture2D' ? tinyTexture(pkg, i) : null; } catch { made = null; }
    }
    let blob, headers;
    if (made) {
      [blob, headers] = made;
      shrunk[cls === 'StaticMesh' ? 'meshes' : 'textures'] += 1;
    } else {
      blob = pkg.objectBytes(i).slice();
      headers = bulkHeaders(pkg, e);
    }
    for (const h of headers) packInto('<i', blob, h + 12, length + h + 16);
    packInto('<ii', entries[i], 32, blob.length, length);    // SerialSize, SerialOffset
    parts.push(blob);
    length += blob.length;
  });
  const place = blob => { parts.push(blob); length += blob.length; return length - blob.length; };
  const s = pkg.summaryAt, head = parts[0];
  packInto('<i', head, s + 8, place(pkg.nameTable));
  packInto('<i', head, s + 24, place(pkg.importTable));
  packInto('<i', head, s + 16, place(concat(...entries)));
  packInto('<i', head, s + 28, place(pkg.dependsBlob().slice()));
  return { bytes: concat(...parts), before: bytes.length, shrunk };
}

