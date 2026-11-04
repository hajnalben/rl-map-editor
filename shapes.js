// Shapes to place in any map: built-in ones made here, and ones taken from maps you open (their geometry and
// collision; they take a surface from the map they go into). Geometry is in Unreal axes as flat typed arrays:
// {positions (3/vertex), uvs (2/vertex), normals (3/vertex), tangents (6/vertex: X then Y), tris (3/triangle)},
// triangles in Unreal's winding.
import { concat, fromHalf, pack } from './bytes.js';
import { read } from './mesh.js';

const sub = (a, b) => a.map((v, k) => v - b[k]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = v => { const n = Math.hypot(...v) || 1; return v.map(c => c / n); };

// Flat-shaded solid from polygons. `outward` gives each polygon's outside direction; corners are reordered to
// match, then fanned into triangles in Unreal's winding (cross(b-a, c-a) points into the shape).
function solid(polys) {
  const P = [], U = [], N = [], T = [], tris = [];
  for (const [corners, outward] of polys) {
    let poly = corners, n = unit(cross(sub(poly[1], poly[0]), sub(poly[2], poly[0])));
    if (dot(n, outward) < 0) { poly = [...poly].reverse(); n = n.map(c => -c); }
    const tx = unit(Math.abs(n[2]) < 0.9 ? cross([0, 0, 1], n) : cross(n, [0, 1, 0])), ty = cross(n, tx);
    const [ua, va] = Math.abs(n[2]) > 0.7 ? [0, 1] : Math.abs(n[0]) > Math.abs(n[1]) ? [1, 2] : [0, 2];
    const base = P.length / 3;
    for (const p of poly) { P.push(...p); U.push(p[ua] / 500, p[va] / 500); N.push(...n); T.push(...tx, ...ty); }
    for (let k = 1; k + 1 < poly.length; k++) tris.push(base, base + k + 1, base + k);
  }
  return { positions: Float32Array.from(P), uvs: Float32Array.from(U), normals: Float32Array.from(N), tangents: Float32Array.from(T), tris: Uint32Array.from(tris) };
}

function box(x0, x1, y0, y1, z0, z1) {
  const c = (x, y, z) => [x, y, z];
  return [[[c(x0, y0, z1), c(x1, y0, z1), c(x1, y1, z1), c(x0, y1, z1)], [0, 0, 1]], [[c(x0, y0, z0), c(x0, y1, z0), c(x1, y1, z0), c(x1, y0, z0)], [0, 0, -1]],
          [[c(x0, y0, z0), c(x1, y0, z0), c(x1, y0, z1), c(x0, y0, z1)], [0, -1, 0]], [[c(x0, y1, z0), c(x0, y1, z1), c(x1, y1, z1), c(x1, y1, z0)], [0, 1, 0]],
          [[c(x0, y0, z0), c(x0, y0, z1), c(x0, y1, z1), c(x0, y1, z0)], [-1, 0, 0]], [[c(x1, y0, z0), c(x1, y1, z0), c(x1, y1, z1), c(x1, y0, z1)], [1, 0, 0]]];
}

function ramp() {                                 // 1200 long, 1000 wide, rising to 400 toward +X
  const [l, w, h] = [600, 500, 400];
  return solid([[[[-l, -w, 0], [l, -w, h], [l, w, h], [-l, w, 0]], [-h, 0, 2 * l]], [[[-l, -w, 0], [-l, w, 0], [l, w, 0], [l, -w, 0]], [0, 0, -1]],
                [[[l, -w, 0], [l, w, 0], [l, w, h], [l, -w, h]], [1, 0, 0]], [[[-l, -w, 0], [l, -w, 0], [l, -w, h]], [0, -1, 0]],
                [[[-l, w, 0], [l, w, h], [l, w, 0]], [0, 1, 0]]]);
}

function pillar(r = 120, h = 800, sides = 20) {
  const at = (k, z) => [r * Math.cos(2 * Math.PI * k / sides), r * Math.sin(2 * Math.PI * k / sides), z];
  const polys = [[Array.from({ length: sides }, (_, k) => at(k, h)), [0, 0, 1]], [Array.from({ length: sides }, (_, k) => at(k, 0)), [0, 0, -1]]];
  for (let k = 0; k < sides; k++) polys.push([[at(k, 0), at(k + 1, 0), at(k + 1, h), at(k, h)], at(k + 0.5, 0).map((c, i) => i < 2 ? c : 0)]);
  return solid(polys);
}

function ring(R = 500, r = 55, around = 36, tube = 10) {   // upright: fly through it along X
  const at = (i, j) => {
    const a = 2 * Math.PI * i / around, b = 2 * Math.PI * j / tube, d = R + r * Math.cos(b);
    return [r * Math.sin(b), d * Math.cos(a), d * Math.sin(a)];
  };
  const polys = [];
  for (let i = 0; i < around; i++) {
    for (let j = 0; j < tube; j++) {
      const a = 2 * Math.PI * (i + 0.5) / around, b = 2 * Math.PI * (j + 0.5) / tube;
      polys.push([[at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)], [Math.sin(b), Math.cos(b) * Math.cos(a), Math.cos(b) * Math.sin(a)]]);
    }
  }
  return solid(polys);
}

