// What the editor needs from a map: what's in it, the shapes to draw, and the edited copy.
import { Additions, Package, editValues } from './ue3.js';
import { pack, packInto } from './bytes.js';
import { addCheckpoints, ballSpawnMarker, checkpointZones, editorDataOf, hudOf, lavaZones, mainSequence, moversOf, nodeProps, setEditorData, setHud, setMovers, spawnBall, textInfo } from './kismet.js';
import { CELL, SINK, TILE, addShapes, meshComponent, saveTerrain, terrain, toMover } from './mesh.js';
import { asMeshInput, boxShape, corners, meshGeometry } from './shapes.js';
import { unpackFrom } from './bytes.js';
import { compact } from './compact.js';
import { LIGHT_FIELDS, addLight, lightOf, setLight } from './lights.js';
import { motionKeys, scaledBox } from './motion.js';
import { scriptOf, setScript } from './rules.js';

export function describe(pkg) {
  const all = pkg.levelActors(), ground = terrain(pkg, all);
  const tileActors = new Set([...ground.tiles.values()].map(([i]) => i));
  const actors = all.filter(a => !tileActors.has(a.i));      // the editor draws the terrain itself
  const tiles = [...ground.tiles].map(([key, [, heights]]) => {
    const [tx, ty] = key.split(',').map(Number);
    return { tx, ty, heights };
  });
  for (const a of actors) {                       // surfaces the mesh component puts on the mesh's parts (0: the mesh's own)
    const c = meshComponent(pkg, a.i), p = c === null ? null : pkg.prop(pkg.exports[c], 'Materials');
    a.materials = p ? [...unpackFrom(`<${unpackFrom('<i', pkg.data, p[2])[0]}i`, pkg.data, p[2] + 4)] : [];
    a.light = lightOf(pkg, a.i);
  }
  const panels = actors.filter(a => /^CheckpointPanel/.test(a.mesh || '')).map(a => ({ i: a.i, material: a.materials[0] || null }));
  const tint = pkg.tintable(), spawn = actors.find(a => a.cls.startsWith('PlayerStart'))?.i ?? null;
  return { actors, palette: pkg.palette(actors), zone: pkg.zoneTemplate(), checkpoints: checkpointZones(pkg), lava: lavaZones(pkg), materials: pkg.materials(), panels,
           spawnBall: spawnBall(pkg, spawn), ballSpawn: ballSpawnMarker(pkg), lights: mapLights(pkg).map(l => l.mood), hud: hudOf(pkg), movers: moversOf(pkg), script: scriptOf(pkg), editor: editorDataOf(pkg),
           tintable: tint && pkg.exports[tint[0]].name, terrain: { tile: TILE, cell: CELL, sink: SINK, base: ground.base, material: ground.material, tiles } };
}

// Lighting moods: a tint and a brightness factor for the map's sun and sky lights, relative to how the map had them
// (the sky dome is unlit, so no night). The mood in use is kept in the lights' Tag, so another one replaces it
// instead of stacking on it.
export const LIGHTING = {
  day: { name: 'Bright day', tint: [255, 252, 245], brightness: 1.25 },
  warm: { name: 'Warm (golden hour)', tint: [255, 196, 135], brightness: 0.95 },
  cool: { name: 'Cool (overcast)', tint: [196, 214, 255], brightness: 0.8 },
  dim: { name: 'Dim', tint: [225, 228, 240], brightness: 0.5 },
};
function mapLights(pkg) {                         // the sun and sky lights: [{actor, component, mood}]
  const out = [];
  for (const a of pkg.levelActors()) {
    const c = /Light$/.test(a.cls) ? pkg.get(pkg.exports[a.i], 'LightComponent', '<i') : null;
    if (!c || c[0] <= 0 || !/^((Dominant)?Directional|Sky)LightComponent$/.test(pkg.classOf(pkg.exports[c[0] - 1]))) continue;
    out.push({ actor: a.i, component: c[0] - 1, mood: /^Lighting_(\w+)$/.exec(nodeProps(pkg, pkg.exports[a.i]).Tag || '')?.[1] ?? null });
  }
  return out;
}
function setLighting(add, mood, skip) {           // `mood`: a LIGHTING key, or 'map' for the lights as the map had them
  const pkg = add.pkg, next = LIGHTING[mood];
  for (const l of mapLights(pkg).filter(l => !skip.has(l.actor))) {
    const p = nodeProps(pkg, pkg.exports[l.component]), was = LIGHTING[l.mood];
    const bgra = Array.isArray(p.LightColor) ? p.LightColor : [255, 255, 255, 0], tint = t => t ? [t[2], t[1], t[0]] : [255, 255, 255];
    const color = bgra.slice(0, 3).map((v, k) => Math.max(0, Math.min(255, Math.round(v * 255 / tint(was?.tint)[k] * tint(next?.tint)[k] / 255))));
    const brightness = (p.Brightness ?? 1) / (was?.brightness ?? 1) * (next?.brightness ?? 1);
    add.setProps(l.component, { Brightness: add.tag('Brightness', 'FloatProperty', pack('<f', brightness)),
                                LightColor: add.tag('LightColor', 'StructProperty', Uint8Array.of(...color, bgra[3]), 'Color') });
    add.setProps(l.actor, { Tag: add.tag('Tag', 'NameProperty', add.fname(next ? `Lighting_${mood}` : pkg.classOf(pkg.exports[l.actor]))) });
  }
}

