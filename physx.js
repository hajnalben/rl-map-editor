// Cooked PhysX 2.8 convex boxes ("NXS\x01CVXM" v3), as UDK stores them in a Level's cooked collision cache for
// KActors (moving shapes' collision stand-ins; ThePath's have one per scale). Reproduces the 2.8 cooker
// in float32: StanHull-style vertex cleanup and incremental hull, skin-width inflation by cropping an expanded box
// with the inflated hull planes (the path PhysX 3.4 kept as InflationConvexHullLib), then the ICE convex hull
// serialization (CVHL v5, VALE, OPCODE hybrid model, mass properties). Checked against 159 boxes UDK cooked in
// Leth's maps: the same hull, apart from float rounding and which face of a parallel pair comes first.
const f = Math.fround;
const SKIN = f(0.025);                       // NxCookingParams.skinWidth default; NX_CF_INFLATE_CONVEX
const add = (a, b) => [f(a[0] + b[0]), f(a[1] + b[1]), f(a[2] + b[2])];
const sub = (a, b) => [f(a[0] - b[0]), f(a[1] - b[1]), f(a[2] - b[2])];
const mul = (a, s) => [f(a[0] * s), f(a[1] * s), f(a[2] * s)];
const vmul = (a, b) => [f(a[0] * b[0]), f(a[1] * b[1]), f(a[2] * b[2])];
const neg = a => [-a[0], -a[1], -a[2]];
const dot = (a, b) => f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));
const cross = (a, b) => [f(f(a[1] * b[2]) - f(a[2] * b[1])), f(f(a[2] * b[0]) - f(a[0] * b[2])), f(f(a[0] * b[1]) - f(a[1] * b[0]))];
const mag2 = a => dot(a, a), mag = a => f(Math.sqrt(dot(a, a)));
const normalize = a => { const m = mag(a); return m > 0 ? mul(a, f(1 / m)) : a; };
const ddot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const bounds = pts => { const mn = [...pts[0]], mx = [...pts[0]]; for (const p of pts) for (let k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k]; } return [mn, mx]; };
const degToRad = d => f(d * f(0.01745329251994329547));
const MAXDOT_3DEG = f(Math.cos(degToRad(3)));

// HullLibrary::CleanupVertices: normalize by the bounds, weld, scale back (the round trip changes low bits)
function cleanup(pts) {
  const [mn, mx] = bounds(pts), dim = sub(mx, mn);
  const recip = dim.map(d => f(1 / d)), c = vmul(add(mn, mul(dim, f(0.5))), recip), out = [];
  for (const p of pts) {
    const q = vmul(p, recip); let j;
    for (j = 0; j < out.length; j++) {
      const v = out[j];
      if (Math.abs(f(q[0] - v[0])) < f(0.001) && Math.abs(f(q[1] - v[1])) < f(0.001) && Math.abs(f(q[2] - v[2])) < f(0.001)) { if (mag2(sub(q, c)) > mag2(sub(v, c))) out[j] = q; break; }
    }
    if (j === out.length) out.push(q);
  }
  return out.map(v => vmul(v, dim));
}