function quarterPipe(R = 800, w = 500, back = 60, steps = 14) {   // curves up from the floor to a wall, rising toward +X
  const arc = Array.from({ length: steps + 1 }, (_, k) => { const t = Math.PI / 2 * k / steps; return [R * Math.sin(t), R * (1 - Math.cos(t))]; });
  const polys = [];
  for (let k = 0; k < steps; k++) {
    const [[x0, z0], [x1, z1]] = [arc[k], arc[k + 1]], t = Math.PI / 2 * (k + 0.5) / steps;
    polys.push([[[x0, -w, z0], [x1, -w, z1], [x1, w, z1], [x0, w, z0]], [-Math.sin(t), 0, Math.cos(t)]]);   // the riding surface faces the curve's center
  }
  const X = R + back, side = y => [[X, y, 0], ...arc.map(([x, z]) => [x, y, z]), [X, y, R]];
  polys.push([side(-w), [0, -1, 0]], [side(w), [0, 1, 0]]);
  polys.push([[[R, -w, R], [X, -w, R], [X, w, R], [R, w, R]], [0, 0, 1]], [[[X, -w, 0], [X, w, 0], [X, w, R], [X, -w, R]], [1, 0, 0]],
             [[[0, -w, 0], [X, -w, 0], [X, w, 0], [0, w, 0]], [0, 0, -1]]);
  return solid(polys);
}

export const boxShape = ([ox, oy, oz, ex, ey, ez]) => solid(box(ox - ex, ox + ex, oy - ey, oy + ey, oz - ez, oz + ez));   // bounds: center, half sizes

export const BUILT_IN = {
  Ramp: ramp, Platform: () => solid(box(-500, 500, -500, 500, 0, 100)), Pillar: () => pillar(), Ring: () => ring(), 'Quarter pipe': () => quarterPipe(),
};

// A map's StaticMesh as shape geometry (UV channel 0), plus its parts: groups of triangles [{start, count,
// material}] (start and count in triangle corners) drawn with their own surface.
export function meshGeometry(pkg, i) {
  const m = read(pkg, i), nv = m.positions.length / 12, stride = m.uvStride;
  const pos = new DataView(m.positions.buffer, m.positions.byteOffset, m.positions.byteLength);
  const uv = new DataView(m.uvs.buffer, m.uvs.byteOffset, m.uvs.byteLength), byte = q => uv.getUint8(q) / 127.5 - 1;
  const positions = new Float32Array(3 * nv), uvs = new Float32Array(2 * nv), normals = new Float32Array(3 * nv), tangents = new Float32Array(6 * nv);
  for (let v = 0; v < nv; v++) {
    for (let k = 0; k < 3; k++) positions[3 * v + k] = pos.getFloat32(12 * v + 4 * k, true);
    const q = stride * v, tx = [byte(q), byte(q + 1), byte(q + 2)], n = [byte(q + 4), byte(q + 5), byte(q + 6)];
    const ty = cross(n, tx).map(c => c * (byte(q + 7) < 0 ? -1 : 1));
    normals.set(n, 3 * v);
    tangents.set([...tx, ...ty], 6 * v);
    uvs.set(m.uvFull ? [uv.getFloat32(q + 8, true), uv.getFloat32(q + 12, true)] : [fromHalf(uv.getUint16(q + 8, true)), fromHalf(uv.getUint16(q + 10, true))], 2 * v);
  }
  const idx = new DataView(m.indices.buffer, m.indices.byteOffset, m.indices.byteLength);
  const tris = Uint32Array.from({ length: m.indices.length / 2 }, (_, k) => idx.getUint16(2 * k, true));
  const groups = m.sections.map(({ fields: [material, , , , first, count] }) => ({ start: first, count: 3 * count, material }));
  return { positions, uvs, normals, tangents, tris, groups };
}