const LAVA_COLOR = [1, 0.12, 0.01, 0];            // linear red-orange
function lavaSurface(add) {                       // a red copy of the map's tintable surface; its 1-based reference
  const [i, at] = add.pkg.tintable(), e = add.pkg.exports[i], blob = add.pkg.objectBytes(i).slice();
  packInto('<4f', blob, at, ...LAVA_COLOR);
  return add.addObject(e.cls, e.outer, 'Lava_INST', blob, e.flags) + 1;
}

// Map(mesh export index -> {corners, uvs, groups}) for drawing: triangle corners, their UVs and the mesh's parts
// (see meshGeometry); only corners for meshes whose render data can't be read, and none for unreadable meshes.
export function shapes(pkg, meshIndices) {
  const out = new Map();
  for (const i of meshIndices) {
    try {
      const g = meshGeometry(pkg, i);
      out.set(i, { corners: corners(g), uvs: corners(g, 'uvs', 2), groups: g.groups });
    } catch {
      try { out.set(i, { corners: pkg.meshTriangles(i), uvs: null, groups: [] }); } catch { /* drawn as its bounding box */ }
    }
  }
  return out;
}

const check = (ok, what) => { if (!ok) throw new Error(`saved map failed its check: ${what}`); };

// The original map bytes (left untouched) with the editor's changes applied, re-read and checked. `fresh` empties
// the map's own Kismet scripts (a new map started from this one). `shapes` are new meshes ([{key, loc, rot, scale3d, material?}])
// built from `shapeGeometry` ({key: geometryMesh arguments}) and drawn with `shapeMaterial`. `respawns` re-point saved
// checkpoints ([{valueVar, zone, marker}]): to a new marker zone at `marker` (transform), or back to the zone itself.
// `panels` ([{loc, rot, scale3d, scale, material}]) make checkpoints visible in game: an opaque box the size of the
// zone that nothing collides with; `surfaces` ([{i, material}]) change the surface of saved mesh actors and panels.
// `lighting` sets the mood of the sun and sky lights (a LIGHTING key, or 'map' for as the map had them).
// `hud` ({timer, deaths}) sets the timer and death counter; a map that has them gets them again, so they follow its
// last checkpoint and lava zones.
// `lights` are new lights ([{kind, loc, rot, ...settings}], see lights.js); an edit or duplicate with `light`
// ({setting: value}) sets those on a saved light or its copy. A sun or sky light set by hand leaves the mood.
// `movers` ([{i | shape: k | duplicate: k, motion}], see motion.js) is every moving shape the map should have, given
// when they change: a saved one, `shapes[k]` (written as a mover), or the copy `duplicates[k]`. A motion's trigger
// is {i} (a saved checkpoint zone), {checkpoint: k} (`checkpoints[k]`) or null.
// `triggerZones` ([{loc, rot, scale3d}]) are new trigger zones for scripts. `script` ({source, plan, names}, see script.js;
// names {name: {i} | {shape | checkpoint | zone | light | duplicate: k}}) replaces the map's script; an empty
// source takes it out. Shapes a script moves, shows or hides must be movers (InterpActors).
// `conversions` ([{i, loc, rot, scale3d, scale?, material?}]) turn saved mesh actors into movers (toMover); an {i}
// anywhere above then means the mover. `meta` ({objects: [{ref, ...notes}]}) is the editor's notes (editorDataOf).
// `checkpoints` entries with `lava` are lava zones (see addCheckpoints). `ballSpawn` ({loc}) gives the ball a spawn
// of its own (a map that has one moves its marker through `edits`). A panel material of 'lava' is a red copy
// of the map's tintable surface (describe().tintable), added once.
export function build(source, { edits = [], duplicates = [], removes = [], checkpoints = [], terrain: ground = null, fresh = false,
                                shapes = [], shapeGeometry = {}, shapeMaterial = null, respawns = [], panels = [], surfaces = [], ballSpawn = null, lighting = null, hud = null,
                                lights = [], movers = null, triggerZones = [], script = null, conversions = [], meta = null }) {
  const pkg = new Package(source.slice());
  const before = pkg.levelList().length;
  let tilesAdded = 0, tilesRemoved = 0, out = pkg.data, triggers = [], copies = [], shapeActors = [], zoneActors = [], converted = new Map();
  const missing = pkg.apply(edits);
  // ball checkpoints switched between ball in front / on top: their mode variable (UDK leaves an IntValue of 0 out)
  const zoneList = checkpointZones(pkg), zones = new Map(zoneList.map(z => [z.i, z])), unsetModes = [];
  // saved checkpoints given another title (an empty one is "Checkpoint N" again, N its place among the checkpoints)
  const titles = edits.filter(e => 'title' in e && zones.get(e.i)?.textNode != null)
    .map(e => ({ i: e.i, text: e.title || `Checkpoint ${zoneList.indexOf(zones.get(e.i)) + 1}` }));
  for (const edit of edits) {
    const modeVar = 'ballOnTop' in edit ? zones.get(edit.i)?.modeVar : null;
    if (modeVar === null || modeVar === undefined) continue;
    try { pkg.set(pkg.exports[modeVar], 'IntValue', '<i', edit.ballOnTop ? 1 : 0); } catch { unsetModes.push([modeVar, edit.ballOnTop ? 1 : 0]); }
  }
  const markers = respawns.filter(r => r.marker);
  for (const r of respawns) if (!r.marker) pkg.set(pkg.exports[r.valueVar], 'ObjValue', '<i', r.zone + 1);
  if (missing.size || duplicates.length || removes.length || checkpoints.length || ground || fresh || shapes.length || unsetModes.length || markers.length || panels.length || surfaces.length || ballSpawn || lighting || titles.length || triggerZones.length || conversions.length) {
    const add = new Additions(pkg);
    let lava = null;
    const surface = m => m === 'lava' ? (lava ??= lavaSurface(add)) : m;
    for (const [v, value] of unsetModes) add.setProps(v, { IntValue: add.tag('IntValue', 'IntProperty', pack('<i', value)) });
    for (const { i, text } of titles) {
      add.setProps(zones.get(i).textNode, { DrawTextInfo: add.tag('DrawTextInfo', 'StructProperty', textInfo(add, text), 'KismetDrawTextInfo') });
    }
    if (fresh) add.clearRefs(mainSequence(pkg), 'SequenceObjects');
    for (const [i, values] of missing) add.setValues(i, values);
    if (lighting) setLighting(add, lighting, new Set(edits.filter(e => e.light && ('color' in e.light || 'brightness' in e.light)).map(e => e.i)));
    copies = duplicates.map(dup => add.duplicate(dup.src, [0, 0, 0], editValues(dup)));
    for (const i of removes) add.remove(i);
    if (triggerZones.length && !pkg.zoneTemplate()) throw new Error('this map has no trigger zone to copy for trigger zones');
    zoneActors = triggerZones.map(z => add.duplicate(pkg.zoneTemplate().i, [0, 0, 0], editValues(z)));
    converted = new Map(conversions.map(c => [c.i, toMover(add, c.i, editValues(c), c.material == null ? null : surface(c.material))]));
    for (const r of markers) {
      const marker = add.duplicate(pkg.zoneTemplate().i, [0, 0, 0], editValues(r.marker));
      pkg.set(pkg.exports[r.valueVar], 'ObjValue', '<i', marker + 1);
    }
    if (checkpoints.length || ballSpawn) {
      const zone = pkg.zoneTemplate();
      if (!zone) throw new Error('this map has no trigger zone to copy for checkpoints');
      const spawn = pkg.levelActors().find(a => a.cls.startsWith('PlayerStart'))?.i ?? null;
      triggers = addCheckpoints(add, zone.i, checkpoints.map(c => ({ values: editValues(c), ball: !!c.ball, ballOnTop: !!c.ballOnTop, lava: !!c.lava, title: c.title ?? '',
                                                                     respawn: c.respawn ? editValues(c.respawn) : null })), fresh, spawn,
                                ballSpawn && editValues({ loc: ballSpawn.loc, rot: [0, 0, 0], scale3d: [0.1, 0.1, 0.1] }));
    }
    if (ground) [tilesAdded, tilesRemoved] = saveTerrain(add, Number(ground.base), ground.material, ground.tiles);
    if (shapes.length) shapeActors = addShapes(add, shapes.map(s => ({ key: s.key, values: editValues(s), material: s.material == null ? undefined : surface(s.material), mover: !!s.mover })),
                                               shapeGeometry, shapeMaterial);
    if (panels.length) {
      const zone = pkg.zoneTemplate();
      if (!zone) throw new Error('this map has no trigger zone to size checkpoint panels');
      addShapes(add, panels.map(p => ({ key: 'panel', values: editValues(p), material: surface(p.material ?? null) })),
                { panel: asMeshInput(boxShape(zone.bounds)) }, null, { name: 'CheckpointPanel', solid: false });
    }
    for (const { i, material } of surfaces) {
      add.setProps(meshComponent(pkg, i), { Materials: add.tag('Materials', 'ArrayProperty', pack('<ii', 1, Math.trunc(surface(material)))) });
    }
    out = add.save();
  }
  // lights on their own pass: a light's actor may have been rewritten above (moved, or its mood)
  const lightEdits = [...edits.filter(e => e.light).map(e => [e.i, e.light]), ...duplicates.map((d, k) => [copies[k], d.light]).filter(([, l]) => l)];
  let newLights = [];
  if (lightEdits.length || lights.length) {
    const p = new Package(out), add = new Additions(p);
    for (const [i, settings] of lightEdits) {
      setLight(add, i, settings);
      if (/^(sun|sky)$/.test(lightOf(p, i).kind) && ('color' in settings || 'brightness' in settings)) {
        add.setProps(i, { Tag: add.tag('Tag', 'NameProperty', add.fname(p.classOf(p.exports[i]))) });
      }
    }
    newLights = lights.map(l => addLight(add, l.kind, l.loc, l.rot ?? [0, 0, 0], l));
    out = add.save();
  }
  const exportOf = r => 'i' in r ? converted.get(r.i) ?? r.i : 'shape' in r ? shapeActors[r.shape] : 'checkpoint' in r ? triggers[r.checkpoint]
    : 'zone' in r ? zoneActors[r.zone] : 'light' in r ? newLights[r.light] : copies[r.duplicate];
  const moving = movers && movers.map(mv => ({ actor: exportOf(mv), motion: { ...mv.motion, trigger: mv.motion.trigger === null ? null : exportOf(mv.motion.trigger) } }));
  if (moving) {
    const p = new Package(out), add = new Additions(p), placed = new Map(p.levelActors().map(a => [a.i, a]));
    setMovers(add, moving.map(mv => {
      const a = placed.get(mv.actor);
      if (!a || a.cls !== 'InterpActor') throw new Error(`mover ${mv.actor} is no InterpActor in the map`);
      return { ...mv, ...motionKeys(mv.motion, a.rot, scaledBox(a.bounds, a.scale3d, a.scale)) };
    }));
    out = add.save();
  }
  let scriptNames = null;
  if (script) {                                   // after the movers: clips and hidden shapes need the shapes as InterpActors
    const p = new Package(out), add = new Additions(p), placed = new Map(p.levelActors().map(a => [a.i, a]));
    scriptNames = Object.fromEntries(Object.entries(script.names).map(([name, r]) => [name, exportOf(r)]));
    const mover = name => {
      const a = placed.get(scriptNames[name]);
      if (!a || a.cls !== 'InterpActor') throw new Error(`script: "${name}" can't move; only shapes added in the editor can (add it as a new shape)`);
      return a;
    };
    const plan = { ...script.plan, clips: script.plan.clips.map(c => { const a = mover(c.target); return { ...c, ...motionKeys(c.motion, a.rot, scaledBox(a.bounds, a.scale3d, a.scale)) }; }) };
    const homes = {};
    const walk = list => list.forEach(x => { if (x.do === 'show' || x.do === 'hide') homes[x.shape] = mover(x.shape).loc; walk(x.then ?? []); walk(x.otherwise ?? []); });
    plan.rules.forEach(r => walk(r.actions));
    setScript(add, script.source.trim() ? { source: script.source, plan, names: scriptNames, homes } : null);
    out = add.save();
  }
  const hudWanted = hud ?? hudOf(new Package(out));
  if (hudWanted) {                                // after everything else, so it sees the final checkpoints and lava
    const p = new Package(out), add = new Additions(p);
    setHud(add, hudWanted, checkpointZones(p).at(-1)?.dest ?? null, lavaZones(p));
    out = add.save();
  }
  const notes = meta && { v: 1, objects: Object.fromEntries(meta.objects.map(({ ref, ...o }) => [exportOf(ref), o])) };
  if (notes) {
    const add = new Additions(new Package(out));
    setEditorData(add, notes);
    out = add.save();
  }
  const packed = compact(out).bytes;              // unused meshes and textures shrunk, superseded copies gone
  if (packed.length < out.length) out = packed;

  const saved = new Package(out), actors = saved.levelActors(), byIndex = new Map(actors.map(a => [a.i, a]));
  const setByHand = new Set(lightEdits.map(([i]) => i));
  if (lighting) check(mapLights(saved).every(l => setByHand.has(l.actor) || newLights.includes(l.actor) || l.mood === (LIGHTING[lighting] ? lighting : null)), 'lighting');
  const lightIs = (i, want, kind = null) => {
    const l = lightOf(saved, i), near = (a, b) => Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(b));
    return l && (!kind || l.kind === kind) && LIGHT_FIELDS.every(f => !(f in want) || !(f in l)
      || (f === 'color' ? want.color.every((v, k) => v === l.color[k]) : typeof want[f] === 'number' ? near(l[f], want[f]) : l[f] === want[f]));
  };
  for (const [i, settings] of lightEdits) check(lightIs(i, settings), `${saved.exports[i].name} light`);
  newLights.forEach((i, k) => {
    const a = byIndex.get(i);
    check(lightIs(i, lights[k], lights[k].kind) && a && a.loc.every((v, j) => Math.abs(v - lights[k].loc[j]) < 0.01), `new light ${k + 1}`);
  });
  if (notes) check(JSON.stringify(editorDataOf(saved)) === JSON.stringify(notes), 'editor notes');
  for (const [, i] of converted) check(byIndex.get(i)?.cls === 'InterpActor', 'shape made a mover');
  if (script) {
    const got = scriptOf(saved);
    check(script.source.trim() ? got?.source === script.source && got.nodes.length > 0 && JSON.stringify(got.names) === JSON.stringify(scriptNames) : got === null, 'script');
  }
  if (moving) {
    const got = new Map(moversOf(saved).map(m => [m.i, JSON.stringify(m.motion)]));
    check(got.size === moving.length && moving.every(m => got.get(m.actor) === JSON.stringify(m.motion)), 'moving shapes');
  }
  if (hudWanted) {
    const got = hudOf(saved);
    check(hudWanted.timer || hudWanted.deaths ? got?.timer === !!hudWanted.timer && got?.deaths === !!hudWanted.deaths : got === null, 'timer and death counter');
  }
  const markersAdded = markers.length + checkpoints.filter(c => c.respawn).length + (ballSpawn ? 1 : 0);
  if (ballSpawn) {
    const m = saved.levelActors().find(a => a.i === ballSpawnMarker(saved));
    check(m && m.loc.every((v, k) => Math.abs(v - ballSpawn.loc[k]) < 0.01), 'ball spawn');
  }
  check(saved.levelList().length === before + duplicates.length + checkpoints.length + markersAdded + shapes.length + panels.length + tilesAdded + lights.length + triggerZones.length
        - removes.length - tilesRemoved, 'level actor count');
  const savedZones = new Map(checkpointZones(saved).map(z => [z.i, z])), savedLava = new Map(lavaZones(saved).map(z => [z.i, z]));
  triggers.forEach((t, k) => {
    const c = checkpoints[k], z = (c.lava ? savedLava : savedZones).get(t);
    if (c.lava) return check(z && z.ball === !!c.ball && !savedZones.has(t), `lava zone ${k + 1} wiring`);
    // maps made before the ball placement setting always drop the ball on top
    check(z && z.ball === !!c.ball && (!c.ball || z.modeVar === null || z.ballOnTop === !!c.ballOnTop) && (z.dest !== t) === !!c.respawn, `checkpoint ${k + 1} wiring`);
    check(c.title ? z.title === c.title : /^Checkpoint \d+$/.test(z.title), `checkpoint ${k + 1} title`);
  });
  for (const edit of edits) {
    if ('ballOnTop' in edit && zones.get(edit.i)?.modeVar != null) check(savedZones.get(edit.i)?.ballOnTop === !!edit.ballOnTop, `${edit.i} ball placement`);
  }
  for (const { i, text } of titles) check(savedZones.get(i)?.title === text, `${i} title`);
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