// --- StanHull calchullgen ---
const maxFiltered = (p, dir, no) => { let m = -1; for (let i = 0; i < p.length; i++) if (!no[i] && (m === -1 || dot(p[i], dir) > dot(p[m], dir))) m = i; return m; };
const orth = v => { const a = cross(v, [0, 0, 1]), b = cross(v, [0, 1, 0]); return normalize(mag2(a) > mag2(b) ? a : b); };
function maxDirSterid(p, dir, allow) {
  const no = new Array(p.length).fill(false);
  const probe = (u, v, deg) => maxFiltered(p, add(dir, mul(add(mul(u, f(Math.sin(degToRad(deg)))), mul(v, f(Math.cos(degToRad(deg))))), f(0.025))), no);
  for (;;) {
    const m = maxFiltered(p, dir, no);
    if (allow[m] === 3) return m;
    const u = orth(dir), v = cross(u, dir);
    let ma = -1;
    for (let x = 0; x <= 360; x += 45) {
      const mb = probe(u, v, x);
      if (ma === m && mb === m) { allow[m] = 3; return m; }
      if (ma !== -1 && ma !== mb) {
        let mc = ma;
        for (let xx = x - 40; xx <= x; xx += 5) { const md = probe(u, v, xx); if (mc === m && md === m) { allow[m] = 3; return m; } mc = md; }
      }
      ma = mb;
    }
    no[m] = true;
  }
}
function findSimplex(v, allow) {
  let b0 = [f(0.01), f(0.02), 1];
  const p0 = maxDirSterid(v, b0, allow), p1 = maxDirSterid(v, neg(b0), allow);
  b0 = sub(v[p0], v[p1]);
  if (p0 === p1) return null;
  let b1 = cross([1, f(0.02), 0], b0), b2 = cross([f(-0.02), 1, 0], b0);
  b1 = normalize(mag(b1) > mag(b2) ? b1 : b2);
  let p2 = maxDirSterid(v, b1, allow);
  if (p2 === p0 || p2 === p1) p2 = maxDirSterid(v, neg(b1), allow);
  if (p2 === p0 || p2 === p1) return null;
  b2 = normalize(cross(sub(v[p2], v[p0]), b0));
  let p3 = maxDirSterid(v, b2, allow);
  if (p3 === p0 || p3 === p1 || p3 === p2) p3 = maxDirSterid(v, neg(b2), allow);
  if (p3 === p0 || p3 === p1 || p3 === p2) return null;
  return dot(sub(v[p3], v[p0]), cross(sub(v[p1], v[p0]), sub(v[p2], v[p0]))) < 0 ? [p0, p1, p3, p2] : [p0, p1, p2, p3];
}
const triNormal = (v, t) => { const cp = cross(sub(v[t[1]], v[t[0]]), sub(v[t[2]], v[t[1]])); const m = mag(cp); return m === 0 ? [1, 0, 0] : mul(cp, f(1 / m)); };
const hasVert = (t, x) => t[0] === x || t[1] === x || t[2] === x;
const above = (v, t, p, eps) => dot(triNormal(v, t), sub(p, v[t[0]])) > eps;

function calchullgen(v) {
  const T = [];
  const make = (a, b, c, n) => { const t = [a, b, c]; t.n = n; t.id = T.length; t.vmax = -1; t.rise = 0; T.push(t); return t; };
  const neib = (t, a, b) => { for (let i = 0; i < 3; i++) { const i1 = (i + 1) % 3; if ((t[i] === a && t[i1] === b) || (t[i] === b && t[i1] === a)) return (i + 2) % 3; } throw new Error('physx: broken hull adjacency'); };
  const b2bfix = (s, t) => { for (let i = 0; i < 3; i++) { const a = s[(i + 1) % 3], b = s[(i + 2) % 3];
    const sa = T[s.n[neib(s, a, b)]]; sa.n[neib(sa, b, a)] = t.n[neib(t, b, a)];
    const tb = T[t.n[neib(t, b, a)]]; tb.n[neib(tb, a, b)] = s.n[neib(s, a, b)]; } };
  const extrude = (t0, x) => {
    const [a, b, c] = t0, n = T.length;
    const ta = make(x, b, c, [t0.n[0], n + 1, n + 2]); { const o = T[t0.n[0]]; o.n[neib(o, b, c)] = n; }
    const tb = make(x, c, a, [t0.n[1], n + 2, n]); { const o = T[t0.n[1]]; o.n[neib(o, c, a)] = n + 1; }
    const tc = make(x, a, b, [t0.n[2], n, n + 1]); { const o = T[t0.n[2]]; o.n[neib(o, a, b)] = n + 2; }
    for (const s of [ta, tb, tc]) { if (!T[s.id]) continue; const o = T[s.n[0]]; if (o && hasVert(o, x)) { b2bfix(s, o); T[s.id] = T[o.id] = null; } }
    T[t0.id] = null;
  };
  const allow = new Array(v.length).fill(1), isext = new Array(v.length).fill(0);
  const [mn, mx] = bounds(v), eps = f(mag(sub(mx, mn)) * f(0.001)), areaEps = f(f(eps * eps) * f(0.1)), lift = f(f(0.01) * eps);
  const p = findSimplex(v, allow); if (!p) throw new Error('physx: degenerate box');
  const center = mul(add(add(add(v[p[0]], v[p[1]]), v[p[2]]), v[p[3]]), f(1 / 4));
  make(p[2], p[3], p[1], [2, 3, 1]); make(p[3], p[2], p[0], [3, 2, 0]); make(p[0], p[1], p[3], [0, 1, 3]); make(p[1], p[0], p[2], [1, 0, 2]);
  for (const x of p) isext[x] = 1;
  for (const t of T) { const n = triNormal(v, t); t.vmax = maxDirSterid(v, n, allow); t.rise = dot(n, sub(v[t.vmax], v[t[0]])); }
  for (let vlimit = 252; vlimit > 0; vlimit--) {
    let te = null; for (const x of T) if (!te || (x && te.rise < x.rise)) te = x;
    if (!te || !(te.rise > eps)) break;
    const x = te.vmax; isext[x] = 1;
    for (let j = T.length; j--;) if (T[j] && above(v, T[j], v[x], lift)) extrude(T[j], x);
    for (let j = T.length; j--;) {
      const t = T[j]; if (!t) continue; if (!hasVert(t, x)) break;
      if (above(v, t, center, lift) || mag(cross(sub(v[t[1]], v[t[0]]), sub(v[t[2]], v[t[1]]))) < areaEps) { extrude(T[t.n[0]], x); j = T.length; }
    }
    for (let j = T.length; j--;) {
      const t = T[j]; if (!t) continue; if (t.vmax >= 0) break;
      const n = triNormal(v, t); t.vmax = maxDirSterid(v, n, allow);
      if (isext[t.vmax]) t.vmax = -1; else t.rise = dot(n, sub(v[t.vmax], v[t[0]]));
    }
  }
  return T;
}