export function asMeshInput(g) {                  // geometryMesh's arguments
  const nv = g.positions.length / 3, at = (a, k, n) => Array.from(a.subarray(n * k, n * k + n));
  const uv0 = Array.from({ length: nv }, (_, v) => at(g.uvs, v, 2));
  return [Array.from({ length: nv }, (_, v) => at(g.positions, v, 3)), uv0, uv0, Array.from({ length: nv }, (_, v) => at(g.normals, v, 3)),
          Array.from({ length: nv }, (_, v) => [at(g.tangents, v, 6).slice(0, 3), at(g.tangents, v, 6).slice(3)]),
          Array.from({ length: g.tris.length / 3 }, (_, t) => at(g.tris, t, 3))];
}

export function corners(g, attribute = 'positions', n = 3) {   // per triangle corner, for drawing: 9 position or 6 UV floats a triangle
  const out = new Float32Array(n * g.tris.length);
  g.tris.forEach((v, k) => out.set(g[attribute].subarray(n * v, n * v + n), n * k));
  return out;
}

// A convex piece of simple collision (UE3's FKConvexElem) around `points`: its corners, its faces as triangles wound
// as UDK winds them (inward), the distinct edge and face directions, and face planes {n, d} (n·p = d, n outward).
// Null when the points enclose no volume.
export function convexHull(points, eps = 0.01) {
  const pts = [];
  for (const p of points) if (!pts.some(q => Math.hypot(...sub(p, q)) < eps)) pts.push([...p]);
  const planes = [];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) for (let k = j + 1; k < pts.length; k++) {
    const c = cross(sub(pts[j], pts[i]), sub(pts[k], pts[i]));
    if (Math.hypot(...c) < 1e-6) continue;
    let n = unit(c), d = dot(n, pts[i]), above = false, below = false;
    for (const p of pts) { const s = dot(n, p) - d; above ||= s > eps; below ||= s < -eps; }
    if (above && below) continue;
    if (above) [n, d] = [n.map(v => -v), -d];
    if (!planes.some(q => dot(q.n, n) > 1 - 1e-6 && Math.abs(q.d - d) < eps)) planes.push({ n, d });
  }
  if (planes.length < 4) return null;
  const verts = pts.filter(p => planes.some(q => Math.abs(dot(q.n, p) - q.d) < eps)), tris = [], edges = [], normals = [];
  const add = (list, v) => { if (!list.some(u => Math.abs(dot(u, v)) > 1 - 1e-6)) list.push(v); };
  for (const { n, d } of planes) {
    const on = verts.map((p, i) => i).filter(i => Math.abs(dot(n, verts[i]) - d) < eps);
    const c = on.reduce((s, i) => s.map((v, k) => v + verts[i][k] / on.length), [0, 0, 0]);
    const u = unit(sub(verts[on[0]], c)), w = cross(n, u);
    on.sort((a, b) => Math.atan2(dot(sub(verts[a], c), w), dot(sub(verts[a], c), u)) - Math.atan2(dot(sub(verts[b], c), w), dot(sub(verts[b], c), u)));
    for (let k = 1; k + 1 < on.length; k++) tris.push(on[0], on[k + 1], on[k]);
    on.forEach((a, k) => add(edges, unit(sub(verts[on[(k + 1) % on.length]], verts[a]))));
    add(normals, n);
  }
  const box = [0, 1, 2].map(k => Math.min(...verts.map(p => p[k]))).concat([0, 1, 2].map(k => Math.max(...verts.map(p => p[k]))));
  return { verts, tris, edges, normals, planes, box };
}

