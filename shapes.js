// Shapes to place in any map: built-in ones made here, and ones taken from maps you open (their geometry and
// collision; they take a surface from the map they go into). Geometry is in Unreal axes as flat typed arrays:
// {positions (3/vertex), uvs (2/vertex), normals (3/vertex), tangents (6/vertex: X then Y), tris (3/triangle)},
// triangles in Unreal's winding.
import { fromHalf } from './bytes.js';
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

export function meshGeometry(pkg, i) {            // a map's StaticMesh as shape geometry (UV channel 0)
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
  return { positions, uvs, normals, tangents, tris };
}

export function asMeshInput(g) {                  // geometryMesh's arguments
  const nv = g.positions.length / 3, at = (a, k, n) => Array.from(a.subarray(n * k, n * k + n));
  const uv0 = Array.from({ length: nv }, (_, v) => at(g.uvs, v, 2));
  return [Array.from({ length: nv }, (_, v) => at(g.positions, v, 3)), uv0, uv0, Array.from({ length: nv }, (_, v) => at(g.normals, v, 3)),
          Array.from({ length: nv }, (_, v) => [at(g.tangents, v, 6).slice(0, 3), at(g.tangents, v, 6).slice(3)]),
          Array.from({ length: g.tris.length / 3 }, (_, t) => at(g.tris, t, 3))];
}

export function corners(g) {                      // triangle corners, 9 floats per triangle, for drawing
  const out = new Float32Array(3 * g.tris.length);
  g.tris.forEach((v, k) => out.set(g.positions.subarray(3 * v, 3 * v + 3), 3 * k));
  return out;
}
