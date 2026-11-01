// StaticMesh native data for UE3 v868 maps: read, write, collision tree, and sculpted terrain tiles.
import { concat, pack, pyDist, pyRound, pySum, unpackFrom } from './bytes.js';

const LEAF_TRIS = 5;                              // most triangles per kDOP leaf
const RAW_TRI = 372;                              // FStaticMeshTriangle: corners, 3x8 UVs, colors, ids, 3x3 tangents, 2 flags
const UNIT = 127;                                 // kDOP node bytes shrink a child by multiples of parent extent / 127
export const rng = { bytes: n => crypto.getRandomValues(new Uint8Array(n)) };

class Reader {
  constructor(data, p) { this.data = data; this.p = p; }
  take(fmt, size) {
    const v = unpackFrom(fmt, this.data, this.p);
    this.p += size;
    return v;
  }
  bulk() {                                        // bulk-serialized array: element size, count, raw elements
    const [size, count] = this.take('<ii', 8);
    const raw = this.data.slice(this.p, this.p + size * count);
    this.p += size * count;
    return raw;
  }
}

const bulk = (size, raw) => concat(pack('<ii', size, size ? Math.floor(raw.length / size) : 0), raw);

export function read(pkg, i) {                    // every field of a StaticMesh export, enough to write it back exactly
  const e = pkg.exports[i];
  const r = new Reader(pkg.data, pkg.skipProperties(e));
  const m = { head: pkg.data.slice(e.off, r.p) };   // NetIndex + tagged properties
  m.bounds = r.take('<7f', 28);
  m.bodySetup = r.take('<i', 4)[0];
  m.root = r.take('<6f', 24);
  m.nodes = r.bulk();
  m.kdopTris = r.bulk();
  m.version = r.take('<i', 4)[0];
  m.preLod = pkg.data.slice(r.p, r.p + 16);
  r.p += 16;
  if (r.take('<i', 4)[0] !== 1) throw new Error(`${e.name}: only single-LOD meshes are supported`);
  const [flags, , size] = r.take('<Iiii', 16);
  m.rawFlags = flags;
  m.raw = pkg.data.slice(r.p, r.p + size);
  r.p += size;
  m.sections = [];
  for (let s = r.take('<i', 4)[0]; s > 0; s--) {
    const fields = r.take('<9i', 36), frags = [];
    for (let f = r.take('<i', 4)[0]; f > 0; f--) frags.push(r.take('<ii', 8));
    m.sections.push({ fields, frags, ps3: r.take('<B', 1)[0] });
  }
  [m.vertexSize] = r.take('<ii', 8);
  m.positions = r.bulk();
  [m.uvChannels, m.uvStride, , m.uvFull] = r.take('<4i', 16);
  m.uvs = r.bulk();
  const [colorStride, colors] = r.take('<ii', 8);
  m.colorStride = colorStride;
  m.colors = colors ? r.bulk() : null;
  m.numVerts = r.take('<i', 4)[0];
  m.indices = r.bulk();
  m.wire = r.bulk();
  m.adjacency = r.bulk();
  m.tail = pkg.data.slice(r.p, e.off + e.size);   // thumbnail, lighting guid, streaming factors...
  return m;
}

export function write(m) {                        // [object bytes, offset of the raw-triangle bulk header]
  const parts = [m.head, pack('<7fi6f', ...m.bounds, m.bodySetup, ...m.root), bulk(6, m.nodes), bulk(8, m.kdopTris),
    pack('<i', m.version), m.preLod, pack('<i', 1)];
  const rawAt = parts.reduce((n, p) => n + p.length, 0);
  parts.push(pack('<Iiii', m.rawFlags, Math.floor(m.raw.length / RAW_TRI), m.raw.length, 0), m.raw, pack('<i', m.sections.length));
  for (const s of m.sections) {
    parts.push(pack('<9ii', ...s.fields, s.frags.length), ...s.frags.map(f => pack('<ii', ...f)), pack('<B', s.ps3));
  }
  const verts = Math.floor(m.positions.length / 12);
  parts.push(pack('<ii', m.vertexSize, verts), bulk(12, m.positions));
  parts.push(pack('<4i', m.uvChannels, m.uvStride, verts, m.uvFull), bulk(m.uvStride, m.uvs));
  parts.push(pack('<ii', m.colorStride, m.colors ? Math.floor(m.colors.length / m.colorStride) : 0));
  if (m.colors) parts.push(bulk(m.colorStride, m.colors));
  parts.push(pack('<i', m.numVerts), bulk(2, m.indices), bulk(2, m.wire), bulk(2, m.adjacency), m.tail);
  return [concat(...parts), rawAt];
}