// A mesh's simple collision as convex pieces (convexHull): the whole mesh when it is convex, else its flat convex
// patches (neighbouring triangles in one plane), each thickened `depth` inward. Moving shapes collide only by these.
// ponytail: no merging across bends, so a curved mesh gets a piece per face (a Ring: 360); merge bends if that's heavy.
export function convexPieces(g, depth = 30) {
  const point = k => Array.from(g.positions.subarray(3 * k, 3 * k + 3)), normal = k => Array.from(g.normals.subarray(3 * k, 3 * k + 3));
  const tris = [];
  for (let t = 0; t < g.tris.length; t += 3) {
    const ids = [g.tris[t], g.tris[t + 1], g.tris[t + 2]], v = ids.map(point), c = cross(sub(v[1], v[0]), sub(v[2], v[0]));
    if (Math.hypot(...c) < 1e-3) continue;
    const n = unit(c), out = ids.map(normal).reduce((a, b) => a.map((x, k) => x + b[k]));
    tris.push({ v, n: dot(n, out) < 0 ? n.map(x => -x) : n, area: Math.hypot(...c) / 2 });   // outward, as the vertex normals say
  }
  const all = tris.flatMap(t => t.v);
  if (tris.every(t => all.every(p => dot(t.n, sub(p, t.v[0])) <= 0.5))) {
    const whole = convexHull(all);
    if (whole) return [whole];
  }
  const same = (p, q) => Math.hypot(...sub(p, q)) < 0.01;
  const touches = (patch, t) => patch.some(u => u.v.filter(p => t.v.some(q => same(p, q))).length >= 2);
  const flatArea = (patch, n) => {                // area of the 2D hull of a flat patch's corners
    const u = unit(sub(patch[0].v[1], patch[0].v[0])), w = cross(n, u);
    const p2 = patch.flatMap(t => t.v).map(p => [dot(p, u), dot(p, w)]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const turn = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = list => list.reduce((h, p) => { while (h.length > 1 && turn(h.at(-2), h.at(-1), p) <= 0) h.pop(); h.push(p); return h; }, []);
    const hull = [...half(p2).slice(0, -1), ...half([...p2].reverse()).slice(0, -1)];
    return Math.abs(hull.reduce((s, p, k) => s + p[0] * hull[(k + 1) % hull.length][1] - hull[(k + 1) % hull.length][0] * p[1], 0)) / 2;
  };
  const slab = patch => convexHull(patch.flatMap(t => t.v.flatMap(p => [p, p.map((x, k) => x - depth * t.n[k])])));
  const pieces = [];
  let patch = [];
  for (const t of tris) {
    const flat = patch.length && dot(patch[0].n, t.n) > 0.9999 && Math.abs(dot(t.n, sub(t.v[0], patch[0].v[0]))) < 0.5;
    const next = [...patch, t];
    if (flat && touches(patch, t) && flatArea(next, t.n) <= 1.01 * next.reduce((s, x) => s + x.area, 0)) patch = next;
    else { if (patch.length) pieces.push(slab(patch)); patch = [t]; }
  }
  if (patch.length) pieces.push(slab(patch));
  return pieces.filter(Boolean);
}

// One convex piece as UE3 saves it: tagged properties made with `tag(name, type, body, struct)`, ended by `none`.
// Planes are stored W first, and the corners also as PermutedVertexData: per four corners, their X, Y and Z rows.
export function convexElemBytes(h, tag, none) {
  const array = (name, rows, fmt) => tag(name, 'ArrayProperty', concat(pack('<i', rows.length), ...rows.map(r => pack(fmt, ...r))));
  const four = Array.from({ length: Math.ceil(h.verts.length / 4) * 4 }, (_, k) => h.verts[Math.min(k, h.verts.length - 1)]);
  const permuted = [];
  for (let g = 0; g < four.length; g += 4) for (let axis = 0; axis < 3; axis++) permuted.push([3, 0, 1, 2].map(k => four[g + k][axis]));
  return concat(array('VertexData', h.verts, '<3f'), array('PermutedVertexData', permuted, '<4f'),
    tag('FaceTriData', 'ArrayProperty', pack(`<i${h.tris.length}i`, h.tris.length, ...h.tris)), array('EdgeDirections', h.edges, '<3f'),
    array('FaceNormalDirections', h.normals, '<3f'), array('FacePlaneData', h.planes.map(p => [p.d, ...p.n]), '<4f'),
    tag('ElemBox', 'StructProperty', concat(pack('<6f', ...h.box), Uint8Array.of(1)), 'Box'), none);
}