// merge near-coplanar triangles (keep the bigger), one inflated plane per survivor
function hullPlanes(v, T) {
  const area2 = t => mag2(cross(sub(v[t[0]], v[t[1]]), sub(v[t[2]], v[t[0]])));
  for (let i = 0; i < T.length; i++) if (T[i]) for (let j = i + 1; j < T.length; j++) if (T[i] && T[j] && dot(triNormal(v, T[i]), triNormal(v, T[j])) > MAXDOT_3DEG) {
    if (area2(T[i]) < area2(T[j])) T[i] = null; else T[j] = null;
  }
  return T.filter(Boolean).map(t => { const n = triNormal(v, t); return { n, d: f(f(-dot(n, v[t[0]])) - SKIN) }; });
}

// --- overhull: crop an AABB (pushed out by half its diagonal) with the inflated planes ---
function threePlane(p0, p1, p2) {
  const c0 = [p0.n[0], p1.n[0], p2.n[0]], c1 = [p0.n[1], p1.n[1], p2.n[1]], c2 = [p0.n[2], p1.n[2], p2.n[2]];
  const id = f(1 / dot(c0, cross(c1, c2))), m = (a, b, c, d) => f(f(a * b) - f(c * d));
  const i0 = [f(id * m(c1[1], c2[2], c2[1], c1[2])), f(id * -m(c0[1], c2[2], c2[1], c0[2])), f(id * m(c0[1], c1[2], c0[2], c1[1]))];
  const i1 = [f(id * -m(c1[0], c2[2], c1[2], c2[0])), f(id * m(c0[0], c2[2], c0[2], c2[0])), f(id * -m(c0[0], c1[2], c0[2], c1[0]))];
  const i2 = [f(id * m(c1[0], c2[1], c1[1], c2[0])), f(id * -m(c0[0], c2[1], c0[1], c2[0])), f(id * m(c0[0], c1[1], c1[0], c0[1]))];
  return neg(add(add(mul(i0, p0.d), mul(i1, p1.d)), mul(i2, p2.d)));
}
const planeTest = (p, v, e) => { const a = f(dot(v, p.n) + p.d); return a > e ? 2 : a < -e ? 1 : 0; };
function makeCube(mn, mx) {
  const verts = [[mn[0], mn[1], mn[2]], [mn[0], mn[1], mx[2]], [mn[0], mx[1], mn[2]], [mn[0], mx[1], mx[2]], [mx[0], mn[1], mn[2]], [mx[0], mn[1], mx[2]], [mx[0], mx[1], mn[2]], [mx[0], mx[1], mx[2]]];
  const facets = [{ n: [-1, 0, 0], d: mn[0] }, { n: [1, 0, 0], d: -mx[0] }, { n: [0, -1, 0], d: mn[1] }, { n: [0, 1, 0], d: -mx[1] }, { n: [0, 0, -1], d: mn[2] }, { n: [0, 0, 1], d: -mx[2] }];
  const E = [[11, 0, 0], [23, 1, 0], [15, 3, 0], [16, 2, 0], [13, 6, 1], [21, 7, 1], [9, 5, 1], [18, 4, 1], [19, 0, 2], [6, 4, 2], [20, 5, 2], [0, 1, 2], [22, 3, 3], [4, 7, 3], [17, 6, 3], [2, 2, 3], [3, 0, 4], [14, 2, 4], [7, 6, 4], [8, 4, 4], [10, 1, 5], [5, 5, 5], [12, 7, 5], [1, 3, 5]];
  return { verts, facets, edges: E.map(([ea, v, p]) => ({ ea, v, p })) };
}
function findCandidate(c, planes, pte) {
  let p = -1, md = 0;
  planes.forEach((P, i) => {
    let dmax = 0, dmin = 0;
    for (const v of c.verts) { const t = f(dot(v, P.n) + P.d); dmax = Math.max(dmax, t); dmin = Math.min(dmin, t); }
    let dr = f(dmax - dmin); if (dr < pte) dr = 1;
    let d = f(dmax / dr);
    if (d <= md) return;
    c.facets.forEach((F, j) => {
      if (F.n[0] === P.n[0] && F.n[1] === P.n[1] && F.n[2] === P.n[2] && F.d === P.d) { d = 0; return; }
      if (dot(P.n, F.n) > MAXDOT_3DEG) for (const e of c.edges) if (e.p === j && f(dot(c.verts[e.v], P.n) + P.d) < 0) { d = 0; break; }
    });
    if (d > md) { p = i; md = d; }
  });
  return md > f(0.01) ? p : -1;
}
function crop(c, slice, pte) {               // convexHullCrop, half-edge bookkeeping as in PhysX 3.4
  const INV = 255, vf = c.verts.map(v => ({ t: planeTest(slice, v, pte), u: INV })); let under = 0, flags = 0;
  for (const x of vf) { if (x.t === 1) x.u = under++; flags |= x.t; }
  if (!(flags & 2)) return c;
  const ef = [], te = [], tp = [], cop = [], created = [];
  let uec = 0, upc = 0, e0 = 0;
  for (let cp = 0; cp < c.facets.length; cp++) {
    const es = e0; let enf = -1, e1 = e0 + 1, vout = INV, vin = INV, copE = INV, side = 0;
    do {
      if (e1 >= c.edges.length || c.edges[e1].p !== cp) { enf = e1; e1 = es; }
      const E0 = c.edges[e0], E1 = c.edges[e1], Ea = c.edges[E0.ea], s0 = vf[E0.v].t, s1 = vf[E1.v].t;
      side |= s0;
      if (s0 === 1 && s1 !== 1) {
        ef[e0] = uec; te[uec] = { v: vf[E0.v].u, p: upc, ea: -1 };
        if (E0.ea < e0) { te[uec].ea = ef[E0.ea]; te[ef[E0.ea]].ea = uec; vout = te[ef[E0.ea]].v; }
        else if (s1 === 0) { if (vf[E1.v].u === INV) { created.push(c.verts[E1.v]); vf[E1.v].u = under++; } vout = vf[E1.v].u; }
        else { created.push(threePlane(c.facets[E0.p], c.facets[Ea.p], slice)); vout = under++; }
        uec++;
        if (vin !== INV && vin !== vout) { copE = uec; te[uec++] = { v: vout, p: upc, ea: INV }; }
      } else if (s0 !== 1 && s1 === 1) {
        if (E0.ea < e0) {
          let nea = ef[E0.ea] + 1; const pp = te[ef[E0.ea]].p;
          if (nea >= uec || te[nea].p !== pp) { nea -= 2; while (nea > 0 && te[nea - 1].p === pp) nea--; }
          vin = te[nea].v;
        } else if (s0 === 0) { if (vf[E0.v].u === INV) { created.push(c.verts[E0.v]); vf[E0.v].u = under++; } vin = vf[E0.v].u; }
        else { created.push(threePlane(c.facets[E0.p], c.facets[Ea.p], slice)); vin = under++; }
        if (vout !== INV && vin !== vout) { copE = uec; te[uec++] = { v: vout, p: upc, ea: INV }; }
        te[uec] = { v: vin, p: upc, ea: -1 }; ef[e0] = uec;
        if (E0.ea < e0) { te[uec].ea = ef[E0.ea]; te[ef[E0.ea]].ea = uec; }
        uec++;
      } else if (s0 === 1 && s1 === 1) {
        ef[e0] = uec; te[uec] = { v: vf[E0.v].u, p: upc, ea: -1 };
        if (E0.ea < e0) { te[uec].ea = ef[E0.ea]; te[ef[E0.ea]].ea = uec; }
        uec++;
      }
      e0 = e1; e1++;
    } while (e0 !== es);
    e0 = enf;
    if (side & 1) tp[upc++] = c.facets[cp];
    if (copE !== INV) cop.push({ ea: copE, v0: vin, v1: vout });
  }
  if (cop.length) tp[upc++] = slice;
  for (let i = 0; i < cop.length - 1; i++) if (cop[i].v1 !== cop[i + 1].v0) {
    let j; for (j = i + 2; j < cop.length; j++) if (cop[i].v1 === cop[j].v0) { [cop[i + 1], cop[j]] = [cop[j], cop[i + 1]]; break; }
    if (j >= cop.length) return null;
  }
  const edges = te.slice(0, uec).map(e => ({ ...e }));
  cop.forEach((x, i) => { edges.push({ p: upc - 1, ea: x.ea, v: x.v0 }); edges[x.ea].ea = uec + i; });
  return { verts: c.verts.filter((_, i) => vf[i].t === 1).concat(created), facets: tp.slice(0, upc), edges };
}
function overhull(v, planes) {
  const [emin, emax] = bounds(v), diam = mag(sub(emax, emin)), pte = f(diam * f(0.001));
  for (let j = 0; j < 6; j++) {
    const n = [0, 0, 0]; n[j >> 1] = j % 2 ? 1 : -1;
    if (planes.some(P => dot(n, P.n) > MAXDOT_3DEG)) { const t = j % 2 ? emax : emin; t.splice(0, 3, ...add(t, mul(n, f(diam * f(0.5))))); }
  }
  let c = makeCube(emin, emax), k;
  for (let maxp = Math.min(256, planes.length); maxp-- && (k = findCandidate(c, planes, pte)) >= 0;) { const nc = crop(c, planes[k], pte); if (!nc) break; c = nc; }
  // HullLibrary output: fan triangles per facet, then BringOutYourDead renumbers vertices by first use
  const cyc = c.facets.map((_, i) => c.edges.filter(e => e.p === i).map(e => e.v));
  const map = new Map(), verts = [];
  for (const q of cyc) for (let j = 1; j + 1 < q.length; j++) for (const x of [q[0], q[j], q[j + 1]]) if (!map.has(x)) { map.set(x, verts.length); verts.push(c.verts[x]); }
  return { verts, polys: cyc.map(q => q.map(x => map.get(x))) };
}