export function leafCount(n) {
  let leaves = 1;
  while (leaves * LEAF_TRIS < n) leaves *= 2;
  return leaves;
}

export function spans(n, leaves) {                // triangle range of every heap node; the left child takes the larger half
  const out = new Map();
  const split = (h, a, b, k) => {
    out.set(h, [a, b]);
    if (k > 1) {
      const mid = a + Math.floor((b - a + 1) / 2);
      split(2 * h + 1, a, mid, k / 2);
      split(2 * h + 2, mid, b, k / 2);
    }
  };
  split(0, 0, n, leaves);
  return out;
}

function box(points) {                           // like Python's min()/max(): the first of equal values wins
  const lo = points[0].slice(0, 3), hi = points[0].slice(0, 3);
  for (const p of points) for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
  return [lo, hi];
}

// UE3 compact kDOP tree: [root bound, node bytes, triangles reordered into leaf order]. Leaves are implicit (a
// complete binary tree over the triangle list); each internal node stores one byte per axis side saying which
// child shrinks there and by how much: 128+q shrinks the first child, 127-q the second.
export function kdop(positions, tris) {
  const leaves = leafCount(tris.length);
  const centers = tris.map(t => [0, 1, 2].map(k => pySum([positions[t[0]][k], positions[t[1]][k], positions[t[2]][k]]) / 3));
  const order = [];
  const arrange = (ids, k) => {
    if (k === 1) { order.push(...ids); return; }
    const [lo, hi] = box(ids.map(t => centers[t]));
    let axis = 0;
    for (let a = 1; a < 3; a++) if (hi[a] - lo[a] > hi[axis] - lo[axis]) axis = a;
    ids = [...ids].sort((a, b) => centers[a][axis] - centers[b][axis]);
    const mid = Math.floor((ids.length + 1) / 2);
    arrange(ids.slice(0, mid), k / 2);
    arrange(ids.slice(mid), k / 2);
  };
  arrange(tris.map((_, t) => t), leaves);
  tris = order.map(t => tris[t]);
  const exact = new Map();
  for (const [h, [a, b]] of spans(tris.length, leaves)) exact.set(h, box(tris.slice(a, b).flatMap(t => t.slice(0, 3).map(v => positions[v]))));
  const root = exact.get(0), decoded = new Map([[0, root]]), nodes = [];
  const quant = s => Math.max(0, Math.min(127, Math.floor(s * UNIT) - 1));   // always shrink a little less than possible
  for (let h = 0; h < leaves - 1; h++) {
    const [pmin, pmax] = decoded.get(h), c0 = exact.get(2 * h + 1), c1 = exact.get(2 * h + 2);
    const kids = [[[...pmin], [...pmax]], [[...pmin], [...pmax]]];
    const mins = [], maxs = [];
    for (let k = 0; k < 3; k++) {
      const ext = pmax[k] - pmin[k];
      for (const [side, out] of [[0, mins], [1, maxs]]) {
        if (ext <= 0) { out.push(128); continue; }
        const s = [c0, c1].map(c => side === 0 ? (c[0][k] - pmin[k]) / ext : (pmax[k] - c[1][k]) / ext);
        const q0 = quant(s[0]), q1 = quant(s[1]);
        const [child, q] = q0 >= q1 ? [0, q0] : [1, q1];
        out.push(child === 0 ? 128 + q : 127 - q);
        const shift = q * ext / UNIT;
        kids[child][side][k] += side === 0 ? shift : -shift;
      }
    }
    nodes.push(...mins, ...maxs);
    decoded.set(2 * h + 1, kids[0]);
    decoded.set(2 * h + 2, kids[1]);
  }
  nodes.push(0, 0, 0, 0, 0, 0);                   // the tree always has one spare node
  return [root, Uint8Array.from(nodes), tris];
}

const packed = (v, w = 1.0) => Uint8Array.from([...v, w], c => Math.max(0, Math.min(255, pyRound((c + 1) * 127.5))));   // FPackedNormal

