// What the editor needs from a map: what's in it, the shapes to draw, and the edited copy.
import { Additions, Package, editValues } from './ue3.js';
import { addCheckpoints, checkpointZones, mainSequence } from './kismet.js';
import { CELL, SINK, TILE, saveTerrain, terrain } from './mesh.js';

export function describe(pkg) {
  const all = pkg.levelActors(), ground = terrain(pkg, all);
  const tileActors = new Set([...ground.tiles.values()].map(([i]) => i));
  const actors = all.filter(a => !tileActors.has(a.i));      // the editor draws the terrain itself
  const tiles = [...ground.tiles].map(([key, [, heights]]) => {
    const [tx, ty] = key.split(',').map(Number);
    return { tx, ty, heights };
  });
  return { actors, palette: pkg.palette(actors), zone: pkg.zoneTemplate(), checkpoints: checkpointZones(pkg), materials: pkg.materials(),
           terrain: { tile: TILE, cell: CELL, sink: SINK, base: ground.base, material: ground.material, tiles } };
}

export function shapes(pkg, meshIndices) {        // Map(mesh export index -> triangle corners), skipping unreadable meshes
  const out = new Map();
  for (const i of meshIndices) {
    try { out.set(i, pkg.meshTriangles(i)); } catch { /* drawn as its bounding box */ }
  }
  return out;
}

const check = (ok, what) => { if (!ok) throw new Error(`saved map failed its check: ${what}`); };

// The original map bytes (left untouched) with the editor's changes applied, re-read and checked. `fresh` empties
// the map's own Kismet scripts (a new map started from this one).
export function build(source, { edits = [], duplicates = [], removes = [], checkpoints = [], terrain: ground = null, fresh = false }) {
  const pkg = new Package(source.slice());
  const before = pkg.levelList().length;
  let tilesAdded = 0, tilesRemoved = 0, out = pkg.data, triggers = [];
  const missing = pkg.apply(edits);
  if (missing.size || duplicates.length || removes.length || checkpoints.length || ground || fresh) {
    const add = new Additions(pkg);
    if (fresh) add.clearRefs(mainSequence(pkg), 'SequenceObjects');
    for (const [i, values] of missing) add.setValues(i, values);
    for (const dup of duplicates) add.duplicate(dup.src, [0, 0, 0], editValues(dup));
    for (const i of removes) add.remove(i);
    if (checkpoints.length) {
      const zone = pkg.zoneTemplate();
      if (!zone) throw new Error('this map has no trigger zone to copy for checkpoints');
      triggers = addCheckpoints(add, zone.i, checkpoints.map(c => ({ values: editValues(c), ball: !!c.ball })), fresh);
    }
    if (ground) [tilesAdded, tilesRemoved] = saveTerrain(add, Number(ground.base), ground.material, ground.tiles);
    out = add.save();
  }

  const saved = new Package(out), actors = saved.levelActors(), byIndex = new Map(actors.map(a => [a.i, a]));
  check(saved.levelList().length === before + duplicates.length + checkpoints.length + tilesAdded - removes.length - tilesRemoved, 'level actor count');
  if (triggers.length) {
    const zones = new Map(checkpointZones(saved).map(z => [z.i, z.ball]));
    triggers.forEach((t, k) => check(zones.get(t) === !!checkpoints[k].ball, `checkpoint ${k + 1} wiring`));
  }
  if (ground) {
    const tiles = terrain(saved, actors).tiles, w = TILE + 3;
    for (const t of ground.tiles) {
      const inner = [];
      for (let j = 0; j <= TILE; j++) for (let i = 0; i <= TILE; i++) inner.push(t.heights[(j + 1) * w + i + 1]);
      const got = tiles.get(`${t.tx},${t.ty}`);
      check((got === undefined) === (Math.max(...inner) <= 0), `terrain tile ${t.tx},${t.ty} placement`);
      check(!got || got[1].every((h, k) => Math.abs(h - inner[k]) < 0.01), `terrain tile ${t.tx},${t.ty} shape`);
    }
  }
  for (const edit of edits) {
    const want = editValues(edit), a = byIndex.get(edit.i);
    for (const [key, prop] of [['loc', 'Location'], ['rot', 'Rotation'], ['scale3d', 'DrawScale3D']]) {
      if (want[prop] && a) check(a[key].every((v, k) => Math.abs(v - want[prop][1][k]) < 0.01), `${a.name} ${key}`);
    }
  }
  return out;
}

export const isOriginalGameMap = bytes => bytes[6] + 256 * bytes[7] !== 0;   // cooked by Psyonix, not saved by UDK