// --- ICE convex hull serialization ---
class Out {
  constructor() { this.b = []; }
  u8(...x) { this.b.push(...x); }
  u32(x) { this.b.push(x & 255, (x >>> 8) & 255, (x >>> 16) & 255, (x >>> 24) & 255); }
  f32(...xs) { for (const x of xs) { const t = new DataView(new ArrayBuffer(4)); t.setFloat32(0, x, true); this.u8(...new Uint8Array(t.buffer)); } }
  tag(s) { for (const ch of s) this.b.push(ch.charCodeAt(0)); }
  idx(a) { const max = Math.max(...a); this.u32(max); for (const x of a) max < 256 ? this.u8(x) : this.u8(x & 255, x >> 8); } // ponytail: 8/16-bit only, boxes never need 32
}
function newellPlane(vs, ids) {
  let n = [0, 0, 0];
  for (let i = ids.length - 1, j = 0; j < ids.length; i = j, j++) {
    const a = vs[ids[i]], b = vs[ids[j]];
    n = [f(n[0] + f(f(a[1] - b[1]) * f(a[2] + b[2]))), f(n[1] + f(f(a[2] - b[2]) * f(a[0] + b[0]))), f(n[2] + f(f(a[0] - b[0]) * f(a[1] + b[1])))];
  }
  n = normalize(n);
  let d = f(-dot(ids.reduce((s, i) => add(s, vs[i]), [0, 0, 0]), n) / ids.length);
  for (const v of vs) { const t = -dot(n, v); if (t < d) d = t; }
  return { n, d };
}
function vertexNormals(vs, tris) {              // ponytail: angle-weighted corner normals; ~82% of UDK's vertices bit-exact, rest off by 1-2 ulps
  const acc = vs.map(() => [0, 0, 0]);
  for (const t of tris) for (let k = 0; k < 3; k++) {
    const a = vs[t[k]], e1 = sub(vs[t[(k + 1) % 3]], a), e2 = sub(vs[t[(k + 2) % 3]], a);
    acc[t[k]] = add(acc[t[k]], mul(normalize(cross(e1, e2)), f(Math.acos(ddot(e1, e2) / (Math.sqrt(ddot(e1, e1)) * Math.sqrt(ddot(e2, e2)))))));
  }
  return acc.map(normalize);
}
function geomCenter(vs, tris) {
  let c = [0, 0, 0], ta = 0;
  for (const [i, j, k] of tris) {
    const area = f(f(0.5) * mag(cross(sub(vs[i], vs[j]), sub(vs[i], vs[k]))));
    c = add(c, mul(mul(add(add(vs[i], vs[j]), vs[k]), f(1 / 3)), area)); ta = f(ta + area);
  }
  return mul(c, f(1 / ta));
}
function massProps(vs, tris) {                   // Mirtich volume integrals (doubles), density 1, inertia about the origin
  let T0 = 0; const T1 = [0, 0, 0], T2 = [0, 0, 0], TP = [0, 0, 0];
  for (const t of tris) {
    const n = normalize(cross(sub(vs[t[1]], vs[t[0]]), sub(vs[t[2]], vs[t[1]]))), w = -dot(n, vs[t[0]]);
    const ax = n.map(Math.abs), C = ax[0] > ax[1] && ax[0] > ax[2] ? 0 : ax[1] > ax[2] ? 1 : 2, A = (C + 1) % 3, B = (A + 1) % 3;
    let P1 = 0, Pa = 0, Pb = 0, Paa = 0, Pab = 0, Pbb = 0, Paaa = 0, Paab = 0, Pabb = 0, Pbbb = 0;
    for (let i = 0; i < 3; i++) {
      const p0 = vs[t[i]], p1 = vs[t[(i + 1) % 3]], a0 = p0[A], b0 = p0[B], a1 = p1[A], b1 = p1[B], da = a1 - a0, db = b1 - b0;
      const a0_2 = a0 * a0, a0_3 = a0_2 * a0, a0_4 = a0_3 * a0, b0_2 = b0 * b0, b0_3 = b0_2 * b0, b0_4 = b0_3 * b0;
      const a1_2 = a1 * a1, a1_3 = a1_2 * a1, b1_2 = b1 * b1, b1_3 = b1_2 * b1;
      const C1 = a1 + a0, Ca = a1 * C1 + a0_2, Caa = a1 * Ca + a0_3, Caaa = a1 * Caa + a0_4;
      const Cb = b1 * (b1 + b0) + b0_2, Cbb = b1 * Cb + b0_3, Cbbb = b1 * Cbb + b0_4;
      const Cab = 3 * a1_2 + 2 * a1 * a0 + a0_2, Kab = a1_2 + 2 * a1 * a0 + 3 * a0_2, Caab = a0 * Cab + 4 * a1_3, Kaab = a1 * Kab + 4 * a0_3;
      const Cabb = 4 * b1_3 + 3 * b1_2 * b0 + 2 * b1 * b0_2 + b0_3, Kabb = b1_3 + 2 * b1_2 * b0 + 3 * b1 * b0_2 + 4 * b0_3;
      P1 += db * C1; Pa += db * Ca; Paa += db * Caa; Paaa += db * Caaa; Pb += da * Cb; Pbb += da * Cbb; Pbbb += da * Cbbb;
      Pab += db * (b1 * Cab + b0 * Kab); Paab += db * (b1 * Caab + b0 * Kaab); Pabb += da * (a1 * Cabb + a0 * Kabb);
    }
    P1 /= 2; Pa /= 6; Paa /= 12; Paaa /= 20; Pb /= -6; Pbb /= -12; Pbbb /= -20; Pab /= 24; Paab /= 60; Pabb /= -60;
    const k1 = 1 / n[C], k2 = k1 * k1, k3 = k2 * k1, k4 = k3 * k1, nA = n[A], nB = n[B];
    const Fa = k1 * Pa, Fb = k1 * Pb, Fc = -k2 * (nA * Pa + nB * Pb + w * P1);
    const Faa = k1 * Paa, Fbb = k1 * Pbb, Fcc = k3 * (nA * nA * Paa + 2 * nA * nB * Pab + nB * nB * Pbb + w * (2 * (nA * Pa + nB * Pb) + w * P1));
    const Faaa = k1 * Paaa, Fbbb = k1 * Pbbb;
    const Fccc = -k4 * (nA ** 3 * Paaa + 3 * nA * nA * nB * Paab + 3 * nA * nB * nB * Pabb + nB ** 3 * Pbbb + 3 * w * (nA * nA * Paa + 2 * nA * nB * Pab + nB * nB * Pbb) + w * w * (3 * (nA * Pa + nB * Pb) + w * P1));
    const Faab = k1 * Paab, Fbbc = -k2 * (nA * Pabb + nB * Pbbb + w * Pbb);
    const Fcca = k3 * (nA * nA * Paaa + 2 * nA * nB * Paab + nB * nB * Pabb + w * (2 * (nA * Paa + nB * Pab) + w * Pa));
    T0 += n[0] * (A === 0 ? Fa : B === 0 ? Fb : Fc);
    T1[A] += n[A] * Faa; T1[B] += n[B] * Fbb; T1[C] += n[C] * Fcc;
    T2[A] += n[A] * Faaa; T2[B] += n[B] * Fbbb; T2[C] += n[C] * Fccc;
    TP[A] += n[A] * Faab; TP[B] += n[B] * Fbbc; TP[C] += n[C] * Fcca;
  }
  for (let k = 0; k < 3; k++) { T1[k] /= 2; T2[k] /= 3; TP[k] /= 2; }
  return { mass: f(T0), inertia: [T2[1] + T2[2], -TP[0], -TP[2], -TP[0], T2[2] + T2[0], -TP[1], -TP[2], -TP[1], T2[0] + T2[1]].map(f), com: T1.map(x => f(x / T0)) };
}

