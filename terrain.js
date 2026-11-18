// Terrain as the document keeps it: one heightfield under the whole map, in tiles of TILE x TILE cells CELL units
// apart, heights over the terrain base (just under the floor). Only tiles with raised ground exist; a vertex on a
// tile edge is stored in every tile sharing it. A stroke works on its own copy of the tiles it changes, so documents
// kept for undo keep theirs.
import { CELL, TILE } from './mesh.js';

export const tileKey = (tx, ty) => `${tx},${ty}`;
const owners = g => g % TILE === 0 ? [g / TILE - 1, g / TILE] : [Math.floor(g / TILE)];
const vertexOf = (tx, ty, gx, gy) => (gy - ty * TILE) * (TILE + 1) + gx - tx * TILE;

export function heightAt(tiles, gx, gy) {
  const tx = Math.floor(gx / TILE), ty = Math.floor(gy / TILE), t = tiles.get(tileKey(tx, ty));
  return t ? t[vertexOf(tx, ty, gx, gy)] : 0;
}
// [[gx, gy, height]] into `tiles` (a Map the stroke owns); `own`: keys of tiles already copied for it. The keys changed.
export function setHeights(tiles, list, own) {
  const touched = new Set();
  for (const [gx, gy, h] of list) for (const tx of owners(gx)) for (const ty of owners(gy)) {
    const key = tileKey(tx, ty);
    let t = tiles.get(key);
    if (!t && h <= 0) continue;
    if (!own.has(key)) { tiles.set(key, t = t ? t.slice() : new Float32Array((TILE + 1) ** 2)); own.add(key); }
    t[vertexOf(tx, ty, gx, gy)] = h;
    touched.add(key);
  }
  return touched;
}
// What one frame of a brush stroke at `p` ({x, z} in view units, which are map units) does: [[gx, gy, height]]
export function brushHeights(tiles, tool, p, radius, strength, dt, level) {
  const out = [];
  for (let gy = Math.ceil((p.z - radius) / CELL); gy <= Math.floor((p.z + radius) / CELL); gy++) {
    for (let gx = Math.ceil((p.x - radius) / CELL); gx <= Math.floor((p.x + radius) / CELL); gx++) {
      const d = Math.hypot(gx * CELL - p.x, gy * CELL - p.z) / radius;
      if (d >= 1) continue;
      const f = (1 - d * d) ** 2, h = heightAt(tiles, gx, gy), at = (x, y) => heightAt(tiles, x, y);
      const target = tool === 'smooth' ? (at(gx - 1, gy) + at(gx + 1, gy) + at(gx, gy - 1) + at(gx, gy + 1)) / 4 : tool === 'flatten' ? level : null;
      const h2 = target === null ? h + (tool === 'lower' ? -1 : 1) * f * strength * 25 * dt : h + (target - h) * Math.min(1, f * strength * dt / 10);
      out.push([gx, gy, Math.max(0, h2)]);         // the floor covers anything lower
    }
  }
  return out;
}
// A road along `path` ([{x, y, z}], y up): flat across, inside `radius` of the path the ground takes the road height,
// which climbs evenly from start to end; the next half radius blends back into the terrain.
export function roadHeights(tiles, path, radius, base) {
  const reach = 1.5 * radius, lengths = [0];
  for (let k = 1; k < path.length; k++) lengths.push(lengths[k - 1] + Math.hypot(path[k].x - path[k - 1].x, path[k].z - path[k - 1].z));
  const total = lengths.at(-1) || 1, h0 = Math.max(0, path[0].y - base), h1 = Math.max(0, path.at(-1).y - base);
  const xs = path.map(p => p.x), zs = path.map(p => p.z), out = [];
  for (let gy = Math.ceil((Math.min(...zs) - reach) / CELL); gy <= Math.floor((Math.max(...zs) + reach) / CELL); gy++) {
    for (let gx = Math.ceil((Math.min(...xs) - reach) / CELL); gx <= Math.floor((Math.max(...xs) + reach) / CELL); gx++) {
      const x = gx * CELL, z = gy * CELL;
      let best = Infinity, along = 0;
      for (let k = 0; k < Math.max(1, path.length - 1); k++) {
        const a = path[k], b = path[Math.min(k + 1, path.length - 1)], dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz;
        const t = len2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0;
        const d = Math.hypot(x - a.x - t * dx, z - a.z - t * dz);
        if (d < best) { best = d; along = lengths[k] + t * Math.sqrt(len2); }
      }
      if (best >= reach) continue;
      const s = Math.max(0, (best - radius) / (reach - radius)), weight = 1 - s * s * (3 - 2 * s);
      const h = heightAt(tiles, gx, gy), target = h0 + (h1 - h0) * along / total;
      out.push([gx, gy, Math.max(0, h + (target - h) * weight)]);
    }
  }
  return out;
}
// the tile's heights plus a one-vertex border, as build() takes them
export function apron(tiles, tx, ty) {
  const out = [];
  for (let j = -1; j <= TILE + 1; j++) for (let i = -1; i <= TILE + 1; i++) out.push(Math.round(heightAt(tiles, tx * TILE + i, ty * TILE + j) * 10) / 10);
  return out;
}
// keys of the tiles whose heights differ between two tile maps (a missing tile is flat)
export function changedTiles(a, b) {
  const flat = t => !t || t.every(h => h === 0);
  return [...new Set([...a.keys(), ...b.keys()])].filter(k => {
    const x = a.get(k), y = b.get(k);
    return x !== y && (flat(x) !== flat(y) || (x && y && x.some((h, v) => h !== y[v])));
  });
}