function normalize(v) {
  const n = Math.sqrt(pySum(v.map(c => c * c))) || 1.0;
  return v.map(c => c / n);
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// A StaticMesh record (as read returns) for new geometry, keeping the template's properties and tail.
// `tris` are vertex index triples in Unreal's winding (corners clockwise seen from the front).
export function geometryMesh(template, positions, uv0, uv1, normals, tangents, tris) {
  const m = { ...template };
  const [lo, hi] = box(positions);
  const origin = [0, 1, 2].map(k => (lo[k] + hi[k]) / 2), extent = [0, 1, 2].map(k => (hi[k] - lo[k]) / 2);
  const radius = Math.max(...positions.map(p => pyDist(p, origin)));
  const [root, nodes, ordered] = kdop(positions, tris.map(t => [...t, 0]));
  Object.assign(m, { bounds: [...origin, ...extent, radius], bodySetup: 0, root: [...root[0], ...root[1]], nodes,
                     kdopTris: concat(...ordered.map(t => pack('<4H', ...t))) });
  const raw = [];
  for (const t of tris) {
    raw.push(...t.map(v => pack('<3f', ...positions[v])));
    for (const v of t) raw.push(pack('<4f', ...uv0[v], ...uv1[v]), new Uint8Array(48));
    raw.push(new Uint8Array(12).fill(0xff), pack('<4i', 0, 0, 1, 2), new Uint8Array(116));
  }
  m.raw = concat(...raw);
  m.rawFlags = 0;
  const sec = template.sections[0];
  m.sections = [{ fields: [sec.fields[0], 1, 1, 1, 0, tris.length, 0, positions.length - 1, 0], frags: [[0, tris.length]], ps3: 0 }];
  m.vertexSize = 12;
  m.positions = concat(...positions.map(p => pack('<3f', ...p)));
  Object.assign(m, { uvChannels: 2, uvStride: 16, uvFull: 0, colorStride: 0, colors: null, numVerts: positions.length });
  m.uvs = concat(...positions.map((_, v) => {
    const [tx, ty] = tangents[v];
    const sign = pySum(cross(normals[v], tx).map((c, k) => c * ty[k])) > 0 ? 1.0 : -1.0;
    return concat(packed(tx, 0), packed(normals[v], sign), pack('<4e', ...uv0[v], ...uv1[v]));
  }));
  m.indices = pack(`<${3 * tris.length}H`, ...tris.flat());
  const edges = new Map();
  for (const [a, b, c] of tris) {
    for (const e of [[a, b], [b, c], [c, a]]) {
      const key = Math.min(...e) + ',' + Math.max(...e);
      if (!edges.has(key)) edges.set(key, e);
    }
  }
  m.wire = pack(`<${2 * edges.size}H`, ...[...edges.values()].flat());
  m.adjacency = concat(...tris.map(([a, b, c]) => pack('<12H', a, b, c, a, b, b, c, c, a, a, b, c)));
  m.tail = concat(template.tail.subarray(0, 28), rng.bytes(16), template.tail.subarray(44));   // fresh lighting guid
  return m;
}

export const TILE = 32;                           // terrain tiles are TILE x TILE grid cells
export const CELL = 100.0;                        // terrain grid spacing
export const SPAN = TILE * CELL;
export const SINK = 30.0;                         // flat terrain sits this far under the floor, out of sight

// [positions, uv0, uv1, normals, tangents, tris] of terrain tile (tx, ty), relative to its -X,-Y corner.
// `apron` holds the heights of the tile's (TILE + 1)^2 vertices plus a one-vertex border from the neighbouring
// tiles, (TILE + 3)^2 values in rows of increasing Y, so normals agree across tile edges.
export function tileGeometry(apron, tx, ty) {
  const w = TILE + 3, h = (i, j) => apron[(j + 1) * w + i + 1];
  const mod1 = x => x - Math.floor(x);           // texture repeats every 1000 units, seamless across tiles
  const u0 = mod1(tx * SPAN / 1000), v0 = mod1(ty * SPAN / 1000);
  const positions = [], uv0 = [], uv1 = [], normals = [], tangents = [];
  for (let j = 0; j <= TILE; j++) {
    for (let i = 0; i <= TILE; i++) {
      const dx = (h(i + 1, j) - h(i - 1, j)) / (2 * CELL), dy = (h(i, j + 1) - h(i, j - 1)) / (2 * CELL);
      positions.push([i * CELL, j * CELL, h(i, j)]);
      uv0.push([u0 + i * CELL / 1000, v0 + j * CELL / 1000]);
      uv1.push([i / TILE, j / TILE]);
      normals.push(normalize([-dx, -dy, 1]));
      tangents.push([normalize([1, 0, dx]), normalize([0, 1, dy])]);
    }
  }
  const tris = [];
  for (let j = 0; j < TILE; j++) {
    for (let i = 0; i < TILE; i++) {
      const a = j * (TILE + 1) + i, b = a + 1, c = a + TILE + 1, d = b + TILE + 1;
      tris.push([a, d, b], [a, c, d]);            // clockwise seen from above
    }
  }
  return [positions, uv0, uv1, normals, tangents, tris];
}

export function gridHeights(positions) {          // vertex heights when packed positions lie on a terrain tile's grid
  if (positions.length !== 12 * (TILE + 1) ** 2) return null;
  const pts = [];
  for (let k = 0; k < (TILE + 1) ** 2; k++) {
    const [x, y, z] = unpackFrom('<3f', positions, 12 * k);
    if (Math.abs(x - k % (TILE + 1) * CELL) > 0.01 || Math.abs(y - Math.floor(k / (TILE + 1)) * CELL) > 0.01) return null;
    pts.push(z);
  }
  return pts;
}

export function meshComponent(pkg, i) {           // export index of a StaticMeshActor's own mesh component, or null
  const e = pkg.exports[i];
  const comp = pkg.classOf(e) === 'StaticMeshActor' ? pkg.get(e, 'StaticMeshComponent', '<i') : null;
  return comp && comp[0] > 0 && pkg.exports[comp[0] - 1].outer === i + 1 ? comp[0] - 1 : null;
}

// [actor, its mesh component, that component's mesh] to copy for new mesh actors: a placed StaticMeshActor whose
// component blocks rigid bodies (the car collides with it) and whose mesh lives in the map.
export function meshActorTemplate(pkg) {
  for (const i of pkg.levelList().sort((a, b) => a - b)) {
    const comp = meshComponent(pkg, i);
    if (comp === null) continue;
    const c = pkg.exports[comp];
    const mesh = pkg.get(c, 'StaticMesh', '<i'), block = pkg.prop(c, 'BlockRigidBody');
    if (mesh && mesh[0] > 0 && block && pkg.data[block[2]]) return [i, comp, mesh[0] - 1];
  }
  throw new Error('this map has no solid mesh actor to copy');
}

export function terrain(pkg, actors) {            // {base, material, tiles: Map("tx,ty" -> [actor index, heights])}
  const found = { base: null, material: null, tiles: new Map() };
  for (const a of actors) {
    if (!(a.mesh || '').startsWith('Terrain') || a.meshIndex === null || a.rot.some(Boolean)) continue;
    const heights = gridHeights(read(pkg, a.meshIndex).positions);
    if (heights === null) continue;
    found.tiles.set(`${pyRound(a.loc[0] / SPAN)},${pyRound(a.loc[1] / SPAN)}`, [a.i, heights]);
    found.base = a.loc[2];
    const p = pkg.prop(pkg.exports[meshComponent(pkg, a.i)], 'Materials');
    if (found.material === null && p) {
      const [count, first] = unpackFrom('<ii', pkg.data, p[2]);
      found.material = count ? first : null;
    }
  }
  return found;
}

// Write sculpted terrain tiles ([{tx, ty, heights}], heights with the one-vertex border tileGeometry takes): new
// tiles become mesh actors, placed ones get the new shape, flat ones leave the level. Returns [added, removed].
export function saveTerrain(add, base, material, tiles) {
  const pkg = add.pkg;
  const placed = new Map([...terrain(pkg, pkg.levelActors()).tiles].map(([k, [i]]) => [k, i]));
  const [actor, comp, templateMesh] = meshActorTemplate(pkg);
  const template = read(pkg, templateMesh), meshExport = pkg.exports[templateMesh];
  // the car collides with the triangles themselves, never a simplified hull
  const perPoly = Object.fromEntries(['UseSimpleRigidBodyCollision', 'UseSimpleBoxCollision', 'UseSimpleLineCollision']
    .map(n => [n, add.tag(n, 'BoolProperty', new Uint8Array(1))]));
  template.head = add.withProps(meshExport, pkg.objectBytes(templateMesh), perPoly, new Uint8Array(0));
  const w = TILE + 3;
  let added = 0, removed = 0;
  for (const t of tiles) {
    const tx = Math.trunc(t.tx), ty = Math.trunc(t.ty), key = `${tx},${ty}`, heights = t.heights.map(Number);
    if (heights.length !== w * w || !heights.every(Number.isFinite)) throw new Error(`terrain tile ${key} needs ${w * w} heights`);
    let flat = true;
    for (let j = 0; j <= TILE && flat; j++) for (let i = 0; i <= TILE; i++) if (heights[(j + 1) * w + i + 1] > 0) { flat = false; break; }
    if (flat) {
      if (placed.has(key)) { add.remove(placed.get(key)); removed += 1; }
      continue;
    }
    const [blob, rawAt] = write(geometryMesh(template, ...tileGeometry(heights, tx, ty)));
    const mesh = add.addObject(meshExport.cls, meshExport.outer, 'Terrain', blob, meshExport.flags, [rawAt]) + 1;
    const tags = { StaticMesh: add.tag('StaticMesh', 'ObjectProperty', pack('<i', mesh)) };
    if (placed.has(key)) {
      add.setProps(meshComponent(pkg, placed.get(key)), tags);
      continue;
    }
    tags.Materials = add.tag('Materials', 'ArrayProperty', pack('<ii', 1, Math.trunc(material)));
    const values = { Location: ['<3f', [tx * SPAN, ty * SPAN, base]], Rotation: ['<3i', [0, 0, 0]],
                     DrawScale3D: ['<3f', [1, 1, 1]], DrawScale: ['<f', [1]] };
    // no baked lighting (LODData): the engine lights the new mesh dynamically
    add.duplicate(actor, [0, 0, 0], values, { [comp]: [tags, pack('<i', 0)] });
    added += 1;
  }
  return [added, removed];
}

function assert(ok, what) { if (!ok) throw new Error(`self-check failed: ${what}`); }

export function selfcheck() {                     // decode the kDOP tree the way the engine does around a test tile
  const w = TILE + 3, apron = [];
  for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) apron.push(Math.max(0, 900 - 70 * Math.hypot(i - w / 3, j - w / 2)));
  const geo = tileGeometry(apron, -3, 2), positions = geo[0], tris = geo[5];
  const back = gridHeights(concat(...positions.map(p => pack('<3f', ...p))));
  assert(back && back.every((b, k) => Math.abs(b - positions[k][2]) < 1e-3), 'grid heights read back');
  const [root, nodes, ordered] = kdop(positions, tris.map(t => [...t, 0]));
  const leaves = leafCount(ordered.length);
  assert(nodes.length === 6 * leaves && nodes.subarray(-6).every(b => b === 0), 'node count');
  const boxes = new Map([[0, [[...root[0]], [...root[1]]]]]);
  for (let h = 0; h < leaves - 1; h++) {
    const [pmin, pmax] = boxes.get(h), b = nodes.subarray(6 * h, 6 * h + 6);
    const kids = [[[...pmin], [...pmax]], [[...pmin], [...pmax]]];
    for (let k = 0; k < 3; k++) {
      const u = (pmax[k] - pmin[k]) / UNIT, lo = b[k], hi = b[3 + k];
      kids[lo >= 128 ? 0 : 1][0][k] += (lo >= 128 ? lo - 128 : 127 - lo) * u;
      kids[hi >= 128 ? 0 : 1][1][k] -= (hi >= 128 ? hi - 128 : 127 - hi) * u;
    }
    boxes.set(2 * h + 1, kids[0]);
    boxes.set(2 * h + 2, kids[1]);
  }
  for (const [h, [a, b]] of spans(ordered.length, leaves)) {
    const [lo, hi] = boxes.get(h);
    for (const t of ordered.slice(a, b)) {
      for (const v of t.slice(0, 3)) {
        assert([0, 1, 2].every(k => lo[k] - 1e-3 <= positions[v][k] && positions[v][k] <= hi[k] + 1e-3), 'leaf box holds its triangles', h);
      }
    }
  }
  assert(tris.every(([a, b, c]) => cross([0, 1, 2].map(k => positions[b][k] - positions[a][k]),
                                                 [0, 1, 2].map(k => positions[c][k] - positions[a][k]))[2] < 0), 'winding');
}