export function serialize(vs, polys) {
  const nv = vs.length, np = polys.length;
  const tris = polys.flatMap(p => p.slice(1, -1).map((_, j) => [p[0], p[j + 1], p[j + 2]]));
  const planes = polys.map(p => newellPlane(vs, p));
  const ek = (a, b) => a < b ? a * 256 + b : b * 256 + a;
  const pe = p => p.map((v, j) => ek(v, p[(j + 1) % p.length]));
  const edges = [...new Set(polys.flatMap(pe))].sort((a, b) => a - b), eIdx = new Map(edges.map((k, i) => [k, i]));
  const edgeFaces = edges.map(k => polys.map((p, pi) => pe(p).includes(k) ? pi : -1).filter(x => x >= 0));
  const [mn, mx] = bounds(vs), center = mul(add(mx, mn), f(0.5)), ext = mul(sub(mx, mn), f(0.5));
  const w = new Out();
  w.u32(1796); w.u32(36 * np); w.u32(4); w.u32(1);   // ponytail: 1796 measured for 8-vertex/6-polygon hulls only
  w.tag('NXS\x01CVXM'); w.u32(3); w.u32(0); w.tag('ICE\x01CLHL'); w.u32(0); w.tag('ICE\x01CVHL'); w.u32(5);
  for (const x of [nv, tris.length, edges.length, np, 2 * edges.length, 2 * edges.length]) w.u32(x);
  for (const v of vs) w.f32(...v);
  w.idx(tris.flat());
  w.u8(1, 0);
  for (const n of vertexNormals(vs, tris)) w.f32(...n);
  w.f32(...geomCenter(vs, tris));
  let vref = 0;
  polys.forEach((p, i) => {
    const { n, d } = planes[i]; let lo = Infinity, hi = -Infinity;
    for (const v of vs) { const t = dot(v, n); lo = Math.min(lo, t); hi = Math.max(hi, t); }
    w.u32(p.length); w.u32(vref); w.u32(2 * vref); w.f32(...n, d, lo, hi); vref += p.length;
  });
  w.u8(...polys.flat());
  w.idx(polys.flatMap(p => pe(p).map(k => eIdx.get(k))));
  w.u32(0); w.u32(0);
  for (const k of edges) w.u8(k >> 8, k & 255);
  for (const [a, b] of edgeFaces) w.f32(...normalize(add(planes[a].n, planes[b].n)));
  for (let i = 0; i < 4; i++) w.u32(0);
  w.idx(edgeFaces.map(e => e.length)); w.idx(edgeFaces.map((_, i) => 2 * i));
  for (const [a, b] of edgeFaces) w.u8(a, b);
  const adj = vs.map(() => new Set());
  for (const t of tris) for (let k = 0; k < 3; k++) adj[t[k]].add(t[(k + 1) % 3]).add(t[(k + 2) % 3]);
  const adjL = adj.map(s => [...s].sort((a, b) => a - b));
  w.tag('ICE\x01VALE'); w.u32(2); w.u32(nv); w.u32(adjL.reduce((s, a) => s + a.length, 0)); w.idx(adjL.map(a => a.length)); w.u8(...adjL.flat());
  // OPCODE hybrid model: one quantized no-leaf node, two leaves of triangles split at the box center on its longest axis
  const cq = center.map(c => c !== 0 ? f(32767 / Math.abs(c)) : 0), eq = ext.map(e => e !== 0 ? f(32767 / e) : 0);
  const cc = cq.map(q => q !== 0 ? f(1 / q) : 0), ec = eq.map(q => q !== 0 ? f(1 / q) : 0);
  const qc = center.map((c, k) => Math.trunc(f(c * cq[k]))), qe = ext.map((e, k) => Math.trunc(f(e * eq[k])));
  for (let k = 0; k < 3; k++) {                  // OPCODE "fix quantized boxes": grow extents until they cover the real box
    const hiK = f(center[k] + ext[k]), loK = f(center[k] - ext[k]), c = f(qc[k] * cc[k]);
    while (qe[k] < 0xffff) { const e = f(qe[k] * ec[k]); if (f(c + e) < hiK || f(c - e) > loK) qe[k]++; else break; }
  }
  let axis = 0; if (ext[1] > ext[axis]) axis = 1; if (ext[2] > ext[axis]) axis = 2;
  const order = tris.map((_, i) => i); let pos = 0;
  for (let i = 0; i < order.length; i++) {
    const c = tris[order[i]].map(x => vs[x]).reduce((a, p) => add(a, p)).map(x => f(x * f(1 / 3)));
    if (c[axis] > center[axis]) { [order[i], order[pos]] = [order[pos], order[i]]; pos++; }
  }
  const opc = new Out();
  opc.tag('OPC\x01'); opc.u32(1); opc.u32(3); opc.u32(1);
  for (const q of [...qc, ...qe]) opc.u8(q & 255, (q >> 8) & 255);
  opc.u32(0xc0000000); opc.u32(0);               // both children are leaves
  opc.f32(...cc, ...ec);
  opc.tag('HBM\x01'); opc.u32(0); opc.u32(2); opc.idx([pos - 1, (tris.length - pos - 1) | (pos << 4)]);
  opc.u32(tris.length); opc.idx(order);
  w.u32(opc.b.length); w.u8(...opc.b);
  w.f32(f(Math.max(...mx) * 2 ** -22));          // geometric epsilon: largest max-coordinate * 2^-22 (signed, as UDK writes it)
  w.f32(...add(mn, ext), f(mag(ext) + f(1e-4)));  // ponytail: bounding sphere ~30% bit-exact; UDK's (miniball-like) centre/radius differ by a few ulps
  w.f32(...mn, ...mx);
  const m = massProps(vs, tris); w.f32(m.mass, ...m.inertia, ...m.com);
  return new Uint8Array(w.b);
}

// points: the 8 corners, PhysX units (Unreal units * 0.02), BEFORE the 0.025 skin inflation the cooker adds
export function cookConvex(points) {
  const v = cleanup(points.map(p => p.map(f)));
  const { verts, polys } = overhull(v, hullPlanes(v, calchullgen(v)));
  if (verts.length !== 8 || polys.length !== 6) throw new Error(`physx: hull came out as ${verts.length} verts / ${polys.length} polygons`);
  return serialize(verts, polys);
}

// min/max: PhysX-space box bounds BEFORE inflation; corners fed in crossUV ConvexElems[0]'s vertex order
export function cookBox(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  return cookConvex([[x0, y1, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z0], [x0, y0, z0], [x1, y1, z0], [x0, y0, z1], [x1, y0, z0]]);
}
