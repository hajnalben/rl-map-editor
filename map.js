// What the editor needs from a map: what's in it, the shapes to draw, and the edited copy.
import { Additions, Package, editValues } from './ue3.js';
import { pack } from './bytes.js';
import { addCheckpoints, checkpointZones, mainSequence } from './kismet.js';
import { CELL, SINK, TILE, addShapes, meshComponent, saveTerrain, terrain } from './mesh.js';
import { asMeshInput, boxShape } from './shapes.js';
import { unpackFrom } from './bytes.js';
import { compact } from './compact.js';

export function describe(pkg) {
  const all = pkg.levelActors(), ground = terrain(pkg, all);
  const tileActors = new Set([...ground.tiles.values()].map(([i]) => i));
  const actors = all.filter(a => !tileActors.has(a.i));      // the editor draws the terrain itself
  const tiles = [...ground.tiles].map(([key, [, heights]]) => {
    const [tx, ty] = key.split(',').map(Number);
    return { tx, ty, heights };
  });
  const panels = actors.filter(a => /^CheckpointPanel/.test(a.mesh || '')).map(a => {
    const p = pkg.prop(pkg.exports[meshComponent(pkg, a.i)], 'Materials');
    return { i: a.i, material: p && unpackFrom('<i', pkg.data, p[2])[0] ? unpackFrom('<ii', pkg.data, p[2])[1] : null };
  });
  return { actors, palette: pkg.palette(actors), zone: pkg.zoneTemplate(), checkpoints: checkpointZones(pkg), materials: pkg.materials(), panels,
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
// the map's own Kismet scripts (a new map started from this one). `shapes` are new meshes ([{key, loc, rot, scale3d}])
// built from `shapeGeometry` ({key: geometryMesh arguments}) and drawn with `shapeMaterial`. `respawns` re-point saved
// checkpoints ([{valueVar, zone, marker}]): to a new marker zone at `marker` (transform), or back to the zone itself.
// `panels` ([{loc, rot, scale3d, scale, material}]) make checkpoints visible in game: an opaque box the size of the
// zone that nothing collides with; `panelMaterials` ([{i, material}]) change the surface of saved ones.
export function build(source, { edits = [], duplicates = [], removes = [], checkpoints = [], terrain: ground = null, fresh = false,
                                shapes = [], shapeGeometry = {}, shapeMaterial = null, respawns = [], panels = [], panelMaterials = [] }) {
  const pkg = new Package(source.slice());
  const before = pkg.levelList().length;
  let tilesAdded = 0, tilesRemoved = 0, out = pkg.data, triggers = [];
  const missing = pkg.apply(edits);
  // ball checkpoints switched between ball in front / on top: their mode variable (UDK leaves an IntValue of 0 out)
  const zones = new Map(checkpointZones(pkg).map(z => [z.i, z])), unsetModes = [];
  for (const edit of edits) {
    const modeVar = 'ballOnTop' in edit ? zones.get(edit.i)?.modeVar : null;
    if (modeVar === null || modeVar === undefined) continue;
    try { pkg.set(pkg.exports[modeVar], 'IntValue', '<i', edit.ballOnTop ? 1 : 0); } catch { unsetModes.push([modeVar, edit.ballOnTop ? 1 : 0]); }
  }
  const markers = respawns.filter(r => r.marker);
  for (const r of respawns) if (!r.marker) pkg.set(pkg.exports[r.valueVar], 'ObjValue', '<i', r.zone + 1);
  if (missing.size || duplicates.length || removes.length || checkpoints.length || ground || fresh || shapes.length || unsetModes.length || markers.length || panels.length || panelMaterials.length) {
    const add = new Additions(pkg);
    for (const [v, value] of unsetModes) add.setProps(v, { IntValue: add.tag('IntValue', 'IntProperty', pack('<i', value)) });
    if (fresh) add.clearRefs(mainSequence(pkg), 'SequenceObjects');
    for (const [i, values] of missing) add.setValues(i, values);
    for (const dup of duplicates) add.duplicate(dup.src, [0, 0, 0], editValues(dup));
    for (const i of removes) add.remove(i);
    for (const r of markers) {
      const marker = add.duplicate(pkg.zoneTemplate().i, [0, 0, 0], editValues(r.marker));
      pkg.set(pkg.exports[r.valueVar], 'ObjValue', '<i', marker + 1);
    }
    if (checkpoints.length) {
      const zone = pkg.zoneTemplate();
      if (!zone) throw new Error('this map has no trigger zone to copy for checkpoints');
      triggers = addCheckpoints(add, zone.i, checkpoints.map(c => ({ values: editValues(c), ball: !!c.ball, ballOnTop: !!c.ballOnTop,
                                                                     respawn: c.respawn ? editValues(c.respawn) : null })), fresh);
    }
    if (ground) [tilesAdded, tilesRemoved] = saveTerrain(add, Number(ground.base), ground.material, ground.tiles);
    if (shapes.length) addShapes(add, shapes.map(s => ({ key: s.key, values: editValues(s) })), shapeGeometry, shapeMaterial);
    if (panels.length) {
      const zone = pkg.zoneTemplate();
      if (!zone) throw new Error('this map has no trigger zone to size checkpoint panels');
      addShapes(add, panels.map(p => ({ key: 'panel', values: editValues(p), material: p.material ?? null })),
                { panel: asMeshInput(boxShape(zone.bounds)) }, null, { name: 'CheckpointPanel', solid: false });
    }
    for (const { i, material } of panelMaterials) {
      add.setProps(meshComponent(pkg, i), { Materials: add.tag('Materials', 'ArrayProperty', pack('<ii', 1, Math.trunc(material))) });
    }
    out = add.save();
  }
  const packed = compact(out).bytes;              // unused meshes and textures shrunk, superseded copies gone
  if (packed.length < out.length) out = packed;

  const saved = new Package(out), actors = saved.levelActors(), byIndex = new Map(actors.map(a => [a.i, a]));
  const markersAdded = markers.length + checkpoints.filter(c => c.respawn).length;
  check(saved.levelList().length === before + duplicates.length + checkpoints.length + markersAdded + shapes.length + panels.length + tilesAdded - removes.length - tilesRemoved, 'level actor count');
  const savedZones = new Map(checkpointZones(saved).map(z => [z.i, z]));
  triggers.forEach((t, k) => {
    const z = savedZones.get(t), c = checkpoints[k];
    check(z && z.ball === !!c.ball && (!c.ball || z.ballOnTop === !!c.ballOnTop) && (z.dest !== t) === !!c.respawn, `checkpoint ${k + 1} wiring`);
  });
  for (const edit of edits) {
    if ('ballOnTop' in edit && zones.get(edit.i)?.modeVar != null) check(savedZones.get(edit.i)?.ballOnTop === !!edit.ballOnTop, `${edit.i} ball placement`);
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
